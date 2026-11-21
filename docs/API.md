# API reference

Generated from the source by `npm run docs:api` (do not edit by hand). Every address also works as `/api/v1/...`.
Routes are listed per file; the file is mounted under a portal prefix in `src/modules/index.js` (`/api/school`, `/api/teacher`, `/api/student`, `/api/finance`, `/api/library`, `/api/transport`, `/api/staff`, `/api/platform`, `/api/auth`). Bodies are validated with zod in the matching `*.validation.js` or at the top of the routes file. Errors are `{ error, code, details? }`; a `Idempotency-Key` header makes a POST safe to repeat.

## admin-tools/admin.routes.js

| Method | Path |
|---|---|
| GET | `/dashboard` |
| GET | `/audit` |
| GET | `/search` |
| GET | `/reports/summary` |
| GET | `/export/students.csv` |
| GET | `/export/teachers.csv` |
| GET | `/export/attendance.csv` |
| GET | `/export/results.csv` |
| POST | `/promotions/preview` |
| POST | `/promotions/commit` |
| GET | `/imports` |
| POST | `/imports/students` |
| POST | `/imports/teachers` |
| POST | `/imports/:id/rollback` |
| GET | `/${path}/:id/documents` |
| POST | `/${path}/:id/documents` |
| POST | `/${path}/:id/photo` |
| DELETE | `/documents/:id` |
| GET | `/attendance-overview` |

## assignments/assignments.routes.js

| Method | Path |
|---|---|
| GET | `/teaching-assignments` |
| POST | `/teaching-assignments` |
| POST | `/teaching-assignments/:id/end` |
| GET | `/class-teachers` |
| PUT | `/sections/:id/class-teacher` |
| DELETE | `/sections/:id/class-teacher` |

## attendance/attendance.admin.routes.js

| Method | Path |
|---|---|
| GET | `/attendance/overview` |
| GET | `/attendance/register` |
| GET | `/attendance/history` |
| PUT | `/attendance/register` |
| POST | `/attendance/register/submit` |
| POST | `/attendance/correct` |
| GET | `/attendance/queries` |
| POST | `/attendance/queries/:id/resolve` |

## attendance/attendance.student.routes.js

| Method | Path |
|---|---|
| GET | `/attendance/summary` |
| GET | `/attendance/calendar` |
| GET | `/attendance/heatmap` |
| GET | `/attendance/monthly` |
| GET | `/attendance/history` |
| GET | `/attendance/queries` |
| POST | `/attendance/queries` |

## attendance/attendance.teacher.routes.js

| Method | Path |
|---|---|
| GET | `/attendance/register` |
| PUT | `/attendance/register` |
| POST | `/attendance/register/submit` |
| POST | `/attendance/request-correction` |
| GET | `/attendance/history` |
| GET | `/attendance/overview` |
| GET | `/attendance/queries` |
| POST | `/attendance/queries/:id/resolve` |

## auth/auth.admin.routes.js

| Method | Path |
|---|---|
| POST | `/users/:id/reset-2fa` |

## auth/auth.routes.js

| Method | Path |
|---|---|
| POST | `/login` |
| POST | `/login/2fa` |
| GET | `/options` |
| POST | `/forgot` |
| POST | `/reset` |
| GET | `/me` |
| POST | `/logout` |
| POST | `/change-password` |
| POST | `/refresh` |
| POST | `/2fa/setup` |
| POST | `/2fa/enable` |
| POST | `/2fa/disable` |
| POST | `/2fa/recovery-codes` |
| GET | `/sessions` |
| POST | `/sessions/revoke-others` |
| DELETE | `/sessions/:id` |
| PATCH | `/preferences` |

## class-life/class-life.routes.js

| Method | Path |
|---|---|
| POST | `/students/:id/remarks` |
| GET | `/remarks` |
| POST | `/remarks/:id/remind` |
| PATCH | `/students/:id` |
| GET | `/chats` |
| POST | `/chats` |
| GET | `/chats/:id` |
| POST | `/chats/:id/messages` |
| PUT | `/classes/:sectionId/monitors` |
| POST | `/attendance/regularise` |
| POST | `/profile/photo` |
| POST | `/remarks/:id/acknowledge` |
| GET | `/chat-teachers` |
| PUT | `/monitors/:sectionId` |

## client-errors.js

| Method | Path |
|---|---|
| POST | `/` |

