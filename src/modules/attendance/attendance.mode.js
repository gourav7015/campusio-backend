import { School, AttendanceSession, PeriodAttendanceSession, Section, Teacher, Student } from '../../models/index.js';
import { addDays, bad, conflict } from '../../core/utils.js';
import { modeOn, modeSummary } from '../../services/attendanceMode.js';
import { notifyUsers } from '../../services/notify.js';
import { forgetMemo } from '../../core/memo.js';

/**
 * Changing how the school takes student attendance (once a day <-> period by period).
 * It changes from a DATE, never in the middle of a day, and nothing recorded before that date is touched.
 * The earliest date is today if no register of the old way has been started today, otherwise tomorrow.
 */
async function earliestAndOpen(ctx) {
  const periodWiseToday = modeOn(ctx.settings.attendance, ctx.today);
  const sections = await Section.find({ tenantId: ctx.tenantId, yearId: ctx.year?._id, status: 'active' }).populate('classId', 'name').lean();
  const name = new Map(sections.map((s) => [String(s._id), `${s.classId?.name || ''} ${s.name}`.trim()]));
  const ids = sections.map((s) => s._id);
  const open = [];
  let started = false;
  if (!periodWiseToday) {
    const sessions = await AttendanceSession.find({ tenantId: ctx.tenantId, date: ctx.today, sectionId: { $in: ids }, source: { $ne: 'periods' } }).select('sectionId status').lean();
    started = sessions.length > 0;
    for (const s of sections) { const x = sessions.find((q) => String(q.sectionId) === String(s._id)); if (!x || x.status !== 'submitted') open.push({ sectionId: s._id, name: name.get(String(s._id)), state: x ? 'draft' : 'not_started' }); }
  } else {
    const sessions = await PeriodAttendanceSession.find({ tenantId: ctx.tenantId, date: ctx.today, sectionId: { $in: ids } }).select('sectionId').lean();
    started = sessions.length > 0;
    const sectionsWith = new Set(sessions.map((x) => String(x.sectionId)));
    for (const s of sections) if (sectionsWith.has(String(s._id))) open.push({ sectionId: s._id, name: name.get(String(s._id)), state: 'periods_started' });
  }
  return { earliest: started ? addDays(ctx.today, 1) : ctx.today, started, open };
}

export async function modeInfo(ctx) {
  const att = ctx.settings.attendance;
  const info = modeSummary(att, ctx.today);
  const { earliest, started, open } = await earliestAndOpen(ctx);
  return { ...info, today: ctx.today, earliest, started, openToday: open.slice(0, 12), openCount: open.length, dayRule: att.dayRule, lateCountsAsPresent: att.lateCountsAsPresent !== false };
}

export async function setMode(ctx, user, { periodWise, from }) {
  const { earliest } = await earliestAndOpen(ctx);
  if (from < earliest) throw bad(earliest === ctx.today ? 'Choose today or a later date' : 'A register has already been started today. Choose tomorrow or a later date.');
  if (from > addDays(ctx.today, 366)) throw bad('Choose a date within the next year');
  const school = await School.findById(ctx.tenantId);
  const att = { ...(school.settings?.attendance || {}) };
  const all = att.modeSchedule || [];
  const keep = all.filter((e) => e.from <= ctx.today && e.from !== from).sort((a, b) => a.from.localeCompare(b.from));
  const hadPending = all.some((e) => e.from > ctx.today);
  // a legacy school (only the old tick box) has no schedule: write down what it takes today before adding the change
  if (!keep.length && att.periodWise) keep.push({ from: '2000-01-01', periodWise: true, at: new Date(), byName: 'Earlier setting' });
  const before = keep.length ? !!keep[keep.length - 1].periodWise : false;
  const save = async () => { att.modeSchedule = keep; att.periodWise = modeOn({ modeSchedule: keep }, ctx.today); school.settings = { ...school.settings, attendance: att }; school.markModified('settings'); await school.save(); forgetMemo(); };
  if (!!periodWise === before) {
    // asking for what is already in force: it only means something if it withdraws a change that was booked for later
    if (!hadPending) throw conflict('Attendance is already taken that way');
    await save();
    return { ok: true, cancelled: true };
  }
  keep.push({ from, periodWise: !!periodWise, at: new Date(), byName: user.name });
  await save();
  await announce(ctx, periodWise, from);
  return { ok: true, from, periodWise: !!periodWise };
}

/** Teachers and students (parents use the student's login) are told when the change is booked. */
async function announce(ctx, periodWise, from) {
  const [teachers, students] = await Promise.all([Teacher.find({ tenantId: ctx.tenantId, status: 'active' }).select('userId').lean(), Student.find({ tenantId: ctx.tenantId, status: 'active' }).select('userId').lean()]);
  const when = from === ctx.today ? 'from today' : `from ${from}`;
  const way = periodWise ? 'period by period: each teacher marks their own period' : 'once a day: the class teacher takes one register';
  const key = `attmode:${from}:${periodWise ? 'p' : 'd'}`;
  await notifyUsers(ctx.tenantId, [...teachers.map((t) => t.userId), ...students.map((s) => s.userId)], { category: 'attendance', title: 'How attendance is taken is changing', body: `${when}, attendance is taken ${way}.`, link: { type: 'attendance', id: from }, dedupeKey: key });
}
