import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { requireMongoUri, config } from '../core/config.js';
import { File } from '../models/index.js';
import { filePath, storeBytes, rawBytes, removeFileBytes } from '../services/files.js';
import { putObject } from '../services/objectStore.js';

/**
 * Moves stored files to where new uploads go.
 *  - Files that were stored on one computer's disk are copied into the object store (R2) when it is set up, otherwise into the database (GridFS).
 *    Run this on the computer that holds the uploads folder (the one that accepted the uploads):  npm run files:migrate
 *  - With `-- --to-r2`, files already in the database (GridFS) are copied to R2 as well (as stored: encrypted files stay encrypted), and the database copy
 *    is deleted once the file is safely in R2. `-- --keep-source` leaves the database copy in place.
 * `-- --dry-run` only counts. A file that cannot be found is listed and left as it is. Nothing is deleted before its copy has been written.
 */
export async function migrateFiles({ dryRun = false, toObjectStore = false, keepSource = false, log = () => {} } = {}) {
  if (toObjectStore && !config.objectStore.enabled) throw new Error('R2 is not set up here: set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY first.');
  const todo = await File.find({ store: { $nin: toObjectStore ? ['r2'] : ['r2', 'gridfs'] } });
  const out = { total: todo.length, moved: 0, missing: [] };
  for (const f of todo) {
    const verb = dryRun ? 'would move' : 'moved';
    if (f.store === 'gridfs') { // already in the database; only moving to R2 gets here
      let bytes;
      try { bytes = await rawBytes(f); } catch { out.missing.push({ id: String(f._id), name: f.originalName, kind: f.kind }); continue; }
      if (!dryRun) {
        const objectKey = `t/${f.tenantId}/${f._id}`;
        await putObject(objectKey, bytes, f.mime);
        const before = { store: f.store, gridId: f.gridId };
        f.store = 'r2'; f.objectKey = objectKey; f.gridId = undefined; await f.save();
        if (!keepSource) await removeFileBytes({ ...before });
      }
      out.moved += 1; log(`${verb} ${f.originalName} (${f.kind}) to R2`); continue;
    }
    const p = filePath(f);
    if (!fs.existsSync(p)) { out.missing.push({ id: String(f._id), name: f.originalName, kind: f.kind }); continue; }
    if (!dryRun) {
      const where = await storeBytes(fs.readFileSync(p), { name: f.originalName || f.storageKey, mime: f.mime, tenantId: f.tenantId });
      Object.assign(f, where); await f.save();
    }
    out.moved += 1; log(`${verb} ${f.originalName} (${f.kind})`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await mongoose.connect(requireMongoUri(), { serverSelectionTimeoutMS: 15000 });
  try {
    const dry = process.argv.includes('--dry-run');
    const r = await migrateFiles({ dryRun: dry, toObjectStore: process.argv.includes('--to-r2'), keepSource: process.argv.includes('--keep-source'), log: (m) => console.log(m) });
    console.log(`\n${dry ? 'Would move' : 'Moved'} ${r.moved} of ${r.total} file(s).`);
    if (r.missing.length) console.log(`${r.missing.length} file(s) could not be found here and were left as they are:\n${r.missing.map((m) => `  ${m.name || m.id} (${m.kind})`).join('\n')}`);
  } catch (e) { console.error(e.message); process.exitCode = 1; } finally { await mongoose.disconnect(); }
}
