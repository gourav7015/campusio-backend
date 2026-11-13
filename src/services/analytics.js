import { MarksSheet, Marks, ExaminationSubject, Examination, Subject, Student } from '../models/index.js';
import { round1 } from '../core/utils.js';
import { maxOf } from './results.js';
import { submittedRecords, summarize } from './attendance.js';

const mean = (a) => (a.length ? round1(a.reduce((x, y) => x + y, 0) / a.length) : null);
const BUCKETS = [[0, 39], [40, 49], [50, 59], [60, 69], [70, 79], [80, 89], [90, 100]];

/** Percentage rows for published marks limited to the given (section, subject) pairs. */
export async function publishedRows(ctx, pairs) {
  if (!pairs.length) return { rows: [], exams: [] };
  const exams = await Examination.find({ tenantId: ctx.tenantId, yearId: ctx.year._id }).sort({ startDate: 1, createdAt: 1 }).lean();
  const sheets = await MarksSheet.find({ tenantId: ctx.tenantId, status: 'published', examId: { $in: exams.map((e) => e._id) }, sectionId: { $in: pairs.map((p) => p.sectionId) } }).lean();
  const ess = await ExaminationSubject.find({ tenantId: ctx.tenantId, _id: { $in: sheets.map((s) => s.examSubjectId) } }).lean();
  const esMap = new Map(ess.map((e) => [String(e._id), e]));
  const okSheets = sheets.filter((s) => pairs.some((p) => String(p.sectionId) === String(s.sectionId) && String(p.subjectId) === String(esMap.get(String(s.examSubjectId))?.subjectId)));
  const marks = await Marks.find({ tenantId: ctx.tenantId, sheetId: { $in: okSheets.map((s) => s._id) }, absent: false, exempt: false, total: { $ne: null } }).lean();
  const sheetMap = new Map(okSheets.map((s) => [String(s._id), s]));
  const rows = marks.map((m) => {
    const es = esMap.get(String(m.examSubjectId));
    const max = maxOf(es);
    return { examId: String(m.examId), subjectId: String(es.subjectId), sectionId: String(m.sectionId), studentId: String(m.studentId), pct: max ? (m.total / max) * 100 : 0, sheet: sheetMap.get(String(m.sheetId)) };
  });
  return { rows, exams };
}

export async function teacherPerformance(ctx) {
  const pairs = ctx.scope.allAssignments.map((a) => ({ sectionId: a.sectionId, subjectId: a.subjectId }));
  const { rows, exams } = await publishedRows(ctx, pairs);
  const subjects = new Map((await Subject.find({ tenantId: ctx.tenantId }).select('name').lean()).map((s) => [String(s._id), s.name]));
  const en = new Map(exams.map((e) => [String(e._id), e]));
  const examIds = [...new Set(rows.map((r) => r.examId))].sort((a, b) => (en.get(a)?.startDate || '').localeCompare(en.get(b)?.startDate || ''));
  const averageByExam = examIds.map((id) => ({ exam: en.get(id)?.name, average: mean(rows.filter((r) => r.examId === id).map((r) => r.pct)) }));
  const distribution = BUCKETS.map(([lo, hi]) => ({ range: `${lo}-${hi}`, count: rows.filter((r) => r.pct >= lo && r.pct <= hi + 0.999).length }));
  const subjectIds = [...new Set(rows.map((r) => r.subjectId))];
  const subjectTrend = subjectIds.map((sid) => ({ subject: subjects.get(sid), points: examIds.map((id) => ({ exam: en.get(id)?.name, average: mean(rows.filter((r) => r.examId === id && r.subjectId === sid).map((r) => r.pct)) })).filter((p) => p.average != null) }));

  // per-student view (private to the teacher): average and attendance
  const byStudent = new Map();
  rows.forEach((r) => { if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, []); byStudent.get(r.studentId).push(r.pct); });
  const attendance = new Map();
  const ids = [...byStudent.keys()];
  const recs = ids.length ? await submittedRecords(ctx.tenantId, { studentId: { $in: ids }, yearId: ctx.year._id }) : [];
  const recBy = new Map();
  recs.forEach((r) => { const k = String(r.studentId); if (!recBy.has(k)) recBy.set(k, []); recBy.get(k).push(r); });
  recBy.forEach((v, k) => attendance.set(k, summarize(v, ctx.settings).percentage));
  const names = new Map((await Student.find({ tenantId: ctx.tenantId, _id: { $in: ids } }).select('name').lean()).map((s) => [String(s._id), s.name]));
  const students = ids.map((id) => ({ studentId: id, name: names.get(id), average: mean(byStudent.get(id)), attendance: attendance.get(id) ?? null }));
  const pass = ctx.settings.grading.passPercentage;
  return {
    averageByExam, distribution, subjectTrend,
    attendanceVsPerformance: ctx.settings.showAttendanceVsPerformance ? students.filter((s) => s.attendance != null).map((s) => ({ attendance: s.attendance, average: s.average })) : null,
    needsAttention: students.filter((s) => (s.average != null && s.average < pass + 10) || (s.attendance != null && s.attendance < 75)).sort((a, b) => (a.average ?? 0) - (b.average ?? 0)).slice(0, 15),
    sampleSize: rows.length,
  };
}
