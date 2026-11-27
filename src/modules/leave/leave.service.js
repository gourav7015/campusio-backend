import { LeaveApplication, LeaveGrant, Teacher, User } from '../../models/index.js';
import { notFound, conflict, bad, forbidden, eachDate, isoDay, addDays } from '../../core/utils.js';
import { notifyUsers } from '../../services/notify.js';
import { LEAVE_DECIDERS, holdsAny } from '../sub-admins/permissions.js';

export function countDays(settings, start, end) {
  return eachDate(start, end).filter((d) => settings.workingDays.includes(isoDay(d))).length;
}

/** Working days a leave takes. A half day is one working date and counts 0.5. */
export function leaveDays(settings, { startDate, endDate, halfDay }) {
  if (halfDay) {
    if (startDate !== endDate) throw bad('A half day is for one date: use the same start and end date');
    if (countDays(settings, startDate, endDate) < 1) throw bad('That date is not a working day');
    return 0.5;
  }
  const days = countDays(settings, startDate, endDate);
  if (days < 1) throw bad('The selected dates contain no working days');
  return days;
}

/**
 * The school's rules on applying for leave, which differ for teaching and non-teaching staff (Settings → Leave rules).
 * Checked when a person applies for themselves; the office recording leave on someone's behalf is not held to them. 0 means no limit.
 */
export function assertLeaveRules(ctx, rules, who, days, { leaveType, startDate, halfDay }) {
  const r = rules || {};
  if (halfDay && r.halfDay === false) throw conflict(`Half-day leave is not allowed for ${who}`);
  if (r.maxDays > 0 && days > r.maxDays) throw conflict(`One application for ${who} can cover at most ${r.maxDays} day${r.maxDays === 1 ? '' : 's'}. Apply in parts, or ask the office.`);
  if (r.noticeDays > 0 && leaveType !== 'sick') {
    const ahead = startDate > ctx.today ? eachDate(ctx.today, startDate).length - 1 : 0;
    if (ahead < r.noticeDays) throw conflict(`Leave for ${who} must be applied for at least ${r.noticeDays} day${r.noticeDays === 1 ? '' : 's'} ahead (sick leave is exempt)`);
  }
}

/**
 * Taking approved leave back while its dates have not all gone. Leave that has not begun (or begins today) is cancelled whole. Leave that is already running
 * ends yesterday: the days already taken stay as leave, the rest go back. Leave that is over cannot be taken back. Returns 'cancel' or 'end_early'
 * and, for the second, has already changed the leave's end date and days (the caller saves it).
 */
export function takeBack(ctx, l) {
  if (l.endDate < ctx.today) throw conflict('That leave is already over, so it cannot be cancelled');
  if (l.startDate >= ctx.today) return 'cancel';
  const end = addDays(ctx.today, -1);
  if (countDays(ctx.settings, l.startDate, end) < 1) return 'cancel'; // nothing but non-working days has gone by
  l.endDate = end; l.days = countDays(ctx.settings, l.startDate, end); l.halfDay = false; l.halfSession = undefined;
  return 'end_early';
}

export async function balances(ctx, teacherId) {
  const approved = await LeaveApplication.find({
    tenantId: ctx.tenantId, teacherId, status: 'approved', startDate: { $gte: ctx.year.startDate }, endDate: { $lte: ctx.year.endDate },
  }).lean();
  const extra = await LeaveGrant.find({ tenantId: ctx.tenantId, personType: 'teacher', personId: teacherId, yearKey: String(ctx.year._id) }).lean();
  const out = {};
  // allowance = what the school settings give everyone + any extra leave the admin gave this teacher (granted, shown separately)
  for (const [type, base] of Object.entries(ctx.settings.leaveBalances)) {
    const used = approved.filter((l) => l.leaveType === type).reduce((n, l) => n + (l.days || 0), 0);
    const granted = extra.filter((g) => g.leaveType === type).reduce((n, g) => n + g.days, 0);
    const allowance = base + granted;
    out[type] = { allowance, base, granted, used, remaining: Math.max(allowance - used, 0) };
  }
  return out;
}

/** The people who decide a teacher's leave: the full admins, and sub-admins who were given leave approval (or the teachers permission, which always included it). They, and only they, are told about leave. */
export async function leaveApproverIds(tenantId) {
  const admins = await User.find({ tenantId, role: 'school_admin', status: 'active' }).select('_id adminLevel permissions role').lean();
  return admins.filter((u) => holdsAny(u, LEAVE_DECIDERS)).map((u) => u._id);
}
const tellApprovers = async (ctx, l, { title, key }) => notifyUsers(ctx.tenantId, await leaveApproverIds(ctx.tenantId), {
  category: 'leave', title, body: `${ctx.teacher.name}: ${l.leaveType} leave, ${l.startDate} to ${l.endDate}${l.reason ? ` — ${l.reason}` : ''}`, link: { type: 'leave', id: String(l._id) }, dedupeKey: `leave:${l._id}:${key}`,
});
/** Active teachers, by name only: what the leave screen needs to offer a substitute (so deciding leave does not need access to the teacher records). */
export const substituteChoices = (ctx) => Teacher.find({ tenantId: ctx.tenantId, status: 'active' }).select('name employeeId').sort({ name: 1 }).lean();

