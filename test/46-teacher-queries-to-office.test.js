import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';

describe('Teachers write to the office; the office desk and the admin answer', () => {
  let root; let W; let desk;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'qo');
    const des = (await api().get('/api/school/designations').set(W.h)).body;
    const clerk = (await api().post('/api/school/support-staff').set(W.h).send({ name: 'Chhaya Clerk', designationId: des.find((d) => d.name === 'Office Clerk')._id, canMarkAttendance: true })).body;
    const c = await api().post(`/api/school/support-staff/${clerk._id}/login`).set(W.h);
    desk = await login(c.body.loginId, c.body.temporaryPassword, 'staff');
  });
  afterAll(teardown);

  it('a teacher raises a query, the desk sees it and answers, the teacher reads the answer', async () => {
    const t = await api().post('/api/teacher/queries').set(W.teacher1.h).send({ subject: 'My attendance on 12 Nov', body: 'I was present but I am marked absent.', category: 'general' });
    expect(t.status).toBe(201); expect(t.body.scope).toBe('school');
    // the desk's inbox and the admin's inbox are the same queries
    const inbox = (await api().get('/api/staff/queries').set(desk.h)).body;
    expect(JSON.stringify(inbox)).toContain('My attendance on 12 Nov');
    expect(JSON.stringify((await api().get('/api/school/queries').set(W.h)).body)).toContain('My attendance on 12 Nov');
    expect((await api().get('/api/staff/dashboard').set(desk.h)).body.openQueries).toBe(1);
    const reply = await api().post(`/api/staff/queries/${t.body._id}/replies`).set(desk.h).send({ body: 'Corrected, sorry about that.' });
    expect(reply.status).toBe(201);
    const mine = (await api().get(`/api/teacher/queries/${t.body._id}`).set(W.teacher1.h)).body;
    expect(JSON.stringify(mine)).toContain('Corrected, sorry about that.');
    // the desk was told when it came in; the teacher was told of the answer
    expect(JSON.stringify((await api().get('/api/teacher/notifications').set(W.teacher1.h)).body)).toContain('My attendance on 12 Nov');
    // other teachers do not see it, and students have no such page
    expect((await api().get('/api/teacher/queries').set(W.teacher2.h)).body.items ?? (await api().get('/api/teacher/queries').set(W.teacher2.h)).body).toEqual(expect.not.arrayContaining([expect.objectContaining({ _id: t.body._id })]));
    expect((await api().get('/api/student/queries').set(W.studentLogins[0].h)).status).toBe(404);
    expect((await api().get('/api/staff/queries').set(W.teacher1.h)).status).toBe(403);
  });
});
