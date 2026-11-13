/** Every read endpoint per role, as templates over the ids of a populated school (q). Shared by the sweep and the cross-tenant test. */
export const admin = (q) => [
    '/api/school/dashboard', '/api/school/years', '/api/school/classes', '/api/school/sections', '/api/school/subjects', `/api/school/offerings?yearId=${q.year}`, '/api/school/settings',
    '/api/school/students', `/api/school/students?sectionId=${q.section}&q=a`, `/api/school/students/${q.student}`, `/api/school/students/${q.student}/documents`,
    '/api/school/teachers', `/api/school/teachers/${q.teacher}`, '/api/school/teaching-assignments', '/api/school/class-teachers',
    '/api/school/timetable/periods', '/api/school/timetable/entries', '/api/school/timetable/unresolved', `/api/school/timetable/section/${q.section}`, '/api/school/substitutions',
    `/api/school/attendance/overview?date=${q.date}`, `/api/school/attendance/register?sectionId=${q.section}&date=${q.date}`, `/api/school/attendance/history?sectionId=${q.section}`, '/api/school/attendance/queries',
    '/api/school/leave', '/api/school/homework', '/api/school/homework?tab=published', '/api/school/materials', '/api/school/exams', `/api/school/exams/${q.exam}`, `/api/school/exams/${q.exam}/sheets`, `/api/school/exams/${q.exam}/results`,
    '/api/school/announcements', '/api/school/events', '/api/school/messages', '/api/school/notifications', '/api/school/audit', '/api/school/search?q=sha', '/api/school/reports/summary', '/api/school/imports',
    '/api/school/export/students.csv', '/api/school/export/teachers.csv', '/api/school/attendance-overview', '/api/school/staff', `/api/school/students/${q.student}/clearance`,
    '/api/school/finance/dashboard', '/api/school/finance/structures', '/api/school/finance/students', '/api/school/finance/payments', '/api/school/finance/reports/collection', '/api/school/finance/reports/classes', '/api/school/finance/lookups',
    '/api/school/library/dashboard', '/api/school/library/books', '/api/school/library/loans', '/api/school/library/settings',
  ];
export const finance = (q) => ['/api/finance/dashboard', '/api/finance/lookups', '/api/finance/structures', '/api/finance/students', '/api/finance/students?status=overdue', `/api/finance/students/${q.student}/account`, '/api/finance/payments', '/api/finance/reports/collection', '/api/finance/reports/classes', '/api/finance/export/dues.csv', '/api/finance/export/payments.csv', '/api/auth/me', '/api/auth/sessions'];
export const library = (_q) => ['/api/library/dashboard', '/api/library/books', '/api/library/books?availability=available', '/api/library/loans', '/api/library/loans?status=overdue', '/api/library/borrowers?type=student&q=aar', '/api/library/borrowers?type=teacher&q=sha', '/api/library/settings', '/api/library/export/inventory.csv', '/api/library/export/loans.csv', '/api/auth/me'];
export const teacher = (q) => [
    '/api/teacher/dashboard', '/api/teacher/years', '/api/teacher/profile', '/api/teacher/timetable', `/api/teacher/timetable?date=${q.date}`, '/api/teacher/classes', `/api/teacher/classes/${q.section}`, `/api/teacher/classes/${q.section}/students`,
    `/api/teacher/students/${q.student}`, '/api/teacher/subjects', '/api/teacher/performance', '/api/teacher/search?q=aar', `/api/teacher/attendance/register?sectionId=${q.section}&date=${q.date}`,
    `/api/teacher/attendance/history?sectionId=${q.section}`, '/api/teacher/attendance/overview', '/api/teacher/attendance/queries', '/api/teacher/leave', '/api/teacher/homework', '/api/teacher/homework?tab=draft',
    '/api/teacher/materials', '/api/teacher/exams', '/api/teacher/marks/corrections', '/api/teacher/announcements', '/api/teacher/notifications', '/api/teacher/calendar', '/api/teacher/messages',
    `/api/teacher/performance/class/${q.section}`, '/api/teacher/library/loans', '/api/teacher/library/books',
  ];
export const student = (_q) => [
    '/api/student/dashboard', '/api/student/profile', '/api/student/timetable', '/api/student/timetable?view=week', '/api/student/timetable?view=subject', '/api/student/documents',
    '/api/student/attendance/summary', '/api/student/attendance/calendar', '/api/student/attendance/monthly', '/api/student/attendance/history', '/api/student/attendance/queries',
    '/api/student/homework', '/api/student/homework?tab=due_soon', '/api/student/materials', '/api/student/exams/schedule', '/api/student/results', '/api/student/performance',
    '/api/student/announcements', '/api/student/notifications', '/api/student/calendar',
    '/api/student/fees', '/api/student/library/loans', '/api/student/library/books', '/api/student/class-results', '/api/student/attendance/heatmap',
  ];
