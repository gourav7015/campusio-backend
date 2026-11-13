import { Router } from 'express';
import { requireRole, requireTenant, rejectActing } from '../middleware/auth.js';
import { forbidden } from '../core/utils.js';
import { adminContext, teacherContext, studentContext, staffContext } from '../middleware/context.js';
import authRoutes from './auth/auth.routes.js';
import platformRoutes from './platform/platform.routes.js';
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
import { adminRoutes as commsAdmin, teacherRoutes as commsTeacher, studentRoutes as commsStudent } from './comms/comms.routes.js';
import { linkRoutes, downloadRoutes } from './files/files.routes.js';
import adminTools from './admin-tools/admin.routes.js';
import staffRoutes from './staff/staff.routes.js';
import { adminRoutes as payrollAdmin, teacherRoutes as payrollTeacher } from './payroll/payroll.routes.js';
import { transportRouter, studentRoutes as transportStudent } from './transport/transport.routes.js';
import { adminRoutes as supportStaffAdmin } from './support-staff/support-staff.routes.js';
import { adminRoutes as staffAttendanceAdmin } from './staff-attendance/staff-attendance.routes.js';
import { adminRoutes as staffLeaveAdmin } from './staff-leave/staff-leave.routes.js';
import staffPortal from './staff-portal/staff.routes.js';
import insightRoutes from './insight/insight.routes.js';
import financeRoutes from './finance/finance.routes.js';
import financeStudent from './finance/finance.student.routes.js';
import libraryRoutes from './library/library.routes.js';
import { selfRoutes } from './library/library.self.routes.js';
import teacherPortal from './teacher-portal/teacher.routes.js';
import studentPortal from './student-portal/student.routes.js';

/** School Admin portal (and Super Admin acting on a chosen school). */
const adminRouters = [
  adminTools, staffRoutes, structureRoutes, studentsRoutes, teachersRoutes, assignmentsRoutes, timetableRoutes, attendanceAdmin, leaveAdmin,
  homeworkAdmin, materialsAdmin, examsAdmin, commsAdmin, payrollAdmin, supportStaffAdmin, staffAttendanceAdmin, staffLeaveAdmin, insightRoutes,
];
/** Teacher portal: every query is scoped server-side to the teacher's own active assignments. */
const teacherRouters = [selfRoutes('teacher'), teacherPortal, attendanceTeacher, leaveTeacher, homeworkTeacher, materialsTeacher, examsTeacher, commsTeacher, payrollTeacher];
/** Student portal: every query is scoped server-side to the signed-in student's own records. */
const studentRouters = [transportStudent, financeStudent, selfRoutes('student'), studentPortal, attendanceStudent, homeworkStudent, materialsStudent, examsStudent, commsStudent];

/** School Admin sees finance and library data but cannot change it. */
const viewOnly = (req, _res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) throw forbidden('The School Admin has view-only access to Finance, Library and Transport');
  next();
};

const stack = (routers) => { const r = Router(); routers.forEach((x) => r.use(x)); return r; };

export function mountModules(app, authenticate) {
  app.use('/api/auth', authRoutes);
  app.use('/api/files', downloadRoutes); // signed-token downloads (token issued only after a permission check)
  app.use('/api/platform', authenticate, platformRoutes);
  // view-only windows for the School Admin (mounted before the general /api/school stack)
  app.use('/api/school/finance', authenticate, requireRole('school_admin', 'super_admin'), requireTenant, adminContext, viewOnly, financeRoutes);
  app.use('/api/school/transport', authenticate, requireRole('school_admin', 'super_admin'), requireTenant, adminContext, viewOnly, transportRouter);
  app.use('/api/school/library', authenticate, requireRole('school_admin', 'super_admin'), requireTenant, adminContext, viewOnly, libraryRoutes);
  app.use('/api/school', authenticate, requireRole('school_admin', 'super_admin'), requireTenant, adminContext, stack(adminRouters));
  app.use('/api/finance', authenticate, requireRole('finance'), rejectActing, requireTenant, adminContext, financeRoutes);
  app.use('/api/library', authenticate, requireRole('library'), rejectActing, requireTenant, adminContext, libraryRoutes);
  app.use('/api/transport', authenticate, requireRole('transport'), rejectActing, requireTenant, adminContext, transportRouter);
  app.use('/api/staff', authenticate, requireRole('staff'), rejectActing, requireTenant, staffContext, staffPortal);
  app.use('/api/teacher', authenticate, requireRole('teacher'), rejectActing, requireTenant, teacherContext, stack(teacherRouters));
  app.use('/api/student', authenticate, requireRole('student'), rejectActing, requireTenant, studentContext, stack(studentRouters));
  app.use('/api/shared', authenticate, requireTenant, linkRoutes);
}
