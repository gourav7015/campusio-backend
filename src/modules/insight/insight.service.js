import { rollStatus } from '../../services/context.js';
import mongoose from 'mongoose';
import { monitorsOf } from '../class-life/class-life.service.js';
import {
  Section, ClassModel, StudentEnrolment, Student, ClassTeacherAssignment, TeachingAssignment, AttendanceSession, AttendanceRecord, Teacher, User,
  LeaveApplication, Substitution, TimetableEntry,
  ReportCard, Examination, Homework, LibraryIssue, StudentRemark, StudentTransport,
} from '../../models/index.js';
import { notFound, addDays, round1 } from '../../core/utils.js';
import { submittedRecords, summarize, summarizeCounts, sessionCounts, studentCounts, zeroCounts, addCounts, sessionTotals } from '../../services/attendance.js';
import { studentHeatmap } from '../attendance/attendance.service.js';
import { busNumbers, busOfStudent } from '../transport/transport.service.js';
import { studentAccount } from '../finance/finance.service.js';
import { publishedRows } from '../../services/analytics.js';
import { balances as leaveBalances } from '../leave/leave.service.js';
import { teacherPay } from '../payroll/payroll.service.js';
import { personAttendance } from '../staff-attendance/staff-attendance.service.js';

const mean = (a) => (a.length ? round1(a.reduce((x, y) => x + y, 0) / a.length) : null);
const mk = (rows) => new Map(rows.map((r) => [String(r._id), r]));
const by = (rows, key) => { const m = new Map(); for (const r of rows) { const k = String(r[key]); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };

async function loadSection(ctx, sectionId) {
  const s = await Section.findOne({ _id: sectionId, tenantId: ctx.tenantId }).lean();
  if (!s) throw notFound('Section not found');
  return s;
}

/** Competition ranking: equal averages share a rank. */
function rankBy(rows, field) {
  const ranked = rows.filter((r) => r[field] != null).sort((a, b) => b[field] - a[field]);
  let last = null; let rank = 0;
  ranked.forEach((r, i) => { if (r[field] !== last) { rank = i + 1; last = r[field]; } r.rank = rank; });
}

/** Latest published overall % per student, from current report cards. */
async function latestScores(ctx, sectionIds) {
  const cards = await ReportCard.find({ tenantId: ctx.tenantId, yearId: ctx.year._id, isCurrent: true, sectionId: { $in: sectionIds } }).sort({ publishedAt: 1 }).select('studentId snapshot.percentage examId').lean();
  const m = new Map();
  for (const c of cards) m.set(String(c.studentId), c.snapshot?.percentage ?? null);
  return m;
}

// ───────────── one section ─────────────
export async function sectionInsight(ctx, sectionId) {
  const section = await loadSection(ctx, sectionId);
  const [cls, ct, enrols, session, assignments, hw] = await Promise.all([
    ClassModel.findById(section.classId).lean(), ClassTeacherAssignment.findOne({ tenantId: ctx.tenantId, sectionId, open: true }).populate('teacherId', 'name').lean(),
    StudentEnrolment.find({ tenantId: ctx.tenantId, sectionId, status: rollStatus(ctx.year) }).select('studentId').lean(),
    AttendanceSession.findOne({ tenantId: ctx.tenantId, sectionId, date: ctx.today }).lean(),
    TeachingAssignment.find({ tenantId: ctx.tenantId, sectionId, yearId: section.yearId, open: true }).populate('subjectId', 'name').populate('teacherId', 'name').populate('offeringId', 'weeklyPeriods').lean(),
    Homework.countDocuments({ tenantId: ctx.tenantId, sectionId, status: 'published', dueDate: { $gte: ctx.today } }),
  ]);
  const studentIds = enrols.map((e) => e.studentId);
  const todayRecs = session ? await AttendanceRecord.find({ sessionId: session._id }).select('status').lean() : [];
  const last30 = zeroCounts();
  for (const r of await sessionCounts(ctx.tenantId, { sectionId, date: { $gte: addDays(ctx.today, -30) } })) addCounts(last30, r.counts);
  const [scores, loans, riders] = await Promise.all([
    latestScores(ctx, [section._id]),
    LibraryIssue.countDocuments({ tenantId: ctx.tenantId, borrowerType: 'student', borrowerId: { $in: studentIds }, status: 'issued' }),
    StudentTransport.countDocuments({ tenantId: ctx.tenantId, studentId: { $in: studentIds } }),
  ]);
  const sc = [...scores.values()].filter((x) => x != null);
  return {
    sectionId, className: cls?.name, section: section.name, room: section.room, capacity: section.capacity, students: studentIds.length, classTeacher: ct?.teacherId?.name || null,
    attendanceToday: session ? { status: session.status, ...sessionTotals(todayRecs) } : { status: 'not_marked' },
    attendance30: summarizeCounts(last30, ctx.settings).percentage,
    averageScore: mean(sc), booksOnLoan: loans, onBus: riders, activeHomework: hw,
    subjectTeachers: assignments.map((a) => ({ id: a._id, subject: a.subjectId?.name, teacher: a.teacherId?.name, teacherId: a.teacherId?._id, periodsPerWeek: a.offeringId?.weeklyPeriods })).sort((a, b) => String(a.subject).localeCompare(String(b.subject))),
  };
}

export async function sectionStudents(ctx, sectionId) {
  await loadSection(ctx, sectionId);
  const enrols = await StudentEnrolment.find({ tenantId: ctx.tenantId, sectionId, status: rollStatus(ctx.year) }).sort({ rollNo: 1 }).lean();
  const ids = enrols.map((e) => e.studentId);
  const [students, counts, scores, loans, buses] = await Promise.all([
    Student.find({ tenantId: ctx.tenantId, _id: { $in: ids } }).select('name admissionNo gender').lean(),
    studentCounts(ctx.tenantId, { sectionId, yearId: ctx.year._id }), latestScores(ctx, [sectionId]),
    LibraryIssue.find({ tenantId: ctx.tenantId, borrowerType: 'student', borrowerId: { $in: ids }, status: 'issued' }).select('borrowerId dueDate').lean(),
    busNumbers(ctx.tenantId, ids),
  ]);
  const S = mk(students); const L = by(loans, 'borrowerId');
  const monitors = await monitorsOf(ctx.tenantId, sectionId);
  return enrols.map((e) => {
    const k = String(e.studentId); const mine = L.get(k) || [];
    return { studentId: e.studentId, monitor: monitors.has(k), rollNo: e.rollNo, name: S.get(k)?.name, admissionNo: S.get(k)?.admissionNo, gender: S.get(k)?.gender, attendance: summarizeCounts(counts.get(k) || zeroCounts(), ctx.settings).percentage, latestScore: scores.get(k) ?? null, booksOut: mine.length, overdueBooks: mine.filter((l) => l.dueDate < ctx.today).length, bus: buses.get(k) || null };
  });
}

// ───────────── exams: analysis for a class or a single section ─────────────
export async function classAnalysis(ctx, { classId, sectionId }) {
  let cls; let sections;
  if (sectionId) {
    const sec = await loadSection(ctx, sectionId);
    cls = await ClassModel.findById(sec.classId).lean(); sections = [sec];
  } else {
    cls = await ClassModel.findOne({ _id: classId, tenantId: ctx.tenantId }).lean();
    if (!cls) throw notFound('Class not found');
    sections = await Section.find({ tenantId: ctx.tenantId, classId: cls._id, yearId: ctx.year._id, status: 'active' }).sort({ name: 1 }).lean();
  }
  const sectionIds = sections.map((s) => s._id);
  const [enrols, cards] = await Promise.all([
    StudentEnrolment.find({ tenantId: ctx.tenantId, sectionId: { $in: sectionIds }, yearId: ctx.year._id, status: rollStatus(ctx.year) }).sort({ rollNo: 1 }).lean(),
    ReportCard.find({ tenantId: ctx.tenantId, yearId: ctx.year._id, isCurrent: true, sectionId: { $in: sectionIds } }).lean(),
  ]);
  const [students, exams, allClassExams] = await Promise.all([
    Student.find({ tenantId: ctx.tenantId, _id: { $in: enrols.map((e) => e.studentId) } }).select('name admissionNo').lean(),
    Examination.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(cards.map((c) => String(c.examId)))] } }).sort({ startDate: 1, createdAt: 1 }).lean(),
    Examination.find({ tenantId: ctx.tenantId, yearId: ctx.year._id, classIds: cls._id }).select('name status startDate').lean(),
  ]);
  const S = mk(students); const SEC = mk(sections);
  const cardsByExam = by(cards, 'examId'); const cardsByStudent = by(cards, 'studentId');
  const pass = ctx.settings.grading.passPercentage;

  const examRows = exams.map((e) => {
    const cs = cardsByExam.get(String(e._id)) || [];
    const withPct = cs.filter((c) => c.snapshot?.percentage != null);
    const best = [...withPct].sort((a, b) => b.snapshot.percentage - a.snapshot.percentage);
    const nameOf = (c) => S.get(String(c.studentId))?.name;
    const subjectMap = new Map();
    for (const c of cs) for (const sub of c.snapshot.subjects || []) if (sub.percentage != null && !sub.exempt) { if (!subjectMap.has(sub.subject)) subjectMap.set(sub.subject, []); subjectMap.get(sub.subject).push(sub.percentage); }
    return {
      id: e._id, name: e.name, type: e.type, date: e.startDate, createdBy: e.createdByName, students: cs.length, average: mean(withPct.map((c) => c.snapshot.percentage)),
      passPercent: cs.length ? round1((cs.filter((c) => c.snapshot.resultStatus === 'pass').length / cs.length) * 100) : null,
      highest: best[0] ? { name: nameOf(best[0]), percentage: best[0].snapshot.percentage } : null, lowest: best.length ? { name: nameOf(best[best.length - 1]), percentage: best[best.length - 1].snapshot.percentage } : null,
      subjects: [...subjectMap.entries()].map(([subject, v]) => ({ subject, average: mean(v) })).sort((a, b) => a.subject.localeCompare(b.subject)),
    };
  });

  const rows = enrols.map((en) => {
    const k = String(en.studentId); const scores = {}; const pcts = [];
    for (const c of cardsByStudent.get(k) || []) { scores[String(c.examId)] = { percentage: c.snapshot.percentage, grade: c.snapshot.grade, result: c.snapshot.resultStatus }; if (c.snapshot.percentage != null) pcts.push(c.snapshot.percentage); }
    return { studentId: en.studentId, rollNo: en.rollNo, name: S.get(k)?.name, admissionNo: S.get(k)?.admissionNo, section: SEC.get(String(en.sectionId))?.name, scores, average: mean(pcts), examsTaken: pcts.length };
  });
  rankBy(rows, 'average');
  const avgs = rows.map((r) => r.average).filter((x) => x != null);
  return {
    classId: cls._id, className: cls.name, sectionId: sectionId || null, sections: sections.map((s) => ({ id: s._id, name: s.name })),
    examsHeld: exams.length, examsPending: allClassExams.filter((e) => !exams.some((x) => String(x._id) === String(e._id))).map((e) => ({ name: e.name, status: e.status, date: e.startDate })),
    exams: examRows, students: rows,
    summary: { students: rows.length, classAverage: mean(avgs), needsAttention: rows.filter((r) => r.average != null && r.average < pass + 10).length, passMark: pass },
  };
}

