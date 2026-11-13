import {
  Examination, ExaminationSubject, MarksSheet, Marks, Section, ClassModel, Subject, SubjectOffering, AcademicYear, ReportCard, ReportRemark, Teacher, Student,
} from '../../models/index.js';
import { notFound, conflict, bad } from '../../core/utils.js';
import { notifyUsers, studentUserIdsInSections } from '../../services/notify.js';
import { generateReportCards, normaliseMarks, maxOf, buildSnapshot } from '../../services/results.js';
import { DEFAULT_COMPONENTS, normaliseComponents, sameComponents } from '../../core/components.js';

const owned = async (Model, tenantId, id, label) => {
  const d = await Model.findOne({ _id: id, tenantId });
  if (!d) throw notFound(`${label} not found`);
  return d;
};

export async function listExams(ctx) {
  const exams = await Examination.find({ tenantId: ctx.tenantId, yearId: ctx.year?._id }).sort({ startDate: -1, createdAt: -1 }).lean();
  const [subs, sheets, classes] = await Promise.all([
    ExaminationSubject.aggregate([{ $match: { tenantId: ctx.tenantId, examId: { $in: exams.map((e) => e._id) } } }, { $group: { _id: '$examId', n: { $sum: 1 } } }]),
    MarksSheet.aggregate([{ $match: { tenantId: ctx.tenantId, examId: { $in: exams.map((e) => e._id) } } }, { $group: { _id: { e: '$examId', s: '$status' }, n: { $sum: 1 } } }]),
    ClassModel.find({ tenantId: ctx.tenantId }).lean(),
  ]);
  const sm = new Map(subs.map((s) => [String(s._id), s.n])); const cm = new Map(classes.map((c) => [String(c._id), c.name]));
  return exams.map((e) => {
    const st = {};
    sheets.filter((x) => String(x._id.e) === String(e._id)).forEach((x) => { st[x._id.s] = x.n; });
    return { ...e, subjectCount: sm.get(String(e._id)) || 0, sheetStatus: st, classNames: e.classIds.map((c) => cm.get(String(c))) };
  });
}

export async function createExam(ctx, body) {
  const year = body.yearId ? await owned(AcademicYear, ctx.tenantId, body.yearId, 'Academic year') : ctx.year;
  if (!year) throw bad('Create an academic year first');
  const classes = await ClassModel.find({ tenantId: ctx.tenantId, _id: { $in: body.classIds } }).select('_id');
  if (classes.length !== new Set(body.classIds).size) throw notFound('One or more classes were not found');
  return Examination.create({ ...body, tenantId: ctx.tenantId, yearId: year._id });
}
export async function updateExam(ctx, id, body) {
  const e = await owned(Examination, ctx.tenantId, id, 'Examination');
  if (body.classIds) {
    const removed = e.classIds.filter((c) => !body.classIds.includes(String(c)));
    if (removed.length && (await ExaminationSubject.exists({ tenantId: ctx.tenantId, examId: e._id, classId: { $in: removed } }))) {
      throw conflict('Remove the exam subjects of that class first');
    }
  }
  Object.assign(e, body);
  return e.save();
}
export async function deleteExam(ctx, id) {
  const e = await owned(Examination, ctx.tenantId, id, 'Examination');
  if (await MarksSheet.exists({ tenantId: ctx.tenantId, examId: e._id })) throw conflict('Marks have been entered for this exam. Archive it instead.');
  await ExaminationSubject.deleteMany({ tenantId: ctx.tenantId, examId: e._id });
  await e.deleteOne();
}

