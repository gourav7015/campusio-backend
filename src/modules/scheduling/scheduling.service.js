import {
  SwapRequest, TimetableEntry, TeachingAssignment, Teacher, Substitution, Section, ClassModel, Subject, TimetablePeriod, AttendanceException, AttendanceSession, AttendanceRecord,
  PeriodAttendanceSession, StudentEnrolment, Student, User, LeaveApplication, StaffLeave, ClassTeacherAssignment,
} from '../../models/index.js';
import { notFound, conflict, bad, forbidden, isoDay, addDays } from '../../core/utils.js';
import { notifyUsers } from '../../services/notify.js';
import { createSubstitution, deleteSubstitution } from '../timetable/timetable.service.js';
import { countDays } from '../leave/leave.service.js';
import { isHoliday } from '../attendance/attendance.service.js';

const mk = (a) => new Map(a.map((x) => [String(x._id), x]));
const adminIds = async (tenantId) => (await User.find({ tenantId, role: 'school_admin', status: 'active' }).select('_id').lean()).map((u) => u._id);

// ───────────── period swaps and cover ─────────────
async function ownedEntry(ctx, entryId, teacherId, date) {
  const entry = await TimetableEntry.findOne({ _id: entryId, tenantId: ctx.tenantId });
  if (!entry) throw notFound('Timetable period not found');
  const asg = await TeachingAssignment.findOne({ _id: entry.assignmentId, tenantId: ctx.tenantId });
  if (!asg || String(asg.teacherId) !== String(teacherId)) throw forbidden('That period does not belong to this teacher');
  if (isoDay(date) !== entry.day) throw bad('That date does not fall on the weekday of this period');
  if (await Substitution.exists({ tenantId: ctx.tenantId, entryId: entry._id, date })) throw conflict('That period already has a substitute for that date');
  return entry;
}

export async function requestSwap(ctx, user, { date, fromEntryId, toTeacherId, toEntryId, reason }) {
  if (date < ctx.today) throw bad('A swap must be for today or a later date');
  if (String(toTeacherId) === String(ctx.teacher._id)) throw bad('Choose another teacher');
  const other = await Teacher.findOne({ _id: toTeacherId, tenantId: ctx.tenantId, status: 'active' });
  if (!other) throw notFound('That teacher was not found');
  await ownedEntry(ctx, fromEntryId, ctx.teacher._id, date);
  if (toEntryId) await ownedEntry(ctx, toEntryId, other._id, date);
  if (await SwapRequest.exists({ tenantId: ctx.tenantId, fromEntryId, date, status: 'pending' })) throw conflict('There is already a pending request for that period');
  const s = await SwapRequest.create({ tenantId: ctx.tenantId, date, reason, fromTeacherId: ctx.teacher._id, fromEntryId, toTeacherId: other._id, toEntryId: toEntryId || undefined });
  await notifyUsers(ctx.tenantId, [other.userId], { category: 'timetable', title: 'Period swap request', body: `${ctx.teacher.name} asks you to take a period on ${date}${reason ? `: ${reason}` : ''}`, link: { type: 'swap', id: String(s._id) }, dedupeKey: `swap:${s._id}:ask` });
  return s;
}

