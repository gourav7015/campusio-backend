import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { todayStr } from '../src/core/utils.js';

const monthsAgo = (n) => { const [y, m] = todayStr('Asia/Kolkata').slice(0, 7).split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 - n, 1)); return d.toISOString().slice(0, 7); };
const M2 = monthsAgo(2); const M1 = monthsAgo(1); const M0 = monthsAgo(0);

describe('every payslip keeps its own figures; a later salary revision is explained, not hidden', () => {
  let root; let W; let t1;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'slip'); t1 = W.t1.teacher._id;
  });
  afterAll(teardown);
  const P = (p) => `/api/school/payroll${p}`;
  const setPay = (basic, effectiveFrom) => api().post(P(`/salaries/${t1}`)).set(W.h).send({ basic, effectiveFrom, reason: 'test' });
  const runMonth = async (month) => {
    const run = (await api().post(P('/runs')).set(W.h).send({ month })).body;
    expect((await api().post(P(`/runs/${run._id}/approve`)).set(W.h).send({})).status).toBe(200);
    return run;
  };

  it('two consecutive runs with different salaries give two different payslips, each matching its own month', async () => {
    expect((await setPay(20000, '2026-01-01')).status).toBe(201);
    await runMonth(M2);
    expect((await setPay(30000, `${M1}-01`)).status).toBe(201);
    await runMonth(M1);
    const slips = (await api().get('/api/teacher/payslips').set(W.teacher1.h)).body;
    expect(slips.map((s) => s.month)).toEqual([M1, M2]); // newest first
    expect(slips[0].gross).toBeGreaterThan(slips[1].gross);
    expect(slips[0].gross).not.toBe(slips[1].gross);
    // the PDF is made from the slip itself, so it matches the on-screen figures
    const pdf = await api().get(`/api/teacher/payslips/${slips[0]._id}/pdf`).set(W.teacher1.h).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(pdf.status).toBe(200); expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain(slips[0].payslipNo);
    // no revision since: no note
    expect((await api().get('/api/teacher/salary').set(W.teacher1.h)).body.revisedAfterLatest).toBeNull();
  });

  it('a salary changed after the latest approved run leaves that slip alone and the person is told when it applies', async () => {
    expect((await setPay(45000, `${M0}-01`)).status).toBe(201);
    const before = (await api().get('/api/teacher/payslips').set(W.teacher1.h)).body;
    expect(before[0].month).toBe(M1); // October-style: still the newest visible slip, unchanged
    const sal = (await api().get('/api/teacher/salary').set(W.teacher1.h)).body;
    expect(sal.current.effectiveFrom).toBe(`${M0}-01`);
    expect(sal.revisedAfterLatest).toMatchObject({ effectiveFrom: `${M0}-01`, appliesFromMonth: M0, latestPayslipMonth: M1 });
    expect(sal.revisedAfterLatest.gross).toBeGreaterThan(before[0].gross);
    // an approved month can never be re-priced by choosing an earlier date
    expect((await setPay(99999, `${M1}-15`)).status).toBe(409);
    // once that month's payroll runs, the note goes and the new slip carries the new pay
    await runMonth(M0);
    const after = (await api().get('/api/teacher/payslips').set(W.teacher1.h)).body;
    expect(after.map((s) => s.month)).toEqual([M0, M1, M2]);
    expect(after[0].gross).toBeGreaterThan(after[1].gross);
    expect((await api().get('/api/teacher/salary').set(W.teacher1.h)).body.revisedAfterLatest).toBeNull();
  });
});

describe('salary paid in parts', () => {
  let root; let W; let t1;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'part'); t1 = W.t1.teacher._id; });
  afterAll(teardown);
  const P = (p) => `/api/school/payroll${p}`;
  it('half a month now and the rest later; the slip, the run and the person all follow', async () => {
    await api().post(P(`/salaries/${t1}`)).set(W.h).send({ basic: 30000, effectiveFrom: '2026-01-01' });
    const run = (await api().post(P('/runs')).set(W.h).send({ month: M1 })).body;
    const slip = (await api().get(P(`/runs/${run._id}`)).set(W.h)).body.payslips[0];
    expect((await api().post(P(`/payslips/${slip._id}/pay`)).set(W.h).send({ amount: 100 })).status).toBe(409); // approve first
    await api().post(P(`/runs/${run._id}/approve`)).set(W.h).send({});
    const half = Math.round(slip.net / 2 * 100) / 100;
    const a = await api().post(P(`/payslips/${slip._id}/pay`)).set(W.h).send({ amount: half, mode: 'cash', note: 'First half' });
    expect(a.body).toMatchObject({ status: 'partial', paidAmount: half });
    expect((await api().post(P(`/payslips/${slip._id}/pay`)).set(W.h).send({ amount: slip.net })).status).toBe(400); // more than what is left
    expect((await api().get(P(`/runs/${run._id}`)).set(W.h)).body.run).toMatchObject({ status: 'approved', totals: { paid: half } });
    expect((await api().get('/api/teacher/payslips').set(W.teacher1.h)).body[0].status).toBe('partial');
    const bank = (await api().get(P(`/runs/${run._id}/bank-file`)).set(W.h)).body;
    expect([...bank.ready, ...bank.missing].map((r) => r.amount ?? r.net)).toEqual([Math.round((slip.net - half) * 100) / 100]); // the file asks only for the rest
    const rest = Math.round((slip.net - half) * 100) / 100;
    const b = await api().post(P(`/payslips/${slip._id}/pay`)).set(W.h).send({ amount: rest });
    expect(b.body).toMatchObject({ status: 'paid', paidAmount: slip.net }); expect(b.body.payments).toHaveLength(2);
    expect((await api().get(P(`/runs/${run._id}`)).set(W.h)).body.run.status).toBe('paid');
    expect((await api().post(P(`/payslips/${slip._id}/pay`)).set(W.h).send({ amount: 1 })).status).toBe(409);
  });
  it('"mark paid" settles what is left after part payments', async () => {
    const m0 = monthsAgo(0);
    await api().post(P(`/salaries/${t1}`)).set(W.h).send({ basic: 31000, effectiveFrom: `${m0}-01` });
    const run = (await api().post(P('/runs')).set(W.h).send({ month: m0 })).body;
    await api().post(P(`/runs/${run._id}/approve`)).set(W.h).send({});
    const slip = (await api().get(P(`/runs/${run._id}`)).set(W.h)).body.payslips[0];
    await api().post(P(`/payslips/${slip._id}/pay`)).set(W.h).send({ amount: 1000 });
    const out = await api().post(P(`/runs/${run._id}/pay`)).set(W.h).send({ mode: 'bank_transfer' });
    expect(out.body.status).toBe('paid'); expect(out.body.totals.paid).toBe(slip.net);
  });
});
