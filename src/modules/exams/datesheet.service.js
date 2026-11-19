import { Examination, ExaminationSubject, ClassModel, Subject, SubjectOffering, AcademicYear, MarksSheet } from '../../models/index.js';
import { notFound, bad, conflict, addDays } from '../../core/utils.js';
import { findOrCreateSubject, ensureOffering } from '../../services/subjects.js';
import { upsertExamSubject } from './exams.service.js';

/** The examinations every school sets up each year, in the order they fall. */
export const STANDARD_EXAMS = [
  { name: 'Unit Test 1', type: 'unit_test' }, { name: 'Unit Test 2', type: 'unit_test' }, { name: 'Half-Yearly', type: 'half_yearly' },
  { name: 'Unit Test 3', type: 'unit_test' }, { name: 'Unit Test 4', type: 'unit_test' }, { name: 'Final Exam', type: 'annual' },
];

/** The subjects a class usually has. A school can add or drop any of them; Classes 11 and 12 differ by stream. */
const PRE_PRIMARY = ['English', 'Hindi', 'Mathematics', 'Drawing & Craft', 'Rhymes & Stories'];
const SETS = {
  medical: ['English', 'Physics', 'Chemistry', 'Biology', 'Physical Education'],
  non_medical: ['English', 'Physics', 'Chemistry', 'Mathematics', 'Computer Science'],
  commerce: ['English', 'Accountancy', 'Business Studies', 'Economics', 'Mathematics'],
  arts: ['English', 'History', 'Political Science', 'Geography', 'Economics'],
};
export function standardSubjects(cls) {
  if (cls.stream) return SETS[cls.stream];
  if (cls.level <= 0) return PRE_PRIMARY;
  if (cls.level <= 2) return ['English', 'Hindi', 'Mathematics', 'Environmental Studies', 'General Knowledge', 'Drawing & Craft'];
  if (cls.level <= 5) return ['English', 'Hindi', 'Mathematics', 'Environmental Studies', 'Computer Science', 'General Knowledge', 'Drawing & Craft'];
  if (cls.level <= 8) return ['English', 'Hindi', 'Mathematics', 'Science', 'Social Science', 'Sanskrit', 'Computer Science'];
  if (cls.level <= 10) return ['English', 'Hindi', 'Mathematics', 'Science', 'Social Science', 'Information Technology'];
  return ['English', 'Physics', 'Chemistry', 'Mathematics'];
}

async function yearOf(ctx, exam) {
  const year = await AcademicYear.findOne({ _id: exam.yearId, tenantId: ctx.tenantId });
  if (!year) throw notFound('Academic year not found');
  return year;
}

/** Unit Test 1-4, Half-Yearly and Final Exam for the current year, for every class. Anything already there is left as it is. */
export async function addStandardExams(ctx) {
  if (!ctx.year) throw bad('Create an academic year first');
  const classes = await ClassModel.find({ tenantId: ctx.tenantId, status: 'active' }).select('_id').lean();
  if (!classes.length) throw bad('Add the classes of the school first');
  const have = new Set((await Examination.find({ tenantId: ctx.tenantId, yearId: ctx.year._id, sectionId: { $exists: false } }).select('name').lean()).map((e) => e.name));
  let created = 0;
  for (const e of STANDARD_EXAMS) {
    if (have.has(e.name)) continue;
    await Examination.create({ tenantId: ctx.tenantId, yearId: ctx.year._id, name: e.name, type: e.type, classIds: classes.map((c) => c._id), createdBy: ctx.actorId });
    created += 1;
  }
  return { created, existing: STANDARD_EXAMS.length - created };
}

/** The date sheet of one class: its subjects with the date, time and room set so far. */
export async function getDatesheet(ctx, examId, classId) {
  const exam = await Examination.findOne({ _id: examId, tenantId: ctx.tenantId });
  if (!exam) throw notFound('Examination not found');
  const cls = await ClassModel.findOne({ _id: classId, tenantId: ctx.tenantId });
  if (!cls) throw notFound('Class not found');
  const [offerings, rows] = await Promise.all([
    SubjectOffering.find({ tenantId: ctx.tenantId, yearId: exam.yearId, classId }).populate('subjectId', 'name code').lean(),
    ExaminationSubject.find({ tenantId: ctx.tenantId, examId, classId }).lean(),
  ]);
  const by = new Map(rows.map((r) => [String(r.subjectId), r]));
  const subjects = offerings.filter((o) => o.subjectId).map((o) => {
    const r = by.get(String(o.subjectId._id));
    return { subjectId: o.subjectId._id, subject: o.subjectId.name, code: o.subjectId.code, examSubjectId: r?._id || null, date: r?.date || '', startTime: r?.startTime || '', endTime: r?.endTime || '', room: r?.room || '', marksStarted: false };
  }).sort((a, b) => (a.date || '9').localeCompare(b.date || '9') || a.subject.localeCompare(b.subject));
  const started = new Set((await MarksSheet.find({ tenantId: ctx.tenantId, examSubjectId: { $in: rows.map((r) => r._id) } }).select('examSubjectId').lean()).map((m) => String(m.examSubjectId)));
  subjects.forEach((s) => { s.marksStarted = !!s.examSubjectId && started.has(String(s.examSubjectId)); });
  return { exam: { id: exam._id, name: exam.name, schedulePublished: exam.schedulePublished }, class: { id: cls._id, name: cls.name, stream: cls.stream || null }, subjects };
}

