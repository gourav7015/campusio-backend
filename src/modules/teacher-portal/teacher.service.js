import { gapsForSections } from '../structure/class-structure.service.js';
import { rollStatus } from '../../services/context.js';
import { monitorsOf } from '../class-life/class-life.service.js';
import {
  Student, StudentEnrolment, Section, ClassModel, Subject, SubjectOffering, Examination, Homework, StudyMaterial, MarksSheet, ExaminationSubject, ReportCard, User, AuditLog, TeachingAssignment, StudentRemark, AcademicYear, ClassTeacherAssignment, AttendanceSession,
  Marks } from '../../models/index.js';
import { studentMarks } from '../insight/insight.service.js';
import { notFound, forbidden, addDays, isoDay, escapeRegex } from '../../core/utils.js';
import { teacherDay, teacherWeek } from '../../services/timetable.js';
import { summarize, submittedRecords } from '../../services/attendance.js';
import { trend } from '../attendance/attendance.service.js';
import { effectiveStatus, teacherTab } from '../homework/homework.service.js';
import { teacherExamList } from '../exams/marks.service.js';
import { teacherPerformance } from '../../services/analytics.js';
import { listFor } from '../comms/announcements.service.js';

const mk = (a) => new Map(a.map((x) => [String(x._id), x]));

export async function myYears(ctx) {
  const asg = await TeachingAssignment.distinct('yearId', { tenantId: ctx.tenantId, teacherId: ctx.teacher._id });
  const ct = await ClassTeacherAssignment.distinct('yearId', { tenantId: ctx.tenantId, teacherId: ctx.teacher._id });
  const years = await AcademicYear.find({ tenantId: ctx.tenantId, _id: { $in: [...asg, ...ct] } }).sort({ startDate: -1 }).lean();
  return years.map((y) => ({ id: y._id, name: y.name, isCurrent: y.isCurrent, isDefault: String(y._id) === String(ctx.year?._id) })); // isDefault: the year the teacher's pages open on when none is chosen
}

// ── classes ──
export async function myClasses(ctx) {
  const { scope } = ctx;
  const sectionIds = scope.sectionIds;
  const sections = await Section.find({ tenantId: ctx.tenantId, _id: { $in: sectionIds } }).lean();
  const [subjects, counts] = await Promise.all([
    Subject.find({ tenantId: ctx.tenantId, _id: { $in: scope.assignments.map((a) => a.subjectId) } }).lean(),
    StudentEnrolment.aggregate([{ $match: { tenantId: ctx.tenantId, status: rollStatus(ctx.year), sectionId: { $in: sections.map((s) => s._id) } } }, { $group: { _id: '$sectionId', n: { $sum: 1 } } }]),
  ]);
  const classes = mk(await ClassModel.find({ tenantId: ctx.tenantId, _id: { $in: sections.map((s) => s.classId) } }).lean());
  const sm = mk(subjects); const cm = new Map(counts.map((c) => [String(c._id), c.n]));
  return sections.map((sec) => {
    const subs = scope.assignments.filter((a) => String(a.sectionId) === String(sec._id)).map((a) => ({ id: a.subjectId, name: sm.get(String(a.subjectId))?.name }));
    const isCT = scope.classTeacherSectionIds.includes(String(sec._id));
    return {
      sectionId: sec._id, className: classes.get(String(sec.classId))?.name, section: sec.name, room: sec.room, students: cm.get(String(sec._id)) || 0, subjects: subs,
      role: isCT && subs.length ? 'Class teacher + subject teacher' : isCT ? 'Class teacher' : 'Subject teacher', isClassTeacher: isCT,
    };
  }).sort((a, b) => `${a.className}${a.section}`.localeCompare(`${b.className}${b.section}`, undefined, { numeric: true }));
}

function assertSection(ctx, sectionId) {
  if (!ctx.scope.hasSection(sectionId)) throw forbidden('You are not assigned to this section');
}

