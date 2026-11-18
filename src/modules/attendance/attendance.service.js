import { classSpan } from '../../services/yearSpan.js';
import {
  AttendanceSession, AttendanceRecord, StudentEnrolment, Student, Section, CalendarEvent, AttendanceQuery, ClassModel,
} from '../../models/index.js';
import { notFound, conflict, bad, forbidden, addDays, eachDate, isoDay } from '../../core/utils.js';
import { summarize, submittedRecords, sessionTotals, sessionCounts, zeroCounts, addCounts, summarizeCounts } from '../../services/attendance.js';
import { AttendanceException } from '../../models/index.js';
import { notifyUsers } from '../../services/notify.js';
import { monitorsOf } from '../class-life/class-life.service.js';

/**
 * Only a section's CLASS TEACHER takes (and edits, before submitting) its daily register.
 * Subject teachers can see their sections' history but never mark. Admin may take any register.
 */
export const isClassTeacherOf = (ctx, sectionId) => ctx.role !== 'teacher' || ctx.scope.classTeacherSectionIds.includes(String(sectionId));
export function assertCanMark(ctx, sectionId) {
  if (ctx.role !== 'teacher') return;
  if (!ctx.scope.hasSection(sectionId)) throw forbidden('You are not assigned to this section');
  if (!isClassTeacherOf(ctx, sectionId)) throw forbidden('Only the class teacher of this section can take attendance');
}

async function loadSection(tenantId, sectionId) {
  const s = await Section.findOne({ _id: sectionId, tenantId });
  if (!s) throw notFound('Section not found');
  return s;
}

export async function isHoliday(tenantId, section, date) {
  return CalendarEvent.findOne({
    tenantId, type: 'holiday', startDate: { $lte: date }, endDate: { $gte: date },
    $or: [{ sectionIds: { $size: 0 } }, { sectionIds: section._id }],
  });
}

/** A Sunday exam or talent test: the School Admin may approve attendance on a day the school does not normally work. */
const dayAllowed = (tenantId, sectionId, date) => AttendanceException.exists({ tenantId, sectionId, date, status: 'approved' });

async function assertMarkableDate(ctx, section, date) {
  if (date > ctx.today) throw bad('Attendance cannot be marked for a future date');
  const allowed = await dayAllowed(ctx.tenantId, section._id, date);
  if (!allowed && !ctx.settings.workingDays.includes(isoDay(date))) throw bad('That date is not a working day. If the school is open for a test or exam, ask the School Admin to allow attendance for that day.');
  const holiday = await isHoliday(ctx.tenantId, section, date);
  if (holiday && !allowed) throw bad(`That date is a holiday (${holiday.title})`);
  const { AcademicYear } = await import('../../models/index.js');
  const year = await AcademicYear.findOne({ _id: section.yearId, tenantId: ctx.tenantId });
  if (year) {
    const span = classSpan(year, section.classId);
    if (date < span.startDate || date > span.endDate) throw bad(span.custom ? 'That date is outside this class\'s session dates' : 'That date is outside the academic year');
  }
}

/** Students on the register for a date (enrolment dates, so transfers and late admissions are right). */
export async function registerStudents(tenantId, sectionId, date) {
  const enrolments = await StudentEnrolment.find({
    tenantId, sectionId, startDate: { $lte: date }, $or: [{ endDate: { $exists: false } }, { endDate: null }, { endDate: { $gt: date } }],
  }).sort({ rollNo: 1 }).lean();
  const students = await Student.find({ tenantId, _id: { $in: enrolments.map((e) => e.studentId) } }).select('name admissionNo userId').lean();
  const sm = new Map(students.map((s) => [String(s._id), s]));
  return enrolments.filter((e) => sm.has(String(e.studentId))).map((e) => ({ enrolment: e, student: sm.get(String(e.studentId)) }));
}

