import { Router } from 'express';
import { z } from 'zod';
import { User, Session } from '../../models/index.js';
import { parse, notFound, forbidden, conflict, generatePassword } from '../../core/utils.js';
import { createUserAccount, hashPassword, chosenPassword, schoolCode } from '../../services/users.js';
import { audit } from '../../services/audit.js';
import { PERMISSIONS, PERMISSION_KEYS, PRESETS } from './permissions.js';

/** Created and managed by the full School Admin only. Their logins (and emails) are made here and nowhere else. */
const r = Router();
const full = (req) => { if (req.user.role === 'school_admin' && req.user.adminLevel === 'sub') throw forbidden('Only the School Admin can manage sub-admins'); };
const perms = z.array(z.enum(PERMISSION_KEYS)).min(1, 'Choose at least one thing this sub-admin may do').max(PERMISSION_KEYS.length);
const view = (u) => ({ id: u._id, name: u.name, email: u.email, loginId: u.loginId, status: u.status, permissions: u.permissions || [], lastLoginAt: u.lastLoginAt });

r.get('/sub-admins/options', async (req, res) => { full(req); res.json({ permissions: Object.entries(PERMISSIONS).map(([key, v]) => ({ key, label: v.label })), presets: PRESETS }); });
/** The next free login id for a sub-admin: school code, a dot and "admin" (dpsr.admin1, dpsr.admin2 ...). The School Admin may type their own instead. */
async function subAdminLoginId(tenantId) {
  const base = `${await schoolCode(tenantId)}.admin`.toLowerCase();
  for (let n = 1; n < 100; n++) if (!(await User.exists({ loginId: `${base}${n}` }))) return `${base}${n}`;
  throw conflict('Too many sub-admin logins');
}
r.get('/sub-admins/login-preview', async (req, res) => { full(req); res.json({ loginId: await subAdminLoginId(req.tenantId) }); });
r.get('/sub-admins', async (req, res) => { full(req); res.json((await User.find({ tenantId: req.tenantId, role: 'school_admin', adminLevel: 'sub' }).sort({ name: 1 }).lean()).map(view)); });
r.post('/sub-admins', async (req, res) => {
  full(req);
  const b = parse(z.object({ name: z.string().trim().min(2).max(100), email: z.string().email().optional(), phone: z.string().trim().max(20).optional(), dob: z.string().optional(), permissions: perms, loginId: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._@+-]{2,59}$/, 'A login id is 3 to 60 letters, numbers, dots, dashes or underscores').optional().or(z.literal('')) }), req.body);
  const { user, temporaryPassword } = await createUserAccount({ role: 'school_admin', tenantId: req.tenantId, name: b.name, email: b.email, phone: b.phone, dob: b.dob, loginId: b.loginId || await subAdminLoginId(req.tenantId), requireContact: false, createdBy: req.user._id, extra: { adminLevel: 'sub', permissions: b.permissions } });
  await audit(req, 'subadmin.created', 'User', user._id, `Created sub-admin ${user.name} (${b.permissions.join(', ')})`);
  res.status(201).json({ ...view(user), temporaryPassword });
});
const own = async (req) => {
  const u = await User.findOne({ _id: req.params.id, tenantId: req.tenantId, role: 'school_admin', adminLevel: 'sub' });
  if (!u) throw notFound('Sub-admin not found');
  return u;
};
r.patch('/sub-admins/:id', async (req, res) => {
  full(req);
  const b = parse(z.object({ name: z.string().trim().min(2).max(100), permissions: perms, status: z.enum(['active', 'disabled']) }).partial(), req.body);
  const u = await own(req);
  Object.assign(u, b);
  await u.save();
  if (b.status === 'disabled' || b.permissions) await Session.updateMany({ userId: u._id, revokedAt: null }, { revokedAt: new Date() }); // sign in again with the new rights
  await audit(req, 'subadmin.updated', 'User', u._id, `Updated sub-admin ${u.name}`, b);
  res.json(view(u));
});
r.post('/sub-admins/:id/reset-password', async (req, res) => {
  full(req);
  const u = await own(req);
  const temporaryPassword = chosenPassword(req.body, u.loginId) || generatePassword();
  u.passwordHash = await hashPassword(temporaryPassword); u.mustChangePassword = true; u.failedLogins = 0; u.lockedUntil = undefined;
  await u.save();
  await Session.updateMany({ userId: u._id, revokedAt: null }, { revokedAt: new Date() });
  await audit(req, 'subadmin.password_reset', 'User', u._id, `Reset the password of sub-admin ${u.name}`);
  res.json({ loginId: u.loginId, temporaryPassword });
});

export default r;
