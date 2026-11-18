import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';

describe('Duplicates by capitalisation, urgent notices, notices to several classes at once', () => {
  let root; let W;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'nb'); });
  afterAll(teardown);

  it('a section "a" and a section "A" can never both exist: names are kept in capitals', async () => {
    const mk = (name, classId = W.c9._id) => api().post('/api/school/sections').set(W.h).send({ yearId: W.year._id, classId, name, capacity: 30 });
    const first = await mk('b');
    expect(first.status).toBe(201); expect(first.body.name).toBe('B'); // stored as typed in capitals
    const dup = await mk('B'); expect(dup.status).toBe(409); expect(JSON.stringify(dup.body)).toMatch(/already has a section B/);
    expect((await mk(' b ')).status).toBe(409);
    // renaming into an existing one is refused too, and a rename is capitalised
    const c = await mk('C'); expect(c.status).toBe(201);
    expect((await api().patch(`/api/school/sections/${c.body._id}`).set(W.h).send({ name: 'b' })).status).toBe(409);
    expect((await api().patch(`/api/school/sections/${c.body._id}`).set(W.h).send({ name: 'd' })).body.name).toBe('D');
    // the same letter in another class is fine
    expect((await mk('a', W.c9._id)).status).toBe(201); // Class 8 also has an A
  });

  it('"Urgent" is a notice category; students get a bell notification marked URGENT', async () => {
    const a = await api().post('/api/school/announcements').set(W.h).send({ title: 'Holiday tomorrow', category: 'urgent', audience: { all: true } });
    expect(a.status).toBe(201); expect(a.body.category).toBe('urgent');
    const n = (await api().get('/api/student/notifications').set(W.studentLogins[0].h)).body;
    expect((n.items || n).some((x) => /^URGENT: Holiday tomorrow/.test(x.title))).toBe(true);
    expect((await api().post('/api/school/announcements').set(W.h).send({ title: 'Bad category', category: 'whatever', audience: { all: true } })).status).toBe(400);
  });

  it('a teacher can send one notice to all of their classes, and only their own', async () => {
    const mine = (await api().get('/api/teacher/classes').set(W.teacher1.h)).body.map((c) => c.sectionId);
    expect(mine.length).toBeGreaterThan(0);
    const ok = await api().post('/api/teacher/announcements').set(W.teacher1.h).send({ title: 'Bring your textbooks', category: 'urgent', sectionIds: mine });
    expect(ok.status).toBe(201); expect(ok.body.audience.sectionIds).toHaveLength(mine.length);
    expect((await api().post('/api/teacher/announcements').set(W.teacher1.h).send({ title: 'Not mine', sectionIds: [...mine, String(W.sec8B._id)] })).status).toBe(403);
  });
});