## comms/comms.routes.js

| Method | Path |
|---|---|
| GET | `/announcements` |
| GET | `/announcements/:id` |
| POST | `/announcements/:id/read` |
| GET | `/notifications` |
| POST | `/notifications/read-all` |
| POST | `/notifications/:id/read` |
| GET | `/calendar` |
| POST | `/announcements` |
| DELETE | `/announcements/:id` |
| DELETE | `/messages/:id` |
| GET | `/messages` |
| POST | `/messages` |
| PATCH | `/announcements/:id` |
| POST | `/announcements/:id/archive` |
| POST | `/announcements/:id/attachments` |
| POST | `/events/government-holidays` |
| GET | `/events` |
| POST | `/events` |
| PATCH | `/events/:id` |
| DELETE | `/events/:id` |
| POST | `/messages/:id/read` |

## document-settings/document-settings.routes.js

| Method | Path |
|---|---|
| GET | `/document-settings` |
| PUT | `/document-settings` |
| POST | `/document-settings/logo` |
| DELETE | `/document-settings/logo` |
| POST | `/document-settings/assets` |
| PUT | `/document-settings/assets/:id` |
| DELETE | `/document-settings/assets/:id` |
| GET | `/document-settings/sample/receipt` |
| GET | `/document-settings/sample/payslip` |

## employees/employees.routes.js

| Method | Path |
|---|---|
| GET | `/employees` |

## exams/exams.routes.js

| Method | Path |
|---|---|
| GET | `/exams` |
| POST | `/exams` |
| POST | `/exams/standard` |
| GET | `/exams/:id/datesheet` |
| PUT | `/exams/:id/datesheet` |
| POST | `/exams/:id/datesheet/standard-subjects` |
| POST | `/exams/:id/datesheet/subjects` |
| GET | `/exams/:id` |
| PATCH | `/exams/:id` |
| DELETE | `/exams/:id` |
| PUT | `/exams/:id/subjects` |
| POST | `/exams/:id/subjects/generate` |
| DELETE | `/exams/:id/subjects/:esId` |
| POST | `/exams/:id/publish-schedule` |
| GET | `/exams/:id/sheets` |
| GET | `/sheets/:id` |
| POST | `/sheets/:id/start-review` |
| POST | `/sheets/:id/approve` |
| POST | `/sheets/:id/return` |
| POST | `/exams/:id/publish` |
| POST | `/marks/:id/correct` |
| PUT | `/exams/:id/remarks` |
| GET | `/exams/:id/results` |
| GET | `/report-cards/:id` |
| GET | `/report-cards/:id/pdf` |
| GET | `/marks/sheet` |
| PUT | `/marks/sheet` |
| POST | `/marks/sheet/submit` |
| POST | `/marks/import` |
| GET | `/marks/corrections` |
| GET | `/exams/schedule` |
| GET | `/results` |
| GET | `/results/:examId` |
| GET | `/results/:examId/pdf` |
| GET | `/class-results` |
| GET | `/class-results/:examId` |
| GET | `/performance` |

## files/files.routes.js

| Method | Path |
|---|---|
| POST | `/files/:id/link` |
| GET | `/download/:id` |

## finance/expenses.routes.js

| Method | Path |
|---|---|
| GET | `/expenses` |
| POST | `/expenses` |
| PATCH | `/expenses/:id` |
| DELETE | `/expenses/:id` |
| GET | `/budgets` |
| PUT | `/budgets` |
| DELETE | `/budgets/:id` |
| GET | `/school-finance-profile` |
| PUT | `/school-finance-profile` |
| GET | `/approvals` |
| POST | `/approvals/expenses/:id` |

## finance/finance.routes.js

| Method | Path |
|---|---|
| GET | `/dashboard` |
| GET | `/lookups` |
| GET | `/structures` |
| POST | `/structures` |
| PATCH | `/structures/:id` |
| DELETE | `/structures/:id` |
| POST | `/assign` |
| GET | `/students` |
| GET | `/students/:id/account` |
| PUT | `/students/:id/personal-discount` |
| DELETE | `/students/:id/personal-discount` |
| POST | `/charges` |
| POST | `/charges/:id/concession` |
| GET | `/online-payments` |
| GET | `/payments` |
| POST | `/payments` |
| POST | `/payments/:id/reverse` |
| GET | `/payments/:id/receipt.pdf` |
| GET | `/policy` |
| PUT | `/policy` |
| GET | `/students/:id/advance-plan` |
| POST | `/students/:id/advance-payment` |
| GET | `/reports/collection` |
| GET | `/reports/defaulters-by-class` |
| GET | `/reports/classes` |
| POST | `/reminders` |
| GET | `/export/defaulters-by-class.csv` |
| GET | `/export/payments.csv` |
| GET | `/export/dues.csv` |

