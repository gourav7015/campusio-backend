import {
  SwapRequest, TimetableEntry, TeachingAssignment, Teacher, Substitution, Section, ClassModel, Subject, TimetablePeriod, AttendanceException, AttendanceSession, AttendanceRecord,
  PeriodAttendanceSession, Student, User, LeaveApplication, StaffLeave, ClassTeacherAssignment,
} from '../../models/index.js';
import { notFound, conflict, bad, forbidden, isoDay, addDays } from '../../core/utils.js';
import { notifyUsers } from '../../services/notify.js';
import { createSubstitution, deleteSubstitution } from '../timetable/timetable.service.js';
import { leaveDays } from '../leave/leave.service.js';
import { isHoliday, registerStudents, assertMarkableDate } from '../attendance/attendance.service.js';
import { modeOn, dayRuleOf } from '../../services/attendanceMode.js';
import { recomputeDay, lessonPeriodsOf } from '../../services/periodDay.js';
import { subjectStats, subjectPeriods } from '../../services/periodStats.js';

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

// ───────────── attendance period by period (the school's way of taking it: see services/attendanceMode.js) ─────────────
const STATUS_WORD = { present: 'present', absent: 'absent', late: 'late', half_day: 'half day', leave: 'on leave', excused: 'excused' };

/** Period attendance exists only on dates the school takes it that way. */
function assertEnabled(ctx, date) {
  if (!modeOn(ctx.settings.attendance, date || ctx.today)) throw conflict('Your school takes attendance once a day on that date, by the class teacher. The School Admin can change this in the school settings.');
}

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

const periodLabel = (p) => p?.name || 'Period';

/** What earlier periods of the day said about each student (only the ones that were not "present"), so a teacher knows who was away this morning. */
async function earlierToday(tenantId, sectionId, date, order) {
  const sessions = await PeriodAttendanceSession.find({ tenantId, sectionId, date, status: 'submitted' }).lean();
  if (!sessions.length) return new Map();
  const periods = mk(await TimetablePeriod.find({ tenantId, _id: { $in: sessions.map((s) => s.periodId) } }).lean());
  const by = new Map();
  for (const s of sessions) {
    const p = periods.get(String(s.periodId));
    if (!p || p.order >= order) continue;
    for (const r of s.records) if (r.status !== 'present') { const k = String(r.studentId); if (!by.has(k)) by.set(k, []); by.get(k).push({ period: p.name, order: p.order, status: r.status }); }
  }
  for (const v of by.values()) v.sort((a, b) => a.order - b.order);
  return by;
}

export async function periodRegister(ctx, { entryId, date }) {
  assertEnabled(ctx, date);
  const entry = await teachingEntry(ctx, entryId, date);
  const section = await Section.findOne({ _id: entry.sectionId, tenantId: ctx.tenantId });
  const [session, list, period, asg, cls] = await Promise.all([
    PeriodAttendanceSession.findOne({ tenantId: ctx.tenantId, sectionId: entry.sectionId, periodId: entry.periodId, date }).lean(),
    registerStudents(ctx.tenantId, entry.sectionId, date), TimetablePeriod.findById(entry.periodId).lean(), TeachingAssignment.findById(entry.assignmentId).lean(),
    ClassModel.findById(section?.classId).select('name').lean(),
  ]);
  const subject = asg?.subjectId ? await Subject.findById(asg.subjectId).select('name').lean() : null;
  const sub = await Substitution.findOne({ tenantId: ctx.tenantId, entryId: entry._id, date }).lean();
  const done = new Map((session?.records || []).map((r) => [String(r.studentId), r.status]));
  const earlier = await earlierToday(ctx.tenantId, entry.sectionId, date, period?.order ?? 0);
  const students = list.map(({ enrolment, student }) => ({ studentId: student._id, name: student.name, admissionNo: student.admissionNo, rollNo: enrolment.rollNo, status: done.get(String(student._id)) || null, earlier: earlier.get(String(student._id)) || [] }));
  let blocked = null;
  if (date > ctx.today) blocked = 'future';
  else { try { await assertMarkableDate(ctx, section, date); } catch (e) { blocked = e.message; } }
  const submitted = session?.status === 'submitted';
  return {
    entryId, date, period: periodLabel(period), time: period ? `${period.startTime}–${period.endTime}` : '', subjectId: asg?.subjectId, subject: subject?.name || '',
    section: { id: section?._id, name: section?.name, className: cls?.name }, covering: !!sub,
    marked: !!session, status: session?.status || null, submitted, blocked, canEdit: !blocked,
    totals: { total: students.length, marked: students.filter((s) => s.status).length },
    students,
  };
}

