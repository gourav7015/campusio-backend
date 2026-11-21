import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { ErrorLog, EmailOutbox, IdempotencyRecord, JobLease, Migration, House } from '../src/models/index.js';
import { takeLease } from '../src/services/jobs.js';
import { runMigrations } from '../src/core/migrations.js';
import { setMailTransport, enqueueEmail, flushEmails } from '../src/services/email.js';
import { flagOn, FLAGS } from '../src/services/flags.js';
import { requestTimeout } from '../src/core/http.js';
import { recordServerError } from '../src/services/errorLog.js';
import { config } from '../src/core/config.js';

describe('Platform hardening: versioned API, idempotent POSTs, error log, durable email, leases, migrations, switches', () => {
  let root; let W;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'hard'); });
  afterAll(teardown);

  it('health reports the version and memory; /api/v1 is the same API', async () => {
    const h = (await api().get('/health')).body;
    expect(h).toMatchObject({ status: 'ok', version: expect.stringMatching(/^\d+\.\d+\.\d+/) }); expect(h.memoryMb.rss).toBeGreaterThan(0);
    expect((await api().get('/api/v1/auth/me')).status).toBe(401); // same answer as /api/auth/me
    const v1 = await api().get('/api/v1/school/houses').set(W.h);
    expect(v1.status).toBe(200); expect(v1.headers['x-api-version']).toBe('1');
  });

  it('a POST repeated with the same Idempotency-Key is done once and gets the first answer back', async () => {
    const post = (body, key = 'key-aaaa-0001') => api().post('/api/school/houses').set(W.h).set('Idempotency-Key', key).send(body);
    const a = await post({ name: 'Once', color: '#dc2626' });
    expect(a.status).toBe(201);
    const b = await post({ name: 'Once', color: '#dc2626' });
    expect(b.status).toBe(201); expect(b.headers['idempotent-replay']).toBe('true'); expect(b.body._id).toBe(a.body._id);
    expect(await House.countDocuments({ tenantId: W.id, name: 'Once' })).toBe(1);
    // the same key for a different request is refused
    expect((await post({ name: 'Other' })).status).toBe(422);
    // a failed try can be retried under the same key
    const bad = await post({ name: 'x' }, 'key-aaaa-0002'); expect(bad.status).toBe(400);
    expect((await post({ name: 'Second', color: '#16a34a' }, 'key-aaaa-0002')).status).toBe(201);
    // someone else's token cannot replay it
    const other = await api().post('/api/school/houses').set(root.h).set('x-acting-school', W.id).set('Idempotency-Key', 'key-aaaa-0001').send({ name: 'Once', color: '#dc2626' });
    expect(other.headers['idempotent-replay']).toBeUndefined();
    expect((await post({ name: 'Short' }, 'k')).status).toBe(400); // too short a key
    expect(await IdempotencyRecord.countDocuments()).toBeGreaterThan(0);
  });

  it('server errors are kept for the Platform Admin; browsers can report crashes; nobody else reads them', async () => {
    await recordServerError({ id: 'req-1', method: 'GET', originalUrl: '/api/x?y=1', tenantId: null }, new Error('boom'));
    const rep = await api().post('/api/client-errors').send({ message: 'Cannot read properties of undefined', stack: 'at X', path: '/admin/students' });
    expect(rep.status).toBe(202);
    expect((await api().post('/api/client-errors').send({ message: 'x'.repeat(600) })).status).toBe(400);
    const list = (await api().get('/api/platform/errors').set(root.h)).body;
    expect(list.last24h).toEqual({ server: 1, client: 1 });
    expect(list.rows.map((r) => r.message)).toEqual(expect.arrayContaining(['boom', 'Cannot read properties of undefined']));
    expect((await api().get('/api/platform/errors').set(W.h)).status).toBe(403);
    expect((await api().delete('/api/platform/errors').set(root.h)).body.removed).toBe(2);
    expect(await ErrorLog.countDocuments()).toBe(0);
  });

  it('email waits in the database and is sent once; a failure is kept with its reason', async () => {
    const sent = [];
    setMailTransport(async (m) => { sent.push(m.to); if (m.to.startsWith('bad')) throw new Error('mailbox refused'); return { id: 1 }; });
    expect(enqueueEmail({ to: 'good@x.test', subject: 'Hello', html: '<p>hi</p>', text: 'hi' })).toBe(true);
    enqueueEmail({ to: 'bad@x.test', subject: 'Nope', html: '<p>no</p>', text: 'no' });
    await flushEmails();
    expect(sent.sort()).toEqual(['bad@x.test', 'good@x.test']);
    expect((await EmailOutbox.findOne({ to: 'good@x.test' })).status).toBe('sent');
    const failed = await EmailOutbox.findOne({ to: 'bad@x.test' });
    expect(failed.status).toBe('failed'); expect(failed.lastError).toMatch(/mailbox refused/);
    // a server that died mid-send leaves the mail "processing" with an old lease: the next server picks it up
    await EmailOutbox.create({ to: 'stuck@x.test', subject: 'Stuck', html: 'x', text: 'x', status: 'processing', leaseUntil: new Date(Date.now() - 1000), tries: 1 });
    await flushEmails(); enqueueEmail({ to: 'again@x.test', subject: 'Kick', html: 'x', text: 'x' }); await flushEmails();
    expect((await EmailOutbox.findOne({ to: 'stuck@x.test' })).status).toBe('sent');
    setMailTransport(null);
    expect(enqueueEmail({ to: 'none@x.test', subject: 's', html: 'x', text: 'x' })).toBe(false); // no mail setup: nothing queued
  });

  it('a scheduled job runs on one server at a time', async () => {
    expect(await takeLease('demo-job', 60000)).toBe(true);
    expect(await takeLease('demo-job', 60000)).toBe(false); // still held
    await JobLease.updateOne({ name: 'demo-job' }, { until: new Date(Date.now() - 1) });
    expect(await takeLease('demo-job', 60000)).toBe(true); // expired: free again
  });

  it('migrations run once, in order, and a failing one is not recorded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    const ran = path.join(dir, 'ran.log');
    const write = (name, id, body) => fs.writeFileSync(path.join(dir, name), `import fs from 'node:fs';\nexport const id = '${id}';\nexport const description = 'test';\nexport async function up() { ${body} }\n`);
    write('001-first.js', '001-first', `fs.appendFileSync(${JSON.stringify(ran)}, 'first\\n');`);
    write('002-second.js', '002-second', `fs.appendFileSync(${JSON.stringify(ran)}, 'second\\n');`);
    expect(await runMigrations({ dir })).toEqual(['001-first', '002-second']);
    await JobLease.deleteMany({});
    expect(await runMigrations({ dir })).toEqual([]); // nothing new
    write('003-broken.js', '003-broken', "throw new Error('cannot migrate');");
    await JobLease.deleteMany({});
    await expect(runMigrations({ dir })).rejects.toThrow(/cannot migrate/);
    expect(await Migration.exists({ id: '003-broken' })).toBeNull();
    expect(fs.readFileSync(ran, 'utf8')).toBe('first\nsecond\n');
  });

  it('feature switches: a default for everyone, an override for one school, unknown names refused', async () => {
    const school = (await api().get(`/api/platform/schools/${W.id}/flags`).set(root.h)).body;
    expect(school.find((f) => f.name === 'periodAttendance')).toMatchObject({ value: false, overridden: false });
    const set = await api().put(`/api/platform/schools/${W.id}/flags`).set(root.h).send({ periodAttendance: true, onlinePayments: false });
    expect(set.status).toBe(200);
    expect(set.body.find((f) => f.name === 'periodAttendance')).toMatchObject({ value: true, overridden: true });
    expect(flagOn({ flags: { onlinePayments: false } }, 'onlinePayments')).toBe(false);
    expect(flagOn({}, 'onlinePayments')).toBe(FLAGS.onlinePayments.default);
    expect(flagOn({}, 'nonsense')).toBe(false);
    const back = await api().put(`/api/platform/schools/${W.id}/flags`).set(root.h).send({ periodAttendance: null });
    expect(back.body.find((f) => f.name === 'periodAttendance').overridden).toBe(false);
    expect((await api().put(`/api/platform/schools/${W.id}/flags`).set(root.h).send({ nonsense: true })).status).toBe(400);
    expect((await api().put(`/api/platform/schools/${W.id}/flags`).set(W.h).send({ periodAttendance: true })).status).toBe(403);
  });

  it('a request that never answers is ended with a clear message', async () => {
    const a = express(); a.use(requestTimeout(60)); a.get('/slow', () => {}); a.get('/fast', (_q, r) => r.json({ ok: true }));
    const slow = await request(a).get('/slow'); expect(slow.status).toBe(503); expect(slow.body.code).toBe('TIMEOUT');
    expect((await request(a).get('/fast')).status).toBe(200);
  });

  it('after a secret rotation, tokens signed with the previous secret keep working', async () => {
    const old = config.jwtSecret;
    try {
      config.jwtSecretPrevious = old; config.jwtSecret = 'a-brand-new-secret-that-is-long-enough-123456';
      expect((await api().get('/api/auth/me').set(W.h)).status).toBe(200); // W.h was signed with the old secret
      config.jwtSecretPrevious = '';
      expect((await api().get('/api/auth/me').set(W.h)).status).toBe(401); // without the previous secret it no longer verifies
    } finally { config.jwtSecret = old; config.jwtSecretPrevious = ''; }
  });
});