## finance/finance.student.routes.js

| Method | Path |
|---|---|
| GET | `/fees` |
| GET | `/fees/receipts/:id.pdf` |

## helpdesk/helpdesk.routes.js

| Method | Path |
|---|---|
| GET | `/summary` |
| GET | `/` |
| POST | `/` |
| GET | `/:id` |
| POST | `/:id/replies` |
| POST | `/:id/files/:fileId/link` |
| POST | `/:id/close` |
| PATCH | `/:id` |

## homework/homework.routes.js

| Method | Path |
|---|---|
| GET | `/homework` |
| POST | `/homework` |
| GET | `/homework/:id` |
| PATCH | `/homework/:id` |
| POST | `/homework/:id/${action}` |
| DELETE | `/homework/:id` |
| POST | `/homework/:id/attachments` |
| DELETE | `/homework/:id/attachments/:fileId` |

## houses/houses.routes.js

| Method | Path |
|---|---|
| GET | `/houses` |
| POST | `/houses` |
| POST | `/houses/distribute` |
| GET | `/houses/:id` |
| PATCH | `/houses/:id` |
| DELETE | `/houses/:id` |
| PUT | `/houses/teachers/:teacherId` |
| GET | `/house` |

## insight/insight.routes.js

| Method | Path |
|---|---|
| GET | `/sections/:id/insight` |
| GET | `/sections/:id/students` |
| GET | `/sections/:id/homework` |
| GET | `/analysis/overview` |
| GET | `/analysis/students/:id` |
| GET | `/analysis/exams` |
| GET | `/teachers/:id/overview` |
| GET | `/students/:id/overview` |

## leave-grants/leave-grants.routes.js

| Method | Path |
|---|---|
| GET | `/leave-balances` |
| GET | `/leave-balances/grants` |
| POST | `/leave-balances/grants` |
| DELETE | `/leave-balances/grants/:id` |

## leave/leave.routes.js

| Method | Path |
|---|---|
| GET | `/leave` |
| POST | `/leave` |
| POST | `/leave/:id/submit` |
| POST | `/leave/:id/cancel` |
| GET | `/leave/:id/affected-periods` |
| POST | `/leave/:id/decide` |

## library/library.routes.js

| Method | Path |
|---|---|
| GET | `/dashboard` |
| GET | `/lookups` |
| GET | `/class-borrowers` |
| GET | `/books` |
| POST | `/books` |
| GET | `/books/:id` |
| PATCH | `/books/:id` |
| DELETE | `/books/:id` |
| POST | `/books/:id/copies` |
| PATCH | `/copies/:id` |
| GET | `/borrowers` |
| POST | `/issue` |
| POST | `/return` |
| POST | `/loans/:id/renew` |
| GET | `/loans` |
| POST | `/reminders` |
| GET | `/settings` |
| PUT | `/settings` |
| GET | `/export/inventory.csv` |
| GET | `/export/loans.csv` |

## library/library.self.routes.js

| Method | Path |
|---|---|
| GET | `/library/loans` |
| GET | `/library/books` |

## materials/materials.routes.js

| Method | Path |
|---|---|
| GET | `/materials` |
| POST | `/materials` |
| PATCH | `/materials/:id` |
| POST | `/materials/:id/${action}` |
| POST | `/materials/:id/file` |
| DELETE | `/materials/:id` |
| GET | `/materials/:id` |

## payments/payments.routes.js

| Method | Path |
|---|---|
| POST | `/fees/pay` |
| POST | `/fees/pay/verify` |
| GET | `/fees/orders/:id` |
| POST | `/fees/orders/:id/test-pay` |
| POST | `/webhook` |

## payroll/payroll.routes.js