export async function getRegister(ctx, { sectionId, date }) {
  if (ctx.role === 'teacher' && !ctx.scope.hasSection(sectionId)) throw forbidden('You are not assigned to this section');
  const section = await loadSection(ctx.tenantId, sectionId);
  const [session, list, cls] = await Promise.all([
    AttendanceSession.findOne({ tenantId: ctx.tenantId, sectionId, date }), registerStudents(ctx.tenantId, sectionId, date), ClassModel.findById(section.classId),
  ]);
  const records = session ? await AttendanceRecord.find({ sessionId: session._id }).lean() : [];
  const rm = new Map(records.map((r) => [String(r.studentId), r]));
  const holiday = await isHoliday(ctx.tenantId, section, date);
  const monitors = await monitorsOf(ctx.tenantId, sectionId);
  const allowedDay = await dayAllowed(ctx.tenantId, sectionId, date);
  let blocked = null;
  if (date > ctx.today) blocked = 'future';
  else if (!allowedDay && !ctx.settings.workingDays.includes(isoDay(date))) blocked = 'non_working_day';
  else if (holiday && !allowedDay) blocked = `holiday:${holiday.title}`;
  const students = list.map(({ enrolment, student }) => {
    const rec = rm.get(String(student._id));
    return { studentId: student._id, name: student.name, admissionNo: student.admissionNo, rollNo: enrolment.rollNo, status: rec?.status || null, remarks: rec?.remarks || '', corrected: (rec?.history?.length || 0) > 0, regularised: !!rec?.regularised, monitor: monitors.has(String(student._id)) };
  });
  const marked = students.filter((s) => s.status);
  const mayMark = isClassTeacherOf(ctx, sectionId);
  return {
    section: { id: section._id, name: section.name, className: cls?.name }, date, blocked, students,
    session: session && { id: session._id, status: session.status, submittedAt: session.submittedAt, remarks: session.remarks },
    totals: { ...sessionTotals(marked), total: students.length, unmarked: students.length - marked.length },
    isClassTeacher: mayMark, specialDay: !!allowedDay,
    // before submission only the class teacher (or admin) edits; once submitted only the admin may correct, with a reason
    canEdit: mayMark && !blocked && (!session || session.status === 'draft'),
    canCorrect: ctx.role !== 'teacher' && !blocked && session?.status === 'submitted',
  };
}

export async function saveRegister(ctx, { sectionId, date, entries, remarks }, { submit }) {
  assertCanMark(ctx, sectionId);
  const section = await loadSection(ctx.tenantId, sectionId);
  await assertMarkableDate(ctx, section, date);
  let session = await AttendanceSession.findOne({ tenantId: ctx.tenantId, sectionId, date });
  if (session?.status === 'submitted') throw conflict('This register is already submitted. Use a correction with a reason.');

  const list = await registerStudents(ctx.tenantId, sectionId, date);
  const allowed = new Map(list.map((x) => [String(x.student._id), x]));
  const seen = new Set();
  for (const e of entries) {
    if (!allowed.has(String(e.studentId))) throw bad('A student in the list is not enrolled in this section on that date');
    if (seen.has(String(e.studentId))) throw bad('A student appears twice in the list');
    seen.add(String(e.studentId));
  }
  if (!session) session = new AttendanceSession({ tenantId: ctx.tenantId, yearId: section.yearId, sectionId, date });
  session.markedBy = ctx.actorId; session.remarks = remarks ?? session.remarks;
  await session.save();

  if (entries.length) {
    await AttendanceRecord.bulkWrite(entries.map((e) => ({
      updateOne: {
        filter: { sessionId: session._id, studentId: e.studentId },
        update: { $set: { tenantId: ctx.tenantId, status: e.status, remarks: e.remarks || '', enrolmentId: allowed.get(String(e.studentId)).enrolment._id, sectionId, yearId: section.yearId, date } },
        upsert: true,
      },
    })));
  }
  const records = await AttendanceRecord.find({ sessionId: session._id }).lean();
  if (submit) {
    const markedIds = new Set(records.map((r) => String(r.studentId)));
    const missing = list.filter((x) => !markedIds.has(String(x.student._id)));
    if (!list.length) throw bad('There are no students on this register');
    if (missing.length) throw bad(`${missing.length} student(s) are not marked yet`, { unmarked: missing.map((m) => m.student.name) });
    session.status = 'submitted'; session.submittedBy = ctx.actorId; session.submittedAt = new Date();
    await session.save();
    await Promise.all(records.map((rec) => {
      const stu = allowed.get(String(rec.studentId))?.student;
      return notifyUsers(ctx.tenantId, [stu?.userId], {
        category: 'attendance', title: 'Attendance marked', body: `You were marked ${rec.status} on ${date}.`, link: { type: 'attendance', id: date }, dedupeKey: `att:${date}:${rec.studentId}`,
      });
    }));
  }
  return { session, totals: sessionTotals(records), submitted: !!submit };
}

