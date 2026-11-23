import { rollStatus } from '../../services/context.js';
import {
  Student, Teacher, Section, ClassModel, Subscription, LeaveApplication, Message, AuditLog, Examination, MarksSheet, TimetableEntry, StudentEnrolment, ReportCard,
  Homework, Announcement, Subject, File, AttendanceSession, AttendanceRecord,
} from '../../models/index.js';
import { escapeRegex, notFound, toCsv } from '../../core/utils.js';
import { listAuditEntries, auditFacets } from '../../services/auditQuery.js';
import { overview, trend } from '../attendance/attendance.service.js';
import { summarizeCounts, sessionCounts, zeroCounts, addCounts } from '../../services/attendance.js';
import { removeFileBytes } from '../../services/files.js';
import { financeSummary } from '../finance/finance.service.js';
import { coverageSummary } from '../structure/class-structure.service.js';
import { LibraryIssue, BookCopy } from '../../models/index.js';

export async function dashboard(ctx) {
  const { tenantId, year, today } = ctx;
  const [students, teachers, sections, sub, pendingLeave, unreadMessages, unresolved, exams, sheets, recent, att, trendRows, openQueries] = await Promise.all([
    Student.countDocuments({ tenantId, status: 'active' }), Teacher.countDocuments({ tenantId, status: 'active' }), Section.countDocuments({ tenantId, yearId: year?._id, status: 'active' }),
    Subscription.findOne({ schoolId: tenantId }), LeaveApplication.countDocuments({ tenantId, status: 'submitted' }), Message.countDocuments({ tenantId, status: 'delivered' }),
    TimetableEntry.countDocuments({ tenantId, unresolved: true }), Examination.find({ tenantId, yearId: year?._id }).lean(), MarksSheet.aggregate([{ $match: { tenantId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    AuditLog.find({ tenantId }).sort({ createdAt: -1 }).limit(10).lean(), overview(ctx, today),
    trend(ctx, (await Section.find({ tenantId, yearId: year?._id }).select('_id')).map((s) => s._id), 14),
    (await import('../../models/index.js')).AttendanceQuery.countDocuments({ tenantId, status: 'open' }),
  ]);
  const sheetStatus = Object.fromEntries(sheets.map((s) => [s._id, s.n]));
  const [finance, onLoan, overdueLoans] = await Promise.all([financeSummary(ctx), BookCopy.countDocuments({ tenantId, status: 'issued' }), LibraryIssue.countDocuments({ tenantId, status: 'issued', dueDate: { $lt: today } })]);
  const coverage = await coverageSummary(tenantId, year?._id); // classes with no class teacher, subjects with no teacher, classes with no subjects
  return {
    year: year && { id: year._id, name: year.name }, today, coverage,
    cards: { students, teachers, sections, pendingLeave, unreadMessages, unresolvedPeriods: unresolved, openAttendanceQueries: openQueries },
    subscription: sub && { plan: sub.plan, status: sub.status, expiresOn: sub.expiresOn, studentsUsed: students, teachersUsed: teachers },
    finance, library: { onLoan, overdue: overdueLoans },
    attendance: att.totals, attendanceTrend: trendRows.map((t) => ({ date: t.date, percentage: t.percentage })),
    exams: { total: exams.length, awaitingReview: (sheetStatus.submitted || 0) + (sheetStatus.under_review || 0), approved: sheetStatus.approved || 0, published: sheetStatus.published || 0, returned: sheetStatus.returned || 0 },
    recent: recent.map((l) => ({ id: l._id, at: l.createdAt, actor: l.actorName, role: l.actorRole, actingAsSuperAdmin: l.actingAsSuperAdmin, action: l.action, summary: l.summary })),
  };
}

export const listAudit = (ctx, q) => listAuditEntries({ tenantId: ctx.tenantId }, q, ctx.settings?.timezone);
export const auditSummary = (ctx, q) => auditFacets({ tenantId: ctx.tenantId }, q, ctx.settings?.timezone);

export async function search(ctx, q) {
  if (!q || q.length < 2) return {};
  const rx = new RegExp(escapeRegex(q), 'i');
  const t = ctx.tenantId;
  const [students, teachers, classes, subjects, exams, homework, announcements] = await Promise.all([
    Student.find({ tenantId: t, $or: [{ name: rx }, { admissionNo: rx }] }).select('name admissionNo status').limit(6).lean(),
    Teacher.find({ tenantId: t, $or: [{ name: rx }, { employeeId: rx }] }).select('name employeeId status').limit(6).lean(),
    ClassModel.find({ tenantId: t, name: rx }).select('name').limit(5).lean(), Subject.find({ tenantId: t, $or: [{ name: rx }, { code: rx }] }).select('name code').limit(5).lean(),
    Examination.find({ tenantId: t, name: rx }).select('name').limit(5).lean(), Homework.find({ tenantId: t, title: rx }).select('title dueDate').limit(5).lean(),
    Announcement.find({ tenantId: t, title: rx }).select('title').limit(5).lean(),
  ]);
  return { students, teachers, classes, subjects, exams, homework, announcements };
}

// ── exports: admin-only, same data the screens show ──
export async function exportStudents(ctx) {
  // every student, not one page: page through the list so a 2,500-student school exports completely
  const { listStudents } = await import('../students/students.service.js');
  const items = [];
  for (let page = 1; ; page++) {
    const out = await listStudents(ctx.tenantId, { page, limit: 200, status: undefined });
    items.push(...out.items);
    if (items.length >= out.total || !out.items.length) break;
  }
  return toCsv(items, [
    { label: 'Admission No', get: (r) => r.admissionNo }, { label: 'Name', get: (r) => r.name }, { label: 'Class', get: (r) => r.enrolment?.className }, { label: 'Section', get: (r) => r.enrolment?.section },
    { label: 'Roll No', get: (r) => r.enrolment?.rollNo }, { label: 'DOB', get: (r) => r.dob }, { label: 'Gender', get: (r) => r.gender }, { label: 'Guardian', get: (r) => r.guardians?.[0]?.name }, { label: 'Guardian Phone', get: (r) => r.guardians?.[0]?.phone }, { label: 'Status', get: (r) => r.status },
  ]);
}
export async function exportTeachers(ctx) {
  const rows = await Teacher.find({ tenantId: ctx.tenantId }).sort({ name: 1 }).lean();
  return toCsv(rows, [{ label: 'Employee Id', get: (r) => r.employeeId }, { label: 'Name', get: (r) => r.name }, { label: 'Email', get: (r) => r.email }, { label: 'Phone', get: (r) => r.phone }, { label: 'Designation', get: (r) => r.designation }, { label: 'Status', get: (r) => r.status }]);
}
export async function exportAttendance(ctx, { sectionId, from, to }) {
  const sessions = await AttendanceSession.find({ tenantId: ctx.tenantId, sectionId, status: 'submitted', ...(from || to ? { date: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {}) }).lean();
  const recs = await AttendanceRecord.find({ sessionId: { $in: sessions.map((s) => s._id) } }).populate('studentId', 'name admissionNo').lean();
  return toCsv(recs.sort((a, b) => a.date.localeCompare(b.date)), [{ label: 'Date', get: (r) => r.date }, { label: 'Admission No', get: (r) => r.studentId?.admissionNo }, { label: 'Student', get: (r) => r.studentId?.name }, { label: 'Status', get: (r) => r.status }, { label: 'Remarks', get: (r) => r.remarks }]);
}
export async function exportResults(ctx, examId) {
  const cards = await ReportCard.find({ tenantId: ctx.tenantId, examId, isCurrent: true }).lean();
  return toCsv(cards, [{ label: 'Admission No', get: (r) => r.snapshot.student.admissionNo }, { label: 'Student', get: (r) => r.snapshot.student.name }, { label: 'Total', get: (r) => r.snapshot.totalObtained }, { label: 'Max', get: (r) => r.snapshot.totalMax }, { label: 'Percentage', get: (r) => r.snapshot.percentage }, { label: 'Grade', get: (r) => r.snapshot.grade }, { label: 'Result', get: (r) => r.snapshot.resultStatus }, { label: 'Version', get: (r) => r.version }]);
}

export async function reportsSummary(ctx) {
  const { tenantId, year } = ctx;
  const [sections, classes, strength] = await Promise.all([
    Section.find({ tenantId, yearId: year?._id, status: 'active' }).lean(), ClassModel.find({ tenantId }).lean(),
    StudentEnrolment.aggregate([{ $match: { tenantId, yearId: year?._id, status: rollStatus(year) } }, { $group: { _id: '$sectionId', n: { $sum: 1 } } }]),
  ]);
  const cm = new Map(classes.map((c) => [String(c._id), c.name])); const sm = new Map(strength.map((s) => [String(s._id), s.n]));
  const regs = await sessionCounts(tenantId, { yearId: year?._id });
  const bySection = new Map();
  for (const r of regs) { if (!bySection.has(r.sectionId)) bySection.set(r.sectionId, { counts: zeroCounts(), registers: 0 }); const e = bySection.get(r.sectionId); addCounts(e.counts, r.counts); e.registers += 1; }
  const cardAgg = await ReportCard.aggregate([{ $match: { tenantId, yearId: year?._id, isCurrent: true } }, { $group: { _id: { c: '$classId', e: '$examId' }, n: { $sum: 1 }, sum: { $sum: { $ifNull: ['$snapshot.percentage', 0] } } } }]);
  const byClassExam = new Map(cardAgg.map((a) => [`${a._id.c}|${a._id.e}`, { n: a.n, sum: a.sum }]));
  const exams = new Map((await Examination.find({ tenantId, yearId: year?._id }).select('name').lean()).map((e) => [String(e._id), e.name]));
  return {
    strength: sections.map((s) => ({ className: cm.get(String(s.classId)), section: s.name, students: sm.get(String(s._id)) || 0, capacity: s.capacity })).sort((a, b) => `${a.className}${a.section}`.localeCompare(`${b.className}${b.section}`, undefined, { numeric: true })),
    attendance: sections.map((s) => ({ className: cm.get(String(s.classId)), section: s.name, percentage: summarizeCounts(bySection.get(String(s._id))?.counts || zeroCounts(), ctx.settings).percentage, days: bySection.get(String(s._id))?.registers || 0 })),
    results: [...byClassExam].map(([k, v]) => { const [cid, eid] = k.split('|'); return { className: cm.get(cid), exam: exams.get(eid), students: v.n, average: v.n ? Math.round((v.sum / v.n) * 10) / 10 : null }; }),
  };
}

// ── documents (student/teacher) ──
export async function listDocuments(ctx, ownerType, ownerId) {
  const files = await File.find({ tenantId: ctx.tenantId, kind: 'document', ownerType, ownerId }).sort({ createdAt: -1 }).lean();
  return files.map((f) => ({ id: f._id, name: f.originalName, type: f.docType, size: f.size, uploadedAt: f.createdAt }));
}
export async function ownerExists(ctx, ownerType, ownerId) {
  const Model = ownerType === 'student' ? Student : Teacher;
  const o = await Model.findOne({ _id: ownerId, tenantId: ctx.tenantId });
  if (!o) throw notFound(`${ownerType} not found`);
  return o;
}
export async function deleteDocument(ctx, id) {
  const f = await File.findOne({ _id: id, tenantId: ctx.tenantId, kind: { $in: ['document', 'photo'] } });
  if (!f) throw notFound('Document not found');
  await removeFileBytes(f);
  await f.deleteOne();
}
