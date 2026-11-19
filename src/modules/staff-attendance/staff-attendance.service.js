import { Teacher, StaffMember, Designation, LeaveApplication, StaffLeave, CalendarEvent, StaffAttendanceSession, StaffAttendanceRecord } from '../../models/index.js';
import { notFound, conflict, bad, eachDate, isoDay, round1 } from '../../core/utils.js';
import { punchesFor, evaluate, setTimes, importPunches } from '../staff-punch/staff-punch.service.js';
import { ensureDeskStaff } from '../support-staff/support-staff.service.js';

/**
 * Daily attendance of everyone who works at the school but is not a student.
 * One register per group per day: teachers and general staff are marked by the School Admin, transport staff by the Transport officer.
 * Everyone starts as present; only exceptions need to be marked. Only SUBMITTED registers count — an unmarked day is never an absence.
 */
export const monthBounds = (month) => { const [y, m] = month.split('-').map(Number); return { start: `${month}-01`, end: `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}` }; };

/** Active people in a group, as register rows. */
export async function peopleOf(ctx, group) {
  if (group === 'teachers') {
    return (await Teacher.find({ tenantId: ctx.tenantId, status: 'active' }).sort({ name: 1 }).select('name employeeId designation joiningDate').lean())
      .map((t) => ({ personType: 'teacher', personId: t._id, name: t.name, code: t.employeeId, designation: t.designation || 'Teacher', joiningDate: t.joiningDate }));
  }
  if (group === 'office') await ensureDeskStaff(ctx.tenantId); // every finance, library and transport officer is an employee, so each has a row
  const designations = await Designation.find({ tenantId: ctx.tenantId, group: group === 'transport' ? 'transport' : 'general' }).lean();
  const D = new Map(designations.map((d) => [String(d._id), d]));
  // 'office' is the officers (a desk role is set); 'general' is every other non-teaching employee
  const desk = group === 'office' ? { deskRole: { $exists: true, $ne: null } } : group === 'general' ? { deskRole: null } : {};
  return (await StaffMember.find({ tenantId: ctx.tenantId, status: 'active', ...desk, designationId: { $in: designations.map((d) => d._id) } }).sort({ name: 1 }).select('name staffId designationId joiningDate').lean())
    .map((s) => ({ personType: 'staff', personId: s._id, name: s.name, code: s.staffId, designation: D.get(String(s.designationId))?.name, joiningDate: s.joiningDate }));
}

async function holidayOn(ctx, date) {
  return CalendarEvent.findOne({ tenantId: ctx.tenantId, type: 'holiday', startDate: { $lte: date }, endDate: { $gte: date }, sectionIds: { $size: 0 } }).lean();
}

/** Why a register cannot be taken on this date, or null. */
async function blockedReason(ctx, date) {
  if (date > ctx.today) return 'future';
  if (!ctx.settings.workingDays.includes(isoDay(date))) return 'not_working_day';
  const h = await holidayOn(ctx, date);
  return h ? `holiday:${h.title}` : null;
}

/** Everyone on approved leave that day: teachers (their applications) and staff (theirs, or recorded by a desk). */
async function approvedLeaveOn(ctx, date) {
  const f = { tenantId: ctx.tenantId, status: 'approved', startDate: { $lte: date }, endDate: { $gte: date } };
  const [teachers, staff] = await Promise.all([LeaveApplication.find(f).select('teacherId leaveType halfDay halfSession').lean(), StaffLeave.find(f).select('staffId leaveType halfDay halfSession').lean()]);
  // a half day of leave: the person is away for halfSession, so the half they attend is the other one
  const info = (l) => ({ type: l.leaveType, half: l.halfDay ? (l.halfSession === 'first' ? 'second' : 'first') : null });
  return new Map([...teachers.map((l) => [String(l.teacherId), info(l)]), ...staff.map((l) => [String(l.staffId), info(l)])]);
}

