import {
  Examination, ExaminationSubject, MarksSheet, Marks, Section, Subject, ClassModel, TeachingAssignment,
} from '../../models/index.js';
import { notFound, conflict, bad, forbidden } from '../../core/utils.js';
import { registerStudents } from '../attendance/attendance.service.js';
import { normaliseMarks, completenessProblems, maxOf } from '../../services/results.js';
import { normaliseComponents } from '../../core/components.js';
import { notifyUsers, studentUserIdsInSections } from '../../services/notify.js';

const EDITABLE = [undefined, 'draft', 'returned'];

async function loadTarget(ctx, examSubjectId, sectionId) {
  const es = await ExaminationSubject.findOne({ _id: examSubjectId, tenantId: ctx.tenantId });
  if (!es) throw notFound('Exam subject not found');
  const [exam, section] = await Promise.all([Examination.findOne({ _id: es.examId, tenantId: ctx.tenantId }), Section.findOne({ _id: sectionId, tenantId: ctx.tenantId })]);
  if (!exam || exam.status === 'archived') throw notFound('Examination not available');
  if (!section) throw notFound('Section not found');
  if (String(section.classId) !== String(es.classId) || String(section.yearId) !== String(exam.yearId)) throw bad('This section does not sit that exam');
  if (exam.sectionId && String(exam.sectionId) !== String(section._id)) throw bad('This test belongs to a different section');
  if (ctx.role === 'teacher' && !ctx.scope.canMark(section._id, es.subjectId)) throw forbidden('You are not assigned to this subject in this section');
  return { es, exam, section };
}

/**
 * Teacher-facing exam list (Examinations + Marks entry are one screen):
 * exam subjects for the teacher's own subject/section assignments, including tests they created.
 */
export async function teacherExamList(ctx) {
  // the subject teacher's own pairs, plus (for a class teacher) every subject of their own class: they have full access to that class
  const ctSecs = ctx.scope.classTeacherSectionIds.length ? await Section.find({ tenantId: ctx.tenantId, _id: { $in: ctx.scope.classTeacherSectionIds } }).select('classId').lean() : [];
  const pairs = ctx.scope.assignments.map((a) => ({ sectionId: String(a.sectionId), subjectId: String(a.subjectId), classId: String(a.classId) }));
  const classIds = [...new Set([...pairs.map((p) => p.classId), ...ctSecs.map((s) => String(s.classId))])];
  if (!classIds.length) return [];
  const exams = await Examination.find({ tenantId: ctx.tenantId, yearId: ctx.year._id, status: { $ne: 'archived' } }).lean();
  const ess = await ExaminationSubject.find({ tenantId: ctx.tenantId, examId: { $in: exams.map((e) => e._id) }, classId: { $in: classIds } }).lean();
  for (const es of ess) for (const s of ctSecs) if (String(s.classId) === String(es.classId) && !pairs.some((p) => p.sectionId === String(s._id) && p.subjectId === String(es.subjectId))) pairs.push({ sectionId: String(s._id), subjectId: String(es.subjectId), classId: String(es.classId) });
  const sheets = await MarksSheet.find({ tenantId: ctx.tenantId, examSubjectId: { $in: ess.map((e) => e._id) } }).lean();
  const [subjects, sections, classes] = await Promise.all([
    Subject.find({ tenantId: ctx.tenantId, _id: { $in: pairs.map((p) => p.subjectId) } }).lean(), Section.find({ tenantId: ctx.tenantId, _id: { $in: pairs.map((p) => p.sectionId) } }).lean(),
    ClassModel.find({ tenantId: ctx.tenantId }).lean(),
  ]);
  const mk = (a) => new Map(a.map((x) => [String(x._id), x]));
  const E = mk(exams); const S = mk(subjects); const SEC = mk(sections); const C = mk(classes);
  const rows = [];
  for (const es of ess) {
    const exam = E.get(String(es.examId));
    for (const p of pairs.filter((x) => x.subjectId === String(es.subjectId) && x.classId === String(es.classId))) {
      if (exam.sectionId && String(exam.sectionId) !== p.sectionId) continue;
      const sheet = sheets.find((s) => String(s.examSubjectId) === String(es._id) && String(s.sectionId) === p.sectionId);
      const deadline = es.marksDeadline || exam.marksDeadline;
      const status = sheet?.status || 'not_started';
      rows.push({
        examId: exam._id, exam: exam.name, type: exam.type, examSubjectId: es._id, sectionId: p.sectionId, subject: S.get(p.subjectId)?.name, subjectId: p.subjectId,
        className: C.get(p.classId)?.name, section: SEC.get(p.sectionId)?.name, date: es.date, max: maxOf(es), components: es.components, passMarks: es.passMarks,
        deadline, status, returnReason: sheet?.returnReason, overdue: !!deadline && deadline < ctx.today && EDITABLE.includes(sheet?.status),
        viaClassTeacher: !ctx.scope.canTeach(p.sectionId, p.subjectId), createdByMe: !!exam.createdBy && String(exam.createdBy) === String(ctx.actorId), scoped: !!exam.sectionId, canDelete: !!exam.createdBy && String(exam.createdBy) === String(ctx.actorId) && !sheet,
      });
    }
  }
  return rows.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
}