async function describe(ctx, rows) {
  const entries = mk(await TimetableEntry.find({ tenantId: ctx.tenantId, _id: { $in: rows.flatMap((r) => [r.fromEntryId, r.toEntryId]).filter(Boolean) } }).lean());
  const [asgs, periods, secs] = await Promise.all([
    TeachingAssignment.find({ tenantId: ctx.tenantId, _id: { $in: [...entries.values()].map((e) => e.assignmentId) } }).lean(),
    TimetablePeriod.find({ tenantId: ctx.tenantId }).lean(), Section.find({ tenantId: ctx.tenantId, _id: { $in: [...entries.values()].map((e) => e.sectionId) } }).lean(),
  ]);
  const [subjects, classes, teachers] = await Promise.all([
    Subject.find({ tenantId: ctx.tenantId, _id: { $in: asgs.map((a) => a.subjectId) } }).select('name').lean(), ClassModel.find({ tenantId: ctx.tenantId, _id: { $in: secs.map((s) => s.classId) } }).select('name').lean(),
    Teacher.find({ tenantId: ctx.tenantId, _id: { $in: rows.flatMap((r) => [r.fromTeacherId, r.toTeacherId]) } }).select('name').lean(),
  ]);
  const A = mk(asgs); const P = mk(periods); const S = mk(secs); const SUB = mk(subjects); const C = mk(classes); const T = mk(teachers);
  const label = (id) => {
    const e = entries.get(String(id)); if (!e) return null;
    const sec = S.get(String(e.sectionId)); const a = A.get(String(e.assignmentId)); const p = P.get(String(e.periodId));
    return { entryId: e._id, period: p?.name, time: p ? `${p.startTime}–${p.endTime}` : '', section: `${C.get(String(sec?.classId))?.name || ''} ${sec?.name || ''}`.trim(), subject: SUB.get(String(a?.subjectId))?.name };
  };
  return rows.map((r) => ({ ...r, fromTeacher: T.get(String(r.fromTeacherId))?.name, toTeacher: T.get(String(r.toTeacherId))?.name, fromPeriod: label(r.fromEntryId), toPeriod: label(r.toEntryId) }));
}

export async function mySwaps(ctx) {
  const rows = await SwapRequest.find({ tenantId: ctx.tenantId, $or: [{ fromTeacherId: ctx.teacher._id }, { toTeacherId: ctx.teacher._id }] }).sort({ createdAt: -1 }).limit(100).lean();
  return (await describe(ctx, rows)).map((r) => ({ ...r, mine: String(r.fromTeacherId) === String(ctx.teacher._id) }));
}

/** The teacher asked to take (or swap) a period answers first; then the School Admin decides. */
export async function respondSwap(ctx, id, { accept, note }) {
  const s = await SwapRequest.findOne({ _id: id, tenantId: ctx.tenantId, toTeacherId: ctx.teacher._id });
  if (!s) throw notFound('Request not found');
  if (s.status !== 'pending' || s.peerStatus !== 'pending') throw conflict('This request has already been answered');
  s.peerStatus = accept ? 'accepted' : 'declined'; s.peerNote = note;
  if (!accept) s.status = 'declined';
  await s.save();
  const from = await Teacher.findById(s.fromTeacherId).select('userId');
  await notifyUsers(ctx.tenantId, [from?.userId], { category: 'timetable', title: accept ? 'Swap accepted by the other teacher' : 'Swap declined', body: `${ctx.teacher.name} ${accept ? 'agreed' : 'declined'} for ${s.date}${note ? `: ${note}` : ''}.${accept ? ' It now waits for the school admin.' : ''}`, link: { type: 'swap', id: String(s._id) }, dedupeKey: `swap:${s._id}:peer` });
  if (accept) await notifyUsers(ctx.tenantId, await adminIds(ctx.tenantId), { category: 'approvals', title: 'Period swap needs approval', body: `${s.date}: both teachers agreed.`, link: { type: 'swap', id: String(s._id) }, dedupeKey: `swap:${s._id}:admin` });
  return s;
}

export async function cancelSwap(ctx, id) {
  const s = await SwapRequest.findOne({ _id: id, tenantId: ctx.tenantId, fromTeacherId: ctx.teacher._id });
  if (!s) throw notFound('Request not found');
  if (s.status !== 'pending') throw conflict(`A ${s.status} request cannot be cancelled`);
  s.status = 'cancelled'; await s.save();
  return s;
}

export async function adminSwaps(ctx, { status }) {
  const f = { tenantId: ctx.tenantId };
  if (status === 'awaiting') { f.status = 'pending'; f.peerStatus = 'accepted'; } else if (status && status !== 'all') f.status = status;
  return describe(ctx, await SwapRequest.find(f).sort({ date: 1, createdAt: -1 }).limit(200).lean());
}

