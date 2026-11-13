Continuing the specification, the next sections cover the complete Teacher and Student experiences, followed by the relationships between all entities, operational workflows, edge cases and the rules that must be enforced in the backend.
Part D. Teacher portal
The teacher portal should be designed around one principle:

A teacher should immediately know what class they have to teach, what work is pending, which students need attention and what they need to complete today.

A teacher should not have to navigate through the entire school's administrative system.
19. Teacher dashboard UI








dribbble.com


19.1 Teacher sidebar

Teacher Portal
Mr. Sharma · Mathematics


Dashboard

My Timetable

My Classes

My Subjects

Attendance

Homework & Assignments

Study Materials

Examinations

Marks Entry

Student Performance

Communication

Leave Management

My Profile


19.2 Header
The header should display:
- Teacher's name and profile image.
- Current academic year.
- Current date.
- Notification bell.
- Messages indicator.
- Quick search.
- Profile menu.
- Logout.
The academic year should be visible because a teacher might have assignments in multiple academic sessions, especially when reviewing historical results.
19.3 Welcome section
Example:

"Good morning, Mr. Sharma"

"Here is your teaching schedule and pending work for today."

Display:
- Today's date.
- Current day.
- First upcoming class.
- Number of assigned classes today.
19.4 Dashboard summary cards
142
Assigned students
Across assigned sections

5
Assigned classes
Across this academic year

2
Pending attendance
Registers not submitted

4
Active assignments
Awaiting completion or review


These are example values to illustrate the design, not actual school data.
19.5 Today's timetable








emstudio.pro


Display a vertical schedule or timetable grid.
Time	Class	Subject	Section	Action
8:00–8:40	8	Mathematics	A	Open class
8:40–9:20	9	Mathematics	B	Open class
9:20–10:00	7	Mathematics	C	Open class
10:20–11:00	8	Mathematics	B	Open class

Each class card should show:
- Class and section.
- Subject.
- Period.
- Room number.
- Number of enrolled students.
- Class attendance status.
- Quick action.
When the teacher clicks a class, open the class workspace.
19.6 Quick action buttons
Place these near the top of the dashboard:
- Mark attendance.
- Create homework.
- Upload study material.
- Enter examination marks.
- View timetable.
- View my classes.
Only show actions the teacher is permitted to perform.
19.7 Attendance overview
Show a small attendance summary:
- Total students in assigned classes.
- Present today.
- Absent today.
- Leave.
- Registers pending.
Graph: Weekly attendance percentage across assigned sections.

The teacher can click a class to open its attendance history.
19.8 Homework overview
Show:
- Published homework.
- Draft homework.
- Upcoming deadlines.
- Overdue assignments.
- Submission/review status, if submissions are enabled.
Graph: Homework completion or submission percentage by assignment.
19.9 Examination overview
Show:
- Upcoming examinations.
- Marks-entry deadlines.
- Marks awaiting submission.
- Marks returned for correction.
- Completed marks entries.
19.10 Student performance overview
A teacher may see performance only for assigned subjects and students.

Graphs:
1. Average marks by examination.
2. Student performance distribution.
3. Subject-wise score trends.
4. Attendance versus academic performance, if the school enables this analysis.
Avoid displaying sensitive rankings publicly. A teacher's private performance view can identify students needing support without exposing unnecessary information to other students.
19.11 Recent activity
A timeline showing:
- Homework published.
- Attendance submitted.
- Study material uploaded.
- Marks entered.
- Marks approved.
- New school announcements.
Each item links to the relevant record.

20. Teacher – My Classes
This is the teacher's primary workspace.








dribbble.com


Class directory
Display only classes and sections assigned to the teacher.

Example:
Class	Section	Subject	Students	Role
8	A	Mathematics	35	Subject teacher
8	B	Mathematics	32	Subject teacher
9	B	Mathematics	38	Subject teacher
7	C	Mathematics	37	Class teacher + subject teacher

A teacher may teach the same subject in multiple sections.
Class workspace tabs
When a teacher opens Class 8-A:
1. Overview.
2. Students.
3. Attendance.
4. Timetable.
5. Homework.
6. Study materials.
7. Examinations.
8. Marks.
9. Performance.
10. Activity history.
Class overview
Display:
- Class name.
- Section.
- Subject.
- Class teacher, if applicable.
- Student count.
- Current academic year.
- Next scheduled period.
- Attendance completion.
- Upcoming exam.
- Active homework.
Student directory
Roll number	Student	Attendance	Latest score	Action
01	Student A	95%	87	View
02	Student B	91%	72	View
03	Student C	82%	64	View