// ── teacher-created tests (class test, surprise test, unit test …) ──
export async function createTeacherExam(ctx, body, byName) {
  if (!ctx.scope.canMark(body.sectionId, body.subjectId)) throw forbidden('You can add tests only for subjects you teach, or for any subject of the class you are the class teacher of');
  const section = await Section.findOne({ _id: body.sectionId, tenantId: ctx.tenantId });
  if (!section) throw notFound('Section not found');
  const components = normaliseComponents(body.components);
  const total = components.reduce((n, c) => n + c.max, 0);
  const passMarks = body.passMarks ?? Math.ceil((total * ctx.settings.grading.passPercentage) / 100);
  if (passMarks > total) throw bad('Pass marks cannot exceed the maximum marks');
  // a surprise test is not announced in advance unless the teacher chooses to
  const announce = body.notifyStudents ?? body.type !== 'surprise_test';
  let exam;
  try {
    exam = await Examination.create({
      tenantId: ctx.tenantId, yearId: section.yearId, name: body.name, type: body.type, classIds: [section.classId], sectionId: section._id, subjectId: body.subjectId,
      startDate: body.date, endDate: body.date, marksDeadline: body.marksDeadline, status: 'scheduled', schedulePublished: announce, createdBy: ctx.actorId, createdByName: byName,
    });
  } catch (e) {
    if (e.code === 11000) throw conflict(`You already have a test named "${body.name}" for this class and subject`);
    throw e;
  }
  const es = await ExaminationSubject.create({
    tenantId: ctx.tenantId, examId: exam._id, classId: section.classId, subjectId: body.subjectId, date: body.date, startTime: body.startTime, endTime: body.endTime, room: body.room, components, passMarks, marksDeadline: body.marksDeadline,
  });
  if (announce) {
    const ids = await studentUserIdsInSections(ctx.tenantId, [section._id]);
    await notifyUsers(ctx.tenantId, ids, { category: 'examination', title: `${body.name} scheduled`, body: `${body.date}`, link: { type: 'exam', id: String(exam._id) }, dedupeKey: `exs:${exam._id}` });
  }
  return { exam, examSubject: es };
}

async function ownTeacherExam(ctx, examId) {
  const exam = await Examination.findOne({ _id: examId, tenantId: ctx.tenantId });
  if (!exam) throw notFound('Examination not found');
  if (!exam.createdBy || String(exam.createdBy) !== String(ctx.actorId)) throw forbidden('You can change only tests you created');
  return exam;
}

export async function updateTeacherExam(ctx, examId, body) {
  const exam = await ownTeacherExam(ctx, examId);
  const es = await ExaminationSubject.findOne({ tenantId: ctx.tenantId, examId });
  const started = await MarksSheet.exists({ tenantId: ctx.tenantId, examId });
  if (started && body.components) throw conflict('Marks entry has started; the marks fields can no longer change');
  if (body.name) exam.name = body.name;
  if (body.date) { exam.startDate = body.date; exam.endDate = body.date; es.date = body.date; }
  if (body.marksDeadline) { exam.marksDeadline = body.marksDeadline; es.marksDeadline = body.marksDeadline; }
  if (body.components) es.components = normaliseComponents(body.components);
  if (body.passMarks !== undefined) es.passMarks = body.passMarks;
  if (es.passMarks > maxOf(es)) throw bad('Pass marks cannot exceed the maximum marks');
  try { await exam.save(); } catch (e) { if (e.code === 11000) throw conflict('You already have a test with that name'); throw e; }
  await es.save();
  return exam;
}

