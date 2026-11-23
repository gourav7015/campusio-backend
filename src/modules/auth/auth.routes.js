import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../../core/config.js';
import { authenticate } from '../../middleware/auth.js';
import { publicUser } from '../../services/users.js';
import { StaffMember, School, Teacher, ClassTeacherAssignment } from '../../models/index.js';
import { isEmailEnabled } from '../../services/email.js';
import { checkPassword } from '../../services/users.js';
import * as otp from '../../services/otp.js';
import { registeredContact, maskEmail } from '../../services/contact.js';

/** The signed-in person as the app sees them. A staff member also says whether they have been given the attendance desk. */
async function shaped(u) {
  const pu = publicUser(u);
  pu.registeredEmail = maskEmail((await registeredContact(u)).email);
  if (u.role === 'staff') pu.canMarkAttendance = !!(await StaffMember.findOne({ userId: u._id, tenantId: u.tenantId }).select('canMarkAttendance').lean())?.canMarkAttendance;
  // a teacher sees "Period attendance" only in a school that takes attendance period by period
  if (u.role === 'teacher') pu.periodWise = !!(await School.findById(u.tenantId).select('settings.attendance.periodWise').lean())?.settings?.attendance?.periodWise;
  // a class teacher also gets the page that moves their class on to the next year
  if (u.role === 'teacher') { const t = await Teacher.findOne({ userId: u._id, tenantId: u.tenantId }).select('_id').lean(); pu.classTeacher = !!t && !!(await ClassTeacherAssignment.exists({ tenantId: u.tenantId, teacherId: t._id, open: true })); }
  return pu;
}
import { audit } from '../../services/audit.js';
import { parse } from '../../core/utils.js';
import * as v from './auth.validation.js';
import * as svc from './auth.service.js';

const r = Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: config.loginRateLimit, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts, try again later', code: 'RATE_LIMIT' }, skip: () => config.env === 'test',
});

const finishLogin = async (req, res, { user, token }) => {
  req.user = user; req.tenantId = user.tenantId;
  await audit(req, 'auth.login', 'User', user._id, `${user.name} signed in`);
  res.json({ token, user: await shaped(user), school: await svc.schoolBrief(user.tenantId) });
};
const ctxOf = (req) => ({ userAgent: req.headers['user-agent'], ip: req.ip });

r.post('/login', loginLimiter, async (req, res) => {
  const out = await svc.login(parse(v.loginBody, req.body), ctxOf(req));
  if (out.challenge) return res.json({ twoFactorRequired: true, challenge: out.challenge, sentTo: out.sentTo });
  await finishLogin(req, res, out);
});
r.post('/login/2fa', loginLimiter, async (req, res) => finishLogin(req, res, await svc.loginSecondStep(parse(v.secondStepBody, req.body), ctxOf(req))));

r.post('/login/2fa/resend', loginLimiter, async (req, res) => res.json(await svc.resendLoginCode(parse(v.challengeOnly, req.body))));

/** What the pages may offer: codes and password resets work only when the server can send email. */
r.get('/options', (_req, res) => res.json({ emailCodes: otp.emailCodesAvailable() }));
const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts, try again later', code: 'RATE_LIMIT' }, skip: () => config.env === 'test' });
// the same answer whether or not the account exists and whether or not the date of birth matched, so this cannot be used to find out who has an account
r.post('/forgot', forgotLimiter, async (req, res) => { await svc.forgotPassword(parse(v.forgotBody, req.body)); res.json({ ok: true }); });
r.post('/forgot/verify', loginLimiter, async (req, res) => res.json(await svc.verifyResetCode(parse(v.verifyResetBody, req.body))));
r.post('/reset', loginLimiter, async (req, res) => {
  const user = await svc.resetPassword(parse(v.resetBody, req.body));
  req.user = user; req.tenantId = user.tenantId; await audit(req, 'auth.password_reset', 'User', user._id, 'Password reset with a code sent by email');
  res.json({ ok: true });
});

r.use(authenticate);

r.get('/me', async (req, res) => res.json({ user: await shaped(req.user), school: await svc.schoolBrief(req.user.tenantId, true) }));

r.post('/logout', async (req, res) => {
  req.session.revokedAt = new Date();
  await req.session.save();
  res.json({ ok: true });
});

r.post('/change-password', async (req, res) => {
  await svc.changePassword(req.user, req.session, parse(v.changePasswordBody, req.body));
  await audit(req, 'auth.password_changed', 'User', req.user._id, 'Password changed');
  res.json({ ok: true });
});

r.post('/refresh', async (req, res) => res.json(await svc.refreshSession(req.user, req.session)));

// two-factor sign-in by a code sent to the registered email
r.post('/2fa/start', async (req, res) => { const b = parse(v.passwordOnly, req.body); res.json(await otp.start(req.user, 'enable', await checkPassword(b.password, req.user.passwordHash))); });
r.post('/2fa/disable-start', async (req, res) => { const b = parse(v.passwordOnly, req.body); res.json(await otp.start(req.user, 'disable', await checkPassword(b.password, req.user.passwordHash))); });
r.post('/2fa/confirm', async (req, res) => {
  const out = await otp.confirm(req.user, parse(v.codeBody, req.body));
  await audit(req, out.purpose === 'enable' ? 'auth.2fa_enabled' : 'auth.2fa_disabled', 'User', req.user._id, `${out.purpose === 'enable' ? 'Turned on' : 'Turned off'} sign-in codes by email`);
  res.json({ ok: true, ...out });
});

r.get('/sessions', async (req, res) => res.json(await svc.listSessions(req.user, req.session)));
r.post('/sessions/revoke-others', async (req, res) => res.json({ revoked: await svc.revokeOthers(req.user, req.session) }));
r.delete('/sessions/:id', async (req, res) => { await svc.revokeSession(req.user, req.params.id); res.json({ ok: true }); });

r.patch('/preferences', async (req, res) => {
  const body = parse(v.preferencesBody, req.body);
  if (body.language) req.user.language = body.language;
  if (body.notificationPrefs) {
    req.user.notificationPrefs = { ...req.user.notificationPrefs, ...body.notificationPrefs };
    req.user.markModified('notificationPrefs');
  }
  await req.user.save();
  res.json(publicUser(req.user));
});

export default r;
