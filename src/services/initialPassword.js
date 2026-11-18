import { assertPasswordPolicy } from './users.js';

/**
 * A school's starting-password format, so nobody has to invent or hand out thousands of passwords when data is loaded.
 * Like a bank's first password: the first four letters of the name in capitals, then the date of birth.
 *   {NAME4}{DDMMYYYY}  ->  "Aarav Singh", born 10 Jan 2013  ->  AARA10012013
 * Tokens: {NAME4} {NAME3} {name4} (lower case) {DDMMYYYY} {DDMM} {YYYY} {YY} {PHONE4} (last four digits of the phone).
 * It is only ever a first password: the person must choose their own at first sign-in. When the details a format needs are missing,
 * or the result is too weak, there is no format password and the caller falls back to a random one.
 */
export const DEFAULT_PASSWORD_FORMAT = '{NAME4}{DDMMYYYY}';
export const PASSWORD_FORMAT_TOKENS = ['NAME4', 'NAME3', 'name4', 'DDMMYYYY', 'DDMM', 'YYYY', 'YY', 'PHONE4'];
export const PASSWORD_FORMAT_RE = /^(?:\{(?:NAME4|NAME3|name4|DDMMYYYY|DDMM|YYYY|YY|PHONE4)\}|[A-Za-z0-9@#_-]){1,40}$/;

const letters = (s) => String(s || '').normalize('NFD').replace(/[^A-Za-z]/g, '');
const pad = (s, n) => (s + 'XXXX').slice(0, n);

export function renderPasswordFormat(format, { name, dob, phone } = {}) {
  let missing = false;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob || '');
  const out = String(format).replace(/\{(\w+)\}/g, (_, t) => {
    switch (t) {
      case 'NAME4': return pad(letters(name).toUpperCase(), 4);
      case 'NAME3': return pad(letters(name).toUpperCase(), 3);
      case 'name4': return pad(letters(name).toLowerCase().replace(/x+$/, ''), 4).toLowerCase();
      case 'DDMMYYYY': if (!d) { missing = true; return ''; } return `${d[3]}${d[2]}${d[1]}`;
      case 'DDMM': if (!d) { missing = true; return ''; } return `${d[3]}${d[2]}`;
      case 'YYYY': if (!d) { missing = true; return ''; } return d[1];
      case 'YY': if (!d) { missing = true; return ''; } return d[1].slice(2);
      case 'PHONE4': { const p = String(phone || '').replace(/\D/g, ''); if (p.length < 4) { missing = true; return ''; } return p.slice(-4); }
      default: missing = true; return '';
    }
  });
  return missing || !letters(name) ? null : out;
}

/** The starting password for a person under the school's settings, or null (use a random one). */
export function initialPassword(settings, person) {
  const format = settings?.passwordFormat;
  if (!format) return null;
  const p = renderPasswordFormat(format, person);
  if (!p) return null;
  try { assertPasswordPolicy(p); } catch { return null; }
  return p;
}
