import crypto from 'node:crypto';
import { config } from '../core/config.js';
import { HttpError, bad } from '../core/utils.js';
import { isEmailEnabled, sendNotificationEmail } from './email.js';
import { registeredContact, maskEmail } from './contact.js';

/** Where a person is told to report a code they did not ask for. */
export const reportTo = () => config.mail.securityTo || config.mail.replyTo;

/**
 * A 6-digit one-time code sent to the registered email: used for two-factor sign-in and for a forgotten password.
 * A code lasts 5 minutes, allows 5 wrong tries, is kept only as a keyed hash, and at most 8 go out per person per hour.
 */
export const TTL_MS = 5 * 60 * 1000;
export const MAX_TRIES = 5;
const RESEND_MS = 30 * 1000;
const MAX_PER_HOUR = 8;

export const emailCodesAvailable = () => isEmailEnabled();
export const hashCode = (userId, code) => crypto.createHmac('sha256', config.dataKey).update(`${userId}:${String(code).replace(/\s/g, '')}`).digest('hex');
export const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
export const sameHash = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** At most MAX_PER_HOUR codes an hour per person (counts the one being sent now). */
export function allowSend(user) {
  const now = Date.now();
  user.otp ||= {};
  user.otp.sends = (user.otp.sends || []).filter((d) => now - new Date(d).getTime() < 3600 * 1000);
  if (user.otp.sends.length >= MAX_PER_HOUR) throw new HttpError(429, 'Too many codes were sent. Wait a while and try again.', 'RATE_LIMIT');
  user.otp.sends.push(new Date());
}

/** Sends the code. Time-sensitive, so it goes ahead of any bulk mail waiting in the outbox. Returns false when nothing could be queued. */
export function emailCode(to, code, what = 'sign-in') {
  return !!sendNotificationEmail(to, {
    subject: what === 'sign-in' ? 'Your AtKaksha sign-in code' : 'Your AtKaksha password reset code', heading: what === 'sign-in' ? 'Your sign-in code' : 'Your password reset code', urgent: true,
    lines: [`${code} is your AtKaksha code.`, `It works for 5 minutes. Never share it with anyone: AtKaksha will never ask you for it. If it was not you, ignore this email and tell your school office${reportTo() ? ` or write to ${reportTo()}` : ''}.`],
  });
}

const registeredEmailOf = async (user) => { const { email } = await registeredContact(user); if (!email) throw bad('There is no email address on file for this account. Ask your school office to add one.'); return email; };

/** Turning two-factor sign-in on (or off): the password, then a code sent to the registered email to prove it can be read. */
export async function start(user, purpose, passwordOk) {
  if (!passwordOk) throw bad('Password is incorrect');
  if (purpose === 'enable' && user.otp?.enabled) throw bad('Sign-in codes are already on');
  if (purpose === 'disable' && !user.otp?.enabled) throw bad('Sign-in codes are not on');
  if (!emailCodesAvailable()) throw bad('Email codes are not available yet.');
  const to = await registeredEmailOf(user);
  allowSend(user);
  const code = newCode();
  user.otp.pending = { purpose, codeHash: hashCode(user._id, code), expiresAt: new Date(Date.now() + TTL_MS), tries: 0 };
  user.markModified('otp');
  await user.save();
  if (!emailCode(to, code)) throw new HttpError(503, 'We could not send the code. Try again in a minute.', 'SEND_FAILED');
  return { sentTo: maskEmail(to) };
}

export async function confirm(user, { code }) {
  const p = user.otp?.pending;
  if (!p?.codeHash) throw bad('Ask for a code first');
  if (!p.expiresAt || p.expiresAt < new Date()) throw bad('That code has expired. Ask for a new one.');
  if (p.tries >= MAX_TRIES) throw bad('Too many wrong tries. Ask for a new code.');
  if (!sameHash(hashCode(user._id, code), p.codeHash)) { user.otp.pending.tries += 1; user.markModified('otp'); await user.save(); throw bad('That code is not right'); }
  const purpose = p.purpose;
  user.otp.enabled = purpose === 'enable';
  user.otp.enabledAt = purpose === 'enable' ? new Date() : undefined;
  user.otp.pending = undefined;
  user.markModified('otp');
  await user.save();
  return { purpose };
}

/** At sign-in, after the password: a fresh code to the registered email. Returns the hidden address it went to. */
export async function sendLoginCode(user, { resend = false } = {}) {
  const to = await registeredEmailOf(user).catch(() => { throw new HttpError(503, 'There is no email address on file to send your sign-in code to. Ask your school office to add one or to reset your sign-in codes.', 'SEND_FAILED'); });
  const last = user.otp?.login?.sentAt;
  if (resend && last && Date.now() - last.getTime() < RESEND_MS) throw new HttpError(429, 'Wait a few seconds before asking for another code.', 'RATE_LIMIT');
  allowSend(user);
  const code = newCode();
  user.otp.login = { codeHash: hashCode(user._id, code), expiresAt: new Date(Date.now() + TTL_MS), tries: 0, sentAt: new Date() };
  user.markModified('otp');
  await user.save();
  if (!emailCode(to, code)) throw new HttpError(503, 'We could not send your sign-in code. Try again in a minute, or ask your school office to reset your sign-in codes.', 'SEND_FAILED');
  return maskEmail(to);
}

/** True when `code` is the sign-in code that was sent. Wrong tries are counted per code; a used code is gone. */
export async function checkLoginCode(user, code) {
  const l = user.otp?.login;
  if (!l?.codeHash || !l.expiresAt || l.expiresAt < new Date() || l.tries >= MAX_TRIES) return false;
  if (!sameHash(hashCode(user._id, code), l.codeHash)) { user.otp.login.tries += 1; user.markModified('otp'); await user.save(); return false; }
  user.otp.login = undefined; user.markModified('otp'); await user.save();
  return true;
}
