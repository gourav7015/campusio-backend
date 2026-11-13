import {
  TimetableEntry, TimetablePeriod, TeachingAssignment, Section, Substitution, Teacher, LeaveApplication, Subject,
} from '../../models/index.js';
import { notFound, conflict, bad, isoDay, eachDate } from '../../core/utils.js';
import { schoolToday, getCurrentYear, inForce } from '../../services/context.js';
import { sectionWeek, sectionDay } from '../../services/timetable.js';

// ── periods ──
export const listPeriods = (tenantId) => TimetablePeriod.find({ tenantId }).sort({ order: 1 });
export const createPeriod = (tenantId, body) => TimetablePeriod.create({ tenantId, ...body });
export async function updatePeriod(tenantId, id, body) {
  const p = await TimetablePeriod.findOne({ _id: id, tenantId });
  if (!p) throw notFound('Period not found');
  Object.assign(p, body);
  if (p.endTime <= p.startTime) throw bad('End time must be after start time');
  return p.save();
}
export async function deletePeriod(tenantId, id) {
  const p = await TimetablePeriod.findOne({ _id: id, tenantId });
  if (!p) throw notFound('Period not found');
  if (await TimetableEntry.exists({ tenantId, periodId: p._id })) throw conflict('This period is used in timetables');
  await p.deleteOne();
}

// ── entries ──
async function checkConflicts(tenantId, { yearId, sectionId, day, periodId, assignment, room, ignoreId }) {
  const sameSlot = { tenantId, yearId, day, periodId, ...(ignoreId ? { _id: { $ne: ignoreId } } : {}) };
  const asgOfTeacher = await TeachingAssignment.find({ tenantId, teacherId: assignment.teacherId }).select('_id');
  const teacherClash = await TimetableEntry.findOne({ ...sameSlot, assignmentId: { $in: asgOfTeacher.map((a) => a._id) }, sectionId: { $ne: sectionId } });
  if (teacherClash) {
    const sec = await Section.findById(teacherClash.sectionId);
    throw conflict(`Teacher is already teaching section ${sec?.name || ''} in that period`, { type: 'teacher' });
  }
  if (room) {
    const roomClash = await TimetableEntry.findOne({ ...sameSlot, room, sectionId: { $ne: sectionId } });
    if (roomClash) throw conflict(`Room ${room} is already used in that period`, { type: 'room' });
  }
}

async function validateEntry(tenantId, body, ignoreId) {
  const [section, period, assignment, { settings, today }] = await Promise.all([
    Section.findOne({ _id: body.sectionId, tenantId }), TimetablePeriod.findOne({ _id: body.periodId, tenantId }),
    TeachingAssignment.findOne({ _id: body.assignmentId, tenantId }), schoolToday(tenantId),
  ]);
  if (!section) throw notFound('Section not found');
  if (!period) throw notFound('Period not found');
  if (!assignment) throw notFound('Teaching assignment not found');
  if (period.type !== 'lesson') throw bad('Lessons cannot be placed in a break');
  if (String(assignment.sectionId) !== String(section._id)) throw bad('That teaching assignment belongs to a different section');
  if (!inForce(assignment, today) && !assignment.open) throw conflict('That teaching assignment has ended');
  if (!settings.workingDays.includes(body.day)) throw bad('That day is not a working day for this school');
  const teacher = await Teacher.findById(assignment.teacherId);
  if (teacher?.status !== 'active') throw conflict('Teacher is inactive');
  const room = body.room ?? section.room;
  await checkConflicts(section.tenantId, { yearId: section.yearId, sectionId: section._id, day: body.day, periodId: period._id, assignment, room, ignoreId });
  return { section, assignment, room };
}

