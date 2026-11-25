import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, makeFinance } from './helpers.js';

/**
 * Payroll is run by the Finance department, like fees and expenses: Finance sets pay levels and salaries, generates the month, adds bonuses and deductions,
 * approves the amounts, records what is paid and prints payslips. The School Admin sees everything and changes nothing.
 */
describe('Payroll is run from Finance; the School Admin only views it', () => {
  let root; let W; let F; let t1; let run; let slip;
  const FIN = (p) => `/api/finance/payroll${p}`;
  const ADM = (p) => `/api/school/payroll${p}`;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'pfn'); F = await makeFinance(W); t1 = W.t1.teacher._id;
  });
  afterAll(teardown);

  it('Finance sets up levels and salaries, generates the month, adds a bonus and a deduction', async () => {
    const lvl = await api().post(FIN('/levels')).set(F.h).send({ name: 'PRT', basic: 30000, allowances: [], deductions: [] });
    expect(lvl.status).toBe(201);
    expect((await api().post(FIN(`/salaries/${t1}`)).set(F.h).send({ levelId: lvl.body._id, effectiveFrom: '2026-04-01' })).status).toBe(201);
    run = (await api().post(FIN('/runs')).set(F.h).send({ month: '2026-10' }));
    expect(run.status).toBe(201); run = run.body;
    slip = (await api().get(FIN(`/runs/${run._id}`)).set(F.h)).body.payslips[0];
    const adj = await api().patch(FIN(`/payslips/${slip._id}/adjustments`)).set(F.h).send({ adjustments: [{ label: 'Diwali bonus', type: 'earning', amount: 2000 }, { label: 'Advance recovery', type: 'deduction', amount: 500 }] });
    expect(adj.status).toBe(200);
  });

  it('Finance approves the checked amounts (the School Admin cannot), and only then can it record payments', async () => {
    expect((await api().post(ADM(`/runs/${run._id}/approve`)).set(W.h)).status).toBe(403); // the admin only looks
    expect((await api().post(FIN(`/runs/${run._id}/pay`)).set(F.h).send({ mode: 'cash' })).status).toBeGreaterThanOrEqual(400); // not approved yet
    expect((await api().post(FIN(`/runs/${run._id}/approve`)).set(F.h)).body.status).toBe('approved');
    const paid = await api().post(FIN(`/runs/${run._id}/pay`)).set(F.h).send({ mode: 'bank_transfer', reference: 'NEFT-1' });
    expect(paid.status).toBe(200); expect(paid.body.status).toBe('paid');
    const pdf = await api().get(FIN(`/payslips/${slip._id}/pdf`)).set(F.h);
    expect(pdf.status).toBe(200);
  });

  it('the School Admin sees all of it but changes nothing', async () => {
    for (const p of ['/summary', '/levels', '/salaries', '/runs', `/runs/${run._id}`, `/payslips/${slip._id}/pdf`]) expect((await api().get(ADM(p)).set(W.h)).status, p).toBe(200);
    expect((await api().post(ADM('/levels')).set(W.h).send({ name: 'TGT', basic: 35000, allowances: [], deductions: [] })).status).toBe(403);
    expect((await api().post(ADM(`/salaries/${t1}`)).set(W.h).send({ basic: 99999, effectiveFrom: '2026-04-01' })).status).toBe(403);
    expect((await api().post(ADM('/runs')).set(W.h).send({ month: '2026-11' })).status).toBe(403);
    expect((await api().patch(ADM(`/payslips/${slip._id}/adjustments`)).set(W.h).send({ adjustments: [] })).status).toBe(403);
    expect((await api().post(ADM(`/runs/${run._id}/pay`)).set(W.h).send({ mode: 'cash' })).status).toBe(403);
    // the school's other admin work is untouched by this rule
    expect((await api().post('/api/school/classes').set(W.h).send({ name: 'Class 5' })).status).toBe(201);
  });

  it('teachers and other roles cannot use either door; the Super Admin acting for the school still can (support)', async () => {
    expect((await api().get(FIN('/runs')).set(W.teacher1.h)).status).toBe(403);
    expect((await api().get(FIN('/runs')).set(W.h)).status).toBe(403); // the admin uses the school window
    expect((await api().get(ADM('/runs')).set(F.h)).status).toBe(403); // Finance uses its own window
    const acting = { ...root.h, 'X-Acting-School': W.id };
    expect((await api().post(ADM('/levels')).set(acting).send({ name: 'Support level', basic: 20000, allowances: [], deductions: [] })).status).toBe(201);
  });

  describe('the payroll day, increments, one-month bonuses and the payslip PDF', () => {
    it('the payroll prepares itself on the school\'s payroll day; Finance sets the day, the admin only sees it', async () => {
      const { autoGeneratePayroll } = await import('../src/modules/payroll/payroll.service.js');
      const { PayrollRun } = await import('../src/models/index.js');
      expect((await api().get(FIN('/settings')).set(F.h)).body).toEqual({ generateDay: 25 });
      expect((await api().get(ADM('/settings')).set(W.h)).body).toEqual({ generateDay: 25 });
      expect((await api().put(ADM('/settings')).set(W.h).send({ generateDay: 10 })).status).toBe(403);
      for (const bad of [-1, 29, 12.5]) expect((await api().put(FIN('/settings')).set(F.h).send({ generateDay: bad })).status, String(bad)).toBe(400);
      expect((await api().put(FIN('/settings')).set(F.h).send({ generateDay: 1 })).body).toEqual({ generateDay: 1 });
      const month = new Date().toLocaleDateString('en-CA').slice(0, 7);
      await PayrollRun.deleteMany({ tenantId: W.id, month }); // start from a month with no payroll
      // switched off: nothing is made
      await api().put(FIN('/settings')).set(F.h).send({ generateDay: 0 });
      expect(await autoGeneratePayroll()).toBe(0);
      // on: this month's payroll appears as a draft, once
      await api().put(FIN('/settings')).set(F.h).send({ generateDay: 1 });
      expect(await autoGeneratePayroll()).toBeGreaterThanOrEqual(1);
      const made = await PayrollRun.findOne({ tenantId: W.id, month }).lean();
      expect(made).toMatchObject({ status: 'draft' });
      expect(await autoGeneratePayroll()).toBe(0); // a month that has a payroll is left alone
      await PayrollRun.deleteMany({ tenantId: W.id, month });
    });

    it('a percentage increment is previewed first, then applied as new salary revisions that keep the old ones in history', async () => {
      const lvl = (await api().get(FIN('/levels')).set(F.h)).body[0];
      await api().post(FIN(`/salaries/${W.t2.teacher._id}`)).set(F.h).send({ basic: 20000, allowances: [{ label: 'HRA', kind: 'percent', value: 10 }], effectiveFrom: '2026-04-01' });
      const body = { scope: 'teachers', percent: 10, effectiveFrom: '2026-11-01', reason: 'Annual increment' };
      const pre = await api().post(FIN('/salaries/increment')).set(F.h).send({ ...body, preview: true });
      expect(pre.status).toBe(200);
      expect(pre.body).toMatchObject({ preview: true, applied: 0, people: 2 });
      expect(pre.body.rows.map((r) => [r.name, r.oldBasic, r.newBasic]).sort()).toEqual([['Mr Sharma', 30000, 33000], ['Mrs Gupta', 20000, 22000]]);
      expect(pre.body.newMonthlyNet).toBeGreaterThan(pre.body.oldMonthlyNet);
      expect((await api().get(FIN(`/salaries/${t1}`)).set(F.h)).body.history).toHaveLength(1); // a preview saves nothing
      const done = await api().post(FIN('/salaries/increment')).set(F.h).send(body);
            expect(done.body).toMatchObject({ applied: 2, failed: [] });
      const hist = (await api().get(FIN(`/salaries/${t1}`)).set(F.h)).body.history;
      expect(hist.map((h) => [h.effectiveFrom, h.basic])).toEqual([['2026-11-01', 33000], ['2026-04-01', 30000]]);
      expect(hist[0]).toMatchObject({ levelName: lvl.name, reason: 'Annual increment' });
      // a person with no salary is skipped, not guessed
      expect((await api().post(FIN('/salaries/increment')).set(F.h).send({ ...body, scope: 'staff', preview: true })).body.rows).toEqual([]);
      // the School Admin cannot give increments, and a nonsense percentage is refused
      expect((await api().post(ADM('/salaries/increment')).set(W.h).send(body)).status).toBe(403);
      expect((await api().post(FIN('/salaries/increment')).set(F.h).send({ ...body, percent: 0 })).status).toBe(400);
      expect((await api().post(FIN('/salaries/increment')).set(F.h).send({ ...body, percent: 150 })).status).toBe(400);
    });

    it('an increment can go to exactly the people picked, as a fixed amount, with rounding, and refuses nonsense', async () => {
      const base = { effectiveFrom: '2026-12-01', reason: 'Promotion round' };
      // a fixed amount for one picked person leaves everyone else alone
      const one = await api().post(FIN('/salaries/increment')).set(F.h).send({ ...base, mode: 'amount', amount: 2000, personIds: [String(t1)] });
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ mode: 'amount', applied: 1 });
      expect(one.body.rows.map((r) => [r.name, r.oldBasic, r.newBasic])).toEqual([['Mr Sharma', 33000, 35000]]);
      expect((await api().get(FIN(`/salaries/${W.t2.teacher._id}`)).set(F.h)).body.history).toHaveLength(2); // Mrs Gupta was not picked
      // a percentage rounded to the nearest 100 (preview only): 35000 + 7% = 37450 -> 37500
      const rounded = await api().post(FIN('/salaries/increment')).set(F.h).send({ ...base, percent: 7, roundTo: 100, personIds: [String(t1)], preview: true });
      expect(rounded.body.rows[0]).toMatchObject({ oldBasic: 35000, newBasic: 37500 });
      // a fixed amount can also reduce pay
      const less = await api().post(FIN('/salaries/increment')).set(F.h).send({ ...base, mode: 'amount', amount: -500, personIds: [String(t1)], preview: true });
      expect(less.body.rows[0].newBasic).toBe(34500);
      // someone who is not in this school is skipped, never touched
      const ghost = await api().post(FIN('/salaries/increment')).set(F.h).send({ ...base, percent: 5, personIds: ['0123456789abcdef01234567'], preview: true });
      expect(ghost.body.rows).toEqual([]);
      expect(ghost.body.skipped[0].reason).toMatch(/Not found/);
      // refusals: nobody picked, a zero amount, an odd rounding step
      expect((await api().post(FIN('/salaries/increment')).set(F.h).send({ ...base, percent: 5, personIds: [] })).status).toBe(400);
      expect((await api().post(FIN('/salaries/increment')).set(F.h).send({ ...base, mode: 'amount', amount: 0, personIds: [String(t1)] })).status).toBe(400);
      expect((await api().post(FIN('/salaries/increment')).set(F.h).send({ ...base, percent: 5, roundTo: 7 })).status).toBe(400);
      expect((await api().post(ADM('/salaries/increment')).set(W.h).send({ ...base, percent: 5, personIds: [String(t1)] })).status).toBe(403);
    });

    it('a bonus is added to every payslip of a draft month, by amount or by percentage of basic, and adding it twice never pays it twice', async () => {
      const r2 = (await api().post(FIN('/runs')).set(F.h).send({ month: '2026-11' })).body;
      const slips = (await api().get(FIN(`/runs/${r2._id}`)).set(F.h)).body.payslips;
      const sharma = slips.find((p) => p.personName === 'Mr Sharma');
      const pct = { label: 'Diwali bonus', mode: 'percent_basic', value: 50, scope: 'all' };
      const pre = await api().post(FIN(`/runs/${r2._id}/bonus`)).set(F.h).send({ ...pct, preview: true });
      expect(pre.body).toMatchObject({ preview: true, applied: 0 });
      expect(pre.body.rows.find((r) => r.name === 'Mr Sharma').amount).toBe(16500); // half of the new basic, 33,000
      expect((await api().get(FIN(`/runs/${r2._id}`)).set(F.h)).body.payslips.find((p) => p.personName === 'Mr Sharma').gross).toBe(sharma.gross); // nothing saved yet
      for (let i = 0; i < 2; i += 1) expect((await api().post(FIN(`/runs/${r2._id}/bonus`)).set(F.h).send(pct)).body.applied).toBeGreaterThan(0);
      const after = (await api().get(FIN(`/runs/${r2._id}`)).set(F.h)).body.payslips.find((p) => p.personName === 'Mr Sharma');
      expect(after.adjustments.filter((a) => a.label === 'Diwali bonus')).toHaveLength(1);
      expect(after.gross).toBe(sharma.gross + 16500);
      // a fixed bonus for teachers only, kept next to the first one
      const fixed = await api().post(FIN(`/runs/${r2._id}/bonus`)).set(F.h).send({ label: 'Exam duty', mode: 'fixed', value: 1000, scope: 'teachers' });
      expect(fixed.body.total).toBe(2000);
      expect((await api().get(FIN(`/runs/${r2._id}`)).set(F.h)).body.run.totals.gross).toBeGreaterThan(sharma.gross);
      expect((await api().post(ADM(`/runs/${r2._id}/bonus`)).set(W.h).send(pct)).status).toBe(403);
      // once the month is approved the figures are locked
      await api().post(FIN(`/runs/${r2._id}/approve`)).set(F.h);
      expect((await api().post(FIN(`/runs/${r2._id}/bonus`)).set(F.h).send({ ...pct, label: 'Late bonus' })).status).toBe(409);
    });

    it('a payslip PDF is issued only once the salary has been paid', async () => {
      const runs = (await api().get(FIN('/runs')).set(F.h)).body;
      const nov = runs.find((r) => r.month === '2026-11');
      const slipNov = (await api().get(FIN(`/runs/${nov._id}`)).set(F.h)).body.payslips[0];
      expect((await api().get(FIN(`/payslips/${slipNov._id}/pdf`)).set(F.h)).status).toBe(409); // approved but not paid
      expect((await api().post(FIN(`/runs/${nov._id}/pay`)).set(F.h).send({ mode: 'cash' })).status).toBe(200);
      expect((await api().get(FIN(`/payslips/${slipNov._id}/pdf`)).set(F.h)).status).toBe(200);
    });
  });
});
