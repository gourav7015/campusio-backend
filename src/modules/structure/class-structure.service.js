import { SubjectOffering, Section, ClassModel, Subject, TeachingAssignment, ClassTeacherAssignment, AcademicYear, Teacher, ExaminationSubject } from '../../models/index.js';
import { escapeRegex } from '../../core/utils.js';
import { findOrCreateSubject, ensureOffering } from '../../services/subjects.js';
import { notFound, conflict, bad } from '../../core/utils.js';

/**
 * The structure of the school class by class, for one academic year: each class's sections, its subjects (with periods per week), who teaches each
 * subject in each section, and who is the class teacher of each section. Anything with nobody assigned is listed as a gap, so the office (and the class
 * teacher, for their own class) can see what still needs a teacher. Teachers are never copied silently into a new year: they are assigned by hand.
 */
export async function classStructure(tenantId, yearId) {
  const year = await AcademicYear.findOne({ _id: yearId, tenantId }).lean();
  if (!year) throw notFound('Academic year not found');
  const [classes, sections, offerings, assignments, classTeachers] = await Promise.all([
    ClassModel.find({ tenantId, status: 'active' }).sort({ level: 1 }).lean(), Section.find({ tenantId, yearId, status: 'active' }).sort({ name: 1 }).lean(),
    SubjectOffering.find({ tenantId, yearId }).populate('subjectId', 'name code').lean(),
    TeachingAssignment.find({ tenantId, yearId, open: true }).populate('teacherId', 'name').lean(),
    ClassTeacherAssignment.find({ tenantId, yearId, open: true }).populate('teacherId', 'name').lean(),
  ]);
  const ctBySection = new Map(classTeachers.map((c) => [String(c.sectionId), c.teacherId]));
  const asgOf = new Map(assignments.map((a) => [`${a.sectionId}|${a.offeringId}`, a]));
  const out = []; const summary = { sectionsWithoutClassTeacher: 0, subjectsWithoutTeacher: 0, classesWithoutSubjects: 0, teachersInChargeOfTwo: [] };
  for (const c of classes) {
    const secs = sections.filter((s) => String(s.classId) === String(c._id));
    if (!secs.length) continue;
    const subs = offerings.filter((o) => String(o.classId) === String(c._id) && o.subjectId).sort((a, b) => a.subjectId.name.localeCompare(b.subjectId.name));
    const sectionRows = secs.map((s) => { const t = ctBySection.get(String(s._id)); return { id: s._id, name: s.name, classTeacher: t ? { id: t._id, name: t.name } : null }; });
    const subjectRows = subs.map((o) => ({
      offeringId: o._id, subjectId: o.subjectId._id, subject: o.subjectId.name, code: o.subjectId.code, weeklyPeriods: o.weeklyPeriods,
      teachers: secs.map((s) => { const a = asgOf.get(`${s._id}|${o._id}`); return { sectionId: s._id, assignmentId: a?._id, teacherId: a?.teacherId?._id, teacher: a?.teacherId?.name || null }; }),
    }));
    const noClassTeacher = sectionRows.filter((s) => !s.classTeacher).map((s) => s.name);
    const noTeacher = subjectRows.map((s) => ({ subject: s.subject, sections: s.teachers.filter((t) => !t.teacher).map((t) => sectionRows.find((r) => String(r.id) === String(t.sectionId)).name) })).filter((x) => x.sections.length);
    summary.sectionsWithoutClassTeacher += noClassTeacher.length; summary.subjectsWithoutTeacher += noTeacher.reduce((a, x) => a + x.sections.length, 0); if (!subjectRows.length) summary.classesWithoutSubjects++;
    out.push({ classId: c._id, className: c.name, level: c.level, sections: sectionRows, subjects: subjectRows, gaps: { noClassTeacher, noTeacher, noSubjects: !subjectRows.length } });
  }
  // a teacher can be in charge of only one class: say so if the records already hold two (from before the rule)
  const label = new Map(out.flatMap((c) => c.sections.map((x) => [String(x.id), `${c.className} ${x.name}`])));
  const byTeacher = new Map();
  for (const ct of classTeachers) { const k = String(ct.teacherId?._id); if (!byTeacher.has(k)) byTeacher.set(k, { teacher: ct.teacherId?.name, sections: [] }); byTeacher.get(k).sections.push(label.get(String(ct.sectionId))); }
  summary.teachersInChargeOfTwo = [...byTeacher.values()].filter((t) => t.sections.filter(Boolean).length > 1).map((t) => ({ teacher: t.teacher, sections: t.sections.filter(Boolean) }));
  return { year: { id: year._id, name: year.name, status: year.status }, classes: out, summary };
}

