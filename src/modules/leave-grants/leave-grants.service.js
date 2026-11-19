import { LeaveGrant, Teacher, StaffMember, Designation } from '../../models/index.js';
import { notFound, bad } from '../../core/utils.js';
import { notifyUsers } from '../../services/notify.js';
import { balances as teacherBalances } from '../leave/leave.service.js';
import { balances as staffBalances } from '../staff-leave/staff-leave.service.js';

/** Extra leave belongs to a school year; with no academic year set up it belongs to the calendar year (the same span staff leave is counted in). */
export const yearKeyOf = (ctx) => (ctx.year ? String(ctx.year._id) : (ctx.today || new Date().toISOString().slice(0, 10)).slice(0, 4));

/** Days of extra leave per person and type: Map(personId → { casual: 2, ... }). */
export async function grantTotals(ctx, personType, personIds) {
  const rows = await LeaveGrant.find({ tenantId: ctx.tenantId, personType, personId: { $in: personIds }, yearKey: yearKeyOf(ctx) }).lean();
  const out = new Map();
  for (const g of rows) {
    const m = out.get(String(g.personId)) || {};
    m[g.leaveType] = (m[g.leaveType] || 0) + g.days;
    out.set(String(g.personId), m);
  }
  return out;
}
export async function grantsOf(ctx, personType, personId) {
  return LeaveGrant.find({ tenantId: ctx.tenantId, personType, personId, yearKey: yearKeyOf(ctx) }).sort({ createdAt: -1 }).populate('grantedBy', 'name').lean();
}

async function personOf(ctx, personType, personId) {
  const p = personType === 'teacher'
    ? await Teacher.findOne({ _id: personId, tenantId: ctx.tenantId }).select('name userId status').lean()
    : await StaffMember.findOne({ _id: personId, tenantId: ctx.tenantId }).select('name userId status').lean();
  if (!p) throw notFound('Person not found');
  return p;
}

export async function addGrant(ctx, { personType, personId, leaveType, days, reason }) {
  const p = await personOf(ctx, personType, personId);
  if (p.status === 'inactive') throw bad('This person is no longer active');
  const g = await LeaveGrant.create({ tenantId: ctx.tenantId, personType, personId, yearKey: yearKeyOf(ctx), leaveType, days, reason, grantedBy: ctx.actorId });
  if (p.userId) await notifyUsers(ctx.tenantId, [p.userId], { category: 'leave', title: 'Extra leave added', body: `${days} day(s) of ${leaveType} leave were added to your balance: ${reason}`, dedupeKey: `leavegrant:${g._id}` });
  return { grant: g, name: p.name };
}

export async function getGrant(ctx, id) {
  const g = await LeaveGrant.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!g) throw notFound('Extra leave not found');
  return g;
}

export async function removeGrant(ctx, g) {
  const bal = (await (g.personType === 'teacher' ? teacherBalances : staffBalances)(ctx, g.personId))[g.leaveType];
  if (bal && bal.used > bal.allowance - g.days) throw bad(`Not possible: ${bal.used} day(s) of ${g.leaveType} leave were already taken, so the balance cannot be lowered by ${g.days}`);
  await g.deleteOne();
  return g;
}

/** Everyone in a group with what they may take, have taken and have left. group: teachers | general | transport. */
export async function listBalances(ctx, group) {
  let people;
  let personType;
  if (group === 'teachers') {
    personType = 'teacher';
    people = (await Teacher.find({ tenantId: ctx.tenantId, status: 'active' }).select('name employeeId designation').sort({ name: 1 }).lean()).map((t) => ({ id: t._id, name: t.name, code: t.employeeId, title: t.designation || 'Teacher' }));
  } else {
    personType = 'staff';
    const desig = await Designation.find({ tenantId: ctx.tenantId, group }).select('name').lean();
    const names = new Map(desig.map((d) => [String(d._id), d.name]));
    const rows = await StaffMember.find({ tenantId: ctx.tenantId, status: 'active', designationId: { $in: [...names.keys()] } }).select('name staffId designationId').sort({ name: 1 }).lean();
    people = rows.map((s) => ({ id: s._id, name: s.name, code: s.staffId, title: names.get(String(s.designationId)) }));
  }
  const bal = personType === 'teacher' ? teacherBalances : staffBalances;
  const rows = await Promise.all(people.map(async (p) => ({ ...p, balances: await bal(ctx, p.id) })));
  return { personType, rows };
}
