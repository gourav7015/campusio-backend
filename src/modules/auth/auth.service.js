import crypto from 'node:crypto';
import { User, Session, School, AcademicYear } from '../../models/index.js';
import { config } from '../../core/config.js';
import { signToken } from '../../middleware/auth.js';
import { checkPassword, hashPassword, assertPasswordPolicy } from '../../services/users.js';
import { HttpError, bad } from '../../core/utils.js';
import { PORTALS } from './auth.validation.js';

const MAX_FAILURES = 8;
const LOCK_MINUTES = 15;
const invalid = () => new HttpError(401, 'Invalid login id or password', 'INVALID_CREDENTIALS');

export async function schoolBrief(tenantId, withSettings = false) {
  if (!tenantId) return null;
  const s = await School.findById(tenantId).select('name code settings');
  if (!s) return null;
  if (!withSettings) return { id: s._id, name: s.name, code: s.code };
  const year = await AcademicYear.findOne({ tenantId, isCurrent: true }).select('name');
  return { id: s._id, name: s.name, code: s.code, timezone: s.settings?.timezone, academicYear: year?.name || null };
}

const PORTAL_NAME = { student: 'Student', teacher: 'Teacher', finance: 'Finance', library: 'Library', transport: 'Transport', staff: 'Staff', school_admin: 'School Admin', super_admin: 'Platform Admin' };

export async function login({ loginId, password, portal }, { userAgent, ip }) {
  const user = await User.findOne({ loginId: loginId.trim().toLowerCase() });
  if (!user) throw invalid();
  if (user.lockedUntil && user.lockedUntil > new Date()) throw new HttpError(429, 'Account temporarily locked after repeated failures', 'LOCKED');
  if (!(await checkPassword(password, user.passwordHash))) {
    user.failedLogins += 1;
    if (user.failedLogins >= MAX_FAILURES) {
      user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
      user.failedLogins = 0;
    }
    await user.save();
    throw invalid();
  }
  if (user.status !== 'active') throw new HttpError(403, 'This account has been disabled', 'DISABLED');
  // Each role signs in through its own portal. Only revealed after the password is right, so it leaks nothing.
  if (PORTALS[portal] !== user.role) throw new HttpError(403, `This login belongs to the ${PORTAL_NAME[user.role]} portal. Please sign in from the ${PORTAL_NAME[user.role]} login page.`, 'WRONG_PORTAL');
  user.failedLogins = 0; user.lockedUntil = undefined; user.lastLoginAt = new Date();
  await user.save();

  const jti = crypto.randomUUID();
  await Session.create({
    userId: user._id, jti, userAgent, ip, lastSeenAt: new Date(), expiresAt: new Date(Date.now() + config.sessionHours * 3600 * 1000),
  });
  return { user, token: signToken(user, jti, config.jwtExpiresIn) };
}

export async function changePassword(user, session, { currentPassword, newPassword }) {
  if (!(await checkPassword(currentPassword, user.passwordHash))) throw bad('Current password is incorrect');
  assertPasswordPolicy(newPassword);
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