/** Just the counts and the class names, for the dashboard. */
export async function coverageSummary(tenantId, yearId) {
  if (!yearId) return null;
  const s = await classStructure(tenantId, yearId);
  return { ...s.summary, classes: s.classes.filter((c) => c.gaps.noClassTeacher.length || c.gaps.noTeacher.length || c.gaps.noSubjects).map((c) => ({ classId: c.classId, className: c.className, ...c.gaps })) };
}

/** Add a subject to a class for a year (the subject is created if the school has not used the name before). Teachers are assigned separately. */
export async function addSubjectToClass(tenantId, { yearId, classId, subject, subjectId, weeklyPeriods }) {
  const [year, cls] = await Promise.all([AcademicYear.findOne({ _id: yearId, tenantId }), ClassModel.findOne({ _id: classId, tenantId })]);
  if (!year) throw notFound('Academic year not found');
  if (year.status === 'closed') throw conflict('That academic year is closed');
  if (!cls) throw notFound('Class not found');
  const subj = subjectId ? await Subject.findOne({ _id: subjectId, tenantId }) : await findOrCreateSubject(tenantId, subject);
  if (!subj) throw notFound('Subject not found');
  if (await SubjectOffering.exists({ tenantId, yearId, classId, subjectId: subj._id })) throw conflict(`${subj.name} is already a subject of ${cls.name} in ${year.name}`);
  return ensureOffering(tenantId, { yearId, classId, subjectId: subj._id }, weeklyPeriods || 5);
}

/** Remove a subject from a class. Only while nothing has been built on it: with teachers (now or in the past) it stays, and the reason is said. */
export async function removeSubjectFromClass(tenantId, offeringId) {
  const o = await SubjectOffering.findOne({ _id: offeringId, tenantId });
  if (!o) throw notFound('Subject of this class not found');
  const year = await AcademicYear.findById(o.yearId).select('status').lean();
  if (year?.status === 'closed') throw conflict('That academic year is closed');
  const open = await TeachingAssignment.countDocuments({ tenantId, offeringId: o._id, open: true });
  if (open) throw conflict(`${open} teacher assignment${open === 1 ? '' : 's'} still use this subject. End them first (Subjects & teacher assignments).`);
  if (await TeachingAssignment.exists({ tenantId, offeringId: o._id })) throw bad('This subject has past teachers, timetable periods or marks in this year, so it is kept as history and cannot be removed');
  await o.deleteOne();
  return { removed: true };
}

/** For a class teacher: what is missing in their own sections (subjects with no teacher, a class with no subjects at all). */
export async function gapsForSections(tenantId, yearId, sectionIds) {
  const wanted = new Set(sectionIds.map(String));
  if (!wanted.size || !yearId) return [];
  const s = await classStructure(tenantId, yearId);
  const out = [];
  for (const c of s.classes) {
    for (const sec of c.sections.filter((x) => wanted.has(String(x.id)))) {
      const missing = c.subjects.filter((sub) => sub.teachers.find((t) => String(t.sectionId) === String(sec.id) && !t.teacher)).map((sub) => sub.subject);
      if (missing.length || !c.subjects.length) out.push({ sectionId: sec.id, section: `${c.className} ${sec.name}`, subjectsWithoutTeacher: missing, noSubjects: !c.subjects.length });
    }
  }
  return out;
}

// ───────────── the school's subjects, and which classes study each ─────────────
/** Every subject with the classes that study it in the year (so the office sees where a subject is used). */
export async function subjectUsage(tenantId, yearId) {
  const [subjects, offerings, classes] = await Promise.all([
    Subject.find({ tenantId }).sort({ name: 1 }).lean(), SubjectOffering.find({ tenantId, yearId }).lean(), ClassModel.find({ tenantId }).select('name level').lean(),
  ]);
  const C = new Map(classes.map((c) => [String(c._id), c]));
  return subjects.map((s) => ({
    id: s._id, name: s.name, code: s.code, status: s.status,
    classes: offerings.filter((o) => String(o.subjectId) === String(s._id)).map((o) => ({ classId: o.classId, className: C.get(String(o.classId))?.name, level: C.get(String(o.classId))?.level ?? 999, offeringId: o._id, weeklyPeriods: o.weeklyPeriods })).sort((a, b) => a.level - b.level),
  }));
}

