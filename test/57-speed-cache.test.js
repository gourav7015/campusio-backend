import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { config } from '../src/core/config.js';
import { forgetMemo } from '../src/core/memo.js';
import { User } from '../src/models/index.js';

describe('Speed: the school, subscription and academic year are read from memory for a few seconds, but a change shows at once', () => {
  let root; let W; let finds = [];
  const count = (coll) => finds.filter((c) => c === coll).length;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'spd');
    config.memoSeconds = 20; forgetMemo();
    mongoose.set('debug', (coll, method) => { if (method === 'findOne' || method === 'find') finds.push(coll); });
  });
  afterAll(async () => { mongoose.set('debug', false); config.memoSeconds = 0; forgetMemo(); await teardown(); });
  const hit = () => api().get('/api/school/classes').set(W.h);
  const years = async () => { const b = (await api().get('/api/school/years').set(W.h)).body; return b.items || b; };

  it('the second request does not read the school, subscription or year again', async () => {
    finds = []; expect((await hit()).status).toBe(200);
    expect(count('schools')).toBeGreaterThanOrEqual(1);
    finds = []; expect((await hit()).status).toBe(200);
    expect({ schools: count('schools'), subs: count('subscriptions'), years: count('academicyears') }).toEqual({ schools: 0, subs: 0, years: 0 });
  });

  it('a disabled account is cut off at once: the account itself is never cached', async () => {
    const dash = () => api().get('/api/teacher/dashboard').set(W.teacher1.h);
    expect((await dash()).status).toBe(200);
    expect((await dash()).status).toBe(200); // warm
    await User.updateOne({ loginId: W.t1.credentials.loginId.toLowerCase() }, { status: 'disabled' }); // a write that does not touch the school or year records, so nothing clears the cache
    expect((await dash()).status).toBe(401);
  });

  it('a new current academic year is used on the very next request', async () => {
    expect((await years()).find((y) => y.isCurrent).name).toBe('2026-2027');
    const next = await api().post('/api/school/years').set(W.h).send({ name: '2027-2028', startDate: '2027-04-01', endDate: '2028-03-31', isCurrent: true });
    expect(next.status).toBe(201);
    expect((await years()).find((y) => y.isCurrent).name).toBe('2027-2028');
  });

  it('suspending the school takes effect on the very next request', async () => {
    expect((await hit()).status).toBe(200);
    expect((await api().patch(`/api/platform/schools/${W.id}`).set(root.h).send({ status: 'suspended' })).status).toBe(200);
    expect((await hit()).status).toBeGreaterThanOrEqual(401); // the sessions are ended too
  });
});
