import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { User, Session, School, AcademicYear, PasswordReset } from '../../models/index.js';
import { seal, open, sha256 } from '../../core/crypto.js';
import { newSecret, otpauthUri, qrSvg, verifyTotp, newRecoveryCodes } from '../../services/totp.js';
import { isEmailEnabled, sendNotificationEmail } from '../../services/email.js';
import { config } from '../../core/config.js';
import { signToken } from '../../middleware/auth.js';
import { checkPassword, hashPassword, assertPasswordPolicy, needsRehash } from '../../services/users.js';
import { HttpError, bad } from '../../core/utils.js';
import { PORTALS } from './auth.validation.js';

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
  if (user.totp?.enabled) return { user, challenge: jwt.sign({ sub: String(user._id), p: '2fa', portal }, config.jwtSecret, { expiresIn: '5m' }) };
  return startSession(user, ctx, password);
}

/** Step two: the challenge from step one plus a 6-digit code or a recovery code. */
export async function loginSecondStep({ challenge, code }, ctx) {
  let payload;
  try { payload = jwt.verify(challenge, config.jwtSecret); } catch { throw new HttpError(401, 'That sign-in took too long. Start again.', 'CHALLENGE_EXPIRED'); }
  if (payload.p !== '2fa') throw invalid();
  const user = await User.findById(payload.sub);
  if (!user || user.status !== 'active' || !user.totp?.enabled || PORTALS[payload.portal] !== user.role) throw invalid();
  assertNotLocked(user);
  if (!(await consumeSecondFactor(user, code))) { await registerFailure(user); throw new HttpError(401, 'That code is not right', 'INVALID_CODE'); }
  return startSession(user, ctx);
}

const recoveryHash = (c) => sha256(String(c).trim().toLowerCase().replace(/\s/g, ''));
/** A six-digit code (not used before) or one unused recovery code. Saves the user on success. */
export async function consumeSecondFactor(user, code) {
  const raw = String(code || '').trim();
  if (/^\d{3}\s?\d{3}$/.test(raw)) {
    const step = verifyTotp(open(user.totp.secretSealed), raw, { lastStep: user.totp.lastStep });
    if (step == null) return false;
    user.totp.lastStep = step; await user.save(); return true;
  }
  const h = recoveryHash(raw);
  if (user.totp.recovery?.includes(h)) { user.totp.recovery = user.totp.recovery.filter((x) => x !== h); await user.save(); return true; }
  return false;
}

