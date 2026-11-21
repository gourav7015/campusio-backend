import { School, AcademicYear, TeachingAssignment, ClassTeacherAssignment, StudentEnrolment, Counter, Teacher, Student, defaultSettings, StaffMember } from '../models/index.js';
import { isId, todayStr, notFound } from '../core/utils.js';
import { memo } from '../core/memo.js';

export function settingsOf(school) {
  const d = defaultSettings();
  const s = school?.settings || {};
  return {
    ...d, ...s,
    grading: { ...d.grading, ...(s.grading || {}) },
    attendance: { ...d.attendance, ...(s.attendance || {}) },
    leaveBalances: { ...d.leaveBalances, ...(s.leaveBalances || {}) },
    staffLeaveBalances: { ...d.staffLeaveBalances, ...(s.staffLeaveBalances || {}) },
    staffAttendance: { ...d.staffAttendance, ...(s.staffAttendance || {}) },
    statutory: { pf: { ...d.statutory.pf, ...(s.statutory?.pf || {}) }, esi: { ...d.statutory.esi, ...(s.statutory?.esi || {}) }, pt: { ...d.statutory.pt, ...(s.statutory?.pt || {}) } },
  };
}

/**
 * The school record. Read on every request, so it is kept in memory for a few seconds (see core/memo.js). Each caller gets its own copy to read:
 * code that changes the school loads it itself with School.findById, never through here.
 */
export async function loadSchool(tenantId) {
  const snap = await memo(`school:${tenantId}`, () => School.findById(tenantId).lean());
  if (!snap) throw notFound('School not found');
  return School.hydrate(snap);
}

export async function schoolToday(tenantId) {
  const school = await loadSchool(tenantId);
  const settings = settingsOf(school);
  return { school, settings, today: todayStr(settings.timezone) };
}

export async function getCurrentYear(tenantId) {
  const snap = await memo(`year:${tenantId}`, async () => (await AcademicYear.findOne({ tenantId, isCurrent: true }).lean()) || (await AcademicYear.findOne({ tenantId }).sort({ startDate: -1 }).lean()));
  return snap ? AcademicYear.hydrate(snap) : null;
}

/** ?yearId= (must belong to tenant) else the current year */
export async function resolveYear(req) {
  const q = req.query?.yearId;
  if (q && isId(String(q))) {
    const y = await AcademicYear.findOne({ _id: q, tenantId: req.tenantId });
    if (y) return y;
  }
  return getCurrentYear(req.tenantId);
}

/**
 * Which enrolments make up a class list. The current year only counts students who are in the class now. A year that has ended (or has not begun)
 * also counts students whose enrolment was closed by promotion, repeating the year or completion, so last year's classes are not shown empty.
 */
export const ON_ROLL = ['active', 'promoted', 'retained', 'completed'];
export const rollStatus = (year) => (year && !year.isCurrent ? { $in: ON_ROLL } : 'active');

export const inForce = (a, today) => (!a.effectiveFrom || a.effectiveFrom <= today) && (!a.effectiveTo || a.effectiveTo >= today);

export async function teacherScope(tenantId, teacherId, yearId, today) {
  const [assignments, classTeacher] = await Promise.all([
    TeachingAssignment.find({ tenantId, teacherId, yearId }),
    ClassTeacherAssignment.find({ tenantId, teacherId, yearId }),
  ]);
  const active = assignments.filter((a) => inForce(a, today));
  const activeCT = classTeacher.filter((a) => inForce(a, today));
  const sectionIds = [...new Set([...active.map((a) => String(a.sectionId)), ...activeCT.map((a) => String(a.sectionId))])];
  return {
    assignments: active, allAssignments: assignments,
    classTeacherSectionIds: activeCT.map((a) => String(a.sectionId)),
    sectionIds,
    canTeach: (sectionId, subjectId) => active.some((a) => String(a.sectionId) === String(sectionId) && (!subjectId || String(a.subjectId) === String(subjectId))),
    hasSection: (sectionId) => sectionIds.includes(String(sectionId)),
  };
}

export async function currentEnrolment(tenantId, studentId, yearId) {
  return StudentEnrolment.findOne({ tenantId, studentId, yearId, status: 'active' });
}

export async function nextSeq(tenantId, key) {
  const c = await Counter.findOneAndUpdate({ tenantId, key }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return c.seq;
}

export async function loadTeacherForUser(req) {
  const t = await Teacher.findOne({ userId: req.user._id, tenantId: req.tenantId });
  if (!t) throw notFound('Teacher profile not found');
  return t;
}
export async function loadStaffForUser(req) {
  const s = await StaffMember.findOne({ userId: req.user._id, tenantId: req.tenantId });
  if (!s) throw notFound('Staff profile not found');
  return s;
}
export async function loadStudentForUser(req) {
  const s = await Student.findOne({ userId: req.user._id, tenantId: req.tenantId });
  if (!s) throw notFound('Student profile not found');
  return s;
}

export function gradeFor(percentage, grading) {
  if (percentage == null) return null;
  const scale = [...(grading?.scale || [])].sort((a, b) => b.min - a.min);
  return (scale.find((s) => percentage >= s.min) || scale[scale.length - 1] || { grade: '-' }).grade;
}
