import path from 'node:path';
import mongoose from 'mongoose';
import { requireMongoUri, config } from '../core/config.js';
import { backupDatabase, verifyBackup, restoreDatabase } from './backup.js';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => rest.includes(`--${n}`);
const arg = rest.find((a) => !a.startsWith('--'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const help = `Usage:
  npm run backup -- [folder] [--files]        save the database (and with --files the uploaded files) to a folder (default backups/<date>)
  npm run backup:verify -- <folder>           check a backup is whole
  npm run backup:restore -- <folder> [--replace] [--files]   load a backup; refuses a database that already has data unless --replace`;

if (!['backup', 'verify', 'restore'].includes(cmd)) { console.log(help); process.exit(cmd ? 1 : 0); }
await mongoose.connect(requireMongoUri(), { serverSelectionTimeoutMS: 15000 });
try {
  if (cmd === 'backup') {
    const dir = path.resolve(arg || `backups/${stamp}`);
    const m = await backupDatabase(dir, { files: flag('files') });
    console.log(`Backed up ${Object.keys(m.collections).length} collections (${Object.values(m.collections).reduce((a, b) => a + b, 0)} documents${flag('files') ? `, ${m.files} files` : ''}) to ${dir}`);
    console.log(`Database was "${m.database}", app version ${config.version}. Keep this folder somewhere other than this computer.`);
  } else if (cmd === 'verify') {
    if (!arg) { console.log(help); process.exit(1); }
    const r = await verifyBackup(path.resolve(arg));
    console.log(r.ok ? `OK: backup of ${r.manifest.createdAt} is whole` : `PROBLEM:\n${r.problems.join('\n')}`); process.exitCode = r.ok ? 0 : 1;
  } else {
    if (!arg) { console.log(help); process.exit(1); }
    const r = await restoreDatabase(path.resolve(arg), { replace: flag('replace'), files: flag('files') });
    console.log(`Restored ${Object.keys(r).length} collections (${Object.values(r).reduce((a, b) => a + b, 0)} documents).`);
  }
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { await mongoose.disconnect(); }
