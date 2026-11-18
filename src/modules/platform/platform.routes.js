import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as v from './platform.validation.js';
import * as svc from './platform.service.js';
import { handlerRoutes as ticketHandler } from '../helpdesk/helpdesk.routes.js';

const r = Router();
r.use(requireRole('super_admin'));

r.use('/helpdesk', ticketHandler('platform')); // tickets schools send to Campusio support
r.get('/stats', async (_req, res) => res.json(await svc.platformStats()));
r.get('/schools', async (req, res) => res.json(await svc.listSchools(req.query)));

r.post('/schools', async (req, res) => {
  const out = await svc.createSchool(parse(v.createSchoolBody, req.body), req.user._id);
  req.tenantId = out.school._id;
  await audit(req, 'school.created', 'School', out.school._id, `Created school ${out.school.name}`);
  res.status(201).json(out);
});

r.get('/schools/:id', async (req, res) => res.json(await svc.getSchool(req.params.id)));

r.patch('/schools/:id', async (req, res) => {
  const body = parse(v.updateSchoolBody, req.body);
  const school = await svc.updateSchool(req.params.id, body);
  req.tenantId = school._id;
  await audit(req, 'school.updated', 'School', school._id, `Updated school ${school.name}`, body);
  res.json(school);
});

r.put('/schools/:id/subscription', async (req, res) => {
  const body = parse(v.updateSubscriptionBody, req.body);
  const { school, sub } = await svc.updateSubscription(req.params.id, body);
  req.tenantId = school._id;
  await audit(req, 'subscription.updated', 'Subscription', sub._id, `Updated subscription for ${school.name}`, body);
  res.json(sub);
});

r.post('/schools/:id/admins', async (req, res) => {
  const { school, user, temporaryPassword } = await svc.createSchoolAdmin(req.params.id, parse(v.createAdminBody, req.body), req.user._id);
  req.tenantId = school._id;
  await audit(req, 'user.created', 'User', user._id, `Created school admin ${user.name}`);
  res.status(201).json({ id: user._id, name: user.name, loginId: user.loginId, temporaryPassword });
});

r.post('/users/:id/reset-password', async (req, res) => {
  const { user, temporaryPassword } = await svc.resetAdminPassword(req.params.id);
  req.tenantId = user.tenantId;
  await audit(req, 'user.password_reset', 'User', user._id, `Reset password for ${user.name}`);
  res.json({ loginId: user.loginId, temporaryPassword });
});

r.patch('/users/:id', async (req, res) => {
  const { status } = parse(v.userStatusBody, req.body);
  const user = await svc.setAdminStatus(req.params.id, status);
  req.tenantId = user.tenantId;
  await audit(req, `user.${status === 'active' ? 'enabled' : 'disabled'}`, 'User', user._id, `${status} ${user.name}`);
  res.json({ id: user._id, status: user.status });
});

r.get('/audit', async (req, res) => res.json(await svc.listAudit(req.query)));

export default r;
