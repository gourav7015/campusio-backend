import { StaffLeave, LeaveGrant, StaffMember, Designation, User } from '../../models/index.js';
import { notFound, conflict, bad, forbidden } from '../../core/utils.js';
import { notifyUsers } from '../../services/notify.js';
import { leaveDays } from '../leave/leave.service.js';

/** The year leave is counted in: the academic year if there is one, otherwise the calendar year. */
const spanOf = (ctx) => (ctx.year ? { from: ctx.year.startDate, to: ctx.year.endDate } : { from: `${ctx.today.slice(0, 4)}-01-01`, to: `${ctx.today.slice(0, 4)}-12-31` });

export async function balances(ctx, staffId) {
  const { from, to } = spanOf(ctx);
  const approved = await StaffLeave.find({ tenantId: ctx.tenantId, staffId, status: 'approved', startDate: { $gte: from }, endDate: { $lte: to } }).lean();
  const extra = await LeaveGrant.find({ tenantId: ctx.tenantId, personType: 'staff', personId: staffId, yearKey: ctx.year ? String(ctx.year._id) : ctx.today.slice(0, 4) }).lean();
  const out = {};
  for (const [type, base] of Object.entries(ctx.settings.staffLeaveBalances || {})) {
    const used = approved.filter((l) => l.leaveType === type).reduce((n, l) => n + (l.days || 0), 0);
    const granted = extra.filter((g) => g.leaveType === type).reduce((n, g) => n + g.days, 0);
    const allowance = base + granted;
    out[type] = { allowance, base, granted, used, remaining: Math.max(allowance - used, 0) };
  }
  out.unpaid = { allowance: null, used: approved.filter((l) => l.leaveType === 'unpaid').reduce((n, l) => n + (l.days || 0), 0), remaining: null };
  return out;
}

async function assertAvailable(ctx, staffId, body) {
  const days = leaveDays(ctx.settings, body);
  const overlap = await StaffLeave.exists({ tenantId: ctx.tenantId, staffId, status: { $in: ['submitted', 'approved'] }, startDate: { $lte: body.endDate }, endDate: { $gte: body.startDate } });
  if (overlap) throw conflict('There is already a leave application overlapping those dates');
  const bal = (await balances(ctx, staffId))[body.leaveType];
  if (bal && bal.allowance != null && bal.allowance > 0 && days > bal.remaining) throw conflict(`Only ${bal.remaining} day(s) of ${body.leaveType} leave remain`);
  if (bal && bal.allowance === 0) throw conflict(`There is no ${body.leaveType} leave allowance. Apply for unpaid leave instead.`);
  return days;
}

// ───────────── the staff member's own leave (Staff portal) ─────────────
export const listMine = (ctx) => StaffLeave.find({ tenantId: ctx.tenantId, staffId: ctx.staff._id }).sort({ createdAt: -1 }).lean();

export async function apply(ctx, body) {
  const days = await assertAvailable(ctx, ctx.staff._id, body);
  return StaffLeave.create({ tenantId: ctx.tenantId, staffId: ctx.staff._id, userId: ctx.actorId, group: ctx.group, ...body, days, status: 'submitted' });
}

export async function cancel(ctx, id) {
  const l = await StaffLeave.findOne({ _id: id, tenantId: ctx.tenantId, staffId: ctx.staff._id });
  if (!l) throw notFound('Leave application not found');
  if (!['submitted', 'approved'].includes(l.status)) throw conflict(`A ${l.status} application cannot be cancelled`);
  if (l.status === 'approved' && l.startDate <= ctx.today) throw conflict('Approved leave that has already started cannot be cancelled');
  l.status = 'cancelled';
  return l.save();
}

// ───────────── the desk that looks after a group (admin: general staff, Transport officer: transport staff) ─────────────
const isAdmin = (ctx) => ctx.role === 'school_admin' || ctx.role === 'super_admin';
/** Does the school keep the right to approve transport staff leave for its admin? */
export const adminKeepsTransportLeave = (ctx) => ctx.settings?.transportLeaveApprover === 'admin';

/** School admins who handle staff leave: the full admins, and sub-admins who hold the staff attendance permission. */
async function adminIds(tenantId) {
  const admins = await User.find({ tenantId, role: 'school_admin', status: 'active' }).select('adminLevel permissions').lean();
  return admins.filter((a) => a.adminLevel !== 'sub' || (a.permissions || []).includes('staff_attendance')).map((a) => a._id);
}
async function tellAdmins(ctx, l, name, { title, key }) {
  await notifyUsers(ctx.tenantId, await adminIds(ctx.tenantId), { category: 'leave', title, body: `${name}: ${l.leaveType} leave, ${l.startDate} to ${l.endDate}`, link: { type: 'staff_leave', id: String(l._id) }, dedupeKey: `staffleave:${l._id}:${key}:admin` });
}
const nameOf = async (l) => (await StaffMember.findById(l.staffId).select('name').lean())?.name || 'A staff member';