Teacher permissions determine which columns are visible.
Student detail for teacher
Tabs:
- Profile summary.
- Attendance.
- Subject marks.
- Homework.
- Teacher remarks.
- Academic history.
Teachers should not see confidential financial records, personal documents or unrelated administrative details merely because they teach that student.

21. Teacher – My Subjects
A teacher may teach several subjects across several sections.

The subject page should show:
- Subject name.
- Subject code.
- Assigned classes.
- Assigned sections.
- Weekly periods.
- Examination structure.
- Subject materials.
- Homework.
- Marks-entry status.
Example:
Mathematics
5 teaching assignments
Academic year 2026–2027

- Class 7-C
- Class 8-A
- Class 8-B
- Class 9-A
- Class 9-B

The teacher should be able to switch between these assignments without repeatedly searching for the subject.

22. Teacher – Attendance screen








schoolbandhu.com


Attendance workflow
1. Select date.
2. Select assigned class and section.
3. Select subject-independent daily attendance register.
4. Load enrolled students.
5. Mark attendance.
6. Review totals.
7. Submit attendance.
The daily attendance register should normally be independent of individual subject periods, unless the school explicitly uses period-wise attendance.
Attendance interface
Roll	Student	Status
01	Student A	Present
02	Student B	Absent
03	Student C	Present
04	Student D	Late

Quick controls:
- Mark all present.
- Mark selected absent.
- Mark leave.
- Search student.
- Filter status.
- Add remarks.
- Save draft.
- Submit.
After submission, show:
- Total students.
- Present.
- Absent.
- Leave.
- Late.
- Submission time.
Attendance corrections
If attendance is submitted, editing should require a defined permission and a reason.

Record:
- Original status.
- New status.
- Changed by.
- Reason.
- Timestamp.
Do not silently replace the original record.

23. Teacher – Homework and assignments








info.teamsatchel.com


Create homework
Fields:
- Title.
- Description.
- Subject.
- Class.
- Section.
- Assignment type.
- Assigned date.
- Due date.
- Attachments.
- Maximum marks, optional.
- Instructions.
- Submission required: Yes/No.
- Visibility: Draft/Scheduled/Published.
Homework assignment types
- Written work.
- Reading.
- Project.
- Worksheet.
- Practical activity.
- Revision.
- Other.
Homework directory
Tabs:
- All.
- Draft.
- Published.
- Scheduled.
- Completed.
- Archived.
Homework detail
Show:
- Description.
- Assigned class and section.
- Publication date.
- Due date.
- Attached files.
- Submission status.
- Teacher feedback.
- Edit history.
If online submissions are enabled in a future version, add:
- Student submission file.
- Submission timestamp.
- Late submission flag.
- Marks.
- Feedback.
- Resubmission history.
For your first version, publishing homework and study materials is enough. Full online assignment submission can be a later feature.

24. Teacher – Study materials
Teachers should be able to upload learning materials for their assigned classes.

Supported material types:
- PDF.
- Images.
- Documents.
- Presentations.
- External video links.
- Worksheets.
Material form
- Title.
- Description.
- Subject.
- Class.
- Section.
- File or external link.
- Publication date.
- Visibility.
- Expiry date, optional.
Material directory
Filters:
- Subject.
- Class.
- Section.
- Upload date.
- Publication status.
Teachers can:
- Upload.
- Preview.
- Edit metadata.
- Publish.
- Unpublish.
- Replace file.
- Archive.
Students should only access materials that are published and applicable to their current enrolment.

25. Teacher – Examination and marks entry








ticket.aorasoft.com


Examination list
Show:
- Examination.
- Academic year.
- Class.
- Subject.
- Exam date.
- Maximum marks.
- Submission deadline.
- Marks status.
Marks entry table
Roll	Student	Theory	Practical	Total
01	Student A	72	18	90
02	Student B	60	15	75
03	Student C	50	16	66