export async function getExam(ctx, id) {
  const e = await owned(Examination, ctx.tenantId, id, 'Examination');
  const [subjects, sheets, sections, subjectDocs, classes] = await Promise.all([
    ExaminationSubject.find({ tenantId: ctx.tenantId, examId: e._id }).sort({ date: 1, startTime: 1 }).lean(),
    MarksSheet.find({ tenantId: ctx.tenantId, examId: e._id }).lean(),
    Section.find({ tenantId: ctx.tenantId, yearId: e.yearId, classId: { $in: e.classIds }, status: 'active' }).lean(),
    Subject.find({ tenantId: ctx.tenantId }).select('name code').lean(), ClassModel.find({ tenantId: ctx.tenantId, _id: { $in: e.classIds } }).lean(),
  ]);
  const S = new Map(subjectDocs.map((s) => [String(s._id), s])); const C = new Map(classes.map((c) => [String(c._id), c]));
  return {
    ...e.toObject(),
    subjects: subjects.map((x) => ({ ...x, subject: S.get(String(x.subjectId))?.name, code: S.get(String(x.subjectId))?.code, className: C.get(String(x.classId))?.name, max: maxOf(x) })),
    sections: sections.map((s) => ({ id: s._id, name: s.name, classId: s.classId, className: C.get(String(s.classId))?.name })),
    sheets: sheets.map((s) => ({ id: s._id, examSubjectId: s.examSubjectId, sectionId: s.sectionId, status: s.status })),
  };
}

const overlaps = (a, b) => a.startTime < b.endTime && b.startTime < a.endTime;

export async function upsertExamSubject(ctx, examId, body) {
  const exam = await owned(Examination, ctx.tenantId, examId, 'Examination');
  if (!exam.classIds.map(String).includes(String(body.classId))) throw bad('That class is not part of this examination');
  const offering = await SubjectOffering.findOne({ tenantId: ctx.tenantId, yearId: exam.yearId, classId: body.classId, subjectId: body.subjectId });
  if (!offering) throw bad('That subject is not offered to the class in this academic year');
  const year = await AcademicYear.findById(exam.yearId);
  if (body.date && (body.date < year.startDate || body.date > year.endDate)) throw bad('The exam date is outside the academic year');
  const existing = await ExaminationSubject.findOne({ tenantId: ctx.tenantId, examId, classId: body.classId, subjectId: body.subjectId });
  const components = body.components ? normaliseComponents(body.components) : (existing?.components?.length ? existing.components.map((c) => c.toObject()) : (offering.assessment.components?.length ? offering.assessment.components.map((c) => ({ key: c.key, label: c.label, max: c.max })) : DEFAULT_COMPONENTS));
  const merged = { passMarks: existing?.passMarks ?? offering.assessment.passMarks, ...body, components };
  if (merged.passMarks > maxOf(merged)) throw bad('Pass marks cannot exceed the maximum marks');
  if (maxOf(merged) <= 0) throw bad('Maximum marks must be greater than zero');
  if (existing && body.components && !sameComponents(existing.components, components) && (await MarksSheet.exists({ tenantId: ctx.tenantId, examSubjectId: existing._id }))) {
    throw conflict('Marks entry has started; the marks fields can no longer change');
  }
  if (merged.date && merged.startTime && merged.endTime) {
    const sameDay = await ExaminationSubject.find({ tenantId: ctx.tenantId, examId, date: merged.date, ...(existing ? { _id: { $ne: existing._id } } : {}) }).lean();
    for (const o of sameDay) {
      if (!o.startTime || !o.endTime || !overlaps(merged, o)) continue;
      if (String(o.classId) === String(merged.classId)) throw conflict('This class already has an exam at that time', { type: 'class' });
      if (merged.room && o.room === merged.room) throw conflict(`Room ${merged.room} is already used at that time`, { type: 'room' });
    }
  }
  const doc = existing || new ExaminationSubject({ tenantId: ctx.tenantId, examId, classId: body.classId, subjectId: body.subjectId });
  Object.assign(doc, merged);
  return doc.save();
}

