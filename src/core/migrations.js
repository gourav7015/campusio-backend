import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Migration } from '../models/index.js';
import { logger } from './logger.js';
import { takeLease } from '../services/jobs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../migrations');

/** Every migration file, oldest first. A file exports { id, description, up(): Promise }. Names start with a number (001-…), which sets the order. */
export async function listMigrations(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => /^\d+.*\.js$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    const m = await import(pathToFileURL(path.join(dir, f)).href);
    if (!m.id || typeof m.up !== 'function') throw new Error(`Migration ${f} must export id and up()`);
    out.push({ id: m.id, description: m.description || '', up: m.up, file: f });
  }
  const ids = out.map((m) => m.id);
  if (new Set(ids).size !== ids.length) throw new Error('Two migrations share an id');
  return out;
}

/** Runs every migration not yet recorded, oldest first, once. Only one server does it at a time. Returns the ids that ran. */
export async function runMigrations({ dir = MIGRATIONS_DIR } = {}) {
  const all = await listMigrations(dir);
  if (!all.length) return [];
  if (!(await takeLease('migrations', 5 * 60 * 1000))) { logger.info('migrations are being run by another server'); return []; }
  const done = new Set((await Migration.find({}, 'id').lean()).map((m) => m.id));
  const ran = [];
  for (const m of all) {
    if (done.has(m.id)) continue;
    logger.info('migration starting', { id: m.id, description: m.description });
    await m.up(); // a failure stops here: the migration is not recorded and the server will not start on a half-changed database
    await Migration.create({ id: m.id, description: m.description });
    ran.push(m.id);
  }
  return ran;
}
