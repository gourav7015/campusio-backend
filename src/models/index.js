import mongoose from 'mongoose';
import { GRADE_NAMES, levelOf, streamOf } from '../core/grades.js';
import { forgetOnWrite } from '../core/memo.js';

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const opts = { timestamps: true };
const tenant = { type: ObjectId, ref: 'School', required: true, index: true };
const ref = (to, extra = {}) => ({ type: ObjectId, ref: to, ...extra });

function model(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}

// ───────────── Platform ─────────────
export const defaultSettings = () => ({
  timezone: 'Asia/Kolkata',
  language: 'en',
  workingDays: [1, 2, 3, 4, 5, 6],
  grading: {
    passPercentage: 33,
    scale: [
      { min: 90, grade: 'A+' }, { min: 80, grade: 'A' }, { min: 70, grade: 'B+' },
      { min: 60, grade: 'B' }, { min: 50, grade: 'C' }, { min: 33, grade: 'D' }, { min: 0, grade: 'F' },
    ],
  },
  attendance: { lateCountsAsPresent: true, periodWise: false },
  finance: { receiptFormat: 'RCPT{YYYY}{SEQ:5}', dueDay: 10, advanceDiscount: { enabled: true, minMonths: 12, type: 'months', value: 1 } },
  library: { loanDays: { student: 14, teacher: 30 }, maxBooks: { student: 2, teacher: 5 }, finePerDay: 2, maxRenewals: 1, blockIfOverdue: true },
  admissionFormat: 'ADM{YYYY}{SEQ:4}',
  // starting password for students, teachers and staff made in bulk or one by one: first 4 letters of the name in capitals + date of birth. '' = a random one each time.
  passwordFormat: '{NAME4}{DDMMYYYY}',
  leaveBalances: { casual: 12, sick: 10, earned: 0, other: 0 },
  staffLeaveBalances: { casual: 12, sick: 10, earned: 0, other: 0 },
  // who approves the leave of transport staff: the Transport officer ('officer'), or the School Admin ('admin': the officer can only pass applications on)
  transportLeaveApprover: 'officer',
  // working hours for staff. A check-in after shiftStart + graceMinutes is late; less than halfDayHours is a half day.
  // location (optional): staff may check in from their own login only within radiusMeters of the school.
  staffAttendance: { shiftStart: '08:00', shiftEnd: '15:00', graceMinutes: 10, fullDayHours: 6, halfDayHours: 3, checkInOpensBeforeMinutes: 60, checkInClosesAtShiftEnd: true, location: null },
  // statutory deductions (India). Off by default: a school switches on what applies to it.
  statutory: {
    pf: { enabled: false, employeeRate: 12, employerRate: 12, wageCeiling: 15000 },
    esi: { enabled: false, employeeRate: 0.75, employerRate: 3.25, grossCeiling: 21000 },
    pt: { enabled: false, slabs: [{ upTo: 12000, amount: 0 }, { upTo: 1000000000, amount: 200 }] },
  },
  showAttendanceVsPerformance: true,
  studentCanEditProfile: [], // students only look: their details are kept up to date by the school (a school may allow phone, address or email here)
});

export const School = model('School', forgetOnWrite(new Schema({
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, unique: true, lowercase: true, trim: true },
  address: String, phone: String, email: String, logoUrl: String, board: String,
  status: { type: String, enum: ['active', 'suspended', 'archived'], default: 'active' },
  settings: { type: Schema.Types.Mixed, default: defaultSettings },
}, opts)));

export const Subscription = model('Subscription', forgetOnWrite(new Schema({
  schoolId: { type: ObjectId, ref: 'School', required: true, unique: true },
  plan: { type: String, default: 'starter' },
  status: { type: String, enum: ['trial', 'active', 'expired', 'cancelled'], default: 'trial' },
  startsOn: String, expiresOn: String,
}, opts)));

export const User = model('User', new Schema({
  tenantId: { type: ObjectId, ref: 'School', index: true, default: null },
  role: { type: String, enum: ['super_admin', 'school_admin', 'teacher', 'student', 'finance', 'library', 'transport', 'staff'], required: true },
  loginId: { type: String, required: true, unique: true, lowercase: true, trim: true },
  email: { type: String, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true },
  mustChangePassword: { type: Boolean, default: true },
  // a sub-admin is a school_admin login that may use only the listed parts of the admin portal
  adminLevel: { type: String, enum: ['full', 'sub'], default: 'full' }, permissions: [String],
  status: { type: String, enum: ['active', 'disabled'], default: 'active' },
  lastLoginAt: Date,
  failedLogins: { type: Number, default: 0 },
  lockedUntil: Date,
  // the registered mobile number and date of birth of accounts that have no person record (school administrators, sub-administrators); everyone else's are on their own record
  phone: String, dob: String,
  // two-factor sign-in: after the password, a 6-digit code is sent to the registered email. Codes are kept only as keyed hashes.
  otp: {
    enabled: { type: Boolean, default: false }, enabledAt: Date,
    pending: { purpose: String, codeHash: String, expiresAt: Date, tries: { type: Number, default: 0 } },
    login: { codeHash: String, expiresAt: Date, tries: { type: Number, default: 0 }, sentAt: Date },
    sends: [Date],
  },
  language: { type: String, default: 'en' },
  notificationPrefs: { type: Schema.Types.Mixed, default: () => ({ homework: true, attendance: true, examination: true, results: true, announcements: true, timetable: true }) },
  createdBy: ref('User'),
}, opts));

export const Session = model('Session', new Schema({
  userId: { type: ObjectId, ref: 'User', required: true, index: true },
  jti: { type: String, required: true, unique: true },
  userAgent: String, ip: String,
  lastSeenAt: Date,
  revokedAt: Date,
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
}, opts));

export const AuditLog = model('AuditLog', new Schema({
  tenantId: { type: ObjectId, ref: 'School', index: true, default: null },
  actorId: ref('User'), actorName: String, actorRole: String,
  actingAsSuperAdmin: { type: Boolean, default: false },
  action: { type: String, required: true, index: true },
  entityType: String, entityId: String, summary: String,
  meta: Schema.Types.Mixed, ip: String,
}, opts));
AuditLog.schema.index({ tenantId: 1, createdAt: -1 });

export const Counter = model('Counter', new Schema({
  tenantId: tenant, key: { type: String, required: true }, seq: { type: Number, default: 0 },
}));
Counter.schema.index({ tenantId: 1, key: 1 }, { unique: true });

const componentSchema = new Schema({ key: String, label: String, max: Number }, { _id: false });

// ───────────── Academic structure ─────────────
export const AcademicYear = model('AcademicYear', (() => {
  const s = new Schema({
    tenantId: tenant, name: { type: String, required: true },
    startDate: { type: String, required: true }, endDate: { type: String, required: true },
    isCurrent: { type: Boolean, default: false },
    status: { type: String, enum: ['upcoming', 'active', 'closed'], default: 'active' },
    // Some classes run on their own calendar: classes 9 and 11 often start in January or February, and 10 and 12 follow the board's date sheet.
    // A class listed here uses these dates instead of the school-wide ones; a class not listed follows the school year.
    classWindows: { type: [new Schema({ classId: ref('Class', { required: true }), startDate: { type: String, required: true }, endDate: { type: String, required: true } }, { _id: false })], default: [] },
  }, opts);
  s.index({ tenantId: 1, name: 1 }, { unique: true });
  return forgetOnWrite(s);
})());

export const ClassModel = model('Class', (() => {
  const s = new Schema({
    tenantId: tenant, name: { type: String, required: true, trim: true, enum: GRADE_NAMES }, level: { type: Number }, stream: { type: String, enum: ['medical', 'non_medical', 'commerce', 'arts'] }, // Class 11 and 12 only
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  }, opts);
  s.pre('validate', function setLevel(next) { this.level = levelOf(this.name); this.stream = streamOf(this.name) || undefined; next(); }); // level always follows the name
  s.index({ tenantId: 1, name: 1 }, { unique: true });
  return s;
})());