export const listMine = (ctx) => LeaveApplication.find({ tenantId: ctx.tenantId, teacherId: ctx.teacher._id }).sort({ createdAt: -1 }).lean();

export async function apply(ctx, body) {
  const days = leaveDays(ctx.settings, body);
  assertLeaveRules(ctx, ctx.settings.leaveRules?.teaching, 'teaching staff', days, body);
  const overlap = await LeaveApplication.exists({
    tenantId: ctx.tenantId, teacherId: ctx.teacher._id, status: { $in: ['submitted', 'approved'] }, startDate: { $lte: body.endDate }, endDate: { $gte: body.startDate },
  });
  if (overlap) throw conflict('You already have a leave application overlapping those dates');
  const bal = (await balances(ctx, ctx.teacher._id))[body.leaveType];
  if (bal && bal.allowance > 0 && days > bal.remaining) throw conflict(`Only ${bal.remaining} day(s) of ${body.leaveType} leave remain`);
  const leave = await LeaveApplication.create({
    tenantId: ctx.tenantId, teacherId: ctx.teacher._id, userId: ctx.actorId, leaveType: body.leaveType, startDate: body.startDate, endDate: body.endDate, halfDay: !!body.halfDay, halfSession: body.halfDay ? body.halfSession || 'second' : undefined,
    days, reason: body.reason, status: body.draft ? 'draft' : 'submitted',
  });
  if (leave.status === 'submitted') await tellApprovers(ctx, leave, { title: 'New leave application', key: 'submitted' });
  return leave;
}

export async function submitDraft(ctx, id) {
  const l = await LeaveApplication.findOne({ _id: id, tenantId: ctx.tenantId, teacherId: ctx.teacher._id });
  if (!l) throw notFound('Leave application not found');
  if (l.status !== 'draft') throw conflict('Only drafts can be submitted');
  l.status = 'submitted';
  await l.save();
  await tellApprovers(ctx, l, { title: 'New leave application', key: 'submitted' });
  return l;
}

export async function cancel(ctx, id) {
  const l = await LeaveApplication.findOne({ _id: id, tenantId: ctx.tenantId, teacherId: ctx.teacher._id });
  if (!l) throw notFound('Leave application not found');
  if (!['draft', 'submitted', 'approved'].includes(l.status)) throw conflict(`A ${l.status} application cannot be cancelled`);
  const was = l.status;
  const how = was === 'approved' ? takeBack(ctx, l) : 'cancel';
  if (how === 'cancel') l.status = 'cancelled';
  l.withdrawnAt = new Date(); l.withdrawnBy = ctx.actorId;
  await l.save();
  // the office is told when an application it was about to decide, or leave it had approved, is taken back
  if (was !== 'draft') {
    await tellApprovers(ctx, l, { title: how === 'end_early' ? 'Approved leave ended early' : was === 'approved' ? 'Approved leave cancelled' : 'Leave application withdrawn', key: how === 'end_early' ? `ended:${l.endDate}` : 'withdrawn' });
  }
  return l;
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

/** The office takes a teacher's leave back (cancels it, or ends it early if it is running) and tells the teacher. */
export async function cancelByOffice(ctx, id) {
  const l = await LeaveApplication.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!l) throw notFound('Leave application not found');
  if (!['submitted', 'approved'].includes(l.status)) throw conflict(`A ${l.status} application cannot be cancelled`);
  const was = l.status;
  const how = was === 'approved' ? takeBack(ctx, l) : 'cancel';
  if (how === 'cancel') l.status = 'cancelled';
  l.withdrawnAt = new Date(); l.withdrawnBy = ctx.actorId;
  await l.save();
  const t = await Teacher.findById(l.teacherId).select('userId');
  await notifyUsers(ctx.tenantId, [t?.userId], { category: 'leave', title: how === 'end_early' ? 'Your leave was ended early' : was === 'approved' ? 'Your approved leave was cancelled' : 'Your leave application was withdrawn', body: `${l.startDate} to ${l.endDate}`, link: { type: 'leave', id: String(l._id) }, dedupeKey: `leave:${l._id}:office-${how}:${l.endDate}` });
  return { leave: l, how };
}