export async function savePeriodRegister(ctx, user, { entryId, date, entries, submit }) {
  assertEnabled(ctx, date);
  if (date > ctx.today) throw bad('Attendance cannot be marked for a future date');
  const entry = await teachingEntry(ctx, entryId, date);
  const section = await Section.findOne({ _id: entry.sectionId, tenantId: ctx.tenantId });
  await assertMarkableDate(ctx, section, date);
  const list = await registerStudents(ctx.tenantId, entry.sectionId, date);
  const byStudent = new Map(list.map((x) => [String(x.student._id), x.student]));
  const seen = new Set();
  for (const e of entries) { if (!byStudent.has(String(e.studentId))) throw bad('A student in the list is not in this class'); if (seen.has(String(e.studentId))) throw bad('A student appears twice'); seen.add(String(e.studentId)); }
  const [asg, sub, period] = await Promise.all([TeachingAssignment.findById(entry.assignmentId).lean(), Substitution.findOne({ tenantId: ctx.tenantId, entryId: entry._id, date }).lean(), TimetablePeriod.findById(entry.periodId).lean()]);
  const subject = asg?.subjectId ? await Subject.findById(asg.subjectId).select('name').lean() : null;
  const key = { tenantId: ctx.tenantId, sectionId: entry.sectionId, periodId: entry.periodId, date };
  let s = await PeriodAttendanceSession.findOne(key);
  const who = { yearId: entry.yearId, teacherId: sub?.substituteTeacherId || asg?.teacherId, subjectId: asg?.subjectId };

  // a submitted period is locked: the teacher who took it may still change it, and every change is kept (who, from, to) and the family is told
  if (s?.status === 'submitted') {
    let changed = 0;
    for (const e of entries) {
      const rec = s.records.find((r) => String(r.studentId) === String(e.studentId));
      if (!rec || rec.status === e.status) continue;
      s.changes.push({ studentId: e.studentId, from: rec.status, to: e.status, by: user._id, byName: user.name, reason: 'Changed by the teacher', at: new Date() });
      rec.status = e.status; changed++;
      await notifyUsers(ctx.tenantId, [byStudent.get(String(e.studentId))?.userId], { category: 'attendance', title: 'Attendance corrected', body: `Your ${subject?.name || 'period'} attendance on ${date} was changed to ${STATUS_WORD[e.status]}.`, link: { type: 'attendance', id: date }, dedupeKey: `pac:${s._id}:${e.studentId}:${s.changes.length}` });
    }
    if (changed) { s.markModified('records'); await s.save(); }
    const day = await recomputeDay(ctx, entry.sectionId, date);
    return { ok: true, id: s._id, submitted: true, edited: true, changed, absent: s.records.filter((r) => r.status === 'absent').length, total: s.records.length, day: day.state };
  }

  const merged = new Map((s?.records || []).map((r) => [String(r.studentId), r.status]));
  for (const e of entries) merged.set(String(e.studentId), e.status);
  const records = [...merged.entries()].map(([studentId, status]) => ({ studentId, status }));
  if (submit) {
    if (!list.length) throw bad('There are no students in this class');
    const missing = list.filter((x) => !merged.has(String(x.student._id)));
    if (missing.length) throw bad(`${missing.length} student(s) are not marked yet`, { unmarked: missing.map((m) => m.student.name) });
  }
  s = await PeriodAttendanceSession.findOneAndUpdate(key, { $set: { ...who, markedBy: user._id, records, status: submit ? 'submitted' : 'draft', ...(submit ? { submittedAt: new Date() } : {}) } }, { upsert: true, new: true });
  let day = { state: 'none' };
  if (submit) {
    // tell the family about a lesson missed after the child was in earlier today (a child who has not come at all is already known to be away)
    const early = await PeriodAttendanceSession.find({ tenantId: ctx.tenantId, sectionId: entry.sectionId, date, status: 'submitted', periodId: { $ne: entry.periodId } }).lean();
    const orders = mk(await TimetablePeriod.find({ tenantId: ctx.tenantId, _id: { $in: early.map((x) => x.periodId) } }).lean());
    for (const r of records) {
      if (r.status !== 'absent') continue;
      const wasIn = early.some((x) => (orders.get(String(x.periodId))?.order ?? 99) < (period?.order ?? 0) && x.records.some((q) => String(q.studentId) === String(r.studentId) && (q.status === 'present' || q.status === 'late')));
      if (!wasIn) continue;
      await notifyUsers(ctx.tenantId, [byStudent.get(String(r.studentId))?.userId], { category: 'attendance', title: 'Missed a period', body: `${byStudent.get(String(r.studentId))?.name} was marked absent in ${period?.name || 'a period'}${subject ? ` (${subject.name})` : ''} on ${date}, after being in school earlier.`, link: { type: 'attendance', id: date }, dedupeKey: `pa:${s._id}:${r.studentId}` });
    }
    day = await recomputeDay(ctx, entry.sectionId, date);
  }
  return { ok: true, id: s._id, submitted: !!submit, absent: records.filter((r) => r.status === 'absent').length, total: records.length, marked: records.length, day: day.state };
}

