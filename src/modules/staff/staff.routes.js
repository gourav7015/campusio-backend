import { Router } from 'express';
import { z } from 'zod';
import { User, Session, StaffMember, Designation } from '../../models/index.js';
import { parse, notFound, conflict, bad, generatePassword } from '../../core/utils.js';
import { createUserAccount, hashPassword } from '../../services/users.js';
import { audit } from '../../services/audit.js';
import { ensureDeskStaff, deskDesignation, createStaff, createLogin } from '../support-staff/support-staff.service.js';

/** School Admin (or Super Admin acting) creates the Finance and Library staff logins. */
const r = Router();
const ROLES = ['finance', 'library', 'transport'];
const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
// an officer (finance, library, transport) signs in with an email; a non-teaching staff member ('staff') is added with a job title and gets the Staff portal login
const body = z.object({
  name: z.string().trim().min(2).max(100).optional(), staffMemberId: id.optional(), email: z.string().email().optional(), role: z.enum([...ROLES, 'staff']), loginId: z.string().optional(), password: z.string().optional(),
  designationId: id.optional(), phone: z.string().trim().max(20).optional(), canMarkAttendance: z.boolean().optional(),
}).superRefine((b, c) => {
  if (!b.name && !b.staffMemberId) c.addIssue({ code: 'custom', path: ['name'], message: 'Enter the person\'s name, or choose who holds this role' });
  if (b.staffMemberId && b.role === 'staff') c.addIssue({ code: 'custom', path: ['staffMemberId'], message: 'A staff login is made from the staff list' });
  if (b.role === 'staff' && !b.designationId) c.addIssue({ code: 'custom', path: ['designationId'], message: 'Choose a job title' });
  if (b.role !== 'staff' && !b.email) c.addIssue({ code: 'custom', path: ['email'], message: 'Enter an email address' });
});

/** The people who hold a desk role (finance, library, transport): the person, the role they hold, and how they sign in. */
r.get('/staff', async (req, res) => {
  await ensureDeskStaff(req.tenantId, req.user._id);
  const users = await User.find({ tenantId: req.tenantId, role: { $in: ROLES } }).select('name loginId email role status lastLoginAt').sort({ role: 1, name: 1 }).lean();
  const people = await StaffMember.find({ tenantId: req.tenantId, userId: { $in: users.map((u) => u._id) } }).select('userId staffId phone designationId').lean();
  const titles = new Map((await Designation.find({ tenantId: req.tenantId }).select('name').lean()).map((d) => [String(d._id), d.name]));
  const byUser = new Map(people.map((p) => [String(p.userId), p]));
  res.json(users.map((u) => { const p = byUser.get(String(u._id)); return { ...u, personId: p?._id, code: p?.staffId, phone: p?.phone, title: titles.get(String(p?.designationId)) }; }));
});

r.post('/staff', async (req, res) => {
  const b = parse(body, req.body);
  if (b.role === 'staff') {
    const ctx = { tenantId: req.tenantId, actorId: req.user._id };
    const m = await createStaff(ctx, 'general', { name: b.name, designationId: b.designationId, ...(b.phone ? { phone: b.phone } : {}), canMarkAttendance: true }); // a Staff portal login is the office desk: it is made only for someone who is given it
    const cred = await createLogin(ctx, 'general', m._id);
    await audit(req, 'staff.created', 'StaffMember', m._id, `Added staff member ${m.name} with a Staff portal login`);
    return res.status(201).json({ id: m._id, name: m.name, role: 'staff', loginId: cred.loginId, temporaryPassword: cred.temporaryPassword });
  }
  // the role is held by a person already on the staff list: they keep their record and gain the desk login
  let holder = null;
  if (b.staffMemberId) {
    holder = await StaffMember.findOne({ _id: b.staffMemberId, tenantId: req.tenantId, status: 'active' });
    if (!holder) throw notFound('That person was not found among the active staff');
    if (holder.userId) throw conflict(`${holder.name} already has a login`);
    if (holder.deskRole) throw conflict(`${holder.name} already holds a desk role`);
    if ((await Designation.findById(holder.designationId).lean())?.group === 'transport') throw bad('Drivers, conductors and other transport crew cannot hold an officer role');
  }
  const { user, temporaryPassword } = await createUserAccount({ role: b.role, tenantId: req.tenantId, name: holder ? holder.name : b.name, email: b.email, loginId: b.loginId, password: b.password, createdBy: req.user._id });
  if (holder) { holder.userId = user._id; holder.deskRole = b.role; holder.designationId = (await deskDesignation(req.tenantId, b.role))._id; await holder.save(); }
  await ensureDeskStaff(req.tenantId, req.user._id); // an officer is an employee too
  if (b.phone && !holder) await StaffMember.updateOne({ tenantId: req.tenantId, userId: user._id }, { phone: b.phone });
  await audit(req, 'staff.created', 'User', user._id, `${holder ? `Gave ${user.name} (already on the staff) the ${b.role} desk` : `Created ${b.role} staff ${user.name}`}`);
  res.status(201).json({ id: user._id, name: user.name, role: user.role, loginId: user.loginId, temporaryPassword });
});

const own = async (req) => {
  const u = await User.findOne({ _id: req.params.id, tenantId: req.tenantId, role: { $in: ROLES } });
  if (!u) throw notFound('Staff member not found');
  return u;
};
r.patch('/staff/:id', async (req, res) => {
  const { phone, ...b } = parse(z.object({ name: z.string().trim().min(2).max(100), phone: z.string().trim().max(20), status: z.enum(['active', 'disabled']) }).partial(), req.body);
  const u = await own(req);
  Object.assign(u, b);
  if (phone !== undefined) await StaffMember.updateOne({ tenantId: req.tenantId, userId: u._id }, { phone });
  await u.save();
  if (b.status === 'disabled') await Session.updateMany({ userId: u._id, revokedAt: null }, { revokedAt: new Date() });
  await ensureDeskStaff(req.tenantId, req.user._id); // keeps the employee row's status and name in step
  if (b.name) await StaffMember.updateOne({ tenantId: req.tenantId, userId: u._id }, { name: u.name });
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