export async function getRegister(ctx, group, date) {
  const d = date || ctx.today;
  const [people, session, blocked, leaves, punches] = await Promise.all([
    peopleOf(ctx, group), StaffAttendanceSession.findOne({ tenantId: ctx.tenantId, group, date: d }).lean(), blockedReason(ctx, d), approvedLeaveOn(ctx, d), punchesFor(ctx, group, d),
  ]);
  const recs = session ? await StaffAttendanceRecord.find({ tenantId: ctx.tenantId, sessionId: session._id }).lean() : [];
  const R = new Map(recs.map((r) => [String(r.personId), r]));
  const rows = people.filter((p) => !p.joiningDate || p.joiningDate <= d).map((p) => {
    const r = R.get(String(p.personId)); const leave = leaves.get(String(p.personId)); const punch = punches.get(String(p.personId));
    const ev = evaluate(ctx.settings, punch);
    const fromTimes = ev && ev.suggested !== 'present' ? ev.suggested : null; // late or short hours, as the clock says
    const status = r?.status || (leave ? (leave.half ? 'half_day' : 'leave') : fromTimes || 'present');
    return {
      ...p, status, halfSession: status === 'half_day' ? r?.halfSession || (!r && leave?.half) || 'first' : null,
      remark: r?.remark || (leave && !r ? `Approved ${leave.type} ${leave.half ? 'half-day ' : ''}leave` : ev?.late && !r ? `Arrived ${punch.checkIn}, ${ev.minutesLate} min late` : ''),
      source: r ? 'register' : leave ? 'leave' : fromTimes ? 'times' : 'default', corrected: !!r?.history?.length,
      checkIn: r?.checkIn ?? punch?.checkIn ?? null, checkOut: r?.checkOut ?? punch?.checkOut ?? null, hours: ev?.hours ?? null, punchSource: punch?.source || null,
    };
  });
  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    policy: { shiftStart: ctx.settings.staffAttendance.shiftStart, shiftEnd: ctx.settings.staffAttendance.shiftEnd, graceMinutes: ctx.settings.staffAttendance.graceMinutes },
    group, date: d, session: session ? { status: session.status, submittedAt: session.submittedAt } : null, blocked,
    canEdit: !blocked && session?.status !== 'submitted', canCorrect: !blocked && session?.status === 'submitted',
    rows, totals: { people: rows.length, present: count('present'), late: count('late'), halfDay: count('half_day'), absent: count('absent'), leave: count('leave') },
  };
}

/** Save the register as a draft, or submit it (which locks it and records everyone not mentioned as present). */
export async function saveRegister(ctx, { group, date, entries, submit }) {
  const blocked = await blockedReason(ctx, date);
  if (blocked) throw bad(blocked === 'future' ? 'Attendance cannot be taken for a future date' : blocked === 'not_working_day' ? 'That is not a working day for the school' : `That date is a holiday (${blocked.split(':')[1]})`);
  let session = await StaffAttendanceSession.findOne({ tenantId: ctx.tenantId, group, date });
  if (session?.status === 'submitted') throw conflict('This register has been submitted. Use a correction, with a reason, to change it.');
  const people = (await peopleOf(ctx, group)).filter((p) => !p.joiningDate || p.joiningDate <= date);
  const P = new Map(people.map((p) => [String(p.personId), p]));
  for (const e of entries) if (!P.has(e.personId)) throw notFound('Someone in the list does not belong to this group');
  if (!session) session = await StaffAttendanceSession.create({ tenantId: ctx.tenantId, group, date, markedBy: ctx.actorId });
  const given = new Map(entries.map((e) => [e.personId, e]));
  for (const e of entries) if (e.checkIn !== undefined || e.checkOut !== undefined) await setTimes(ctx, { personType: P.get(e.personId).personType, personId: e.personId, group, date, checkIn: e.checkIn || undefined, checkOut: e.checkOut || undefined });
  let final = entries;
  if (submit) {
    const leaves = await approvedLeaveOn(ctx, date);
    const draft = new Map((await StaffAttendanceRecord.find({ tenantId: ctx.tenantId, sessionId: session._id }).lean()).map((r) => [String(r.personId), { personId: String(r.personId), status: r.status, halfSession: r.halfSession, remark: r.remark }]));
    // what was just sent wins, then what was saved earlier as a draft, then the default (present, or on leave if an approved leave covers the day)
    final = people.map((p) => given.get(String(p.personId)) || draft.get(String(p.personId)) || (() => { const lv = leaves.get(String(p.personId)); return { personId: String(p.personId), status: lv ? (lv.half ? 'half_day' : 'leave') : 'present', ...(lv?.half ? { halfSession: lv.half } : {}), remark: lv ? `Approved ${lv.type} ${lv.half ? 'half-day ' : ''}leave` : undefined }; })());
  }
  const punches = await punchesFor(ctx, group, date);
  if (final.length) await StaffAttendanceRecord.bulkWrite(final.map((e) => { const pu = punches.get(String(e.personId)); return { updateOne: { filter: { tenantId: ctx.tenantId, sessionId: session._id, personId: e.personId }, update: { $set: { group, date, personType: P.get(e.personId).personType, status: e.status, halfSession: e.status === 'half_day' ? e.halfSession || 'first' : null, remark: e.remark, ...(pu?.checkIn ? { checkIn: pu.checkIn } : {}), ...(pu?.checkOut ? { checkOut: pu.checkOut } : {}) } }, upsert: true } }; }));
  if (submit) { session.status = 'submitted'; session.submittedBy = ctx.actorId; session.submittedAt = new Date(); await session.save(); }
  return getRegister(ctx, group, date);
}