export async function classOverview(ctx, sectionId) {
  assertSection(ctx, sectionId);
  const section = await Section.findOne({ _id: sectionId, tenantId: ctx.tenantId });
  if (!section) throw notFound('Section not found');
  const [cls, ct, studentCount, session, nextExam, hw] = await Promise.all([
    ClassModel.findById(section.classId), ClassTeacherAssignment.findOne({ tenantId: ctx.tenantId, sectionId, open: true }).populate('teacherId', 'name'),
    StudentEnrolment.countDocuments({ tenantId: ctx.tenantId, sectionId, status: 'active' }), AttendanceSession.findOne({ tenantId: ctx.tenantId, sectionId, date: ctx.today }),
    ExaminationSubject.find({ tenantId: ctx.tenantId, classId: section.classId, date: { $gte: ctx.today } }).sort({ date: 1 }).limit(1).populate('subjectId', 'name').populate('examId', 'name schedulePublished'),
    Homework.find({ tenantId: ctx.tenantId, sectionId, teacherId: ctx.teacher._id, status: 'published', dueDate: { $gte: ctx.today } }).countDocuments(),
  ]);
  const week = await teacherWeek({ tenantId: ctx.tenantId, yearId: ctx.year._id, teacherId: ctx.teacher._id, date: ctx.today, today: ctx.today, tz: ctx.settings.timezone });
  const upcoming = week.flatMap((d) => d.rows.filter((r) => String(r.sectionId) === String(sectionId) && (d.date > ctx.today || (d.date === ctx.today && ['upcoming', 'next', 'current'].includes(r.status)))));
  const subjects = ctx.scope.assignments.filter((a) => String(a.sectionId) === String(sectionId));
  const subjDocs = mk(await Subject.find({ tenantId: ctx.tenantId, _id: { $in: subjects.map((s) => s.subjectId) } }).lean());
  return {
    sectionId, className: cls?.name, section: section.name, room: section.room, yearName: ctx.year.name, classTeacher: ct?.teacherId?.name || null, isClassTeacher: ctx.scope.classTeacherSectionIds.includes(String(sectionId)),
    subjects: subjects.map((s) => ({ id: s.subjectId, name: subjDocs.get(String(s.subjectId))?.name })), studentCount, capacity: section.capacity,
    attendanceToday: session ? session.status : 'not_marked', nextPeriod: upcoming[0] || null,
    upcomingExam: nextExam[0] && nextExam[0].examId?.schedulePublished ? { exam: nextExam[0].examId.name, subject: nextExam[0].subjectId?.name, date: nextExam[0].date } : null, activeHomework: hw,
  };
}

export async function classStudents(ctx, sectionId) {
  assertSection(ctx, sectionId);
  const enr = await StudentEnrolment.find({ tenantId: ctx.tenantId, sectionId, status: rollStatus(ctx.year) }).sort({ rollNo: 1 }).lean();
  const students = mk(await Student.find({ tenantId: ctx.tenantId, _id: { $in: enr.map((e) => e.studentId) } }).select('name admissionNo gender').lean());
  const recs = await submittedRecords(ctx.tenantId, { sectionId, yearId: ctx.year._id });
  const by = new Map();
  recs.forEach((r) => { const k = String(r.studentId); if (!by.has(k)) by.set(k, []); by.get(k).push(r); });
  const subjectIds = ctx.scope.assignments.filter((a) => String(a.sectionId) === String(sectionId)).map((a) => String(a.subjectId));
  const cards = await ReportCard.find({ tenantId: ctx.tenantId, sectionId, yearId: ctx.year._id, isCurrent: true, studentId: { $in: enr.map((e) => e.studentId) } }).sort({ publishedAt: 1 }).lean();
  const subjDocs = mk(await Subject.find({ tenantId: ctx.tenantId, _id: { $in: subjectIds } }).select('code').lean());
  const codes = new Set([...subjDocs.values()].map((s) => s.code));
  const monitors = await monitorsOf(ctx.tenantId, sectionId);
  return enr.map((e) => {
    const s = students.get(String(e.studentId));
    const mine = cards.filter((c) => String(c.studentId) === String(e.studentId));
    const last = mine[mine.length - 1];
    // a subject teacher sees scores for their own subject; the class teacher sees overall
    const ownScore = last?.snapshot.subjects.filter((x) => codes.has(x.code) && x.percentage != null);
    const latest = ctx.scope.classTeacherSectionIds.includes(String(sectionId)) ? last?.snapshot.percentage ?? null : ownScore?.length ? Math.round(ownScore.reduce((n, x) => n + x.percentage, 0) / ownScore.length) : null;
    return { studentId: e.studentId, rollNo: e.rollNo, name: s?.name, admissionNo: s?.admissionNo, attendance: summarize(by.get(String(e.studentId)) || [], ctx.settings).percentage, latestScore: latest, monitor: monitors.has(String(e.studentId)) };
  });
}

