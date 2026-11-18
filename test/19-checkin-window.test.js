import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';
import { checkInWindow, checkInState } from '../src/modules/staff-punch/staff-punch.service.js';

const pol = (over = {}) => ({ shiftStart: '08:00', shiftEnd: '15:00', checkInOpensBeforeMinutes: 60, checkInClosesAtShiftEnd: true, ...over });

describe('self check-in is only open around the shift', () => {
  it('the window opens an hour before the shift and closes at shift end; boundaries are inclusive', () => {
    expect(checkInWindow(pol())).toMatchObject({ opensAt: '07:00', closesAt: '15:00' });
    expect(checkInState(pol(), '06:59').state).toBe('early');
    expect(checkInState(pol(), '07:00').state).toBe('open'); // the first minute
    expect(checkInState(pol(), '15:00').state).toBe('open');
    expect(checkInState(pol(), '15:01').state).toBe('closed');
    expect(checkInState(pol({ checkInOpensBeforeMinutes: 0 }), '07:59').state).toBe('early');
    expect(checkInState(pol({ checkInClosesAtShiftEnd: false }), '23:30').state).toBe('open');
    expect(checkInWindow(pol({ shiftStart: '00:30' })).opensAt).toBe('00:00'); // never goes below midnight
  });

  describe('through the API', () => {
    let root; let W;
    beforeAll(async () => {
      await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'win');
      await api().put('/api/school/settings').set(W.h).send({ workingDays: [1, 2, 3, 4, 5, 6, 7] });
    });
    afterAll(teardown);
    const setPol = (staffAttendance) => api().put('/api/school/settings').set(W.h).send({ staffAttendance });

    // the school's clock, pinned to a time of day
    // yesterday, not today: the sign-in tokens were made a moment ago, so a pinned clock in the past can never expire them
    const DAY = addDays(todayStr('Asia/Kolkata'), -1); // worked out once, before the clock is pinned
    const at = (hhmm) => vi.setSystemTime(new Date(`${DAY}T${hhmm}:00+05:30`));
    afterEach(() => vi.useRealTimers());
    const msg = (r) => r.body.error?.message || r.body.message || JSON.stringify(r.body);

    it('refuses a check-in before the window and after shift end, allows one inside it, and says what to do', async () => {
      await setPol({ shiftStart: '08:00', shiftEnd: '15:00', checkInOpensBeforeMinutes: 60, checkInClosesAtShiftEnd: true });
      vi.useFakeTimers({ toFake: ['Date'] });
      at('06:59');
      const early = await api().post('/api/teacher/punch/check-in').set(W.teacher1.h).send({});
      expect(early.status).toBe(400); expect(msg(early)).toMatch(/opens at 07:00/i);
      expect((await api().get('/api/teacher/punch').set(W.teacher1.h)).body.policy).toMatchObject({ checkInState: 'early', opensAt: '07:00', closesAt: '15:00' });
      at('15:01');
      const late = await api().post('/api/teacher/punch/check-in').set(W.teacher1.h).send({});
      expect(late.status).toBe(400); expect(msg(late)).toMatch(/closed at 15:00.*school office/i);
      at('07:00'); // the first minute
      expect((await api().post('/api/teacher/punch/check-in').set(W.teacher1.h).send({})).status).toBe(201);
      expect((await api().post('/api/teacher/punch/check-in').set(W.teacher1.h).send({})).status).toBe(409); // still one per day
      at('18:00'); // leaving late is never blocked
      expect((await api().post('/api/teacher/punch/check-out').set(W.teacher1.h).send({})).status).toBe(200);
    });

    it('the new settings validate and are saved', async () => {
      await setPol({ shiftStart: '00:00', shiftEnd: '23:59' });
      
      expect((await api().put('/api/school/settings').set(W.h).send({ staffAttendance: { checkInOpensBeforeMinutes: -5 } })).status).toBe(400);
      expect((await api().put('/api/school/settings').set(W.h).send({ staffAttendance: { checkInOpensBeforeMinutes: 90, checkInClosesAtShiftEnd: false } })).status).toBe(200);
      expect((await api().get('/api/school/settings').set(W.h)).body.staffAttendance).toMatchObject({ checkInOpensBeforeMinutes: 90, checkInClosesAtShiftEnd: false });
    });
  });
});