export async function decideSwap(ctx, id, { approve, note }, user) {
  const s = await SwapRequest.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!s) throw notFound('Request not found');
  if (s.status !== 'pending') throw conflict(`This request is already ${s.status}`);
  if (s.peerStatus !== 'accepted') throw conflict('The other teacher has not agreed yet');
  if (!approve && !note) throw bad('Say why it is being rejected');
  if (approve) {
    if (s.date < ctx.today) throw bad('That date has passed');
    const made = [];
    try {
      const a = await createSubstitution(ctx.tenantId, { entryId: s.fromEntryId, date: s.date, substituteTeacherId: s.toTeacherId, reason: `Swap approved${s.reason ? `: ${s.reason}` : ''}` }, user._id);
      made.push(a.substitution._id);
      if (s.toEntryId) { const b = await createSubstitution(ctx.tenantId, { entryId: s.toEntryId, date: s.date, substituteTeacherId: s.fromTeacherId, reason: 'Swap approved' }, user._id); made.push(b.substitution._id); }
    } catch (e) { for (const m of made) await deleteSubstitution(ctx.tenantId, m).catch(() => {}); throw e; } // all or nothing
  }
  s.adminStatus = approve ? 'approved' : 'rejected'; s.status = approve ? 'approved' : 'rejected'; s.adminNote = note; s.decidedBy = user._id; s.decidedByName = user.name; s.decidedAt = new Date();
  await s.save();
  const ts = await Teacher.find({ _id: { $in: [s.fromTeacherId, s.toTeacherId] } }).select('userId');
  await notifyUsers(ctx.tenantId, ts.map((t) => t.userId), { category: 'timetable', title: `Period swap ${s.status}`, body: `${s.date}${note ? `: ${note}` : ''}`, link: { type: 'swap', id: String(s._id) }, dedupeKey: `swap:${s._id}:${s.status}` });
  return s;
}

// ───────────── attendance on a day the school does not work ─────────────
export async function requestException(ctx, user, { sectionId, date, reason }) {
  if (!ctx.scope.classTeacherSectionIds.includes(String(sectionId))) throw forbidden('Only the class teacher can ask to take attendance on this section');
  if (date < ctx.today) throw bad('Ask for today or a later date');
  await assertExceptionWanted(ctx, sectionId, date);
  if (await AttendanceException.exists({ tenantId: ctx.tenantId, sectionId, date })) throw conflict('There is already a request for that day');
  const e = await AttendanceException.create({ tenantId: ctx.tenantId, sectionId, date, reason, requestedBy: user._id, requestedByName: user.name, teacherId: ctx.teacher._id });
  await notifyUsers(ctx.tenantId, await adminIds(ctx.tenantId), { category: 'approvals', title: 'Attendance on a non-working day', body: `${user.name} asks to take attendance on ${date}: ${reason}`, link: { type: 'exception', id: String(e._id) }, dedupeKey: `attx:${e._id}` });
  return e;
}
async function assertExceptionWanted(ctx, sectionId, date) {
  const section = await Section.findOne({ _id: sectionId, tenantId: ctx.tenantId });
  if (!section) throw notFound('Section not found');
  const working = ctx.settings.workingDays.includes(isoDay(date)) && !(await isHoliday(ctx.tenantId, section, date));
  if (working) throw bad('That is a normal working day: no request is needed');
}
/** The School Admin may also allow a day directly. */
export async function createApprovedException(ctx, user, { sectionId, date, reason }) {
  await assertExceptionWanted(ctx, sectionId, date);
  return AttendanceException.findOneAndUpdate({ tenantId: ctx.tenantId, sectionId, date }, { $set: { reason, status: 'approved', requestedBy: user._id, requestedByName: user.name, decidedBy: user._id, decidedByName: user.name, decidedAt: new Date() } }, { upsert: true, new: true });
}
export async function decideException(ctx, id, { approve, note }, user) {
  const e = await AttendanceException.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!e) throw notFound('Request not found');
  if (e.status !== 'pending') throw conflict(`This request is already ${e.status}`);
  if (!approve && !note) throw bad('Say why it is being rejected');
  e.status = approve ? 'approved' : 'rejected'; e.decidedBy = user._id; e.decidedByName = user.name; e.decidedAt = new Date(); e.decisionNote = note;
  await e.save();
  const t = await Teacher.findById(e.teacherId).select('userId');
  await notifyUsers(ctx.tenantId, [t?.userId], { category: 'attendance', title: `Attendance on ${e.date} ${e.status}`, body: note || (approve ? 'You can take attendance on that day.' : ''), link: { type: 'exception', id: String(e._id) }, dedupeKey: `attx:${e._id}:${e.status}` });
  return e;
}
export async function listExceptions(ctx, { teacherId, status } = {}) {
  const f = { tenantId: ctx.tenantId };
  if (teacherId) f.teacherId = teacherId;
  if (status) f.status = status;
  const rows = await AttendanceException.find(f).sort({ date: -1 }).limit(200).lean();
  const secs = mk(await Section.find({ tenantId: ctx.tenantId, _id: { $in: rows.map((r) => r.sectionId) } }).lean());
  const cls = mk(await ClassModel.find({ tenantId: ctx.tenantId, _id: { $in: [...secs.values()].map((s) => s.classId) } }).select('name').lean());
  return rows.map((r) => ({ ...r, section: `${cls.get(String(secs.get(String(r.sectionId))?.classId))?.name || ''} ${secs.get(String(r.sectionId))?.name || ''}`.trim() }));
}
export const exceptionApproved = (tenantId, sectionId, date) => AttendanceException.exists({ tenantId, sectionId, date, status: 'approved' });

