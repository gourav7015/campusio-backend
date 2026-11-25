import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, makeFinance, makeSchool } from './helpers.js';
import { CalendarEvent } from '../src/models/index.js';

const MONTH = '2026-10'; // 31 days, 4 Sundays, 1 holiday (Fri 2 Oct) => 26 working days (Mon-Sat)

let F;
describe('Payroll: pay levels, salaries, monthly runs, payslips', () => {
  let root; let W; let prt; let pgt; let run; let t1; let t2; let slip1; let slip2;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'pay'); F = await makeFinance(W);
    t1 = W.t1.teacher._id; t2 = W.t2.teacher._id;
    await CalendarEvent.create({ tenantId: W.id, title: 'Gandhi Jayanti', type: 'holiday', startDate: '2026-10-02', endDate: '2026-10-02', sectionIds: [] });
  });
  afterAll(teardown);
  const A = (p) => `/api/finance/payroll${p}`; // payroll is run from Finance
  const AA = (p) => `/api/school/payroll${p}`; // the School Admin's window: view and approve

  it('the School Admin defines pay levels; teachers and other roles cannot', async () => {
    const body = { name: 'PRT', basic: 30000, allowances: [{ label: 'HRA', kind: 'percent', value: 40 }, { label: 'Transport', kind: 'fixed', value: 2000 }], deductions: [{ label: 'PF', kind: 'percent', value: 12 }] };
    expect((await api().post(A('/levels')).set(W.teacher1.h).send(body)).status).toBe(403);
    expect((await api().post(A('/levels')).set(F.h).send({ ...body, allowances: [{ label: 'HRA', kind: 'percent', value: 140 }] })).status).toBe(400);
    expect((await api().post(A('/levels')).set(F.h).send({ ...body, allowances: [{ label: 'PF', value: 5 }] })).status).toBe(400); // same name as a deduction
    prt = (await api().post(A('/levels')).set(F.h).send(body)).body;
    expect((await api().post(A('/levels')).set(F.h).send(body)).status).toBe(409);
    pgt = (await api().post(A('/levels')).set(F.h).send({ name: 'PGT', basic: 40000, allowances: [], deductions: [] })).body;
    const list = (await api().get(A('/levels')).set(F.h)).body;
    expect(list.find((l) => l.name === 'PRT')).toMatchObject({ gross: 44000, fixedDeductions: 3600, net: 40400, teachers: 0 });
  });

  it('salary is set from a level or by explicit figures, with effective dates and history', async () => {
    expect((await api().post(A(`/salaries/${t1}`)).set(F.h).send({ effectiveFrom: '2026-04-01' })).status).toBe(400); // neither level nor basic
    expect((await api().post(A(`/salaries/${t1}`)).set(W.teacher1.h).send({ levelId: prt._id, effectiveFrom: '2026-04-01' })).status).toBe(403);
    const r1 = await api().post(A(`/salaries/${t1}`)).set(F.h).send({ levelId: prt._id, effectiveFrom: '2026-04-01', reason: 'Joined' });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ levelName: 'PRT', basic: 30000, gross: 44000, net: 40400 });
    expect((await api().post(A(`/salaries/${t2}`)).set(F.h).send({ basic: 20000, effectiveFrom: '2026-04-01' })).status).toBe(201);
    const all = (await api().get(A('/salaries')).set(F.h)).body;
    expect(all).toMatchObject({ withSalary: 2, withoutSalary: 0 });
    expect(all.items.find((x) => x.name === 'Mr Sharma').revision).toMatchObject({ levelName: 'PRT', gross: 44000 });
    // a later revision is history, not an overwrite
    expect((await api().post(A(`/salaries/${t1}`)).set(F.h).send({ levelId: pgt._id, effectiveFrom: '2026-12-01' })).status).toBe(201);
    const hist = (await api().get(A(`/salaries/${t1}`)).set(F.h)).body.history;
    expect(hist.map((h) => [h.effectiveFrom, h.levelName])).toEqual([['2026-12-01', 'PGT'], ['2026-04-01', 'PRT']]);
    expect((await api().get(A('/levels')).set(F.h)).body.find((l) => l.name === 'PRT').teachers).toBe(1);
    expect((await api().delete(A(`/levels/${prt._id}`)).set(F.h)).status).toBe(409); // already used for pay
  });

  it('unpaid leave and school holidays drive the payroll calculation', async () => {
    const l = await api().post('/api/teacher/leave').set(W.teacher1.h).send({ leaveType: 'unpaid', startDate: '2026-10-05', endDate: '2026-10-06', reason: 'Personal work abroad' });
    expect(l.status).toBe(201);
    expect((await api().post(`/api/school/leave/${l.body._id}/decide`).set(W.h).send({ decision: 'approve' })).status).toBe(200);

    expect((await api().post(A('/runs')).set(F.h).send({ month: '2027-05' })).status).toBe(400); // future month
    expect((await api().post(A('/runs')).set(W.teacher1.h).send({ month: MONTH })).status).toBe(403);
    const r = await api().post(A('/runs')).set(F.h).send({ month: MONTH });
    expect(r.status).toBe(201);
    run = r.body;
    expect(run).toMatchObject({ month: MONTH, status: 'draft', workingDays: 26 });
    expect((await api().post(A('/runs')).set(F.h).send({ month: MONTH })).status).toBe(409);
    const { payslips } = (await api().get(A(`/runs/${run._id}`)).set(F.h)).body;
    slip1 = payslips.find((p) => p.employeeId === 'T001'); slip2 = payslips.find((p) => p.employeeId === 'T002');
    // PRT: gross 44000, PF 3600, 2 unpaid of 26 days => LOP = 44000*2/26 = 3384.62
    expect(slip1).toMatchObject({ levelName: 'PRT', workingDays: 26, unpaidDays: 2, paidDays: 24, gross: 44000, lossOfPay: 3384.62, totalDeductions: 6984.62, net: 37015.38, payslipNo: 'PAY202610-T001' });
    expect(slip2).toMatchObject({ unpaidDays: 0, gross: 20000, net: 20000 });
    expect(run.totals).toMatchObject({ count: 2, gross: 64000, net: 57015.38 });
  });

  it('a draft can be adjusted and recalculated without losing adjustments; negative pay is refused', async () => {
    const adj = await api().patch(A(`/payslips/${slip1._id}/adjustments`)).set(F.h).send({ adjustments: [{ label: 'Exam duty bonus', type: 'earning', amount: 1000 }, { label: 'Advance recovery', type: 'deduction', amount: 500, reason: 'Advance of Sept' }] });
    expect(adj.status).toBe(200);
    expect(adj.body).toMatchObject({ gross: 45000, net: 37515.38 });
    expect((await api().patch(A(`/payslips/${slip1._id}/adjustments`)).set(F.h).send({ adjustments: [{ label: 'Too much', type: 'deduction', amount: 90000 }] })).status).toBe(400);
    expect((await api().patch(A(`/payslips/${slip1._id}/adjustments`)).set(W.teacher1.h).send({ adjustments: [] })).status).toBe(403);
    expect((await api().post(A(`/runs/${run._id}/recalculate`)).set(F.h)).status).toBe(200);
    const again = (await api().get(A(`/runs/${run._id}`)).set(F.h)).body.payslips.find((p) => p.employeeId === 'T001');
    expect(again.net).toBe(37515.38);
    expect((await api().post(A(`/runs/${run._id}/pay`)).set(F.h).send({})).status).toBe(409); // cannot pay a draft
  });

  it('teachers see their payslip only after approval, and only their own', async () => {
    expect((await api().get('/api/teacher/payslips').set(W.teacher1.h)).body).toHaveLength(0);
    expect((await api().get(`/api/teacher/payslips/${slip1._id}/pdf`).set(W.teacher1.h)).status).toBe(403);
    expect((await api().post(AA(`/runs/${run._id}/approve`)).set(W.teacher1.h)).status).toBe(403);
    expect((await api().post(AA(`/runs/${run._id}/approve`)).set(W.h)).body.status).toBe('approved');
    // approved payroll is locked
    expect((await api().patch(A(`/payslips/${slip1._id}/adjustments`)).set(F.h).send({ adjustments: [] })).status).toBe(409);
    expect((await api().post(A(`/runs/${run._id}/recalculate`)).set(F.h)).status).toBe(409);
    expect((await api().delete(A(`/runs/${run._id}`)).set(F.h)).status).toBe(409);
    // and salary changes for an approved month are refused rather than silently disagreeing with it
    expect((await api().post(A(`/salaries/${t1}`)).set(F.h).send({ levelId: pgt._id, effectiveFrom: '2026-10-01' })).status).toBe(409);

    const mine = (await api().get('/api/teacher/payslips').set(W.teacher1.h)).body;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ month: MONTH, net: 37515.38, status: 'pending' });
    const pdf = await api().get(`/api/teacher/payslips/${slip1._id}/pdf`).set(W.teacher1.h);
    expect(pdf.status).toBe(200); expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((await api().get(`/api/teacher/payslips/${slip1._id}/pdf`).set(W.teacher2.h)).status).toBe(404); // someone else's
    expect((await api().get(`/api/school/payroll/payslips/${slip1._id}/pdf`).set(W.h)).status).toBe(200);
  });

  it('payment is recorded per payslip, once, and the run closes when everyone is paid', async () => {
    const p1 = await api().post(A(`/runs/${run._id}/pay`)).set(F.h).send({ mode: 'bank_transfer', reference: 'NEFT123', paidOn: '2026-11-01', payslipIds: [slip1._id] });
    expect(p1.body).toMatchObject({ status: 'approved', totals: { paid: 37515.38 } });
    const mine = (await api().get('/api/teacher/payslips').set(W.teacher1.h)).body[0];
    expect(mine).toMatchObject({ status: 'paid', paidOn: '2026-11-01', mode: 'bank_transfer', reference: 'NEFT123' });
    expect((await api().post(A(`/runs/${run._id}/pay`)).set(F.h).send({ payslipIds: [slip1._id] })).status).toBe(409); // never paid twice
    expect((await api().post(A(`/runs/${run._id}/pay`)).set(F.h).send({ mode: 'cash' })).body.status).toBe('paid');
    expect((await api().post(A(`/runs/${run._id}/pay`)).set(F.h).send({})).status).toBe(409);
    const notes = (await api().get('/api/teacher/notifications').set(W.teacher1.h)).body;
    expect(JSON.stringify(notes)).toMatch(/Salary paid/);
  });

  it('teacher salary page, admin summary and CSV export', async () => {
    const me = (await api().get('/api/teacher/salary').set(W.teacher1.h)).body;
    expect(me.current).toMatchObject({ levelName: 'PRT', basic: 30000, gross: 44000, net: 40400 });
    expect(me.current.earnings.map((e) => e.label)).toEqual(['Basic', 'HRA', 'Transport']);
    expect(me.history).toHaveLength(2);
    expect(me).toMatchObject({ paidThisYear: 37515.38, monthsPaidThisYear: 1 });
    const sum = (await api().get(A('/summary')).set(F.h)).body;
    expect(sum).toMatchObject({ teachers: 2, withSalary: 2, withoutSalary: 0, monthlyGross: 64000, paidThisYear: 57515.38 });
    const csv = await api().get(A(`/runs/${run._id}/export.csv`)).set(F.h);
    expect(csv.status).toBe(200);
    const lines = csv.text.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Net pay');
    expect(csv.text).toContain('37515.38');
  });

  it('a teacher without a salary is skipped and reported; other schools cannot see any of it', async () => {
    const other = await makeSchool(root, 'oth');
    expect((await api().get(AA(`/runs/${run._id}`)).set(other.h)).status).toBe(404);
    expect((await api().get(AA('/runs')).set(other.h)).body).toHaveLength(0);
    const otherFin = await makeFinance(other, 'otherfin');
    expect((await api().post('/api/finance/payroll/runs').set(otherFin.h).send({ month: MONTH })).status).toBe(400); // no teachers with salary there
    // Super Admin can run payroll inside a school (data dumping / support), audited as acting
    const acting = { ...root.h, 'X-Acting-School': W.id };
    expect((await api().get(AA('/runs')).set(acting)).body).toHaveLength(1);
  });
});
