import { Router } from 'express';
import { z } from 'zod';
import { User, Session, StaffMember, Designation, SalaryRevision, Payslip, StaffAttendanceRecord, StaffPunch } from '../../models/index.js';
import { parse, notFound, conflict, bad, generatePassword } from '../../core/utils.js';
import { createUserAccount, hashPassword, chosenPassword, schoolCode } from '../../services/users.js';
import { audit } from '../../services/audit.js';
import { ensureDeskStaff, createStaff, createLogin, DESK_NAMES, STAND_IN_NAMES } from '../support-staff/support-staff.service.js';

/** School Admin (or Super Admin acting) creates the Finance and Library staff logins. */
const r = Router();
const ROLES = ['finance', 'library', 'transport'];
const PLACEHOLDER_NAMES = STAND_IN_NAMES;
const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
// an officer (finance, library, transport) signs in with an email; a non-teaching staff member ('staff') is added with a job title and gets the Staff portal login
const body = z.object({
  name: z.string().trim().min(2).max(100).optional(), staffMemberId: id.optional(), email: z.string().email().optional(), role: z.enum([...ROLES, 'staff']), loginId: z.string().optional(), password: z.string().optional(),
  designationId: id.optional(), phone: z.string().trim().max(20).optional(), dob: z.string().optional(), canMarkAttendance: z.boolean().optional(),
}).superRefine((b, c) => {
  // a desk login is the desk's sign-in. Officer desks may be made with nobody on them yet; the office desk (Staff portal) belongs to an employee already on the staff list
  if (b.role === 'staff' && !b.staffMemberId && !(b.name && b.designationId)) c.addIssue({ code: 'custom', path: ['staffMemberId'], message: 'Choose the employee who works the office desk' });
});

/** The next free login id for a desk: school code, a dot and the desk (dpsr.finance, then dpsr.finance2). */
async function deskLoginId(tenantId, role) {
  const base = `${await schoolCode(tenantId)}.${role}`.toLowerCase();
  for (let n = 1; n < 100; n++) { const candidate = n === 1 ? base : `${base}${n}`; if (!(await User.exists({ loginId: candidate }))) return candidate; }
  throw conflict('Too many logins for this desk');
}

/** What login id a new desk login would get, so the form can show it before anything is saved. */
r.get('/staff/login-preview', async (req, res) => {
  const { role, staffMemberId } = parse(z.object({ role: z.enum([...ROLES, 'staff']), staffMemberId: id.optional().or(z.literal('')) }), req.query);
  if (role === 'staff') {
    if (!staffMemberId) return res.json({ loginId: null });
    const s = await StaffMember.findOne({ _id: staffMemberId, tenantId: req.tenantId }).select('staffId').lean();
    return res.json({ loginId: s ? `${await schoolCode(req.tenantId)}.${s.staffId}`.toLowerCase() : null });
  }
  res.json({ loginId: await deskLoginId(req.tenantId, role) });
});

/** The people who hold a desk role (finance, library, transport): the person, the role they hold, and how they sign in. */
r.get('/staff', async (req, res) => {
  await ensureDeskStaff(req.tenantId, req.user._id);
  // every desk sign-in: the three officer desks and the office desk (Staff portal). The login is the desk's credential; the person is the employee who holds it.
  const users = await User.find({ tenantId: req.tenantId, role: { $in: [...ROLES, 'staff'] } }).select('name loginId email role status lastLoginAt').sort({ role: 1, name: 1 }).lean();
  const people = await StaffMember.find({ tenantId: req.tenantId, userId: { $in: users.map((u) => u._id) } }).select('userId staffId name phone designationId').lean();
  const titles = new Map((await Designation.find({ tenantId: req.tenantId }).select('name').lean()).map((d) => [String(d._id), d.name]));
  const byUser = new Map(people.map((p) => [String(p.userId), p]));
  res.json(users.map((u) => {
    const p = byUser.get(String(u._id));
    // an officer desk made without naming an employee holds a stand-in named after the role ("Accounts Officer"): it still needs a real person
    const standIn = ROLES.includes(u.role) && (!p || PLACEHOLDER_NAMES.includes(p.name));
    return { ...u, personId: p?._id, personName: p?.name || null, code: p?.staffId, phone: p?.phone, title: titles.get(String(p?.designationId)), assigned: !!p && !standIn };
  }));
});

