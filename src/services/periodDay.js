import { AttendanceSession, AttendanceRecord, PeriodAttendanceSession, TimetableEntry, TimetablePeriod, Section } from '../models/index.js';
import { isoDay } from '../core/utils.js';
import { dayRuleOf } from './attendanceMode.js';
import { registerStudents } from '../modules/attendance/attendance.service.js';

/**
 * When a school takes attendance period by period there is no daily register. The DAY is worked out from the period registers and stored as an
 * ordinary AttendanceSession + AttendanceRecords (source: 'periods'), so percentages, reports, report cards, low-attendance lists and the student's
 * calendar keep working without knowing which way a day was taken.
 *
 * The rule (set by the School Admin, default 75 / 40):
 *   present in at least presentPct% of the periods taken  -> Present (Late if the first period taken was late)
 *   present in at least halfPct%                          -> Half day
 *   less                                                  -> Absent
 * Half a period counts half, Late counts as present unless the school says otherwise, leave and excused periods are left out of the count,
 * a period nobody has submitted is left out, and a day with fewer than half of its periods submitted is "not complete yet": nothing is stored,
 * so it is never read as absent.
 */
export const periodCredit = (status, lateCounts) => (status === 'present' ? 2 : status === 'late' ? (lateCounts ? 2 : 0) : status === 'half_day' ? 1 : status === 'absent' ? 0 : null);

/** The period ids a section has on that weekday (breaks excluded). */
export async function lessonPeriodsOf(tenantId, yearId, sectionId, date) {
  const entries = await TimetableEntry.find({ tenantId, yearId, sectionId, day: isoDay(date) }).select('periodId').lean();
  const ids = [...new Set(entries.map((e) => String(e.periodId)))];
  const periods = await TimetablePeriod.find({ tenantId, _id: { $in: ids }, type: { $ne: 'break' } }).sort({ order: 1 }).lean();
  return periods;
}

export function dayFromPeriods(credits, rule, { firstWasLate = false, firstHalfCredit = 0, secondHalfCredit = 0 } = {}) {
  // credits: array of 0 | 1 | 2 (twice the share of a period attended), already without excused periods
  const counted = credits.length;
  if (!counted) return null;
  const score2 = credits.reduce((a, b) => a + b, 0);
  const full = score2 * 100 >= 2 * rule.presentPct * counted;
  const half = score2 * 100 >= 2 * rule.halfPct * counted;
  if (full) return { status: firstWasLate ? 'late' : 'present' };
  if (half) return { status: 'half_day', halfSession: firstHalfCredit >= secondHalfCredit ? 'first' : 'second' };
  return { status: 'absent' };
}

/**
 * Work the day out again from the submitted period registers. Call after any period register is submitted, changed or corrected.
 * Never touches a day that was taken as a daily register.
 */
export async function recomputeDay({ tenantId, settings }, sectionId, date) {
  const section = await Section.findOne({ _id: sectionId, tenantId });
  if (!section) return { state: 'none' };
  const existing = await AttendanceSession.findOne({ tenantId, sectionId, date });
  if (existing && existing.source !== 'periods') return { state: 'register' };
  const sessions = (await PeriodAttendanceSession.find({ tenantId, sectionId, date, status: 'submitted' }).lean());
  const lessons = await lessonPeriodsOf(tenantId, section.yearId, sectionId, date);
  const order = new Map(lessons.map((p, i) => [String(p._id), i]));
  const extra = sessions.filter((s) => !order.has(String(s.periodId))).length; // a lesson that was moved after it was marked still counts
  const expected = lessons.length + extra;
  const need = Math.max(1, Math.ceil(expected / 2));
  const taken = sessions.length;
  if (taken < need) {
    if (existing) { existing.status = 'draft'; await existing.save(); }
    return { state: 'incomplete', taken, expected };
  }
  const periods = await TimetablePeriod.find({ tenantId, _id: { $in: sessions.map((s) => s.periodId) } }).select('order').lean();
  const ord = new Map(periods.map((p) => [String(p._id), p.order]));
  sessions.sort((a, b) => (ord.get(String(a.periodId)) ?? 99) - (ord.get(String(b.periodId)) ?? 99));
  const rule = dayRuleOf(settings.attendance);
  const lateCounts = settings.attendance?.lateCountsAsPresent !== false;
  const list = await registerStudents(tenantId, sectionId, date);
  const derived = [];
  for (const { enrolment, student } of list) {
    const credits = []; const first = []; const second = []; let firstWasLate = false; let seenFirst = false; let excused = 0;
    sessions.forEach((s, i) => {
      const rec = s.records.find((r) => String(r.studentId) === String(student._id));
      if (!rec) return;
      const c = periodCredit(rec.status, lateCounts);
      if (c === null) { excused++; return; }
      if (!seenFirst) { seenFirst = true; firstWasLate = rec.status === 'late'; }
      credits.push(c);
      (i < sessions.length / 2 ? first : second).push(c);
    });
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    let day = dayFromPeriods(credits, rule, { firstWasLate, firstHalfCredit: sum(first), secondHalfCredit: sum(second) });
    if (!day && excused) day = { status: 'leave' };
    if (day) derived.push({ enrolment, student, day });
  }
  const session = await AttendanceSession.findOneAndUpdate({ tenantId, sectionId, date },
    { $set: { yearId: section.yearId, status: 'submitted', source: 'periods', submittedAt: new Date() } }, { upsert: true, new: true });
  if (derived.length) {
    await AttendanceRecord.bulkWrite(derived.map(({ enrolment, student, day }) => ({
      updateOne: {
        filter: { sessionId: session._id, studentId: student._id },
        update: { $set: { tenantId, status: day.status, halfSession: day.halfSession || null, remarks: 'Worked out from the periods', enrolmentId: enrolment._id, sectionId, yearId: section.yearId, date } },
        upsert: true,
      },
    })));
  }
  await AttendanceRecord.deleteMany({ sessionId: session._id, studentId: { $nin: derived.map((d) => d.student._id) } });
  return { state: 'complete', taken, expected, rule };
}
