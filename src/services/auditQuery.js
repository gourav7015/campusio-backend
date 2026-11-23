import { AuditLog } from '../models/index.js';
import { escapeRegex } from '../core/utils.js';

const DAY = 24 * 3600 * 1000;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** The instant a calendar date begins in a time zone (the audit log is read by date in the school's own clock). */
export function dayStart(dateStr, tz = 'Asia/Kolkata') {
  const guess = new Date(`${dateStr}T00:00:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(guess).map((x) => [x.type, x.value]));
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(guess.getTime() - (shown - guess.getTime()));
}

/**
 * The filter for an audit listing. from / to: calendar days (both included) in the school's time zone; role, actorId: who; area: the part of the action before
 * the first dot (attendance, fees, auth...); action: the start of the action; q: words in the details, the action or the person's name; platform: only actions
 * a platform administrator took inside the school.
 */
export function auditFilter(base, q = {}, tz) {
  const f = { ...base };
  if (isDate(q.from) || isDate(q.to)) {
    f.createdAt = {};
    if (isDate(q.from)) f.createdAt.$gte = dayStart(q.from, tz);
    if (isDate(q.to)) f.createdAt.$lt = new Date(dayStart(q.to, tz).getTime() + DAY);
  }
  if (q.role) f.actorRole = String(q.role);
  if (q.actorId && /^[a-f0-9]{24}$/i.test(String(q.actorId))) f.actorId = q.actorId;
  if (q.platform === '1' || q.platform === 'true') f.actingAsSuperAdmin = true;
  const and = [];
  if (q.area) and.push({ action: new RegExp(`^${escapeRegex(String(q.area))}\\.`) });
  if (q.action) and.push({ action: new RegExp(`^${escapeRegex(String(q.action))}`) });
  if (q.q && String(q.q).trim().length >= 2) { const rx = new RegExp(escapeRegex(String(q.q).trim()), 'i'); and.push({ $or: [{ summary: rx }, { action: rx }, { actorName: rx }] }); }
  if (and.length) f.$and = and;
  return f;
}

export const listAuditEntries = (base, q, tz) => AuditLog.find(auditFilter(base, q, tz)).sort({ createdAt: -1 }).limit(Math.min(Number(q.limit) || 100, 500)).lean();

/** What happened in a period: how many entries, which areas and who did them, so the filters only offer what exists. */
export async function auditFacets(base, q, tz) {
  const match = auditFilter(base, { from: q.from, to: q.to }, tz);
  const [areas, people, total] = await Promise.all([
    AuditLog.aggregate([{ $match: match }, { $group: { _id: { $arrayElemAt: [{ $split: ['$action', '.'] }, 0] }, count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    AuditLog.aggregate([{ $match: match }, { $group: { _id: '$actorId', name: { $first: '$actorName' }, role: { $first: '$actorRole' }, count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 200 }]),
    AuditLog.countDocuments(match),
  ]);
  return { total, areas: areas.map((a) => ({ area: a._id, count: a.count })), people: people.filter((p) => p._id).map((p) => ({ id: p._id, name: p.name, role: p.role, count: p.count })) };
}
