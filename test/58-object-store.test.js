import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import mongoose from 'mongoose';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { File } from '../src/models/index.js';
import { config } from '../src/core/config.js';
import { resetObjectStore } from '../src/services/objectStore.js';
import { migrateFiles } from '../src/scripts/files-migrate.js';
import { storeBytes } from '../src/services/files.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const bin = (res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };

/** A small S3-style store in memory: signed PUT / GET / HEAD / DELETE on /<bucket>/<key>. It refuses requests that are not signed with the right access key. */
function fakeStore(bucket, accessKeyId) {
  const objects = new Map(); const seen = [];
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('AWS4-HMAC-SHA256') || !auth.includes(`Credential=${accessKeyId}/`)) { res.statusCode = 403; return res.end('denied'); }
    const key = decodeURIComponent(req.url.split('?')[0]).replace(`/${bucket}/`, '');
    seen.push(`${req.method} ${key}`);
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'PUT') { objects.set(key, { body: Buffer.concat(chunks), type: req.headers['content-type'] }); res.statusCode = 200; return res.end(); }
      const o = objects.get(key);
      if (req.method === 'DELETE') { objects.delete(key); res.statusCode = 204; return res.end(); }
      if (!o) { res.statusCode = 404; return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
      res.setHeader('content-length', o.body.length); res.setHeader('content-type', o.type || 'application/octet-stream');
      res.statusCode = 200; return res.end(req.method === 'HEAD' ? undefined : o.body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ objects, seen, close: () => new Promise((r) => server.close(r)), endpoint: `http://127.0.0.1:${server.address().port}` })));
}

describe('Files can live in a private R2 bucket instead of the database', () => {
  let root; let W; let store; const saved = { ...config.objectStore };
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'r2');
    store = await fakeStore('school-files', 'KEYID');
  });
  afterAll(async () => { config.objectStore = saved; resetObjectStore(); await store.close(); await teardown(); });
  const on = () => { config.objectStore = { endpoint: store.endpoint, bucket: 'school-files', accessKeyId: 'KEYID', secretAccessKey: 'SECRET', enabled: true }; resetObjectStore(); };
  const off = () => { config.objectStore = { ...saved, enabled: false }; resetObjectStore(); };
  const gallery = () => api().post('/api/school/school-info/gallery').set(W.h).field('caption', 'x').attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
  const download = async (id, h = W.h) => { const link = (await api().post(`/api/shared/files/${id}/link`).set(h)).body.url; return api().get(link).buffer(true).parse(bin); };

  it('with R2 set up, a new upload goes to the bucket (not the database) and downloads through the app after the access check', async () => {
    on();
    const g = await gallery(); expect(g.status).toBe(201);
    const f = await File.findById(g.body.fileId);
    expect(f).toMatchObject({ store: 'r2' }); expect(f.objectKey).toMatch(/^t\/[a-f0-9]{24}\/[0-9a-f-]{36}$/); expect(f.gridId).toBeUndefined();
    expect(store.objects.get(f.objectKey).body.equals(PNG)).toBe(true);
    expect(await mongoose.connection.db.collection('files.files').countDocuments({ filename: 'a.png' })).toBe(0);
    const dl = await download(f._id);
    expect(dl.status).toBe(200); expect(dl.headers['content-type']).toBe('image/png'); expect(dl.body.equals(PNG)).toBe(true);
    // the bucket is private: nobody gets a file without the app's permission check
    expect((await api().post(`/api/shared/files/${f._id}/link`)).status).toBe(401);
  });

  it('the store is told who is calling: unsigned or wrongly signed requests are refused', async () => {
    config.objectStore = { endpoint: store.endpoint, bucket: 'school-files', accessKeyId: 'WRONG', secretAccessKey: 'SECRET', enabled: true }; resetObjectStore();
    await expect(storeBytes(PNG, { name: 'x.png', mime: 'image/png', tenantId: W.id })).rejects.toThrow(/upload failed \(403\)/);
    on();
  });

  it('deleting the picture deletes the stored object; a missing object says so plainly', async () => {
    const g = (await gallery()).body; const f = await File.findById(g.fileId);
    expect(store.objects.has(f.objectKey)).toBe(true);
    expect((await api().delete(`/api/school/school-info/gallery/${g._id}`).set(W.h)).status).toBe(200);
    expect(store.objects.has(f.objectKey)).toBe(false);
    const g2 = (await gallery()).body; const f2 = await File.findById(g2.fileId);
    store.objects.delete(f2.objectKey); // the object vanishes from the bucket
    expect((await download(f2._id)).status).toBe(404);
  });

  it('files stored encrypted stay encrypted in the bucket and still open', async () => {
    config.encryptFiles = true;
    try {
      const g = (await gallery()).body; const f = await File.findById(g.fileId);
      expect(f.enc).toBe(true);
      expect(store.objects.get(f.objectKey).body.equals(PNG)).toBe(false); // what is in the bucket is not the picture
      expect(store.objects.get(f.objectKey).body.includes(PNG)).toBe(false);
      expect((await download(f._id)).body.equals(PNG)).toBe(true);
    } finally { config.encryptFiles = false; }
  });

  it('the migration moves files already in the database to R2, then removes the database copy; a dry run changes nothing', async () => {
    off();
    const g = (await gallery()).body; const f = await File.findById(g.fileId);
    expect(f.store).toBe('gridfs'); const grid = f.gridId;
    on();
    const dry = await migrateFiles({ dryRun: true, toObjectStore: true }); expect(dry.moved).toBeGreaterThanOrEqual(1);
    expect((await File.findById(f._id)).store).toBe('gridfs');
    const r = await migrateFiles({ toObjectStore: true }); expect(r.moved).toBeGreaterThanOrEqual(1); expect(r.missing).toEqual([]);
    const after = await File.findById(f._id);
    expect(after.store).toBe('r2'); expect(after.gridId).toBeUndefined(); expect(store.objects.get(after.objectKey).body.equals(PNG)).toBe(true);
    expect(await mongoose.connection.db.collection('files.files').countDocuments({ _id: grid })).toBe(0); // the database copy is gone
    expect((await download(f._id)).body.equals(PNG)).toBe(true);
    // without R2 set up, moving to R2 is refused with a plain message
    off(); await expect(migrateFiles({ toObjectStore: true })).rejects.toThrow(/R2 is not set up/);
  });

  it('with R2 off again, files already in the bucket are still reachable only when it is on; new uploads go back to the database', async () => {
    off(); const g = await gallery(); expect((await File.findById(g.body.fileId)).store).toBe('gridfs');
  });
});