/**
 * Everything the class teacher needs to know about a student of their own class: the personal and family details, the bus, how the student is doing in every subject
 * (with the rank in the class and the strong and weak subjects), and the marks that have been entered or approved but not published yet.
 * Fees and personal documents are never part of it.
 */
async function fullFile(ctx, student, enr) {
  const m = await studentMarks(ctx, student._id);
  const rows = await Marks.find({ tenantId: ctx.tenantId, studentId: student._id, sectionId: enr.sectionId }).lean();
  const sheets = new Map((await MarksSheet.find({ tenantId: ctx.tenantId, _id: { $in: rows.map((r) => r.sheetId) } }).select('status').lean()).map((x) => [String(x._id), x.status]));
  const waiting = rows.filter((r) => sheets.get(String(r.sheetId)) && sheets.get(String(r.sheetId)) !== 'published');
  const ess = new Map((await ExaminationSubject.find({ tenantId: ctx.tenantId, _id: { $in: waiting.map((r) => r.examSubjectId) } }).select('subjectId components').lean()).map((x) => [String(x._id), x]));
  const exams = new Map((await Examination.find({ tenantId: ctx.tenantId, _id: { $in: waiting.map((r) => r.examId) } }).select('name type').lean()).map((x) => [String(x._id), x]));
  const subjects = new Map((await Subject.find({ tenantId: ctx.tenantId, _id: { $in: [...ess.values()].map((x) => x.subjectId) } }).select('name').lean()).map((x) => [String(x._id), x.name]));
  const pending = waiting.map((r) => {
    const es = ess.get(String(r.examSubjectId));
    return { exam: exams.get(String(r.examId))?.name, subject: subjects.get(String(es?.subjectId)), status: sheets.get(String(r.sheetId)), obtained: r.absent ? null : r.total ?? null, max: (es?.components || []).reduce((n, c) => n + (c.max || 0), 0), absent: !!r.absent, exempt: !!r.exempt };
  }).sort((a, b) => `${a.exam}${a.subject}`.localeCompare(`${b.exam}${b.subject}`));
  return {
    personal: { dob: student.dob, admissionDate: student.admissionDate, bloodGroup: student.bloodGroup, emergencyContact: student.emergencyContact || null },
    guardians: (student.guardians || []).map((g) => ({ name: g.name, relationship: g.relationship, phone: g.phone, email: g.email })),
    bus: m.profile.bus, summary: m.summary, exams: m.exams, subjectAverages: m.subjectAverages, pending,
  };
}

