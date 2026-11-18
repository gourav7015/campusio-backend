import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { StudentCharge, AuditLog } from '../src/models/index.js';

describe('Admission: fee preview and a personal discount on tuition', () => {
  let root; let W; let fin;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'adm');
    const s = await api().post('/api/school/staff').set(W.h).send({ name: 'Fiona Finance', email: 'fiona@adm.test', role: 'finance' });
    fin = await login(s.body.loginId, s.body.temporaryPassword, 'finance');
    // Class 8 bills automatically: admission 5000 once, tuition 1000 a month. Class 9 has no fee structure.
    const st = await api().post('/api/finance/structures').set(fin.h).send({ classId: W.c8._id, name: 'Class 8 Fee', admissionFee: 5000, monthlyFee: 1000, dueDay: 10, autoAssign: true });
    expect(st.status).toBe(201);
  });
  afterAll(teardown);
  const admit = (name, extra = {}, sectionId = W.sec8B._id) => api().post('/api/school/students').set(W.h).send({ name, dob: '2013-09-09', sectionId, admissionDate: '2026-04-15', guardians: [{ name: `Parent of ${name}`, relationship: 'Father', phone: '9876543210', isPrimary: true }], ...extra });
  const tuitionOf = (studentId) => StudentCharge.find({ studentId, category: 'Tuition' }).lean();
  const sum = (rows, k) => Math.round(rows.reduce((n, r) => n + (r[k] || 0), 0) * 100) / 100;

  it('the preview shows what will be billed, and it matches the real charges to the rupee (a mid-year joiner pays fewer months)', async () => {
    const full = (await api().get(`/api/school/students/fee-preview?sectionId=${W.sec8B._id}&admissionDate=2026-04-15`).set(W.h)).body;
    expect(full).toMatchObject({ months: 12, totals: { admission: 5000, tuition: 12000, total: 17000 } });
    const mid = (await api().get(`/api/school/students/fee-preview?sectionId=${W.sec8B._id}&admissionDate=2026-10-05`).set(W.h)).body;
    expect(mid.months).toBe(6); expect(mid.totals.tuition).toBe(6000);
    const a = await admit('Mid Year', { admissionDate: '2026-10-05' });
    expect(a.status).toBe(201);
    const charges = await StudentCharge.find({ studentId: a.body.student._id }).lean();
    expect(sum(charges, 'amount')).toBe(mid.totals.total);
    expect((await api().get(`/api/school/students/fee-preview?sectionId=${W.sec8B._id}`).set(W.teacher1.h)).status).toBe(403);
  });

  it('a 10% discount makes tuition 90% of the full amount, every month carries the reason, and nothing else is touched', async () => {
    const a = await admit('Ten Percent', { discount: { type: 'percent', value: 10, reason: 'Staff child' } });
    expect(a.status).toBe(201);
    expect(a.body.discount).toMatchObject({ type: 'percent', value: 10, applied: 1200, reason: 'Staff child' });
    const t = await tuitionOf(a.body.student._id);
    expect(t).toHaveLength(12);
    expect(sum(t, 'amount') - sum(t, 'concession')).toBe(10800); // 90% of 12000
    expect(t.every((c) => c.concession === 100 && c.concessionNote === 'Staff child' && c.concessions[0].reason === 'Staff child')).toBe(true);
    const adm = await StudentCharge.findOne({ studentId: a.body.student._id, category: 'Admission' }).lean();
    expect(adm.concession || 0).toBe(0); // tuition only
    // the student and Finance both see it, read-only for the student
    const acct = (await api().get(`/api/finance/students/${a.body.student._id}/account`).set(fin.h)).body;
    expect(acct.totals.concession).toBe(1200);
    // it is a concession on the charges, not a field on the student, and it is audited with who, how much and why
    expect((await api().get(`/api/school/students/${a.body.student._id}`).set(W.h)).body.discount).toBeUndefined();
    const log = await AuditLog.findOne({ action: 'student.admission_discount' }).lean();
    expect(log.summary || log.detail || JSON.stringify(log)).toMatch(/10%.*Staff child/);
  });

  it('a fixed amount is spread so the parts add up exactly', async () => {
    const a = await admit('Fixed Amount', { discount: { type: 'amount', value: 1000.10, reason: 'Merit scholarship' } });
    expect(a.status).toBe(201);
    const t = await tuitionOf(a.body.student._id);
    expect(sum(t, 'concession')).toBe(1000.1); // no paise lost or invented
    expect(sum(t, 'amount') - sum(t, 'concession')).toBeCloseTo(10999.9, 2);
  });

  it('refuses a missing reason, a discount above the tuition, a bad percentage, and a class with no fee structure; nothing is created', async () => {
    const before = (await api().get('/api/school/students').set(W.h)).body.total;
    expect((await admit('No Reason', { discount: { type: 'percent', value: 10, reason: '' } })).status).toBe(400);
    expect((await admit('No Reason 2', { discount: { type: 'percent', value: 10 } })).status).toBe(400);
    expect((await admit('Too Much', { discount: { type: 'amount', value: 12000.01, reason: 'Because' } })).status).toBe(400);
    expect((await admit('Over Hundred', { discount: { type: 'percent', value: 101, reason: 'Because' } })).status).toBe(400);
    expect((await admit('Negative', { discount: { type: 'amount', value: -5, reason: 'Because' } })).status).toBe(400);
    const sec9 = (await api().post('/api/school/sections').set(W.h).send({ yearId: W.year._id, classId: W.c9._id, name: 'A', capacity: 30 })).body;
    const none = await admit('No Structure', { discount: { type: 'percent', value: 10, reason: 'Because' } }, sec9._id);
    expect(none.status).toBe(400); expect(JSON.stringify(none.body)).toMatch(/no fee structure/i);
    expect((await api().get('/api/school/students').set(W.h)).body.total).toBe(before); // no half-admitted student
    expect((await admit('Without Discount', {}, sec9._id)).status).toBe(201); // admitting without a discount is unaffected
  });

  it('only the School Admin can give it, and the student cannot', async () => {
    expect((await api().post('/api/school/students').set(W.teacher1.h).send({})).status).toBe(403);
    expect((await api().post('/api/school/students').set(W.studentLogins[0].h).send({})).status).toBe(403);
  });
});

