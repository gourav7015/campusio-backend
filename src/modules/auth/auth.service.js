import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { User, Session, School, AcademicYear, PasswordResetCode } from '../../models/index.js';
import { sha256 } from '../../core/crypto.js';
import { isEmailEnabled, sendNotificationEmail } from '../../services/email.js';
import { config } from '../../core/config.js';
import { signToken } from '../../middleware/auth.js';
import { checkPassword, hashPassword, assertPasswordPolicy, needsRehash } from '../../services/users.js';
import { HttpError, bad } from '../../core/utils.js';
import { PORTALS } from './auth.validation.js';
import { registeredContact } from '../../services/contact.js';
import { sendLoginCode, checkLoginCode, newCode, hashCode, sameHash, emailCode, reportTo, MAX_TRIES } from '../../services/otp.js';

const MAX_FAILURES = 8;
const LOCK_MINUTES = 15;
const invalid = () => new HttpError(401, 'Invalid login id or password', 'INVALID_CREDENTIALS');
// An unknown login id still costs one password check, so response time does not reveal which ids exist.
let dummyHash;

export async function schoolBrief(tenantId, withSettings = false) {
  if (!tenantId) return null;
  const s = await School.findById(tenantId).select('name code settings');
  if (!s) return null;
  if (!withSettings) return { id: s._id, name: s.name, code: s.code };
  const year = await AcademicYear.findOne({ tenantId, isCurrent: true }).select('name');
  return { id: s._id, name: s.name, code: s.code, timezone: s.settings?.timezone, academicYear: year?.name || null };
}


/** Counts a wrong password or wrong code; the eighth in a row locks the account for a while. */
async function registerFailure(user) {
  user.failedLogins += 1;
  if (user.failedLogins >= MAX_FAILURES) { user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000); user.failedLogins = 0; }
  await user.save();
}
const assertNotLocked = (user) => { if (user.lockedUntil && user.lockedUntil > new Date()) throw new HttpError(429, 'Account temporarily locked after repeated failures', 'LOCKED'); };

async function startSession(user, { userAgent, ip }, password) {
  user.failedLogins = 0; user.lockedUntil = undefined; user.lastLoginAt = new Date();
  if (password && needsRehash(user.passwordHash)) user.passwordHash = await hashPassword(password); // quietly upgrade old, cheaper hashes
  await user.save();
  const jti = crypto.randomUUID();
  await Session.create({ userId: user._id, jti, userAgent, ip, lastSeenAt: new Date(), expiresAt: new Date(Date.now() + config.sessionHours * 3600 * 1000) });
  return { user, token: signToken(user, jti, config.jwtExpiresIn) };
}

/**
 * Step one: login id, password and portal. A person with two-factor sign-in on gets `{ challenge }` instead of a session and must send the
 * code from their authenticator app (or a recovery code) to `loginSecondStep` within five minutes.
 */
export async function login({ loginId, password, portal }, ctx) {
  const user = await User.findOne({ loginId: loginId.trim().toLowerCase() });
  if (!user) { dummyHash ||= await hashPassword('not-a-real-password'); await checkPassword(password, dummyHash); throw invalid(); }
  assertNotLocked(user);
  if (!(await checkPassword(password, user.passwordHash))) { await registerFailure(user); throw invalid(); }
  if (user.status !== 'active') throw new HttpError(403, 'This account has been disabled', 'DISABLED');
  // Each role signs in through its own portal. A right password at the wrong door gets the same answer as a wrong password: saying "wrong portal" would confirm the credentials are valid.
  if (PORTALS[portal] !== user.role) throw invalid();
  if (user.otp?.enabled) {
    const sentTo = await sendLoginCode(user); // the code goes to the registered email
    return { user, challenge: jwt.sign({ sub: String(user._id), p: '2fa', portal }, config.jwtSecret, { expiresIn: '5m' }), sentTo };
  }
  return startSession(user, ctx, password);
}

