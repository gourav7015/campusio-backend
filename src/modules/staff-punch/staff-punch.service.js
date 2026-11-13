import { StaffPunch, CalendarEvent } from '../../models/index.js';
import { bad, conflict, forbidden, isoDay, nowTimeStr, round1 } from '../../core/utils.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const policyOf = (ctx) => ctx.settings.staffAttendance;

/** Metres between two points on the Earth (haversine). */
export function distanceMeters(a, b) {
  const R = 6371000; const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** What the times say, against the school's working hours: late, hours worked, and the status the register should suggest. */
export function evaluate(settings, punch) {
  if (!punch?.checkIn) return null;
  const p = settings.staffAttendance;
  const minutesLate = Math.max(0, mins(punch.checkIn) - (mins(p.shiftStart) + p.graceMinutes));
  const hours = punch.checkOut ? round1((mins(punch.checkOut) - mins(punch.checkIn)) / 60) : null;
  const late = minutesLate > 0;
  const short = hours != null && hours < p.fullDayHours;
  const suggested = hours != null && hours < p.halfDayHours ? 'half_day' : short && hours < p.fullDayHours - 1 ? 'half_day' : late ? 'late' : 'present';
  return { late, minutesLate, hours, short, suggested };
}

export async function punchesFor(ctx, group, date) {
  const rows = await StaffPunch.find({ tenantId: ctx.tenantId, group, date }).lean();
  return new Map(rows.map((r) => [String(r.personId), r]));
}

async function workingToday(ctx) {
  if (!ctx.settings.workingDays.includes(isoDay(ctx.today))) throw bad('Today is not a working day for the school');
  const h = await CalendarEvent.findOne({ tenantId: ctx.tenantId, type: 'holiday', startDate: { $lte: ctx.today }, endDate: { $gte: ctx.today }, sectionIds: { $size: 0 } }).lean();
  if (h) throw bad(`Today is a holiday (${h.title})`);
}

function locate(ctx, coords) {
  const loc = policyOf(ctx).location;
  if (!loc) return coords ? { lat: coords.lat, lng: coords.lng } : undefined;
  if (!coords) throw bad('This school asks you to check in from the school. Allow location access and try again.');
  const distance = Math.round(distanceMeters(loc, coords));
  if (distance > loc.radiusMeters) throw forbidden(`You are ${distance} m from the school. You can check in only within ${loc.radiusMeters} m.`);
  return { lat: coords.lat, lng: coords.lng, distance };
}

export async function today(ctx, person) {
  const p = await StaffPunch.findOne({ tenantId: ctx.tenantId, personId: person.id, date: ctx.today }).lean();
  const pol = policyOf(ctx);
  return { date: ctx.today, now: nowTimeStr(ctx.settings.timezone), punch: p, evaluation: evaluate(ctx.settings, p), policy: { shiftStart: pol.shiftStart, shiftEnd: pol.shiftEnd, graceMinutes: pol.graceMinutes, requiresLocation: !!pol.location, radiusMeters: pol.location?.radiusMeters } };
}

export async function checkIn(ctx, person, coords) {
  await workingToday(ctx);
  const existing = await StaffPunch.findOne({ tenantId: ctx.tenantId, personId: person.id, date: ctx.today });
  if (existing?.checkIn) throw conflict(`You already checked in at ${existing.checkIn}`);
  const where = locate(ctx, coords);
  const doc = { checkIn: nowTimeStr(ctx.settings.timezone), source: 'self', inLocation: where };
  await StaffPunch.updateOne({ tenantId: ctx.tenantId, personId: person.id, date: ctx.today }, { $set: { personType: person.type, group: person.group, ...doc } }, { upsert: true });
  return today(ctx, person);
}

export async function checkOut(ctx, person, coords) {
  const p = await StaffPunch.findOne({ tenantId: ctx.tenantId, personId: person.id, date: ctx.today });
  if (!p?.checkIn) throw conflict('Check in first');
  if (p.checkOut) throw conflict(`You already checked out at ${p.checkOut}`);
  const where = locate(ctx, coords);
  const t = nowTimeStr(ctx.settings.timezone);
  p.checkOut = mins(t) >= mins(p.checkIn) ? t : p.checkIn; p.outLocation = where;
  await p.save();
  return today(ctx, person);
}

/** A desk enters or corrects the times of someone (they may have no login, or forgot). */
export async function setTimes(ctx, { personType, personId, group, date, checkIn, checkOut }) {
  for (const t of [checkIn, checkOut]) if (t && !HHMM.test(t)) throw bad('Use HH:MM for times');
  if (checkIn && checkOut && mins(checkOut) < mins(checkIn)) throw bad('Check-out cannot be before check-in');
  const $set = { personType, group, source: 'manual' };
  const $unset = {};
  if (checkIn) $set.checkIn = checkIn; else $unset.checkIn = '';
  if (checkOut) $set.checkOut = checkOut; else $unset.checkOut = '';
  await StaffPunch.updateOne({ tenantId: ctx.tenantId, personId, date }, { $set, ...(Object.keys($unset).length ? { $unset } : {}) }, { upsert: true });
}

/**
 * Import the export of a biometric / attendance machine: rows of (employee or staff code, date, time).
 * For each person and day the earliest time is the check-in and the latest (if different) the check-out.
 */
export async function importPunches(ctx, group, people, rows) {
  const byCode = new Map(people.map((p) => [String(p.code).toLowerCase(), p]));
  const buckets = new Map(); const unknown = new Set(); let bad_ = 0;
  for (const r of rows) {
    const p = byCode.get(String(r.code).trim().toLowerCase());
    if (!p) { unknown.add(String(r.code)); continue; }
    if (!HHMM.test(r.time) || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || r.date > ctx.today) { bad_++; continue; }
    const k = `${p.personId}|${r.date}`;
    if (!buckets.has(k)) buckets.set(k, { p, date: r.date, times: [] });
    buckets.get(k).times.push(r.time);
  }
  const ops = [...buckets.values()].map(({ p, date, times }) => {
    const sorted = [...new Set(times)].sort();
    return { updateOne: { filter: { tenantId: ctx.tenantId, personId: p.personId, date }, update: { $set: { personType: p.personType, group, source: 'import', checkIn: sorted[0], ...(sorted.length > 1 ? { checkOut: sorted[sorted.length - 1] } : {}) } }, upsert: true } };
  });
  if (ops.length) await StaffPunch.bulkWrite(ops);
  return { imported: ops.length, people: new Set([...buckets.values()].map((b) => String(b.p.personId))).size, unknownCodes: [...unknown], badRows: bad_ };
}
