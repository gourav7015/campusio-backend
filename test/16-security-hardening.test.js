import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { findOperatorKey } from '../src/middleware/sanitize.js';
import { needsRehash, hashPassword } from '../src/services/users.js';
import { AuditLog } from '../src/models/index.js';

const run = promisify(execFile);
const boot = (env) => run(process.execPath, ['--input-type=module', '-e', "await import('./src/core/config.js'); console.log('started')"], { cwd: process.cwd(), env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: '/nonexistent/.env', ...env } }).then((r) => ({ ok: true, out: r.stdout }), (e) => ({ ok: false, out: String(e.stderr) }));

describe('production configuration is refused when unsafe', () => {
  const good = { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(48), CORS_ORIGIN: 'https://erp.example.org', DATA_KEY: 'ab'.repeat(32) };
  it('starts with a strong secret and a real origin', async () => { expect((await boot(good)).ok).toBe(true); });
  it('refuses a malformed data key, and starts without one (it is then derived, with a warning on the health page)', async () => {
    expect((await boot({ ...good, DATA_KEY: 'not-hex' })).ok).toBe(false);
    expect((await boot({ ...good, DATA_KEY: undefined })).ok).toBe(true);
  });
  it('refuses a missing, short or published-default JWT secret', async () => {
    for (const JWT_SECRET of [undefined, 'short', 'change-me-to-a-long-random-string', 'dev-only-secret-change-me']) {
      const r = await boot({ ...good, JWT_SECRET }); expect(r.ok, String(JWT_SECRET)).toBe(false); expect(r.out).toMatch(/JWT_SECRET/);
    }
  });
  it('refuses localhost or wildcard CORS in production', async () => {
    for (const CORS_ORIGIN of [undefined, 'http://localhost:5173', '*']) expect((await boot({ ...good, CORS_ORIGIN })).ok, String(CORS_ORIGIN)).toBe(false);
  });
});

describe('request hardening', () => {
  let root; let W;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'hrd'); });
  afterAll(teardown);

  it('finds operator and prototype keys at any depth', () => {
    expect(findOperatorKey({ a: { b: [{ $ne: 1 }] } })).toBe('a.b.0.$ne');
    expect(findOperatorKey(JSON.parse('{"__proto__":{"x":1}}'))).toBe('__proto__');
    expect(findOperatorKey({ name: 'Rao', tags: ['a'] })).toBeNull();
  });

  it('MongoDB operators in a query string or JSON body are refused before any handler runs', async () => {
    expect((await api().get('/api/school/students?q[$ne]=zzz').set(W.h)).status).toBe(400);
    expect((await api().get('/api/school/students?status[$in][]=active').set(W.h)).status).toBe(400);
    expect((await api().post('/api/auth/login').send({ loginId: { $ne: '' }, password: { $ne: '' }, portal: 'admin' })).status).toBe(400);
    expect((await api().patch(`/api/school/students/${W.students[0].student._id}`).set(W.h).send({ name: { $set: 'x' } })).status).toBe(400);
  });

  it('API responses are never cacheable and carry security headers', async () => {
    const r = await api().get('/api/school/years').set(W.h);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['strict-transport-security']).toBeTruthy();
  });

  it('a duplicate error names the field, not the value', async () => {
    const dup = await api().post('/api/school/classes').set(W.h).send({ name: 'Class 8' });
    expect(dup.status).toBe(409);
    expect(JSON.stringify(dup.body)).not.toMatch(/[0-9a-f]{24}/);
  });

  it('server errors do not leak internals', async () => {
    const r = await api().get('/api/school/students/not-an-id').set(W.h);
    expect([400, 404]).toContain(r.status);
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.js|node_modules|mongoose/i);
  });

  it('unknown and known login ids give the same answer', async () => {
    const a = await api().post('/api/auth/login').send({ loginId: 'nobody@nowhere', password: 'Whatever123', portal: 'admin' });
    const b = await api().post('/api/auth/login').send({ loginId: W.adminLoginId || 'hrd-admin', password: 'Whatever123', portal: 'admin' });
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.body.error).toBe(b.body.error);
  });

  it('a person cannot choose a short, common or login-containing password', async () => {
    const t = W.teacher1;
    const change = (newPassword) => api().post('/api/auth/change-password').set(t.h).send({ currentPassword: t.password || t.temporaryPassword, newPassword });
    for (const weak of ['Short1a', 'Teach@12345', 'Password123', 'a'.repeat(80) + '1']) expect((await change(weak)).status, weak).toBe(400);
  });

  it('uploads: the content must match the declared type, and risky types download instead of opening', async () => {
    const hw = (await api().post('/api/teacher/homework').set(W.teacher1.h).send({ title: 'Upload check', sectionId: W.sec8A._id, subjectId: W.maths._id, dueDate: '2099-01-01', status: 'published' })).body;
    const up = (name, type, bytes) => api().post(`/api/teacher/homework/${hw._id}/attachments`).set(W.teacher1.h).attach('file', Buffer.from(bytes), { filename: name, contentType: type });
    expect((await up('fake.pdf', 'application/pdf', '<html><script>alert(1)</script></html>')).status).toBe(400);
    expect((await up('fake.png', 'image/png', 'not really a png')).status).toBe(400);
    expect((await up('bin.txt', 'text/plain', Buffer.from([0x68, 0x00, 0x69]))).status).toBe(400);
    expect((await up('ok.pdf', 'application/pdf', '%PDF-1.4 real enough')).status).toBe(201);
  });
});

describe('accountability and password upgrades', () => {
  let root; let W;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'acc'); });
  afterAll(teardown);

  it('a platform administrator entering a school is recorded once per half hour, even for reads', async () => {
    const h = { ...root.h, 'X-Acting-School': W.id };
    await api().get('/api/school/students').set(h);
    await api().get('/api/school/teachers').set(h);
    const entries = await AuditLog.find({ tenantId: W.id, action: 'platform.acting' }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0].actingAsSuperAdmin).toBe(true);
    const seen = (await api().get('/api/school/audit?action=platform.acting').set(W.h)).body;
    expect(seen.length).toBe(1); // the school's own administrator can see it
  });

  it('a hash made with a lower cost is flagged for upgrade; a current one is not', async () => {
    const old = await hashPassword('Some-Passw0rd');
    expect(needsRehash(old, 4)).toBe(false);
    expect(needsRehash(old, 12)).toBe(true);
    expect(needsRehash('not-a-hash', 12)).toBe(false);
  });
});