/** A teacher's lessons for a day with what has been marked, so the Home card and the Period attendance page can show them. */
export async function teacherPeriodDay(ctx, date, rows) {
  const enabled = modeOn(ctx.settings.attendance, date);
  if (!enabled) return { enabled, rows: [] };
  const lessons = rows.filter((r) => !r.isBreak && !r.free);
  const done = await PeriodAttendanceSession.find({ tenantId: ctx.tenantId, date, sectionId: { $in: lessons.map((r) => r.sectionId) } }).lean();
  const entries = mk(await TimetableEntry.find({ tenantId: ctx.tenantId, _id: { $in: lessons.map((r) => r.entryId) } }).select('periodId sectionId').lean());
  const by = new Map(done.map((d) => [`${d.sectionId}:${d.periodId}`, d]));
  return { enabled, rows: lessons.map((r) => {
    const d = by.get(`${r.sectionId}:${entries.get(String(r.entryId))?.periodId}`);
    return { ...r, marked: !!d, status: d?.status || null, submitted: d?.status === 'submitted', absent: d ? d.records.filter((x) => x.status === 'absent').length : 0, total: d ? d.records.length : 0 };
  }) };
}

/** The student's own day, period by period: every lesson of their class, what was marked, and the day that was worked out from it. */
export async function studentPeriods(ctx, date) {
  const enabled = modeOn(ctx.settings.attendance, date);
  if (!ctx.enrolment) return { enabled, date, periods: [], day: null };
  const sectionId = ctx.enrolment.sectionId;
  const dayRec = await AttendanceSession.findOne({ tenantId: ctx.tenantId, sectionId, date, status: 'submitted' }).lean();
  const rec = dayRec ? await AttendanceRecord.findOne({ sessionId: dayRec._id, studentId: ctx.student._id }).lean() : null;
  const day = rec ? { status: rec.status, source: dayRec.source } : null;
  if (!enabled) return { enabled, date, periods: [], day };
  const [lessons, sessions] = await Promise.all([lessonPeriodsOf(ctx.tenantId, ctx.year._id, sectionId, date), PeriodAttendanceSession.find({ tenantId: ctx.tenantId, sectionId, date, status: 'submitted' }).lean()]);
  const entries = await TimetableEntry.find({ tenantId: ctx.tenantId, yearId: ctx.year._id, sectionId, day: isoDay(date) }).lean();
  const asg = mk(await TeachingAssignment.find({ tenantId: ctx.tenantId, _id: { $in: entries.map((e) => e.assignmentId).filter(Boolean) } }).select('subjectId').lean());
  const subj = mk(await Subject.find({ tenantId: ctx.tenantId, _id: { $in: [...asg.values()].map((a) => a.subjectId).filter(Boolean) } }).select('name').lean());
  const S = new Map(sessions.map((s) => [String(s.periodId), s]));
  const E = new Map(entries.map((e) => [String(e.periodId), e]));
  const extra = sessions.filter((s) => !lessons.some((p) => String(p._id) === String(s.periodId)));
  const extraPeriods = extra.length ? await TimetablePeriod.find({ tenantId: ctx.tenantId, _id: { $in: extra.map((s) => s.periodId) } }).lean() : [];
  const periods = [...lessons, ...extraPeriods].sort((a, b) => a.order - b.order).map((p) => {
    const s = S.get(String(p._id)); const e = E.get(String(p._id));
    const subjectId = s?.subjectId || asg.get(String(e?.assignmentId))?.subjectId;
    return { period: p.name, order: p.order, time: `${p.startTime}–${p.endTime}`, subject: subj.get(String(subjectId))?.name || '', status: s?.records.find((r) => String(r.studentId) === String(ctx.student._id))?.status || null };
  });
  return { enabled, date, periods, day };
}