This is illustrative; the total calculation should follow the school's configured assessment scheme.
Features
- Auto-save draft.
- Bulk marks import.
- Validation.
- Mark absent.
- Mark exempt, if applicable.
- Add remarks.
- Submit for approval.
- View correction requests.
Marks status
Not Started → Draft → Submitted → Under Review → Approved → Published

The teacher must not change published results without a formal correction process.

26. Teacher – Communication
Teachers need controlled communication tools.

Features:
- View school announcements.
- View class-specific notices.
- Send permitted messages to administrators.
- Send permitted communication to parents, once parent functionality is introduced.
- Receive examination and timetable updates.
- Receive assignment and attendance reminders.
The system should record message delivery status and enforce school communication policies.

27. Teacher – Leave management
Apply for leave
Fields:
- Leave type.
- Start date.
- End date.
- Number of days.
- Reason.
- Attachment, if required.
Leave status
- Draft.
- Submitted.
- Approved.
- Rejected.
- Cancelled.
The teacher can see:
- Leave balance, if the school maintains it.
- Previous applications.
- Approval status.
- Remarks.
Leave approval should be handled by the authorized administrator, not automatically approved by the teacher's own account.

Part E. Student portal
This is the most important user experience from the student's perspective.

A student should not see administrative complexity. The dashboard should feel like a personal academic companion.

The student must be able to answer five questions immediately:
1. What classes do I have today?
2. What homework do I need to complete?
3. How is my attendance?
4. When are my examinations?
5. What are my latest academic results?
28. Student dashboard UI








techxsolutions.in


28.1 Student sidebar

Student Portal
Rahul Sharma · Class 8-A


Dashboard

My Profile

My Timetable

My Attendance

Homework & Assignments

Study Materials

Examinations

Results & Report Cards

My Performance

School Calendar

Announcements

Fee Information

My Documents

Settings


For the student portal, the fee page is read-only in the initial four-role system. Payment functionality can later be exposed to parents or authorized guardians.
28.2 Student header
Display:
- Student's profile image.
- Student name.
- Class and section.
- Admission number, if useful.
- Current academic year.
- Notification bell.
- Profile menu.
- Logout.
The student should not be able to change their class, section, roll number or admission number.
28.3 Welcome banner
Example:
Good morning, Rahul! 👋
Your academic overview for Thursday, 12 November.

Class 8-A · Academic Year 2026–2027
Enrolled
Today's schedule available


You can make this greeting dynamic based on the student's local school timezone.
28.4 Student dashboard summary cards
94.5%
Attendance
Current academic year

4
Pending homework
Due assignments

12
Completed exams
This academic year

86%
Latest average
Latest published examination


These figures must be calculated from actual records. Don't display fabricated default statistics when the student has no results or attendance history.
28.5 Today's timetable widget








heloix.com


Display a list of today's periods:
Period	Time	Subject	Teacher
1	8:00–8:40	Mathematics	Mr. Sharma
2	8:40–9:20	English	Mrs. Gupta
3	9:20–10:00	Science	Mr. Verma
4	10:20–11:00	Hindi	Mrs. Singh

Each period card should show:
- Subject.
- Teacher.
- Time.
- Room number.
- Current/next/completed status.
- Optional learning-material link.
If there is no timetable for a day, show "No scheduled classes" rather than an empty table.
28.6 Attendance widget








dribbble.com


Display:
- Overall attendance percentage.
- Total working days.
- Present days.
- Absent days.
- Leave days.
- Late days, if tracked.
A progress indicator can show the overall attendance percentage.

Below it, show a monthly attendance calendar.

Suggested colors:
- Green: Present.
- Red: Absent.
- Yellow: Late.
- Blue: Approved leave.
- Grey: No attendance recorded or non-working day.
Do not treat an unmarked register as an absent day.
28.7 Attendance graph
A monthly line chart:
- X-axis: Dates or months.
- Y-axis: Attendance percentage.
- Range: Current academic year.
A second graph can show monthly present/absent counts.

Clicking the chart opens detailed attendance history.
28.8 Homework widget
Show the next five pending assignments:
Subject	Homework	Due date	Status
Mathematics	Exercise 4	14 Nov	Pending
Science	Chapter 6	15 Nov	Pending
English	Essay	16 Nov	Submitted, if enabled