/** Asks for the sign-in code again (at most once every 30 seconds). */
export async function resendLoginCode({ challenge }) {
  let payload;
  try { payload = jwt.verify(challenge, config.jwtSecret); } catch { throw new HttpError(401, 'That sign-in took too long. Start again.', 'CHALLENGE_EXPIRED'); }
  if (payload.p !== '2fa') throw invalid();
  const user = await User.findById(payload.sub);
  if (!user || user.status !== 'active' || !user.otp?.enabled || PORTALS[payload.portal] !== user.role) throw invalid();
  assertNotLocked(user);
  return { sentTo: await sendLoginCode(user, { resend: true }) };
}

/** Step two: the challenge from step one plus a 6-digit code or a recovery code. */
export async function loginSecondStep({ challenge, code }, ctx) {
  let payload;
  try { payload = jwt.verify(challenge, config.jwtSecret); } catch { throw new HttpError(401, 'That sign-in took too long. Start again.', 'CHALLENGE_EXPIRED'); }
  if (payload.p !== '2fa') throw invalid();
  const user = await User.findById(payload.sub);
  if (!user || user.status !== 'active' || !user.otp?.enabled || PORTALS[payload.portal] !== user.role) throw invalid();
  assertNotLocked(user);
  if (!(await checkLoginCode(user, String(code).replace(/\s/g, '')))) { await registerFailure(user); throw new HttpError(401, 'That code is not right', 'INVALID_CODE'); }
  return startSession(user, ctx);
}

/** For an administrator (or the database owner) when someone can no longer receive their sign-in codes: the codes are switched off and every device is signed out. */
export async function twoFactorReset(user) {
  user.set('otp', {});
  await user.save();
  await Session.updateMany({ userId: user._id, revokedAt: null }, { revokedAt: new Date() });
}

// ───────────── renewing a session ─────────────
/** A new token for the same session while it is younger than SESSION_MAX_DAYS, so someone using the app is not signed out mid-work. */
export async function refreshSession(user, session) {
  const maxMs = config.sessionMaxDays * 24 * 3600 * 1000;
  if (Date.now() - session.createdAt.getTime() > maxMs) throw new HttpError(401, 'Please sign in again', 'SESSION_TOO_OLD');
  session.expiresAt = new Date(Date.now() + config.sessionHours * 3600 * 1000);
  await session.save();
  return { token: signToken(user, session.jti, config.jwtExpiresIn) };
}

// ───────────── forgotten password: date of birth, then a code by email, then a new password ─────────────
const RESET_TTL_MS = 10 * 60 * 1000;
const normDob = (v) => String(v || '').trim().slice(0, 10);

/**
 * Step one: login id and date of birth. When they match what the school has on file and there is a registered email, a 6-digit code is sent to it.
 * The answer is always the same, so this cannot be used to find out who has an account or when someone was born.
 */
export async function forgotPassword({ loginId, dob }) {
  if (!isEmailEnabled()) return false;
  const user = await User.findOne({ loginId: loginId.trim().toLowerCase() });
  if (!user || user.status !== 'active') return false;
  const contact = await registeredContact(user);
  if (!contact.email || !contact.dob || contact.dob !== normDob(dob)) return false;
  if (await PasswordResetCode.countDocuments({ userId: user._id, createdAt: { $gt: new Date(Date.now() - 3600 * 1000) } }) >= 5) return false; // at most five an hour
  await PasswordResetCode.updateMany({ userId: user._id, usedAt: null }, { $set: { usedAt: new Date() } }); // an earlier request stops working
  const code = newCode();
  await PasswordResetCode.create({ userId: user._id, codeHash: hashCode(user._id, code), expiresAt: new Date(Date.now() + RESET_TTL_MS) });
  emailCode(contact.email, code, 'reset');
  return true;
}