/** Teachers see academic data only, never fees, documents or unrelated administrative details. */
export async function studentDetail(ctx, studentId) {
  const enrols = await StudentEnrolment.find({ tenantId: ctx.tenantId, studentId, status: rollStatus(ctx.year), yearId: ctx.year._id });
  const enr = enrols.find((e) => ctx.scope.hasSection(e.sectionId));
  if (!enr) throw notFound('Student not found in your classes');
  const [student, section, cls] = await Promise.all([Student.findOne({ _id: studentId, tenantId: ctx.tenantId }).select('name admissionNo gender dob house guardians phone email address photoFileId admissionDate bloodGroup emergencyContact'), Section.findById(enr.sectionId), ClassModel.findById(enr.classId)]);
  const recs = await submittedRecords(ctx.tenantId, { studentId, yearId: ctx.year._id });
  const isCT = ctx.scope.classTeacherSectionIds.includes(String(enr.sectionId));
  const mySubjects = new Set(ctx.scope.assignments.filter((a) => String(a.sectionId) === String(enr.sectionId)).map((a) => String(a.subjectId)));
  const subjDocs = await Subject.find({ tenantId: ctx.tenantId }).select('name code').lean();
  const myCodes = new Set(subjDocs.filter((s) => mySubjects.has(String(s._id))).map((s) => s.code));
  const cards = await ReportCard.find({ tenantId: ctx.tenantId, studentId, isCurrent: true }).sort({ publishedAt: 1 }).lean();
  const hw = await Homework.find({ tenantId: ctx.tenantId, sectionId: enr.sectionId, teacherId: ctx.teacher._id, status: 'published' }).sort({ dueDate: -1 }).limit(15).lean();
  const history = await StudentEnrolment.find({ tenantId: ctx.tenantId, studentId }).sort({ startDate: -1 }).lean();
  const [secs, cls2, years] = await Promise.all([Section.find({ tenantId: ctx.tenantId }).lean(), ClassModel.find({ tenantId: ctx.tenantId }).lean(), AcademicYear.find({ tenantId: ctx.tenantId }).lean()]);
  const SM = mk(secs); const CM = mk(cls2); const YM = mk(years);
  const remarks = await StudentRemark.find({ tenantId: ctx.tenantId, studentId }).sort({ createdAt: -1 }).limit(30).populate('teacherId', 'name').lean();
  const monitors = await monitorsOf(ctx.tenantId, enr.sectionId);
  const full = isCT ? await fullFile(ctx, student, enr) : null;
  return {
    full,
    profile: { id: student._id, name: student.name, admissionNo: student.admissionNo, rollNo: enr.rollNo, className: cls?.name, section: section?.name, gender: student.gender, house: student.house, guardian: student.guardians?.find((g) => g.isPrimary)?.name || student.guardians?.[0]?.name },
    attendance: summarize(recs, ctx.settings),
    marks: cards.map((c) => ({
      exam: c.snapshot.exam.name, examType: c.snapshot.exam.type, publishedAt: c.publishedAt, percentage: isCT ? c.snapshot.percentage : null, grade: isCT ? c.snapshot.grade : null,
      subjects: c.snapshot.subjects.filter((s) => isCT || myCodes.has(s.code)).map((s) => ({ subject: s.subject, components: s.components, obtained: s.obtained, max: s.max, percentage: s.percentage, grade: s.grade, absent: s.absent, remarks: s.remarks })),
    })),
    homework: hw.map((h) => ({ id: h._id, title: h.title, dueDate: h.dueDate })),
    remarks: remarks.map((r) => ({ id: r._id, text: r.text, date: r.date, category: r.category, requireAck: r.requireAck, acknowledged: !!r.ackAt, teacher: r.teacherId?.name, mine: String(r.teacherId?._id) === String(ctx.teacher._id) })),
    canEdit: isCT, monitor: monitors.has(String(studentId)), photoFileId: student.photoFileId, contact: isCT ? { phone: student.phone, email: student.email, address: student.address, guardianPhone: student.guardians?.[0]?.phone, guardianEmail: student.guardians?.[0]?.email } : undefined,
    history: history.map((e) => ({ year: YM.get(String(e.yearId))?.name, className: CM.get(String(e.classId))?.name, section: SM.get(String(e.sectionId))?.name, rollNo: e.rollNo, status: e.status, startDate: e.startDate, endDate: e.endDate })),
  };
}
export async function addRemark(ctx, studentId, text) {
  const enr = await StudentEnrolment.findOne({ tenantId: ctx.tenantId, studentId, status: rollStatus(ctx.year), yearId: ctx.year._id });
  if (!enr || !ctx.scope.hasSection(enr.sectionId)) throw notFound('Student not found in your classes');
  return StudentRemark.create({ tenantId: ctx.tenantId, studentId, teacherId: ctx.teacher._id, text, date: ctx.today });
}

/**
 * Class-wise results matrix: every student of the section × every published exam.
 * The class teacher sees overall results; a subject teacher sees only their own subject(s).
 */
