import mongoose from 'mongoose';
import { GRADE_NAMES, levelOf } from '../core/grades.js';

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
  leaveBalances: { casual: 12, sick: 10, earned: 0, other: 0 },
  staffLeaveBalances: { casual: 12, sick: 10, earned: 0, other: 0 },
  // working hours for staff. A check-in after shiftStart + graceMinutes is late; less than halfDayHours is a half day.
  // location (optional): staff may check in from their own login only within radiusMeters of the school.
  staffAttendance: { shiftStart: '08:00', shiftEnd: '15:00', graceMinutes: 10, fullDayHours: 6, halfDayHours: 3, location: null },
  // statutory deductions (India). Off by default: a school switches on what applies to it.
  statutory: {
    pf: { enabled: false, employeeRate: 12, employerRate: 12, wageCeiling: 15000 },
    esi: { enabled: false, employeeRate: 0.75, employerRate: 3.25, grossCeiling: 21000 },
    pt: { enabled: false, slabs: [{ upTo: 12000, amount: 0 }, { upTo: 1000000000, amount: 200 }] },
  },
  showAttendanceVsPerformance: true,
  studentCanEditProfile: ['phone', 'address'],
});

export const School = model('School', new Schema({
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, unique: true, lowercase: true, trim: true },
  address: String, phone: String, email: String, logoUrl: String, board: String,
  status: { type: String, enum: ['active', 'suspended', 'archived'], default: 'active' },
  settings: { type: Schema.Types.Mixed, default: defaultSettings },
}, opts));

export const Subscription = model('Subscription', new Schema({
  schoolId: { type: ObjectId, ref: 'School', required: true, unique: true },
  plan: { type: String, default: 'starter' },
  status: { type: String, enum: ['trial', 'active', 'expired', 'cancelled'], default: 'trial' },
  studentLimit: { type: Number, default: 500 },
  teacherLimit: { type: Number, default: 50 },
  startsOn: String, expiresOn: String,
}, opts));

export const User = model('User', new Schema({
  tenantId: { type: ObjectId, ref: 'School', index: true, default: null },
  role: { type: String, enum: ['super_admin', 'school_admin', 'teacher', 'student', 'finance', 'library', 'transport', 'staff'], required: true },
  loginId: { type: String, required: true, unique: true, lowercase: true, trim: true },
  email: { type: String, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true },
  mustChangePassword: { type: Boolean, default: true },
  status: { type: String, enum: ['active', 'disabled'], default: 'active' },
  lastLoginAt: Date,
  failedLogins: { type: Number, default: 0 },
  lockedUntil: Date,
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
  }, opts);
  s.index({ tenantId: 1, name: 1 }, { unique: true });
  return s;
})());

export const ClassModel = model('Class', (() => {
  const s = new Schema({
    tenantId: tenant, name: { type: String, required: true, trim: true, enum: GRADE_NAMES }, level: { type: Number },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  }, opts);
  s.pre('validate', function setLevel(next) { this.level = levelOf(this.name); next(); }); // level always follows the name
  s.index({ tenantId: 1, name: 1 }, { unique: true });
  return s;
})());

export const Section = model('Section', (() => {
  const s = new Schema({
    tenantId: tenant, yearId: ref('AcademicYear', { required: true }), classId: ref('Class', { required: true }),
    name: { type: String, required: true, trim: true }, capacity: { type: Number, default: 40 }, room: String,
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  }, opts);
  s.index({ tenantId: 1, yearId: 1, classId: 1, name: 1 }, { unique: true });
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
    email: String, phone: String, qualification: String, designation: String, joiningDate: String, address: String,
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
    status: { type: String, enum: ['present', 'absent', 'late', 'leave', 'excused'], required: true },
    remarks: String,
    history: [new Schema({ from: String, to: String, by: ref('User'), byName: String, reason: String, at: { type: Date, default: Date.now } }, { _id: false })],
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
  category: { type: String, enum: ['holiday', 'examination', 'event', 'homework', 'general'], default: 'general' },
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

export const LeaveApplication = model('LeaveApplication', new Schema({
  tenantId: tenant, teacherId: ref('Teacher', { required: true, index: true }), userId: ref('User'),
  leaveType: { type: String, enum: ['casual', 'sick', 'earned', 'other', 'unpaid'], default: 'casual' },
  startDate: { type: String, required: true }, endDate: { type: String, required: true }, days: Number, reason: String, attachmentFileId: ref('File'),
  status: { type: String, enum: ['draft', 'submitted', 'approved', 'rejected', 'cancelled'], default: 'submitted' },
  decisionBy: ref('User'), decisionRemark: String, decidedAt: Date,
}, opts));

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
    status: { type: String, enum: ['pending', 'paid'], default: 'pending' }, paidOn: String, mode: String, reference: String, paidBy: ref('User'),
  }, opts);
  s.index({ tenantId: 1, runId: 1, personId: 1 }, { unique: true });
  return s;
})());

