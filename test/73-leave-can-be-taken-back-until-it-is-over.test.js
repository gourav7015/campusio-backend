import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');

/** Approved leave can be taken back as long as its dates have not all gone: not begun = cancelled; running = ends yesterday; over = refused. */
describe('Taking leave back while its dates have not all gone', () => {
  let root; let W; let tr; let driver; let T;
  const TR = (p) => `/api/transport${p}`;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'lb'); T = W.teacher1.h;
    await api().put('/api/school/settings').set(W.h).send({ workingDays: [1, 2, 3, 4, 5, 6, 7] });
    const c = await api().post('/api/school/staff').set(W.h).send({ name: 'Tara Transport', email: 'tara@lb.test', role: 'transport', phone: '9833333333', dob: '1984-04-04' });
    tr = await login(c.body.loginId, c.body.temporaryPassword, 'transport');
    const des = (await api().get(TR('/designations')).set(tr.h)).body;
    driver = (await api().post(TR('/staff')).set(tr.h).send({ name: 'Ramesh Bhai', designationId: des.find((d) => d.name === 'Driver')._id, phone: '9876500001' })).body;
  }, 120000);
  afterAll(teardown);

  it('staff leave: running leave ends yesterday (days already taken stay); leave starting today is cancelled whole; leave that is over is refused', async () => {
    const running = (await api().post(TR('/leave')).set(tr.h).send({ staffId: driver._id, leaveType: 'casual', startDate: addDays(TODAY, -2), endDate: addDays(TODAY, 3), reason: 'Family matter' })).body;
    expect(running).toMatchObject({ status: 'approved', days: 6 });
    const out = await api().post(TR(`/leave/${running._id}/withdraw`)).set(tr.h);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ status: 'approved', startDate: addDays(TODAY, -2), endDate: addDays(TODAY, -1), days: 2 }); // ended early, still approved for the days gone
    expect(out.body.withdrawnAt).toBeTruthy();
    expect((await api().post(TR(`/leave/${running._id}/withdraw`)).set(tr.h)).status).toBe(409); // now over
    const today = (await api().post(TR('/leave')).set(tr.h).send({ staffId: driver._id, leaveType: 'casual', startDate: TODAY, endDate: addDays(TODAY, 2), reason: 'Starts today' })).body;
    expect((await api().post(TR(`/leave/${today._id}/withdraw`)).set(tr.h)).body.status).toBe('cancelled');
    const gone = (await api().post(TR('/leave')).set(tr.h).send({ staffId: driver._id, leaveType: 'casual', startDate: addDays(TODAY, -5), endDate: addDays(TODAY, -3), reason: 'Over' })).body;
    expect((await api().post(TR(`/leave/${gone._id}/withdraw`)).set(tr.h)).status).toBe(409);
  });

  it('teacher leave: the teacher, and the office, can end a running leave early or cancel one that has not begun', async () => {
    const mk = async (s, e, who = T) => { const l = (await api().post('/api/teacher/leave').set(who).send({ leaveType: 'casual', startDate: s, endDate: e, reason: 'Family function' })).body; await api().post(`/api/school/leave/${l._id}/decide`).set(W.h).send({ decision: 'approve' }); return l; };
    const a = await mk(addDays(TODAY, -3), addDays(TODAY, 1));
    const mine = await api().post(`/api/teacher/leave/${a._id}/withdraw`).set(T);
    expect(mine.status).toBe(200); expect(mine.body).toMatchObject({ status: 'approved', endDate: addDays(TODAY, -1), days: 3 });
    const b = await mk(addDays(TODAY, -1), addDays(TODAY, 4), W.teacher2.h); // another teacher: one person cannot have two leaves on the same days
    const office = await api().post(`/api/school/leave/${b._id}/cancel`).set(W.h);
    expect(office.status).toBe(200); expect(office.body).toMatchObject({ how: 'end_early', status: 'approved', endDate: addDays(TODAY, -1) });
    const c = await mk(addDays(TODAY, 6), addDays(TODAY, 7));
    expect((await api().post(`/api/school/leave/${c._id}/cancel`).set(W.h)).body).toMatchObject({ how: 'cancel', status: 'cancelled' });
    expect((await api().post(`/api/school/leave/${c._id}/cancel`).set(W.h)).status).toBe(409); // already cancelled
    expect((await api().post(`/api/school/leave/${b._id}/cancel`).set(W.h)).status).toBe(409); // over now
    expect((await api().post(`/api/school/leave/${c._id}/cancel`).set(T)).status).toBe(403); // a teacher cannot use the office's door
  });
});