/** Corrections never overwrite silently: every change is appended to the record's history with who/why/when. */
export async function correctRecord(ctx, { sectionId, date, studentId, status, reason }, byName) {
  if (ctx.role === 'teacher') throw forbidden('Submitted attendance is locked. Ask the school admin to correct it (use "Request correction").');
  const session = await AttendanceSession.findOne({ tenantId: ctx.tenantId, sectionId, date });
  if (!session) throw notFound('No attendance register for that date');
  if (session.status !== 'submitted') throw conflict('The register is still a draft; edit it directly');
  const rec = await AttendanceRecord.findOne({ sessionId: session._id, studentId });
  if (!rec) throw notFound('Student is not on that register');
  if (rec.status === status) throw bad('The status is unchanged');
  rec.history.push({ from: rec.status, to: status, by: ctx.actorId, byName, reason, at: new Date() });
  rec.status = status;
  await rec.save();
  const stu = await Student.findById(studentId).select('userId');
  await notifyUsers(ctx.tenantId, [stu?.userId], {
    category: 'attendance', title: 'Attendance corrected', body: `Your attendance for ${date} was changed to ${status}.`, link: { type: 'attendance', id: date }, dedupeKey: `attc:${rec._id}:${rec.history.length}`,
  });
  return rec;
}

export async function sectionHistory(ctx, { sectionId, from, to }) {
  if (ctx.role === 'teacher' && !ctx.scope.hasSection(sectionId)) throw forbidden('You are not assigned to this section');
  await loadSection(ctx.tenantId, sectionId);
  const range = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const sessions = await AttendanceSession.find({ tenantId: ctx.tenantId, sectionId, ...(from || to ? { date: range } : {}) }).sort({ date: -1 }).limit(120).lean();
  const recs = await AttendanceRecord.find({ sessionId: { $in: sessions.map((s) => s._id) } }).select('sessionId status').lean();
  const by = new Map();
  recs.forEach((r) => { const k = String(r.sessionId); if (!by.has(k)) by.set(k, []); by.get(k).push(r); });
  return sessions.map((s) => ({ id: s._id, date: s.date, status: s.status, submittedAt: s.submittedAt, totals: sessionTotals(by.get(String(s._id)) || []) }));
}