/** Saves the whole date sheet of a class in one go. The rows are checked against each other (one exam at a time for a class) before anything is written. */
export async function saveDatesheet(ctx, examId, { classId, rows }) {
  const exam = await Examination.findOne({ _id: examId, tenantId: ctx.tenantId });
  if (!exam) throw notFound('Examination not found');
  const cls = await ClassModel.findOne({ _id: classId, tenantId: ctx.tenantId });
  if (!cls) throw notFound('Class not found');
  const names = new Map((await Subject.find({ tenantId: ctx.tenantId, _id: { $in: rows.map((r) => r.subjectId) } }).select('name').lean()).map((s) => [String(s._id), s.name]));
  const dated = rows.filter((r) => r.date);
  for (const r of dated) if (!r.startTime !== !r.endTime) throw bad(`${names.get(String(r.subjectId))}: give both the start and the end time, or neither`);
  // two papers of one class at the same time
  for (let i = 0; i < dated.length; i += 1) for (let j = i + 1; j < dated.length; j += 1) {
    const a = dated[i]; const b = dated[j];
    if (a.date === b.date && a.startTime && b.startTime && a.startTime < b.endTime && b.startTime < a.endTime) throw conflict(`${names.get(String(a.subjectId))} and ${names.get(String(b.subjectId))} are at the same time on ${a.date}`);
  }
  if (!exam.classIds.map(String).includes(String(classId))) { exam.classIds.push(classId); await exam.save(); } // a class added later joins the examination
  const existing = await ExaminationSubject.find({ tenantId: ctx.tenantId, examId, classId }).lean();
  const ignoreIds = existing.map((e) => e._id);
  const byId = new Map(existing.map((e) => [String(e.subjectId), e]));
  let saved = 0; let cleared = 0;
  for (const r of rows) {
    const cur = byId.get(String(r.subjectId));
    if (!r.date) {
      if (cur?.date) { await ExaminationSubject.updateOne({ _id: cur._id }, { $unset: { date: 1, startTime: 1, endTime: 1, room: 1 } }); cleared += 1; }
      continue;
    }
    await upsertExamSubject(ctx, examId, { classId, subjectId: r.subjectId, date: r.date, ...(r.startTime ? { startTime: r.startTime, endTime: r.endTime } : {}), ...(r.room ? { room: r.room } : {}) }, { ignoreIds });
    saved += 1;
  }
  await refreshSpan(ctx, exam);
  return { saved, cleared };
}

/** The examination's own start and end follow its date sheets, and marks are due a week after the last paper unless the school set a date. */
async function refreshSpan(ctx, exam) {
  const dates = (await ExaminationSubject.find({ tenantId: ctx.tenantId, examId: exam._id, date: { $exists: true, $ne: null } }).select('date').lean()).map((x) => x.date).filter(Boolean).sort();
  if (!dates.length) return;
  exam.startDate = dates[0]; exam.endDate = dates[dates.length - 1];
  if (!exam.marksDeadline || exam.marksDeadline < exam.endDate) exam.marksDeadline = addDays(exam.endDate, 7);
  await exam.save();
}

/** Puts the usual subjects of a class (by its stream, for Classes 11 and 12) into its list, so the date sheet can be filled before any teacher is assigned. */
export async function addStandardSubjects(ctx, examId, classId) {
  const exam = await Examination.findOne({ _id: examId, tenantId: ctx.tenantId });
  if (!exam) throw notFound('Examination not found');
  const cls = await ClassModel.findOne({ _id: classId, tenantId: ctx.tenantId });
  if (!cls) throw notFound('Class not found');
  await yearOf(ctx, exam);
  let created = 0;
  for (const name of standardSubjects(cls)) {
    const subject = await findOrCreateSubject(ctx.tenantId, name);
    const had = await SubjectOffering.exists({ tenantId: ctx.tenantId, yearId: exam.yearId, classId, subjectId: subject._id });
    await ensureOffering(ctx.tenantId, { yearId: exam.yearId, classId, subjectId: subject._id });
    if (!had) created += 1;
  }
  return { created };
}

/** One more subject for a class, by name (it is created if the school has no subject of that name yet). */
export async function addSubjectToClass(ctx, examId, classId, name) {
  const exam = await Examination.findOne({ _id: examId, tenantId: ctx.tenantId });
  if (!exam) throw notFound('Examination not found');
  if (!(await ClassModel.exists({ _id: classId, tenantId: ctx.tenantId }))) throw notFound('Class not found');
  const subject = await findOrCreateSubject(ctx.tenantId, name);
  await ensureOffering(ctx.tenantId, { yearId: exam.yearId, classId, subjectId: subject._id });
  return { subjectId: subject._id, name: subject.name };
}
