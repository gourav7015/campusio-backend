import { Designation, StaffMember, Bus, Teacher } from '../../models/index.js';
import { notFound, conflict, bad, forbidden, escapeRegex } from '../../core/utils.js';
import { nextSeq, settingsOf, loadSchool } from '../../services/context.js';
import { createUserAccount, hashPassword, schoolCode } from '../../services/users.js';
import { initialPassword } from '../../services/initialPassword.js';
import { generatePassword } from '../../core/utils.js';
import { User, Session } from '../../models/index.js';

/** Titles every school starts with. A school can add its own, rename or archive them. */
export const DEFAULT_DESIGNATIONS = [
  { name: 'Driver', group: 'transport', busRole: 'driver' }, { name: 'Conductor', group: 'transport', busRole: 'conductor' }, { name: 'Transport Maintainer', group: 'transport' },
  { name: 'Peon', group: 'general' }, { name: 'Maid', group: 'general' }, { name: 'Sweeper', group: 'general' }, { name: 'Gardener', group: 'general' },
  { name: 'Security Guard', group: 'general' }, { name: 'Lab Assistant', group: 'general' }, { name: 'Office Clerk', group: 'general' },
  { name: 'PT Teacher', group: 'general' }, { name: 'Accountant', group: 'general' }, { name: 'School Counsellor', group: 'general' }, { name: 'School Nurse', group: 'general' }, { name: 'Computer Operator', group: 'general' },
  // the ranks of teachers. A school can add its own; a teacher can hold only a rank that is registered here
  { name: 'Principal', group: 'teaching' }, { name: 'Vice Principal', group: 'teaching' }, { name: 'Head of Department', group: 'teaching' }, { name: 'Coordinator', group: 'teaching' },
  { name: 'PGT', group: 'teaching' }, { name: 'TGT', group: 'teaching' }, { name: 'PRT', group: 'teaching' }, { name: 'Nursery Teacher', group: 'teaching' },
];

/** Each kind of designation starts with the usual ones, once, the first time the school needs it. After that the school's own list is the list. */
export async function ensureDesignations(tenantId, groups = ['general', 'transport', 'teaching']) {
  for (const g of groups) {
    if (await Designation.exists({ tenantId, group: g })) continue;
    const have = new Set((await Designation.find({ tenantId }).select('name').lean()).map((d) => d.name.toLowerCase()));
    const rows = DEFAULT_DESIGNATIONS.filter((d) => d.group === g && !have.has(d.name.toLowerCase())).map((d) => ({ ...d, tenantId }));
    if (rows.length) await Designation.insertMany(rows, { ordered: false }).catch(() => {});
  }
}

/**
 * A teacher's rank must be one the school has registered (Employees → Designations). Give the id or the name; both come back.
 * Nothing given = no rank. An unknown name is refused, so the list never fills with spellings.
 */
export async function resolveTeacherDesignation(tenantId, { designationId, designation }) {
  if (designationId === '' || (designationId === undefined && designation === '')) return { designationId: null, designation: '' };
  if (!designationId && !designation) return null;
  await ensureDesignations(tenantId, ['teaching']);
  const d = designationId
    ? await Designation.findOne({ _id: designationId, tenantId, group: 'teaching' })
    : await Designation.findOne({ tenantId, group: 'teaching', name: new RegExp(`^${escapeRegex(String(designation).trim())}$`, 'i') });
  if (!d) throw bad(`"${designation || 'That rank'}" is not a designation of this school. Add it under Designations first.`);
  if (d.status !== 'active') throw bad(`"${d.name}" is archived`);
  return { designationId: d._id, designation: d.name };
}

/**
 * Two separate worlds. The Transport officer (scope 'transport') owns transport designations and staff: drivers, conductors, maintainers.
 * The School Admin (scope 'general') owns every other non-teaching staff member: maids, sweepers, gardeners, guards, clerks…
 */
const groupOf = (scope) => (scope === 'transport' ? 'transport' : scope === 'teaching' ? 'teaching' : 'general');
const inScope = (scope, group) => group === groupOf(scope);