// ───────────── two-factor set-up ─────────────
export async function twoFactorSetup(user, { password }) {
  if (!(await checkPassword(password || '', user.passwordHash))) throw bad('Password is incorrect');
  if (user.totp?.enabled) throw bad('Two-factor sign-in is already on');
  const secret = newSecret();
  user.totp = { ...(user.totp?.toObject?.() || {}), enabled: false, pendingSealed: seal(secret) };
  await user.save();
  const uri = otpauthUri(secret, user.loginId);
  return { secret, otpauth: uri, qrSvg: qrSvg(uri) };
}
export async function twoFactorEnable(user, { code }) {
  if (user.totp?.enabled) throw bad('Two-factor sign-in is already on');
  if (!user.totp?.pendingSealed) throw bad('Start the set-up first');
  const secret = open(user.totp.pendingSealed);
  const step = verifyTotp(secret, code);
  if (step == null) throw bad('That code is not right. Check the time on your phone and try the next code.');
  const codes = newRecoveryCodes();
  user.totp = { enabled: true, secretSealed: seal(secret), pendingSealed: undefined, lastStep: step, recovery: codes.map(recoveryHash), enabledAt: new Date() };
  await user.save();
  return { recoveryCodes: codes };
}
export async function twoFactorDisable(user, { password, code }) {
  if (!user.totp?.enabled) throw bad('Two-factor sign-in is not on');
  if (!(await checkPassword(password || '', user.passwordHash))) throw bad('Password is incorrect');
  if (!(await consumeSecondFactor(user, code))) throw bad('That code is not right');
  user.totp = { enabled: false, recovery: [], lastStep: 0 };
  await user.save();
}
export async function newRecovery(user, { password, code }) {
  if (!user.totp?.enabled) throw bad('Two-factor sign-in is not on');
  if (!(await checkPassword(password || '', user.passwordHash))) throw bad('Password is incorrect');
  if (!(await consumeSecondFactor(user, code))) throw bad('That code is not right');
  const codes = newRecoveryCodes(); user.totp.recovery = codes.map(recoveryHash); await user.save();
  return { recoveryCodes: codes };
}
/** For an administrator (or the database owner) when someone has lost their phone and their recovery codes. */
export async function twoFactorReset(user) {
  user.totp = { enabled: false, recovery: [], lastStep: 0 };
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

// ───────────── forgotten password by email ─────────────
export async function forgotPassword({ loginId }) {
  if (!isEmailEnabled()) return false;
  const user = await User.findOne({ loginId: loginId.trim().toLowerCase() });
  if (!user || user.status !== 'active' || !user.email) return false;
  if (await PasswordReset.countDocuments({ userId: user._id, createdAt: { $gt: new Date(Date.now() - 3600 * 1000) } }) >= 3) return false; // at most three a hour
  await PasswordReset.updateMany({ userId: user._id, usedAt: null }, { $set: { usedAt: new Date() } }); // an earlier link stops working when a newer one is sent
  const token = crypto.randomBytes(32).toString('base64url');
  await PasswordReset.create({ userId: user._id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 30 * 60 * 1000) });
  sendNotificationEmail(user.email, {
    subject: 'Reset your AtKaksha password', heading: 'Reset your password',
    lines: [`Hello ${user.name},`, 'Someone asked to reset the password for your AtKaksha account. Use the button below within 30 minutes. If it was not you, ignore this email: your password stays as it is.'],
    button: { label: 'Choose a new password', url: `${config.mail.appUrl}/reset-password?token=${token}` },
  });
  return true;
}
export async function resetPassword({ token, newPassword, code }) {
  const rec = await PasswordReset.findOne({ tokenHash: sha256(token), usedAt: null, expiresAt: { $gt: new Date() } });
  if (!rec) throw new HttpError(400, 'This reset link is not valid any more. Ask for a new one.', 'RESET_INVALID');
  const user = await User.findById(rec.userId);
  if (!user || user.status !== 'active') throw new HttpError(400, 'This reset link is not valid any more. Ask for a new one.', 'RESET_INVALID');
  if (user.totp?.enabled && !(await consumeSecondFactor(user, code))) throw new HttpError(401, 'Enter the code from your authenticator app', 'INVALID_CODE');
  assertPasswordPolicy(newPassword, { loginId: user.loginId, choosing: true });
  user.passwordHash = await hashPassword(newPassword); user.mustChangePassword = false; user.failedLogins = 0; user.lockedUntil = undefined;
  await user.save();
  rec.usedAt = new Date(); await rec.save();
  await Session.updateMany({ userId: user._id, revokedAt: null }, { revokedAt: new Date() }); // every device is signed out
  if (user.email) sendNotificationEmail(user.email, { subject: 'Your AtKaksha password was changed', heading: 'Your password was changed', lines: [`Hello ${user.name},`, 'The password for your AtKaksha account was just changed using a reset link. If this was not you, contact your school office or AtKaksha support at once.'] });
  return user;
}

export async function changePassword(user, session, { currentPassword, newPassword }) {
  if (!(await checkPassword(currentPassword, user.passwordHash))) throw bad('Current password is incorrect');
  assertPasswordPolicy(newPassword, { loginId: user.loginId, choosing: true });
  if (newPassword === currentPassword) throw bad('Choose a different password');
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
