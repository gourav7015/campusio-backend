import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { File } from '../src/models/index.js';
import { config } from '../src/core/config.js';
import { migrateFiles } from '../src/scripts/files-migrate.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const bin = (res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };

describe('Files live in the database, so every server (and every deploy) sees the same pictures and documents', () => {
  let root; let W;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'fil'); });
  afterAll(teardown);
  const gallery = () => api().post('/api/school/school-info/gallery').set(W.h).field('caption', 'Main building').attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
  const download = async (id, h = W.h) => { const link = (await api().post(`/api/shared/files/${id}/link`).set(h)).body.url; return api().get(link).buffer(true).parse(bin); };

  it('a new upload is kept in GridFS, leaves nothing in the uploads folder, and downloads', async () => {
    const before = fs.readdirSync(config.uploadDir).length;
    const g = await gallery(); expect(g.status).toBe(201);
    const f = await File.findById(g.body.fileId);
    expect(f.store).toBe('gridfs'); expect(f.gridId).toBeTruthy();
    expect(fs.readdirSync(config.uploadDir).length).toBe(before); // the temporary upload was removed
    expect(await mongoose.connection.db.collection('files.files').countDocuments({ _id: f.gridId })).toBe(1);
    const dl = await download(f._id);
    expect(dl.status).toBe(200); expect(dl.headers['content-type']).toBe('image/png'); expect(dl.body.equals(PNG)).toBe(true);
  });

  it('removing the picture removes its stored bytes', async () => {
    const g = (await gallery()).body; const f = await File.findById(g.fileId);
    expect((await api().delete(`/api/school/school-info/gallery/${g._id}`).set(W.h)).status).toBe(200);
    expect(await mongoose.connection.db.collection('files.files').countDocuments({ _id: f.gridId })).toBe(0);
    expect(await mongoose.connection.db.collection('files.chunks').countDocuments({ files_id: f.gridId })).toBe(0);
  });

  it('a file that is gone says so plainly, and an older file on disk still opens', async () => {
    const g = (await gallery()).body; const f = await File.findById(g.fileId);
    await mongoose.connection.db.collection('files.files').deleteOne({ _id: f.gridId }); await mongoose.connection.db.collection('files.chunks').deleteMany({ files_id: f.gridId });
    const gone = await download(f._id); expect(gone.status).toBe(404);
    // a file stored the old way (on this server's disk)
    const key = 'legacy-test-file'; fs.writeFileSync(path.join(config.uploadDir, key), PNG);
    const old = await File.create({ tenantId: W.id, originalName: 'old.png', mime: 'image/png', size: PNG.length, storageKey: key, kind: 'photo', ownerType: 'school', ownerId: String(W.id), visibility: 'school', uploadedBy: (await File.findOne())?.uploadedBy });
    const dl = await download(old._id); expect(dl.status).toBe(200); expect(dl.body.equals(PNG)).toBe(true);
    // the migration moves it into the database; a file whose bytes are not here is reported and left alone
    const ghost = await File.create({ tenantId: W.id, originalName: 'ghost.png', mime: 'image/png', size: 1, storageKey: 'not-on-this-computer', kind: 'photo', ownerType: 'school', ownerId: String(W.id), visibility: 'school', uploadedBy: old.uploadedBy });
    const dry = await migrateFiles({ dryRun: true }); expect(dry.moved).toBe(1); expect((await File.findById(old._id)).store).toBe('disk');
    const real = await migrateFiles(); expect(real.moved).toBe(1); expect(real.missing.map((m) => m.name)).toContain('ghost.png');
    expect((await File.findById(old._id)).store).toBe('gridfs');
    fs.unlinkSync(path.join(config.uploadDir, key)); // the disk copy is no longer needed
    expect((await download(old._id)).body.equals(PNG)).toBe(true);
    expect((await File.findById(ghost._id)).store).toBe('disk');
  });
});