// ───────────── the school's own officers (finance, librarian, transport officer) ─────────────
export const DESK_TITLES = { finance: 'Finance Officer', library: 'Librarian', transport: 'Transport Officer' };
/** The job title a desk role carries (made when first needed). A title is held by a person; it is never itself on the payroll. */
export async function deskDesignation(tenantId, role) {
  await ensureDesignations(tenantId);
  const title = DESK_TITLES[role];
  return (await Designation.findOne({ tenantId, name: new RegExp(`^${escapeRegex(title)}$`, 'i') })) || Designation.create({ tenantId, name: title, group: 'general' });
}
/**
 * Every desk login is also an employee: it needs a row in the staff list so that it shows in the employee directory and can be marked in the
 * attendance register. This creates the missing rows and keeps the status in step with the login. Safe to call as often as needed.
 */
export async function ensureDeskStaff(tenantId, actorId) {
  const users = await User.find({ tenantId, role: { $in: Object.keys(DESK_TITLES) } }).select('name role status createdAt').lean();
  if (!users.length) return 0;
  await ensureDesignations(tenantId); // the standard titles first, so adding an officer's title never hides them
  const have = new Map((await StaffMember.find({ tenantId, userId: { $in: users.map((u) => u._id) } }).select('userId status').lean()).map((s) => [String(s.userId), s]));
  let made = 0;
  for (const u of users) {
    const want = u.status === 'active' ? 'active' : 'inactive';
    const cur = have.get(String(u._id));
    if (cur) { if (cur.status !== want) await StaffMember.updateOne({ _id: cur._id }, { status: want }); continue; }
    const d = await deskDesignation(tenantId, u.role);
    const seq = await nextSeq(tenantId, 'staff-officer'); // officers have their own numbers (OF0001…), so staff ids (S0001…) are never used up by them
    await StaffMember.create({ tenantId, userId: u._id, staffId: `OF${String(seq).padStart(4, '0')}`, name: u.name, designationId: d._id, deskRole: u.role, joiningDate: u.createdAt?.toISOString().slice(0, 10), status: want, createdBy: actorId });
    made += 1;
  }
  return made;
}

// ───────────── designations ─────────────
export async function listDesignations(ctx, scope) {
  await ensureDesignations(ctx.tenantId, [groupOf(scope)]);
  const [rows, counts] = await Promise.all([
    Designation.find({ tenantId: ctx.tenantId, group: groupOf(scope) }).sort({ name: 1 }).lean(),
    groupOf(scope) === 'teaching'
      ? Teacher.aggregate([{ $match: { tenantId: ctx.tenantId, status: 'active', designationId: { $ne: null } } }, { $group: { _id: '$designationId', n: { $sum: 1 } } }])
      : StaffMember.aggregate([{ $match: { tenantId: ctx.tenantId, status: 'active' } }, { $group: { _id: '$designationId', n: { $sum: 1 } } }]),
  ]);
  const n = new Map(counts.map((c) => [String(c._id), c.n]));
  return rows.map((d) => ({ ...d, staff: n.get(String(d._id)) || 0 }));
}

export async function createDesignation(ctx, scope, body) {
  const group = groupOf(scope);
  if (await Designation.exists({ tenantId: ctx.tenantId, name: new RegExp(`^${escapeRegex(body.name)}$`, 'i') })) throw conflict(`"${body.name}" already exists`);
  return Designation.create({ tenantId: ctx.tenantId, name: body.name, group, busRole: group === 'transport' ? body.busRole || null : null });
}

async function ownDesignation(ctx, scope, id) {
  const d = await Designation.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!d || !inScope(scope, d.group)) throw notFound('Designation not found');
  return d;
}

export async function updateDesignation(ctx, scope, id, patch) {
  const d = await ownDesignation(ctx, scope, id);
  if (patch.name && patch.name.toLowerCase() !== d.name.toLowerCase() && await Designation.exists({ tenantId: ctx.tenantId, name: new RegExp(`^${escapeRegex(patch.name)}$`, 'i'), _id: { $ne: d._id } })) throw conflict(`"${patch.name}" already exists`);
  if (patch.busRole !== undefined && d.group !== 'transport' && patch.busRole) throw bad('Only a transport designation can be a driver or conductor');
  if ((patch.status === 'archived' || (patch.busRole !== undefined && patch.busRole !== d.busRole)) && d.busRole) {
    const onBus = await busesCrewedBy(ctx, d);
    if (onBus.length) throw conflict(`${onBus.length} ${d.name.toLowerCase()}(s) are on a bus. Reassign the bus first.`);
  }
  Object.assign(d, patch);
  return d.save();
}

