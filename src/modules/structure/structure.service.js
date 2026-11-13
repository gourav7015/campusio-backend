import {
  AcademicYear, ClassModel, Section, Subject, SubjectOffering, StudentEnrolment, TeachingAssignment, TimetableEntry,
  AttendanceSession, School, Homework, ClassTeacherAssignment, Teacher,
} from '../../models/index.js';
import { notFound, conflict, bad } from '../../core/utils.js';
import { settingsOf } from '../../services/context.js';
import { levelOf } from '../../core/grades.js';
import { normaliseComponents } from '../../core/components.js';

const owned = async (Model, tenantId, id, label) => {
  const doc = await Model.findOne({ _id: id, tenantId });
  if (!doc) throw notFound(`${label} not found`);
  return doc;
};

// ── academic years ──
export const listYears = (tenantId) => AcademicYear.find({ tenantId }).sort({ startDate: -1 });

export async function createYear(tenantId, body) {
  const makeCurrent = body.isCurrent || !(await AcademicYear.exists({ tenantId }));
  if (makeCurrent) await AcademicYear.updateMany({ tenantId }, { isCurrent: false });
  return AcademicYear.create({ tenantId, ...body, isCurrent: makeCurrent, status: makeCurrent ? 'active' : 'upcoming' });
}
export async function updateYear(tenantId, id, body) {
  const y = await owned(AcademicYear, tenantId, id, 'Academic year');
  Object.assign(y, body);
  if (y.endDate <= y.startDate) throw bad('End date must be after start date');
  return y.save();
}
export async function setCurrentYear(tenantId, id) {
  const y = await owned(AcademicYear, tenantId, id, 'Academic year');
  if (y.status === 'closed') throw conflict('A closed academic year cannot be made current');
  await AcademicYear.updateMany({ tenantId, _id: { $ne: y._id } }, { isCurrent: false });
  y.isCurrent = true; y.status = 'active';
  return y.save();
}
export async function closeYear(tenantId, id) {
  const y = await owned(AcademicYear, tenantId, id, 'Academic year');
  y.status = 'closed'; y.isCurrent = false;
  return y.save();
}

// ── classes ──
export const listClasses = (tenantId) => ClassModel.find({ tenantId }).sort({ level: 1, name: 1 });
export async function createClass(tenantId, body) {
  if (await ClassModel.exists({ tenantId, name: body.name })) throw conflict(`${body.name} already exists`);
  return ClassModel.create({ tenantId, name: body.name, level: levelOf(body.name) });
}
export async function updateClass(tenantId, id, body) {
  const c = await owned(ClassModel, tenantId, id, 'Class');
  Object.assign(c, body);
  return c.save();
}
export async function deleteClass(tenantId, id) {
  const c = await owned(ClassModel, tenantId, id, 'Class');
  if (await Section.exists({ tenantId, classId: c._id })) throw conflict('This class has sections. Archive it instead of deleting.');
  await c.deleteOne();
}

// ── sections ──
export async function listSections(tenantId, { yearId, classId }) {
  const f = { tenantId };
  if (yearId) f.yearId = yearId;
  if (classId) f.classId = classId;
  const sections = await Section.find(f).sort({ classId: 1, name: 1 }).lean();
  const counts = await StudentEnrolment.aggregate([
    { $match: { tenantId, status: 'active', sectionId: { $in: sections.map((s) => s._id) } } },
    { $group: { _id: '$sectionId', n: { $sum: 1 } } },
  ]);
  const cm = new Map(counts.map((c) => [String(c._id), c.n]));
  return sections.map((s) => ({ ...s, studentCount: cm.get(String(s._id)) || 0 }));
}
export async function createSection(tenantId, body) {
  await owned(AcademicYear, tenantId, body.yearId, 'Academic year');
  await owned(ClassModel, tenantId, body.classId, 'Class');
  return Section.create({ tenantId, ...body });
}
export async function updateSection(tenantId, id, body) {
  const s = await owned(Section, tenantId, id, 'Section');
  if (body.capacity !== undefined) {
    const n = await StudentEnrolment.countDocuments({ tenantId, sectionId: s._id, status: 'active' });
    if (body.capacity < n) throw conflict(`Capacity cannot be lower than the ${n} enrolled students`);
  }
  if (body.status === 'archived' && (await StudentEnrolment.exists({ tenantId, sectionId: s._id, status: 'active' }))) {
    throw conflict('Reallocate the active students before archiving this section');
  }
  Object.assign(s, body);
  return s.save();
}
export async function deleteSection(tenantId, id) {
  const s = await owned(Section, tenantId, id, 'Section');
  const hasHistory = await Promise.all([
    StudentEnrolment.exists({ tenantId, sectionId: s._id }), AttendanceSession.exists({ tenantId, sectionId: s._id }),
    TimetableEntry.exists({ tenantId, sectionId: s._id }), TeachingAssignment.exists({ tenantId, sectionId: s._id }), Homework.exists({ tenantId, sectionId: s._id }),
  ]);
  if (hasHistory.some(Boolean)) throw conflict('This section has students or records. Archive it instead of deleting.');
  await s.deleteOne();
}