describe('a standing personal discount follows the student month after month', () => {
  let root; let W; let fin;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'pdisc');
    const s = await api().post('/api/school/staff').set(W.h).send({ name: 'Fiona Finance', email: 'fiona@pdisc.test', role: 'finance' });
    fin = await login(s.body.loginId, s.body.temporaryPassword, 'finance');
    await api().post('/api/finance/structures').set(fin.h).send({ classId: W.c8._id, name: 'Class 8 Fee', admissionFee: 0, monthlyFee: 1000, dueDay: 10, autoAssign: true });
  });
  afterAll(teardown);
  it('Finance sets and removes it; open tuition months change, paid ones do not, and the account shows it', async () => {
    const sid = W.students[0].student._id;
    const st = (await api().get('/api/finance/structures').set(fin.h)).body[0];
    await api().post('/api/finance/assign').set(fin.h).send({ structureId: st._id, all: true });
    const tuition = () => StudentCharge.find({ studentId: sid, category: 'Tuition' }).sort({ dueDate: 1 }).lean();
    // pay the first month in full, then give a 10% discount
    const first = (await tuition())[0];
    await api().post('/api/finance/payments').set(fin.h).send({ studentId: sid, amount: first.amount, mode: 'cash', allocations: [{ chargeId: first._id, amount: first.amount }] });
    expect((await api().put(`/api/finance/students/${sid}/personal-discount`).set(W.teacher1.h).send({ type: 'percent', value: 10, reason: 'Sibling' })).status).toBe(403);
    expect((await api().put(`/api/finance/students/${sid}/personal-discount`).set(fin.h).send({ type: 'percent', value: 101, reason: 'Sibling' })).status).toBe(400);
    const out = await api().put(`/api/finance/students/${sid}/personal-discount`).set(fin.h).send({ type: 'percent', value: 10, reason: 'Sibling' });
    expect(out.body).toMatchObject({ personalDiscount: { type: 'percent', value: 10 } });
    let t = await tuition();
    expect(t[0].concession || 0).toBe(0); // already paid: untouched
    expect(t.slice(1).every((c) => c.concession === 100)).toBe(true);
    expect((await api().get(`/api/finance/students/${sid}/account`).set(fin.h)).body.personalDiscount).toMatchObject({ type: 'percent', value: 10 });
    // changing it replaces the old amount; it never stacks
    await api().put(`/api/finance/students/${sid}/personal-discount`).set(fin.h).send({ type: 'per_month', value: 250, reason: 'Merit' });
    t = await tuition();
    expect(t.slice(1).every((c) => c.concession === 250)).toBe(true);
    // a student admitted with a discount keeps it for later months too
    const adm = await api().post('/api/school/students').set(W.h).send({ name: 'New Child', dob: '2013-09-09', sectionId: W.sec8B._id, admissionDate: '2026-04-15', discount: { type: 'amount', value: 1200, reason: 'Staff child' }, guardians: [{ name: 'Parent', relationship: 'Father', phone: '9876543210', isPrimary: true }] });
    expect(adm.status).toBe(201);
    const nid = adm.body.student._id;
    expect((await api().get(`/api/finance/students/${nid}/account`).set(fin.h)).body.personalDiscount).toMatchObject({ type: 'per_month', value: 100 }); // ₹1,200 over 12 months
    await api().delete(`/api/finance/students/${sid}/personal-discount`).set(fin.h);
    expect((await tuition()).every((c) => !c.concession)).toBe(true);
  });
});
