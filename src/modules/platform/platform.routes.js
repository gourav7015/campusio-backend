import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as v from './platform.validation.js';
import * as svc from './platform.service.js';
import { ErrorLog } from '../../models/index.js';
import { School } from '../../models/index.js';
import { flagsView, setFlags } from '../../services/flags.js';
import { z } from 'zod';
import { handlerRoutes as ticketHandler } from '../helpdesk/helpdesk.routes.js';
import * as connect from '../connect/connect.service.js';
import { memberBody, settingsBody } from '../connect/connect.routes.js';

const r = Router();
r.use(requireRole('super_admin'));

r.use('/helpdesk', ticketHandler('platform')); // tickets schools send to AtKaksha support
// the public Connect page: its team (who people can reach), its wording and hours, and the messages sent from it
const oid = z.string().regex(/^[a-f0-9]{24}$/i);
r.get('/team', async (_req, res) => res.json(await connect.adminTeam()));
r.post('/team', async (req, res) => {
  const m = await connect.addMember(parse(memberBody, req.body));
  await audit(req, 'connect.member_added', 'TeamMember', m.id, `Added ${m.name} to the Connect page`);
  res.status(201).json(m);
});
r.post('/team/reorder', async (req, res) => {
  const out = await connect.reorder(parse(z.object({ ids: z.array(oid).min(1).max(100) }), req.body).ids);
  await audit(req, 'connect.team_reordered', 'TeamMember', null, 'Changed the order of the Connect page team');
  res.json(out);
});
r.patch('/team/:id', async (req, res) => {
  const m = await connect.updateMember(req.params.id, parse(memberBody.partial(), req.body));
  await audit(req, 'connect.member_updated', 'TeamMember', m.id, `Updated ${m.name} on the Connect page`);
  res.json(m);
});
r.delete('/team/:id', async (req, res) => {
  const m = await connect.removeMember(req.params.id);
  await audit(req, 'connect.member_removed', 'TeamMember', m._id, `Removed ${m.name} from the Connect page`);
  res.json({ removed: true });
});
r.get('/connect', async (_req, res) => { const s = (await connect.getSettings()).toObject(); res.json({ title: s.title, intro: s.intro, hoursNote: s.hoursNote || '', hoursDays: s.hoursDays, opensAt: s.opensAt, closesAt: s.closesAt, mailboxes: s.mailboxes, helloTo: s.helloTo || '', supportTo: s.supportTo || '' }); });
r.put('/connect', async (req, res) => {
  const b = parse(settingsBody, req.body);
  await connect.saveSettings({ ...b, hoursNote: b.hoursNote || '', helloTo: b.helloTo || '', supportTo: b.supportTo || '' });
  await audit(req, 'connect.settings_saved', 'ConnectSettings', null, 'Saved the Connect page wording, hours and mailboxes');
  res.json({ saved: true });
});
r.get('/connect/messages', async (req, res) => res.json(await connect.listMessages(parse(z.object({ status: z.enum(['new', 'handled']).optional() }), req.query).status)));
r.get('/connect/messages/summary', async (_req, res) => res.json({ count: await connect.newMessageCount() }));
r.patch('/connect/messages/:id', async (req, res) => res.json(await connect.setMessageStatus(req.params.id, parse(z.object({ status: z.enum(['new', 'handled']) }), req.body).status, req.user._id)));
r.delete('/connect/messages/:id', async (req, res) => { await connect.removeMessage(req.params.id); res.json({ removed: true }); });
r.get('/errors', async (req, res) => {
  const q = parse(z.object({ source: z.enum(['server', 'client']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
  const rows = await ErrorLog.find(q.source ? { source: q.source } : {}).sort({ at: -1 }).limit(q.limit).lean();
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  res.json({ last24h: { server: await ErrorLog.countDocuments({ source: 'server', at: { $gte: since } }), client: await ErrorLog.countDocuments({ source: 'client', at: { $gte: since } }) }, rows });
});
r.delete('/errors', async (req, res) => { const out = await ErrorLog.deleteMany({}); await audit(req, 'platform.errors_cleared', 'ErrorLog', null, 'Cleared the error log'); res.json({ removed: out.deletedCount }); });
r.get('/schools/:id/flags', async (req, res) => { const s = await School.findById(req.params.id).select('settings').lean(); if (!s) return res.status(404).json({ error: 'School not found', code: 'NOT_FOUND' }); res.json(flagsView(s.settings)); });
r.put('/schools/:id/flags', async (req, res) => {
  const body = parse(z.record(z.boolean().nullable()), req.body);
  const out = await setFlags(req.params.id, body);
  if (!out) return res.status(404).json({ error: 'School not found', code: 'NOT_FOUND' });
  req.tenantId = req.params.id; await audit(req, 'school.flags_changed', 'School', req.params.id, `Changed feature switches: ${Object.keys(body).join(', ')}`);
  res.json(out);
});
r.post('/users/:id/reset-2fa', async (req, res) => {
  const { User } = await import('../../models/index.js'); const { twoFactorReset } = await import('../auth/auth.service.js');
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
  if (String(u._id) === String(req.user._id)) return res.status(403).json({ error: 'Use the command line on the server to reset your own', code: 'FORBIDDEN' });
  await twoFactorReset(u); req.tenantId = u.tenantId; await audit(req, 'auth.2fa_reset', 'User', u._id, `Reset two-factor sign-in for ${u.name}`);
  res.json({ ok: true });
});
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
  const { user, temporaryPassword } = await svc.resetAdminPassword(req.params.id, req.body);
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

r.get('/audit/facets', async (req, res) => res.json(await svc.auditSummary(req.query)));
r.get('/audit', async (req, res) => res.json(await svc.listAudit(req.query)));

export default r;
