import { AttendanceRecord, AttendanceSession } from '../models/index.js';
import { pct } from '../core/utils.js';

export const zeroCounts = () => ({ present: 0, absent: 0, late: 0, leave: 0, excused: 0 });

/** Percentage from already-counted statuses. Leave and excused days never count against the student. */
export function summarizeCounts(c, settings) {
  const counted = c.present + c.absent + c.late;
  const attended = c.present + (settings?.attendance?.lateCountsAsPresent === false ? 0 : c.late);
  return { ...c, workingDays: c.present + c.absent + c.late + c.leave + c.excused, percentage: pct(attended, counted) };
}

export function summarize(records, settings) {
  const c = zeroCounts();
  for (const r of records) if (c[r.status] !== undefined) c[r.status]++;
  return { ...summarizeCounts(c, settings), workingDays: records.length };
}

/**
 * Totals per submitted register, counted by the database (not downloaded record by record).
 * Returns [{ sectionId, date, counts }]. Use this for school-wide and class-wide numbers.
 */
export async function sessionCounts(tenantId, sessionFilter) {
  const sessions = await AttendanceSession.find({ tenantId, status: 'submitted', ...sessionFilter }).select('sectionId date').lean();
  if (!sessions.length) return [];
  const rows = await AttendanceRecord.aggregate([{ $match: { sessionId: { $in: sessions.map((s) => s._id) } } }, { $group: { _id: { s: '$sessionId', st: '$status' }, n: { $sum: 1 } } }]);
  const by = new Map(sessions.map((s) => [String(s._id), { sectionId: String(s.sectionId), date: s.date, counts: zeroCounts() }]));
  for (const r of rows) { const e = by.get(String(r._id.s)); if (e && e.counts[r._id.st] !== undefined) e.counts[r._id.st] += r.n; }
  return [...by.values()];
}

/** Per-student totals over the submitted registers matching the filter. Returns Map(studentId -> counts). */
export async function studentCounts(tenantId, sessionFilter) {
  const sessions = await AttendanceSession.find({ tenantId, status: 'submitted', ...sessionFilter }).select('_id').lean();
  const out = new Map();
  if (!sessions.length) return out;
  const rows = await AttendanceRecord.aggregate([{ $match: { sessionId: { $in: sessions.map((s) => s._id) } } }, { $group: { _id: { s: '$studentId', st: '$status' }, n: { $sum: 1 } } }]);
  for (const r of rows) { const k = String(r._id.s); if (!out.has(k)) out.set(k, zeroCounts()); if (out.get(k)[r._id.st] !== undefined) out.get(k)[r._id.st] += r.n; }
  return out;
}

export const addCounts = (a, b) => { for (const k of Object.keys(a)) a[k] += b[k] || 0; return a; };

/** Only records belonging to SUBMITTED registers are real; drafts are invisible and unmarked is never "absent". */
export async function submittedRecords(tenantId, filter) {
  const recs = await AttendanceRecord.find({ tenantId, ...filter }).lean();
  if (!recs.length) return [];
  const ids = [...new Set(recs.map((r) => String(r.sessionId)))];
  const ok = new Set((await AttendanceSession.find({ _id: { $in: ids }, status: 'submitted' }).select('_id').lean()).map((s) => String(s._id)));
  return recs.filter((r) => ok.has(String(r.sessionId)));
}

export function sessionTotals(records) {
  const t = { total: records.length, present: 0, absent: 0, late: 0, leave: 0, excused: 0 };
  for (const r of records) t[r.status]++;
  return t;
}