// ───────────── period-by-period attendance (a school setting) ─────────────
function assertEnabled(ctx) { if (!ctx.settings.attendance?.periodWise) throw conflict('Period-wise attendance is not switched on for this school. The School Admin can turn it on in the school settings.'); }

async function teachingEntry(ctx, entryId, date) {
  const entry = await TimetableEntry.findOne({ _id: entryId, tenantId: ctx.tenantId });
  if (!entry) throw notFound('Timetable period not found');
  if (isoDay(date) !== entry.day) throw bad('That date does not fall on the weekday of this period');
  if (ctx.role === 'teacher') {
    const asg = await TeachingAssignment.findOne({ _id: entry.assignmentId, tenantId: ctx.tenantId });
    const sub = await Substitution.findOne({ tenantId: ctx.tenantId, entryId: entry._id, date });
    const mine = sub ? String(sub.substituteTeacherId) === String(ctx.teacher._id) : asg && String(asg.teacherId) === String(ctx.teacher._id);
    if (!mine) throw forbidden('This period is not yours on that date');
  }
  return entry;
}

export async function periodRegister(ctx, { entryId, date }) {
  assertEnabled(ctx);
  const entry = await teachingEntry(ctx, entryId, date);
  const [session, daily, enr, period, asg] = await Promise.all([
    PeriodAttendanceSession.findOne({ tenantId: ctx.tenantId, sectionId: entry.sectionId, periodId: entry.periodId, date }).lean(),
    AttendanceRecord.find({ tenantId: ctx.tenantId, sectionId: entry.sectionId, date }).select('studentId status').lean(),
    StudentEnrolment.find({ tenantId: ctx.tenantId, sectionId: entry.sectionId, status: 'active' }).sort({ rollNo: 1 }).lean(),
    TimetablePeriod.findById(entry.periodId).lean(), TeachingAssignment.findById(entry.assignmentId).lean(),
  ]);
  const students = mk(await Student.find({ tenantId: ctx.tenantId, _id: { $in: enr.map((e) => e.studentId) } }).select('name admissionNo').lean());
  const done = new Map((session?.records || []).map((r) => [String(r.studentId), r.status]));
  const day = new Map(daily.map((r) => [String(r.studentId), r.status]));
  return {
    entryId, date, period: period?.name, subjectId: asg?.subjectId, marked: !!session, canEdit: date <= ctx.today,
    students: enr.map((e) => ({ studentId: e.studentId, name: students.get(String(e.studentId))?.name, admissionNo: students.get(String(e.studentId))?.admissionNo, rollNo: e.rollNo, status: done.get(String(e.studentId)) || (day.get(String(e.studentId)) === 'absent' ? 'absent' : 'present'), dailyStatus: day.get(String(e.studentId)) || null })),
  };
}