export async function correct(ctx, { group, date, personId, status, halfSession, reason }) {
  const session = await StaffAttendanceSession.findOne({ tenantId: ctx.tenantId, group, date });
  if (!session || session.status !== 'submitted') throw conflict('Only a submitted register needs a correction. Edit the draft instead.');
  const rec = await StaffAttendanceRecord.findOne({ tenantId: ctx.tenantId, sessionId: session._id, personId });
  if (!rec) throw notFound('That person is not in this register');
  const part = status === 'half_day' ? halfSession || 'first' : null;
  if (rec.status === status && (rec.halfSession || null) === part) return getRegister(ctx, group, date);
  rec.history.push({ from: rec.status, to: status, reason, by: ctx.actorId });
  rec.status = status; rec.halfSession = part || undefined;
  await rec.save();
  return getRegister(ctx, group, date);
}

/** Per-person totals for a month, from submitted registers: the month view of the register page. */
export async function monthSummary(ctx, group, month) {
  const m = month || ctx.today.slice(0, 7);
  const { start, end } = monthBounds(m);
  const [people, sessions] = await Promise.all([peopleOf(ctx, group), StaffAttendanceSession.find({ tenantId: ctx.tenantId, group, status: 'submitted', date: { $gte: start, $lte: end } }).select('_id').lean()]);
  const rows = sessions.length ? await StaffAttendanceRecord.aggregate([{ $match: { tenantId: ctx.tenantId, sessionId: { $in: sessions.map((s) => s._id) } } }, { $group: { _id: { p: '$personId', s: '$status' }, n: { $sum: 1 } } }]) : [];
  const by = new Map();
  for (const r of rows) { const k = String(r._id.p); if (!by.has(k)) by.set(k, { present: 0, absent: 0, late: 0, half_day: 0, leave: 0 }); by.get(k)[r._id.s] = r.n; }
  return { group, month: m, registers: sessions.length, people: people.map((p) => ({ ...p, ...(by.get(String(p.personId)) || { present: 0, absent: 0, late: 0, half_day: 0, leave: 0 }) })).map((p) => ({ ...p, percentage: summarizeCounts(p).percentage })) };
}

export function summarizeCounts(c) {
  const counted = c.present + c.late + c.absent + c.half_day + c.leave; // a day on leave is not a day at work
  const attended = c.present + c.late + 0.5 * c.half_day;
  return { ...c, counted, percentage: counted ? round1((attended / counted) * 100) : null };
}