export async function listForGroup(ctx, group, { status }) {
  const f = { tenantId: ctx.tenantId, group };
  if (status) f.status = status;
  const rows = await StaffLeave.find(f).populate('staffId', 'name staffId designationId').sort({ createdAt: -1 }).limit(300).lean();
  // canDecide: may the person looking at this list approve or reject it? Passing it to the admin takes it away from the desk.
  return rows.map((l) => ({ ...l, canDecide: l.status === 'submitted' && (isAdmin(ctx) || (!l.awaitingAdmin && !(group === 'transport' && adminKeepsTransportLeave(ctx)))), canPassOn: l.status === 'submitted' && !isAdmin(ctx) && group === 'transport' && !l.awaitingAdmin }));
}

export async function decide(ctx, group, id, { decision, remark }) {
  const l = await StaffLeave.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!l || l.group !== group) throw notFound('Leave application not found');
  if (l.status !== 'submitted') throw conflict(`This application is ${l.status}`);
  if (!isAdmin(ctx) && group === 'transport') {
    if (l.awaitingAdmin) throw forbidden('This leave was sent to the school admin to decide');
    if (adminKeepsTransportLeave(ctx)) throw forbidden('The school has kept leave approval for the admin. Send the application to the admin instead.');
  }
  l.status = decision === 'approve' ? 'approved' : 'rejected';
  l.awaitingAdmin = false; l.decisionBy = ctx.actorId; l.decisionRemark = remark; l.decidedAt = new Date();
  await l.save();
  await notifyUsers(ctx.tenantId, [l.userId], { category: 'leave', title: `Leave ${l.status}`, body: `${l.startDate} to ${l.endDate}${remark ? ` — ${remark}` : ''}`, link: { type: 'leave', id: String(l._id) }, dedupeKey: `staffleave:${l._id}:${l.status}` });
  // the admin is kept informed of what the desk decided
  if (!isAdmin(ctx) && group === 'transport') await tellAdmins(ctx, l, await nameOf(l), { title: `Transport staff leave ${l.status} by the Transport officer`, key: l.status });
  // the Transport officer hears back about a leave they passed on
  if (isAdmin(ctx) && group === 'transport') {
    const officers = (await User.find({ tenantId: ctx.tenantId, role: 'transport', status: 'active' }).select('_id').lean()).map((u) => u._id);
    await notifyUsers(ctx.tenantId, officers, { category: 'leave', title: `Transport staff leave ${l.status} by the School Admin`, body: `${await nameOf(l)}: ${l.startDate} to ${l.endDate}${remark ? ` — ${remark}` : ''}`, link: { type: 'leave', id: String(l._id) }, dedupeKey: `staffleave:${l._id}:${l.status}:officer` });
  }
  return l;
}

/** The Transport officer passes a waiting application to the School Admin to decide. */
export async function passToAdmin(ctx, group, id) {
  if (group !== 'transport' || isAdmin(ctx)) throw bad('Only the Transport officer can pass transport leave on to the admin');
  const l = await StaffLeave.findOne({ _id: id, tenantId: ctx.tenantId, group });
  if (!l) throw notFound('Leave application not found');
  if (l.status !== 'submitted') throw conflict(`This application is ${l.status}`);
  if (l.awaitingAdmin) return l;
  l.awaitingAdmin = true; await l.save();
  await tellAdmins(ctx, l, await nameOf(l), { title: 'Transport staff leave needs your approval', key: 'passed' });
  return l;
}

export async function record(ctx, group, body) {
  const s = await StaffMember.findOne({ _id: body.staffId, tenantId: ctx.tenantId, status: 'active' });
  if (!s) throw notFound('Staff member not found');
  const d = await Designation.findById(s.designationId).lean();
  if ((d?.group === 'transport' ? 'transport' : 'general') !== group) throw forbidden('That person belongs to another desk');
  const days = await assertAvailable(ctx, s._id, body);
  const { staffId: _drop, sendToAdmin, ...rest } = body;
  // the officer may approve straight away, or pass it to the admin; where the school keeps the right for its admin, it always goes to the admin
  const viaAdmin = group === 'transport' && !isAdmin(ctx) && (sendToAdmin || adminKeepsTransportLeave(ctx));
  const base = { tenantId: ctx.tenantId, staffId: s._id, userId: s.userId, group, ...rest, days, recordedBy: ctx.actorId };
  const l = viaAdmin ? await StaffLeave.create({ ...base, status: 'submitted', awaitingAdmin: true }) : await StaffLeave.create({ ...base, status: 'approved', decisionBy: ctx.actorId, decidedAt: new Date() });
  if (group === 'transport' && !isAdmin(ctx)) {
    await tellAdmins(ctx, l, s.name, viaAdmin ? { title: 'Transport staff leave needs your approval', key: 'recorded' } : { title: 'Transport staff leave recorded and approved by the Transport officer', key: 'recorded' });
  }
  return l;
}
