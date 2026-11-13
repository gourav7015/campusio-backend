import bcrypt from 'bcryptjs';
import { User, School } from '../models/index.js';
import { config } from '../core/config.js';
import { bad, conflict, generatePassword } from '../core/utils.js';

export const hashPassword = (p) => bcrypt.hash(p, config.bcryptRounds);
export const checkPassword = (p, hash) => bcrypt.compare(p, hash);

export function assertPasswordPolicy(p) {
  if (typeof p !== 'string' || p.length < 8) throw bad('Password must be at least 8 characters');
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) throw bad('Password must contain a letter and a number');
}

/**
 * The only way user accounts come into existence: created by Super Admin (school admins)
 * or by School Admin / acting Super Admin (everyone inside a school). No self-signup.
 */
export async function createUserAccount({ role, tenantId, name, email, loginId, password, createdBy }) {
  let id = (loginId || email || '').trim().toLowerCase();
  if (!id) throw bad('A login id or email is required');
  if (await User.exists({ loginId: id })) throw conflict(`Login id "${id}" is already in use`);
  const plain = password || generatePassword();
  if (password) assertPasswordPolicy(password);
  const user = await User.create({
    role, tenantId: tenantId || null, name, email: email?.toLowerCase() || undefined, loginId: id,
    passwordHash: await hashPassword(plain), mustChangePassword: true, createdBy,
  });
  return { user, temporaryPassword: plain };
}

export async function schoolCode(tenantId) {
  const s = await School.findById(tenantId).select('code');
  return s?.code;
}

export const publicUser = (u) => ({
  id: u._id, name: u.name, loginId: u.loginId, email: u.email, role: u.role, tenantId: u.tenantId,
  mustChangePassword: u.mustChangePassword, language: u.language, notificationPrefs: u.notificationPrefs, status: u.status,
});
