import bcrypt from 'bcryptjs';
import { User, School } from '../models/index.js';
import { config } from '../core/config.js';
import { bad, conflict, generatePassword } from '../core/utils.js';

export const hashPassword = (p) => bcrypt.hash(p, config.bcryptRounds);
export const checkPassword = (p, hash) => bcrypt.compare(p, hash);
/** True when a stored hash was made with a lower cost than the current setting, so it can be upgraded the next time the person signs in. */
export const needsRehash = (hash, rounds = config.bcryptRounds) => { try { return bcrypt.getRounds(hash) < rounds; } catch { return false; } };

// The passwords this product's own demo and test data use, plus the most common ones. A person may not choose these for a real account.
const COMMON = new Set(['password1', 'password123', 'password@123', 'qwerty123', 'welcome123', 'admin@12345', 'super@12345', 'teach@12345', 'student@12345', 'staff@12345', 'finance@12345', 'library@12345', 'transport@12345', 'iloveyou1', '1234567890a']);

export function assertPasswordPolicy(p, { loginId, choosing = false } = {}) {
  if (typeof p !== 'string' || p.length < (choosing ? 10 : 8)) throw bad(`Password must be at least ${choosing ? 10 : 8} characters`);
  if (Buffer.byteLength(p, 'utf8') > 72) throw bad('Password must be at most 72 bytes (about 72 characters)');
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) throw bad('Password must contain a letter and a number');
  if (choosing) {
    if (COMMON.has(p.toLowerCase())) throw bad('That password is too common. Choose something harder to guess');
    if (loginId && p.toLowerCase().includes(String(loginId).toLowerCase().split('@')[0])) throw bad('Password must not contain your login id');
  }
}

/**
 * The only way user accounts come into existence: created by Super Admin (school admins)
 * or by School Admin / acting Super Admin (everyone inside a school). No self-signup.
 */
export async function createUserAccount({ role, tenantId, name, email, loginId, password, createdBy, extra = {} }) {
  let id = (loginId || email || '').trim().toLowerCase();
  if (!id) throw bad('A login id or email is required');
  if (await User.exists({ loginId: id })) throw conflict(`Login id "${id}" is already in use`);
  const plain = password || generatePassword();
  if (password) assertPasswordPolicy(password);
  const user = await User.create({
    role, tenantId: tenantId || null, name, email: email?.toLowerCase() || undefined, loginId: id,
    passwordHash: await hashPassword(plain), mustChangePassword: true, createdBy, ...extra,
  });
  return { user, temporaryPassword: plain };
}

export async function schoolCode(tenantId) {
  const s = await School.findById(tenantId).select('code');
  return s?.code;
}

export const publicUser = (u) => ({
  id: u._id, name: u.name, loginId: u.loginId, email: u.email, role: u.role, tenantId: u.tenantId,
  mustChangePassword: u.mustChangePassword, adminLevel: u.role === 'school_admin' ? u.adminLevel || 'full' : undefined, permissions: u.adminLevel === 'sub' ? u.permissions || [] : undefined, language: u.language, notificationPrefs: u.notificationPrefs, status: u.status, twoFactor: !!u.totp?.enabled,
});