export async function generateSubjects(ctx, examId) {
  const exam = await owned(Examination, ctx.tenantId, examId, 'Examination');
  const offerings = await SubjectOffering.find({ tenantId: ctx.tenantId, yearId: exam.yearId, classId: { $in: exam.classIds } });
  let created = 0;
  for (const o of offerings) {
    if (await ExaminationSubject.exists({ tenantId: ctx.tenantId, examId, classId: o.classId, subjectId: o.subjectId })) continue;
    await ExaminationSubject.create({
      tenantId: ctx.tenantId, examId, classId: o.classId, subjectId: o.subjectId, passMarks: o.assessment.passMarks,
      components: o.assessment.components?.length ? o.assessment.components.map((c) => ({ key: c.key, label: c.label, max: c.max })) : DEFAULT_COMPONENTS,
    });
    created++;
  }
  return { created };
}
export async function deleteExamSubject(ctx, examId, esId) {
  const es = await owned(ExaminationSubject, ctx.tenantId, esId, 'Exam subject');
  if (String(es.examId) !== String(examId)) throw notFound('Exam subject not found');
  if (await MarksSheet.exists({ tenantId: ctx.tenantId, examSubjectId: es._id })) throw conflict('Marks entry has started for this subject');
  await es.deleteOne();
}

export async function publishSchedule(ctx, examId) {
  const exam = await owned(Examination, ctx.tenantId, examId, 'Examination');
  const subs = await ExaminationSubject.find({ tenantId: ctx.tenantId, examId });
  if (!subs.length) throw bad('Add exam subjects before publishing the schedule');
  const undated = subs.filter((s) => !s.date);
  if (undated.length) throw bad(`${undated.length} exam subject(s) have no date yet`);
  exam.schedulePublished = true; exam.status = 'scheduled';
  await exam.save();
  const sections = await Section.find({ tenantId: ctx.tenantId, yearId: exam.yearId, classId: { $in: exam.classIds } }).select('_id');
  const ids = await studentUserIdsInSections(ctx.tenantId, sections.map((s) => s._id));
  await notifyUsers(ctx.tenantId, ids, { category: 'examination', title: `${exam.name} schedule published`, body: 'Check your examination dates.', link: { type: 'exam', id: String(exam._id) }, dedupeKey: `exs:${exam._id}` });
  return exam;
}

// ── review workflow ──
export async function listSheets(ctx, examId) {
  const sheets = await MarksSheet.find({ tenantId: ctx.tenantId, examId }).lean();
  const [subs, sections, teachers, counts] = await Promise.all([
    ExaminationSubject.find({ tenantId: ctx.tenantId, examId }).populate('subjectId', 'name').lean(),
    Section.find({ tenantId: ctx.tenantId, _id: { $in: sheets.map((s) => s.sectionId) } }).populate('classId', 'name').lean(),
    Teacher.find({ tenantId: ctx.tenantId, _id: { $in: sheets.map((s) => s.teacherId).filter(Boolean) } }).select('name').lean(),
    Marks.aggregate([{ $match: { tenantId: ctx.tenantId, sheetId: { $in: sheets.map((s) => s._id) } } }, { $group: { _id: '$sheetId', n: { $sum: 1 } } }]),
  ]);
  const mk = (a) => new Map(a.map((x) => [String(x._id), x]));
  const ES = mk(subs); const SEC = mk(sections); const T = mk(teachers); const CN = new Map(counts.map((c) => [String(c._id), c.n]));
  return sheets.map((s) => ({
    ...s, subject: ES.get(String(s.examSubjectId))?.subjectId?.name, max: maxOf(ES.get(String(s.examSubjectId)) || {}),
    section: `${SEC.get(String(s.sectionId))?.classId?.name || ''} ${SEC.get(String(s.sectionId))?.name || ''}`.trim(), teacher: T.get(String(s.teacherId))?.name, entries: CN.get(String(s._id)) || 0,
  }));
}

export async function getSheetForReview(ctx, sheetId) {
  const sheet = await owned(MarksSheet, ctx.tenantId, sheetId, 'Marks sheet');
  const [es, marks, section] = await Promise.all([
    ExaminationSubject.findById(sheet.examSubjectId).populate('subjectId', 'name').lean(),
    Marks.find({ tenantId: ctx.tenantId, sheetId }).lean(), Section.findById(sheet.sectionId).populate('classId', 'name').lean(),
  ]);
  const students = await Student.find({ tenantId: ctx.tenantId, _id: { $in: marks.map((m) => m.studentId) } }).select('name admissionNo').lean();
  const sm = new Map(students.map((s) => [String(s._id), s]));
  return {
    sheet, examSubject: { ...es, subject: es?.subjectId?.name, max: maxOf(es) }, section: { name: section?.name, className: section?.classId?.name },
    rows: marks.map((m) => ({ ...m, student: sm.get(String(m.studentId))?.name, admissionNo: sm.get(String(m.studentId))?.admissionNo })).sort((a, b) => String(a.student).localeCompare(String(b.student))),
  };
}

