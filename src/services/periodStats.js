import mongoose from 'mongoose';
import { PeriodAttendanceSession, Subject, TimetablePeriod, Teacher, TimetableEntry, TeachingAssignment } from '../models/index.js';
import { dayRuleOf } from './attendanceMode.js';
import { addDays, isoDay } from '../core/utils.js';

/**
 * A student's attendance when it is taken period by period: per subject, not per day. Every subject has its own number of lessons, so a
 * percentage of "days" would say nothing. Only submitted period registers count; leave and excused periods are left out; late counts as
 * present unless the school says it does not; a half day counts half.
 */
const key = (id) => (id ? String(id) : 'other');
const mondayOf = (d) => addDays(d, -(isoDay(d) - 1));
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

/** Sessions of one student, with only that student's record kept (not the whole class). */
const sessionsOf = (tenantId, yearId, studentId, extra = {}) => {
  const sid = new mongoose.Types.ObjectId(String(studentId)); // a projection is not cast like a filter is
  return PeriodAttendanceSession.find({ tenantId, yearId, status: 'submitted', 'records.studentId': sid, ...extra }).select({ subjectId: 1, date: 1, periodId: 1, records: { $elemMatch: { studentId: sid } } }).lean();
};

/** Where a subject stands against the school's attendance target: what to do next to stay safe, or to get back above it. */
function advice(attended, periods, target) {
  const t = target / 100;
  if (!periods || !(t > 0 && t < 1)) return { state: 'none' };
  const p = attended / periods;
  if (p >= t) {
    const canMiss = Math.floor(attended / t - periods + 1e-9);
    return { state: p >= t + 0.1 ? 'good' : 'watch', canMiss: Math.max(canMiss, 0) };
  }
  return { state: 'low', needed: Math.max(Math.ceil((t * periods - attended) / (1 - t) - 1e-9), 1) };
}

/**
 * The subjects a class has on its timetable, with who teaches each and how many lessons a week: shown before any lesson has been marked,
 * so the page is never empty, and for subjects that have no mark yet.
 */
export async function plannedSubjects({ tenantId, yearId, sectionId }) {
  if (!yearId || !sectionId) return [];
  const entries = await TimetableEntry.find({ tenantId, yearId, sectionId }).select('assignmentId periodId').lean();
  if (!entries.length) return [];
  const asg = new Map((await TeachingAssignment.find({ tenantId, _id: { $in: [...new Set(entries.map((e) => e.assignmentId).filter(Boolean).map(String))] } }).select('subjectId teacherId').lean()).map((a) => [String(a._id), a]));
  const [subj, teach, periods] = await Promise.all([
    Subject.find({ tenantId, _id: { $in: [...new Set([...asg.values()].map((a) => a.subjectId).filter(Boolean).map(String))] } }).select('name').lean(),
    Teacher.find({ tenantId, _id: { $in: [...new Set([...asg.values()].map((a) => a.teacherId).filter(Boolean).map(String))] } }).select('name').lean(),
    TimetablePeriod.find({ tenantId, _id: { $in: [...new Set(entries.map((e) => String(e.periodId)))] } }).select('type').lean(),
  ]);
  const sn = new Map(subj.map((s) => [String(s._id), s.name])); const tn = new Map(teach.map((t) => [String(t._id), t.name]));
  const isBreak = new Set(periods.filter((p) => p.type === 'break').map((p) => String(p._id)));
  const out = new Map();
  for (const e of entries) {
    const a = asg.get(String(e.assignmentId)); if (!a || isBreak.has(String(e.periodId))) continue;
    const k = key(a.subjectId); const o = out.get(k) || { subjectId: k, subject: sn.get(k) || 'Other', teacher: tn.get(String(a.teacherId)) || '', weekly: 0 };
    o.weekly++; out.set(k, o);
  }
  return [...out.values()].sort((x, y) => x.subject.localeCompare(y.subject));
}