/** School-wide view for one day: every section's register state. */
export async function overview(ctx, date) {
  const sections = await Section.find({ tenantId: ctx.tenantId, yearId: ctx.year?._id, status: 'active' }).populate('classId', 'name').lean();
  const sessions = await AttendanceSession.find({ tenantId: ctx.tenantId, date, sectionId: { $in: sections.map((s) => s._id) } }).lean();
  const recs = await AttendanceRecord.find({ sessionId: { $in: sessions.map((s) => s._id) } }).select('sessionId status').lean();
  const sm = new Map(sessions.map((s) => [String(s.sectionId), s]));
  const by = new Map();
  recs.forEach((r) => { const k = String(r.sessionId); if (!by.has(k)) by.set(k, []); by.get(k).push(r); });
  const working = ctx.settings.workingDays.includes(isoDay(date));
  const rows = sections.map((sec) => {
    const s = sm.get(String(sec._id));
    const totals = s ? sessionTotals(by.get(String(s._id)) || []) : null;
    return { sectionId: sec._id, className: sec.classId?.name, section: sec.name, status: s ? s.status : 'not_marked', submittedAt: s?.submittedAt, totals };
  }).sort((a, b) => `${a.className}${a.section}`.localeCompare(`${b.className}${b.section}`, undefined, { numeric: true }));
  const submitted = rows.filter((r) => r.status === 'submitted');
  const sum = (k) => submitted.reduce((n, r) => n + (r.totals?.[k] || 0), 0);
  return {
    date, working, rows,
    totals: { sections: rows.length, submitted: submitted.length, pending: working ? rows.length - submitted.length : 0, present: sum('present'), absent: sum('absent'), late: sum('late'), leave: sum('leave'), excused: sum('excused'), students: sum('total') },
  };
}

/** Daily percentage across given sections for the last `days` calendar days (submitted registers only). */
export async function trend(ctx, sectionIds, days = 7) {
  const from = addDays(ctx.today, -(days - 1));
  const rows = await sessionCounts(ctx.tenantId, { sectionId: { $in: sectionIds }, date: { $gte: from, $lte: ctx.today } });
  const per = new Map();
  for (const r of rows) { if (!per.has(r.date)) per.set(r.date, zeroCounts()); addCounts(per.get(r.date), r.counts); }
  return eachDate(from, ctx.today).filter((d) => per.has(d)).map((d) => ({ date: d, ...summarizeCounts(per.get(d), ctx.settings) }));
}

// ── student-facing ──
export async function studentSummary(ctx) {
  const recs = await submittedRecords(ctx.tenantId, { studentId: ctx.student._id, yearId: ctx.year?._id });
  return { ...summarize(recs, ctx.settings), yearName: ctx.year?.name };
}

export async function studentCalendar(ctx, month) {
  const m = month || ctx.today.slice(0, 7);
  const from = `${m}-01`; const to = `${m}-31`;
  const recs = await submittedRecords(ctx.tenantId, { studentId: ctx.student._id, yearId: ctx.year?._id, date: { $gte: from, $lte: to } });
  const rm = new Map(recs.map((r) => [r.date, r]));
  const holidays = await CalendarEvent.find({ tenantId: ctx.tenantId, type: 'holiday', startDate: { $lte: to }, endDate: { $gte: from } }).lean();
  const days = [];
  for (let d = from; d <= to && d.slice(0, 7) === m; d = addDays(d, 1)) {
    const rec = rm.get(d);
    const hol = holidays.find((h) => h.startDate <= d && h.endDate >= d);
    const working = ctx.settings.workingDays.includes(isoDay(d)) && !hol;
    days.push({ date: d, day: isoDay(d), status: rec?.status || null, remarks: rec?.remarks || '', working, holiday: hol?.title, corrected: (rec?.history?.length || 0) > 0 });
  }
  return { month: m, days };
}

export async function studentMonthly(ctx) {
  const recs = await submittedRecords(ctx.tenantId, { studentId: ctx.student._id, yearId: ctx.year?._id });
  const by = new Map();
  recs.forEach((r) => { const k = r.date.slice(0, 7); if (!by.has(k)) by.set(k, []); by.get(k).push(r); });
  return [...by.keys()].sort().map((month) => ({ month, ...summarize(by.get(month), ctx.settings) }));
}

export async function studentHistory(ctx, { from, to }) {
  const f = { studentId: ctx.student._id, yearId: ctx.year?._id };
  if (from || to) f.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const recs = await submittedRecords(ctx.tenantId, f);
  return recs.sort((a, b) => b.date.localeCompare(a.date)).map((r) => ({ date: r.date, day: isoDay(r.date), status: r.status, remarks: r.remarks, corrected: (r.history?.length || 0) > 0 }));
}

