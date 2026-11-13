import crypto from 'node:crypto';
import mongoose from 'mongoose';

export class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const bad = (m, d) => new HttpError(400, m, 'BAD_REQUEST', d);
export const forbidden = (m = 'You do not have permission to do this') => new HttpError(403, m, 'FORBIDDEN');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'NOT_FOUND');
export const conflict = (m, d) => new HttpError(409, m, 'CONFLICT', d);

export function parse(schema, data) {
  return schema.parse(data ?? {});
}

export const isId = (v) => typeof v === 'string' && mongoose.isValidObjectId(v) && /^[a-f0-9]{24}$/i.test(v);
export function oid(v, label = 'id') {
  if (!isId(String(v))) throw bad(`Invalid ${label}`);
  return new mongoose.Types.ObjectId(String(v));
}

// ---- dates: calendar days are plain 'YYYY-MM-DD' strings (school-local) ----
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isDateStr(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export function todayStr(tz = 'Asia/Kolkata', now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
export function nowTimeStr(tz = 'Asia/Kolkata', now = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
}
export function addDays(s, n) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** ISO weekday: 1=Mon … 7=Sun */
export function isoDay(s) {
  const d = new Date(`${s}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}
export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}
export function eachDate(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
export const monthOf = (s) => s.slice(0, 7);

export function generatePassword(len = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out + '#7';
}

export const round1 = (n) => Math.round(n * 10) / 10;
export const round2 = (n) => Math.round(n * 100) / 100;
export const pct = (num, den) => (den > 0 ? round1((num / den) * 100) : null);
export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const uniq = (arr) => [...new Set(arr.map(String))];
export const str = (v) => (v == null ? v : String(v));

export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(c.get(r))).join(','))].join('\n');
}