The widget should allow:
- Open homework.
- Download attachment.
- View instructions.
- View deadline.
- Submit work, if online submission is enabled.
Show overdue assignments distinctly.
28.9 Upcoming examination widget
Display:
- Examination name.
- Subject.
- Date.
- Start time.
- Room.
- Days remaining.
Example:
Upcoming examination
Mathematics
Unit Test 2 · 18 November
6 days left

10:00 AM · Room 204

The countdown should use the school's configured timezone.
28.10 Latest results widget
Display:
- Latest published examination.
- Overall percentage.
- Grade.
- Result status.
- Subject-wise performance.
Clicking "View Result" opens the full report card.
28.11 Performance graph








school.synergy.ru


Suggested graphs:

1. Examination performance trend

Line chart showing the student's percentage in each published examination.

2. Subject-wise performance

Bar chart showing the latest examination percentage by subject.

3. Grade distribution

Donut chart showing the student's grade distribution across subjects in a selected examination.

4. Attendance trend

Monthly attendance percentage.

5. Personal improvement

Compare the student's latest result against their previous result in the same subject.

Important: Show only published marks. Do not expose draft marks or another student's performance.
28.12 School announcements widget
Display the most recent announcements:
- Holiday notice.
- Examination schedule.
- School event.
- Homework reminder.
- General school notice.
Each announcement should show:
- Title.
- Category.
- Date.
- Description.
- Attachments.
- Read/unread status.
28.13 Calendar widget
Display:
- Examinations.
- Holidays.
- School events.
- Homework deadlines.
- Important dates.
Students should be able to switch between:
- Monthly view.
- Weekly view.
- Agenda view.
28.14 Recent activity widget
Examples:
- New Mathematics homework published.
- Science study material uploaded.
- Attendance marked for today.
- Half-yearly results published.
- New school announcement.
Every activity should link to its actual record.

29. Student – My Profile


Profile sections
Personal information
- Name.
- Date of birth.
- Profile photo.
- Gender, if collected.
- Address.
Academic information
- Admission number.
- Current academic year.
- Class.
- Section.
- Roll number.
- Admission date.
- School name.
Guardian information
- Guardian names.
- Relationship.
- Authorized contact details.
Other information
- School house.
- Transport assignment, if enabled.
- Emergency contact information, where appropriate.
Students can update only fields explicitly permitted by the school. Changes to critical personal details should require administrative verification.

30. Student – My Timetable








schoolap.com


Provide three views:
1. Daily timetable.
2. Weekly timetable.
3. Subject-wise timetable.
Each timetable entry shows:
- Period.
- Subject.
- Teacher.
- Room.
- Start time.
- End time.
Also show:
- Free periods.
- Breaks.
- Temporary schedule changes.
- Substitute teacher, where available.
If the administrator changes a published timetable, students should receive an update notification.

31. Student – My Attendance
This page should be more detailed than the dashboard widget.

Tabs:
- Overview.
- Daily history.
- Monthly calendar.
- Subject/period attendance, if the school records it.
Overview
- Attendance percentage.
- Total working days.
- Present.
- Absent.
- Leave.
- Late.
- Excused.
Daily history
Date	Day	Status	Remarks
10 Nov	Tuesday	Present	—
11 Nov	Wednesday	Absent	—
12 Nov	Thursday	Present	—

Students can report a suspected error or submit a correction request, but they cannot edit attendance directly.

32. Student – Homework and assignments
This page should have:
- All assignments.
- Pending.
- Due soon.
- Overdue.
- Completed/submitted, if enabled.
Homework detail
- Title.
- Subject.
- Teacher.
- Description.
- Assigned date.
- Due date.
- Attachments.
- Instructions.
- Submission status.
The student can:
- Read instructions.
- Download files.
- View due dates.
- Submit an assignment if enabled.
- View teacher feedback.
- Review submission history.

33. Student – Study materials
Organize materials by subject and chapter.

Example:
Mathematics
Chapter 4 – Algebra
PDF · Uploaded by Mr. Sharma
New


Practice worksheet
PDF · 2 pages


Algebra revision video
External learning link


Support searching by:
- Subject.
- Chapter.
- Teacher.
- Material type.
- Upload date.

34. Student – Examinations and results
Examination schedule
Show upcoming and completed examinations.
Results directory
Examination	Date	Percentage	Grade	Status
Unit Test 1	July	82%	A	Published
Half-Yearly	October	86%	A	Published
Unit Test 2	November	—	—	Upcoming

