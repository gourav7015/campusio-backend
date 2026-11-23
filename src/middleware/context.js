import { StudentEnrolment, Designation, AcademicYear } from '../models/index.js';
import { forbidden, notFound } from '../core/utils.js';
import { schoolToday, resolveYear, teacherScope, loadTeacherForUser, teacherDefaultYear, loadStudentForUser, loadStaffForUser } from '../services/context.js';

/** Resolve school settings, local "today" and the academic year (?yearId= or current). */
export async function adminContext(req, _res, next) {
  const { school, settings, today } = await schoolToday(req.tenantId);
  // yearExplicit: a year was asked for (?yearId=). Without it, lists of people show each one where they are now, whichever year their class is in
  req.ctx = { school, settings, today, year: await resolveYear(req), yearExplicit: !!req.query?.yearId, tenantId: req.tenantId, actorId: req.user._id, role: req.user.role };
  next();
}

/** Teacher context: the teacher profile and the sections/subjects they may act on right now. */
export async function teacherContext(req, _res, next) {
  const { school, settings, today } = await schoolToday(req.tenantId);
  const teacher = await loadTeacherForUser(req);
  if (teacher.status !== 'active') throw forbidden('Your teacher account is inactive');
  let year = await resolveYear(req);
  if (!year) throw notFound('No academic year has been set up yet');
  if (!req.query?.yearId) year = await teacherDefaultYear(req.tenantId, teacher._id, year, today);
  const scope = await teacherScope(req.tenantId, teacher._id, year._id, today);
  req.ctx = { school, settings, today, year, teacher, scope, tenantId: req.tenantId, actorId: req.user._id, role: 'teacher' };
  next();
}

/** Student context: own profile + the enrolment(s) of the selected year. Never accepts a student id from the client. */
export async function studentContext(req, _res, next) {
  const { school, settings, today } = await schoolToday(req.tenantId);
  const student = await loadStudentForUser(req);
  if (student.status !== 'active' && student.status !== 'completed') throw forbidden('Your student account is not active');
  let year = await resolveYear(req);
  // classes do not all change year together: a student whose class has moved on sees the year they are now in, not the school's older "current" one
  if (!req.query?.yearId) {
    const now = await StudentEnrolment.findOne({ tenantId: req.tenantId, studentId: student._id, status: 'active' }).sort({ startDate: -1 }).select('yearId').lean();
    if (now && (!year || String(now.yearId) !== String(year._id))) year = (await AcademicYear.findOne({ _id: now.yearId, tenantId: req.tenantId })) || year;
  }
  const enrolments = year ? await StudentEnrolment.find({ tenantId: req.tenantId, studentId: student._id, yearId: year._id }).sort({ startDate: 1, createdAt: 1 }) : [];
  const enrolment = enrolments.find((e) => e.status === 'active') || enrolments[enrolments.length - 1] || null;
  req.ctx = {
    school, settings, today, year, student, enrolment, enrolments, tenantId: req.tenantId, actorId: req.user._id, role: 'student',
    sectionIds: [...new Set(enrolments.map((e) => String(e.sectionId)))],
  };
  next();
}

/** Staff context (drivers, conductors, maids, sweepers…): their own record only. The client never sends an id. */
export async function staffContext(req, _res, next) {
  const { school, settings, today } = await schoolToday(req.tenantId);
  const staff = await loadStaffForUser(req);
  if (staff.status !== 'active') throw forbidden('Your staff account is inactive');
  const designation = await Designation.findById(staff.designationId).lean();
  req.ctx = { school, settings, today, year: await resolveYear(req), staff, designation, group: designation?.group === 'transport' ? 'transport' : 'general', tenantId: req.tenantId, actorId: req.user._id, role: 'staff' };
  next();
}
