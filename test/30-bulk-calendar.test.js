import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { CalendarEvent } from '../src/models/index.js';

describe('Bulk student change and government holidays', () => {
  let root; let W;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'bulk'); });
  afterAll(teardown);

  it('one change for many students: house, or a move to another section; each student succeeds or fails on its own', async () => {
    const ids = W.students.map((s) => s.student._id);
    // a student can be put only in a house the school has made
    expect((await api().post('/api/school/students/bulk').set(W.h).send({ action: 'house', studentIds: ids, house: 'Blue' })).status).toBe(400);
    await api().post('/api/school/houses').set(W.h).send({ name: 'Blue' });
    const h = await api().post('/api/school/students/bulk').set(W.h).send({ action: 'house', studentIds: ids, house: 'Blue' });
    expect(h.body).toMatchObject({ requested: 3, done: 3, failed: [] });
    expect((await api().get(`/api/school/students/${ids[0]}`).set(W.h)).body.house).toBe('Blue');
    const mv = await api().post('/api/school/students/bulk').set(W.h).send({ action: 'transfer', studentIds: [...ids, '64b000000000000000000000'], toSectionId: W.sec8B._id, reason: 'Re-balancing the sections' });
    expect(mv.body.done).toBe(3); expect(mv.body.failed).toEqual([expect.objectContaining({ error: 'Student not found' })]);
    const again = await api().post('/api/school/students/bulk').set(W.h).send({ action: 'transfer', studentIds: [ids[0]], toSectionId: W.sec8B._id, reason: 'Again' });
    expect(again.body).toMatchObject({ done: 0 }); expect(again.body.failed[0].error).toMatch(/already in that section/i);
    expect((await api().post('/api/school/students/bulk').set(W.h).send({ action: 'transfer', studentIds: ids, toSectionId: W.sec8B._id })).status).toBe(400); // a reason is required
    expect((await api().post('/api/school/students/bulk').set(W.teacher1.h).send({ action: 'house', studentIds: ids, house: 'Red' })).status).toBe(403);
  });

  it('national holidays with fixed dates are added once and shown to students; moving festivals are left to the school', async () => {
    const r = await api().post('/api/school/events/government-holidays').set(W.h).send({});
    expect(r.status).toBe(200); expect(r.body.added).toBeGreaterThanOrEqual(4); // 2026-27: 14 Apr, 15 Aug, 2 Oct, 25 Dec, 26 Jan 2027
    const again = await api().post('/api/school/events/government-holidays').set(W.h).send({});
    expect(again.body.added).toBe(0);
    const titles = (await CalendarEvent.find({ tenantId: W.id, kind: 'government' }).lean()).map((e) => e.title);
    expect(titles).toEqual(expect.arrayContaining(['Independence Day', 'Gandhi Jayanti', 'Republic Day']));
    expect(titles).not.toContain('Diwali');
    const cal = (await api().get('/api/student/calendar?from=2026-08-01&to=2026-08-31').set(W.studentLogins[0].h)).body;
    const items = cal.items || cal;
    expect(items.find((x) => x.title === 'Independence Day')).toMatchObject({ type: 'holiday', kind: 'government' });
    // a government holiday blocks attendance like any holiday
    expect((await api().get(`/api/teacher/attendance/register?sectionId=${W.sec8A._id}&date=2026-08-15`).set(W.teacher1.h)).body.blocked).toMatch(/holiday|non_working|future/);
  });
});