export async function upsertEntry(tenantId, body) {
  const existing = await TimetableEntry.findOne({ tenantId, sectionId: body.sectionId, day: body.day, periodId: body.periodId });
  const { section, assignment, room } = await validateEntry(tenantId, body, existing?._id);
  const entry = existing || new TimetableEntry({ tenantId, yearId: section.yearId, sectionId: section._id, day: body.day, periodId: body.periodId });
  entry.assignmentId = assignment._id; entry.room = room; entry.unresolved = false;
  await entry.save();
  const weekly = await TimetableEntry.countDocuments({ tenantId, sectionId: section._id, assignmentId: assignment._id });
  const offering = await TeachingAssignment.findById(assignment._id).populate('offeringId');
  const target = offering?.offeringId?.weeklyPeriods;
  return { entry, section, warnings: target && weekly > target ? [`${weekly} periods scheduled per week; the subject offering allows ${target}`] : [] };
}

export async function updateEntry(tenantId, id, body) {
  const entry = await TimetableEntry.findOne({ _id: id, tenantId });
  if (!entry) throw notFound('Timetable entry not found');
  return upsertEntry(tenantId, { sectionId: entry.sectionId, day: entry.day, periodId: entry.periodId, assignmentId: body.assignmentId || entry.assignmentId, room: body.room ?? entry.room });
}
export async function deleteEntry(tenantId, id) {
  const entry = await TimetableEntry.findOne({ _id: id, tenantId });
  if (!entry) throw notFound('Timetable entry not found');
  await Substitution.deleteMany({ tenantId, entryId: entry._id });
  await entry.deleteOne();
  return entry;
}

export async function listEntries(tenantId, { sectionId, teacherId, yearId }) {
  const year = yearId ? { _id: yearId } : await getCurrentYear(tenantId);
  const f = { tenantId, yearId: year?._id };
  if (sectionId) f.sectionId = sectionId;
  if (teacherId) {
    const asg = await TeachingAssignment.find({ tenantId, teacherId }).select('_id');
    f.assignmentId = { $in: asg.map((a) => a._id) };
  }
  const entries = await TimetableEntry.find(f).lean();
  const asg = await TeachingAssignment.find({ tenantId, _id: { $in: entries.map((e) => e.assignmentId) } }).populate('teacherId', 'name').populate('subjectId', 'name code').lean();
  const am = new Map(asg.map((a) => [String(a._id), a]));
  return entries.map((e) => {
    const a = am.get(String(e.assignmentId));
    return { ...e, subject: a?.subjectId?.name, subjectCode: a?.subjectId?.code, teacher: a?.teacherId?.name, teacherId: a?.teacherId?._id };
  });
}

export async function unresolvedEntries(tenantId) {
  const entries = await TimetableEntry.find({ tenantId, unresolved: true }).lean();
  const [sections, periods] = await Promise.all([Section.find({ tenantId, _id: { $in: entries.map((e) => e.sectionId) } }).populate('classId', 'name').lean(), TimetablePeriod.find({ tenantId }).lean()]);
  const sm = new Map(sections.map((s) => [String(s._id), s])); const pm = new Map(periods.map((p) => [String(p._id), p]));
  const asg = await TeachingAssignment.find({ tenantId, _id: { $in: entries.map((e) => e.assignmentId) } }).populate('subjectId', 'name').lean();
  const am = new Map(asg.map((a) => [String(a._id), a]));
  return entries.map((e) => ({
    ...e, section: `${sm.get(String(e.sectionId))?.classId?.name || ''} ${sm.get(String(e.sectionId))?.name || ''}`.trim(),
    period: pm.get(String(e.periodId))?.name, subject: am.get(String(e.assignmentId))?.subjectId?.name,
  }));
}

export async function sectionTimetable(tenantId, sectionId, date) {
  const section = await Section.findOne({ _id: sectionId, tenantId });
  if (!section) throw notFound('Section not found');
  const { today, settings } = await schoolToday(tenantId);
  return sectionWeek({ tenantId, yearId: section.yearId, sectionId, date: date || today, today, tz: settings.timezone, days: settings.workingDays });
}
export { sectionDay };