export async function savePeriodRegister(ctx, user, { entryId, date, entries }) {
  assertEnabled(ctx);
  if (date > ctx.today) throw bad('Attendance cannot be marked for a future date');
  const entry = await teachingEntry(ctx, entryId, date);
  const enr = await StudentEnrolment.find({ tenantId: ctx.tenantId, sectionId: entry.sectionId, status: 'active' }).select('studentId').lean();
  const ok = new Set(enr.map((e) => String(e.studentId)));
  const seen = new Set();
  for (const e of entries) { if (!ok.has(String(e.studentId))) throw bad('A student in the list is not in this class'); if (seen.has(String(e.studentId))) throw bad('A student appears twice'); seen.add(String(e.studentId)); }
  const asg = await TeachingAssignment.findById(entry.assignmentId).lean();
  const sub = await Substitution.findOne({ tenantId: ctx.tenantId, entryId: entry._id, date }).lean();
  // everyone not listed is present
  const records = enr.map((e) => ({ studentId: e.studentId, status: entries.find((x) => String(x.studentId) === String(e.studentId))?.status || 'present' }));
  const s = await PeriodAttendanceSession.findOneAndUpdate({ tenantId: ctx.tenantId, sectionId: entry.sectionId, periodId: entry.periodId, date },
    { $set: { yearId: entry.yearId, teacherId: sub?.substituteTeacherId || asg?.teacherId, subjectId: asg?.subjectId, markedBy: user._id, records } }, { upsert: true, new: true });
  return { ok: true, id: s._id, absent: records.filter((r) => r.status === 'absent').length, total: records.length };
}

export async function teacherPeriodDay(ctx, date, rows) {
  assertEnabled(ctx);
  const done = await PeriodAttendanceSession.find({ tenantId: ctx.tenantId, date, sectionId: { $in: rows.map((r) => r.sectionId) } }).select('sectionId periodId').lean();
  const key = new Set(done.map((d) => `${d.sectionId}:${d.periodId}`));
  const entries = mk(await TimetableEntry.find({ tenantId: ctx.tenantId, _id: { $in: rows.map((r) => r.entryId) } }).select('periodId sectionId').lean());
  return rows.filter((r) => !r.isBreak && !r.free).map((r) => ({ ...r, marked: key.has(`${r.sectionId}:${entries.get(String(r.entryId))?.periodId}`) }));
}

export async function studentPeriods(ctx, date) {
  assertEnabled(ctx);
  if (!ctx.enrolment) return { date, periods: [] };
  const sessions = await PeriodAttendanceSession.find({ tenantId: ctx.tenantId, sectionId: ctx.enrolment.sectionId, date }).lean();
  const periods = mk(await TimetablePeriod.find({ tenantId: ctx.tenantId, _id: { $in: sessions.map((s) => s.periodId) } }).lean());
  const subj = mk(await Subject.find({ tenantId: ctx.tenantId, _id: { $in: sessions.map((s) => s.subjectId).filter(Boolean) } }).select('name').lean());
  return {
    date, periods: sessions.map((s) => ({ period: periods.get(String(s.periodId))?.name, order: periods.get(String(s.periodId))?.order, time: periods.get(String(s.periodId)) ? `${periods.get(String(s.periodId)).startTime}–${periods.get(String(s.periodId)).endTime}` : '', subject: subj.get(String(s.subjectId))?.name, status: s.records.find((r) => String(r.studentId) === String(ctx.student._id))?.status || null })).sort((a, b) => a.order - b.order),
  };
}