export async function subjectStats({ tenantId, yearId, studentId, settings, sectionId }) {
  const target = dayRuleOf(settings.attendance).presentPct;
  const lateCounts = settings.attendance?.lateCountsAsPresent !== false;
  const planned = await plannedSubjects({ tenantId, yearId, sectionId });
  const empty = { since: null, target, lateCountsAsPresent: lateCounts, planned, totals: { periods: 0, attended: 0, absent: 0, late: 0, halfDay: 0, leave: 0, percentage: null }, subjects: [], weekly: [] };
  if (!yearId) return empty;
  const sessions = await sessionsOf(tenantId, yearId, studentId);
  if (!sessions.length) return empty;
  const [subj, periods] = await Promise.all([
    Subject.find({ tenantId, _id: { $in: [...new Set(sessions.map((s) => s.subjectId).filter(Boolean).map(String))] } }).select('name').lean(),
    TimetablePeriod.find({ tenantId, _id: { $in: [...new Set(sessions.map((s) => String(s.periodId)))] } }).select('order').lean(),
  ]);
  const name = new Map(subj.map((s) => [String(s._id), s.name]));
  const order = new Map(periods.map((p) => [String(p._id), p.order]));
  const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date) || (order.get(String(a.periodId)) || 0) - (order.get(String(b.periodId)) || 0));

  const by = new Map(); const weeks = new Map();
  const totals = { periods: 0, attended: 0, absent: 0, late: 0, halfDay: 0, leave: 0 };
  let since = null;
  for (const s of sorted) {
    const r = s.records?.[0]; if (!r) continue;
    const k = key(s.subjectId);
    if (!by.has(k)) by.set(k, { subjectId: k, subject: name.get(k) || 'Other', periods: 0, attended: 0, absent: 0, late: 0, halfDay: 0, leave: 0, lastAbsent: null, recent: [] });
    const o = by.get(k);
    o.recent.push(r.status); if (o.recent.length > 8) o.recent.shift();
    if (r.status === 'leave' || r.status === 'excused') { o.leave++; totals.leave++; continue; }
    if (!since || s.date < since) since = s.date;
    const got = r.status === 'present' || (r.status === 'late' && lateCounts) ? 1 : r.status === 'half_day' ? 0.5 : 0;
    o.periods++; o.attended += got; totals.periods++; totals.attended += got;
    if (r.status === 'late') { o.late++; totals.late++; }
    if (r.status === 'half_day') { o.halfDay++; totals.halfDay++; }
    if (r.status === 'absent' || (r.status === 'late' && !lateCounts)) { o.absent++; totals.absent++; o.lastAbsent = s.date; }
    const w = mondayOf(s.date); const wk = weeks.get(w) || { week: w, periods: 0, attended: 0 };
    wk.periods++; wk.attended += got; weeks.set(w, wk);
  }
  const subjects = [...by.values()].filter((o) => o.periods || o.leave).map((o) => ({ ...o, percentage: pct(o.attended, o.periods), ...advice(o.attended, o.periods, target) }))
    .sort((a, b) => (a.percentage ?? 101) - (b.percentage ?? 101) || a.subject.localeCompare(b.subject)); // the ones that need attention come first
  return {
    since, target, lateCountsAsPresent: lateCounts, planned,
    totals: { ...totals, percentage: pct(totals.attended, totals.periods), below: subjects.filter((s) => s.state === 'low').length },
    subjects,
    weekly: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)).slice(-10).map((w) => ({ week: w.week, periods: w.periods, percentage: pct(w.attended, w.periods) })),
  };
}

