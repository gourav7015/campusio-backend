import mongoose from 'mongoose';
import { requireMongoUri } from '../core/config.js';
import { listMigrations, runMigrations } from '../core/migrations.js';
import { Migration } from '../models/index.js';

await mongoose.connect(requireMongoUri(), { serverSelectionTimeoutMS: 15000 });
try {
  const all = await listMigrations();
  const done = new Set((await Migration.find({}, 'id').lean()).map((m) => m.id));
  console.log(all.length ? all.map((m) => `${done.has(m.id) ? 'done   ' : 'PENDING'} ${m.id} — ${m.description}`).join('\n') : 'No migrations.');
  if (process.argv.includes('--status')) process.exit(0);
  const ran = await runMigrations();
  console.log(ran.length ? `Ran: ${ran.join(', ')}` : 'Nothing to run.');
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { await mongoose.disconnect(); }
