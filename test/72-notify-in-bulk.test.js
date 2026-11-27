import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, makeSuperAdmin, seedWorld } from './helpers.js';
import { Notification } from '../src/models/index.js';
import { notifyUsers } from '../src/services/notify.js';

describe('Notifications go out in batches, and a repeat for the same event tells nobody twice', () => {
  let W; let ids;
  beforeAll(async () => { await setup(); await reset(); const root = await makeSuperAdmin(); W = await seedWorld(root, 'nb'); ids = W.students.map((s) => s.student.userId).concat(W.t1.teacher.userId); }, 120000);
  afterAll(teardown);
  it('tells everyone once and counts only the new ones on a repeat', async () => {
    const n = await notifyUsers(W.id, ids, { category: 'attendance', title: 'Hello', body: 'First', dedupeKey: 'bulk:1' });
    expect(n).toBe(ids.length);
    expect(await Notification.countDocuments({ tenantId: W.id, dedupeKey: 'bulk:1' })).toBe(ids.length);
    expect(await notifyUsers(W.id, ids, { category: 'attendance', title: 'Hello', body: 'First', dedupeKey: 'bulk:1' })).toBe(0);
    // a mix of people already told and people not yet told: only the new person is counted
    expect(await notifyUsers(W.id, [...ids, W.t2.teacher.userId], { category: 'attendance', title: 'Hello', body: 'First', dedupeKey: 'bulk:1' })).toBe(1);
    expect(await Notification.countDocuments({ tenantId: W.id, dedupeKey: 'bulk:1' })).toBe(ids.length + 1);
  });
  it('a large school is told in one go (seven hundred people)', async () => {
    const many = Array.from({ length: 700 }, () => W.students[0].student.userId); // the same person repeated counts once
    expect(await notifyUsers(W.id, many, { category: 'attendance', title: 'Big', body: 'x', dedupeKey: 'bulk:2' })).toBe(1);
  });
});
