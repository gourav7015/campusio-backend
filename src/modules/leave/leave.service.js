import { LeaveApplication, Teacher } from '../../models/index.js';
import { notFound, conflict, bad, forbidden, eachDate, isoDay } from '../../core/utils.js';
import { notifyUsers } from '../../services/notify.js';

export function countDays(settings, start, end) {
  return eachDate(start, end).filter((d) => settings.workingDays.includes(isoDay(d))).length;
}

export async function balances(ctx, teacherId) {
  const approved = await LeaveApplication.find({
    tenantId: ctx.tenantId, teacherId, status: 'approved', startDate: { $gte: ctx.year.startDate }, endDate: { $lte: ctx.year.endDate },
  }).lean();
  const out = {};
  for (const [type, allowance] of Object.entries(ctx.settings.leaveBalances)) {
    const used = approved.filter((l) => l.leaveType === type).reduce((n, l) => n + (l.days || 0), 0);
    out[type] = { allowance, used, remaining: Math.max(allowance - used, 0) };
  }
  return out;
}

export const listMine = (ctx) => LeaveApplication.find({ tenantId: ctx.tenantId, teacherId: ctx.teacher._id }).sort({ createdAt: -1 }).lean();

export async function apply(ctx, body) {
  const days = countDays(ctx.settings, body.startDate, body.endDate);
  if (days < 1) throw bad('The selected dates contain no working days');
  const overlap = await LeaveApplication.exists({
    tenantId: ctx.tenantId, teacherId: ctx.teacher._id, status: { $in: ['submitted', 'approved'] }, startDate: { $lte: body.endDate }, endDate: { $gte: body.startDate },
  });
  if (overlap) throw conflict('You already have a leave application overlapping those dates');
  const bal = (await balances(ctx, ctx.teacher._id))[body.leaveType];
  if (bal && bal.allowance > 0 && days > bal.remaining) throw conflict(`Only ${bal.remaining} day(s) of ${body.leaveType} leave remain`);
  const leave = await LeaveApplication.create({
    tenantId: ctx.tenantId, teacherId: ctx.teacher._id, userId: ctx.actorId, leaveType: body.leaveType, startDate: body.startDate, endDate: body.endDate,
    days, reason: body.reason, status: body.draft ? 'draft' : 'submitted',
  });
  return leave;
}

export async function submitDraft(ctx, id) {
  const l = await LeaveApplication.findOne({ _id: id, tenantId: ctx.tenantId, teacherId: ctx.teacher._id });
  if (!l) throw notFound('Leave application not found');
  if (l.status !== 'draft') throw conflict('Only drafts can be submitted');
  l.status = 'submitted';
  return l.save();
}

export async function cancel(ctx, id) {
  const l = await LeaveApplication.findOne({ _id: id, tenantId: ctx.tenantId, teacherId: ctx.teacher._id });
  if (!l) throw notFound('Leave application not found');
  if (!['draft', 'submitted', 'approved'].includes(l.status)) throw conflict(`A ${l.status} application cannot be cancelled`);
  if (l.status === 'approved' && l.startDate <= ctx.today) throw conflict('Approved leave that has already started cannot be cancelled');
  l.status = 'cancelled';
  return l.save();
}

export async function listAll(ctx, { status }) {
  const f = { tenantId: ctx.tenantId, status: { $ne: 'draft' } };
  if (status) f.status = status;
  const rows = await LeaveApplication.find(f).populate('teacherId', 'name employeeId').sort({ createdAt: -1 }).limit(200).lean();
  return rows;
}

/** Leave is decided by an authorised administrator, never by the applicant. */
export async function decide(ctx, id, { decision, remark }) {
  if (ctx.role === 'teacher') throw forbidden('Teachers cannot decide leave');
  const l = await LeaveApplication.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!l) throw notFound('Leave application not found');
  if (l.status !== 'submitted') throw conflict(`This application is ${l.status}`);
  l.status = decision === 'approve' ? 'approved' : 'rejected';
  l.decisionBy = ctx.actorId; l.decisionRemark = remark; l.decidedAt = new Date();
  await l.save();
  const t = await Teacher.findById(l.teacherId).select('userId');
  await notifyUsers(ctx.tenantId, [t?.userId], {
    category: 'leave', title: `Leave ${l.status}`, body: `${l.startDate} to ${l.endDate}${remark ? ` — ${remark}` : ''}`, link: { type: 'leave', id: String(l._id) }, dedupeKey: `leave:${l._id}:${l.status}`,
  });
  return l;
}