// ───────────── homework of a day, by subject ─────────────
export async function sectionHomework(ctx, sectionId, date) {
  const section = await loadSection(ctx, sectionId);
  const base = { tenantId: ctx.tenantId, sectionId: section._id, status: { $in: ['published', 'archived'] } };
  const [rows, counts] = await Promise.all([
    Homework.find({ ...base, $or: [{ assignedDate: date }, { dueDate: date }] }).populate('subjectId', 'name').populate('teacherId', 'name').lean(),
    Homework.aggregate([{ $match: { ...base, assignedDate: { $gte: addDays(date, -13), $lte: date } } }, { $group: { _id: '$assignedDate', n: { $sum: 1 } } }]),
  ]);
  const n = new Map(counts.map((c) => [c._id, c.n]));
  const offered = await TeachingAssignment.find({ tenantId: ctx.tenantId, sectionId: section._id, open: true }).populate('subjectId', 'name').lean();
  const items = rows.map((h) => ({ id: h._id, title: h.title, subject: h.subjectId?.name, teacher: h.teacherId?.name, type: h.type, assignedDate: h.assignedDate, dueDate: h.dueDate, status: h.status, description: h.description, kind: h.assignedDate === date && h.dueDate === date ? 'both' : h.assignedDate === date ? 'assigned' : 'due' }))
    .sort((a, b) => String(a.subject).localeCompare(String(b.subject)));
  // subjects that set nothing that day are shown too, so the admin sees at a glance who did and did not give homework
  const given = new Set(items.filter((i) => i.kind !== 'due').map((i) => i.subject));
  return {
    date, items, days: Array.from({ length: 14 }, (_, i) => { const d = addDays(date, -13 + i); return { date: d, count: n.get(d) || 0 }; }),
    subjectsWithout: [...new Set(offered.map((a) => a.subjectId?.name))].filter((s) => s && !given.has(s)).sort(),
  };
}