Result detail
For each subject:
- Subject name.
- Theory marks.
- Practical marks.
- Internal marks.
- Total obtained.
- Maximum marks.
- Percentage.
- Grade.
- Teacher remarks.
The result page should also include:
- Overall percentage.
- Total marks.
- Maximum marks.
- Result status.
- Attendance summary.
- Teacher remarks.
- Principal remarks.
- Download PDF report card.

35. Student – Fee information
The initial student portal should provide limited read-only information.

Show:
- Fee category.
- Total fee assigned.
- Paid amount.
- Pending amount.
- Due dates.
- Payment history.
- Receipt downloads.
Do not expose:
- Other students' fees.
- Internal accounting notes.
- Payment gateway secrets.
- Administrative financial adjustments.
Later, parent/guardian accounts can be given payment permissions.

36. Student – Notifications and settings
Notification centre
Categories:
- Homework.
- Attendance.
- Examination.
- Results.
- Announcements.
- Timetable changes.
- Fee reminders.
Actions:
- Mark as read.
- Mark all read.
- Open related record.
- Filter by category.
Student settings
- Profile photo, if permitted.
- Language.
- Password change.
- Notification preferences.
- Session/device management.
- Logout.
A student's settings must never permit them to change their role or school membership.

Part F. Relationships between every entity
This is the most important technical part of your ERP.

You can create beautiful dashboards, but if the relationships between the records are wrong, your software will break as soon as a school starts moving students, teachers, classes or academic years.
37. The core academic relationship model
SCHOOL


ACADEMIC YEAR


CLASS


SECTION


STUDENT ENROLMENT


SUBJECT OFFERING


TEACHER ASSIGNMENT


TIMETABLE




ATTENDANCE · HOMEWORK · EXAMS · RESULTS


38. Entity relationships in detail
Entity	Relationship	Explanation
School	Has many academic years	Each school has its own academic calendar
Academic year	Has many classes/sections	Academic structures are year-specific
Class	Has many sections	Class 8 can have A, B, C
Section	Has many student enrolments	Students are allocated to a section
Student	Has many enrolments over time	A student progresses through years
Class	Has many subject offerings	Subjects can differ by grade
Subject	Has many subject offerings	Same subject can exist in many classes
Subject offering	Has many teacher assignments	Teachers can be assigned to sections
Teacher	Has many teaching assignments	One teacher can teach multiple sections
Section	Has one class teacher assignment at a time	Class teacher responsibility
Section	Has many timetable entries	Weekly periods
Teacher assignment	Can have many timetable entries	Teaching schedule
Student enrolment	Has attendance records	Historical attendance
Subject offering	Has homework records	Academic assignments
Examination	Has examination subject records	Exam-specific subject setup
Examination subject	Has marks records	Marks per student
Student	Has guardian relationships	Future parent portal support

39. The difference between Class, Section and Student
This needs to be implemented correctly.
- Class is the grade: Class 8.
- Section is the grouping: A, B or C.
- Student is the individual learner.
- Student enrolment is the record that connects a student to a particular academic year, class and section.
Do not permanently store only classId and sectionId on the student and treat those as their complete academic history.

A student might:
- Start in Class 7-A.
- Move to Class 7-B in October.
- Complete Class 7.
- Be promoted to Class 8-A the next year.
- Transfer to another school.
All of these changes must be represented without destroying historical records.
40. Recommended MongoDB collections
Here is a starting collection design. It is not yet a final production schema, but it identifies the important entities.
Collection	Purpose
schools	Tenant records
users	Authentication identities
schoolMemberships	User-to-school roles
subscriptions	School subscriptions
academicYears	School academic sessions
classes	Class/grade definitions
sections	Sections within classes
subjects	Subject master records
subjectOfferings	Subject availability by class/section/year
students	Permanent student profiles
studentEnrolments	Student's academic-year allocation
studentSectionHistory	Section transfers
teachers	Teacher/staff profiles
classTeacherAssignments	Class teacher relationships
teachingAssignments	Teacher, subject and section assignments
timetablePeriods	School period definitions
timetableEntries	Scheduled lessons
attendanceSessions	Attendance registers
attendanceRecords	Individual student attendance
homework	Assignments
homeworkSubmissions	Future online submissions
studyMaterials	Uploaded learning resources
examinations	Exam definitions
examinationSubjects	Subjects and exam-specific marking rules
examSchedules	Exam dates and times
marks	Student assessment results
reportCards	Published result snapshots
feeStructures	Fee definitions
studentFeeAssignments	Fees allocated to students
payments	Payment transactions
announcements	School notices
notifications	Notification events
notificationDeliveries	Delivery attempts
documents	File metadata
leaveApplications	Teacher/student leave requests
auditLogs	Record of sensitive actions