/** A new subject for the school. The same name (any capitals) is the same subject. */
export async function createSubject(tenantId, { name }) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (await Subject.exists({ tenantId, name: new RegExp(`^${escapeRegex(clean)}$`, 'i'), status: 'active' })) throw conflict(`${clean} is already a subject of the school`);
  return findOrCreateSubject(tenantId, clean); // also brings back an archived subject of the same name
}

export async function renameSubject(tenantId, id, { name }) {
  const subj = await Subject.findOne({ _id: id, tenantId });
  if (!subj) throw notFound('Subject not found');
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (clean.length < 2) throw bad('Enter the subject name');
  if (await Subject.exists({ tenantId, _id: { $ne: subj._id }, name: new RegExp(`^${escapeRegex(clean)}$`, 'i') })) throw conflict(`${clean} is already a subject of the school`);
  subj.name = clean; return subj.save();
}

/** Delete a subject nobody uses. One that any class, teacher assignment or exam still uses stays, and the reason is said. */
export async function deleteSubject(tenantId, id) {
  const subj = await Subject.findOne({ _id: id, tenantId });
  if (!subj) throw notFound('Subject not found');
  const [offered, taught, exams] = await Promise.all([SubjectOffering.countDocuments({ tenantId, subjectId: id }), TeachingAssignment.countDocuments({ tenantId, subjectId: id }), ExaminationSubject.countDocuments({ tenantId, subjectId: id })]);
  if (offered || taught || exams) throw conflict(offered ? `${subj.name} is a subject of ${offered} class${offered === 1 ? '' : 'es'} in some year. Remove it from the classes first, and it can only be deleted if it never had teachers or exams.` : `${subj.name} has had teachers or exams, so it is kept as history and cannot be deleted`);
  await Teacher.updateMany({ tenantId, subjectIds: subj._id }, { $pull: { subjectIds: subj._id } });
  await subj.deleteOne();
  return { deleted: true };
}

/** Give one subject to several classes at once for a year; classes that already have it are skipped. */
export async function addSubjectToClasses(tenantId, { yearId, subjectId, classIds, weeklyPeriods }) {
  const out = { created: 0, skipped: 0 };
  for (const classId of classIds) {
    const exists = await SubjectOffering.exists({ tenantId, yearId, classId, subjectId });
    if (exists) { out.skipped++; continue; }
    await addSubjectToClass(tenantId, { yearId, classId, subjectId, weeklyPeriods });
    out.created++;
  }
  return out;
}

/**
 * What is missing in the given sections of a year, for the year-end promotion: a section with no class teacher, a subject nobody teaches in it, a class with
 * no subjects. Students can still be moved into such a section; the office is told, and has to confirm.
 */
export async function sectionGaps(tenantId, yearId, sectionIds) {
  const wanted = new Set(sectionIds.map(String));
  if (!wanted.size) return [];
  const s = await classStructure(tenantId, yearId);
  const out = [];
  for (const c of s.classes) {
    for (const sec of c.sections.filter((x) => wanted.has(String(x.id)))) {
      const missing = c.subjects.filter((sub) => sub.teachers.find((t) => String(t.sectionId) === String(sec.id) && !t.teacher)).map((sub) => sub.subject);
      const noClassTeacher = !sec.classTeacher;
      if (noClassTeacher || missing.length || !c.subjects.length) out.push({ sectionId: sec.id, section: `${c.className} ${sec.name}`, noClassTeacher, subjectsWithoutTeacher: missing, noSubjects: !c.subjects.length });
    }
  }
  return out;
}

/** The same, for every section of the classes a promotion will fill (a whole class, so the office sees it before choosing sections). */
export async function classReadiness(tenantId, yearId, classIds) {
  const wanted = new Set(classIds.map(String));
  const s = await classStructure(tenantId, yearId);
  return s.classes.filter((c) => wanted.has(String(c.classId))).map((c) => ({
    classId: c.classId, className: c.className, sections: c.sections.map((x) => ({ id: x.id, name: x.name, classTeacher: x.classTeacher?.name || null })), subjects: c.subjects.length,
    noClassTeacher: c.gaps.noClassTeacher, noTeacher: c.gaps.noTeacher, noSubjects: c.gaps.noSubjects,
    ready: !c.gaps.noClassTeacher.length && !c.gaps.noTeacher.length && !c.gaps.noSubjects,
  }));
}