// ───────────── one student, everything ─────────────
export async function studentOverview(ctx, studentId) {
  const student = await Student.findOne({ _id: studentId, tenantId: ctx.tenantId }).select('name admissionNo gender dob house guardians phone address status').lean();
  if (!student) throw notFound('Student not found');
  const enrols = await StudentEnrolment.find({ tenantId: ctx.tenantId, studentId }).sort({ startDate: -1, createdAt: -1 }).lean();
  const enr = enrols.find((e) => String(e.yearId) === String(ctx.year._id) && e.status === 'active') || enrols.find((e) => String(e.yearId) === String(ctx.year._id)) || enrols[0] || null;
  const [section, cls] = enr ? await Promise.all([Section.findById(enr.sectionId).lean(), ClassModel.findById(enr.classId).lean()]) : [];
  const recs = await submittedRecords(ctx.tenantId, { studentId, yearId: ctx.year._id });
  const heat = await studentHeatmap({ ...ctx, student: { _id: student._id } });
  const [cards, hw, fees, issues, bus, remarks] = await Promise.all([
    ReportCard.find({ tenantId: ctx.tenantId, studentId, isCurrent: true }).sort({ publishedAt: 1 }).lean(),
    enr ? Homework.find({ tenantId: ctx.tenantId, sectionId: enr.sectionId, status: 'published' }).sort({ dueDate: -1 }).limit(25).populate('subjectId', 'name').populate('teacherId', 'name').lean() : [],
    studentAccount(ctx.tenantId, studentId, ctx.today),
    LibraryIssue.find({ tenantId: ctx.tenantId, borrowerType: 'student', borrowerId: studentId }).sort({ issuedOn: -1 }).limit(40).populate('bookId', 'title author').lean(),
    busOfStudent(ctx.tenantId, studentId),
    StudentRemark.find({ tenantId: ctx.tenantId, studentId }).sort({ createdAt: -1 }).limit(20).populate('teacherId', 'name').lean(),
  ]);
  const monthly = new Map();
  for (const r of recs) { const m = r.date.slice(0, 7); if (!monthly.has(m)) monthly.set(m, []); monthly.get(m).push(r); }
  return {
    profile: { id: student._id, name: student.name, admissionNo: student.admissionNo, className: cls?.name, section: section?.name, rollNo: enr?.rollNo, gender: student.gender, dob: student.dob, house: student.house, phone: student.phone, address: student.address, status: student.status, guardians: student.guardians },
    attendance: { ...summarize(recs, ctx.settings), days: heat.days, byMonth: [...monthly.entries()].sort().map(([month, v]) => ({ month, percentage: summarize(v, ctx.settings).percentage, absent: summarize(v, ctx.settings).absent })) },
    exams: cards.map((c) => ({ id: c.examId, exam: c.snapshot.exam.name, type: c.snapshot.exam.type, publishedAt: c.publishedAt, percentage: c.snapshot.percentage, grade: c.snapshot.grade, result: c.snapshot.resultStatus, obtained: c.snapshot.totalObtained, max: c.snapshot.totalMax,
      subjects: c.snapshot.subjects.map((s) => ({ subject: s.subject, components: s.components, obtained: s.obtained, max: s.max, percentage: s.percentage, grade: s.grade, absent: s.absent, passed: s.passed })) })),
    homework: hw.map((h) => ({ id: h._id, title: h.title, subject: h.subjectId?.name, teacher: h.teacherId?.name, assignedDate: h.assignedDate, dueDate: h.dueDate, type: h.type })),
    fees, bus,
    library: issues.map((i) => ({ id: i._id, title: i.bookId?.title, author: i.bookId?.author, issuedOn: i.issuedOn, dueDate: i.dueDate, returnedOn: i.returnedOn, status: i.status, overdue: i.status === 'issued' && i.dueDate < ctx.today, fine: i.fineAmount })),
    remarks: remarks.map((r) => ({ id: r._id, text: r.text, date: r.date, teacher: r.teacherId?.name })),
  };
}


