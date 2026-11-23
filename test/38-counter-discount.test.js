import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { Payment, StudentCharge } from '../src/models/index.js';

describe('A discount or concession given while collecting a payment', () => {
  let root; let W; let fin; let structure;
  const F = (p) => `/api/finance${p}`;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'cd');
    const s = await api().post('/api/school/staff').set(W.h).send({ name: 'Fiona Finance', email: 'f@cd.test', role: 'finance', phone: '9833333333', dob: '1984-04-04' });
    fin = await login(s.body.loginId, s.body.temporaryPassword, 'finance');
    structure = (await api().post(F('/structures')).set(fin.h).send({ classId: W.c8._id, name: 'Class 8 Fee', admissionFee: 5000, monthlyFee: 1000, dueDay: 10, autoAssign: false })).body;
    await api().post(F('/assign')).set(fin.h).send({ structureId: structure._id, all: true });
  });
  afterAll(teardown);
  const account = async (i) => (await api().get(F(`/students/${W.students[i].student._id}/account`)).set(fin.h)).body;
  const pay = (i, body) => api().post(F('/payments')).set(fin.h).send({ studentId: W.students[i].student._id, mode: 'cash', ...body });

  it('a percentage discount on everything that is due, then the rest is paid; the discount is kept on the dues with its reason', async () => {
    const before = await account(0);
    expect(before.totals.pending).toBe(17000);
    const r = await pay(0, { amount: 15300, discount: { type: 'percent', value: 10, reason: 'Staff child' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ amount: 15300, mode: 'cash' });
    const after = await account(0);
    expect(after.totals).toMatchObject({ concession: 1700, paid: 15300, pending: 0 });
    const touched = after.charges.filter((c) => c.concession > 0);
    expect(touched.length).toBeGreaterThan(0);
    expect(touched[0].concessions?.[0]?.reason ?? (await StudentCharge.findById(touched[0]._id)).concessions[0].reason).toContain('Staff child');
    expect(touched.reduce((n, c) => n + c.concession, 0)).toBe(1700);
  });

  it('a rupee discount on the dues ticked; what is not covered is paid', async () => {
    const acct = await account(1);
    const admission = acct.charges.find((c) => c.category === 'Admission');
    const r = await pay(1, { amount: 4000, chargeIds: [admission._id], discount: { type: 'amount', value: 1000, reason: 'Scholarship' } });
    expect(r.status).toBe(201);
    const a = (await account(1)).charges.find((c) => c.category === 'Admission');
    expect(a).toMatchObject({ concession: 1000, paidAmount: 4000, status: 'paid' });
  });

  it('a discount that clears what is due makes no receipt', async () => {
    const acct = await account(2);
    const tuition = acct.charges.find((c) => c.category === 'Tuition');
    const before = await Payment.countDocuments({ studentId: W.students[2].student._id });
    const r = await pay(2, { chargeIds: [tuition._id], discount: { type: 'amount', value: 1000, reason: 'Fee waived by the principal' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ discountOnly: true, discount: 1000 });
    expect(await Payment.countDocuments({ studentId: W.students[2].student._id })).toBe(before);
    expect((await account(2)).charges.find((c) => c._id === tuition._id)).toMatchObject({ status: 'paid', concession: 1000 });
  });

  it('bad requests change nothing', async () => {
    const before = await account(2);
    const base = { amount: 100 };
    expect((await pay(2, { ...base, discount: { type: 'amount', value: 999999, reason: 'Too much' } })).status).toBe(400); // more than is due
    expect((await pay(2, { amount: 99999, discount: { type: 'amount', value: 100, reason: 'Amount too high' } })).status).toBe(400); // pays more than remains
    expect((await pay(2, { ...base, discount: { type: 'percent', value: 150, reason: 'Over a hundred' } })).status).toBe(400);
    expect((await pay(2, { ...base, discount: { type: 'amount', value: 100, reason: 'x' } })).status).toBe(400); // a reason is needed
    expect((await pay(2, { discount: undefined })).status).toBe(400); // an amount is needed when there is no discount
    expect((await pay(2, { amount: 100 })).status).toBe(201); // and a plain payment still works
    const after = await account(2);
    expect(after.totals.concession).toBe(before.totals.concession); // no discount was applied by any of the refused requests
  });

  it('only Finance can do it; the School Admin and teachers cannot', async () => {
    expect((await api().post('/api/school/finance/payments').set(W.h).send({ studentId: W.students[0].student._id, amount: 1, mode: 'cash', discount: { type: 'amount', value: 1, reason: 'Nope' } })).status).toBe(403);
    expect((await api().post(F('/payments')).set(W.teacher1.h).send({ studentId: W.students[0].student._id, amount: 1, mode: 'cash' })).status).toBe(403);
  });
});