export async function classPerformance(ctx, sectionId) {
  assertSection(ctx, sectionId);
  const section = await Section.findOne({ _id: sectionId, tenantId: ctx.tenantId });
  if (!section) throw notFound('Section not found');
  const isCT = ctx.scope.classTeacherSectionIds.includes(String(sectionId));
  const mine = ctx.scope.allAssignments.filter((a) => String(a.sectionId) === String(sectionId)).map((a) => String(a.subjectId));
  const subjDocs = await Subject.find({ tenantId: ctx.tenantId, _id: { $in: mine } }).select('code').lean();
  const myCodes = new Set(subjDocs.map((x) => x.code));
  const enrolments = await StudentEnrolment.find({ tenantId: ctx.tenantId, sectionId, yearId: ctx.year._id }).sort({ rollNo: 1 }).lean();
  const students = mk(await Student.find({ tenantId: ctx.tenantId, _id: { $in: enrolments.map((e) => e.studentId) } }).select('name admissionNo').lean());
  const cards = await ReportCard.find({ tenantId: ctx.tenantId, sectionId, yearId: ctx.year._id, isCurrent: true }).lean();
  const exams = await Examination.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(cards.map((c) => String(c.examId)))] } }).lean();
  const examList = exams.map((e) => ({ id: e._id, name: e.name, type: e.type, date: e.startDate || '' })).sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.name.localeCompare(b.name));
  const rows = [];
  const seen = new Set();
  for (const e of enrolments) {
    if (seen.has(String(e.studentId))) continue;
    seen.add(String(e.studentId));
    const scores = {};
    const pcts = [];
    for (const c of cards.filter((x) => String(x.studentId) === String(e.studentId))) {
      let cell;
      if (isCT) cell = { percentage: c.snapshot.percentage, grade: c.snapshot.grade, obtained: c.snapshot.totalObtained, max: c.snapshot.totalMax, result: c.snapshot.resultStatus };
      else {
        const rowsMine = c.snapshot.subjects.filter((x) => myCodes.has(x.code) && !x.exempt);
        if (!rowsMine.length) continue;
        const obtained = rowsMine.reduce((n, x) => n + (x.obtained ?? 0), 0); const max = rowsMine.reduce((n, x) => n + x.max, 0);
        cell = { percentage: max ? Math.round((obtained / max) * 1000) / 10 : null, grade: rowsMine.length === 1 ? rowsMine[0].grade : null, obtained, max, result: rowsMine.every((x) => x.passed) ? 'pass' : 'fail' };
      }
      scores[String(c.examId)] = cell;
      if (cell.percentage != null) pcts.push(cell.percentage);
    }
    rows.push({ studentId: e.studentId, rollNo: e.rollNo, name: students.get(String(e.studentId))?.name, admissionNo: students.get(String(e.studentId))?.admissionNo, active: e.status === 'active', scores, average: pcts.length ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 10) / 10 : null });
  }
  // a subject teacher only sees the tests in which their subject took part
  const shown = isCT ? examList : examList.filter((e) => rows.some((r) => r.scores[String(e.id)]));
  return { sectionId, scope: isCT ? 'overall' : 'subject', exams: shown, students: rows };
}

// ── subjects ──
export async function mySubjects(ctx) {
  const asg = ctx.scope.assignments;
  const bySubject = new Map();
  asg.forEach((a) => { const k = String(a.subjectId); if (!bySubject.has(k)) bySubject.set(k, []); bySubject.get(k).push(a); });
  const [subjects, sections, offerings, hw, mat, sheets, ess, classes] = await Promise.all([
    Subject.find({ tenantId: ctx.tenantId, _id: { $in: [...bySubject.keys()] } }).lean(), Section.find({ tenantId: ctx.tenantId, _id: { $in: asg.map((a) => a.sectionId) } }).lean(),
    SubjectOffering.find({ tenantId: ctx.tenantId, _id: { $in: asg.map((a) => a.offeringId) } }).lean(),
    Homework.aggregate([{ $match: { tenantId: ctx.tenantId, teacherId: ctx.teacher._id, yearId: ctx.year._id, status: 'published' } }, { $group: { _id: '$subjectId', n: { $sum: 1 } } }]),
    StudyMaterial.aggregate([{ $match: { tenantId: ctx.tenantId, teacherId: ctx.teacher._id, yearId: ctx.year._id, status: 'published' } }, { $group: { _id: '$subjectId', n: { $sum: 1 } } }]),
    MarksSheet.find({ tenantId: ctx.tenantId, teacherId: ctx.teacher._id }).lean(), ExaminationSubject.find({ tenantId: ctx.tenantId, classId: { $in: asg.map((a) => a.classId) } }).lean(),
    ClassModel.find({ tenantId: ctx.tenantId }).lean(),
  ]);
  const SEC = mk(sections); const OFF = mk(offerings); const HW = new Map(hw.map((x) => [String(x._id), x.n])); const MAT = new Map(mat.map((x) => [String(x._id), x.n])); const CM = mk(classes);
  return subjects.map((s) => {
    const list = bySubject.get(String(s._id));
    const sheetStatus = {};
    sheets.filter((sh) => ess.some((e) => String(e._id) === String(sh.examSubjectId) && String(e.subjectId) === String(s._id))).forEach((sh) => { sheetStatus[sh.status] = (sheetStatus[sh.status] || 0) + 1; });
    return {
      subjectId: s._id, name: s.name, code: s.code, academicYear: ctx.year.name, assignmentCount: list.length,
      assignments: list.map((a) => ({ sectionId: a.sectionId, className: CM.get(String(SEC.get(String(a.sectionId))?.classId))?.name, section: SEC.get(String(a.sectionId))?.name, weeklyPeriods: OFF.get(String(a.offeringId))?.weeklyPeriods })),
      weeklyPeriods: list.reduce((n, a) => n + (OFF.get(String(a.offeringId))?.weeklyPeriods || 0), 0), examStructure: OFF.get(String(list[0].offeringId))?.assessment, homeworkCount: HW.get(String(s._id)) || 0, materialCount: MAT.get(String(s._id)) || 0, marksStatus: sheetStatus,
    };
  });
}