r.post('/staff', async (req, res) => {
  const b = parse(body, req.body);
  if (b.role === 'staff') {
    const ctx = { tenantId: req.tenantId, actorId: req.user._id };
    if (b.staffMemberId) {
      // the office desk for an employee already on the staff list: they keep their record and their job title; the Staff portal opens for them
      const e = await StaffMember.findOne({ _id: b.staffMemberId, tenantId: req.tenantId, status: 'active' });
      if (!e) throw notFound('That person was not found among the active staff');
      if (e.userId) throw conflict(`${e.name} already has a login`);
      if (e.deskRole || (await Designation.findById(e.designationId).lean())?.group === 'transport') throw bad(`${e.name} cannot work the office desk`);
      e.canMarkAttendance = true; await e.save();
      const cred = await createLogin(ctx, 'general', e._id);
      await audit(req, 'staff.created', 'StaffMember', e._id, `Opened the office desk login ${cred.loginId} for ${e.name}`);
      return res.status(201).json({ id: e._id, name: e.name, role: 'staff', loginId: cred.loginId, temporaryPassword: cred.temporaryPassword });
    }
    const m = await createStaff(ctx, 'general', { name: b.name, designationId: b.designationId, ...(b.phone ? { phone: b.phone } : {}), ...(b.email ? { email: b.email } : {}), ...(b.dob ? { dob: b.dob } : {}), canMarkAttendance: true }); // a Staff portal login is the office desk: it is made only for someone who is given it
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
  const { user, temporaryPassword } = await createUserAccount({ role: b.role, tenantId: req.tenantId, name: holder ? holder.name : (b.name || DESK_NAMES[b.role]), email: b.email || holder?.email, phone: b.phone || holder?.phone, dob: b.dob || holder?.dob, loginId: b.loginId || b.email || await deskLoginId(req.tenantId, b.role), password: b.password, createdBy: req.user._id, requireContact: false });
  if (holder) { if (!holder.email) holder.email = user.email; holder.userId = user._id; holder.deskRole = b.role; await holder.save(); } // they keep their own job title: holding a desk is separate from it
  await ensureDeskStaff(req.tenantId, req.user._id); // an officer is an employee too
  if (b.phone && !holder) await StaffMember.updateOne({ tenantId: req.tenantId, userId: user._id }, { phone: b.phone });
  await audit(req, 'staff.created', 'User', user._id, `${holder ? `Gave ${user.name} (already on the staff) the ${b.role} desk` : `Created ${b.role} staff ${user.name}`}`);
  res.status(201).json({ id: user._id, name: user.name, role: user.role, loginId: user.loginId, temporaryPassword });
});

/**
 * Gives a desk (Finance, Library, Transport or the office desk) to an existing employee. The sign-in (login id and password) stays the desk's; what changes is the person it belongs to, so the school can see
 * who holds which desk. The employee keeps their own job title and now holds the desk; the one who held it before is released (and removed if it was only a stand-in with no records).
 */
r.post('/staff/:id/assign', async (req, res) => {
  const { staffMemberId } = parse(z.object({ staffMemberId: id }), req.body);
  const u = await own(req);
  const next = await StaffMember.findOne({ _id: staffMemberId, tenantId: req.tenantId, status: 'active' });
  if (!next) throw notFound('That person was not found among the active staff');
  if (String(next.userId || '') === String(u._id)) throw bad(`${next.name} already holds this desk`);
  if (next.userId || next.deskRole) throw conflict(`${next.name} already has a login or holds another desk`);
  if ((await Designation.findById(next.designationId).lean())?.group === 'transport') throw bad('Drivers, conductors and other transport crew cannot hold an officer desk');
  const prev = await StaffMember.findOne({ tenantId: req.tenantId, userId: u._id });
  if (prev) {
    const used = await Promise.all([SalaryRevision.exists({ tenantId: req.tenantId, personId: prev._id }), Payslip.exists({ tenantId: req.tenantId, personId: prev._id }), StaffAttendanceRecord.exists({ tenantId: req.tenantId, personId: prev._id }), StaffPunch.exists({ tenantId: req.tenantId, personId: prev._id })]);
    if (ROLES.includes(u.role) && PLACEHOLDER_NAMES.includes(prev.name) && !used.some(Boolean)) await prev.deleteOne();
    else { prev.userId = undefined; prev.deskRole = undefined; if (u.role === 'staff') prev.canMarkAttendance = false; await prev.save(); } // released, and still on the staff list
  }
  next.userId = u._id;
  if (u.role === 'staff') next.canMarkAttendance = true; // the office desk: the employee keeps their own job title
  else next.deskRole = u.role; // their own job title stays: holding a desk is separate from it
  if (!next.email) next.email = u.email;
  await next.save();
  u.name = next.name; await u.save();
  await audit(req, 'staff.desk_assigned', 'User', u._id, `Gave the ${u.role} desk (${u.loginId}) to ${next.name}${prev && prev.name !== next.name ? `, who takes over from ${prev.name}` : ''}`);
  res.json({ id: u._id, name: u.name, personId: next._id, code: next.staffId });
});

const own = async (req) => {
  const u = await User.findOne({ _id: req.params.id, tenantId: req.tenantId, role: { $in: [...ROLES, 'staff'] } });
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
  const temporaryPassword = chosenPassword(req.body, u.loginId) || generatePassword();
  u.passwordHash = await hashPassword(temporaryPassword); u.mustChangePassword = true; u.failedLogins = 0; u.lockedUntil = undefined;
  await u.save();
  await Session.updateMany({ userId: u._id, revokedAt: null }, { revokedAt: new Date() });
  await audit(req, 'user.password_reset', 'User', u._id, `Reset password for ${u.name}`);
  res.json({ loginId: u.loginId, temporaryPassword });
});
export default r;