/** Attendance by subject for the signed-in student: only periods that were taken period by period. */
export async function studentSubjects(ctx) {
  return subjectStats({ tenantId: ctx.tenantId, yearId: ctx.year?._id, studentId: ctx.student._id, settings: ctx.settings });
}
/** Every period of one subject, newest first, for the signed-in student. */
export async function studentSubjectPeriods(ctx, subjectId) {
  return subjectPeriods({ tenantId: ctx.tenantId, yearId: ctx.year?._id, studentId: ctx.student._id, subjectId });
}

/**
 * One day of one class, period by period: each lesson (who takes it, who covers it, whether it is submitted), each student's status in each period,
 * and the day that was worked out from it. Used by the class teacher (their own section) and by the School Admin (any section).
 */
export async function sectionDay(ctx, { sectionId, date }) {
  if (ctx.role === 'teacher' && !ctx.scope.classTeacherSectionIds.includes(String(sectionId))) throw forbidden('Only the class teacher can see the periods of a class this way');
  const enabled = modeOn(ctx.settings.attendance, date);
  const rule = dayRuleOf(ctx.settings.attendance);
  const section = await Section.findOne({ _id: sectionId, tenantId: ctx.tenantId }).lean();
  if (!section) throw notFound('Section not found');
  if (!enabled) return { enabled, date, rule, periods: [], students: [] };
  const [entries, periods, sessions, list, dayRec] = await Promise.all([
    TimetableEntry.find({ tenantId: ctx.tenantId, yearId: section.yearId, sectionId, day: isoDay(date) }).lean(),
    TimetablePeriod.find({ tenantId: ctx.tenantId }).lean(),
    PeriodAttendanceSession.find({ tenantId: ctx.tenantId, sectionId, date }).lean(),
    registerStudents(ctx.tenantId, sectionId, date),
    AttendanceSession.findOne({ tenantId: ctx.tenantId, sectionId, date, status: 'submitted' }).lean(),
  ]);
  const [asgs, subs] = await Promise.all([
    TeachingAssignment.find({ tenantId: ctx.tenantId, _id: { $in: entries.map((e) => e.assignmentId).filter(Boolean) } }).select('teacherId subjectId').lean(),
    Substitution.find({ tenantId: ctx.tenantId, date, entryId: { $in: entries.map((e) => e._id) } }).lean(),
  ]);
  const [teachers, subjects, dayRecs] = await Promise.all([
    Teacher.find({ tenantId: ctx.tenantId, _id: { $in: [...asgs.map((a) => a.teacherId), ...subs.map((x) => x.substituteTeacherId)].filter(Boolean) } }).select('name').lean(),
    Subject.find({ tenantId: ctx.tenantId, _id: { $in: asgs.map((a) => a.subjectId).filter(Boolean) } }).select('name').lean(),
    dayRec ? AttendanceRecord.find({ sessionId: dayRec._id }).select('studentId status halfSession').lean() : [],
  ]);
  const A = mk(asgs); const P = mk(periods); const S = new Map(sessions.map((s) => [String(s.periodId), s])); const C = new Map(subs.map((s) => [String(s.entryId), s]));
  const T = mk(teachers); const J = mk(subjects);
  const rows = entries.map((e) => {
    const p = P.get(String(e.periodId)); if (!p || p.type === 'break') return null;
    const a = A.get(String(e.assignmentId)); const cover = C.get(String(e._id)); const s = S.get(String(e.periodId));
    const teacherId = cover?.substituteTeacherId || a?.teacherId;
    return {
      entryId: e._id, periodId: p._id, period: p.name, order: p.order, time: `${p.startTime}–${p.endTime}`, subject: J.get(String(a?.subjectId))?.name || '', teacher: T.get(String(teacherId))?.name || '',
      covering: !!cover, mine: ctx.role === 'teacher' && !!teacherId && String(teacherId) === String(ctx.teacher._id), state: s ? s.status : 'none',
      marked: s?.status === 'submitted', absent: s?.status === 'submitted' ? s.records.filter((r) => r.status === 'absent').length : 0, late: s?.status === 'submitted' ? s.records.filter((r) => r.status === 'late').length : 0, total: s?.status === 'submitted' ? s.records.length : 0,
    };
  }).filter(Boolean).sort((x, y) => x.order - y.order);
  const D = new Map(dayRecs.map((r) => [String(r.studentId), r]));
  const students = list.map(({ enrolment, student }) => {
    const cells = {};
    for (const r of rows) { const s = S.get(String(r.periodId)); cells[r.periodId] = s?.status === 'submitted' ? s.records.find((x) => String(x.studentId) === String(student._id))?.status || null : null; }
    const d = D.get(String(student._id));
    return { studentId: student._id, name: student.name, rollNo: enrolment.rollNo, cells, day: d ? { status: d.status, halfSession: d.halfSession || null } : null };
  });
  const submitted = rows.filter((r) => r.state === 'submitted').length;
  return { enabled, date, rule, lateCounts: ctx.settings.attendance?.lateCountsAsPresent !== false, periods: rows, students, complete: rows.length > 0 && submitted === rows.length, submitted, expected: rows.length, working: ctx.settings.workingDays.includes(isoDay(date)) };
}
export const classPeriodDay = sectionDay;
export const adminPeriodOverview = sectionDay;

