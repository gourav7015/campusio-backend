import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, makeFinance } from './helpers.js';

/**
 * Payroll is run by the Finance department, like fees and expenses: Finance sets pay levels and salaries, generates the month, adds bonuses and deductions,
 * records what is paid and prints payslips. The School Admin sees everything and approves each month, and does nothing else. Finance cannot approve its own run.
 */
describe('Payroll is run from Finance; the School Admin views it and approves', () => {
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

  it('Finance cannot approve its own run; the School Admin can, and only then can Finance pay', async () => {
    expect((await api().post(FIN(`/runs/${run._id}/approve`)).set(F.h)).status).toBe(403);
    expect((await api().post(FIN(`/runs/${run._id}/pay`)).set(F.h).send({ mode: 'cash' })).status).toBeGreaterThanOrEqual(400); // not approved yet
    expect((await api().post(ADM(`/runs/${run._id}/approve`)).set(W.h)).body.status).toBe('approved');
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
});