export async function adminPeriodOverview(ctx, { sectionId, date }) {
  const sessions = await PeriodAttendanceSession.find({ tenantId: ctx.tenantId, sectionId, date }).lean();
  const [periods, teachers, subj] = await Promise.all([TimetablePeriod.find({ tenantId: ctx.tenantId }).lean(), Teacher.find({ tenantId: ctx.tenantId, _id: { $in: sessions.map((s) => s.teacherId).filter(Boolean) } }).select('name').lean(), Subject.find({ tenantId: ctx.tenantId, _id: { $in: sessions.map((s) => s.subjectId).filter(Boolean) } }).select('name').lean()]);
  const P = mk(periods); const T = mk(teachers); const S = mk(subj);
  return { enabled: !!ctx.settings.attendance?.periodWise, date, periods: sessions.map((s) => ({ period: P.get(String(s.periodId))?.name, order: P.get(String(s.periodId))?.order, teacher: T.get(String(s.teacherId))?.name, subject: S.get(String(s.subjectId))?.name, absent: s.records.filter((r) => r.status === 'absent').length, late: s.records.filter((r) => r.status === 'late').length, total: s.records.length })).sort((a, b) => a.order - b.order) };
}

// ───────────── the School Admin edits leave ─────────────
export async function editTeacherLeave(ctx, id, patch, user) {
  const l = await LeaveApplication.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!l) throw notFound('Leave application not found');
  if (l.status === 'cancelled') throw conflict('A cancelled application cannot be edited');
  const next = { ...l.toObject(), ...patch };
  if (next.endDate < next.startDate) throw bad('End date cannot be before start date');
  const days = countDays(ctx.settings, next.startDate, next.endDate);
  if (days < 1) throw bad('The selected dates contain no working days');
  const overlap = await LeaveApplication.exists({ tenantId: ctx.tenantId, teacherId: l.teacherId, _id: { $ne: l._id }, status: { $in: ['submitted', 'approved'] }, startDate: { $lte: next.endDate }, endDate: { $gte: next.startDate } });
  if (overlap) throw conflict('That overlaps another leave of the same teacher');
  const before = `${l.leaveType} ${l.startDate}–${l.endDate}`;
  Object.assign(l, patch, { days });
  await l.save();
  const t = await Teacher.findById(l.teacherId).select('userId');
  await notifyUsers(ctx.tenantId, [t?.userId], { category: 'leave', title: 'Your leave was changed by the office', body: `${before} is now ${l.leaveType} ${l.startDate}–${l.endDate}${patch.editNote ? `: ${patch.editNote}` : ''}`, link: { type: 'leave', id: String(l._id) }, dedupeKey: `leavee:${l._id}:${Date.now()}` });
  return l;
}
export async function editStaffLeave(ctx, group, id, patch) {
  const l = await StaffLeave.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!l || l.group !== group) throw notFound('Leave application not found');
  if (l.status === 'cancelled') throw conflict('A cancelled application cannot be edited');
  const next = { ...l.toObject(), ...patch };
  if (next.endDate < next.startDate) throw bad('End date cannot be before start date');
  const days = countDays(ctx.settings, next.startDate, next.endDate);
  if (days < 1) throw bad('The selected dates contain no working days');
  const overlap = await StaffLeave.exists({ tenantId: ctx.tenantId, staffId: l.staffId, _id: { $ne: l._id }, status: { $in: ['submitted', 'approved'] }, startDate: { $lte: next.endDate }, endDate: { $gte: next.startDate } });
  if (overlap) throw conflict('That overlaps another leave of the same person');
  Object.assign(l, patch, { days });
  return l.save();
}
export { ClassTeacherAssignment, addDays };