export async function deleteDesignation(ctx, scope, id) {
  const d = await ownDesignation(ctx, scope, id);
  if (await StaffMember.exists({ tenantId: ctx.tenantId, designationId: d._id }) || await Teacher.exists({ tenantId: ctx.tenantId, designationId: d._id })) throw conflict('Someone holds this designation. Archive it instead of deleting.');
  await d.deleteOne();
}

async function busesCrewedBy(ctx, designation) {
  const ids = (await StaffMember.find({ tenantId: ctx.tenantId, designationId: designation._id }).select('_id').lean()).map((s) => s._id);
  return Bus.find({ tenantId: ctx.tenantId, $or: [{ driverId: { $in: ids } }, { conductorId: { $in: ids } }] }).select('busNo').lean();
}

// ───────────── staff ─────────────
async function busOf(ctx, staffIds) {
  const buses = await Bus.find({ tenantId: ctx.tenantId, $or: [{ driverId: { $in: staffIds } }, { conductorId: { $in: staffIds } }] }).select('busNo driverId conductorId').lean();
  const m = new Map();
  for (const b of buses) { if (b.driverId) m.set(String(b.driverId), { busNo: b.busNo, as: 'driver' }); if (b.conductorId) m.set(String(b.conductorId), { busNo: b.busNo, as: 'conductor' }); }
  return m;
}

export async function listStaff(ctx, scope, q) {
  await ensureDesignations(ctx.tenantId);
  const dFilter = { tenantId: ctx.tenantId, group: groupOf(scope) };
  const designations = await Designation.find(dFilter).lean();
  const D = new Map(designations.map((d) => [String(d._id), d]));
  const f = { tenantId: ctx.tenantId, designationId: { $in: designations.map((d) => d._id) } };
  if (scope !== 'transport') f.deskRole = null; // the school's officers are listed under Employees, not here
  if (q.designationId) f.designationId = q.designationId;
  if (q.status !== 'all') f.status = q.status;
  if (q.q) { const rx = new RegExp(escapeRegex(q.q), 'i'); f.$or = [{ name: rx }, { staffId: rx }, { phone: rx }]; }
  const [total, rows] = await Promise.all([StaffMember.countDocuments(f), StaffMember.find(f).sort({ name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean()]);
  const bus = await busOf(ctx, rows.map((r) => r._id));
  return {
    total, items: rows.map((s) => { const d = D.get(String(s.designationId)); return { ...s, designation: d?.name, group: d?.group, busRole: d?.busRole, bus: bus.get(String(s._id)) || null, hasLogin: !!s.userId }; }),
  };
}

async function loadDesignation(ctx, scope, id) {
  const d = await Designation.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!d) throw notFound('Designation not found');
  if (!inScope(scope, d.group)) throw forbidden(scope === 'transport' ? 'You can add only transport staff' : 'Drivers, conductors and other transport staff are added by the Transport officer');
  if (d.status !== 'active') throw bad(`"${d.name}" is archived`);
  return d;
}

export async function createStaff(ctx, scope, body) {
  const d = await loadDesignation(ctx, scope, body.designationId);
  const seq = await nextSeq(ctx.tenantId, 'staff');
  const s = await StaffMember.create({ ...body, tenantId: ctx.tenantId, staffId: `S${String(seq).padStart(4, '0')}`, createdBy: ctx.actorId });
  return { ...s.toObject(), designation: d.name, group: d.group, busRole: d.busRole };
}

async function ownStaff(ctx, scope, id) {
  const s = await StaffMember.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!s) throw notFound('Staff member not found');
  const d = await Designation.findById(s.designationId).lean();
  if (!inScope(scope, d?.group)) throw notFound('Staff member not found');
  return { s, d };
}

