import {
  TeachingAssignment, ClassTeacherAssignment, Teacher, Section, Subject, TimetableEntry, StudentEnrolment, ClassModel, } from '../../models/index.js';
import { notFound, conflict, addDays } from '../../core/utils.js';
import { schoolToday } from '../../services/context.js';
import { findOrCreateSubject, ensureOffering } from '../../services/subjects.js';

/** Future timetable periods taught under an ended assignment are flagged unresolved, never silently deleted. */
async function flagTimetable(tenantId, assignmentIds) {
  if (!assignmentIds.length) return 0;
  const r = await TimetableEntry.updateMany({ tenantId, assignmentId: { $in: assignmentIds } }, { unresolved: true });
  return r.modifiedCount;
}

export async function listAssignments(tenantId, { yearId, teacherId, sectionId, open }) {
  const f = { tenantId };
  if (yearId) f.yearId = yearId;
  if (teacherId) f.teacherId = teacherId;
  if (sectionId) f.sectionId = sectionId;
  if (open !== undefined) f.open = open === 'true';
  return TeachingAssignment.find(f)
    .populate('teacherId', 'name employeeId').populate('subjectId', 'name code').populate('sectionId', 'name classId').populate('classId', 'name').populate('offeringId', 'weeklyPeriods')
    .sort({ createdAt: -1 }).lean();
}

export async function createAssignment(tenantId, { teacherId, sectionId, subjectId, subject, weeklyPeriods, effectiveFrom }) {
  const [teacher, section] = await Promise.all([Teacher.findOne({ _id: teacherId, tenantId }), Section.findOne({ _id: sectionId, tenantId })]);
  if (!teacher) throw notFound('Teacher not found');
  if (teacher.status !== 'active') throw conflict('Teacher is inactive');
  if (!section) throw notFound('Section not found');
  // the subject is created on the spot if this is the first time the school uses it
  const subj = subjectId ? await Subject.findOne({ _id: subjectId, tenantId }) : await findOrCreateSubject(tenantId, subject);
  if (!subj) throw notFound('Subject not found');
  const { today } = await schoolToday(tenantId);
  const existing = await TeachingAssignment.findOne({ tenantId, yearId: section.yearId, sectionId, subjectId: subj._id, open: true });
  if (existing) throw conflict('This subject already has a teacher in that section. End the current assignment first.');
  const offering = await ensureOffering(tenantId, { yearId: section.yearId, classId: section.classId, subjectId: subj._id }, weeklyPeriods);
  if (weeklyPeriods && offering.weeklyPeriods !== weeklyPeriods) { offering.weeklyPeriods = weeklyPeriods; await offering.save(); }
  if (!teacher.subjectIds.map(String).includes(String(subj._id))) { teacher.subjectIds.push(subj._id); await teacher.save(); }
  return TeachingAssignment.create({
    tenantId, yearId: section.yearId, teacherId, sectionId, classId: section.classId, subjectId: subj._id, offeringId: offering._id, effectiveFrom: effectiveFrom || today,
  });
}

export async function endAssignment(tenantId, id, effectiveTo) {
  const a = await TeachingAssignment.findOne({ _id: id, tenantId });
  if (!a) throw notFound('Assignment not found');
  if (!a.open) throw conflict('Assignment already ended');
  const { today } = await schoolToday(tenantId);
  a.effectiveTo = effectiveTo || today;
  a.open = false;
  await a.save();
  const flagged = await flagTimetable(tenantId, [a._id]);
  return { assignment: a, unresolvedPeriods: flagged };
}

export async function endTeacherAssignments(tenantId, teacherId, effectiveTo) {
  const open = await TeachingAssignment.find({ tenantId, teacherId, open: true });
  for (const a of open) { a.effectiveTo = effectiveTo; a.open = false; await a.save(); }
  await ClassTeacherAssignment.updateMany({ tenantId, teacherId, open: true }, { effectiveTo, open: false });
  return flagTimetable(tenantId, open.map((a) => a._id));
}

export async function listClassTeachers(tenantId, { yearId }) {
  const f = { tenantId };
  if (yearId) f.yearId = yearId;
  return ClassTeacherAssignment.find(f).populate('teacherId', 'name employeeId').populate('sectionId', 'name classId').lean();
}

export async function setClassTeacher(tenantId, sectionId, { teacherId, effectiveFrom }) {
  const [teacher, section] = await Promise.all([Teacher.findOne({ _id: teacherId, tenantId }), Section.findOne({ _id: sectionId, tenantId })]);
  if (!teacher || teacher.status !== 'active') throw notFound('Active teacher not found');
  if (!section) throw notFound('Section not found');
  const { today } = await schoolToday(tenantId);
  const open = await ClassTeacherAssignment.findOne({ tenantId, sectionId, open: true });
  if (open && String(open.teacherId) === String(teacherId)) return open;
  // one teacher is in charge of one class at a time: another section of the same year always counts; a section of another year counts while its students are still in it
  const others = await ClassTeacherAssignment.find({ tenantId, teacherId, open: true, sectionId: { $ne: sectionId } }).lean();
  for (const o of others) {
    const busy = String(o.yearId) === String(section.yearId) || (await StudentEnrolment.exists({ tenantId, sectionId: o.sectionId, status: 'active' }));
    if (!busy) continue;
    const sec = await Section.findById(o.sectionId).select('name classId').lean(); const cls = sec && (await ClassModel.findById(sec.classId).select('name').lean());
    throw conflict(`${teacher.name} is already the class teacher of ${cls?.name || ''} ${sec?.name || ''}`.trim() + '. A teacher can be in charge of one class at a time: change that class teacher first.');
  }
  if (open) {
    open.effectiveTo = addDays(effectiveFrom || today, -1) < (open.effectiveFrom || '') ? (open.effectiveFrom || today) : addDays(effectiveFrom || today, -1);
    open.open = false;
    await open.save();
  }
  return ClassTeacherAssignment.create({ tenantId, yearId: section.yearId, sectionId, teacherId, effectiveFrom: effectiveFrom || today });
}

export async function clearClassTeacher(tenantId, sectionId) {
  const open = await ClassTeacherAssignment.findOne({ tenantId, sectionId, open: true });
  if (!open) throw notFound('No class teacher is assigned');
  const { today } = await schoolToday(tenantId);
  open.effectiveTo = today; open.open = false;
  await open.save();
  return open;
}
