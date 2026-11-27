import { Router } from 'express';
import { requireRole, requireTenant, rejectActing } from '../middleware/auth.js';
import { forbidden } from '../core/utils.js';
import { AcademicYear } from '../models/index.js';
import { adminContext, teacherContext, studentContext, staffContext } from '../middleware/context.js';
import authRoutes from './auth/auth.routes.js';
import platformRoutes from './platform/platform.routes.js';
import { publicRoutes as connectPublic } from './connect/connect.routes.js';
import structureRoutes from './structure/structure.routes.js';
import studentsRoutes from './students/students.routes.js';
import teachersRoutes from './teachers/teachers.routes.js';
import assignmentsRoutes from './assignments/assignments.routes.js';
import timetableRoutes from './timetable/timetable.routes.js';
import attendanceAdmin from './attendance/attendance.admin.routes.js';
import attendanceTeacher from './attendance/attendance.teacher.routes.js';
import attendanceStudent from './attendance/attendance.student.routes.js';
import { teacherRoutes as leaveTeacher, adminRoutes as leaveAdmin } from './leave/leave.routes.js';
import { adminRoutes as homeworkAdmin, teacherRoutes as homeworkTeacher, studentRoutes as homeworkStudent } from './homework/homework.routes.js';
import { adminRoutes as materialsAdmin, teacherRoutes as materialsTeacher, studentRoutes as materialsStudent } from './materials/materials.routes.js';
import { adminRoutes as examsAdmin, teacherRoutes as examsTeacher, studentRoutes as examsStudent } from './exams/exams.routes.js';
import { adminRoutes as commsAdmin, teacherRoutes as commsTeacher, studentRoutes as commsStudent, departmentRoutes as commsDepartment, calendarRead } from './comms/comms.routes.js';
import { linkRoutes, downloadRoutes } from './files/files.routes.js';
import adminTools from './admin-tools/admin.routes.js';
import staffRoutes from './staff/staff.routes.js';
import { adminRoutes as payrollAdmin, teacherRoutes as payrollTeacher } from './payroll/payroll.routes.js';
import { transportRouter, studentRoutes as transportStudent } from './transport/transport.routes.js';
import { adminRoutes as supportStaffAdmin } from './support-staff/support-staff.routes.js';
import { adminRoutes as staffAttendanceAdmin } from './staff-attendance/staff-attendance.routes.js';
import { adminRoutes as leaveGrantsAdmin } from './leave-grants/leave-grants.routes.js';
import { adminRoutes as housesAdmin, teacherRoutes as housesTeacher } from './houses/houses.routes.js';
import { adminRoutes as staffLeaveAdmin } from './staff-leave/staff-leave.routes.js';
import staffPortal from './staff-portal/staff.routes.js';
import insightRoutes from './insight/insight.routes.js';
import financeRoutes from './finance/finance.routes.js';
import financeStudent from './finance/finance.student.routes.js';
import libraryRoutes from './library/library.routes.js';
import { classOfficeGuard } from './class-office/class-office.guard.js';
import { selfRoutes } from './library/library.self.routes.js';
import teacherPortal from './teacher-portal/teacher.routes.js';
import studentPortal from './student-portal/student.routes.js';
import { approvalRoutes } from './finance/expenses.routes.js';
import { readRoutes as schoolInfoRead, adminRoutes as schoolInfoAdmin } from './school-info/school-info.routes.js';
import { adminRoutes as privacyAdmin } from './privacy/privacy.routes.js';
import { adminRoutes as authAdmin } from './auth/auth.admin.routes.js';
import { adminRoutes as documentSettingsAdmin } from './document-settings/document-settings.routes.js';
import { teacherRoutes as classLifeTeacher, studentRoutes as classLifeStudent, adminRoutes as classLifeAdmin } from './class-life/class-life.routes.js';
import { teacherRoutes as schedTeacher, studentRoutes as schedStudent, adminRoutes as schedAdmin } from './scheduling/scheduling.routes.js';
import subAdminRoutes from './sub-admins/sub-admins.routes.js';
import { subAdminGate } from './sub-admins/permissions.js';
import { studentRoutes as paymentsStudent, webhookRoutes as paymentsWebhook } from './payments/payments.routes.js';
import { adminRoutes as employeesAdmin } from './employees/employees.routes.js';
import { attendanceRoutes, DESK_GROUPS } from './staff-attendance/staff-attendance.routes.js';
import { requesterRoutes as ticketRequester, handlerRoutes as ticketHandler, at } from './helpdesk/helpdesk.routes.js';
import { leaveDeskRoutes } from './staff-leave/staff-leave.routes.js';