export async function getStaff(ctx, scope, id) {
  const { s, d } = await ownStaff(ctx, scope, id);
  const bus = await busOf(ctx, [s._id]);
  return { ...s.toObject(), designation: d?.name, group: d?.group, busRole: d?.busRole, bus: bus.get(String(s._id)) || null };
}

export async function updateStaff(ctx, scope, id, patch) {
  const { s, d } = await ownStaff(ctx, scope, id);
  if (patch.designationId && String(patch.designationId) !== String(s.designationId)) {
    const nd = await loadDesignation(ctx, scope, patch.designationId);
    if (d?.busRole && nd.busRole !== d.busRole && (await busOf(ctx, [s._id])).has(String(s._id))) throw conflict(`${s.name} is on a bus as ${d.busRole}. Reassign the bus first.`);
  }
  if (patch.canMarkAttendance && (scope === 'transport' || d?.group === 'transport')) throw bad('Transport crew cannot take attendance');
  if (patch.canMarkAttendance === false && s.userId) throw conflict(`${s.name} has a sign-in for the office desk. Remove it before switching the desk off.`);
  Object.assign(s, patch);
  return s.save();
}

export async function setStaffStatus(ctx, scope, id, status) {
  const { s } = await ownStaff(ctx, scope, id);
  if (status === 'inactive') {
    const bus = (await busOf(ctx, [s._id])).get(String(s._id));
    if (bus) throw conflict(`${s.name} is the ${bus.as} of bus ${bus.busNo}. Reassign the bus first.`);
  }
  s.status = status;
  return s.save();
}

// ───────────── a login for staff (so they can use the Staff portal) ─────────────
/** Staff do not need a login to be on the books or on payroll. Giving them one lets them see attendance and payslips and apply for leave. */
export async function createLogin(ctx, scope, id) {
  if (scope === 'transport') throw forbidden('Transport crew have no sign-in. The Transport officer records their attendance and leave.');
  const { s } = await ownStaff(ctx, scope, id);
  if (s.userId) throw conflict(`${s.name} already has a login`);
  // the Staff portal is the office desk (attendance, leave, queries): a login is for someone who is given that work, not for every employee
  if (!s.canMarkAttendance) throw bad(`${s.name} has no office desk duties. Switch on "Office desk" for this person first: only people who work for the office have a sign-in.`);
  const code = await schoolCode(ctx.tenantId);
  const { user, temporaryPassword } = await createUserAccount({ role: 'staff', tenantId: ctx.tenantId, name: s.name, email: s.email, phone: s.phone, dob: s.dob, loginId: `${code}.${s.staffId.toLowerCase()}`, createdBy: ctx.actorId, password: initialPassword(settingsOf(await loadSchool(ctx.tenantId)), { name: s.name, dob: s.dob, phone: s.phone }) });
  s.userId = user._id;
  await s.save();
  return { loginId: user.loginId, temporaryPassword };
}

/** Takes the sign-in away (the person stays on the books and on payroll). Used when someone no longer works for the office desk. */
export async function removeLogin(ctx, scope, id) {
  const { s } = await ownStaff(ctx, scope, id);
  if (!s.userId) throw notFound(`${s.name} has no sign-in`);
  const u = await User.findById(s.userId);
  if (u) { u.status = 'disabled'; await u.save(); await Session.updateMany({ userId: u._id, revokedAt: null }, { revokedAt: new Date() }); }
  s.userId = undefined; s.canMarkAttendance = false;
  await s.save();
  return { ok: true };
}

export async function resetLogin(ctx, scope, id) {
  const { s } = await ownStaff(ctx, scope, id);
  if (!s.userId) throw notFound(`${s.name} has no login yet`);
  const temporaryPassword = initialPassword(settingsOf(await loadSchool(ctx.tenantId)), { name: s.name, dob: s.dob, phone: s.phone }) || generatePassword();
  const u = await User.findById(s.userId);
  u.passwordHash = await hashPassword(temporaryPassword); u.mustChangePassword = true; u.failedLogins = 0; u.lockedUntil = undefined;
  await u.save();
  await Session.updateMany({ userId: u._id, revokedAt: null }, { revokedAt: new Date() });
  return { loginId: u.loginId, temporaryPassword };
}