// ───────────── one teacher, everything ─────────────
/**
 * The School Admin's complete picture of a teacher: classes taught and the class they are class teacher of, how those classes perform,
 * homework given, attendance (derived from leave records), leave balances, substitutions, salary and payslips, and library loans.
 */
export async function teacherOverview(ctx, teacherId) {
  const teacher = await Teacher.findOne({ _id: teacherId, tenantId: ctx.tenantId }).populate('subjectIds', 'name code').lean();
  if (!teacher) throw notFound('Teacher not found');
  const year = ctx.year;
  const [account, asg, cts] = await Promise.all([
    User.findById(teacher.userId).select('loginId status lastLoginAt').lean(),
    TeachingAssignment.find({ tenantId: ctx.tenantId, yearId: year._id, teacherId, open: true }).populate('subjectId', 'name').populate('sectionId', 'name').populate('classId', 'name').populate('offeringId', 'weeklyPeriods').lean(),
    ClassTeacherAssignment.find({ tenantId: ctx.tenantId, yearId: year._id, teacherId, open: true }).populate('sectionId', 'name classId').lean(),
  ]);
  const ctClassIds = cts.map((c) => c.sectionId?.classId).filter(Boolean);
  const ctClasses = mk(await ClassModel.find({ _id: { $in: ctClassIds } }).select('name').lean());
  const sectionIds = [...new Set([...asg.map((a) => String(a.sectionId?._id)), ...cts.map((c) => String(c.sectionId?._id))])];

  const [counts, ctRegs, ctToday, { rows, exams }, hwCounts, leaves, subsCovered, load, issues, pay, balances] = await Promise.all([
    StudentEnrolment.aggregate([{ $match: { tenantId: ctx.tenantId, status: 'active', sectionId: { $in: sectionIds.map((s) => new mongoose.Types.ObjectId(s)) } } }, { $group: { _id: '$sectionId', n: { $sum: 1 } } }]),
    sessionCounts(ctx.tenantId, { sectionId: { $in: cts.map((c) => c.sectionId?._id) }, date: { $gte: addDays(ctx.today, -30) } }),
    AttendanceSession.find({ tenantId: ctx.tenantId, sectionId: { $in: cts.map((c) => c.sectionId?._id) }, date: ctx.today }).select('sectionId status').lean(),
    publishedRows(ctx, asg.map((a) => ({ sectionId: a.sectionId?._id, subjectId: a.subjectId?._id }))),
    Homework.aggregate([{ $match: { tenantId: ctx.tenantId, teacherId: teacher._id, yearId: year._id, status: { $in: ['published', 'archived'] } } }, { $group: { _id: { s: '$sectionId', sub: '$subjectId' }, n: { $sum: 1 }, last: { $max: '$assignedDate' } } }]),
    LeaveApplication.find({ tenantId: ctx.tenantId, teacherId, status: { $in: ['approved', 'submitted'] }, endDate: { $gte: year.startDate }, startDate: { $lte: year.endDate } }).sort({ startDate: -1 }).lean(),
    Substitution.countDocuments({ tenantId: ctx.tenantId, substituteTeacherId: teacherId, date: { $gte: year.startDate, $lte: year.endDate } }),
    TimetableEntry.countDocuments({ tenantId: ctx.tenantId, yearId: year._id, assignmentId: { $in: asg.map((a) => a._id) } }),
    LibraryIssue.find({ tenantId: ctx.tenantId, borrowerType: 'teacher', borrowerId: teacherId }).sort({ issuedOn: -1 }).limit(30).populate('bookId', 'title author').lean(),
    teacherPay(ctx, teacher._id),
    leaveBalances(ctx, teacher._id),
  ]);
  const students = new Map(counts.map((c) => [String(c._id), c.n]));

  // classes taught, each with its strength and how the class did in this teacher's subject
  const en = new Map(exams.map((e) => [String(e._id), e]));
  const hwBy = new Map(hwCounts.map((h) => [`${h._id.s}|${h._id.sub}`, h]));
  const classes = asg.map((a) => {
    const mine = rows.filter((r) => r.sectionId === String(a.sectionId?._id) && r.subjectId === String(a.subjectId?._id));
    const examIds = [...new Set(mine.map((r) => r.examId))].sort((x, y) => (en.get(x)?.startDate || '').localeCompare(en.get(y)?.startDate || ''));
    const byExam = examIds.map((id) => ({ exam: en.get(id)?.name, average: mean(mine.filter((r) => r.examId === id).map((r) => r.pct)), students: mine.filter((r) => r.examId === id).length }));
    const h = hwBy.get(`${a.sectionId?._id}|${a.subjectId?._id}`);
    return {
      id: a._id, sectionId: a.sectionId?._id, className: a.classId?.name, section: a.sectionId?.name, subject: a.subjectId?.name, periodsPerWeek: a.offeringId?.weeklyPeriods, since: a.effectiveFrom,
      students: students.get(String(a.sectionId?._id)) || 0, results: byExam, latestAverage: byExam.length ? byExam[byExam.length - 1].average : null, homeworkGiven: h?.n || 0, lastHomework: h?.last || null,
    };
  }).sort((a, b) => `${a.className}${a.section}`.localeCompare(`${b.className}${b.section}`, undefined, { numeric: true }) || String(a.subject).localeCompare(b.subject));
  const todayBy = new Map(ctToday.map((s) => [String(s.sectionId), s.status]));
  const classTeacherOf = cts.map((c) => {
    const regs = ctRegs.filter((r) => r.sectionId === String(c.sectionId?._id)); const sum = zeroCounts();
    regs.forEach((r) => addCounts(sum, r.counts));
    return { sectionId: c.sectionId?._id, className: ctClasses.get(String(c.sectionId?.classId))?.name, section: c.sectionId?.name, students: students.get(String(c.sectionId?._id)) || 0, attendanceToday: todayBy.get(String(c.sectionId?._id)) || 'not_marked', attendance30: summarizeCounts(sum, ctx.settings).percentage };
  });

  // attendance: from the daily staff register where the school uses one, otherwise implied by approved leave
  const att = await personAttendance(ctx, 'teacher', teacher._id, { joiningDate: teacher.joiningDate, group: 'teachers' });
  const sm = att.summary;
  const leaveByType = {};
  att.days.filter((d) => d.leaveType).forEach((d) => { leaveByType[d.leaveType] = (leaveByType[d.leaveType] || 0) + 1; });
  const byMonth = [...att.days.filter((d) => d.working && d.status).reduce((m, d) => { const k = d.date.slice(0, 7); if (!m.has(k)) m.set(k, { month: k, n: 0, ok: 0 }); const e = m.get(k); e.n++; if (['present', 'late'].includes(d.status) || d.rawStatus === 'half_day') e.ok += d.rawStatus === 'half_day' ? 0.5 : 1; return m; }, new Map()).values()]
    .map((m) => ({ month: m.month, 'Present %': Math.round((m.ok / m.n) * 1000) / 10 }));

  return {
    profile: { id: teacher._id, name: teacher.name, employeeId: teacher.employeeId, designation: teacher.designation, email: teacher.email, phone: teacher.phone, qualification: teacher.qualification, joiningDate: teacher.joiningDate, address: teacher.address, status: teacher.status, subjects: (teacher.subjectIds || []).map((s) => s.name), account },
    classes, classTeacherOf, timetable: { periodsPerWeek: load },
    attendance: { workingDays: sm.workingDays, markedDays: sm.markedDays, present: sm.present + sm.late, late: sm.late, halfDay: sm.half_day, absent: sm.absent, onLeave: sm.leave, unpaid: sm.absent, percentage: sm.percentage, leaveByType, days: att.days, byMonth, source: att.source, registers: att.registers, derivedFromLeave: att.source !== 'registers' },
    leave: { balances, applications: leaves.slice(0, 20).map((l) => ({ id: l._id, leaveType: l.leaveType, startDate: l.startDate, endDate: l.endDate, days: l.days, status: l.status, reason: l.reason })) },
    substitutions: { covered: subsCovered },
    homework: { total: hwCounts.reduce((n, h) => n + h.n, 0) },
    pay, library: issues.map((i) => ({ id: i._id, title: i.bookId?.title, author: i.bookId?.author, issuedOn: i.issuedOn, dueDate: i.dueDate, returnedOn: i.returnedOn, status: i.status, overdue: i.status === 'issued' && i.dueDate < ctx.today })),
  };
}