// ── dashboard ──
export async function dashboard(ctx) {
  const { scope, today, year } = ctx;
  const tenantId = ctx.tenantId;
  const rows = await teacherDay({ tenantId, yearId: year._id, teacherId: ctx.teacher._id, date: today, today, tz: ctx.settings.timezone });
  const sectionIds = scope.sectionIds;
  const [studentsAssigned, sessions, hw, exams, perf, announcements, trendRows, activity] = await Promise.all([
    StudentEnrolment.distinct('studentId', { tenantId, sectionId: { $in: sectionIds }, status: 'active' }),
    AttendanceSession.find({ tenantId, sectionId: { $in: sectionIds }, date: today }).lean(),
    Homework.find({ tenantId, teacherId: ctx.teacher._id, yearId: year._id }).lean(),
    teacherExamList(ctx), teacherPerformance(ctx), listFor(ctx, { role: 'teacher', sectionIds, userId: ctx.actorId }, { limit: 5 }), trend(ctx, sectionIds, 7),
    recentActivity(ctx),
  ]);
  const sessionBy = new Map(sessions.map((s) => [String(s.sectionId), s]));
  const working = ctx.settings.workingDays.includes(isoDay(today));
  // sections this teacher is responsible for registering today: they teach a period there, or they are its class teacher
  // only the class teacher takes a section's daily register
  const respSections = new Set(scope.classTeacherSectionIds);
  const pendingAttendance = working ? [...respSections].filter((id) => sessionBy.get(id)?.status !== 'submitted').length : 0;
  const todaysSubmitted = sessions.filter((s) => s.status === 'submitted' && sectionIds.includes(String(s.sectionId)));
  const { AttendanceRecord } = await import('../../models/index.js');
  const recs = todaysSubmitted.length ? await AttendanceRecord.find({ sessionId: { $in: todaysSubmitted.map((s) => s._id) } }).select('status').lean() : [];
  const att = { present: 0, absent: 0, leave: 0, late: 0, half_day: 0 };
  recs.forEach((r) => { if (att[r.status] !== undefined) att[r.status]++; if (r.status === 'excused') att.leave++; });
  const hwEnriched = hw.map((h) => ({ ...h, tab: teacherTab(h, today, new Date()), eff: effectiveStatus(h) }));
  const published = hwEnriched.filter((h) => h.eff === 'published');
  const next = rows.find((r) => ['current', 'next'].includes(r.status));
  const examStatusCount = (s) => exams.filter((e) => e.status === s).length;
  const upcomingExams = exams.filter((e) => e.date && e.date >= today).slice(0, 5);
  return {
    // what is still missing in the classes this teacher is class teacher of (a subject nobody has been assigned to teach)
    classGaps: await gapsForSections(tenantId, year._id, scope.classTeacherSectionIds),
    permissions: { takeAttendance: scope.classTeacherSectionIds.length > 0 },
    greeting: { name: ctx.teacher.name, date: today, weekday: isoDay(today), periodsToday: rows.filter((r) => !r.covering || true).length, firstUpcoming: next || null, working },
    cards: { assignedStudents: studentsAssigned.length, assignedClasses: sectionIds.length, pendingAttendance, activeAssignments: published.filter((h) => h.dueDate >= today).length },
    today: rows,
    attendance: { totalStudents: studentsAssigned.length, ...att, registersPending: pendingAttendance, trend: trendRows.map((t) => ({ date: t.date, percentage: t.percentage })) },
    homework: {
      published: published.length, draft: hwEnriched.filter((h) => h.eff === 'draft').length, scheduled: hwEnriched.filter((h) => h.eff === 'scheduled').length,
      upcomingDeadlines: published.filter((h) => h.dueDate >= today).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 5).map((h) => ({ id: h._id, title: h.title, dueDate: h.dueDate })),
      overdue: published.filter((h) => h.dueDate < today && h.dueDate >= addDays(today, -14)).length,
    },
    exams: {
      upcoming: upcomingExams, awaitingSubmission: exams.filter((e) => ['not_started', 'draft'].includes(e.status)).length, returned: examStatusCount('returned'),
      completed: exams.filter((e) => ['approved', 'published'].includes(e.status)).length, deadlines: exams.filter((e) => e.deadline && ['not_started', 'draft', 'returned'].includes(e.status)).sort((a, b) => a.deadline.localeCompare(b.deadline)).slice(0, 5),
    },
    performance: { averageByExam: perf.averageByExam, distribution: perf.distribution },
    announcements, activity,
  };
}

