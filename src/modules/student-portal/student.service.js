import { Section, ClassModel, File, User, Notification, ChatThread, AcademicYear, StudentEnrolment } from '../../models/index.js';
import { forbidden, addDays, isoDay } from '../../core/utils.js';
import { sectionDay, sectionWeek } from '../../services/timetable.js';
import { listForStudent as homeworkFor } from '../homework/homework.service.js';
import * as attendance from '../attendance/attendance.service.js';
import * as results from '../exams/results.service.js';
import { listFor as announcementsFor } from '../comms/announcements.service.js';
import { feed } from '../comms/calendar.service.js';
import { studentAccount } from '../finance/finance.service.js';
import { LibraryIssue } from '../../models/index.js';
import { monitorsOf, pendingCount } from '../class-life/class-life.service.js';


export async function profile(ctx) {
  const { student, enrolment, year } = ctx;
  const [section, cls, user, photo] = await Promise.all([
    enrolment && Section.findById(enrolment.sectionId), enrolment && ClassModel.findById(enrolment.classId), User.findById(ctx.actorId).select('loginId language'),
    student.photoFileId && File.findById(student.photoFileId).select('originalName'),
  ]);
  return {
    personal: { name: student.name, dob: student.dob, gender: student.gender, address: student.address, phone: student.phone, email: student.email, photoFileId: photo?._id },
    academic: {
      admissionNo: student.admissionNo, academicYear: year?.name, className: cls?.name, section: section?.name, rollNo: enrolment?.rollNo, monitor: enrolment ? (await monitorsOf(ctx.tenantId, enrolment.sectionId)).has(String(student._id)) : false, admissionDate: student.admissionDate, schoolName: ctx.school.name, enrolmentStatus: enrolment?.status,
    },
    guardians: (student.guardians || []).map((g) => ({ name: g.name, relationship: g.relationship, phone: g.phone, email: g.email })),
    other: { house: student.house, bloodGroup: student.bloodGroup, emergencyContact: student.emergencyContact },
    account: { loginId: user?.loginId, language: user?.language }, editableFields: [], // a student only looks: the class teacher keeps their details (phone, address, guardian) up to date
  };
}

/** A student cannot change their own details: the class teacher (or the school office) keeps them. Only a photo can be added by the student. */
export async function updateProfile() {
  throw forbidden('Your details are kept by your class teacher. Ask them to change anything that is wrong.');
}

export async function setPhoto(ctx, file) {
  const old = ctx.student.photoFileId;
  ctx.student.photoFileId = file._id;
  await ctx.student.save();
  if (old) { const f = await File.findById(old); if (f) { const { removeFileBytes } = await import('../../services/files.js'); await removeFileBytes(f); await f.deleteOne(); } }
  return profile(ctx);
}

export async function timetable(ctx, { view = 'day', date }) {
  if (!ctx.enrolment) return { view, rows: [], message: 'No active enrolment for this academic year' };
  const d = date || ctx.today;
  const base = { tenantId: ctx.tenantId, yearId: ctx.year._id, sectionId: ctx.enrolment.sectionId, date: d, today: ctx.today, tz: ctx.settings.timezone };
  if (view === 'week') return { view, date: d, week: await sectionWeek({ ...base, days: ctx.settings.workingDays }) };
  if (view === 'subject') {
    const week = await sectionWeek({ ...base, days: ctx.settings.workingDays });
    const by = new Map();
    for (const day of week) for (const row of day.rows.filter((r) => r.subject)) {
      if (!by.has(row.subject)) by.set(row.subject, []);
      by.get(row.subject).push({ day: day.day, date: day.date, period: row.period, startTime: row.startTime, endTime: row.endTime, teacher: row.teacher, room: row.room, substitute: row.substitute });
    }
    return { view, subjects: [...by].map(([subject, slots]) => ({ subject, slots })) };
  }
  const rows = await sectionDay({ ...base });
  return { view: 'day', date: d, working: ctx.settings.workingDays.includes(isoDay(d)), rows, empty: !rows.some((r) => !r.isBreak && !r.free) };
}

export async function documents(ctx) {
  const files = await File.find({ tenantId: ctx.tenantId, kind: 'document', ownerType: 'student', ownerId: String(ctx.student._id) }).sort({ createdAt: -1 }).lean();
  return files.map((f) => ({ id: f._id, name: f.originalName, type: f.docType, size: f.size, mime: f.mime, uploadedAt: f.createdAt }));
}