/** Step two: the code. A right code gives a one-time token for step three; a wrong one is counted (five and the request is dead). */
export async function verifyResetCode({ loginId, code }) {
  const wrong = () => new HttpError(400, 'That code is not right, or it has expired. Check it, or start again.', 'RESET_INVALID');
  const user = await User.findOne({ loginId: loginId.trim().toLowerCase() });
  if (!user || user.status !== 'active') throw wrong();
  const rec = await PasswordResetCode.findOne({ userId: user._id, usedAt: null, tokenHash: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
  if (!rec || rec.tries >= MAX_TRIES) throw wrong();
  if (!sameHash(hashCode(user._id, code), rec.codeHash)) { rec.tries += 1; await rec.save(); throw wrong(); }
  const token = crypto.randomBytes(32).toString('base64url');
  rec.tokenHash = sha256(token); rec.expiresAt = new Date(Date.now() + RESET_TTL_MS); await rec.save();
  return { resetToken: token };
}

/** Step three: the new password. Works once; every device is signed out. */
export async function resetPassword({ resetToken, newPassword }) {
  const rec = await PasswordResetCode.findOne({ tokenHash: sha256(resetToken), usedAt: null, expiresAt: { $gt: new Date() } });
  if (!rec) throw new HttpError(400, 'This reset has expired. Start again.', 'RESET_INVALID');
  const user = await User.findById(rec.userId);
  if (!user || user.status !== 'active') throw new HttpError(400, 'This reset has expired. Start again.', 'RESET_INVALID');
  assertPasswordPolicy(newPassword, { loginId: user.loginId, choosing: true });
  user.passwordHash = await hashPassword(newPassword); user.mustChangePassword = false; user.failedLogins = 0; user.lockedUntil = undefined;
  await user.save();
  rec.usedAt = new Date(); await rec.save();
  await Session.updateMany({ userId: user._id, revokedAt: null }, { revokedAt: new Date() }); // every device is signed out
  const { email } = await registeredContact(user);
  if (email) sendNotificationEmail(email, { subject: 'Your AtKaksha password was changed', heading: 'Your password was changed', lines: [`Hello ${user.name},`, `The password for your AtKaksha account was just changed. If this was not you, contact your school office${reportTo() ? ` or write to ${reportTo()}` : ' or AtKaksha support'} at once.`] });
  return user;
}

export async function changePassword(user, session, { currentPassword, newPassword }) {
  // someone signing in for the first time (or after a reset) has just typed the temporary password to get in, so they are not asked for it again; everyone else proves who they are with the current one
  const first = user.mustChangePassword && !currentPassword;
  if (!first && !(currentPassword && await checkPassword(currentPassword, user.passwordHash))) throw bad('Current password is incorrect');
  assertPasswordPolicy(newPassword, { loginId: user.loginId, choosing: true });
  if (first ? await checkPassword(newPassword, user.passwordHash) : newPassword === currentPassword) throw bad('Choose a different password');
  user.passwordHash = await hashPassword(newPassword);
  user.mustChangePassword = false;
  await user.save();
  await Session.updateMany({ userId: user._id, _id: { $ne: session._id }, revokedAt: null }, { revokedAt: new Date() });
}

export async function listSessions(user, session) {
  const rows = await Session.find({ userId: user._id, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ lastSeenAt: -1 });
  return rows.map((s) => ({
    id: s._id, userAgent: s.userAgent, ip: s.ip, lastSeenAt: s.lastSeenAt, createdAt: s.createdAt, current: String(s._id) === String(session._id),
  }));
}

export async function revokeSession(user, id) {
  const s = await Session.findOne({ _id: id, userId: user._id });
  if (!s) throw new HttpError(404, 'Session not found', 'NOT_FOUND');
  s.revokedAt = new Date();
  await s.save();
}

export async function revokeOthers(user, session) {
  const out = await Session.updateMany({ userId: user._id, _id: { $ne: session._id }, revokedAt: null }, { revokedAt: new Date() });
  return out.modifiedCount;
}
