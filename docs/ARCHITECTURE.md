# Architecture

## Layers (API)
`routes` (HTTP + zod validation) → `service` (business rules) → `models` (Mongoose). Cross-cutting code: `core/` (config, errors, logging, dates, mark-field helpers), `middleware/` (auth, per-portal context), `services/` (audit, notifications, files, timetable/attendance/results maths, clearance, subjects).
Each feature is `src/modules/<name>/{*.routes,*.service,*.validation}.js`; `modules/index.js` mounts them per portal:

| Mount | Roles | Server-side context |
|---|---|---|
| `/api/auth` | public login (needs `portal`) / signed-in | – |
| `/api/platform` | super_admin | – |
| `/api/school` | school_admin, super_admin *(acting)* | settings, school "today", academic year |
| `/api/school/finance`, `/api/school/library` | school_admin, super_admin | **GET only** (view-only window) |
| `/api/finance` | finance | same context, no academic data |
| `/api/library` | library | same context, no academic data |
| `/api/transport` | transport | buses, crew, riders, transport staff and designations; names of classes/sections only |
| `/api/school/transport` | school_admin, super_admin *(acting)* | **GET only** window onto the transport desk |
| `/api/school/support-staff`, `/api/school/designations` | school_admin, super_admin | **general** non-teaching staff (maids, sweepers, gardeners, guards, clerks…) and the school's general designations. Transport staff and titles belong only to `/api/transport` |
| `/api/teacher` | teacher | teacher profile + **active assignments** (sections, subjects, class-teacher sections) |
| `/api/student` | student | own profile + enrolment(s) of the selected year |
| `/api/shared/files/:id/link`, `/api/files/download/:id?token=` | signed-in / token | per-file permission check, 5-minute signed link |

## Identity, tenancy, logins
* Every school-owned document carries `tenantId` taken **only** from the authenticated user. Platform Admin has none; to work in a school they send `X-Acting-School` (verified, honoured only for them, rejected on teacher/student/finance/library routes, audit-flagged).
* `POST /api/auth/login {loginId,password,portal}`: portal ∈ student|teacher|finance|library|admin|platform must match the account's role, else `403 WRONG_PORTAL` (revealed only when the password is correct).
* JWT + server-side `Session` (revocable, device list), bcrypt, lock-out after 8 failures, forced password change, rate limits.
* Role is never enough: teachers need an **active, dated assignment**; attendance needs the **class-teacher** assignment; students only ever read rows keyed by their own enrolment.

## Data model (collections)
**Academics:** `School(+settings) · Subscription · User · Session · AcademicYear · Class · Section · Subject · SubjectOffering · Student · StudentEnrolment · TransferRecord · Teacher · TeachingAssignment · ClassTeacherAssignment · TimetablePeriod · TimetableEntry · Substitution`
**Daily work:** `AttendanceSession/Record(+correction history) · AttendanceQuery · Homework · StudyMaterial · LeaveApplication · Announcement(+Read) · CalendarEvent · Notification · Message · File · ImportBatch · StudentRemark · AuditLog`
**Exams:** `Examination(type, optional section+subject scope) · ExaminationSubject(components[]) · MarksSheet · Marks(values{field→mark}) · ReportCard(versioned, immutable snapshot) · ReportRemark`
**Finance:** `FeeStructure(items, instalments) · StudentCharge(fee | library_fine | other) · Payment(payment | reversal, receiptNo)`
**Library:** `Book · BookCopy(accessionNo, status) · LibraryIssue`

Rules enforced in code (all covered by tests):
* A student is a person; an **enrolment** is year+class+section. Transfers close one enrolment and open another; promotion creates new-year enrolments and keeps the old.
* **Subjects have no master list.** They are created by name when a teacher is given them (teacher profile or section assignment), which also creates the class offering.
* **Attendance:** only the section's class teacher takes/edits the register, until it is submitted; then it is **locked for teachers**. The School Admin corrects with a reason (history keeps original/new/who/why/when); teachers send a *request correction*. Unmarked days are never "absent".
* **Exams:** every exam subject defines its own **marks fields** (e.g. Written 40 + Oral 10; default a single "Marks"); fields freeze once marks entry starts. Teachers can add unit/class/surprise tests for their own section+subject (a surprise test is not announced unless chosen). Workflow: draft → submitted → under review/returned → approved → published; published results are a `ReportCard` snapshot; corrections and remark changes create **version n+1**, never overwrite.
* **Class results:** a student sees every test of their class (a section-scoped test only its section; an unannounced test only after its results are published), everyone's marks and their own **rank** (competition ranking, ties share a rank). This deliberately overrides the original spec's caution about exposing other students' marks.
* **Money:** a payment is **immutable**; a mistake is a *reversal* entry. Charges are allocated oldest-due-first; two simultaneous receipts cannot overpay (conditional update). Library fines become a `library_fine` charge in the student's fees; unpaid fines block borrowing.
* **Clearance:** withdrawing a student or deactivating a teacher is refused while library books are out or fees unpaid, unless explicitly overridden (dues stay on the ledger).
* **Communication:** announcements/messages can be deleted by their sender (teacher: own; admin: any); the notice, read marks and bell notifications are removed, the audit log keeps the record.
* Files live outside Mongo documents; downloads need a permission check and a short-lived signed token.

