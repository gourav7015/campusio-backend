import { CalendarEvent, Examination, ExaminationSubject, Subject, Homework } from '../../models/index.js';
import { notFound, addDays } from '../../core/utils.js';
import { effectiveStatus } from '../homework/homework.service.js';

export const listEvents = (ctx, { from, to }) => {
  const f = { tenantId: ctx.tenantId };
  if (from) f.endDate = { $gte: from };
  if (to) f.startDate = { $lte: to };
  return CalendarEvent.find(f).sort({ startDate: 1 }).lean();
};
export const createEvent = (ctx, body) => CalendarEvent.create({ ...body, endDate: body.endDate || body.startDate, tenantId: ctx.tenantId, createdBy: ctx.actorId });
export async function updateEvent(ctx, id, body) {
  const e = await CalendarEvent.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!e) throw notFound('Event not found');
  Object.assign(e, body);
  return e.save();
}
export async function deleteEvent(ctx, id) {
  const e = await CalendarEvent.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!e) throw notFound('Event not found');
  await e.deleteOne();
}

/** The school's own calendar for people who have no class of their own (finance, library, transport, staff): holidays and events for everyone, not exams or homework. */
export async function schoolFeed(ctx, { from, to }) {
  const start = from || addDays(ctx.today, -30);
  const end = to || addDays(ctx.today, 90);
  const events = await CalendarEvent.find({ tenantId: ctx.tenantId, startDate: { $lte: end }, endDate: { $gte: start }, $or: [{ sectionIds: { $exists: false } }, { sectionIds: { $size: 0 } }] }).lean();
  return events.map((e) => ({ id: String(e._id), title: e.title, type: e.type, kind: e.kind || 'school', date: e.startDate, endDate: e.endDate, description: e.description, source: 'event' })).sort((a, b) => a.date.localeCompare(b.date));
}

/** One merged feed for a viewer: school events + exam dates + homework deadlines, limited to what they may see. */
export async function feed(ctx, { from, to }, { sectionIds, classIds, teacherId }) {
  const start = from || addDays(ctx.today, -30);
  const end = to || addDays(ctx.today, 90);
  const items = [];
  const events = await CalendarEvent.find({ tenantId: ctx.tenantId, startDate: { $lte: end }, endDate: { $gte: start } }).lean();
  for (const e of events) {
    const secs = (e.sectionIds || []).map(String);
    if (secs.length && !secs.some((s) => sectionIds.includes(s))) continue;
    items.push({ id: String(e._id), title: e.title, type: e.type, kind: e.kind || 'school', date: e.startDate, endDate: e.endDate, description: e.description, source: 'event' });
  }
  const exams = (await Examination.find({ tenantId: ctx.tenantId, yearId: ctx.year._id, schedulePublished: true }).select('_id name sectionId').lean())
    .filter((e) => !e.sectionId || sectionIds.includes(String(e.sectionId)));
  const es = await ExaminationSubject.find({ tenantId: ctx.tenantId, examId: { $in: exams.map((e) => e._id) }, classId: { $in: classIds }, date: { $gte: start, $lte: end } }).lean();
  const subj = new Map((await Subject.find({ tenantId: ctx.tenantId, _id: { $in: es.map((x) => x.subjectId) } }).select('name').lean()).map((s) => [String(s._id), s.name]));
  const en = new Map(exams.map((e) => [String(e._id), e.name]));
  for (const x of es) items.push({ id: String(x._id), title: `${en.get(String(x.examId))} · ${subj.get(String(x.subjectId))}`, type: 'exam', date: x.date, endDate: x.date, description: [x.startTime, x.room && `Room ${x.room}`].filter(Boolean).join(' · '), source: 'exam' });
  const hwFilter = { tenantId: ctx.tenantId, yearId: ctx.year._id, sectionId: { $in: sectionIds }, status: { $in: ['published', 'scheduled'] }, dueDate: { $gte: start, $lte: end } };
  if (teacherId) hwFilter.teacherId = teacherId;
  const hw = (await Homework.find(hwFilter).lean()).filter((h) => effectiveStatus(h) === 'published');
  const hs = new Map((await Subject.find({ tenantId: ctx.tenantId, _id: { $in: hw.map((h) => h.subjectId) } }).select('name').lean()).map((s) => [String(s._id), s.name]));
  for (const h of hw) items.push({ id: String(h._id), title: `${hs.get(String(h.subjectId)) || ''}: ${h.title}`, type: 'deadline', date: h.dueDate, endDate: h.dueDate, source: 'homework', link: { type: 'homework', id: String(h._id) } });
  return items.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * National holidays that fall on the same date every year. Festivals that move with the moon or the state (Diwali, Eid, Holi…) are NOT guessed:
 * the school adds those itself, so a wrong date can never reach a family.
 */
export const FIXED_GOVERNMENT_HOLIDAYS = [
  { md: '01-26', title: 'Republic Day' }, { md: '04-14', title: 'Dr. B. R. Ambedkar Jayanti' }, { md: '08-15', title: 'Independence Day' },
  { md: '10-02', title: 'Gandhi Jayanti' }, { md: '12-25', title: 'Christmas' },
];
export async function addGovernmentHolidays(ctx) {
  const y = ctx.year;
  if (!y) throw notFound('Create an academic year first');
  const years = [...new Set([Number(y.startDate.slice(0, 4)), Number(y.endDate.slice(0, 4))])];
  let added = 0; let skipped = 0;
  for (const yr of years) for (const h of FIXED_GOVERNMENT_HOLIDAYS) {
    const date = `${yr}-${h.md}`;
    if (date < y.startDate || date > y.endDate) continue;
    const have = await CalendarEvent.exists({ tenantId: ctx.tenantId, type: 'holiday', title: h.title, startDate: date });
    if (have) { skipped += 1; continue; }
    await CalendarEvent.create({ tenantId: ctx.tenantId, title: h.title, type: 'holiday', kind: 'government', description: 'Government holiday', startDate: date, endDate: date, sectionIds: [], createdBy: ctx.actorId });
    added += 1;
  }
  return { added, skipped };
}