/** The School Admin corrects one student in one submitted period, with a reason. Kept in the period's history, the family is told, the day is worked out again. */
export async function correctPeriod(ctx, user, { sectionId, date, periodId, studentId, status, reason }) {
  if (ctx.role === 'teacher') throw forbidden('A submitted period is locked. Ask the school admin to correct it.');
  assertEnabled(ctx, date);
  const s = await PeriodAttendanceSession.findOne({ tenantId: ctx.tenantId, sectionId, periodId, date });
  if (!s) throw notFound('That period has not been marked');
  if (s.status !== 'submitted') throw conflict('That period is still a draft: its teacher has not submitted it yet');
  const rec = s.records.find((r) => String(r.studentId) === String(studentId));
  if (!rec) throw notFound('That student is not on this period');
  if (rec.status === status) throw bad('The status is unchanged');
  s.changes.push({ studentId, from: rec.status, to: status, by: user._id, byName: user.name, reason, at: new Date() });
  rec.status = status; s.markModified('records'); await s.save();
  const [stu, p] = await Promise.all([Student.findById(studentId).select('userId'), TimetablePeriod.findById(periodId).select('name').lean()]);
  await notifyUsers(ctx.tenantId, [stu?.userId], { category: 'attendance', title: 'Attendance corrected', body: `Your ${p?.name || 'period'} attendance on ${date} was changed to ${STATUS_WORD[status]}.`, link: { type: 'attendance', id: date }, dedupeKey: `pac:${s._id}:${studentId}:${s.changes.length}` });
  const day = await recomputeDay(ctx, sectionId, date);
  return { ok: true, day: day.state, changes: s.changes.length };
}

