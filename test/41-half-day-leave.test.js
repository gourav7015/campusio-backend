import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');
const workingDay = (back) => { let d = addDays(TODAY, -back); while (new Date(`${d}T00:00:00Z`).getUTCDay() === 0) d = addDays(d, -1); return d; };
const A = (p) => `/api/school${p}`;

describe('Half-day leave', () => {
  let root; let W; let clerk;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'hl');
    const des = (await api().get(A('/designations')).set(W.h)).body;
    clerk = (await api().post(A('/support-staff')).set(W.h).send({ name: 'Chhaya Clerk', designationId: des.find((d) => d.name === 'Office Clerk')._id, phone: '9000000001', email: 'clerk@fixture.test', dob: '1984-04-04' })).body;
  });
  afterAll(teardown);

  it('a teacher takes half a day: it is one date, counts 0.5, and is taken from the balance once approved', async () => {
    const d = workingDay(2);
    const bad = await api().post('/api/teacher/leave').set(W.teacher1.h).send({ leaveType: 'casual', startDate: d, endDate: addDays(d, 1), reason: 'Two dates', halfDay: true });
    expect(bad.status).toBe(400);
    const ok = await api().post('/api/teacher/leave').set(W.teacher1.h).send({ leaveType: 'casual', startDate: d, endDate: d, reason: 'Doctor visit', halfDay: true, halfSession: 'second' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ days: 0.5, halfDay: true, halfSession: 'second' });
    expect((await api().post(A(`/leave/${ok.body._id}/decide`)).set(W.h).send({ decision: 'approve' })).status).toBe(200);
    const bal = (await api().get('/api/teacher/leave').set(W.teacher1.h)).body.balances.casual;
    expect(bal).toMatchObject({ used: 0.5, remaining: 11.5 });
    // a second half-day on the same date overlaps
    expect((await api().post('/api/teacher/leave').set(W.teacher1.h).send({ leaveType: 'sick', startDate: d, endDate: d, reason: 'Again', halfDay: true })).status).toBe(409);
  });

  it('the admin can change a full day into a half day, and back', async () => {
    const d = workingDay(5);
    const l = (await api().post('/api/teacher/leave').set(W.teacher1.h).send({ leaveType: 'sick', startDate: d, endDate: d, reason: 'Fever' })).body;
    expect(l.days).toBe(1);
    const half = await api().patch(A(`/leave/${l._id}`)).set(W.h).send({ halfDay: true, halfSession: 'first' });
    expect(half.status).toBe(200);
    expect(half.body).toMatchObject({ days: 0.5, halfDay: true, halfSession: 'first' });
    const full = await api().patch(A(`/leave/${l._id}`)).set(W.h).send({ halfDay: false });
    expect(full.body).toMatchObject({ days: 1, halfDay: false });
  });

  it('staff: the desk records a half day; the attendance register shows a half day for the half they attend', async () => {
    const d = workingDay(3);
    const rec = await api().post(A('/staff-leave')).set(W.h).send({ staffId: clerk._id, leaveType: 'casual', startDate: d, endDate: d, reason: 'Bank work', halfDay: true, halfSession: 'first' });
    expect(rec.status).toBe(201);
    expect(rec.body).toMatchObject({ days: 0.5, halfDay: true, status: 'approved' });
    const reg = (await api().get(A(`/staff-attendance/register?group=general&date=${d}`)).set(W.h)).body;
    const row = reg.rows.find((r) => r.name === 'Chhaya Clerk');
    // away in the first half, so present in the second
    expect(row).toMatchObject({ status: 'half_day', halfSession: 'second' });
    expect(row.remark).toContain('half-day');
    const bal = (await api().get(A('/leave-balances?group=general')).set(W.h)).body.rows[0].balances.casual;
    expect(bal.used).toBe(0.5);
  });

  it('a half day needs a working day', async () => {
    let sun = TODAY; while (new Date(`${sun}T00:00:00Z`).getUTCDay() !== 0) sun = addDays(sun, 1);
    expect((await api().post('/api/teacher/leave').set(W.teacher2.h).send({ leaveType: 'casual', startDate: sun, endDate: sun, reason: 'Sunday', halfDay: true })).status).toBe(400);
  });

  it('a teacher is told whether the school takes attendance period by period (the menu follows it)', async () => {
    expect((await api().get('/api/auth/me').set(W.teacher1.h)).body.user.periodWise).toBe(false);
    expect((await api().put(`/api/platform/schools/${W.id}/attendance-mode`).set(root.h).send({ periodWise: true, from: TODAY })).status).toBe(200);
    expect((await api().get('/api/auth/me').set(W.teacher1.h)).body.user.periodWise).toBe(true);
  });
});