export async function deleteTeacherExam(ctx, examId) {
  const exam = await ownTeacherExam(ctx, examId);
  if (await MarksSheet.exists({ tenantId: ctx.tenantId, examId })) throw conflict('Marks have been entered for this test, so it can no longer be deleted');
  await ExaminationSubject.deleteMany({ tenantId: ctx.tenantId, examId });
  const { Notification } = await import('../../models/index.js');
  await Notification.deleteMany({ tenantId: ctx.tenantId, 'link.type': 'exam', 'link.id': String(exam._id) });
  await exam.deleteOne();
}

// ── marks sheet ──
export async function getSheet(ctx, { examSubjectId, sectionId }) {
  const { es, exam, section } = await loadTarget(ctx, examSubjectId, sectionId);
  const sheet = await MarksSheet.findOne({ tenantId: ctx.tenantId, examSubjectId, sectionId });
  const marks = sheet ? await Marks.find({ tenantId: ctx.tenantId, sheetId: sheet._id }).lean() : [];
  const mm = new Map(marks.map((m) => [String(m.studentId), m]));
  const list = await registerStudents(ctx.tenantId, sectionId, ctx.today);
  const subject = await Subject.findById(es.subjectId).select('name code');
  const students = list.map(({ enrolment, student }) => {
    const m = mm.get(String(student._id));
    return { studentId: student._id, name: student.name, admissionNo: student.admissionNo, rollNo: enrolment.rollNo, values: m?.values || {}, total: m?.total ?? null, absent: !!m?.absent, exempt: !!m?.exempt, remarks: m?.remarks || '' };
  });
  return {
    exam: { id: exam._id, name: exam.name, type: exam.type },
    examSubject: { id: es._id, subject: subject?.name, code: subject?.code, components: es.components, passMarks: es.passMarks, max: maxOf(es), date: es.date, deadline: es.marksDeadline || exam.marksDeadline },
    section: { id: section._id, name: section.name },
    status: sheet?.status || 'not_started', returnReason: sheet?.returnReason, revisions: (sheet?.revisions || []).map((r) => ({ version: r.version, submittedAt: r.submittedAt, returnedAt: r.returnedAt, returnReason: r.returnReason })),
    canEdit: EDITABLE.includes(sheet?.status), students,
  };
}

async function ensureSheet(ctx, es, section) {
  let sheet = await MarksSheet.findOne({ tenantId: ctx.tenantId, examSubjectId: es._id, sectionId: section._id });
  if (!sheet) {
    const asg = await TeachingAssignment.findOne({ tenantId: ctx.tenantId, sectionId: section._id, subjectId: es.subjectId, open: true });
    sheet = await MarksSheet.create({ tenantId: ctx.tenantId, examId: es.examId, examSubjectId: es._id, sectionId: section._id, teacherId: ctx.teacher?._id || asg?.teacherId, enteredByUserId: ctx.actorId, status: 'draft' });
  }
  if (!EDITABLE.includes(sheet.status)) throw conflict(`Marks are ${sheet.status.replace('_', ' ')} and can no longer be edited. ${sheet.status === 'published' ? 'Use a formal correction.' : ''}`.trim());
  return sheet;
}

export async function saveSheet(ctx, { examSubjectId, sectionId, marks }) {
  const { es, section } = await loadTarget(ctx, examSubjectId, sectionId);
  const sheet = await ensureSheet(ctx, es, section);
  const list = await registerStudents(ctx.tenantId, sectionId, ctx.today);
  const allowed = new Map(list.map((x) => [String(x.student._id), x]));
  const errors = [];
  const prepared = [];
  for (const m of marks) {
    const a = allowed.get(String(m.studentId));
    if (!a) { errors.push({ studentId: m.studentId, error: 'Student is not in this section' }); continue; }
    try { prepared.push({ a, data: normaliseMarks(es, m) }); } catch (e) { errors.push({ studentId: m.studentId, student: a.student.name, error: e.message }); }
  }
  if (errors.length) throw bad('Some marks are invalid', errors);
  if (prepared.length) {
    await Marks.bulkWrite(prepared.map(({ a, data }) => ({
      updateOne: {
        filter: { sheetId: sheet._id, studentId: a.student._id },
        update: { $set: { ...data, tenantId: ctx.tenantId, examId: es.examId, examSubjectId: es._id, sectionId, enrolmentId: a.enrolment._id } },
        upsert: true,
      },
    })));
  }
  sheet.enteredByUserId = ctx.actorId;
  if (!sheet.teacherId && ctx.teacher) sheet.teacherId = ctx.teacher._id;
  await sheet.save();
  return { saved: prepared.length, status: sheet.status, savedAt: new Date() };
}

