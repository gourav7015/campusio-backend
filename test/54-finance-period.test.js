import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, login, makeSuperAdmin, seedWorld } from './helpers.js';
import { Payment } from '../src/models/index.js';

describe('Finance dashboard: money received between any two dates (financial-year view)', () => {
  let root; let W; let fin;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'per');
    const s = await api().post('/api/school/staff').set(W.h).send({ name: 'Fiona Finance', email: 'fiona@per.test', role: 'finance' });
    fin = await login(s.body.loginId, s.body.temporaryPassword, 'finance');
    const sid = W.students[0].student._id;
    const pay = (receiptNo, paidOn, amount, mode, kind = 'payment') => Payment.create({ tenantId: W.id, studentId: sid, kind, amount, mode, receiptNo, paidOn, allocations: [] });
    await pay('R1', '2026-04-10', 1000, 'cash'); await pay('R2', '2026-05-02', 2500, 'upi'); await pay('R3', '2026-11-05', 4000, 'upi'); await pay('R3R', '2026-11-06', 500, 'upi', 'reversal');
    await pay('R0', '2026-03-30', 9999, 'cash'); // the year before
  });
  afterAll(teardown);
  const dash = (q) => api().get(`/api/finance/dashboard${q}`).set(fin.h);

  it('without dates there is no period block; with dates it adds up that period only', async () => {
    expect((await dash('')).body.period).toBeNull();
    const p = (await dash('?from=2026-04-01&to=2027-03-31')).body.period;
    expect(p).toMatchObject({ from: '2026-04-01', to: '2027-03-31', collected: 7000, receipts: 3, perMonth: true }); // 1000 + 2500 + 4000 − 500; the reversal is not a receipt
    expect(p.byMode.find((m) => m.mode === 'upi').amount).toBe(6000);
    expect(p.byMode.find((m) => m.mode === 'cash').amount).toBe(1000);
    expect(p.series).toHaveLength(12); expect(p.series[0]).toEqual({ label: '2026-04', amount: 1000 }); expect(p.series[7]).toEqual({ label: '2026-11', amount: 3500 });
  });

  it('a short period is shown day by day; the other year is separate', async () => {
    const p = (await dash('?from=2026-11-01&to=2026-11-10')).body.period;
    expect(p).toMatchObject({ collected: 3500, receipts: 1, perMonth: false }); expect(p.series).toHaveLength(10);
    expect((await dash('?from=2025-04-01&to=2026-03-31')).body.period.collected).toBe(9999);
  });

  it('wrong dates are refused; the School Admin sees the same view, read-only', async () => {
    expect((await dash('?from=2026-12-01&to=2026-11-01')).status).toBe(400);
    expect((await dash('?from=nonsense&to=2026-11-01')).status).toBe(400);
    const a = await api().get('/api/school/finance/dashboard?from=2026-04-01&to=2027-03-31').set(W.h);
    expect(a.status).toBe(200); expect(a.body.period.collected).toBe(7000);
  });
});