/**
 * One person's attendance across the academic year: a heat-map day list and totals.
 * Where the group has submitted registers, those are the truth. Where it has none (a school that has not started using them),
 * teachers' days fall back to what approved leave implies, and the result says so.
 */
export async function personAttendance(ctx, personType, personId, { joiningDate, group }) {
  const year = ctx.year;
  const to = ctx.today < year.endDate ? ctx.today : year.endDate;
  if (to < year.startDate) return { days: [], summary: summarizeCounts({ present: 0, absent: 0, late: 0, half_day: 0, leave: 0 }), source: 'none', registers: 0 };
  const [sessions, holidays] = await Promise.all([
    StaffAttendanceSession.find({ tenantId: ctx.tenantId, group, status: 'submitted', date: { $gte: year.startDate, $lte: to } }).select('_id date').lean(),
    CalendarEvent.find({ tenantId: ctx.tenantId, type: 'holiday', sectionIds: { $size: 0 }, startDate: { $lte: to }, endDate: { $gte: year.startDate } }).lean(),
  ]);
  const recs = sessions.length ? await StaffAttendanceRecord.find({ tenantId: ctx.tenantId, personId, sessionId: { $in: sessions.map((s) => s._id) } }).select('date status remark').lean() : [];
  const R = new Map(recs.map((r) => [r.date, r]));
  const submittedDates = new Set(sessions.map((s) => s.date));
  const holidaySet = new Set(holidays.flatMap((h) => eachDate(h.startDate < year.startDate ? year.startDate : h.startDate, h.endDate > to ? to : h.endDate)));
  const leaveOn = new Map();
  const leaveRows = personType === 'teacher'
    ? await LeaveApplication.find({ tenantId: ctx.tenantId, teacherId: personId, status: 'approved', endDate: { $gte: year.startDate }, startDate: { $lte: to } }).lean()
    : await StaffLeave.find({ tenantId: ctx.tenantId, staffId: personId, status: 'approved', endDate: { $gte: year.startDate }, startDate: { $lte: to } }).lean();
  for (const l of leaveRows) for (const d of eachDate(l.startDate, l.endDate)) leaveOn.set(d, { type: l.leaveType, half: !!l.halfDay });
  const useRegisters = sessions.length > 0;
  const days = eachDate(year.startDate, to).map((date) => {
    const working = ctx.settings.workingDays.includes(isoDay(date)) && !holidaySet.has(date);
    const employed = !joiningDate || date >= joiningDate;
    const base = { date, working: working && employed, holiday: holidaySet.has(date) ? 'Holiday' : undefined };
    if (!working || !employed) return { ...base, status: null };
    if (useRegisters) { const r = R.get(date); return { ...base, status: r ? (r.status === 'half_day' ? 'late' : r.status) : null, rawStatus: r?.status, remark: r?.remark }; }
    const lv = leaveOn.get(date); const lt = lv?.type;
    if (lv?.half) return { ...base, status: 'late', rawStatus: 'half_day', leaveType: lt, derived: true }; // half the day away: shown as a half day
    return { ...base, status: lt ? (lt === 'unpaid' ? 'absent' : 'leave') : 'present', leaveType: lt, derived: true };
  });
  const counts = { present: 0, absent: 0, late: 0, half_day: 0, leave: 0 };
  for (const d of days) { if (!d.working || !d.status) continue; const k = d.rawStatus || (d.status === 'late' ? 'late' : d.status); if (counts[k] !== undefined) counts[k] += 1; }
  const working = days.filter((d) => d.working).length;
  return { days, summary: { ...summarizeCounts(counts), workingDays: working, markedDays: useRegisters ? submittedDates.size : working }, source: useRegisters ? 'registers' : 'leave', registers: sessions.length };
}

/** Import the export of a biometric machine for one group (the desk that owns the group does this). */
export async function importTimes(ctx, group, rows) {
  const people = await peopleOf(ctx, group);
  return importPunches(ctx, group, people, rows);
}