export async function submitSheet(ctx, { examSubjectId, sectionId }) {
  const { es, section } = await loadTarget(ctx, examSubjectId, sectionId);
  const sheet = await ensureSheet(ctx, es, section);
  const list = await registerStudents(ctx.tenantId, sectionId, ctx.today);
  const marks = await Marks.find({ tenantId: ctx.tenantId, sheetId: sheet._id });
  const problems = completenessProblems(es, marks, list.map((x) => x.student));
  if (problems.length) throw bad('Marks are incomplete', problems.slice(0, 20));
  sheet.revisions.push({
    version: sheet.revisions.length + 1, submittedAt: new Date(),
    marks: marks.map((m) => ({ studentId: m.studentId, values: m.values, total: m.total, absent: m.absent, exempt: m.exempt })),
  });
  sheet.status = 'submitted'; sheet.submittedAt = new Date(); sheet.returnReason = undefined;
  await sheet.save();
  return sheet;
}

export async function importMarks(ctx, { examSubjectId, sectionId, rows, skipInvalid, dryRun }) {
  const { es, section } = await loadTarget(ctx, examSubjectId, sectionId);
  const list = await registerStudents(ctx.tenantId, sectionId, ctx.today);
  const byAdm = new Map(list.map((x) => [x.student.admissionNo, x])); const byRoll = new Map(list.map((x) => [x.enrolment.rollNo, x]));
  const valid = []; const errors = [];
  rows.forEach((row, i) => {
    const a = (row.admissionNo && byAdm.get(row.admissionNo)) || (row.rollNo && byRoll.get(row.rollNo));
    if (!a) { errors.push({ row: i + 1, error: 'Student not found (use admission number or roll number)' }); return; }
    try { valid.push({ studentId: a.student._id, ...normaliseMarks(es, row), name: a.student.name }); } catch (e) { errors.push({ row: i + 1, student: a.student.name, error: e.message }); }
  });
  if (errors.length && !skipInvalid) return { applied: 0, errors, valid: valid.length, dryRun: true };
  if (dryRun) return { applied: 0, errors, valid: valid.length, dryRun: true };
  if (valid.length) await ensureSheet(ctx, es, section); // checks editability
  const out = valid.length ? await saveSheet(ctx, { examSubjectId, sectionId, marks: valid.map(({ name: _n, total: _t, ...v }) => v) }) : { saved: 0 };
  return { applied: out.saved, errors, valid: valid.length };
}

export async function correctionRequests(ctx) {
  const sections = ctx.scope.assignments.map((a) => a.sectionId);
  const sheets = await MarksSheet.find({ tenantId: ctx.tenantId, sectionId: { $in: sections }, $or: [{ status: 'returned' }, { 'revisions.returnReason': { $exists: true } }] }).lean();
  const [ess, secs] = await Promise.all([ExaminationSubject.find({ _id: { $in: sheets.map((s) => s.examSubjectId) } }).populate('subjectId', 'name').populate('examId', 'name').lean(), Section.find({ _id: { $in: sheets.map((s) => s.sectionId) } }).lean()]);
  const E = new Map(ess.map((e) => [String(e._id), e])); const S = new Map(secs.map((s) => [String(s._id), s]));
  return sheets.filter((s) => ctx.scope.allAssignments.some((a) => String(a.sectionId) === String(s.sectionId) && String(a.subjectId) === String(E.get(String(s.examSubjectId))?.subjectId?._id)))
    .map((s) => ({ sheetId: s._id, exam: E.get(String(s.examSubjectId))?.examId?.name, subject: E.get(String(s.examSubjectId))?.subjectId?.name, section: S.get(String(s.sectionId))?.name, status: s.status, returnReason: s.returnReason, history: (s.revisions || []).filter((r) => r.returnReason).map((r) => ({ version: r.version, reason: r.returnReason, at: r.returnedAt })) }));
}
