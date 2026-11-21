import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../../core/config.js';
import { authenticate } from '../../middleware/auth.js';
import { publicUser } from '../../services/users.js';
import { StaffMember, School } from '../../models/index.js';
import { isEmailEnabled } from '../../services/email.js';

/** The signed-in person as the app sees them. A staff member also says whether they have been given the attendance desk. */
async function shaped(u) {
  const pu = publicUser(u);
  if (u.role === 'staff') pu.canMarkAttendance = !!(await StaffMember.findOne({ userId: u._id, tenantId: u.tenantId }).select('canMarkAttendance').lean())?.canMarkAttendance;
  // a teacher sees "Period attendance" only in a school that takes attendance period by period
  if (u.role === 'teacher') pu.periodWise = !!(await School.findById(u.tenantId).select('settings.attendance.periodWise').lean())?.settings?.attendance?.periodWise;
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
  if (out.challenge) return res.json({ twoFactorRequired: true, challenge: out.challenge });
  await finishLogin(req, res, out);
});
r.post('/login/2fa', loginLimiter, async (req, res) => finishLogin(req, res, await svc.loginSecondStep(parse(v.secondStepBody, req.body), ctxOf(req))));

/** What the sign-in page may offer: a reset link by email works only when the server can send email. */
r.get('/options', (_req, res) => res.json({ emailReset: isEmailEnabled() }));
const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts, try again later', code: 'RATE_LIMIT' }, skip: () => config.env === 'test' });
// the same answer whether or not the account exists, so this cannot be used to find out who has an account
r.post('/forgot', forgotLimiter, async (req, res) => { await svc.forgotPassword(parse(v.forgotBody, req.body)); res.json({ ok: true }); });
r.post('/reset', loginLimiter, async (req, res) => {
  const user = await svc.resetPassword(parse(v.resetBody, req.body));
  req.user = user; req.tenantId = user.tenantId; await audit(req, 'auth.password_reset', 'User', user._id, 'Password reset by email link');
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

r.post('/2fa/setup', async (req, res) => res.json(await svc.twoFactorSetup(req.user, parse(v.passwordOnly, req.body))));
r.post('/2fa/enable', async (req, res) => {
  const out = await svc.twoFactorEnable(req.user, parse(v.codeBody, req.body));
  await audit(req, 'auth.2fa_enabled', 'User', req.user._id, 'Turned on two-factor sign-in');
  res.json(out);
});
r.post('/2fa/disable', async (req, res) => {
  await svc.twoFactorDisable(req.user, parse(v.passwordAndCode, req.body));
  await audit(req, 'auth.2fa_disabled', 'User', req.user._id, 'Turned off two-factor sign-in');
  res.json({ ok: true });
});
r.post('/2fa/recovery-codes', async (req, res) => res.json(await svc.newRecovery(req.user, parse(v.passwordAndCode, req.body))));

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
