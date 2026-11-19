import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../../core/config.js';
import { authenticate } from '../../middleware/auth.js';
import { publicUser } from '../../services/users.js';
import { StaffMember, School } from '../../models/index.js';

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

r.post('/login', loginLimiter, async (req, res) => {
  const { user, token } = await svc.login(parse(v.loginBody, req.body), { userAgent: req.headers['user-agent'], ip: req.ip });
  req.user = user; req.tenantId = user.tenantId;
  await audit(req, 'auth.login', 'User', user._id, `${user.name} signed in`);
  res.json({ token, user: await shaped(user), school: await svc.schoolBrief(user.tenantId) });
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