/** The office asks the teacher of a waiting period to mark it. */
export async function remindPeriod(ctx, { sectionId, date, periodId }) {
  assertEnabled(ctx, date);
  const entry = await TimetableEntry.findOne({ tenantId: ctx.tenantId, sectionId, periodId, day: isoDay(date) });
  if (!entry) throw notFound('That period is not on this class\'s timetable that day');
  const s = await PeriodAttendanceSession.findOne({ tenantId: ctx.tenantId, sectionId, periodId, date }).select('status').lean();
  if (s?.status === 'submitted') throw conflict('That period has already been submitted');
  const [asg, sub, p, section] = await Promise.all([TeachingAssignment.findById(entry.assignmentId).lean(), Substitution.findOne({ tenantId: ctx.tenantId, entryId: entry._id, date }).lean(), TimetablePeriod.findById(periodId).lean(), Section.findById(sectionId).populate('classId', 'name').lean()]);
  const teacherId = sub?.substituteTeacherId || asg?.teacherId;
  const teacher = teacherId ? await Teacher.findOne({ _id: teacherId, tenantId: ctx.tenantId }).select('userId name').lean() : null;
  if (!teacher?.userId) throw conflict('No teacher is set for that period');
  const subject = asg?.subjectId ? await Subject.findById(asg.subjectId).select('name').lean() : null;
  const hour = new Date().toISOString().slice(0, 13);
  const n = await notifyUsers(ctx.tenantId, [teacher.userId], { category: 'attendance', title: 'Please mark your period', body: `${section?.classId?.name || ''} ${section?.name || ''} · ${p?.name || ''}${subject ? ` ${subject.name}` : ''} on ${date} is waiting for attendance.`.replace(/\s+/g, ' '), link: { type: 'period-attendance', id: date }, dedupeKey: `remind:${periodId}:${sectionId}:${date}:${hour}` });
  return { ok: true, asked: teacher.name, sent: n > 0 };
}

/**
 * The School Admin's board for one day in a period-by-period school: for every class, how many of its periods are submitted and which ones are still waiting.
 */
