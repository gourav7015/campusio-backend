import mongoose from 'mongoose';
import { User } from '../models/index.js';

export const id = '004-email-codes';
export const description = 'Two-factor sign-in is now a code sent to the registered email. The authenticator-app secrets and recovery codes are removed, and the old password-reset links collection is dropped.';

export async function up() {
  await User.updateMany({ totp: { $exists: true } }, { $unset: { totp: 1 } });
  try { await mongoose.connection.db.dropCollection('passwordresets'); } catch { /* never existed, or already gone */ }
}