Important MongoDB rules
- Every school-owned record must contain tenantId.
- Use proper indexes for tenant and frequently searched fields.
- Use unique constraints scoped to a school where needed.
- Use transactions for multi-record operations such as student transfer and payment processing where supported.
- Use server-side tenant context from the authenticated membership.
- Do not trust a tenantId sent by the browser.
- Do not store large uploaded files directly in ordinary MongoDB documents; store files in object storage and keep their metadata in MongoDB.
- Maintain historical relationships and immutable financial events.

Part G. Critical workflows connecting the modules
41. New school onboarding
1. Super Admin registers a new school.
2. System creates a tenant and subscription record.
3. School administrator receives an invitation.
4. Administrator sets up school profile and academic year.
5. Administrator creates classes and sections.
6. Administrator adds subjects.
7. Administrator creates teacher profiles and invitations.
8. Administrator assigns teachers to classes and subjects.
9. Administrator configures the timetable.
10. Administrator admits students and allocates them to sections.
11. Student accounts are created and linked to the correct enrolment.
42. New student admission workflow
Student Profile → Admission → Enrolment → Class → Section → Roll Number → Account Invitation

A student should not appear in the active Class 8-A register until an active enrolment exists for the current academic year.
Admission validations
- Duplicate admission number.
- Duplicate student identity warning.
- Required personal details.
- Valid academic year.
- Active class.
- Active section.
- Section capacity.
- Roll number uniqueness within the appropriate scope.
- Required guardian information.
43. Student transfer workflow
Source Section → Transfer Request → Validation → Approval → New Section Assignment

The system must preserve:
- Previous section.
- Previous class.
- Effective date.
- Reason.
- Authorized user.
- Previous attendance.
- Previous marks.
- Existing fee transactions.
A student transfer must not automatically change examination records or previously published report cards.
44. Teacher assignment workflow
Teacher → Academic Year → Class → Section → Subject Offering → Teaching Assignment → Timetable

When an administrator removes a teacher from an assignment:
- Existing marks must remain attributed to the original teacher.
- Historical homework must remain.
- Past attendance must remain.
- Future timetable periods must be reassigned or marked unresolved.
- The teacher's access to that assignment must end according to the effective date.
45. Daily academic workflow
A typical school day
1. Teacher opens dashboard and checks timetable.
2. Teacher marks student attendance.
3. Attendance is submitted and stored.
4. Administrator sees school attendance overview.
5. Student sees their attendance status.
6. Teacher publishes homework.
7. Student receives notification and accesses homework.
8. Teacher uploads study material.
9. Student opens the material in their portal.

46. Examination workflow
Create Examination → Configure Subjects → Create Schedule → Teacher Enters Marks → Submit → Administrator Reviews → Approves → Publishes → Student Views Results

If marks are returned for correction, preserve the submitted version and record the reason for the revision.
47. Academic year promotion workflow
This is often overlooked, but it is essential.

At the end of an academic year:
1. Administrator reviews all students.
2. Students are marked as promoted, retained, transferred or withdrawn.
3. The new academic year is created.
4. New class and section structures are configured.
5. Promoted students are allocated to the new class and section.
6. New roll numbers are generated.
7. New subject offerings are configured.
8. Teachers are reassigned.
9. New timetables are created.
10. Old academic records are archived and remain accessible.
Do not simply change every student's class number by adding one. Some students may be retained, leave school or move into a different section.

