import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { todayStr, addDays, isoDay } from '../src/core/utils.js';
import { assertLeaveRules } from '../src/modules/leave/leave.service.js';

const TODAY = todayStr('Asia/Kolkata');
const nextWorking = (from) => { let d = addDays(from, 1); while (isoDay(d) === 7) d = addDays(d, 1); return d; };

describe('leave rules: teaching and non-teaching staff can have different ones', () => {
  let W;
  beforeAll(async () => { await setup(); await reset(); const root = await makeSuperAdmin(); W = await seedWorld(root, 'lr'); });
  afterAll(teardown);

  it('are kept separately for the two groups and start with no limits', async () => {
    const s = (await api().get('/api/school/settings').set(W.h)).body;
    expect(s.leaveRules.teaching).toEqual({ maxDays: 0, noticeDays: 0, halfDay: true });
    expect(s.leaveRules.nonTeaching).toEqual({ maxDays: 0, noticeDays: 0, halfDay: true });
    const put = await api().put('/api/school/settings').set(W.h).send({ leaveRules: { teaching: { maxDays: 2, noticeDays: 3, halfDay: false } } });
    expect(put.status).toBe(200);
    const after = (await api().get('/api/school/settings').set(W.h)).body;
    expect(after.leaveRules.teaching).toEqual({ maxDays: 2, noticeDays: 3, halfDay: false });
    expect(after.leaveRules.nonTeaching).toEqual({ maxDays: 0, noticeDays: 0, halfDay: true }); // the other group is untouched
    expect((await api().put('/api/school/settings').set(W.h).send({ leaveRules: { teaching: { maxDays: -1 } } })).status).toBe(400);
  });

  it('are enforced when a teacher applies: half day, longest application, notice; sick leave needs no notice', async () => {
    const T = W.teacher1.h;
    const soon = nextWorking(TODAY);
    const far = (() => { let d = TODAY; for (let i = 0; i < 6; i++) d = nextWorking(d); return d; })();
    const half = await api().post('/api/teacher/leave').set(T).send({ leaveType: 'casual', startDate: far, endDate: far, halfDay: true, reason: 'Half day please' });
    expect(half.status).toBe(409); expect(half.body.message || half.body.error).toMatch(/Half-day/);
    let end = far; for (let i = 0; i < 2; i++) end = nextWorking(end);
    const long = await api().post('/api/teacher/leave').set(T).send({ leaveType: 'casual', startDate: far, endDate: end, reason: 'Three days away' });
    expect(long.status).toBe(409); expect(long.body.message || long.body.error).toMatch(/at most 2 days/);
    const late = await api().post('/api/teacher/leave').set(T).send({ leaveType: 'casual', startDate: soon, endDate: soon, reason: 'Short notice' });
    expect(late.status).toBe(409); expect(late.body.message || late.body.error).toMatch(/3 days ahead/);
    expect((await api().post('/api/teacher/leave').set(T).send({ leaveType: 'sick', startDate: soon, endDate: soon, reason: 'Fever, no notice' })).status).toBe(201);
    expect((await api().post('/api/teacher/leave').set(T).send({ leaveType: 'casual', startDate: far, endDate: far, reason: 'Planned well ahead' })).status).toBe(201);
  });

  it('the non-teaching group has its own rules', () => {
    const ctx = { today: TODAY };
    const rules = { maxDays: 1, noticeDays: 2, halfDay: true };
    const far = (() => { let d = TODAY; for (let i = 0; i < 5; i++) d = nextWorking(d); return d; })();
    expect(() => assertLeaveRules(ctx, rules, 'non-teaching staff', 1, { leaveType: 'casual', startDate: far, halfDay: false })).not.toThrow();
    expect(() => assertLeaveRules(ctx, rules, 'non-teaching staff', 2, { leaveType: 'casual', startDate: far })).toThrow(/at most 1 day/);
    expect(() => assertLeaveRules(ctx, rules, 'non-teaching staff', 1, { leaveType: 'casual', startDate: TODAY })).toThrow(/2 days ahead/);
    expect(() => assertLeaveRules(ctx, rules, 'non-teaching staff', 1, { leaveType: 'sick', startDate: TODAY })).not.toThrow();
    expect(() => assertLeaveRules(ctx, undefined, 'x', 9, { leaveType: 'casual', startDate: TODAY, halfDay: true })).not.toThrow(); // no rules, no limits
  });
});
