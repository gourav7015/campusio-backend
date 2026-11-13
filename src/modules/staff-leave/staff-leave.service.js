import { StaffLeave, StaffMember, Designation } from '../../models/index.js';
import { notFound, conflict, bad, forbidden } from '../../core/utils.js';
import { notifyUsers } from '../../services/notify.js';
import { countDays } from '../leave/leave.service.js';

/** The year leave is counted in: the academic year if there is one, otherwise the calendar year. */
const spanOf = (ctx) => (ctx.year ? { from: ctx.year.startDate, to: ctx.year.endDate } : { from: `${ctx.today.slice(0, 4)}-01-01`, to: `${ctx.today.slice(0, 4)}-12-31` });

export async function balances(ctx, staffId) {
  const { from, to } = spanOf(ctx);
  const approved = await StaffLeave.find({ tenantId: ctx.tenantId, staffId, status: 'approved', startDate: { $gte: from }, endDate: { $lte: to } }).lean();
  const out = {};
  for (const [type, allowance] of Object.entries(ctx.settings.staffLeaveBalances || {})) {
    const used = approved.filter((l) => l.leaveType === type).reduce((n, l) => n + (l.days || 0), 0);
    out[type] = { allowance, used, remaining: Math.max(allowance - used, 0) };
  }
  out.unpaid = { allowance: null, used: approved.filter((l) => l.leaveType === 'unpaid').reduce((n, l) => n + (l.days || 0), 0), remaining: null };
  return out;
}

async function assertAvailable(ctx, staffId, body) {
  const days = countDays(ctx.settings, body.startDate, body.endDate);
  if (days < 1) throw bad('The selected dates contain no working days');
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
export async function listForGroup(ctx, group, { status }) {
  const f = { tenantId: ctx.tenantId, group };
  if (status) f.status = status;
  return StaffLeave.find(f).populate('staffId', 'name staffId designationId').sort({ createdAt: -1 }).limit(300).lean();
}

export async function decide(ctx, group, id, { decision, remark }) {
  const l = await StaffLeave.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!l || l.group !== group) throw notFound('Leave application not found');
  if (l.status !== 'submitted') throw conflict(`This application is ${l.status}`);
  l.status = decision === 'approve' ? 'approved' : 'rejected';
  l.decisionBy = ctx.actorId; l.decisionRemark = remark; l.decidedAt = new Date();
  await l.save();
  await notifyUsers(ctx.tenantId, [l.userId], { category: 'leave', title: `Leave ${l.status}`, body: `${l.startDate} to ${l.endDate}${remark ? ` — ${remark}` : ''}`, link: { type: 'leave', id: String(l._id) }, dedupeKey: `staffleave:${l._id}:${l.status}` });
  return l;
}

export async function record(ctx, group, body) {
  const s = await StaffMember.findOne({ _id: body.staffId, tenantId: ctx.tenantId, status: 'active' });
  if (!s) throw notFound('Staff member not found');
  const d = await Designation.findById(s.designationId).lean();
  if ((d?.group === 'transport' ? 'transport' : 'general') !== group) throw forbidden('That person belongs to another desk');
  const days = await assertAvailable(ctx, s._id, body);
  const { staffId: _drop, ...rest } = body;
  return StaffLeave.create({ tenantId: ctx.tenantId, staffId: s._id, userId: s.userId, group, ...rest, days, status: 'approved', recordedBy: ctx.actorId, decisionBy: ctx.actorId, decidedAt: new Date() });
}
