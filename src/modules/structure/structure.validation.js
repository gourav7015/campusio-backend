import { z } from 'zod';
import { PASSWORD_FORMAT_RE } from '../../services/initialPassword.js';
import { isDateStr } from '../../core/utils.js';
import { GRADE_NAMES, canonicalGrade } from '../../core/grades.js';

const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

export const classWindows = z.array(z.object({ classId: objectId, startDate: date, endDate: date })
  .refine((w) => w.endDate > w.startDate, { message: 'A class must end after it starts', path: ['endDate'] }))
  .max(20)
  .refine((a) => new Set(a.map((w) => w.classId)).size === a.length, { message: 'A class can only be listed once' });
export const yearBody = z.object({ name: z.string().trim().min(3), startDate: date, endDate: date, isCurrent: z.boolean().optional(), classWindows: classWindows.optional() })
  .refine((y) => y.endDate > y.startDate, { message: 'End date must be after start date', path: ['endDate'] });
export const rolloverBody = z.object({
  fromYearId: objectId, name: z.string().trim().min(3).max(30), startDate: date, endDate: date,
  copySections: z.boolean().default(true), copyOfferings: z.boolean().default(true), copyTeachers: z.boolean().default(false), // teachers are assigned by hand for the new year unless asked for
}).refine((y) => y.endDate > y.startDate, { message: 'End date must be after start date', path: ['endDate'] });
export const yearPatch = z.object({ name: z.string().trim().min(3), startDate: date, endDate: date, classWindows }).partial();

// Only LKG, UKG and Class 1-12 exist. The level is derived from the name, so it is not accepted from the client.
export const classBody = z.object({ name: z.preprocess(canonicalGrade, z.enum(GRADE_NAMES, { errorMap: () => ({ message: 'Choose LKG, UKG, a class from 1 to 12, or a Class 11 or 12 stream' }) })) });
export const classPatch = z.object({ status: z.enum(['active', 'archived']) });

export const sectionBody = z.object({
  yearId: objectId, classId: objectId, name: z.string().trim().min(1).max(10), capacity: z.number().int().min(1).max(200).optional(), room: z.string().max(20).optional(),
});
export const sectionPatch = z.object({
  name: z.string().trim().min(1).max(10), capacity: z.number().int().min(1).max(200), room: z.string().max(20), status: z.enum(['active', 'archived']),
}).partial();


import { componentsInput } from '../../core/components.js';

const assessment = z.object({ components: componentsInput, passMarks: z.number().min(0).max(3000) }).partial();
export const offeringPatch = z.object({ weeklyPeriods: z.number().int().min(1).max(20), assessment }).partial();
export const copyOfferingsBody = z.object({ fromYearId: objectId, toYearId: objectId });

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
export const settingsBody = z.object({
  timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown timezone'),
  language: z.enum(['en', 'hi']),
  workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  grading: z.object({
    passPercentage: z.number().min(0).max(100),
    scale: z.array(z.object({ min: z.number().min(0).max(100), grade: z.string().min(1).max(4) })).min(2)
      .refine((s) => s.some((x) => x.min === 0), 'Scale must include a band starting at 0'),
  }),
  // The way attendance is taken (once a day or period by period) is NOT part of this form: it changes only through PUT /attendance-mode, from a date.
  attendance: z.object({
    lateCountsAsPresent: z.boolean(),
    dayRule: z.object({ presentPct: z.number().int().min(1).max(100), halfPct: z.number().int().min(1).max(99) })
      .refine((r) => r.halfPct < r.presentPct, 'Half day must need fewer periods than a full day'),
  }).partial(),
  passwordFormat: z.string().max(80).refine((f) => f === '' || PASSWORD_FORMAT_RE.test(f), 'Use tokens such as {NAME4}{DDMMYYYY}, plus letters, digits or @ # _ -').refine((f) => f === '' || /\{(NAME4|NAME3|name4|DDMMYYYY|DDMM|YYYY|YY|PHONE4)\}/.test(f), 'Include at least one token, or leave it empty for random passwords'),
  admissionFormat: z.string().refine((f) => /\{SEQ:\d\}/.test(f), 'Must contain {SEQ:n}, e.g. ADM{YYYY}{SEQ:4}'),
  leaveBalances: z.object({ casual: z.number().min(0), sick: z.number().min(0), earned: z.number().min(0), other: z.number().min(0) }).partial(),
  leaveRules: z.object({ teaching: z.object({ maxDays: z.number().int().min(0).max(365), noticeDays: z.number().int().min(0).max(60), halfDay: z.boolean() }).partial(), nonTeaching: z.object({ maxDays: z.number().int().min(0).max(365), noticeDays: z.number().int().min(0).max(60), halfDay: z.boolean() }).partial() }).partial(),
  transportLeaveApprover: z.enum(['officer', 'admin']),
  staffLeaveBalances: z.object({ casual: z.number().min(0), sick: z.number().min(0), earned: z.number().min(0), other: z.number().min(0) }).partial(),
  staffAttendance: z.object({
    shiftStart: time, shiftEnd: time, graceMinutes: z.number().int().min(0).max(120), fullDayHours: z.number().min(1).max(16), halfDayHours: z.number().min(0.5).max(12),
    checkInOpensBeforeMinutes: z.number().int().min(0).max(600), checkInClosesAtShiftEnd: z.boolean(),
    location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), radiusMeters: z.number().int().min(20).max(5000) }).nullable(),
  }).partial(),
  statutory: z.object({
    pf: z.object({ enabled: z.boolean(), employeeRate: z.number().min(0).max(30), employerRate: z.number().min(0).max(30), wageCeiling: z.number().min(0).max(10_000_000) }).partial(),
    esi: z.object({ enabled: z.boolean(), employeeRate: z.number().min(0).max(10), employerRate: z.number().min(0).max(10), grossCeiling: z.number().min(0).max(10_000_000) }).partial(),
    pt: z.object({ enabled: z.boolean(), slabs: z.array(z.object({ upTo: z.number().min(0), amount: z.number().min(0).max(100000) })).min(1).max(8) }).partial(),
  }).partial(),
  showAttendanceVsPerformance: z.boolean(),
  studentCanEditProfile: z.array(z.enum(['phone', 'address', 'email'])).optional(), // no longer used: students never edit their own details (the class teacher does)
  schoolName: z.string(),
}).partial();
