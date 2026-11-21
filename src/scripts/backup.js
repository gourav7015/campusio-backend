import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import mongoose from 'mongoose';
import { EJSON } from 'bson';
import { config } from '../core/config.js';

const BATCH = 500;
const lines = async function* (cursor) { for await (const doc of cursor) yield `${EJSON.stringify(doc, { relaxed: false })}\n`; };

/**
 * Writes every collection to <dir>/<collection>.jsonl.gz (one document per line, exact types kept) and a manifest with the counts.
 * With `files`, the uploaded files are copied beside them. Returns the manifest. Needs an open mongoose connection.
 */
export async function backupDatabase(dir, { files = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const db = mongoose.connection.db;
  const cols = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.'));
  const counts = {};
  for (const name of cols) {
    await pipeline(Readable.from(lines(db.collection(name).find({}))), zlib.createGzip(), fs.createWriteStream(path.join(dir, `${name}.jsonl.gz`)));
    counts[name] = await db.collection(name).countDocuments();
  }
  let fileCount = 0;
  if (files && fs.existsSync(config.uploadDir)) {
    fs.cpSync(config.uploadDir, path.join(dir, 'uploads'), { recursive: true });
    fileCount = fs.readdirSync(path.join(dir, 'uploads')).length;
  }
  const manifest = { createdAt: new Date().toISOString(), version: config.version, database: db.databaseName, collections: counts, files: fileCount };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function readLines(file) {
  const out = [];
  let buf = '';
  for await (const chunk of fs.createReadStream(file).pipe(zlib.createGunzip())) {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line) out.push(EJSON.parse(line, { relaxed: false })); }
  }
  if (buf.trim()) out.push(EJSON.parse(buf, { relaxed: false }));
  return out;
}

/** Checks a backup folder is whole: the manifest is there and every collection file holds the number of documents the manifest says. */
export async function verifyBackup(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const problems = [];
  for (const [name, n] of Object.entries(m.collections)) {
    const f = path.join(dir, `${name}.jsonl.gz`);
    if (!fs.existsSync(f)) { problems.push(`${name}: file missing`); continue; }
    const got = (await readLines(f)).length;
    if (got !== n) problems.push(`${name}: manifest says ${n}, file has ${got}`);
  }
  return { manifest: m, ok: problems.length === 0, problems };
}

/**
 * Loads a backup into the connected database. It refuses to touch a database that already holds data unless `replace` is set (then each collection
 * in the backup is emptied first). Indexes are rebuilt afterwards. Returns the counts restored.
 */
export async function restoreDatabase(dir, { replace = false, files = false } = {}) {
  const check = await verifyBackup(dir);
  if (!check.ok) throw new Error(`The backup is not complete: ${check.problems.join('; ')}`);
  const db = mongoose.connection.db;
  const existing = [];
  for (const name of Object.keys(check.manifest.collections)) if (await db.collection(name).countDocuments({}, { limit: 1 })) existing.push(name);
  if (existing.length && !replace) throw new Error(`The database already has data (${existing.slice(0, 5).join(', ')}…). Restore into an empty database, or pass replace to overwrite those collections.`);
  const restored = {};
  for (const name of Object.keys(check.manifest.collections)) {
    const docs = await readLines(path.join(dir, `${name}.jsonl.gz`));
    if (replace) await db.collection(name).deleteMany({});
    for (let i = 0; i < docs.length; i += BATCH) await db.collection(name).insertMany(docs.slice(i, i + BATCH), { ordered: false });
    restored[name] = docs.length;
  }
  if (files && fs.existsSync(path.join(dir, 'uploads'))) fs.cpSync(path.join(dir, 'uploads'), config.uploadDir, { recursive: true });
  await mongoose.syncIndexes();
  return restored;
}