| Method | Path |
|---|---|
| GET | `/payroll/summary` |
| GET | `/payroll/levels` |
| POST | `/payroll/levels` |
| PATCH | `/payroll/levels/:id` |
| DELETE | `/payroll/levels/:id` |
| GET | `/payroll/salaries` |
| POST | `/payroll/salaries/bulk` |
| GET | `/payroll/salaries/:personId` |
| POST | `/payroll/salaries/:personId` |
| GET | `/payroll/runs` |
| POST | `/payroll/runs` |
| GET | `/payroll/runs/:id` |
| POST | `/payroll/runs/:id/recalculate` |
| DELETE | `/payroll/runs/:id` |
| POST | `/payroll/runs/:id/approve` |
| POST | `/payroll/runs/:id/pay` |
| GET | `/payroll/runs/:id/bank-file` |
| GET | `/payroll/runs/:id/bank-file.csv` |
| GET | `/payroll/runs/:id/statutory` |
| GET | `/payroll/runs/:id/statutory/pf-ecr.txt` |
| GET | `/payroll/runs/:id/statutory/esi.csv` |
| GET | `/payroll/runs/:id/statutory/pt.csv` |
| GET | `/payroll/runs/:id/export.csv` |
| PATCH | `/payroll/payslips/:id/adjustments` |
| POST | `/payroll/payslips/:id/pay` |
| GET | `/payroll/payslips/:id/pdf` |
| GET | `/salary` |
| GET | `/payslips` |
| GET | `/payslips/:id/pdf` |

## platform/platform.routes.js

| Method | Path |
|---|---|
| GET | `/errors` |
| DELETE | `/errors` |
| GET | `/schools/:id/flags` |
| PUT | `/schools/:id/flags` |
| POST | `/users/:id/reset-2fa` |
| GET | `/stats` |
| GET | `/schools` |
| POST | `/schools` |
| GET | `/schools/:id` |
| PATCH | `/schools/:id` |
| PUT | `/schools/:id/subscription` |
| POST | `/schools/:id/admins` |
| POST | `/users/:id/reset-password` |
| PATCH | `/users/:id` |
| GET | `/audit` |

## privacy/privacy.routes.js

| Method | Path |
|---|---|
| GET | `/privacy/consent-summary` |
| GET | `/privacy/students/:id` |
| PUT | `/privacy/students/:id/consent` |
| DELETE | `/privacy/students/:id/consent` |
| GET | `/privacy/students/:id/export` |
| POST | `/privacy/students/:id/erase` |

## scheduling/scheduling.routes.js

| Method | Path |
|---|---|
| GET | `/swaps` |
| GET | `/swaps/colleagues` |
| GET | `/swaps/periods` |
| POST | `/swaps` |
| POST | `/swaps/:id/respond` |
| POST | `/swaps/:id/cancel` |
| GET | `/attendance/exceptions` |
| POST | `/attendance/exceptions` |
| GET | `/period-attendance` |
| GET | `/period-attendance/register` |
| PUT | `/period-attendance/register` |
| POST | `/approvals/swaps/:id` |
| GET | `/attendance-exceptions` |
| POST | `/attendance-exceptions` |
| POST | `/approvals/attendance-exceptions/:id` |
| PATCH | `/leave/:id` |

## school-info/school-info.routes.js

| Method | Path |
|---|---|
| GET | `/school-info` |
| PUT | `/school-info` |
| POST | `/school-info/gallery` |
| DELETE | `/school-info/gallery/:itemId` |
| GET | `/licenses` |
| POST | `/licenses` |
| PATCH | `/licenses/:id` |
| DELETE | `/licenses/:id` |
| POST | `/licenses/:id/file` |

## staff-attendance/staff-attendance.routes.js

| Method | Path |
|---|---|
| GET | `/register` |
| PUT | `/register` |
| POST | `/correct` |
| POST | `/punches/import` |
| GET | `/month` |

## staff-leave/staff-leave.routes.js

| Method | Path |
|---|---|
| GET | `/` |
| POST | `/` |
| GET | `/policy` |
| POST | `/:id/pass-to-admin` |
| POST | `/:id/decide` |
| PATCH | `/:id` |

## staff-portal/staff.routes.js

| Method | Path |
|---|---|
| GET | `/profile` |
| PATCH | `/profile` |
| GET | `/dashboard` |
| GET | `/people` |
| GET | `/employees` |

## staff-punch/staff-punch.routes.js

| Method | Path |
|---|---|
| GET | `/punch` |
| POST | `/punch/check-in` |
| POST | `/punch/check-out` |

## staff/staff.routes.js