## Permissions at a glance
| | Platform | School Admin | Teacher | Student | Finance | Library |
|---|---|---|---|---|---|---|
| Create schools / School Admins | ✔ | – | – | – | – | – |
| Create teachers, students, staff, structure | ✔ (acting) | ✔ | – | – | – | – |
| Take attendance | – | ✔ any | class teacher only | – | – | – |
| Correct submitted attendance | – | ✔ (reason) | request only | report only | – | – |
| Add tests / enter marks | – | ✔ | own sections+subjects | – | – | – |
| Approve & publish results | – | ✔ | – | – | – | – |
| See class results & rank | – | ✔ | own classes | own class | – | – |
| Fees: structures, billing, receipts, reversals | – | view only | – | own, read-only | ✔ | – |
| Library: books, issue/return, fines | – | view only | own loans + catalogue | own loans + catalogue | – | ✔ |

## Security controls present
Helmet, CORS allow-list, global and login rate limits, body size limit, zod validation on every body, CSV formula neutralisation, upload type/size limits + `nosniff`, signed expiring file links, audit log of sensitive actions (including every Platform-Admin action inside a school), request ids, structured logs, graceful shutdown, `/health` and `/ready`.

## Fees (monthly billing)
* A **fee structure** is an admission fee (once) plus tuition per month, plus optional extras (once / monthly / yearly). There is no "activities" head unless a school adds one. Billing creates one `StudentCharge` per item: `Admission fee`, `Tuition fee — <Month Year>` (category `Tuition`, `period` YYYY-MM) and any extras. A student who joins mid-year is billed from their joining month.
* **Transport** is billed by the same ledger: when the Transport officer seats a student on a bus, Finance bills `Transport fee — <Month>` (category `Transport`) from this month to the end of the year, using the stop's fare or the bus's default fare. Removing the student deletes the future unpaid months.
* **Fee policy** (per school, `settings.finance`): the due day of the month and the *advance-payment discount* (pay N months at once → X free months or Y% off tuition). `advancePlan` computes the offer; `payAdvance` records the concession on the waived months and then collects one payment. The student portal shows the offer read-only.
* School-wide money totals (dashboard, class report, reminders) are computed by the database (`duesRows`) and never download student records; names are fetched only for the rows shown.

## Staff attendance and payroll for everyone
* **Staff attendance** is a daily register per group — `teachers`, `general` (non-teaching) and `transport` — in `StaffAttendanceSession` / `StaffAttendanceRecord`. The School Admin marks teachers and general staff; the Transport officer marks the transport crew (the admin can read it). Everyone starts as present, teachers with an approved leave start as `leave`, and only exceptions are marked. Submitting locks the register; changes afterwards are corrections with a reason, kept in the record's history. A day with no submitted register is unknown, never an absence.
* **Payroll** works on a *person* (`personType` teacher | staff, `personId`). Pay levels have `appliesTo` (teaching | non_teaching) and can only be given to the matching group. Loss of pay for a month = approved unpaid leave + days before joining + days marked **absent** (1 day) or **half day** (0.5) in submitted registers. Teachers and staff can read only their own payslips (`/api/teacher/salary`, `/api/staff/payslips`). The Transport officer does not run payroll.

## Staff portal, punches, statutory
* **Staff portal** (`/api/staff`, role `staff`, login page `/staff/login`): own profile, attendance, check-in/out, leave applications, salary and payslips. A staff login is created from the staff record by the School Admin (general staff) or the Transport officer (transport crew) — `POST /:id/login`, `/:id/reset-password`.
* **Staff leave** (`StaffLeave`): staff apply, the desk (admin for general, transport officer for transport) approves/rejects or records leave on their behalf. Approved leave pre-fills the daily register; unpaid leave feeds loss of pay. Per-type balances come from settings `staffLeaveBalances`.
* **Punches** (`StaffPunch`, one per person per day; source `self` | `manual` | `import`): `modules/staff-punch`. Teachers and staff check in/out from their own portal; settings `staffAttendance` hold shift start/end, grace minutes, full/half-day hours and an optional location (lat, lng, radius) checked server-side with haversine. Times produce *suggestions* (late / half day) in the register; the desk decides. `POST /punches/import` accepts a machine-export CSV.
* **Statutory + bank** (`payroll.calc.js` `statutoryOf`, `payroll.service.js`): PF on min(earned basic, wage ceiling), ESI only while fixed gross ≤ ceiling, Professional Tax by slab — all from settings `statutory`, shown on the payslip. Per run: bank file (CSV), statutory report, ECR text, ESI CSV, PT CSV. TDS is not computed.