Part H. Additional modules and edge cases
The four main roles and the core modules above form the first version. But there are additional school workflows worth designing into the architecture.
48. School settings
Administrator should be able to configure:
- School name and logo.
- Address and contact details.
- Academic year.
- Timezone.
- Language.
- Grading rules.
- Attendance rules.
- Working days.
- Period timings.
- School holidays.
- Admission number format.
- Student roll number format.
- Receipt numbering.
- Notification preferences.
- Report card templates.
- Document templates.
Some settings should be locked after records are created, or changes should take effect only from a specified date.
49. Student promotion and retention
Support:
- Individual promotion.
- Bulk promotion.
- Retention.
- Transfer out.
- Withdrawal.
- New section allocation.
- Roll number regeneration.
- Promotion approval.
Always preview the changes before committing a bulk promotion.
50. Document management
Documents may include:
- Student photographs.
- Transfer certificates.
- Birth certificates.
- Admission documents.
- Teacher qualifications.
- Employment documents.
- Examination report cards.
- School notices.
Document metadata should contain:
- Owner entity.
- Document type.
- Uploading user.
- Upload date.
- File size.
- Storage location.
- Visibility.
- Retention policy.
Use signed access URLs and permission checks. Never make student documents publicly accessible by guessing a file URL.
51. School calendar and events
Support:
- Holidays.
- Parent-teacher meetings.
- School functions.
- Sports days.
- Examination dates.
- Admission deadlines.
- Special events.
An event can target the whole school or selected classes and sections.
52. Transport management — later module
Potential entities:
- Vehicles.
- Drivers.
- Routes.
- Stops.
- Student route assignments.
- Transport fees.
- Route schedules.
A student can be assigned to one active route arrangement for a specified period.

Live GPS tracking is expensive and should not be part of your first release.
53. Library management — later module
Potential features:
- Books.
- Categories.
- ISBN.
- Copies.
- Issue records.
- Return records.
- Due dates.
- Late fees.
- Lost/damaged book records.
54. Teacher leave and substitution
If a teacher is absent:
- Administrator sees affected periods.
- Administrator assigns a substitute.
- Timetable displays the substitution.
- Students see the updated teacher.
- Original timetable remains available in history.
55. Data correction and deletion
Do not give users unrestricted delete buttons.

Examples:
- A wrongly created student can be archived if no critical records exist.
- A student with attendance and marks history should be withdrawn or archived, not hard-deleted.
- A teacher leaving the school should be deactivated, not deleted.
- A section with active students should not be deleted until students are reallocated.
- A completed payment should be reversed or refunded, not deleted.
- Published examination results require a formal correction process.
56. Search, filtering and exports
Global search should be permission-aware.

Searchable records:
- Students.
- Teachers.
- Classes.
- Sections.
- Subjects.
- Examinations.
- Homework.
- Announcements.
- Fee receipts.
Exports must respect the same permissions as the screen. A user must not gain access to restricted records by exporting an Excel file.
57. Notifications and background jobs
Events that should trigger notifications:
- New student admission.
- Student transfer.
- Teacher assignment change.
- Timetable publication.
- Timetable modification.
- Attendance submission.
- Homework publication.
- Examination schedule publication.
- Marks publication.
- Subscription renewal reminder.
- Account invitation.
- Password reset.
Use a background queue when needed, with retries and duplicate-delivery protection.

Part I. Permission rules and security
58. Role-based access is not enough by itself
Your backend needs both role-based and resource-based permissions.

For example, a teacher might have the permission attendance.mark, but that does not mean they can mark attendance for every section.

The server must also verify that the teacher has an active assignment for the relevant class/section and academic year.
Action	Super Admin	School Admin	Teacher	Student
Create school	Yes	No	No	No
Create academic year	No	Yes	No	No
Create class/section	No	Yes	No	No
Allocate student	No	Yes	No	No
Transfer student	No	Yes	No	No
Assign teachers	No	Yes	No	No
Edit timetable	No	Yes	No	No
View own timetable	No	Yes	Yes	Yes
Mark assigned class attendance	No	Yes	Yes	No
Create homework	No	Yes	Yes, assigned classes	No
Enter assigned marks	No	Yes	Yes, assigned subjects	No
Publish final results	No	Yes	Only if explicitly granted	No
View own results	No	Yes	Assigned students	Yes
Manage subscriptions	Yes	View status	No	No

Additional controls:
- Tenant isolation.
- Secure authentication and session handling.
- Strong password reset flows.
- Rate limiting.
- Audit logs.
- File-access permissions.
- Protection against unauthorized exports.
- Backup and restore procedures.
- Database encryption and encrypted network traffic.
- Protection against IDOR/BOLA vulnerabilities.
- Least-privilege administrative access.

