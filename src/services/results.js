import {
  Marks, MarksSheet, ExaminationSubject, Subject, Teacher, ReportCard, ReportRemark, StudentEnrolment, Student,
} from '../models/index.js';
import { bad, round2, pct } from '../core/utils.js';
import { gradeFor } from './context.js';
import { totalMax } from '../core/components.js';
import { submittedRecords, summarize } from './attendance.js';

export const maxOf = (es) => totalMax(es?.components);

/**
 * Validate + normalise one student's marks against the exam subject's own fields.
 * input: { values: { <fieldKey>: number|null }, absent, exempt, remarks }
 */
export function normaliseMarks(es, input) {
  const out = { absent: !!input.absent, exempt: !!input.exempt, remarks: input.remarks ?? undefined };
  if (out.absent && out.exempt) throw bad('A student cannot be both absent and exempt');
  if (out.absent || out.exempt) return { ...out, values: {}, total: null };
  const given = input.values || {};
  const known = new Map((es.components || []).map((c) => [c.key, c]));
  for (const k of Object.keys(given)) if (!known.has(k)) throw bad(`"${k}" is not a marks field of this exam`);
  const values = {};
  let total = 0; let any = false;
  for (const c of es.components || []) {
    const v = given[c.key];
    if (v === undefined || v === null || v === '') { values[c.key] = null; continue; }
    const n = Number(v);
    if (!Number.isFinite(n)) throw bad(`${c.label} marks must be a number`);
    if (n < 0) throw bad(`${c.label} marks cannot be negative`);
    if (n > c.max) throw bad(`${c.label} marks cannot exceed ${c.max}`);
    values[c.key] = round2(n);
    total += n; any = true;
  }
  return { ...out, values, total: any ? round2(total) : null };
}

/** A sheet may be submitted only when every student has every field filled, or is absent/exempt. */
export function completenessProblems(es, marksDocs, students) {
  const byStudent = new Map(marksDocs.map((m) => [String(m.studentId), m]));
  const problems = [];
  for (const s of students) {
    const m = byStudent.get(String(s._id));
    if (!m) { problems.push(`${s.name}: no marks entered`); continue; }
    if (m.absent || m.exempt) continue;
    for (const c of es.components || []) {
      const v = m.values?.[c.key];
      if (v === null || v === undefined) problems.push(`${s.name}: ${c.label} marks missing`);
    }
  }
  return problems;
}

export async function buildSnapshot({ tenantId, exam, studentId, settings, classId }) {
  const [student, examSubjects] = await Promise.all([
    Student.findOne({ _id: studentId, tenantId }),
    ExaminationSubject.find({ tenantId, examId: exam._id, classId }),
  ]);
  const subjects = await Subject.find({ tenantId, _id: { $in: examSubjects.map((e) => e.subjectId) } });
  const subjectById = new Map(subjects.map((s) => [String(s._id), s]));
  const sheets = await MarksSheet.find({ tenantId, examId: exam._id, status: 'published' });
  const sheetById = new Map(sheets.map((s) => [String(s._id), s]));
  const marks = await Marks.find({ tenantId, examId: exam._id, studentId, sheetId: { $in: sheets.map((s) => s._id) } });
  const teachers = await Teacher.find({ tenantId, _id: { $in: sheets.map((s) => s.teacherId).filter(Boolean) } }).select('name');
  const teacherName = new Map(teachers.map((t) => [String(t._id), t.name]));

  const rows = [];
  let totalObtained = 0;
  let totalMax = 0;
  let allPass = true;
  for (const es of examSubjects.sort((a, b) => String(a.subjectId).localeCompare(String(b.subjectId)))) {
    const m = marks.find((x) => String(x.examSubjectId) === String(es._id));
    if (!m) continue;
    const sheet = sheetById.get(String(m.sheetId));
    const subj = subjectById.get(String(es.subjectId));
    const max = maxOf(es);
    const row = {
      subject: subj?.name, code: subj?.code,
      components: (es.components || []).map((c) => ({ key: c.key, label: c.label, max: c.max, value: m.absent || m.exempt ? null : m.values?.[c.key] ?? null })),
      obtained: m.total, max, absent: m.absent, exempt: m.exempt, remarks: m.remarks, teacher: teacherName.get(String(sheet?.teacherId)),
      percentage: null, grade: null, passed: true,
    };
    if (m.exempt) { row.grade = 'EX'; }
    else if (m.absent) { row.grade = 'AB'; row.passed = false; totalMax += max; allPass = false; }
    else {
      row.percentage = pct(m.total ?? 0, max);
      row.grade = gradeFor(row.percentage, settings.grading);
      row.passed = (m.total ?? 0) >= (es.passMarks ?? 0);
      totalObtained += m.total ?? 0;
      totalMax += max;
      if (!row.passed) allPass = false;
    }
    rows.push(row);
  }
  const percentage = pct(totalObtained, totalMax);
  const remark = await ReportRemark.findOne({ tenantId, examId: exam._id, studentId });
  const recs = await submittedRecords(tenantId, { studentId, yearId: exam.yearId });
  const att = summarize(recs, settings);
  return {
    exam: { id: exam._id, name: exam.name, type: exam.type }, student: { id: student._id, name: student.name, admissionNo: student.admissionNo },
    subjects: rows, totalObtained: round2(totalObtained), totalMax, percentage, grade: gradeFor(percentage, settings.grading),
    resultStatus: rows.length && allPass ? 'pass' : 'fail',
    attendance: { percentage: att.percentage, present: att.present, absent: att.absent, workingDays: att.workingDays },
    teacherRemark: remark?.teacherRemark || '', principalRemark: remark?.principalRemark || '',
  };
}

/**
 * Create the immutable published snapshot for every student with published marks in a section.
 * A correction creates version n+1 and retires the previous one, which stays on record.
 */
export async function generateReportCards({ tenantId, exam, sectionId, classId, settings, userId, studentIds, correctionReason }) {
  const sheets = await MarksSheet.find({ tenantId, examId: exam._id, sectionId, status: 'published' }).select('_id');
  const ids = studentIds || (await Marks.distinct('studentId', { tenantId, sheetId: { $in: sheets.map((s) => s._id) } }));
  let created = 0;
  for (const sid of ids) {
    const enrolment = await StudentEnrolment.findOne({ tenantId, studentId: sid, yearId: exam.yearId, sectionId }).sort({ createdAt: -1 });
    const snapshot = await buildSnapshot({ tenantId, exam, studentId: sid, settings, classId });
    const current = await ReportCard.findOne({ tenantId, examId: exam._id, studentId: sid, isCurrent: true });
    if (current && !correctionReason) continue;
    if (current) { current.isCurrent = false; await current.save(); }
    await ReportCard.create({
      tenantId, examId: exam._id, studentId: sid, enrolmentId: enrolment?._id, sectionId, classId, yearId: exam.yearId,
      version: (current?.version || 0) + 1, isCurrent: true, correctionReason, snapshot, publishedAt: new Date(), publishedBy: userId,
    });
    created++;
  }
  return created;
}
