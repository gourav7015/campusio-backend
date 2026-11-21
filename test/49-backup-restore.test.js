import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { setup, teardown, reset, makeSuperAdmin, seedWorld } from './helpers.js';
import { Student, School, Payment } from '../src/models/index.js';
import { backupDatabase, verifyBackup, restoreDatabase } from '../src/scripts/backup.js';

describe('Backup and restore: a whole school can be saved, checked and brought back exactly', () => {
  let root; let W; let dir; let before;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'bak'); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-')); });
  afterAll(teardown);

  it('backs up every collection with counts and a manifest, and verifies it', async () => {
    before = { students: await Student.countDocuments(), schools: await School.countDocuments() };
    expect(before.students).toBeGreaterThan(0);
    const m = await backupDatabase(dir);
    expect(m.collections.students).toBe(before.students); expect(m.collections.schools).toBe(before.schools);
    expect(fs.existsSync(path.join(dir, 'students.jsonl.gz'))).toBe(true);
    const v = await verifyBackup(dir); expect(v.ok).toBe(true);
  });

  it('a damaged backup is caught before anything is restored', async () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-bad-')); fs.cpSync(dir, copy, { recursive: true });
    fs.unlinkSync(path.join(copy, 'students.jsonl.gz'));
    expect((await verifyBackup(copy)).problems.join()).toMatch(/students: file missing/);
    await expect(restoreDatabase(copy, { replace: true })).rejects.toThrow(/not complete/);
  });

  it('refuses to restore over data, and with replace brings back exact values (dates, ids)', async () => {
    await expect(restoreDatabase(dir)).rejects.toThrow(/already has data/);
    const one = await Student.findOne().lean();
    await Student.deleteMany({}); await Payment.deleteMany({});
    expect(await Student.countDocuments()).toBe(0);
    const r = await restoreDatabase(dir, { replace: true });
    expect(r.students).toBe(before.students);
    const again = await Student.findById(one._id).lean();
    expect(String(again._id)).toBe(String(one._id)); expect(again.name).toBe(one.name); expect(String(again.tenantId)).toBe(String(one.tenantId));
    expect(+new Date(again.createdAt)).toBe(+new Date(one.createdAt));
  });

  it('restores into an empty database', async () => {
    const cols = await mongoose.connection.db.collections(); await Promise.all(cols.map((c) => c.deleteMany({})));
    const r = await restoreDatabase(dir);
    expect(r.students).toBe(before.students); expect(await School.countDocuments()).toBe(before.schools);
  });
});
