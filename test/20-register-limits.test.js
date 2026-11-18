import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { registerBody } from '../src/modules/staff-attendance/staff-attendance.validation.js';

describe('staff register: bulk marking', () => {
  it('accepts a register of well over 100 people in one request', () => {
    const entries = Array.from({ length: 300 }, (_, i) => ({ personId: i.toString(16).padStart(24, '0'), status: 'present', checkIn: '08:00', checkOut: '15:00' }));
    expect(registerBody.safeParse({ group: 'teachers', date: '2026-10-05', submit: false, entries }).success).toBe(true);
    const tooMany = Array.from({ length: 2001 }, (_, i) => ({ personId: i.toString(16).padStart(24, '0'), status: 'present' }));
    expect(registerBody.safeParse({ group: 'teachers', date: '2026-10-05', submit: false, entries: tooMany }).success).toBe(false); // the cap is 2000
  });

  describe('through the API', () => {
    let root; let W;
    beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'reg'); await api().put('/api/school/settings').set(W.h).send({ workingDays: [1, 2, 3, 4, 5, 6, 7] }); });
    afterAll(teardown);
    it('returns the shift hours with the register, saves bulk times, and rejects Out before In', async () => {
      const date = (await api().get('/api/school/staff-attendance/register?group=teachers').set(W.h)).body;
      expect(date.policy).toEqual({ shiftStart: '08:00', shiftEnd: '15:00', graceMinutes: 10 });
      const entries = date.rows.map((r) => ({ personId: String(r.personId), status: 'present', checkIn: '08:00', checkOut: '15:00' }));
      const ok = await api().put('/api/school/staff-attendance/register').set(W.h).send({ group: 'teachers', date: date.date, submit: false, entries });
      expect(ok.status).toBe(200);
      expect(ok.body.rows.every((r) => r.checkIn === '08:00' && r.checkOut === '15:00')).toBe(true);
      const bad = await api().put('/api/school/staff-attendance/register').set(W.h).send({ group: 'teachers', date: date.date, submit: false, entries: [{ ...entries[0], checkIn: '15:00', checkOut: '08:00' }] });
      expect(bad.status).toBe(400);
    });
  });
});
