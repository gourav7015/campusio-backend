import { Student, Teacher, StaffMember } from '../models/index.js';
import { bad, isDateStr } from '../core/utils.js';

/** A mobile number as people write it (98765 43210, +91 98765-43210) → the digits, or null when it cannot be one. */
export const cleanPhone = (v) => { const d = String(v || '').replace(/[^\d]/g, ''); const ten = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d; return /^[6-9]\d{9}$/.test(ten) ? ten : (/^\d{8,15}$/.test(d) && String(v).trim().startsWith('+') ? d : null); };
const isEmail = (v) => /^\S+@\S+\.\S+$/.test(String(v || '').trim()) && String(v).length <= 200;

/**
 * An account needs a way to reach its owner: an email address, a mobile number and a date of birth. They are asked for when the account is made,
 * because they are how a forgotten password is recovered and where sign-in codes go. Throws a plain message when one is missing or wrong.
 */
export function assertContact({ email, phone, dob }, who = 'this person') {
  if (!isEmail(email)) throw bad(`An email address is needed for ${who}: sign-in codes and password resets are sent to it`);
  if (!cleanPhone(phone)) throw bad(`A mobile number is needed for ${who}`);
  if (!dob || !isDateStr(dob)) throw bad(`A date of birth is needed for ${who}: it is asked when a password is reset`);
}

/**
 * The contact details on file for an account, taken from the person's own record so they stay right when the school corrects them:
 * a student's own, else the primary guardian's; a teacher's; an employee's; otherwise what was given when the account was made.
 */
export async function registeredContact(user) {
  const by = { tenantId: user.tenantId, userId: user._id };
  let rec = null;
  if (user.role === 'student') {
    const s = await Student.findOne(by).select('email phone dob guardians').lean();
    if (s) { const g = (s.guardians || []).find((x) => x.isPrimary) || s.guardians?.[0]; rec = { email: s.email || g?.email, phone: s.phone || g?.phone, dob: s.dob }; }
  } else if (user.role === 'teacher') rec = await Teacher.findOne(by).select('email phone dob').lean();
  else if (['staff', 'finance', 'library', 'transport'].includes(user.role)) rec = await StaffMember.findOne(by).select('email phone dob').lean();
  return { email: (rec?.email || user.email || '').toLowerCase() || null, phone: rec?.phone || user.phone || null, dob: rec?.dob || user.dob || null };
}

export const maskEmail = (e) => { if (!e) return null; const [n, d] = e.split('@'); return `${n.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(5, n.length - 1)))}@${d}`; };