const LINKS = { Homework: 'homework', AttendanceSession: 'attendance', StudyMaterial: 'material', MarksSheet: 'marks', Announcement: 'announcement', LeaveApplication: 'leave' };
export async function recentActivity(ctx) {
  const logs = await AuditLog.find({ tenantId: ctx.tenantId, actorId: ctx.actorId, action: { $ne: 'auth.login' } }).sort({ createdAt: -1 }).limit(8).lean();
  const approvals = await AuditLog.find({ tenantId: ctx.tenantId, action: { $in: ['marks.approved', 'marks.returned'] } }).sort({ createdAt: -1 }).limit(4).lean();
  const sheets = await MarksSheet.find({ tenantId: ctx.tenantId, _id: { $in: approvals.map((a) => a.entityId) }, teacherId: ctx.teacher._id }).select('_id').lean();
  const mine = new Set(sheets.map((s) => String(s._id)));
  return [...logs, ...approvals.filter((a) => mine.has(String(a.entityId)))].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10)
    .map((l) => ({ id: l._id, at: l.createdAt, action: l.action, summary: l.summary, link: LINKS[l.entityType] ? { type: LINKS[l.entityType], id: l.entityId } : null }));
}

export async function search(ctx, q) {
  if (!q || q.length < 2) return { students: [], classes: [] };
  const rx = new RegExp(escapeRegex(q), 'i');
  const enr = await StudentEnrolment.find({ tenantId: ctx.tenantId, sectionId: { $in: ctx.scope.sectionIds }, status: 'active', yearId: ctx.year._id }).lean();
  const students = await Student.find({ tenantId: ctx.tenantId, _id: { $in: enr.map((e) => e.studentId) }, $or: [{ name: rx }, { admissionNo: rx }] }).select('name admissionNo').limit(8).lean();
  const secs = mk(await Section.find({ tenantId: ctx.tenantId, _id: { $in: ctx.scope.sectionIds } }).lean());
  const cls = mk(await ClassModel.find({ tenantId: ctx.tenantId }).lean());
  const classes = [...secs.values()].map((s) => ({ sectionId: s._id, label: `${cls.get(String(s.classId))?.name} ${s.name}` })).filter((c) => rx.test(c.label));
  return { students: students.map((s) => ({ id: s._id, name: s.name, admissionNo: s.admissionNo, sectionId: enr.find((e) => String(e.studentId) === String(s._id))?.sectionId })), classes };
}

export async function profile(ctx) {
  const [user, subjects] = await Promise.all([User.findById(ctx.actorId).select('loginId email lastLoginAt'), Subject.find({ tenantId: ctx.tenantId, _id: { $in: ctx.teacher.subjectIds } }).select('name code').lean()]);
  return { ...ctx.teacher.toObject(), subjects, account: user, school: ctx.school.name };
}
export async function updateProfile(ctx, { phone, address }) {
  if (phone !== undefined) ctx.teacher.phone = phone;
  if (address !== undefined) ctx.teacher.address = address;
  return ctx.teacher.save();
}