// ── substitutions ──
export async function createSubstitution(tenantId, body, userId) {
  const entry = await TimetableEntry.findOne({ _id: body.entryId, tenantId });
  if (!entry) throw notFound('Timetable entry not found');
  if (isoDay(body.date) !== entry.day) throw bad('That date does not fall on the weekday of this period');
  const asg = await TeachingAssignment.findOne({ _id: entry.assignmentId, tenantId });
  const sub = await Teacher.findOne({ _id: body.substituteTeacherId, tenantId, status: 'active' });
  if (!sub) throw notFound('Substitute teacher not found');
  if (asg && String(asg.teacherId) === String(sub._id)) throw bad('The substitute is the original teacher');
  // substitute must be free: no own lesson and no other cover in that period
  const mine = await TeachingAssignment.find({ tenantId, teacherId: sub._id }).select('_id');
  const busy = await TimetableEntry.findOne({ tenantId, day: entry.day, periodId: entry.periodId, assignmentId: { $in: mine.map((a) => a._id) } });
  if (busy) {
    const covered = await Substitution.exists({ tenantId, entryId: busy._id, date: body.date });
    if (!covered) throw conflict('Substitute teacher has their own lesson in that period', { type: 'teacher' });
  }
  const otherCovers = await Substitution.find({ tenantId, date: body.date, substituteTeacherId: sub._id }).lean();
  if (otherCovers.length) {
    const es = await TimetableEntry.find({ tenantId, _id: { $in: otherCovers.map((c) => c.entryId) }, periodId: entry.periodId });
    if (es.length) throw conflict('Substitute teacher is already covering another class in that period', { type: 'teacher' });
  }
  const doc = await Substitution.findOneAndUpdate(
    { tenantId, entryId: entry._id, date: body.date },
    { $set: { originalTeacherId: asg?.teacherId, substituteTeacherId: sub._id, reason: body.reason, leaveId: body.leaveId, createdBy: userId } },
    { upsert: true, new: true },
  );
  return { substitution: doc, entry };
}
export async function listSubstitutions(tenantId, { from, to }) {
  const f = { tenantId };
  if (from || to) f.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  return Substitution.find(f).populate('substituteTeacherId', 'name').populate('originalTeacherId', 'name').sort({ date: -1 }).lean();
}
export async function deleteSubstitution(tenantId, id) {
  const s = await Substitution.findOne({ _id: id, tenantId });
  if (!s) throw notFound('Substitution not found');
  await s.deleteOne();
  return s;
}

/** For a leave application: every period the teacher would miss, with any substitute already arranged. */
export async function affectedPeriods(tenantId, leaveId) {
  const leave = await LeaveApplication.findOne({ _id: leaveId, tenantId });
  if (!leave) throw notFound('Leave application not found');
  const asg = await TeachingAssignment.find({ tenantId, teacherId: leave.teacherId });
  const entries = await TimetableEntry.find({ tenantId, assignmentId: { $in: asg.map((a) => a._id) } }).populate('periodId').populate('sectionId').lean();
  const subs = await Substitution.find({ tenantId, entryId: { $in: entries.map((e) => e._id) }, date: { $gte: leave.startDate, $lte: leave.endDate } }).populate('substituteTeacherId', 'name').lean();
  const subjects = await Subject.find({ tenantId, _id: { $in: asg.map((a) => a.subjectId) } }).lean();
  const sm = new Map(subjects.map((s) => [String(s._id), s.name]));
  const am = new Map(asg.map((a) => [String(a._id), a]));
  const out = [];
  for (const date of eachDate(leave.startDate, leave.endDate)) {
    for (const e of entries.filter((x) => x.day === isoDay(date))) {
      const sub = subs.find((s) => String(s.entryId) === String(e._id) && s.date === date);
      out.push({
        date, entryId: e._id, period: e.periodId?.name, startTime: e.periodId?.startTime, endTime: e.periodId?.endTime, order: e.periodId?.order,
        section: e.sectionId?.name, sectionId: e.sectionId?._id, subject: sm.get(String(am.get(String(e.assignmentId))?.subjectId)),
        substitute: sub?.substituteTeacherId?.name || null, substitutionId: sub?._id,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
}