export async function raiseQuery(ctx, { date, message }) {
  if (date > ctx.today) throw bad('Choose a past date');
  return AttendanceQuery.create({ tenantId: ctx.tenantId, studentId: ctx.student._id, date, message });
}
export const listOwnQueries = (ctx) => AttendanceQuery.find({ tenantId: ctx.tenantId, studentId: ctx.student._id }).sort({ createdAt: -1 }).lean();

export async function listQueries(ctx, { status, sectionIds }) {
  const f = { tenantId: ctx.tenantId };
  if (status) f.status = status;
  if (sectionIds) {
    const enr = await StudentEnrolment.find({ tenantId: ctx.tenantId, sectionId: { $in: sectionIds }, status: 'active' }).select('studentId');
    f.studentId = { $in: enr.map((e) => e.studentId) };
  }
  const rows = await AttendanceQuery.find(f).sort({ createdAt: -1 }).limit(100).populate('studentId', 'name admissionNo').lean();
  return rows;
}
export async function resolveQuery(ctx, id, { status, response }, sectionIds) {
  const q = await AttendanceQuery.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!q) throw notFound('Query not found');
  if (sectionIds) {
    const enr = await StudentEnrolment.exists({ tenantId: ctx.tenantId, studentId: q.studentId, sectionId: { $in: sectionIds }, status: 'active' });
    if (!enr) throw forbidden('This student is not in your class');
  }
  q.status = status; q.response = response; q.resolvedBy = ctx.actorId; q.resolvedAt = new Date();
  await q.save();
  const stu = await Student.findById(q.studentId).select('userId');
  await notifyUsers(ctx.tenantId, [stu?.userId], { category: 'attendance', title: 'Attendance query answered', body: response, link: { type: 'attendance', id: q.date }, dedupeKey: `attq:${q._id}` });
  return q;
}

/** The class teacher asks the admin to correct a submitted register; delivered as a message with the details. */
export async function requestCorrection(ctx, user, { sectionId, date, note }) {
  if (!isClassTeacherOf(ctx, sectionId) || !ctx.scope.hasSection(sectionId)) throw forbidden('Only the class teacher can request a correction');
  const section = await loadSection(ctx.tenantId, sectionId);
  const session = await AttendanceSession.findOne({ tenantId: ctx.tenantId, sectionId, date });
  if (!session || session.status !== 'submitted') throw conflict('That register is not submitted; you can edit it directly');
  const cls = await ClassModel.findById(section.classId);
  const { sendToAdmin } = await import('../comms/notifications.service.js');
  return sendToAdmin(ctx, user, { subject: `Attendance correction request · ${cls?.name} ${section.name} · ${date}`, body: note });
}

/** Every day of the academic year so far with the student's status: feeds the attendance heat map. */
export async function studentHeatmap(ctx) {
  if (!ctx.year) return { days: [] };
  const span = classSpan(ctx.year, ctx.enrolment?.classId);
  const to = ctx.today < span.endDate ? ctx.today : span.endDate;
  const from = span.startDate;
  if (to < from) return { from, to, days: [] };
  const recs = await submittedRecords(ctx.tenantId, { studentId: ctx.student._id, yearId: ctx.year._id });
  const rm = new Map(recs.map((r) => [r.date, r.status]));
  const holidays = await CalendarEvent.find({ tenantId: ctx.tenantId, type: 'holiday', startDate: { $lte: to }, endDate: { $gte: from } }).lean();
  const days = eachDate(from, to).map((date) => {
    const hol = holidays.find((h) => h.startDate <= date && h.endDate >= date);
    return { date, status: rm.get(date) || null, working: ctx.settings.workingDays.includes(isoDay(date)) && !hol, holiday: hol?.title };
  });
  return { from, to, days };
}