async function transition(ctx, sheetId, from, to, patch = {}) {
  const sheet = await owned(MarksSheet, ctx.tenantId, sheetId, 'Marks sheet');
  if (!from.includes(sheet.status)) throw conflict(`A sheet that is "${sheet.status}" cannot move to "${to}"`);
  sheet.status = to; sheet.reviewedBy = ctx.actorId; sheet.reviewedAt = new Date();
  Object.assign(sheet, patch);
  await sheet.save();
  return sheet;
}
export const startReview = (ctx, id) => transition(ctx, id, ['submitted'], 'under_review');
export const approveSheet = (ctx, id) => transition(ctx, id, ['submitted', 'under_review'], 'approved', { returnReason: undefined });
export async function returnSheet(ctx, id, reason) {
  const sheet = await transition(ctx, id, ['submitted', 'under_review'], 'returned', { returnReason: reason });
  const last = sheet.revisions[sheet.revisions.length - 1];
  if (last) { last.returnedAt = new Date(); last.returnReason = reason; last.returnedBy = ctx.actorId; sheet.markModified('revisions'); await sheet.save(); }
  const t = await Teacher.findById(sheet.teacherId).select('userId');
  await notifyUsers(ctx.tenantId, [t?.userId], { category: 'examination', title: 'Marks returned for correction', body: reason, link: { type: 'marks', id: String(sheet._id) }, dedupeKey: `ret:${sheet._id}:${sheet.revisions.length}` });
  return sheet;
}

/** Publish an exam per section once every expected sheet is approved. */
export async function publishExam(ctx, examId, { sectionId, all }) {
  const exam = await owned(Examination, ctx.tenantId, examId, 'Examination');
  const filter = { tenantId: ctx.tenantId, yearId: exam.yearId, classId: { $in: exam.classIds }, status: 'active' };
  if (exam.sectionId) filter._id = exam.sectionId; // a teacher's class test belongs to exactly one section
  else if (sectionId) filter._id = sectionId; else if (!all) throw bad('Choose a section or publish all');
  const sections = await Section.find(filter).populate('classId', 'name');
  if (!sections.length) throw notFound('No matching sections');
  const { settings } = ctx;
  const published = []; const skipped = [];
  for (const sec of sections) {
    const label = `${sec.classId.name} ${sec.name}`;
    const expected = await ExaminationSubject.find({ tenantId: ctx.tenantId, examId, classId: sec.classId._id });
    if (!expected.length) { skipped.push({ section: label, reason: 'No exam subjects configured' }); continue; }
    const sheets = await MarksSheet.find({ tenantId: ctx.tenantId, examId, sectionId: sec._id });
    const sm = new Map(sheets.map((s) => [String(s.examSubjectId), s]));
    const missing = expected.filter((es) => !sm.has(String(es._id)));
    const notApproved = sheets.filter((s) => !['approved', 'published'].includes(s.status));
    if (missing.length) { skipped.push({ section: label, reason: `${missing.length} subject(s) have no marks yet` }); continue; }
    if (notApproved.length) { skipped.push({ section: label, reason: `${notApproved.length} sheet(s) are not approved` }); continue; }
    for (const s of sheets.filter((x) => x.status === 'approved')) { s.status = 'published'; s.publishedAt = new Date(); await s.save(); }
    const n = await generateReportCards({ tenantId: ctx.tenantId, exam, sectionId: sec._id, classId: sec.classId._id, settings, userId: ctx.actorId });
    const ids = await studentUserIdsInSections(ctx.tenantId, [sec._id]);
    await notifyUsers(ctx.tenantId, ids, { category: 'results', title: `${exam.name} results published`, body: 'Your report card is ready.', link: { type: 'result', id: String(exam._id) }, dedupeKey: `res:${exam._id}` });
    published.push({ section: label, reportCards: n });
  }
  return { published, skipped };
}

