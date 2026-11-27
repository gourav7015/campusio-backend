import {
  TimetableEntry, TimetablePeriod, TeachingAssignment, Subject, Teacher, Section, ClassModel, Substitution, StudentEnrolment, AttendanceSession, ClassTeacherAssignment,
} from '../models/index.js';
import { isoDay, addDays, nowTimeStr } from '../core/utils.js';
import { inForce } from './context.js';

const byId = (arr, key = '_id') => new Map(arr.map((x) => [String(x[key]), x]));

async function refs(tenantId, entries) {
  const asgIds = [...new Set(entries.map((e) => String(e.assignmentId)).filter((x) => x !== 'undefined'))];
  const assignments = await TeachingAssignment.find({ tenantId, _id: { $in: asgIds } }).lean();
  const [subjects, teachers, sections, periods] = await Promise.all([
    Subject.find({ tenantId, _id: { $in: assignments.map((a) => a.subjectId) } }).lean(),
    Teacher.find({ tenantId, _id: { $in: assignments.map((a) => a.teacherId) } }).select('name').lean(),
    Section.find({ tenantId, _id: { $in: entries.map((e) => e.sectionId) } }).lean(),
    TimetablePeriod.find({ tenantId }).sort({ order: 1 }).lean(),
  ]);
  const classes = await ClassModel.find({ tenantId, _id: { $in: sections.map((s) => s.classId) } }).lean();
  return { A: byId(assignments), S: byId(subjects), T: byId(teachers), SEC: byId(sections), C: byId(classes), periods, P: byId(periods) };
}

function statusFor(period, date, today, nowTime) {
  if (date < today) return 'completed';
  if (date > today) return 'upcoming';
  if (nowTime >= period.endTime) return 'completed';
  if (nowTime >= period.startTime) return 'current';
  return 'upcoming';
}

function markNext(rows) {
  const next = rows.find((r) => r.status === 'upcoming');
  if (next) next.status = 'next';
  return rows;
}

function row(entry, R, date, today, nowTime, subst, teachers) {
  const a = R.A.get(String(entry.assignmentId));
  const period = R.P.get(String(entry.periodId));
  const sec = R.SEC.get(String(entry.sectionId));
  const cls = sec && R.C.get(String(sec.classId));
  const origTeacher = a && R.T.get(String(a.teacherId));
  const subTeacher = subst && teachers.get(String(subst.substituteTeacherId));
  return {
    entryId: entry._id, day: entry.day, date, period: period?.name, periodOrder: period?.order, startTime: period?.startTime, endTime: period?.endTime,
    sectionId: entry.sectionId, className: cls?.name, section: sec?.name, sectionLabel: cls && sec ? `${cls.name.replace(/^Class\s*/i, '')}-${sec.name}` : undefined,
    subject: a ? R.S.get(String(a.subjectId))?.name : null, subjectId: a?.subjectId,
    teacher: subTeacher?.name || origTeacher?.name || null, teacherId: subst ? subst.substituteTeacherId : a?.teacherId,
    originalTeacher: subst ? origTeacher?.name : undefined, substitute: !!subst, substitutionReason: subst?.reason,
    room: entry.room || sec?.room, unresolved: entry.unresolved || !a, status: statusFor(period, date, today, nowTime),
  };
}

const breaksOf = (periods) => periods.filter((p) => p.type === 'break').map((p) => ({ period: p.name, periodOrder: p.order, startTime: p.startTime, endTime: p.endTime, isBreak: true }));

/** One section's timetable for one date, with substitutions applied and breaks interleaved. */
export async function sectionDay({ tenantId, yearId, sectionId, date, today, tz }) {
  const entries = await TimetableEntry.find({ tenantId, yearId, sectionId, day: isoDay(date) }).lean();
  const subs = await Substitution.find({ tenantId, date, entryId: { $in: entries.map((e) => e._id) } }).lean();
  const R = await refs(tenantId, entries);
  const subTeachers = byId(await Teacher.find({ tenantId, _id: { $in: subs.map((s) => s.substituteTeacherId) } }).select('name').lean());
  const subByEntry = byId(subs, 'entryId');
  const nowTime = nowTimeStr(tz);
  const lessons = entries.map((e) => row(e, R, date, today, nowTime, subByEntry.get(String(e._id)), subTeachers));
  const lessonOrders = new Set(lessons.map((l) => l.periodOrder));
  const free = R.periods.filter((p) => p.type === 'lesson' && !lessonOrders.has(p.order)).map((p) => ({ period: p.name, periodOrder: p.order, startTime: p.startTime, endTime: p.endTime, free: true }));
  const rows = [...lessons, ...free, ...breaksOf(R.periods)].sort((a, b) => a.periodOrder - b.periodOrder);
  markNext(rows.filter((r) => !r.isBreak && !r.free));
  return rows;
}