export async function dashboard(ctx) {
  const { today } = ctx;
  const enrolled = !!ctx.enrolment;
  const [att, hwAll, schedule, resultsList, latest, anns, cal, activity, calendarMonth, timetableRows] = await Promise.all([
    attendance.studentSummary(ctx), homeworkFor(ctx, { tab: 'all' }), results.schedule(ctx), results.resultsList(ctx), results.dashboardResult(ctx),
    announcementsFor(ctx, { role: 'student', sectionIds: ctx.sectionIds, userId: ctx.actorId }, { limit: 5 }),
    feed(ctx, { from: today, to: addDays(today, 45) }, { sectionIds: ctx.sectionIds, classIds: [...new Set(ctx.enrolments.map((e) => String(e.classId)))] }),
    Notification.find({ tenantId: ctx.tenantId, userId: ctx.actorId }).sort({ createdAt: -1 }).limit(8).lean(),
    attendance.studentCalendar(ctx, today.slice(0, 7)),
    enrolled ? sectionDay({ tenantId: ctx.tenantId, yearId: ctx.year._id, sectionId: ctx.enrolment.sectionId, date: today, today, tz: ctx.settings.timezone }) : [],
  ]);
  const [pendingRemarks, unreadChats] = await Promise.all([pendingCount(ctx), ChatThread.countDocuments({ tenantId: ctx.tenantId, studentId: ctx.student._id, unreadStudent: { $gt: 0 } })]);
  const [acct, loans] = await Promise.all([studentAccount(ctx.tenantId, ctx.student._id, today), LibraryIssue.find({ tenantId: ctx.tenantId, borrowerType: 'student', borrowerId: ctx.student._id, status: 'issued' }).lean()]);
  const pending = hwAll.filter((h) => h.state !== 'overdue');
  const next = schedule.find((s) => s.daysLeft >= 0);
  const published = resultsList.filter((r) => r.status === 'published');
  const cls = ctx.enrolment ? await ClassModel.findById(ctx.enrolment.classId) : null;
  const sec = ctx.enrolment ? await Section.findById(ctx.enrolment.sectionId) : null;
  return {
    welcome: { name: ctx.student.name.split(' ')[0], date: today, weekday: isoDay(today), className: cls?.name, section: sec?.name, academicYear: ctx.year?.name, enrolmentStatus: ctx.enrolment?.status || 'not_enrolled', scheduleAvailable: timetableRows.some((r) => !r.isBreak && !r.free) },
    cards: {
      attendance: att.workingDays ? att.percentage : null, pendingHomework: pending.length, completedExams: published.length, latestAverage: latest ? latest.percentage : null,
      latestExam: latest?.exam || null,
    },
    timetable: { rows: timetableRows, empty: !timetableRows.some((r) => !r.isBreak && !r.free) },
    attendance: { summary: att, calendar: calendarMonth },
    homework: hwAll.filter((h) => h.state !== 'overdue').slice(0, 10).map((h) => ({ _id: h._id, subject: h.subject, title: h.title, description: h.description, dueDate: h.dueDate, state: h.state, attachmentFiles: h.attachmentFiles })),
    fees: acct.charges.length ? { pending: acct.totals.pending, overdue: acct.totals.overdue, nextDue: acct.totals.nextDue } : null,
    toDo: { remarksToAcknowledge: pendingRemarks, unreadChats },
    library: { onLoan: loans.length, overdue: loans.filter((l) => l.dueDate < today).length },
    upcomingExam: next || null, latestResult: latest, announcements: anns, calendar: cal.slice(0, 8),
    activity: activity.map((n) => ({ id: n._id, at: n.createdAt, title: n.title, body: n.body, category: n.category, link: n.link, read: !!n.readAt })),
  };
}

/**
 * The academic years the student has been at this school, newest first, each with the class and section they were in. A student promoted to the next
 * class keeps everything of the earlier years (results, report cards) under that year, so this is how they find it.
 */
export async function myYears(ctx) {
  const enr = await StudentEnrolment.find({ tenantId: ctx.tenantId, studentId: ctx.student._id }).lean();
  const [years, classes, sections] = await Promise.all([
    AcademicYear.find({ tenantId: ctx.tenantId, _id: { $in: enr.map((e) => e.yearId) } }).select('name startDate isCurrent').lean(),
    ClassModel.find({ tenantId: ctx.tenantId, _id: { $in: enr.map((e) => e.classId) } }).select('name').lean(),
    Section.find({ tenantId: ctx.tenantId, _id: { $in: enr.map((e) => e.sectionId) } }).select('name').lean(),
  ]);
  const C = new Map(classes.map((x) => [String(x._id), x.name])); const S = new Map(sections.map((x) => [String(x._id), x.name]));
  return years.sort((a, b) => String(b.startDate).localeCompare(String(a.startDate))).map((y) => {
    const e = enr.filter((x) => String(x.yearId) === String(y._id)).sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)))[0];
    return { id: y._id, name: y.name, current: String(y._id) === String(ctx.year?._id) && !!y.isCurrent, className: C.get(String(e.classId)), section: S.get(String(e.sectionId)), status: e.status };
  });
}