/** Formal correction of a published mark: history is kept and a new report-card version replaces the current one. */
export async function correctPublishedMark(ctx, marksId, body, byName) {
  const m = await owned(Marks, ctx.tenantId, marksId, 'Marks');
  const sheet = await MarksSheet.findById(m.sheetId);
  if (sheet.status !== 'published') throw conflict('Only published marks need a formal correction; edit the sheet instead');
  const es = await ExaminationSubject.findById(m.examSubjectId);
  const { reason, ...input } = body;
  const snap = (x) => ({ values: { ...(x.values || {}) }, total: x.total, absent: x.absent, exempt: x.exempt });
  const before = snap(m);
  const next = normaliseMarks(es, { values: { ...(m.values || {}), ...(input.values || {}) }, absent: input.absent ?? m.absent, exempt: input.exempt ?? m.exempt, remarks: m.remarks });
  Object.assign(m, next);
  m.markModified('values');
  m.history.push({ by: ctx.actorId, byName, reason, before, after: snap(m) });
  await m.save();
  const exam = await Examination.findById(m.examId);
  const section = await Section.findById(m.sectionId);
  await generateReportCards({ tenantId: ctx.tenantId, exam, sectionId: m.sectionId, classId: section.classId, settings: ctx.settings, userId: ctx.actorId, studentIds: [m.studentId], correctionReason: reason });
  const stu = await Student.findById(m.studentId).select('userId');
  await notifyUsers(ctx.tenantId, [stu?.userId], { category: 'results', title: 'Result corrected', body: `${exam.name}: ${reason}`, link: { type: 'result', id: String(exam._id) }, dedupeKey: `resc:${m._id}:${m.history.length}` });
  return m;
}

export async function saveRemark(ctx, examId, { studentId, teacherRemark, principalRemark }) {
  const exam = await owned(Examination, ctx.tenantId, examId, 'Examination');
  const stu = await owned(Student, ctx.tenantId, studentId, 'Student');
  const upd = {};
  if (teacherRemark !== undefined) upd.teacherRemark = teacherRemark;
  if (principalRemark !== undefined) upd.principalRemark = principalRemark;
  const remark = await ReportRemark.findOneAndUpdate({ tenantId: ctx.tenantId, examId, studentId }, { $set: upd }, { upsert: true, new: true });
  const current = await ReportCard.findOne({ tenantId: ctx.tenantId, examId, studentId, isCurrent: true });
  if (current) {
    await generateReportCards({ tenantId: ctx.tenantId, exam, sectionId: current.sectionId, classId: current.classId, settings: ctx.settings, userId: ctx.actorId, studentIds: [stu._id], correctionReason: 'Remarks updated' });
  }
  return remark;
}

export async function examResults(ctx, examId, { sectionId }) {
  const f = { tenantId: ctx.tenantId, examId, isCurrent: true };
  if (sectionId) f.sectionId = sectionId;
  const cards = await ReportCard.find(f).lean();
  return cards.map((c) => ({ id: c._id, studentId: c.studentId, version: c.version, publishedAt: c.publishedAt, ...pickSummary(c.snapshot) })).sort((a, b) => String(a.student).localeCompare(String(b.student)));
}
const pickSummary = (s) => ({ student: s.student.name, admissionNo: s.student.admissionNo, percentage: s.percentage, grade: s.grade, resultStatus: s.resultStatus, totalObtained: s.totalObtained, totalMax: s.totalMax });
export async function reportCardOf(ctx, cardId) {
  const c = await owned(ReportCard, ctx.tenantId, cardId, 'Report card');
  const versions = await ReportCard.find({ tenantId: ctx.tenantId, examId: c.examId, studentId: c.studentId }).select('version isCurrent correctionReason publishedAt').sort({ version: -1 }).lean();
  return { ...c.toObject(), versions };
}
export { buildSnapshot };
