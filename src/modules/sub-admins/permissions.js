import { forbidden } from '../../core/utils.js';

/**
 * What a sub-admin can be allowed to do. A sub-admin is a School Admin login limited to the parts listed here; everything not listed
 * (school settings, desk logins, the audit log, other sub-admins) stays with the full School Admin.
 */
export const PERMISSIONS = {
  academics: { label: 'Years, classes, sections, subjects, timetable, promotion', paths: ['years', 'classes', 'sections', 'subjects', 'offerings', 'class-teachers', 'teaching-assignments', 'timetable', 'substitutions', 'promotions'] },
  students: { label: 'Students and admissions', paths: ['students', 'imports', 'documents', 'remarks'] },
  teachers: { label: 'Teachers and teacher leave', paths: ['teachers', 'leave', 'swaps', 'attendance-exceptions'] },
  attendance: { label: 'Student attendance', paths: ['attendance', 'attendance-overview', 'monitors', 'period-attendance'] },
  staff_attendance: { label: 'Staff and teacher attendance, staff leave, non-teaching staff', paths: ['staff-attendance', 'staff-leave', 'support-staff', 'designations', 'correct', 'month', 'punches', 'register'] },
  exams: { label: 'Examinations, homework and study materials', paths: ['exams', 'marks', 'report-cards', 'sheets', 'homework', 'materials'] },
  communication: { label: 'Announcements, calendar, messages', paths: ['announcements', 'events', 'messages', 'school-info', 'licenses'] },
  payroll: { label: 'Payroll and salaries', paths: ['payroll'] },
  finance_view: { label: 'View fees, expenses and budgets', paths: ['finance'] },
  approvals: { label: 'Approve expenses, Sunday attendance and period swaps', paths: ['approvals'] },
  library_view: { label: 'View the library', paths: ['library'] },
  transport_view: { label: 'View transport', paths: ['transport'] },
  reports: { label: 'Reports and exports', paths: ['reports', 'export', 'analysis', 'sections'] },
};
export const PERMISSION_KEYS = Object.keys(PERMISSIONS);
/** Ready-made sets, e.g. a desk that only takes attendance. */
export const PRESETS = {
  attendance_desk: { label: 'Attendance desk (teachers and staff)', permissions: ['staff_attendance'] },
  student_attendance_desk: { label: 'Student attendance desk', permissions: ['attendance'] },
  office_clerk: { label: 'Office clerk (students, communication)', permissions: ['students', 'communication'] },
};

const ALWAYS = new Set(['dashboard', 'search', 'notifications', 'me', 'helpdesk']); // helpdesk: everyone may write to Campusio support
const LOOKUPS = new Set(['years', 'classes', 'sections', 'subjects', 'designations', 'offerings']); // read-only lists every page needs
const OWNER = { settings: 1, staff: 1, audit: 1, 'sub-admins': 1 };

/** Is this request allowed for a sub-admin holding these permissions? The first segment of the path decides. */
export function subAdminMay(perms, method, path) {
  const seg = path.split('/').filter(Boolean)[0];
  if (!seg || ALWAYS.has(seg)) return true;
  if (OWNER[seg]) return false;
  if (['GET', 'HEAD'].includes(method) && LOOKUPS.has(seg)) return true;
  return perms.some((k) => PERMISSIONS[k]?.paths.includes(seg));
}

/** Sits in front of the School Admin routes. A full admin passes untouched. `segment` is given for the view-only windows (finance, library, transport). */
export const subAdminGate = (segment) => (req, _res, next) => {
  const u = req.user;
  if (u.role === 'school_admin' && u.adminLevel === 'sub' && !subAdminMay(u.permissions || [], req.method, segment || req.path)) {
    throw forbidden('Your sub-admin account does not include this part of the school portal');
  }
  next();
};
