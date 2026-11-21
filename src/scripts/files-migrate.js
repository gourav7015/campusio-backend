import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { requireMongoUri } from '../core/config.js';
import { File } from '../models/index.js';
import { filePath, putBytes } from '../services/files.js';

/**
 * Moves files that were stored on one computer's disk into the database (GridFS), so every server sees them.
 * Run it on the computer that holds the uploads folder (the one that accepted the uploads):  npm run files:migrate
 * `-- --dry-run` only counts. A file whose bytes are not found in the uploads folder here is listed and left as it is.
 */
export async function migrateFiles({ dryRun = false, log = () => {} } = {}) {
  const todo = await File.find({ store: { $ne: 'gridfs' } });
  const out = { total: todo.length, moved: 0, missing: [] };
  for (const f of todo) {
    const p = filePath(f);
    if (!fs.existsSync(p)) { out.missing.push({ id: String(f._id), name: f.originalName, kind: f.kind }); continue; }
    if (!dryRun) {
      f.gridId = await putBytes(fs.readFileSync(p), f.originalName || f.storageKey);
      f.store = 'gridfs'; await f.save();
    }
    out.moved += 1; log(`${dryRun ? 'would move' : 'moved'} ${f.originalName} (${f.kind})`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await mongoose.connect(requireMongoUri(), { serverSelectionTimeoutMS: 15000 });
  try {
    const dry = process.argv.includes('--dry-run');
    const r = await migrateFiles({ dryRun: dry, log: (m) => console.log(m) });
    console.log(`\n${dry ? 'Would move' : 'Moved'} ${r.moved} of ${r.total} file(s) into the database.`);
    if (r.missing.length) console.log(`${r.missing.length} file(s) are not in this computer's uploads folder and were left as they are:\n${r.missing.map((m) => `  ${m.name || m.id} (${m.kind})`).join('\n')}\nUpload those again from the app.`);
  } catch (e) { console.error(e.message); process.exitCode = 1; } finally { await mongoose.disconnect(); }
}