export const Section = model('Section', (() => {
  const s = new Schema({
    tenantId: tenant, yearId: ref('AcademicYear', { required: true }), classId: ref('Class', { required: true }),
    name: { type: String, required: true, trim: true, uppercase: true }, capacity: { type: Number, default: 40 }, room: String, monitorIds: [ref('Student')], // always stored in capitals, so 12a and 12A can never be two sections
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  }, opts);
  s.index({ tenantId: 1, yearId: 1, classId: 1, name: 1 }, { unique: true });
  return s;
})());

/** A house of the school (the school names its own: there are no built-in houses). Students and teachers each belong to at most one; a teacher in a house mentors its students. */
export const House = model('House', (() => {
  const s = new Schema({
    tenantId: tenant, name: { type: String, required: true, trim: true, maxlength: 30 }, color: { type: String, trim: true, match: /^#[0-9a-f]{6}$/i }, motto: { type: String, trim: true, maxlength: 80 },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  }, opts);
  s.index({ tenantId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
  return s;
})());

export const Subject = model('Subject', (() => {
  const s = new Schema({
    tenantId: tenant, name: { type: String, required: true, trim: true }, code: { type: String, required: true, trim: true, uppercase: true },
    type: { type: String, enum: ['core', 'elective', 'activity'], default: 'core' },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  }, opts);
  s.index({ tenantId: 1, code: 1 }, { unique: true });
  return s;
})());

export const SubjectOffering = model('SubjectOffering', (() => {
  const s = new Schema({
    tenantId: tenant, yearId: ref('AcademicYear', { required: true }), classId: ref('Class', { required: true }),
    subjectId: ref('Subject', { required: true }), weeklyPeriods: { type: Number, default: 5 },
    assessment: { components: { type: [componentSchema], default: undefined }, passMarks: { type: Number, default: 33 } },
  }, opts);
  s.index({ tenantId: 1, yearId: 1, classId: 1, subjectId: 1 }, { unique: true });
  return s;
})());

// ───────────── People ─────────────
const guardian = new Schema({ name: String, relationship: String, phone: String, email: String, isPrimary: Boolean }, { _id: false });

export const Student = model('Student', (() => {
  const s = new Schema({
    tenantId: tenant, userId: ref('User'), admissionNo: { type: String, required: true },
    name: { type: String, required: true, trim: true }, dob: String, gender: { type: String, enum: ['male', 'female', 'other', ''], default: '' },
    address: String, phone: String, email: String, photoFileId: ref('File'), admissionDate: String, house: String, bloodGroup: String,
    guardians: [guardian], emergencyContact: { name: String, phone: String },
    status: { type: String, enum: ['active', 'withdrawn', 'transferred_out', 'completed', 'archived'], default: 'active' },
    importBatchId: ref('ImportBatch'),
    // the guardian's consent for the school to hold the child's details, as the school recorded it
    consent: { givenOn: String, guardianName: String, relationship: String, note: String, recordedByName: String, recordedAt: Date },
    // set when a former student's personal details were erased (fees, marks and attendance stay, without a name)
    anonymisedAt: Date, anonymisedByName: String, anonymisationReason: String,
    // a discount on tuition that goes with the student and applies to every month billed (set at admission or by Finance)
    personalDiscount: { type: { type: String, enum: ['percent', 'per_month'] }, value: Number, reason: String, setByName: String, setAt: Date },
  }, opts);
  s.index({ tenantId: 1, admissionNo: 1 }, { unique: true });
  s.index({ tenantId: 1, name: 1 });
  return s;
})());

export const StudentEnrolment = model('StudentEnrolment', (() => {
  const s = new Schema({
    tenantId: tenant, studentId: ref('Student', { required: true, index: true }), yearId: ref('AcademicYear', { required: true }),
    classId: ref('Class', { required: true }), sectionId: ref('Section', { required: true, index: true }),
    rollNo: Number, startDate: { type: String, required: true }, endDate: String,
    status: { type: String, enum: ['active', 'section_changed', 'promoted', 'retained', 'transferred_out', 'withdrawn', 'completed'], default: 'active' },
  }, opts);
  s.index({ tenantId: 1, studentId: 1, yearId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
  s.index({ tenantId: 1, sectionId: 1, rollNo: 1 }, { unique: true, partialFilterExpression: { status: 'active', rollNo: { $gt: 0 } } });
  return s;
})());

export const TransferRecord = model('TransferRecord', new Schema({
  tenantId: tenant, studentId: ref('Student', { required: true, index: true }),
  fromEnrolmentId: ref('StudentEnrolment'), toEnrolmentId: ref('StudentEnrolment'),
  fromSectionId: ref('Section'), toSectionId: ref('Section'), effectiveDate: String, reason: String, by: ref('User'),
}, opts));

export const Teacher = model('Teacher', (() => {
  const s = new Schema({
    tenantId: tenant, userId: ref('User'), employeeId: { type: String, required: true }, name: { type: String, required: true, trim: true },
    bank: { accountName: String, accountNo: String, ifsc: String, bankName: String, upi: String },
    statutory: { uan: String, esiNo: String, pan: String },
    email: String, phone: String, dob: String, qualification: String, designation: String, designationId: ref('Designation'), house: String, joiningDate: String, address: String, // designation: always the name of a registered teaching designation; house: one of the school's houses
    subjectIds: [ref('Subject')], photoFileId: ref('File'),
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    importBatchId: ref('ImportBatch'),
  }, opts);
  s.index({ tenantId: 1, employeeId: 1 }, { unique: true });
  return s;
})());

export const TeachingAssignment = model('TeachingAssignment', (() => {
  const s = new Schema({
    tenantId: tenant, yearId: ref('AcademicYear', { required: true }), teacherId: ref('Teacher', { required: true, index: true }),
    sectionId: ref('Section', { required: true, index: true }), classId: ref('Class', { required: true }),
    subjectId: ref('Subject', { required: true }), offeringId: ref('SubjectOffering', { required: true }),
    effectiveFrom: String, effectiveTo: String, open: { type: Boolean, default: true },
  }, opts);
  s.index({ tenantId: 1, yearId: 1, sectionId: 1, subjectId: 1 }, { unique: true, partialFilterExpression: { open: true } });
  return s;
})());

export const ClassTeacherAssignment = model('ClassTeacherAssignment', (() => {
  const s = new Schema({
    tenantId: tenant, yearId: ref('AcademicYear', { required: true }), sectionId: ref('Section', { required: true }),
    teacherId: ref('Teacher', { required: true, index: true }), effectiveFrom: String, effectiveTo: String, open: { type: Boolean, default: true },
  }, opts);
  s.index({ tenantId: 1, sectionId: 1 }, { unique: true, partialFilterExpression: { open: true } });
  return s;
})());

// ───────────── Timetable ─────────────
export const TimetablePeriod = model('TimetablePeriod', (() => {
  const s = new Schema({
    tenantId: tenant, name: { type: String, required: true }, order: { type: Number, required: true },
    startTime: { type: String, required: true }, endTime: { type: String, required: true },
    type: { type: String, enum: ['lesson', 'break'], default: 'lesson' },
  }, opts);
  s.index({ tenantId: 1, order: 1 }, { unique: true });
  return s;
})());

export const TimetableEntry = model('TimetableEntry', (() => {
  const s = new Schema({
    tenantId: tenant, yearId: ref('AcademicYear', { required: true }), sectionId: ref('Section', { required: true, index: true }),
    day: { type: Number, min: 1, max: 7, required: true }, periodId: ref('TimetablePeriod', { required: true }),
    assignmentId: ref('TeachingAssignment', { index: true }), room: String, unresolved: { type: Boolean, default: false },
  }, opts);
  s.index({ tenantId: 1, yearId: 1, sectionId: 1, day: 1, periodId: 1 }, { unique: true });
  return s;
})());

export const Substitution = model('Substitution', (() => {
  const s = new Schema({
    tenantId: tenant, entryId: ref('TimetableEntry', { required: true }), date: { type: String, required: true },
    originalTeacherId: ref('Teacher'), substituteTeacherId: ref('Teacher', { required: true }), reason: String, leaveId: ref('LeaveApplication'), createdBy: ref('User'),
  }, opts);
  s.index({ tenantId: 1, entryId: 1, date: 1 }, { unique: true });
  return s;
})());

// ───────────── Attendance ─────────────
export const AttendanceSession = model('AttendanceSession', (() => {
  const s = new Schema({
    tenantId: tenant, yearId: ref('AcademicYear', { required: true }), sectionId: ref('Section', { required: true }),
    date: { type: String, required: true }, status: { type: String, enum: ['draft', 'submitted'], default: 'draft' },
    markedBy: ref('User'), submittedBy: ref('User'), submittedAt: Date, remarks: String,
  }, opts);
  s.index({ tenantId: 1, sectionId: 1, date: 1 }, { unique: true });
  return s;
})());

export const AttendanceRecord = model('AttendanceRecord', (() => {
  const s = new Schema({
    tenantId: tenant, sessionId: ref('AttendanceSession', { required: true, index: true }),
    studentId: ref('Student', { required: true }), enrolmentId: ref('StudentEnrolment'), sectionId: ref('Section'), yearId: ref('AcademicYear'),
    date: String,
    status: { type: String, enum: ['present', 'absent', 'late', 'half_day', 'leave', 'excused'], required: true },
    halfSession: { type: String, enum: ['first', 'second'] }, // for a half day: the session the person attended (the other half they were away)
    remarks: String, regularised: { type: Boolean, default: false },
    history: [new Schema({ from: String, to: String, by: ref('User'), byName: String, reason: String, kind: String, at: { type: Date, default: Date.now } }, { _id: false })],
  }, opts);
  s.index({ sessionId: 1, studentId: 1 }, { unique: true });
  s.index({ tenantId: 1, studentId: 1, yearId: 1, date: 1 });
  return s;
})());

export const AttendanceQuery = model('AttendanceQuery', new Schema({
  tenantId: tenant, studentId: ref('Student', { required: true, index: true }), date: { type: String, required: true }, message: { type: String, required: true },
  status: { type: String, enum: ['open', 'resolved', 'rejected'], default: 'open' }, response: String, resolvedBy: ref('User'), resolvedAt: Date,
}, opts));

// ───────────── Learning ─────────────
export const Homework = model('Homework', new Schema({
  tenantId: tenant, yearId: ref('AcademicYear', { required: true }), sectionId: ref('Section', { required: true, index: true }),
  subjectId: ref('Subject', { required: true }), teacherId: ref('Teacher', { required: true, index: true }),
  title: { type: String, required: true }, description: String, instructions: String,
  type: { type: String, enum: ['written', 'reading', 'project', 'worksheet', 'practical', 'revision', 'other'], default: 'written' },
  assignedDate: String, dueDate: { type: String, required: true }, maxMarks: Number, submissionRequired: { type: Boolean, default: false },
  status: { type: String, enum: ['draft', 'scheduled', 'published', 'archived'], default: 'draft' },
  publishAt: Date, publishedAt: Date, attachments: [ref('File')],
  editHistory: [new Schema({ at: { type: Date, default: Date.now }, by: ref('User'), byName: String, changes: [String] }, { _id: false })],
}, opts));

export const StudyMaterial = model('StudyMaterial', new Schema({
  tenantId: tenant, yearId: ref('AcademicYear', { required: true }), sectionId: ref('Section', { required: true, index: true }),
  subjectId: ref('Subject', { required: true }), teacherId: ref('Teacher', { required: true, index: true }),
  title: { type: String, required: true }, description: String, chapter: String,
  materialType: { type: String, enum: ['pdf', 'image', 'document', 'presentation', 'video', 'worksheet'], default: 'pdf' },
  fileId: ref('File'), externalUrl: String, publishDate: String, expiryDate: String,
  status: { type: String, enum: ['draft', 'published', 'unpublished', 'archived'], default: 'draft' },
}, opts));

// ───────────── Examinations ─────────────
export const Examination = model('Examination', (() => {
  const s = new Schema({
    tenantId: tenant, yearId: ref('AcademicYear', { required: true }), name: { type: String, required: true },
    type: { type: String, default: 'unit_test' }, classIds: [ref('Class')], startDate: String, endDate: String, marksDeadline: String,
    status: { type: String, enum: ['draft', 'scheduled', 'archived'], default: 'draft' },
    schedulePublished: { type: Boolean, default: false },
    // Tests created by a teacher are scoped to one section + subject (class test, surprise test, …)
    sectionId: ref('Section'), subjectId: ref('Subject'), createdBy: ref('User'), createdByName: String,
  }, opts);
  s.index({ tenantId: 1, yearId: 1, name: 1, sectionId: 1, subjectId: 1 }, { unique: true });
  return s;
})());

export const ExaminationSubject = model('ExaminationSubject', (() => {
  const s = new Schema({
    tenantId: tenant, examId: ref('Examination', { required: true, index: true }), classId: ref('Class', { required: true }), subjectId: ref('Subject', { required: true }),
    date: String, startTime: String, endTime: String, room: String,
    components: [componentSchema], passMarks: { type: Number, default: 33 }, marksDeadline: String,
  }, opts);
  s.index({ tenantId: 1, examId: 1, classId: 1, subjectId: 1 }, { unique: true });
  return s;
})());

export const MarksSheet = model('MarksSheet', (() => {
  const s = new Schema({
    tenantId: tenant, examId: ref('Examination', { required: true, index: true }), examSubjectId: ref('ExaminationSubject', { required: true }),
    sectionId: ref('Section', { required: true }), teacherId: ref('Teacher'), enteredByUserId: ref('User'),
    status: { type: String, enum: ['draft', 'submitted', 'under_review', 'returned', 'approved', 'published'], default: 'draft' },
    submittedAt: Date, reviewedBy: ref('User'), reviewedAt: Date, returnReason: String, publishedAt: Date,
    revisions: [new Schema({ version: Number, submittedAt: Date, returnedAt: Date, returnReason: String, returnedBy: ref('User'), marks: Schema.Types.Mixed }, { _id: false })],
  }, opts);
  s.index({ tenantId: 1, examSubjectId: 1, sectionId: 1 }, { unique: true });
  return s;
})());

export const Marks = model('Marks', (() => {
  const s = new Schema({
    tenantId: tenant, sheetId: ref('MarksSheet', { required: true, index: true }), examId: ref('Examination', { required: true }),
    examSubjectId: ref('ExaminationSubject', { required: true }), sectionId: ref('Section', { required: true }),
    studentId: ref('Student', { required: true, index: true }), enrolmentId: ref('StudentEnrolment'),
    values: { type: Schema.Types.Mixed, default: {} }, total: Number,
    absent: { type: Boolean, default: false }, exempt: { type: Boolean, default: false }, remarks: String,
    history: [new Schema({ at: { type: Date, default: Date.now }, by: ref('User'), byName: String, reason: String, before: Schema.Types.Mixed, after: Schema.Types.Mixed }, { _id: false })],
  }, opts);
  s.index({ sheetId: 1, studentId: 1 }, { unique: true });
  return s;
})());

export const ReportCard = model('ReportCard', (() => {
  const s = new Schema({
    tenantId: tenant, examId: ref('Examination', { required: true }), studentId: ref('Student', { required: true }), enrolmentId: ref('StudentEnrolment'),
    sectionId: ref('Section'), classId: ref('Class'), yearId: ref('AcademicYear'),
    version: { type: Number, default: 1 }, isCurrent: { type: Boolean, default: true }, correctionReason: String,
    snapshot: Schema.Types.Mixed, publishedAt: Date, publishedBy: ref('User'),
  }, opts);
  s.index({ tenantId: 1, studentId: 1, examId: 1, version: 1 }, { unique: true });
  return s;
})());

export const ReportRemark = model('ReportRemark', (() => {
  const s = new Schema({
    tenantId: tenant, examId: ref('Examination', { required: true }), studentId: ref('Student', { required: true }),
    teacherRemark: String, principalRemark: String,
  }, opts);
  s.index({ tenantId: 1, examId: 1, studentId: 1 }, { unique: true });
  return s;
})());

// ───────────── Communication ─────────────
export const Announcement = model('Announcement', new Schema({
  tenantId: tenant, title: { type: String, required: true }, body: String,
  category: { type: String, enum: ['urgent', 'holiday', 'examination', 'event', 'homework', 'general'], default: 'general' },
  audience: { roles: [String], sectionIds: [ref('Section')], all: { type: Boolean, default: true } },
  attachments: [ref('File')], publishAt: Date, status: { type: String, enum: ['draft', 'published', 'archived'], default: 'published' }, createdBy: ref('User'), createdByName: String, createdByRole: String,
}, opts));

export const AnnouncementRead = model('AnnouncementRead', (() => {
  const s = new Schema({ tenantId: tenant, announcementId: ref('Announcement', { required: true }), userId: ref('User', { required: true }) }, opts);
  s.index({ announcementId: 1, userId: 1 }, { unique: true });
  return s;
})());

export const CalendarEvent = model('CalendarEvent', new Schema({
  tenantId: tenant, title: { type: String, required: true }, description: String,
  type: { type: String, enum: ['holiday', 'exam', 'event', 'ptm', 'deadline', 'other'], default: 'event' },
  kind: { type: String, enum: ['school', 'government'], default: 'school' }, // a school's own day, or a national / state holiday
  startDate: { type: String, required: true }, endDate: { type: String, required: true }, sectionIds: [ref('Section')], createdBy: ref('User'),
}, opts));

export const Notification = model('Notification', (() => {
  const s = new Schema({
    tenantId: tenant, userId: ref('User', { required: true, index: true }), category: String, title: String, body: String,
    link: { type: { type: String }, id: String }, readAt: Date, dedupeKey: String,
    delivery: { status: { type: String, default: 'delivered' }, at: { type: Date, default: Date.now } },
  }, opts);
  s.index({ userId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
  s.index({ userId: 1, createdAt: -1 });
  return s;
})());

export const Message = model('Message', new Schema({
  tenantId: tenant, fromUserId: ref('User', { required: true }), fromName: String, fromRole: String, toRole: { type: String, default: 'school_admin' },
  subject: { type: String, required: true }, body: { type: String, required: true },
  status: { type: String, enum: ['delivered', 'read'], default: 'delivered' }, readAt: Date,
}, opts));

// ───────────── Help desk ─────────────
// scope 'platform': a School Admin asks AtKaksha support (handled by the Super Admin side).
// scope 'school': a teacher, student or staff member asks their own school's admin.
export const TICKET_CATEGORIES = ['general', 'bug', 'account', 'billing', 'how_to', 'feature', 'other'];
export const Ticket = model('Ticket', (() => {
  const reply = new Schema({
    authorId: ref('User'), authorName: String, authorRole: String, body: { type: String, required: true },
    internal: { type: Boolean, default: false }, // a note for the handling side only; the person who raised the ticket never sees it
    attachments: { type: [new Schema({ fileId: ref('File'), name: String, mime: String, size: Number }, { _id: false })], default: [] },
    at: { type: Date, default: Date.now },
  });
  const s = new Schema({
    tenantId: tenant, scope: { type: String, enum: ['school', 'platform'], required: true },
    number: { type: Number, required: true }, reference: { type: String, required: true }, // what people quote, e.g. DEMO-12 or T-0007
    subject: { type: String, required: true }, category: { type: String, enum: TICKET_CATEGORIES, default: 'general' },
    priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
    status: { type: String, enum: ['open', 'pending', 'resolved', 'closed'], default: 'open' }, // pending = waiting for the person who raised it
    raisedBy: { userId: ref('User', { required: true }), name: String, role: String, email: String },
    assignedTo: { userId: ref('User'), name: String },
    messages: [reply], lastActivityAt: { type: Date, default: Date.now }, lastReplyBy: { type: String, enum: ['requester', 'handler'], default: 'requester' },
    resolvedAt: Date, closedAt: Date,
  }, opts);
  s.index({ tenantId: 1, scope: 1, number: 1 }, { unique: true });
  s.index({ scope: 1, status: 1, lastActivityAt: -1 });
  s.index({ tenantId: 1, scope: 1, 'raisedBy.userId': 1, lastActivityAt: -1 });
  return s;
})());

export const LeaveApplication = model('LeaveApplication', new Schema({
  tenantId: tenant, teacherId: ref('Teacher', { required: true, index: true }), userId: ref('User'),
  leaveType: { type: String, enum: ['casual', 'sick', 'earned', 'other', 'unpaid'], default: 'casual' },
  startDate: { type: String, required: true }, endDate: { type: String, required: true }, days: Number, reason: String, attachmentFileId: ref('File'),
  halfDay: { type: Boolean, default: false }, halfSession: { type: String, enum: ['first', 'second'] }, // a half day is one date; halfSession is the half the person is away
  status: { type: String, enum: ['draft', 'submitted', 'approved', 'rejected', 'cancelled'], default: 'submitted' },
  decisionBy: ref('User'), decisionRemark: String, decidedAt: Date,
  withdrawnAt: Date, withdrawnBy: ref('User'), // the applicant took the application back (before a decision), or cancelled approved leave that had not begun
}, opts));

/** Extra leave the school gives one person on top of the yearly allowance in the school settings (e.g. a compensatory day for working on a holiday). Counted in the year named by yearKey. */
export const LeaveGrant = model('LeaveGrant', (() => {
  const s = new Schema({
    tenantId: tenant, personType: { type: String, enum: ['teacher', 'staff'], required: true }, personId: { type: ObjectId, required: true }, yearKey: { type: String, required: true },
    leaveType: { type: String, enum: ['casual', 'sick', 'earned', 'other'], required: true }, days: { type: Number, required: true, min: 0.5, max: 60 }, reason: { type: String, required: true, trim: true, maxlength: 300 },
    grantedBy: ref('User'),
  }, opts);
  s.index({ tenantId: 1, personType: 1, personId: 1, yearKey: 1 });
  return s;
})());

// ───────────── Payroll (teachers) ─────────────
const payItemSchema = new Schema({ label: { type: String, required: true, trim: true }, kind: { type: String, enum: ['fixed', 'percent'], default: 'fixed' }, value: { type: Number, required: true, min: 0 } }, { _id: false });

/** A pay level / grade (e.g. PRT, TGT, PGT, Vice Principal) with a default salary structure. */
export const PayLevel = model('PayLevel', (() => {
  const s = new Schema({
    tenantId: tenant, name: { type: String, required: true, trim: true }, order: { type: Number, default: 0 }, description: String,
    appliesTo: { type: String, enum: ['teaching', 'non_teaching'], default: 'teaching' },
    basic: { type: Number, required: true, min: 0 }, allowances: [payItemSchema], deductions: [payItemSchema],
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  }, opts);
  s.index({ tenantId: 1, name: 1 }, { unique: true });
  return s;
})());

/** Append-only salary history: the revision with the latest effectiveFrom on or before a month is the one paid for it. */
export const SalaryRevision = model('SalaryRevision', (() => {
  const s = new Schema({
    tenantId: tenant, personType: { type: String, enum: ['teacher', 'staff'], default: 'teacher' }, personId: { type: ObjectId, required: true, index: true }, effectiveFrom: { type: String, required: true },
    levelId: ref('PayLevel'), levelName: String, basic: { type: Number, required: true, min: 0 }, allowances: [payItemSchema], deductions: [payItemSchema],
    reason: String, by: ref('User'), byName: String,
  }, opts);
  s.index({ tenantId: 1, personId: 1, effectiveFrom: -1 });
  return s;
})());

const lineSchema = new Schema({ label: String, amount: Number }, { _id: false });
export const PayrollRun = model('PayrollRun', (() => {
  const s = new Schema({
    tenantId: tenant, month: { type: String, required: true }, // YYYY-MM
    status: { type: String, enum: ['draft', 'approved', 'paid'], default: 'draft' },
    workingDays: Number, totals: { count: Number, gross: Number, deductions: Number, net: Number, paid: Number },
    generatedBy: ref('User'), approvedBy: ref('User'), approvedAt: Date, paidAt: Date, skipped: [{ personId: ObjectId, personType: String, name: String, reason: String, _id: false }],
  }, opts);
  s.index({ tenantId: 1, month: 1 }, { unique: true });
  return s;
})());

/** One teacher's pay for one month. A snapshot: later salary changes never rewrite it. */
export const Payslip = model('Payslip', (() => {
  const s = new Schema({
    tenantId: tenant, runId: ref('PayrollRun', { required: true, index: true }), month: { type: String, required: true }, payslipNo: String,
    personType: { type: String, enum: ['teacher', 'staff'], default: 'teacher' }, personId: { type: ObjectId, required: true, index: true }, userId: ref('User'), personName: String, employeeId: String, designation: String, levelName: String,
    workingDays: Number, unpaidDays: Number, paidDays: Number,
    earnings: [lineSchema], deductions: [lineSchema], lossOfPay: { type: Number, default: 0 },
    adjustments: [{ label: String, type: { type: String, enum: ['earning', 'deduction'] }, amount: Number, reason: String, _id: false }],
    gross: Number, totalDeductions: Number, net: Number, statutory: Schema.Types.Mixed,
    status: { type: String, enum: ['pending', 'partial', 'paid'], default: 'pending' }, paidOn: String, mode: String, reference: String, paidBy: ref('User'),
    // salary can be paid in parts (half now, the rest later); the slip is 'paid' once the parts add up to the net pay
    paidAmount: { type: Number, default: 0 }, payments: [new Schema({ amount: Number, paidOn: String, mode: String, reference: String, note: String, by: ref('User') }, { _id: false })],
  }, opts);
  s.index({ tenantId: 1, runId: 1, personId: 1 }, { unique: true });
  return s;
})());

/** A teacher's remark about a student (a homework mistake, behaviour, a guideline). The parent, who signs in as the student, must acknowledge it; reminders go out until they do. */
export const StudentRemark = model('StudentRemark', new Schema({
  tenantId: tenant, studentId: ref('Student', { required: true, index: true }), teacherId: ref('Teacher', { required: true }), text: { type: String, required: true }, date: String,
  category: { type: String, enum: ['remark', 'homework', 'behaviour', 'guideline'], default: 'remark' }, requireAck: { type: Boolean, default: true },
  ackAt: Date, ackByName: String, reminders: { type: Number, default: 0 }, lastRemindedOn: String,
}, opts));

// ───────────── Files & imports ─────────────
export const File = model('File', new Schema({
  tenantId: tenant, originalName: String, mime: String, size: Number, storageKey: { type: String, required: true },
  kind: { type: String, enum: ['homework', 'material', 'document', 'photo', 'announcement', 'leave', 'ticket'], required: true },
  ownerType: String, ownerId: String, docType: String, visibility: { type: String, enum: ['owner', 'school'], default: 'owner' },
  uploadedBy: ref('User'), enc: { type: Boolean, default: false }, // enc: the stored bytes are encrypted with the data key
  store: { type: String, enum: ['disk', 'gridfs', 'r2'], default: 'disk' }, gridId: ObjectId, objectKey: String, // r2: the bytes are in the object store under objectKey; gridfs: the bytes are in the database (collection files.files / files.chunks); disk: an older upload on one server's disk
}, opts));

export const ImportBatch = model('ImportBatch', new Schema({
  tenantId: tenant, entity: { type: String, enum: ['students', 'teachers'] }, createdBy: ref('User'), actingAsSuperAdmin: Boolean,
  total: Number, created: Number, skipped: Number, status: { type: String, enum: ['committed', 'rolled_back'], default: 'committed' },
  userIds: [ref('User')], recordIds: [ObjectId], rowErrors: Schema.Types.Mixed,
}, opts));

// ───────────── Finance ─────────────
export const FeeStructure = model('FeeStructure', (() => {
  const s = new Schema({
    tenantId: tenant, yearId: ref('AcademicYear', { required: true }), classId: ref('Class'), name: { type: String, required: true, trim: true },
    // how Indian schools bill: an admission fee once, tuition every month, and optional extras (never an "activities" fee unless the school adds one)
    admissionFee: { type: Number, default: 0 }, monthlyFee: { type: Number, default: 0 }, dueDay: Number,
    extras: [new Schema({ head: String, amount: Number, frequency: { type: String, enum: ['once', 'monthly', 'yearly'], default: 'once' } }, { _id: false })],
    items: [new Schema({ head: String, amount: Number }, { _id: false })], // legacy structures only
    installments: [new Schema({ label: String, dueDate: String, percent: Number }, { _id: false })], // legacy structures only
    autoAssign: { type: Boolean, default: true }, status: { type: String, enum: ['active', 'archived'], default: 'active' }, createdBy: ref('User'),
  }, opts);
  s.index({ tenantId: 1, yearId: 1, name: 1 }, { unique: true });
  return s;
})());

/** One amount a student owes (a fee instalment, a library fine, a manual charge). Payments are allocated to charges. */
export const StudentCharge = model('StudentCharge', (() => {
  const s = new Schema({
    tenantId: tenant, studentId: ref('Student', { required: true, index: true }), yearId: ref('AcademicYear'),
    kind: { type: String, enum: ['fee', 'library_fine', 'other'], default: 'fee' }, label: { type: String, required: true }, category: String,
    structureId: ref('FeeStructure'), period: String, amount: { type: Number, required: true }, concession: { type: Number, default: 0 }, concessionNote: String,
    concessions: [new Schema({ amount: Number, reason: String, kind: String, by: ref('User'), byName: String, at: { type: Date, default: Date.now } }, { _id: false })],
    dueDate: String, paidAmount: { type: Number, default: 0 }, status: { type: String, enum: ['open', 'paid'], default: 'open' },
    source: { type: { type: String }, id: String }, createdBy: ref('User'),
  }, opts);
  s.index({ tenantId: 1, status: 1, dueDate: 1 });
  s.index({ tenantId: 1, structureId: 1, studentId: 1 });
  return s;
})());

/** Immutable money event. A mistake is corrected by a reversal entry; nothing is edited or deleted. */
export const Payment = model('Payment', (() => {
  const s = new Schema({
    tenantId: tenant, studentId: ref('Student', { required: true, index: true }), kind: { type: String, enum: ['payment', 'reversal'], default: 'payment' },
    amount: { type: Number, required: true }, mode: { type: String, enum: ['cash', 'upi', 'cheque', 'bank_transfer', 'card', 'other', 'online'], default: 'cash' }, reference: String,
    receiptNo: { type: String, required: true }, paidOn: { type: String, required: true },
    allocations: [new Schema({ chargeId: ref('StudentCharge'), label: String, amount: Number }, { _id: false })],
    receivedBy: ref('User'), receivedByName: String, note: String,
    status: { type: String, enum: ['completed', 'reversed'], default: 'completed' }, reversalOf: ref('Payment'), reversalReason: String, reversedBy: ref('User'), reversedAt: Date,
  }, opts);
  s.index({ tenantId: 1, receiptNo: 1 }, { unique: true });
  s.index({ tenantId: 1, paidOn: 1 });
  return s;
})());

/**
 * One attempt to pay fees online. The amount is worked out by the server from the student's open charges, never taken from the browser.
 * created: waiting for the person to pay. paid: money received and a receipt issued. failed / expired: nothing was paid.
 * needs_review: the gateway took the money but the dues no longer matched (for example the office recorded a cash payment meanwhile): finance must settle it.
 */
export const PaymentOrder = model('PaymentOrder', (() => {
  const s = new Schema({
    tenantId: tenant, studentId: ref('Student', { required: true, index: true }), userId: ref('User'),
    provider: { type: String, enum: ['mock', 'razorpay'], required: true }, providerOrderId: { type: String, required: true }, providerPaymentId: String,
    amount: { type: Number, required: true }, currency: { type: String, default: 'INR' }, chargeIds: [ref('StudentCharge')],
    status: { type: String, enum: ['created', 'processing', 'paid', 'failed', 'expired', 'needs_review'], default: 'created' },
    paymentId: ref('Payment'), receiptNo: String, failureReason: String, note: String, paidAt: Date,
  }, opts);
  s.index({ providerOrderId: 1 }, { unique: true });
  s.index({ tenantId: 1, status: 1, createdAt: -1 });
  return s;
})());

// ───────────── Library ─────────────
export const Book = model('Book', (() => {
  const s = new Schema({
    tenantId: tenant, title: { type: String, required: true, trim: true }, author: { type: String, trim: true }, isbn: { type: String, trim: true }, category: { type: String, trim: true },
    publisher: String, edition: String, language: String, shelf: String, price: { type: Number, default: 0 }, description: String,
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  }, opts);
  s.index({ tenantId: 1, title: 1 }); s.index({ tenantId: 1, isbn: 1 });
  return s;
})());

export const BookCopy = model('BookCopy', (() => {
  const s = new Schema({
    tenantId: tenant, bookId: ref('Book', { required: true, index: true }), accessionNo: { type: String, required: true },
    status: { type: String, enum: ['available', 'issued', 'lost', 'damaged', 'withdrawn'], default: 'available' }, notes: String,
  }, opts);
  s.index({ tenantId: 1, accessionNo: 1 }, { unique: true });
  return s;
})());

export const LibraryIssue = model('LibraryIssue', (() => {
  const s = new Schema({
    tenantId: tenant, copyId: ref('BookCopy', { required: true }), bookId: ref('Book', { required: true, index: true }),
    borrowerType: { type: String, enum: ['student', 'teacher'], required: true }, borrowerId: { type: ObjectId, required: true }, borrowerUserId: ref('User'),
    issuedOn: { type: String, required: true }, dueDate: { type: String, required: true }, returnedOn: String,
    status: { type: String, enum: ['issued', 'returned', 'lost'], default: 'issued' }, renewals: { type: Number, default: 0 },
    returnCondition: { type: String, enum: ['good', 'damaged', 'lost'] }, fineDays: Number, fineAmount: { type: Number, default: 0 }, fineWaived: { type: Boolean, default: false }, fineNote: String, fineChargeId: ref('StudentCharge'),
    issuedBy: ref('User'), returnedBy: ref('User'),
  }, opts);
  s.index({ tenantId: 1, borrowerType: 1, borrowerId: 1, status: 1 });
  s.index({ tenantId: 1, status: 1, dueDate: 1 });
  s.index({ copyId: 1 }, { unique: true, partialFilterExpression: { status: 'issued' } }); // a copy can have only one open loan
  return s;
})());

export { mongoose };

// ───────────── Transport ─────────────
/** A school bus: vehicle details, its driver and conductor (staff records), route and stops. Managed by the Transport officer. */
export const Bus = model('Bus', (() => {
  const s = new Schema({
    tenantId: tenant, busNo: { type: String, required: true, trim: true }, registrationNo: { type: String, trim: true }, vehicleModel: String,
    capacity: { type: Number, default: 40, min: 1 }, status: { type: String, enum: ['active', 'maintenance', 'retired'], default: 'active' },
    routeName: String, startTime: String, endTime: String, monthlyFare: { type: Number, default: 0 }, stops: [new Schema({ name: String, pickupTime: String, dropTime: String, fare: Number }, { _id: false })],
    driverId: ref('StaffMember'), conductorId: ref('StaffMember'),
    insuranceExpiry: String, fitnessExpiry: String, pollutionExpiry: String, notes: String,
  }, opts);
  s.index({ tenantId: 1, busNo: 1 }, { unique: true });
  return s;
})());

/** Which bus a student rides (at most one) and where they get on. */
/**
 * A vehicle's paper: registration certificate (RC), insurance, pollution (PUC), fitness, route permit, road tax, or something else.
 * One record per standard type per bus (a renewal replaces it); "other" can be added more than once. The copy is an uploaded file.
 */
export const BUS_DOC_TYPES = {
  registration: { label: 'Registration certificate (RC)', expiry: 'optional' },
  insurance: { label: 'Insurance', expiry: 'required' },
  pollution: { label: 'Pollution certificate (PUC)', expiry: 'required' },
  fitness: { label: 'Fitness certificate', expiry: 'required' },
  permit: { label: 'Route permit', expiry: 'required' },
  road_tax: { label: 'Road tax', expiry: 'required' },
  other: { label: 'Other', expiry: 'optional' },
};
export const BusDocument = model('BusDocument', (() => {
  const s = new Schema({
    tenantId: tenant, busId: ref('Bus', { required: true, index: true }), type: { type: String, enum: Object.keys(BUS_DOC_TYPES), required: true }, title: String,
    number: String, issuedOn: String, expiresOn: String, notes: String, fileId: ref('File'), updatedByName: String,
  }, opts);
  s.index({ tenantId: 1, busId: 1, type: 1 }, { unique: true, partialFilterExpression: { type: { $in: ['registration', 'insurance', 'pollution', 'fitness', 'permit', 'road_tax'] } } }); // a standard type exists once per bus; "other" can repeat
  return s;
})());

export const StudentTransport = model('StudentTransport', (() => {
  const s = new Schema({ tenantId: tenant, studentId: ref('Student', { required: true }), busId: ref('Bus', { required: true, index: true }), stop: String, since: String, assignedBy: ref('User') }, opts);
  s.index({ tenantId: 1, studentId: 1 }, { unique: true });
  return s;
})());

// ───────────── Non-teaching staff ─────────────
/** A job title in one school (Driver, Conductor, Sweeper, Gardener…). Every school keeps its own list. */
export const Designation = model('Designation', (() => {
  const s = new Schema({
    tenantId: tenant, name: { type: String, required: true, trim: true },
    group: { type: String, enum: ['transport', 'general', 'teaching'], default: 'general' }, // transport = managed by the Transport officer; teaching = ranks of teachers (PGT, TGT, Head of Department…); general = everyone else who works at the school
    busRole: { type: String, enum: ['driver', 'conductor'], default: null },   // which seat on a bus this title can fill
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  }, opts);
  s.index({ tenantId: 1, name: 1 }, { unique: true });
  return s;
})());

/** Anyone who works at the school but does not teach: drivers, conductors, maintainers, maids, sweepers, gardeners… */
export const StaffMember = model('StaffMember', (() => {
  const s = new Schema({
    tenantId: tenant, userId: ref('User'), staffId: { type: String, required: true }, name: { type: String, required: true, trim: true }, gender: String, dob: String, bloodGroup: String,
    bank: { accountName: String, accountNo: String, ifsc: String, bankName: String, upi: String },
    statutory: { uan: String, esiNo: String, pan: String },
    phone: { type: String, trim: true }, email: { type: String, lowercase: true, trim: true }, address: String, designationId: ref('Designation', { required: true, index: true }), joiningDate: String,
    licenseNo: String, licenseExpiry: String, idProof: String, emergencyContact: { name: String, phone: String }, notes: String,
    status: { type: String, enum: ['active', 'inactive'], default: 'active' }, createdBy: ref('User'),
    deskRole: { type: String, enum: ['finance', 'library', 'transport'] }, // set for the school's own officers (finance, librarian, transport officer): they are employees too, kept in step with their desk login
    canMarkAttendance: { type: Boolean, default: false }, // may take the attendance of teachers and staff from the Staff portal
  }, opts);
  s.index({ tenantId: 1, staffId: 1 }, { unique: true });
  return s;
})());

// ───────────── Staff attendance (teachers, non-teaching staff, transport staff) ─────────────
/** One register per group per day. Teachers and general staff are marked by the School Admin, transport staff by the Transport officer. */
export const StaffAttendanceSession = model('StaffAttendanceSession', (() => {
  const s = new Schema({
    tenantId: tenant, group: { type: String, enum: ['teachers', 'general', 'office', 'transport'], required: true }, date: { type: String, required: true },
    status: { type: String, enum: ['draft', 'submitted'], default: 'draft' }, markedBy: ref('User'), submittedBy: ref('User'), submittedAt: Date,
  }, opts);
  s.index({ tenantId: 1, group: 1, date: 1 }, { unique: true });
  return s;
})());

export const StaffAttendanceRecord = model('StaffAttendanceRecord', (() => {
  const s = new Schema({
    tenantId: tenant, sessionId: ref('StaffAttendanceSession', { required: true, index: true }), group: String, date: { type: String, required: true },
    personType: { type: String, enum: ['teacher', 'staff'], required: true }, personId: { type: ObjectId, required: true },
    status: { type: String, enum: ['present', 'absent', 'late', 'half_day', 'leave'], required: true }, halfSession: { type: String, enum: ['first', 'second'] }, remark: String, checkIn: String, checkOut: String,
    history: [new Schema({ from: String, to: String, reason: String, by: ref('User'), at: { type: Date, default: Date.now } }, { _id: false })],
  }, opts);
  s.index({ tenantId: 1, sessionId: 1, personId: 1 }, { unique: true });
  s.index({ tenantId: 1, personId: 1, date: 1 });
  return s;
})());

// ───────────── Staff leave and punches ─────────────
/** A leave of a non-teaching or transport staff member. Applied for in the Staff portal, or recorded by the desk on their behalf. */
export const StaffLeave = model('StaffLeave', new Schema({
  tenantId: tenant, staffId: ref('StaffMember', { required: true, index: true }), userId: ref('User'), group: { type: String, enum: ['general', 'transport'], required: true },
  leaveType: { type: String, enum: ['casual', 'sick', 'earned', 'other', 'unpaid'], default: 'casual' },
  startDate: { type: String, required: true }, endDate: { type: String, required: true }, days: Number, reason: String,
  halfDay: { type: Boolean, default: false }, halfSession: { type: String, enum: ['first', 'second'] }, // a half day is one date; halfSession is the half the person is away
  status: { type: String, enum: ['submitted', 'approved', 'rejected', 'cancelled'], default: 'submitted' },
  recordedBy: ref('User'), decisionBy: ref('User'), decisionRemark: String, decidedAt: Date,
  awaitingAdmin: { type: Boolean, default: false }, // a transport desk leave that the School Admin has to decide (the officer passed it on, or the school keeps that right)
  withdrawnAt: Date, withdrawnBy: ref('User'), // taken back before a decision, or approved leave cancelled before it began
}, opts));

/** When a person arrived and left on a day. Written by self check-in, by the desk, or imported from a biometric machine's export. */
export const StaffPunch = model('StaffPunch', (() => {
  const s = new Schema({
    tenantId: tenant, personType: { type: String, enum: ['teacher', 'staff'], required: true }, personId: { type: ObjectId, required: true }, group: String, date: { type: String, required: true },
    checkIn: String, checkOut: String, source: { type: String, enum: ['self', 'manual', 'import'], default: 'manual' },
    inLocation: { lat: Number, lng: Number, distance: Number }, outLocation: { lat: Number, lng: Number, distance: Number }, note: String,
  }, opts);
  s.index({ tenantId: 1, personId: 1, date: 1 }, { unique: true });
  s.index({ tenantId: 1, group: 1, date: 1 });
  return s;
})());

// ───────────── School money out: expenses, budgets, approvals ─────────────
export const Expense = model('Expense', (() => {
  const s = new Schema({
    tenantId: tenant, yearId: ref('AcademicYear'), date: { type: String, required: true }, department: { type: String, required: true, trim: true }, work: { type: String, trim: true },
    title: { type: String, required: true, trim: true }, vendor: { type: String, trim: true }, vendorId: ref('Vendor'), billNo: { type: String, trim: true }, amount: { type: Number, required: true, min: 0.01 }, notes: String,
    nature: { type: String, enum: ['revenue', 'capital'], default: 'revenue' }, // running costs (salaries, supplies, repairs) or assets bought (buildings, labs, vehicles)
    attachments: { type: [new Schema({ fileId: ref('File'), name: String, mime: String, size: Number }, { _id: false })], default: [] }, // bills and quotes that go to the approver with the expense
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    submittedBy: ref('User'), submittedByName: String, decidedBy: ref('User'), decidedByName: String, decidedAt: Date, decisionNote: String,
    // money goes out only after approval: Finance records the payment against an approved expense
    paymentStatus: { type: String, enum: ['unpaid', 'paid'], default: 'unpaid' }, paidOn: String, paymentMode: String, paymentRef: String, paymentNote: String, paidByName: String, paidAt: Date,
  }, opts);
  s.index({ tenantId: 1, status: 1, date: -1 });
  return s;
})());

/** Money set aside for a department (and optionally one piece of work) in an academic year. */
export const Budget = model('Budget', (() => {
  const s = new Schema({
    tenantId: tenant, yearId: ref('AcademicYear', { required: true }), kind: { type: String, enum: ['revenue', 'capital'], default: 'revenue' }, department: { type: String, required: true, trim: true }, work: { type: String, trim: true, default: '' },
    allocated: { type: Number, required: true, min: 0 }, notes: String,
  }, opts);
  s.index({ tenantId: 1, yearId: 1, kind: 1, department: 1, work: 1 }, { unique: true });
  return s;
})());

/**
 * A supplier or service provider the school pays. Finance keeps the list; the School Admin approves each vendor before any expense can name it.
 * Changing the name, GSTIN, PAN or bank details of an approved vendor sends it back for approval (a changed bank account is how payments get diverted).
 */
export const VENDOR_STATUS = ['pending', 'approved', 'rejected', 'inactive'];
export const Vendor = model('Vendor', (() => {
  const s = new Schema({
    tenantId: tenant, code: { type: String, required: true }, name: { type: String, required: true, trim: true }, nameKey: { type: String, required: true },
    category: { type: String, trim: true }, contactPerson: String, phone: String, email: { type: String, lowercase: true, trim: true },
    address: String, city: String, state: String, pincode: String,
    gstin: { type: String, uppercase: true, trim: true }, pan: { type: String, uppercase: true, trim: true },
    bankName: String, accountName: String, accountNo: String, ifsc: { type: String, uppercase: true, trim: true }, upi: String,
    paymentTerms: String, notes: String,
    status: { type: String, enum: VENDOR_STATUS, default: 'pending' },
    submittedBy: ref('User'), submittedByName: String, decidedBy: ref('User'), decidedByName: String, decidedAt: Date, decisionNote: String,
  }, opts);
  s.index({ tenantId: 1, code: 1 }, { unique: true });
  s.index({ tenantId: 1, nameKey: 1 }, { unique: true });
  s.index({ tenantId: 1, status: 1, name: 1 });
  return s;
})());

// ───────────── The school itself: profile, gallery, licences, tax details ─────────────
export const SchoolProfile = model('SchoolProfile', new Schema({
  tenantId: { type: ObjectId, ref: 'School', required: true, unique: true },
  tagline: String, about: String, address: String, phone: String, email: String, website: String, board: String, affiliationNo: String, established: String,
  principalName: String, principalMessage: String,
  gallery: [new Schema({ fileId: ref('File'), caption: String }, { _id: true })],
  sections: [new Schema({ title: { type: String, required: true }, body: String }, { _id: true })],
  // visible only to the Finance team
  finance: { gstin: String, pan: String, tan: String, bankName: String, accountName: String, accountNo: String, ifsc: String, branch: String, upi: String },
}, opts));

/**
 * How the school's printed documents (fee receipt, payslip) look: its letterhead, and which uploaded stamp and signature goes on which document.
 * Stamps and signatures are images the School Admin uploads once to a small library and then assigns per document.
 */
export const DocumentSettings = model('DocumentSettings', new Schema({
  tenantId: { type: ObjectId, ref: 'School', required: true, unique: true },
  schoolName: String, addressLine: String, affiliationNo: String, contactLine: String, color: { type: String, default: '#1e3a8a' },
  logoFileId: ref('File'),
  assets: [new Schema({ kind: { type: String, enum: ['stamp', 'signature'], required: true }, name: { type: String, required: true }, fileId: ref('File', { required: true }) }, { _id: true })],
  receipt: { signatureId: ObjectId, caption: String, stampId: ObjectId, note: { type: Boolean, default: true } },
  payslip: { leftSignatureId: ObjectId, leftCaption: String, rightSignatureId: ObjectId, rightCaption: String, stampId: ObjectId, note: { type: Boolean, default: true } },
}, opts));

export const License = model('License', new Schema({
  tenantId: tenant, name: { type: String, required: true, trim: true }, authority: { type: String, enum: ['state', 'central', 'local', 'other'], default: 'state' },
  issuedBy: String, number: String, issuedOn: String, validUntil: String, fileId: ref('File'), notes: String,
}, opts));

// ───────────── Teacher and parent: chat ─────────────
/** One conversation between a teacher and a student's family (they sign in as the student). */
export const ChatThread = model('ChatThread', (() => {
  const s = new Schema({
    tenantId: tenant, studentId: ref('Student', { required: true }), teacherId: ref('Teacher', { required: true }), topic: String,
    lastMessageAt: Date, lastPreview: String, unreadTeacher: { type: Number, default: 0 }, unreadStudent: { type: Number, default: 0 },
  }, opts);
  s.index({ tenantId: 1, studentId: 1, teacherId: 1 }, { unique: true });
  return s;
})());
export const ChatMessage = model('ChatMessage', (() => {
  const s = new Schema({ tenantId: tenant, threadId: ref('ChatThread', { required: true, index: true }), from: { type: String, enum: ['teacher', 'student'], required: true }, fromUserId: ref('User'), text: { type: String, required: true } }, opts);
  s.index({ threadId: 1, createdAt: 1 });
  return s;
})());

// ───────────── Attendance extras ─────────────
/** A teacher asks to take attendance on a day the school does not work (a Sunday exam, a talent test). The School Admin approves. */
export const AttendanceException = model('AttendanceException', (() => {
  const s = new Schema({
    tenantId: tenant, sectionId: ref('Section', { required: true }), date: { type: String, required: true }, reason: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }, requestedBy: ref('User'), requestedByName: String, teacherId: ref('Teacher'),
    decidedBy: ref('User'), decidedByName: String, decidedAt: Date, decisionNote: String,
  }, opts);
  s.index({ tenantId: 1, sectionId: 1, date: 1 }, { unique: true });
  return s;
})());

/** Attendance taken period by period, for schools that want it (a setting). */
export const PeriodAttendanceSession = model('PeriodAttendanceSession', (() => {
  const s = new Schema({
    tenantId: tenant, yearId: ref('AcademicYear'), sectionId: ref('Section', { required: true }), periodId: ref('TimetablePeriod', { required: true }), date: { type: String, required: true },
    teacherId: ref('Teacher'), subjectId: ref('Subject'), markedBy: ref('User'),
    records: [new Schema({ studentId: ref('Student', { required: true }), status: { type: String, enum: ['present', 'absent', 'late', 'half_day', 'leave', 'excused'], required: true } }, { _id: false })],
  }, opts);
  s.index({ tenantId: 1, sectionId: 1, date: 1, periodId: 1 }, { unique: true });
  return s;
})());

// ───────────── Timetable: a teacher asks to swap a period ─────────────
export const SwapRequest = model('SwapRequest', (() => {
  const s = new Schema({
    tenantId: tenant, date: { type: String, required: true }, reason: String,
    fromTeacherId: ref('Teacher', { required: true }), fromEntryId: ref('TimetableEntry', { required: true }),
    toTeacherId: ref('Teacher', { required: true }), toEntryId: ref('TimetableEntry'),
    peerStatus: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' }, peerNote: String,
    adminStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }, adminNote: String, decidedBy: ref('User'), decidedByName: String, decidedAt: Date,
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'declined', 'cancelled'], default: 'pending' },
  }, opts);
  s.index({ tenantId: 1, status: 1, date: 1 });
  return s;
})());


// ───────────── platform plumbing: errors, durable email, job leases, idempotency, migrations ─────────────
/** Server and browser errors, kept for 30 days so the Platform Admin can see what broke. */
export const ErrorLog = model('ErrorLog', (() => {
  const s = new Schema({
    source: { type: String, enum: ['server', 'client'], default: 'server' }, requestId: String, method: String, path: String, status: Number,
    message: String, stack: String, tenantId: { type: ObjectId, default: null }, userId: { type: ObjectId, default: null }, userAgent: String, at: { type: Date, default: Date.now },
  }, { timestamps: false });
  s.index({ at: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
  return s;
})());

/** An email waiting to be sent. Kept in the database so a restart loses nothing and two servers never send the same one. */
export const EmailOutbox = model('EmailOutbox', (() => {
  const s = new Schema({
    to: String, subject: String, html: String, text: String, replyTo: String,
    priority: { type: Number, default: 0 }, // 1 = time-sensitive (a sign-in code): sent before any bulk mail that is waiting
    attachments: { type: [new Schema({ filename: String, contentType: String, content: String }, { _id: false })], default: [] }, // content is base64; dropped once the email is sent
    status: { type: String, enum: ['pending', 'processing', 'sent', 'failed'], default: 'pending', index: true },
    tries: { type: Number, default: 0 }, nextAt: { type: Date, default: Date.now }, leaseUntil: Date, lastError: String, sentAt: Date,
  }, opts);
  s.index({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 3600 });
  return s;
})());

/** One named lease at a time: scheduled jobs take it so that, with several servers, only one runs each job. */
export const JobLease = model('JobLease', new Schema({ name: { type: String, required: true, unique: true }, holder: String, until: Date }, { timestamps: false }));

/** A POST that was already done once under the same Idempotency-Key: repeating it returns the first answer instead of doing it again. */
export const IdempotencyRecord = model('IdempotencyRecord', (() => {
  const s = new Schema({ scope: { type: String, required: true, unique: true }, bodyHash: String, state: { type: String, enum: ['processing', 'done'], default: 'processing' }, status: Number, response: Schema.Types.Mixed, expiresAt: { type: Date, required: true } }, { timestamps: false });
  s.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return s;
})());

/** Which database migrations have run. */
export const Migration = model('Migration', new Schema({ id: { type: String, required: true, unique: true }, description: String, appliedAt: { type: Date, default: Date.now } }, { timestamps: false }));

/** A forgotten-password request: a 6-digit code sent to the registered email (only its hash is kept), then a one-time token once the code is right. Lasts 10 minutes. */
export const PasswordResetCode = model('PasswordResetCode', (() => {
  const s = new Schema({ userId: { type: ObjectId, ref: 'User', required: true, index: true }, codeHash: String, tries: { type: Number, default: 0 }, expiresAt: { type: Date, required: true }, tokenHash: String, usedAt: Date }, { timestamps: true });
  s.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });
  return s;
})());
