/**
 * Create the first Super Admin (the only account that can exist without being created by another user).
 *   SUPERADMIN_EMAIL=you@company.com SUPERADMIN_PASSWORD='...' npm run seed   (inside backend/)
 */
import mongoose from 'mongoose';
import { requireMongoUri } from './core/config.js';
import { User } from './models/index.js';
import { hashPassword, assertPasswordPolicy } from './services/users.js';

const email = (process.env.SUPERADMIN_EMAIL || '').toLowerCase();
const password = process.env.SUPERADMIN_PASSWORD || '';
if (!email || !password) { console.error('Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD'); process.exit(1); }
assertPasswordPolicy(password);

await mongoose.connect(requireMongoUri());
await mongoose.syncIndexes();
if (await User.exists({ loginId: email })) { console.log(`Super Admin ${email} already exists`); } else {
  await User.create({ role: 'super_admin', loginId: email, email, name: process.env.SUPERADMIN_NAME || 'Platform Admin', passwordHash: await hashPassword(password), mustChangePassword: true });
  console.log(`Super Admin ${email} created (password must be changed at first sign-in)`);
}
await mongoose.disconnect();