export const StudentRemark = model('StudentRemark', new Schema({
  tenantId: tenant, studentId: ref('Student', { required: true, index: true }), teacherId: ref('Teacher', { required: true }), text: { type: String, required: true }, date: String,
}, opts));

// ───────────── Files & imports ─────────────
export const File = model('File', new Schema({
  tenantId: tenant, originalName: String, mime: String, size: Number, storageKey: { type: String, required: true },
  kind: { type: String, enum: ['homework', 'material', 'document', 'photo', 'announcement', 'leave'], required: true },
  ownerType: String, ownerId: String, docType: String, visibility: { type: String, enum: ['owner', 'school'], default: 'owner' },
  uploadedBy: ref('User'),
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
    concessions: [new Schema({ amount: Number, reason: String, by: ref('User'), byName: String, at: { type: Date, default: Date.now } }, { _id: false })],
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
    amount: { type: Number, required: true }, mode: { type: String, enum: ['cash', 'upi', 'cheque', 'bank_transfer', 'card', 'other'], default: 'cash' }, reference: String,
    receiptNo: { type: String, required: true }, paidOn: { type: String, required: true },
    allocations: [new Schema({ chargeId: ref('StudentCharge'), label: String, amount: Number }, { _id: false })],
    receivedBy: ref('User'), receivedByName: String, note: String,
    status: { type: String, enum: ['completed', 'reversed'], default: 'completed' }, reversalOf: ref('Payment'), reversalReason: String, reversedBy: ref('User'), reversedAt: Date,
  }, opts);
  s.index({ tenantId: 1, receiptNo: 1 }, { unique: true });
  s.index({ tenantId: 1, paidOn: 1 });
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
    group: { type: String, enum: ['transport', 'general'], default: 'general' }, // transport = managed by the Transport officer
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
    phone: { type: String, trim: true }, address: String, designationId: ref('Designation', { required: true, index: true }), joiningDate: String,
    licenseNo: String, licenseExpiry: String, idProof: String, emergencyContact: { name: String, phone: String }, notes: String,
    status: { type: String, enum: ['active', 'inactive'], default: 'active' }, createdBy: ref('User'),
  }, opts);
  s.index({ tenantId: 1, staffId: 1 }, { unique: true });
  return s;
})());

// ───────────── Staff attendance (teachers, non-teaching staff, transport staff) ─────────────
/** One register per group per day. Teachers and general staff are marked by the School Admin, transport staff by the Transport officer. */
export const StaffAttendanceSession = model('StaffAttendanceSession', (() => {
  const s = new Schema({
    tenantId: tenant, group: { type: String, enum: ['teachers', 'general', 'transport'], required: true }, date: { type: String, required: true },
    status: { type: String, enum: ['draft', 'submitted'], default: 'draft' }, markedBy: ref('User'), submittedBy: ref('User'), submittedAt: Date,
  }, opts);
  s.index({ tenantId: 1, group: 1, date: 1 }, { unique: true });
  return s;
})());

export const StaffAttendanceRecord = model('StaffAttendanceRecord', (() => {
  const s = new Schema({
    tenantId: tenant, sessionId: ref('StaffAttendanceSession', { required: true, index: true }), group: String, date: { type: String, required: true },
    personType: { type: String, enum: ['teacher', 'staff'], required: true }, personId: { type: ObjectId, required: true },
    status: { type: String, enum: ['present', 'absent', 'late', 'half_day', 'leave'], required: true }, remark: String, checkIn: String, checkOut: String,
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
  status: { type: String, enum: ['submitted', 'approved', 'rejected', 'cancelled'], default: 'submitted' },
  recordedBy: ref('User'), decisionBy: ref('User'), decisionRemark: String, decidedAt: Date,
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
