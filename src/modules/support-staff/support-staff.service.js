import { Designation, StaffMember, Bus } from '../../models/index.js';
import { notFound, conflict, bad, forbidden, escapeRegex } from '../../core/utils.js';
import { nextSeq } from '../../services/context.js';
import { createUserAccount, hashPassword, schoolCode } from '../../services/users.js';
import { generatePassword } from '../../core/utils.js';
import { User, Session } from '../../models/index.js';

/** Titles every school starts with. A school can add its own, rename or archive them. */
export const DEFAULT_DESIGNATIONS = [
  { name: 'Driver', group: 'transport', busRole: 'driver' }, { name: 'Conductor', group: 'transport', busRole: 'conductor' }, { name: 'Transport Maintainer', group: 'transport' },
  { name: 'Peon', group: 'general' }, { name: 'Maid', group: 'general' }, { name: 'Sweeper', group: 'general' }, { name: 'Gardener', group: 'general' },
  { name: 'Security Guard', group: 'general' }, { name: 'Lab Assistant', group: 'general' }, { name: 'Office Clerk', group: 'general' },
];

export async function ensureDesignations(tenantId) {
  if (await Designation.exists({ tenantId })) return;
  await Designation.insertMany(DEFAULT_DESIGNATIONS.map((d) => ({ ...d, tenantId })), { ordered: false }).catch(() => {});
}

/**
 * Two separate worlds. The Transport officer (scope 'transport') owns transport designations and staff: drivers, conductors, maintainers.
 * The School Admin (scope 'general') owns every other non-teaching staff member: maids, sweepers, gardeners, guards, clerks…
 */
const groupOf = (scope) => (scope === 'transport' ? 'transport' : 'general');
const inScope = (scope, group) => group === groupOf(scope);

// ───────────── designations ─────────────
export async function listDesignations(ctx, scope) {
  await ensureDesignations(ctx.tenantId);
  const [rows, counts] = await Promise.all([
    Designation.find({ tenantId: ctx.tenantId, group: groupOf(scope) }).sort({ name: 1 }).lean(),
    StaffMember.aggregate([{ $match: { tenantId: ctx.tenantId, status: 'active' } }, { $group: { _id: '$designationId', n: { $sum: 1 } } }]),
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
  if (await StaffMember.exists({ tenantId: ctx.tenantId, designationId: d._id })) throw conflict('Staff have this designation. Archive it instead of deleting.');
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
  const { s } = await ownStaff(ctx, scope, id);
  if (s.userId) throw conflict(`${s.name} already has a login`);
  const code = await schoolCode(ctx.tenantId);
  const { user, temporaryPassword } = await createUserAccount({ role: 'staff', tenantId: ctx.tenantId, name: s.name, loginId: `${code}.${s.staffId.toLowerCase()}`, createdBy: ctx.actorId });
  s.userId = user._id;
  await s.save();
  return { loginId: user.loginId, temporaryPassword };
}

export async function resetLogin(ctx, scope, id) {
  const { s } = await ownStaff(ctx, scope, id);
  if (!s.userId) throw notFound(`${s.name} has no login yet`);
  const temporaryPassword = generatePassword();
  const u = await User.findById(s.userId);
  u.passwordHash = await hashPassword(temporaryPassword); u.mustChangePassword = true; u.failedLogins = 0; u.lockedUntil = undefined;
  await u.save();
  await Session.updateMany({ userId: u._id, revokedAt: null }, { revokedAt: new Date() });
  return { loginId: u.loginId, temporaryPassword };
}
