import mongoose from 'mongoose';
import { requireMongoUri } from '../core/config.js';
import { User } from '../models/index.js';
import { twoFactorReset } from '../modules/auth/auth.service.js';

const loginId = process.argv[2];
if (!loginId) { console.log('Usage: npm run reset-2fa -- <login id>\nSwitches off two-factor sign-in for that account (for example when the Platform Admin lost their phone) and signs it out everywhere.'); process.exit(1); }
await mongoose.connect(requireMongoUri(), { serverSelectionTimeoutMS: 15000 });
try {
  const u = await User.findOne({ loginId: loginId.trim().toLowerCase() });
  if (!u) { console.error('No such account'); process.exitCode = 1; } else { await twoFactorReset(u); console.log(`Two-factor sign-in is off for ${u.loginId}. They can sign in with their password and turn it on again.`); }
} finally { await mongoose.disconnect(); }