/** One subject, period by period, newest first (for the "show me every period" sheet). */
export async function subjectPeriods({ tenantId, yearId, studentId, subjectId, limit = 120 }) {
  const extra = subjectId === 'other' ? { subjectId: null } : { subjectId };
  const sessions = (await sessionsOf(tenantId, yearId, studentId, extra)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  const [periods, subj] = await Promise.all([
    TimetablePeriod.find({ tenantId, _id: { $in: [...new Set(sessions.map((s) => String(s.periodId)))] } }).select('name startTime endTime order').lean(),
    subjectId === 'other' ? null : Subject.findOne({ tenantId, _id: subjectId }).select('name').lean(),
  ]);
  const P = new Map(periods.map((p) => [String(p._id), p]));
  const rows = sessions.map((s) => { const p = P.get(String(s.periodId)); return { date: s.date, day: isoDay(s.date), period: p?.name || '', order: p?.order || 0, time: p ? `${p.startTime}–${p.endTime}` : '', status: s.records?.[0]?.status || null }; })
    .sort((a, b) => b.date.localeCompare(a.date) || a.order - b.order);
  return { subjectId, subject: subj?.name || 'Other', rows };
}

/**
 * Every student of a section, period by period, for the class teacher and the office: overall attendance in lessons, how many subjects each
 * is below the target in, and how the class does in each subject. Counted by the database, so a big section stays quick.
 * `roster` = [{ studentId, name, rollNo, admissionNo }].
 */
export async function sectionSummary({ tenantId, yearId, sectionId, roster, settings, from, to }) {
  const planned = await plannedSubjects({ tenantId, yearId, sectionId });
  const target = dayRuleOf(settings.attendance).presentPct;
  const lateCounts = settings.attendance?.lateCountsAsPresent !== false;
  const oid = (x) => new mongoose.Types.ObjectId(String(x));
  const rows = await PeriodAttendanceSession.aggregate([
    { $match: { tenantId: oid(tenantId), yearId: oid(yearId), sectionId: oid(sectionId), status: 'submitted', ...(from || to ? { date: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {}) } },
    { $unwind: '$records' },
    { $group: { _id: { s: '$records.studentId', sub: '$subjectId', st: '$records.status' }, n: { $sum: 1 } } },
  ]);
  const names = new Map((await Subject.find({ tenantId, _id: { $in: [...new Set(rows.map((r) => r._id.sub).filter(Boolean).map(String))] } }).select('name').lean()).map((s) => [String(s._id), s.name]));
  const who = await PeriodAttendanceSession.aggregate([{ $match: { tenantId: oid(tenantId), yearId: oid(yearId), sectionId: oid(sectionId), status: 'submitted' } }, { $group: { _id: { sub: '$subjectId', t: '$teacherId' }, n: { $sum: 1 } } }]);
  const tn = new Map((await Teacher.find({ tenantId, _id: { $in: [...new Set(who.map((w) => w._id.t).filter(Boolean).map(String))] } }).select('name').lean()).map((t) => [String(t._id), t.name]));
  const teacherOf = new Map();
  for (const w of who.sort((a, b) => a.n - b.n)) teacherOf.set(key(w._id.sub), tn.get(String(w._id.t)) || ''); // the one who took most of the lessons wins
  const per = new Map(); const bySubject = new Map();
  for (const r of rows) {
    const { s, sub, st } = r._id;
    if (st === 'leave' || st === 'excused') continue;
    const got = (st === 'present' || (st === 'late' && lateCounts) ? 1 : st === 'half_day' ? 0.5 : 0) * r.n;
    const sk = String(s); const k = key(sub);
    const o = per.get(sk) || { periods: 0, attended: 0, absent: 0, late: 0, subjects: new Map() };
    o.periods += r.n; o.attended += got; if (st === 'late') o.late += r.n; if (st === 'absent' || (st === 'late' && !lateCounts)) o.absent += r.n;
    const ss = o.subjects.get(k) || { periods: 0, attended: 0 }; ss.periods += r.n; ss.attended += got; o.subjects.set(k, ss); per.set(sk, o);
    const b = bySubject.get(k) || { subjectId: k, subject: names.get(k) || 'Other', periods: 0, attended: 0 }; b.periods += r.n; b.attended += got; bySubject.set(k, b);
  }
  const students = roster.map((st) => {
    const o = per.get(String(st.studentId));
    const percentage = o ? pct(o.attended, o.periods) : null;
    const below = o ? [...o.subjects.values()].filter((x) => x.periods && x.attended / x.periods < target / 100).length : 0;
    const cells = o ? Object.fromEntries([...o.subjects.entries()].map(([k, x]) => [k, pct(x.attended, x.periods)])) : {};
    return { ...st, cells, periods: o?.periods || 0, attended: o?.attended || 0, absent: o?.absent || 0, late: o?.late || 0, percentage, below, state: percentage == null ? 'none' : percentage >= target ? (percentage >= target + 10 ? 'good' : 'watch') : 'low' };
  });
  const counted = students.filter((s) => s.percentage != null);
  const tot = counted.reduce((a, s) => ({ periods: a.periods + s.periods, attended: a.attended + s.attended }), { periods: 0, attended: 0 });
  return {
    target, planned,
    totals: { students: roster.length, marked: counted.length, percentage: pct(tot.attended, tot.periods), below: counted.filter((s) => s.state === 'low').length },
    subjects: [...bySubject.values()].map((b) => ({ ...b, teacher: teacherOf.get(b.subjectId) || '', percentage: pct(b.attended, b.periods) })).sort((a, b) => (a.percentage ?? 101) - (b.percentage ?? 101)),
    students,
  };
}
