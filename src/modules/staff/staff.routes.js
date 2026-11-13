import { Router } from 'express';
import { z } from 'zod';
import { User, Session } from '../../models/index.js';
import { parse, notFound, generatePassword } from '../../core/utils.js';
import { createUserAccount, hashPassword } from '../../services/users.js';
import { audit } from '../../services/audit.js';

/** School Admin (or Super Admin acting) creates the Finance and Library staff logins. */
const r = Router();
const ROLES = ['finance', 'library', 'transport'];
const body = z.object({ name: z.string().trim().min(2).max(100), email: z.string().email(), role: z.enum(ROLES), loginId: z.string().optional(), password: z.string().optional() });

r.get('/staff', async (req, res) => res.json(await User.find({ tenantId: req.tenantId, role: { $in: ROLES } }).select('name loginId email role status lastLoginAt').sort({ role: 1, name: 1 }).lean()));

r.post('/staff', async (req, res) => {
  const b = parse(body, req.body);
  const { user, temporaryPassword } = await createUserAccount({ role: b.role, tenantId: req.tenantId, name: b.name, email: b.email, loginId: b.loginId, password: b.password, createdBy: req.user._id });
  await audit(req, 'staff.created', 'User', user._id, `Created ${b.role} staff ${user.name}`);
  res.status(201).json({ id: user._id, name: user.name, role: user.role, loginId: user.loginId, temporaryPassword });
});

const own = async (req) => {
  const u = await User.findOne({ _id: req.params.id, tenantId: req.tenantId, role: { $in: ROLES } });
  if (!u) throw notFound('Staff member not found');
  return u;
};
r.patch('/staff/:id', async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(100), status: z.enum(['active', 'disabled']) }).partial(), req.body);
  const u = await own(req);
  Object.assign(u, b);
  await u.save();
  if (b.status === 'disabled') await Session.updateMany({ userId: u._id, revokedAt: null }, { revokedAt: new Date() });
  await audit(req, 'staff.updated', 'User', u._id, `Updated staff ${u.name}`, b);
  res.json({ id: u._id, name: u.name, status: u.status });
});
r.post('/staff/:id/reset-password', async (req, res) => {
  const u = await own(req);
  const temporaryPassword = generatePassword();
  u.passwordHash = await hashPassword(temporaryPassword); u.mustChangePassword = true; u.failedLogins = 0; u.lockedUntil = undefined;
  await u.save();
  await Session.updateMany({ userId: u._id, revokedAt: null }, { revokedAt: new Date() });
  await audit(req, 'user.password_reset', 'User', u._id, `Reset password for ${u.name}`);
  res.json({ loginId: u.loginId, temporaryPassword });
});
export default r;