export async function sectionWeek({ tenantId, yearId, sectionId, date, today, tz, days = [1, 2, 3, 4, 5, 6] }) {
  const monday = addDays(date, 1 - isoDay(date));
  const out = [];
  for (const d of days) {
    const dt = addDays(monday, d - 1);
    out.push({ day: d, date: dt, rows: await sectionDay({ tenantId, yearId, sectionId, date: dt, today, tz }) });
  }
  return out;
}

/** A teacher's lessons for one date: own periods (minus those covered by a substitute) plus periods they cover. */
export async function teacherDay({ tenantId, yearId, teacherId, date, today, tz, periodWise = false }) {
  const day = isoDay(date);
  const assignments = await TeachingAssignment.find({ tenantId, yearId, teacherId }).lean();
  const mine = assignments.filter((a) => inForce(a, date));
  const entries = await TimetableEntry.find({ tenantId, yearId, day, assignmentId: { $in: mine.map((a) => a._id) } }).lean();
  const [coveredAway, covering] = await Promise.all([
    Substitution.find({ tenantId, date, entryId: { $in: entries.map((e) => e._id) } }).lean(),
    Substitution.find({ tenantId, date, substituteTeacherId: teacherId }).lean(),
  ]);
  const coveredIds = new Set(coveredAway.map((s) => String(s.entryId)));
  const covEntries = await TimetableEntry.find({ tenantId, _id: { $in: covering.map((s) => s.entryId) } }).lean();
  const all = [...entries.filter((e) => !coveredIds.has(String(e._id))), ...covEntries];
  const R = await refs(tenantId, all);
  const teachers = byId(await Teacher.find({ tenantId, _id: { $in: [teacherId] } }).select('name').lean());
  const subByEntry = byId(covering, 'entryId');
  const nowTime = nowTimeStr(tz);
  const rows = all.map((e) => row(e, R, date, today, nowTime, subByEntry.get(String(e._id)), teachers));

  const sectionIds = [...new Set(rows.map((r) => String(r.sectionId)))];
  const [counts, sessions] = await Promise.all([
    StudentEnrolment.aggregate([{ $match: { tenantId, status: 'active', sectionId: { $in: [...new Set(all.map((e) => e.sectionId))] } } }, { $group: { _id: '$sectionId', n: { $sum: 1 } } }]),
    AttendanceSession.find({ tenantId, date, sectionId: { $in: all.map((e) => e.sectionId) } }).select('sectionId status').lean(),
  ]);
  const cm = new Map(counts.map((c) => [String(c._id), c.n]));
  const sm = new Map(sessions.map((s) => [String(s.sectionId), s.status]));
  // the daily register is the class teacher's; a subject teacher's period does not show it
  const mineAsClassTeacher = new Set((await ClassTeacherAssignment.find({ tenantId, yearId, teacherId }).lean()).filter((a) => inForce(a, date)).map((a) => String(a.sectionId)));
  rows.forEach((r) => {
    r.studentCount = cm.get(String(r.sectionId)) || 0; r.covering = r.substitute;
    // the class teacher's daily register is shown against their lessons only in a school that takes attendance once a day
    if (!periodWise && mineAsClassTeacher.has(String(r.sectionId))) { r.attendance = sm.get(String(r.sectionId)) || 'not_marked'; r.classTeacher = true; }
  });
  void sectionIds;
  rows.sort((a, b) => a.periodOrder - b.periodOrder);
  return markNext(rows);
}

export async function teacherWeek({ tenantId, yearId, teacherId, date, today, tz, days = [1, 2, 3, 4, 5, 6], periodWiseOn = () => false }) {
  const monday = addDays(date, 1 - isoDay(date));
  const out = [];
  for (const d of days) {
    const dt = addDays(monday, d - 1);
    out.push({ day: d, date: dt, rows: await teacherDay({ tenantId, yearId, teacherId, date: dt, today, tz, periodWise: periodWiseOn(dt) }) });
  }
  return out;
}

export async function periodsOf(tenantId) {
  return TimetablePeriod.find({ tenantId }).sort({ order: 1 }).lean();
}