// ── subjects & offerings ──
export const listSubjects = (tenantId) => Subject.find({ tenantId }).sort({ name: 1 });
export async function listOfferings(tenantId, { yearId, classId }) {
  const f = { tenantId };
  if (yearId) f.yearId = yearId;
  if (classId) f.classId = classId;
  return SubjectOffering.find(f).populate('subjectId', 'name code').lean();
}
export async function updateOffering(tenantId, id, body) {
  const o = await owned(SubjectOffering, tenantId, id, 'Offering');
  if (body.weeklyPeriods) o.weeklyPeriods = body.weeklyPeriods;
  if (body.assessment) {
    const next = { components: o.assessment.components, passMarks: o.assessment.passMarks };
    if (body.assessment.components) next.components = normaliseComponents(body.assessment.components);
    if (body.assessment.passMarks !== undefined) next.passMarks = body.assessment.passMarks;
    o.assessment = next;
  }
  return o.save();
}
export async function copyOfferings(tenantId, { fromYearId, toYearId }) {
  await Promise.all([owned(AcademicYear, tenantId, fromYearId, 'Source year'), owned(AcademicYear, tenantId, toYearId, 'Target year')]);
  const src = await SubjectOffering.find({ tenantId, yearId: fromYearId }).lean();
  let created = 0;
  for (const o of src) {
    const exists = await SubjectOffering.exists({ tenantId, yearId: toYearId, classId: o.classId, subjectId: o.subjectId });
    if (exists) continue;
    await SubjectOffering.create({ tenantId, yearId: toYearId, classId: o.classId, subjectId: o.subjectId, weeklyPeriods: o.weeklyPeriods, assessment: o.assessment });
    created++;
  }
  return { created, skipped: src.length - created };
}

/**
 * Create the next academic year in one step and carry the set-up over from the year that is ending:
 * its sections (same class, name, capacity, room), its subject offerings, and — if asked — the same teachers
 * (subject teachers and class teachers). Students are not moved here; that is the year-end promotion.
 */
export async function rolloverYear(tenantId, actorId, body) {
  const from = await owned(AcademicYear, tenantId, body.fromYearId, 'Source year');
  if (body.startDate <= from.startDate) throw bad('The new year must start after the year it follows');
  if (await AcademicYear.exists({ tenantId, name: body.name })) throw conflict(`An academic year called ${body.name} already exists`);
  const year = await AcademicYear.create({ tenantId, name: body.name, startDate: body.startDate, endDate: body.endDate, isCurrent: false, status: 'upcoming' });
  const out = { year, sections: 0, offerings: 0, subjectTeachers: 0, classTeachers: 0 };

  const sectionMap = new Map(); // old section id -> new section id
  if (body.copySections) {
    const old = await Section.find({ tenantId, yearId: from._id, status: 'active' }).lean();
    const classes = new Set((await ClassModel.find({ tenantId, status: 'active' }).select('_id').lean()).map((c) => String(c._id)));
    for (const s of old.filter((x) => classes.has(String(x.classId)))) {
      const created = await Section.create({ tenantId, yearId: year._id, classId: s.classId, name: s.name, capacity: s.capacity, room: s.room });
      sectionMap.set(String(s._id), created); out.sections++;
    }
  }
  if (body.copyOfferings) out.offerings = (await copyOfferings(tenantId, { fromYearId: from._id, toYearId: year._id })).created;
  if (body.copyTeachers && sectionMap.size) {
    const active = new Set((await Teacher.find({ tenantId, status: 'active' }).select('_id').lean()).map((t) => String(t._id)));
    const offerings = await SubjectOffering.find({ tenantId, yearId: year._id }).lean();
    const offerOf = new Map(offerings.map((o) => [`${o.classId}|${o.subjectId}`, o]));
    const asg = await TeachingAssignment.find({ tenantId, yearId: from._id, open: true }).lean();
    for (const a of asg) {
      const sec = sectionMap.get(String(a.sectionId)); const off = offerOf.get(`${a.classId}|${a.subjectId}`);
      if (!sec || !off || !active.has(String(a.teacherId))) continue;
      await TeachingAssignment.create({ tenantId, yearId: year._id, teacherId: a.teacherId, sectionId: sec._id, classId: a.classId, subjectId: a.subjectId, offeringId: off._id, effectiveFrom: year.startDate, open: true });
      out.subjectTeachers++;
    }
    const cts = await ClassTeacherAssignment.find({ tenantId, yearId: from._id, open: true }).lean();
    for (const c of cts) {
      const sec = sectionMap.get(String(c.sectionId));
      if (!sec || !active.has(String(c.teacherId))) continue;
      await ClassTeacherAssignment.create({ tenantId, yearId: year._id, sectionId: sec._id, teacherId: c.teacherId, effectiveFrom: year.startDate, open: true });
      out.classTeachers++;
    }
  }
  return out;
}

// ── settings ──
export async function getSettings(tenantId) {
  const school = await School.findById(tenantId);
  return { ...settingsOf(school), schoolName: school.name };
}
export async function updateSettings(tenantId, body) {
  const school = await School.findById(tenantId);
  const current = settingsOf(school);
  const { schoolName, ...rest } = body;
  if (schoolName) school.name = schoolName;
  const scale = rest.grading?.scale ? [...rest.grading.scale].sort((a, b) => b.min - a.min) : undefined;
  school.settings = {
    ...current, ...rest,
    grading: { ...current.grading, ...(rest.grading || {}), ...(scale ? { scale } : {}) },
    attendance: { ...current.attendance, ...(rest.attendance || {}) },
    leaveBalances: { ...current.leaveBalances, ...(rest.leaveBalances || {}) },
    staffLeaveBalances: { ...current.staffLeaveBalances, ...(rest.staffLeaveBalances || {}) },
    staffAttendance: { ...current.staffAttendance, ...(rest.staffAttendance || {}) },
    statutory: { pf: { ...current.statutory.pf, ...(rest.statutory?.pf || {}) }, esi: { ...current.statutory.esi, ...(rest.statutory?.esi || {}) }, pt: { ...current.statutory.pt, ...(rest.statutory?.pt || {}) } },
  };
  school.markModified('settings');
  await school.save();
  return { ...settingsOf(school), schoolName: school.name };
}