export async function periodBoard(ctx, date) {
  const sections = await Section.find({ tenantId: ctx.tenantId, yearId: ctx.year?._id, status: 'active' }).select('_id').lean();
  const ids = sections.map((s) => s._id);
  const [entries, periods, sessions] = await Promise.all([
    TimetableEntry.find({ tenantId: ctx.tenantId, yearId: ctx.year?._id, sectionId: { $in: ids }, day: isoDay(date) }).lean(),
    TimetablePeriod.find({ tenantId: ctx.tenantId }).lean(),
    PeriodAttendanceSession.find({ tenantId: ctx.tenantId, sectionId: { $in: ids }, date }).select('sectionId periodId status').lean(),
  ]);
  const [asgs, subs] = await Promise.all([
    TeachingAssignment.find({ tenantId: ctx.tenantId, _id: { $in: entries.map((e) => e.assignmentId).filter(Boolean) } }).select('teacherId subjectId').lean(),
    Substitution.find({ tenantId: ctx.tenantId, date, entryId: { $in: entries.map((e) => e._id) } }).lean(),
  ]);
  const [teachers, subjects] = await Promise.all([
    Teacher.find({ tenantId: ctx.tenantId, _id: { $in: [...asgs.map((a) => a.teacherId), ...subs.map((x) => x.substituteTeacherId)].filter(Boolean) } }).select('name').lean(),
    Subject.find({ tenantId: ctx.tenantId, _id: { $in: asgs.map((a) => a.subjectId).filter(Boolean) } }).select('name').lean(),
  ]);
  const P = mk(periods); const A = mk(asgs); const T = mk(teachers); const J = mk(subjects); const C = new Map(subs.map((s) => [String(s.entryId), s]));
  const S = new Map(sessions.map((s) => [`${s.sectionId}:${s.periodId}`, s.status]));
  const out = new Map();
  for (const e of entries) {
    const p = P.get(String(e.periodId)); if (!p || p.type === 'break') continue;
    const k = String(e.sectionId);
    if (!out.has(k)) out.set(k, { expected: 0, submitted: 0, drafts: 0, missing: [] });
    const o = out.get(k); o.expected++;
    const st = S.get(`${k}:${e.periodId}`);
    if (st === 'submitted') o.submitted++;
    else {
      if (st === 'draft') o.drafts++;
      const a = A.get(String(e.assignmentId)); const cover = C.get(String(e._id));
      o.missing.push({ periodId: e.periodId, period: p.name, order: p.order, subject: J.get(String(a?.subjectId))?.name || '', teacher: T.get(String(cover?.substituteTeacherId || a?.teacherId))?.name || '', draft: st === 'draft' });
    }
  }
  for (const o of out.values()) o.missing.sort((x, y) => x.order - y.order);
  return out;
}

// ───────────── the School Admin edits leave ─────────────
export async function editTeacherLeave(ctx, id, patch, user) {
  const l = await LeaveApplication.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!l) throw notFound('Leave application not found');
  if (l.status === 'cancelled') throw conflict('A cancelled application cannot be edited');
  const next = { ...l.toObject(), ...patch };
  if (next.halfDay && patch.startDate && patch.endDate === undefined) next.endDate = patch.startDate;
  if (next.endDate < next.startDate) throw bad('End date cannot be before start date');
  const days = leaveDays(ctx.settings, next);
  const overlap = await LeaveApplication.exists({ tenantId: ctx.tenantId, teacherId: l.teacherId, _id: { $ne: l._id }, status: { $in: ['submitted', 'approved'] }, startDate: { $lte: next.endDate }, endDate: { $gte: next.startDate } });
  if (overlap) throw conflict('That overlaps another leave of the same teacher');
  const before = `${l.leaveType} ${l.startDate}–${l.endDate}`;
  Object.assign(l, patch, { days, endDate: next.endDate, halfSession: next.halfDay ? next.halfSession || 'second' : undefined });
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
  if (next.halfDay && patch.startDate && patch.endDate === undefined) next.endDate = patch.startDate;
  if (next.endDate < next.startDate) throw bad('End date cannot be before start date');
  const days = leaveDays(ctx.settings, next);
  const overlap = await StaffLeave.exists({ tenantId: ctx.tenantId, staffId: l.staffId, _id: { $ne: l._id }, status: { $in: ['submitted', 'approved'] }, startDate: { $lte: next.endDate }, endDate: { $gte: next.startDate } });
  if (overlap) throw conflict('That overlaps another leave of the same person');
  Object.assign(l, patch, { days, endDate: next.endDate, halfSession: next.halfDay ? next.halfSession || 'second' : undefined });
  return l.save();
}
export { ClassTeacherAssignment, addDays };
