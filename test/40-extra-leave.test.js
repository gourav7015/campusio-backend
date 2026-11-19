import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');
const workingDay = (back) => { let d = addDays(TODAY, -back); while (new Date(`${d}T00:00:00Z`).getUTCDay() === 0) d = addDays(d, -1); return d; };
const A = (p) => `/api/school${p}`;

describe('Extra leave: the admin adds leave on top of the school allowance, for one person', () => {
  let root; let W; let clerk;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'xl');
    const des = (await api().get(A('/designations')).set(W.h)).body;
    clerk = (await api().post(A('/support-staff')).set(W.h).send({ name: 'Chhaya Clerk', designationId: des.find((d) => d.name === 'Office Clerk')._id, phone: '9000000001' })).body;
  });
  afterAll(teardown);

  it('a teacher: the allowance in settings is the same for everyone, the extra days are added to one teacher only', async () => {
    const before = (await api().get('/api/teacher/leave').set(W.teacher1.h)).body;
    expect(before.balances.casual).toMatchObject({ allowance: 12, granted: 0, remaining: 12 });
    expect(before.balances.earned.allowance).toBe(0);
    const g = await api().post(A('/leave-balances/grants')).set(W.h).send({ personType: 'teacher', personId: W.t1.teacher._id, leaveType: 'casual', days: 2, reason: 'Worked on the Annual Day holiday' });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    expect((await api().post(A('/leave-balances/grants')).set(W.h).send({ personType: 'teacher', personId: W.t1.teacher._id, leaveType: 'earned', days: 1.5, reason: 'Exam duty on Sunday' })).status).toBe(201);
    const after = (await api().get('/api/teacher/leave').set(W.teacher1.h)).body;
    expect(after.balances.casual).toMatchObject({ base: 12, granted: 2, allowance: 14, remaining: 14 });
    expect(after.balances.earned).toMatchObject({ allowance: 1.5, remaining: 1.5 }); // a type that had no allowance now has one
    expect(after.grants.map((x) => x.reason).sort()).toEqual(['Exam duty on Sunday', 'Worked on the Annual Day holiday']);
    // the other teacher is untouched
    expect((await api().get('/api/teacher/leave').set(W.teacher2.h)).body.balances.casual).toMatchObject({ allowance: 12, granted: 0 });
    // the teacher was told
    const notes = (await api().get('/api/teacher/notifications').set(W.teacher1.h)).body;
    expect(JSON.stringify(notes)).toContain('Extra leave added');
  });

  it('the admin sees everyone with allowance, extra, used and left', async () => {
    const r = (await api().get(A('/leave-balances?group=teachers')).set(W.h)).body;
    expect(r.personType).toBe('teacher');
    const row = r.rows.find((x) => String(x.id) === String(W.t1.teacher._id));
    expect(row.balances.casual).toMatchObject({ base: 12, granted: 2, allowance: 14, used: 0 });
    expect(r.rows.find((x) => String(x.id) === String(W.t2.teacher._id)).balances.casual.granted).toBe(0);
    expect((await api().get(A('/leave-balances?group=general')).set(W.h)).body.rows.map((x) => x.name)).toEqual(['Chhaya Clerk']);
  });

  it('extra days can be spent, and cannot be withdrawn once they have been', async () => {
    const d = workingDay(2);
    expect((await api().post('/api/teacher/leave').set(W.teacher1.h).send({ leaveType: 'earned', startDate: d, endDate: d, reason: 'Compensatory day off' })).status).toBe(201);
    const list = (await api().get(A('/leave')).set(W.h)).body;
    const app = list.find((l) => l.leaveType === 'earned');
    expect((await api().post(A(`/leave/${app._id}/decide`)).set(W.h).send({ decision: 'approve' })).status).toBe(200);
    const bal = (await api().get('/api/teacher/leave').set(W.teacher1.h)).body.balances.earned;
    expect(bal).toMatchObject({ used: 1, remaining: 0.5 });
    const grants = (await api().get(A(`/leave-balances/grants?personType=teacher&personId=${W.t1.teacher._id}`)).set(W.h)).body;
    const earned = grants.find((x) => x.leaveType === 'earned');
    expect((await api().delete(A(`/leave-balances/grants/${earned._id}`)).set(W.h)).status).toBe(400);
    const casual = grants.find((x) => x.leaveType === 'casual');
    expect((await api().delete(A(`/leave-balances/grants/${casual._id}`)).set(W.h)).status).toBe(200);
    expect((await api().get('/api/teacher/leave').set(W.teacher1.h)).body.balances.casual.allowance).toBe(12);
  });

  it('staff: extra leave works the same way, and unpaid/invalid requests are refused', async () => {
    expect((await api().post(A('/leave-balances/grants')).set(W.h).send({ personType: 'staff', personId: clerk._id, leaveType: 'unpaid', days: 1, reason: 'Nope' })).status).toBe(400);
    expect((await api().post(A('/leave-balances/grants')).set(W.h).send({ personType: 'staff', personId: clerk._id, leaveType: 'sick', days: 0.3, reason: 'Odd amount' })).status).toBe(400);
    expect((await api().post(A('/leave-balances/grants')).set(W.h).send({ personType: 'staff', personId: clerk._id, leaveType: 'sick', days: 3, reason: 'Long illness, doctor note' })).status).toBe(201);
    const row = (await api().get(A('/leave-balances?group=general')).set(W.h)).body.rows[0];
    expect(row.balances.sick).toMatchObject({ base: 10, granted: 3, allowance: 13 });
    // the same person is not in the transport list
    expect((await api().get(A('/leave-balances?group=transport')).set(W.h)).body.rows.map((x) => x.name)).not.toContain('Chhaya Clerk');
  });

  it('only the school admin can give extra leave; a sub-admin only for the group they hold', async () => {
    expect((await api().post(A('/leave-balances/grants')).set(W.teacher1.h).send({ personType: 'teacher', personId: W.t1.teacher._id, leaveType: 'casual', days: 5, reason: 'Give me more' })).status).toBe(403);
    expect((await api().get(A('/leave-balances?group=teachers')).set(W.teacher1.h)).status).toBe(403);
    const c = await api().post(A('/sub-admins')).set(W.h).send({ name: 'Desk Two', email: 'desk2@xl.test', permissions: ['staff_attendance'] });
    const sub = await login(c.body.loginId, c.body.temporaryPassword, 'admin');
    expect((await api().get(A('/leave-balances?group=general')).set(sub.h)).status).toBe(200);
    expect((await api().get(A('/leave-balances?group=teachers')).set(sub.h)).status).toBe(403);
    expect((await api().post(A('/leave-balances/grants')).set(sub.h).send({ personType: 'teacher', personId: W.t1.teacher._id, leaveType: 'casual', days: 1, reason: 'Not mine to give' })).status).toBe(403);
    expect((await api().post(A('/leave-balances/grants')).set(sub.h).send({ personType: 'staff', personId: clerk._id, leaveType: 'casual', days: 1, reason: 'Held by this desk' })).status).toBe(201);
  });
});