Part J. Complete first-release scope
You asked to avoid leaving anything out. The blueprint above covers a broad school operating system. However, you should not attempt to develop every possible feature at once.

I would divide the implementation into three releases.
Release 1 — Core school operations
Build first
- Super Admin school management.
- School onboarding.
- Authentication and permissions.
- Academic years.
- Classes and sections.
- Student admissions.
- Student section allocation and transfers.
- Teacher management.
- Subject assignments.
- Class teacher assignments.
- Timetable.
- Attendance.
- Teacher portal.
- Student portal.
- Homework.
- Study materials.
- Examinations.
- Marks entry.
- Result approval and publishing.
- Basic school reports.
- Audit history.
Release 2 — Commercial school operations
- Fee structures.
- Student fee assignments.
- Payment recording.
- Online payment gateway.
- Receipts.
- Discounts and concessions.
- Advanced reports.
- Notifications.
- Parent/guardian portal.
- Bulk Excel migration.
- Subscription billing and limits.
- Improved analytics.
- Mobile application.
Release 3 — Expansion
- Transport.
- Library.
- Payroll.
- Advanced HR.
- Online examination engine.
- Advanced analytics.
- Multi-branch school support.
- AI-assisted reports and insights.
- More sophisticated communication tools.

Part K. Development acceptance checklist
This is the checklist I would use to decide whether your system is actually ready, rather than merely looking finished.
Product readiness checklist
0/37 complete



Platform and tenancy
[ ] Super Admin can create and configure a school
[ ] School receives its own tenant identifier
[ ] School A cannot access School B records
[ ] Subscription limits are enforced by the backend
[ ] Audit history is recorded for sensitive actions


Academic structure
[ ] Administrator can create academic years
[ ] Administrator can create classes
[ ] Administrator can create multiple sections within a class
[ ] Administrator can assign subjects to classes and sections
[ ] Administrator can assign teachers to subject offerings
[ ] Administrator can assign class teachers
[ ] Section capacity is enforced
[ ] Students can be transferred between sections with history preserved


Students and teachers
[ ] Student admissions and enrolments work separately
[ ] Student profiles preserve historical enrolments
[ ] Teacher profiles and invitations work
[ ] Teacher sees only assigned classes and subjects
[ ] Bulk import detects duplicates and invalid rows


Timetable and attendance
[ ] Timetable supports teacher, section and room conflict checks
[ ] Students see their current section timetable
[ ] Teachers see their own teaching timetable
[ ] Attendance can be saved and submitted
[ ] Attendance corrections require authorization and a reason
[ ] Unmarked attendance is not treated as absence


Learning and examinations
[ ] Teachers can publish homework to assigned classes
[ ] Students see only relevant published homework
[ ] Teachers can upload class-specific study materials
[ ] Examination schedules can be configured
[ ] Marks validation prevents invalid values
[ ] Results require approval before publication
[ ] Published report cards remain historically consistent


Student portal and security
[ ] Student sees only their own academic records
[ ] Student sees published results only
[ ] Student dashboard graphs use real data
[ ] Notifications link to relevant records
[ ] Exports enforce user permissions
[ ] Backups can be restored successfully

0% of acceptance criteria checked
Reset checklist


My final architectural recommendations
Before development, there are five decisions I strongly recommend locking down:
1. Separate student identity from enrolment. A student is a person; enrolment connects that person to a particular academic year, class and section.
2. Separate teacher identity from teaching assignment. One teacher can teach multiple subjects and sections, and assignments can change over time.
3. Make academic year a first-class entity. Timetable, class structure, student enrolment, subjects and examination records must be associated with the appropriate academic year.
4. Preserve history. Transfers, promotions, attendance, marks and fee transactions must never be overwritten casually.
5. Build permission checks into the backend from day one. Hiding a menu item in React is not security.
One more thing: I would not start by asking Claude Code to generate all these screens at once. First, lock down the database relationships, API contracts, permissions and critical workflows. Then build one complete vertical workflow at a time—for example, create class → create section → enrol student → assign teacher → create timetable → mark attendance → student views attendance.

That workflow will prove that your architecture actually works, instead of giving you dozens of attractive but disconnected screens.