/** School Admin portal (and Super Admin acting on a chosen school). */
const adminRouters = [
  at('/helpdesk', ticketRequester('platform')), at('/queries', ticketHandler('school')), employeesAdmin,
  subAdminRoutes, schedAdmin, classLifeAdmin, approvalRoutes, schoolInfoRead, schoolInfoAdmin, documentSettingsAdmin, authAdmin, privacyAdmin, adminTools, staffRoutes, structureRoutes, studentsRoutes, teachersRoutes, assignmentsRoutes, timetableRoutes, attendanceAdmin, leaveAdmin, leaveGrantsAdmin, housesAdmin,
  homeworkAdmin, materialsAdmin, examsAdmin, commsAdmin, payrollAdmin, supportStaffAdmin, staffAttendanceAdmin, staffLeaveAdmin, insightRoutes,
];
/** Teacher portal: every query is scoped server-side to the teacher's own active assignments. */
const teacherRouters = [at('/tickets', ticketRequester('platform')), at('/queries', ticketRequester('school')), schedTeacher, classLifeTeacher, schoolInfoRead, selfRoutes('teacher'), teacherPortal, attendanceTeacher, leaveTeacher, housesTeacher, homeworkTeacher, materialsTeacher, examsTeacher, commsTeacher, payrollTeacher];
/** Student portal: every query is scoped server-side to the signed-in student's own records. */
const studentRouters = [paymentsStudent, at('/tickets', ticketRequester('platform')), schedStudent, classLifeStudent, schoolInfoRead, transportStudent, financeStudent, selfRoutes('student'), studentPortal, attendanceStudent, homeworkStudent, materialsStudent, examsStudent, commsStudent];

/** The Staff portal is the office desk: only staff the School Admin has given the desk can use any of it. */
const deskGate = (req, _res, next) => { if (!req.ctx.staff?.canMarkAttendance) throw forbidden('This account has not been given the office desk. Ask the School Admin.'); next(); };

/** School Admin sees finance and library data but cannot change it. */
const viewOnly = (req, _res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) throw forbidden('The School Admin has view-only access to Finance, Library and Transport');
  next();
};

const stack = (routers) => { const r = Router(); routers.forEach((x) => r.use(x)); return r; };

export function mountModules(app, authenticate) {
  app.use('/api/auth', authRoutes);
  app.use('/api/public/connect', connectPublic); // the public Connect page: no sign-in
  app.use('/api/files', downloadRoutes); // signed-token downloads (token issued only after a permission check)
  app.use('/api/payments', paymentsWebhook); // the payment gateway calls this itself: no sign-in, the signature is the proof
  app.use('/api/platform', authenticate, platformRoutes);
  // view-only windows for the School Admin (mounted before the general /api/school stack)
  app.use('/api/school/finance', authenticate, requireRole('school_admin', 'super_admin'), requireTenant, subAdminGate('finance'), adminContext, viewOnly, financeRoutes);
  app.use('/api/school/transport', authenticate, requireRole('school_admin', 'super_admin'), requireTenant, subAdminGate('transport'), adminContext, viewOnly, transportRouter);
  app.use('/api/school/library', authenticate, requireRole('school_admin', 'super_admin'), requireTenant, subAdminGate('library'), adminContext, viewOnly, libraryRoutes);
  app.use('/api/school', authenticate, requireRole('school_admin', 'super_admin'), requireTenant, subAdminGate(), adminContext, stack(adminRouters));
  app.use('/api/finance', authenticate, requireRole('finance'), rejectActing, requireTenant, adminContext, stack([at('/tickets', ticketRequester('platform')), at('/queries', ticketRequester('school')), commsDepartment, schoolInfoRead, calendarRead, financeRoutes, payrollAdmin]));
  app.use('/api/library', authenticate, requireRole('library'), rejectActing, requireTenant, adminContext, stack([at('/tickets', ticketRequester('platform')), at('/queries', ticketRequester('school')), commsDepartment, schoolInfoRead, calendarRead, libraryRoutes]));
  app.use('/api/transport', authenticate, requireRole('transport'), rejectActing, requireTenant, adminContext, stack([at('/tickets', ticketRequester('platform')), at('/queries', ticketRequester('school')), commsDepartment, schoolInfoRead, calendarRead, transportRouter]));
  app.use('/api/staff', authenticate, requireRole('staff'), rejectActing, requireTenant, staffContext, deskGate, stack([at('/attendance-desk', attendanceRoutes(DESK_GROUPS)), at('/leave', leaveDeskRoutes('general')), at('/queries', ticketHandler('school')), at('/tickets', ticketRequester('platform')), commsDepartment, schoolInfoRead, calendarRead, staffPortal]));
  // a class teacher sees his own class the way the school office does: the office's read endpoints, behind a guard that limits them to his own sections
  app.use('/api/teacher/office', authenticate, requireRole('teacher'), rejectActing, requireTenant, teacherContext, classOfficeGuard, stack([studentsRoutes, insightRoutes, at('/finance', financeRoutes), at('/library', libraryRoutes)]));
  app.use('/api/teacher', authenticate, requireRole('teacher'), rejectActing, requireTenant, teacherContext, stack(teacherRouters));
  app.use('/api/student', authenticate, requireRole('student'), rejectActing, requireTenant, studentContext, stack(studentRouters));
  // The school's academic years (names and dates only), so any signed-in person can look back at a past session.
  app.get('/api/shared/years', authenticate, requireTenant, async (req, res) => res.json(await AcademicYear.find({ tenantId: req.tenantId }).sort({ startDate: -1 }).select('name startDate endDate isCurrent status').lean()));
  app.use('/api/shared', authenticate, requireTenant, linkRoutes);
}