| Method | Path |
|---|---|
| GET | `/staff` |
| POST | `/staff` |
| PATCH | `/staff/:id` |
| POST | `/staff/:id/reset-password` |

## structure/structure.routes.js

| Method | Path |
|---|---|
| GET | `/years` |
| POST | `/years` |
| POST | `/years/rollover` |
| PATCH | `/years/:id` |
| POST | `/years/:id/set-current` |
| POST | `/years/:id/close` |
| GET | `/classes` |
| POST | `/classes` |
| PATCH | `/classes/:id` |
| DELETE | `/classes/:id` |
| GET | `/sections` |
| POST | `/sections` |
| PATCH | `/sections/:id` |
| DELETE | `/sections/:id` |
| GET | `/subjects` |
| GET | `/offerings` |
| POST | `/offerings/copy` |
| PATCH | `/offerings/:id` |
| GET | `/settings` |
| PUT | `/settings` |

## student-portal/student.routes.js

| Method | Path |
|---|---|
| GET | `/dashboard` |
| GET | `/profile` |
| PATCH | `/profile` |
| POST | `/profile/photo` |
| GET | `/timetable` |
| GET | `/documents` |

## students/students.routes.js

| Method | Path |
|---|---|
| GET | `/students` |
| GET | `/students/fee-preview` |
| POST | `/students/bulk` |
| POST | `/students` |
| GET | `/students/:id` |
| PATCH | `/students/:id` |
| POST | `/students/:id/transfer` |
| GET | `/students/:id/clearance` |
| POST | `/students/:id/withdraw` |
| POST | `/students/:id/reactivate` |
| DELETE | `/students/:id` |
| POST | `/students/:id/reset-password` |

## sub-admins/sub-admins.routes.js

| Method | Path |
|---|---|
| GET | `/sub-admins/options` |
| GET | `/sub-admins` |
| POST | `/sub-admins` |
| PATCH | `/sub-admins/:id` |
| POST | `/sub-admins/:id/reset-password` |

## support-staff/support-staff.routes.js

| Method | Path |
|---|---|
| GET | `/` |
| POST | `/` |
| GET | `/:id` |
| PATCH | `/:id` |
| POST | `/:id/login` |
| POST | `/:id/remove-login` |
| POST | `/:id/reset-password` |
| POST | `/:id/${path}` |
| DELETE | `/:id` |

## teacher-portal/teacher.routes.js

| Method | Path |
|---|---|
| GET | `/dashboard` |
| GET | `/my-attendance` |
| GET | `/years` |
| GET | `/profile` |
| PATCH | `/profile` |
| GET | `/timetable` |
| GET | `/classes` |
| GET | `/classes/:sectionId` |
| GET | `/classes/:sectionId/students` |
| GET | `/students/:id` |
| GET | `/subjects` |
| GET | `/performance` |
| GET | `/performance/class/:sectionId` |
| GET | `/search` |

## teachers/teachers.routes.js

| Method | Path |
|---|---|
| GET | `/teachers` |
| POST | `/teachers` |
| GET | `/teachers/:id` |
| PATCH | `/teachers/:id` |
| POST | `/teachers/:id/deactivate` |
| POST | `/teachers/:id/reactivate` |
| POST | `/teachers/:id/reset-password` |

## timetable/timetable.routes.js

| Method | Path |
|---|---|
| GET | `/timetable/periods` |
| POST | `/timetable/periods` |
| PATCH | `/timetable/periods/:id` |
| DELETE | `/timetable/periods/:id` |
| GET | `/timetable/export` |
| GET | `/timetable/entries` |
| GET | `/timetable/unresolved` |
| GET | `/timetable/section/:id` |
| POST | `/timetable/entries` |
| PATCH | `/timetable/entries/:id` |
| DELETE | `/timetable/entries/:id` |
| GET | `/substitutions` |
| POST | `/substitutions` |
| DELETE | `/substitutions/:id` |

## transport/transport.routes.js

| Method | Path |
|---|---|
| GET | `/dashboard` |
| GET | `/lookups` |
| GET | `/students` |
| GET | `/buses` |
| POST | `/buses` |
| GET | `/buses/:id` |
| PATCH | `/buses/:id` |
| DELETE | `/buses/:id` |
| POST | `/assign` |
| DELETE | `/students/:studentId` |
| GET | `/transport` |

_497 routes in 46 files._
