import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';
import { StudentCharge } from '../src/models/index.js';

const TODAY = todayStr('Asia/Kolkata');

describe('Finance portal: fee structures, billing, payments, receipts, reversals, concessions', () => {
  let root; let W; let fin; let structure; let sid; let sid2;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'fin');
    const s = await api().post('/api/school/staff').set(W.h).send({ name: 'Fiona Finance', email: 'fiona@fin.test', role: 'finance' });
    fin = await login(s.body.loginId, s.body.temporaryPassword, 'finance');
    sid = W.students[0].student._id; sid2 = W.students[1].student._id;
  });
  afterAll(teardown);
  const F = (p) => `/api/finance${p}`;
  const structBody = (over = {}) => ({ classId: W.c8._id, name: 'Class 8 Fee', admissionFee: 5000, monthlyFee: 1000, dueDay: 10, autoAssign: false, ...over });
  const admit = async (name) => {
    const adm = await api().post('/api/school/students').set(W.h).send({ name, dob: '2013-09-09', sectionId: W.sec8B._id, admissionDate: '2026-04-15', guardians: [{ name: `Parent of ${name}`, relationship: 'Father', phone: '9876543210' }] });
    return { id: adm.body.student._id, login: await login(adm.body.credentials.loginId, adm.body.credentials.temporaryPassword, 'student') };
  };

  it('Finance defines a fee structure the way schools bill: an admission fee, then tuition every month', async () => {
    expect((await api().post(F('/structures')).set(fin.h).send(structBody({ monthlyFee: 0 }))).status).toBe(400); // tuition is required
    expect((await api().post(F('/structures')).set(fin.h).send(structBody({ dueDay: 40 }))).status).toBe(400);
    expect((await api().post(F('/structures')).set(fin.h).send(structBody({ extras: [{ head: 'Lab', amount: 100, frequency: 'weekly' }] }))).status).toBe(400);
    expect((await api().post(F('/structures')).set(W.teacher1.h).send(structBody())).status).toBe(403);
    structure = (await api().post(F('/structures')).set(fin.h).send(structBody())).body;
    expect(structure.extras).toEqual([]); // no "activities" fee unless the school adds one
    expect((await api().post(F('/structures')).set(fin.h).send(structBody())).status).toBe(409);
    const list = (await api().get(F('/structures')).set(fin.h)).body;
    expect(list[0]).toMatchObject({ name: 'Class 8 Fee', total: 17000, months: 12, admissionFee: 5000, monthlyFee: 1000, className: 'Class 8', students: 0 }); // 5000 + 12 x 1000
    // nobody is billed until the structure is assigned
    expect((await api().get('/api/student/fees').set(W.studentLogins[0].h)).body.charges).toHaveLength(0);
    const a = await api().post(F('/assign')).set(fin.h).send({ structureId: structure._id, all: true });
    expect(a.body).toEqual({ assigned: 3, skipped: 0 });
    expect((await api().post(F('/assign')).set(fin.h).send({ structureId: structure._id, all: true })).body).toEqual({ assigned: 0, skipped: 3 }); // never double-billed
    expect((await api().post(F('/assign')).set(fin.h).send({ structureId: structure._id })).status).toBe(400);
    expect((await api().delete(F(`/structures/${structure._id}`)).set(fin.h)).status).toBe(409); // students have been billed
  });

  it('students see their own fee information, read-only: one admission fee and twelve monthly tuition charges', async () => {
    const fees = (await api().get('/api/student/fees').set(W.studentLogins[0].h)).body;
    // as of 13 Nov 2026: admission (due 15 Apr) and April-November tuition (due on the 10th) are overdue
    expect(fees.totals).toMatchObject({ assigned: 17000, paid: 0, pending: 17000, overdue: 13000, concession: 0 });
    expect(fees.charges).toHaveLength(13);
    expect(fees.charges.filter((c) => c.category === 'Tuition')).toHaveLength(12);
    expect(fees.charges.filter((c) => c.category === 'Admission').map((c) => [c.label, c.amount, c.dueDate])).toEqual([['Admission fee', 5000, '2026-04-15']]);
    const tuition = fees.charges.filter((c) => c.category === 'Tuition');
    expect(tuition[0]).toMatchObject({ label: 'Tuition fee — April 2026', period: '2026-04', amount: 1000, dueDate: '2026-04-10', overdue: true });
    expect(tuition[11]).toMatchObject({ label: 'Tuition fee — March 2027', period: '2027-03', dueDate: '2027-03-10', overdue: false });
    expect(fees.charges.some((c) => /activit/i.test(c.label))).toBe(false);
    expect(fees.categories).toHaveLength(2);
    expect(fees.categories).toEqual(expect.arrayContaining([{ name: 'Admission', total: 5000, paid: 0, months: 0 }, { name: 'Tuition', total: 12000, paid: 0, months: 12 }]));
    expect(fees.totals.nextDue).toBe('2026-04-10');
    expect((await api().post('/api/student/fees').set(W.studentLogins[0].h).send({})).status).toBe(404); // nothing to write
    expect((await api().get('/api/student/dashboard').set(W.studentLogins[0].h)).body.fees).toMatchObject({ pending: 17000, overdue: 13000 });
  });

  it('Finance sees only what it needs: names, classes and money — not marks, attendance or the academic admin area', async () => {
    const d = (await api().get(F('/students')).set(fin.h)).body;
    expect(d.total).toBe(3);
    expect(d.items[0]).toMatchObject({ assigned: 17000, pending: 17000, overdue: 13000, className: 'Class 8', section: 'A' });
    expect(d.totals).toMatchObject({ pending: 51000, overdue: 39000 });
    expect((await api().get(F('/students?status=overdue&q=Aarav')).set(fin.h)).body.items.map((x) => x.name)).toEqual(['Aarav Singh']);
    expect((await api().get(F('/students?status=clear')).set(fin.h)).body.items).toHaveLength(0);
    const acct = (await api().get(F(`/students/${sid}/account`)).set(fin.h)).body;
    expect(acct.student).toMatchObject({ name: 'Aarav Singh', className: 'Class 8', section: 'A' });
    expect(acct.student).not.toHaveProperty('dob');
    expect((await api().get(`/api/school/students/${sid}`).set(fin.h)).status).toBe(403);
    expect((await api().get('/api/teacher/dashboard').set(fin.h)).status).toBe(403);
    // the School Admin has a view-only window
    expect((await api().get('/api/school/finance/dashboard').set(W.h)).status).toBe(200);
    expect((await api().post('/api/school/finance/payments').set(W.h).send({ studentId: sid, amount: 10, mode: 'cash' })).status).toBe(403);
    expect((await api().post('/api/school/finance/structures').set(W.h).send(structBody({ name: 'X' }))).status).toBe(403);
  });

  it('collects payments oldest-due-first with a numbered receipt, validation and a notification', async () => {
    const pay = (body) => api().post(F('/payments')).set(fin.h).send({ studentId: sid, mode: 'cash', ...body });
    expect((await pay({ amount: 0 })).status).toBe(400);
    expect((await pay({ amount: 20000 })).status).toBe(400); // more than owed (advances go through the advance-payment desk)
    expect((await pay({ amount: 100, paidOn: addDays(TODAY, 2) })).status).toBe(400);
    expect((await pay({ amount: 100, mode: 'bitcoin' })).status).toBe(400);
    expect((await api().post(F('/payments')).set(W.studentLogins[0].h).send({ studentId: sid, amount: 100, mode: 'cash' })).status).toBe(403);
    const p1 = (await pay({ amount: 1500, reference: 'cash desk' })).body;
    expect(p1.receiptNo).toMatch(/^RCPT\d{4}00001$/);
    expect(p1.allocations.map((a) => [a.label, a.amount])).toEqual([['Tuition fee — April 2026', 1000], ['Admission fee', 500]]); // oldest due first
    const p2 = (await pay({ amount: 5000, mode: 'upi', reference: 'UPI123' })).body; // finishes the admission fee (4500) and starts May (500)
    expect(p2.receiptNo).toMatch(/00002$/);
    expect(p2.allocations.map((a) => a.amount)).toEqual([4500, 500]);
    const fees = (await api().get('/api/student/fees').set(W.studentLogins[0].h)).body;
    expect(fees.totals).toMatchObject({ paid: 6500, pending: 10500, overdue: 6500 });
    expect(fees.payments).toHaveLength(2);
    expect((await api().get('/api/student/notifications?category=fees').set(W.studentLogins[0].h)).body.items.map((n) => n.title)).toEqual(['Payment received', 'Payment received']);
    // receipts: finance and the student themself — nobody else
    const pdf = (url, h) => api().get(url).set(h).buffer().parse((res, cb) => { const d = []; res.on('data', (x) => d.push(x)); res.on('end', () => cb(null, Buffer.concat(d))); });
    const fr = await pdf(F(`/payments/${p1._id}/receipt.pdf`), fin.h);
    expect(fr.headers['content-type']).toBe('application/pdf');
    expect(fr.body.subarray(0, 4).toString()).toBe('%PDF');
    expect((await pdf(`/api/student/fees/receipts/${p1._id}.pdf`, W.studentLogins[0].h)).status).toBe(200);
    expect((await api().get(`/api/student/fees/receipts/${p1._id}.pdf`).set(W.studentLogins[1].h)).status).toBe(404);
    W.p1 = p1; W.p2 = p2;
  });

  it('concessions need a reason, cannot exceed what is owed, and are recorded on the charge; a scholarship at billing is spread over the months', async () => {
    const acct = (await api().get(F(`/students/${sid2}/account`)).set(fin.h)).body;
    const may = acct.charges.find((c) => c.label === 'Tuition fee — May 2026');
    expect((await api().post(F(`/charges/${may._id}/concession`)).set(fin.h).send({ amount: 500 })).status).toBe(400); // reason required
    expect((await api().post(F(`/charges/${may._id}/concession`)).set(fin.h).send({ amount: 9000, reason: 'Scholarship' })).status).toBe(409);
    const ok = await api().post(F(`/charges/${may._id}/concession`)).set(fin.h).send({ amount: 300, reason: 'Sibling discount' });
    expect(ok.status).toBe(200);
    expect(ok.body.concessions[0]).toMatchObject({ amount: 300, reason: 'Sibling discount', byName: 'Fiona Finance' });
    expect((await api().get('/api/student/fees').set(W.studentLogins[1].h)).body.totals).toMatchObject({ assigned: 17000, concession: 300, pending: 16700 });
    // a 25% merit scholarship given when billing is spread evenly over the twelve tuition months
    const scholar = await admit('Merit Scholar'); W.scholar = scholar;
    expect((await api().post(F('/assign')).set(fin.h).send({ structureId: structure._id, studentIds: [scholar.id], concession: { type: 'percent', value: 25, reason: 'Merit' } })).body).toEqual({ assigned: 1, skipped: 0 });
    const sch = (await api().get(F(`/students/${scholar.id}/account`)).set(fin.h)).body;
    expect(sch.totals).toMatchObject({ assigned: 17000, concession: 3000 });
    expect(sch.charges.filter((c) => c.category === 'Tuition').every((c) => c.net === 750)).toBe(true); // 1000 - 250 each month
    expect(sch.charges.find((c) => c.category === 'Admission').net).toBe(5000); // the scholarship is on tuition, not on admission
  });

  it('a manual charge can be added; payments are never edited or deleted, only reversed with a reason', async () => {
    expect((await api().post(F('/charges')).set(fin.h).send({ studentId: sid, label: 'Lost ID card', amount: 150, dueDate: addDays(TODAY, 7) })).status).toBe(201);
    expect((await api().patch(F(`/payments/${W.p1._id}`)).set(fin.h).send({ amount: 1 })).status).toBe(404); // no edit route
    expect((await api().delete(F(`/payments/${W.p1._id}`)).set(fin.h)).status).toBe(404); // no delete route
    expect((await api().post(F(`/payments/${W.p1._id}/reverse`)).set(fin.h).send({})).status).toBe(400);
    const rev = await api().post(F(`/payments/${W.p1._id}/reverse`)).set(fin.h).send({ reason: 'Cheque bounced' });
    expect(rev.status).toBe(200);
    expect(rev.body.reversal).toMatchObject({ kind: 'reversal', amount: 1500, reversalReason: 'Cheque bounced' });
    expect(rev.body.reversal.receiptNo).not.toBe(W.p1.receiptNo);
    expect((await api().post(F(`/payments/${W.p1._id}/reverse`)).set(fin.h).send({ reason: 'again' })).status).toBe(409);
    const fees = (await api().get('/api/student/fees').set(W.studentLogins[0].h)).body;
    expect(fees.totals).toMatchObject({ paid: 5000, pending: 10500 + 1500 + 150 });
    const list = (await api().get(F('/payments')).set(fin.h)).body;
    const orig = list.find((p) => p._id === W.p1._id);
    expect(orig).toMatchObject({ status: 'reversed', amount: 1500 }); // the receipt is still there, flagged
    expect(list.some((p) => p.kind === 'reversal')).toBe(true);
    expect((await api().get(F('/payments?q=Aarav')).set(fin.h)).body.length).toBeGreaterThanOrEqual(3);
    expect((await api().get(F('/payments?mode=upi')).set(fin.h)).body.every((p) => p.mode === 'upi')).toBe(true);
    expect((await api().get('/api/student/notifications?category=fees').set(W.studentLogins[0].h)).body.items.some((n) => n.title === 'Payment reversed')).toBe(true);
  });

  it('two simultaneous receipts cannot overpay a charge', async () => {
    const owed = (await api().get(F(`/students/${sid}/account`)).set(fin.h)).body.totals.pending;
    const body = { studentId: sid, mode: 'cash', amount: owed };
    const [a, b] = await Promise.all([api().post(F('/payments')).set(fin.h).send(body), api().post(F('/payments')).set(fin.h).send(body)]);
    expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1);
    const t = (await api().get(F(`/students/${sid}/account`)).set(fin.h)).body.totals;
    expect(t.pending).toBe(0);
    const charges = await StudentCharge.find({ studentId: sid }).lean();
    expect(charges.every((c) => c.paidAmount <= c.amount - c.concession + 0.001)).toBe(true);
  });

  it('each school sets its own fee policy: the due day and the pay-the-whole-year discount', async () => {
    expect((await api().get(F('/policy')).set(fin.h)).body).toEqual({ dueDay: 10, advanceDiscount: { enabled: true, minMonths: 12, type: 'months', value: 1 } });
    expect((await api().get('/api/school/finance/policy').set(W.h)).status).toBe(200); // the admin can read it …
    expect((await api().put('/api/school/finance/policy').set(W.h).send({ dueDay: 5, advanceDiscount: { enabled: false, minMonths: 12, type: 'months', value: 1 } })).status).toBe(403); // … not change it
    expect((await api().put(F('/policy')).set(W.teacher1.h).send({})).status).toBe(403);
    expect((await api().put(F('/policy')).set(fin.h).send({ dueDay: 40, advanceDiscount: { enabled: true, minMonths: 12, type: 'months', value: 1 } })).status).toBe(400);
    expect((await api().put(F('/policy')).set(fin.h).send({ dueDay: 10, advanceDiscount: { enabled: true, minMonths: 12, type: 'months', value: 9 } })).status).toBe(400); // at most 6 free months
    expect((await api().put(F('/policy')).set(fin.h).send({ dueDay: 10, advanceDiscount: { enabled: true, minMonths: 12, type: 'percent', value: 150 } })).status).toBe(400);
  });

  it('pay the whole year at once and the school gives a month free; a part-paid student does not qualify', async () => {
    const fresh = await admit('Fresh Payer'); W.fresh = fresh;
    await api().post(F('/assign')).set(fin.h).send({ structureId: structure._id, studentIds: [fresh.id] });
    const plan = (await api().get(F(`/students/${fresh.id}/advance-plan`)).set(fin.h)).body;
    // 12 open tuition months of 1000; the last one is waived. The admission fee is paid separately at admission.
    expect(plan).toMatchObject({ eligible: true, months: 12, tuition: 12000, discount: 1000, payable: 11000, offer: '1 month of tuition free' });
    expect(plan.waived).toMatchObject([{ label: 'Tuition fee — March 2027', amount: 1000 }]);
    expect((await api().get('/api/student/fees').set(fresh.login.h)).body.advanceOffer).toMatchObject({ eligible: true, discount: 1000, payable: 11000 }); // the student can see the offer
    expect((await api().post(F(`/students/${fresh.id}/advance-payment`)).set(W.teacher1.h).send({ mode: 'upi' })).status).toBe(403);
    expect((await api().post(F(`/students/${fresh.id}/advance-payment`)).set(fin.h).send({ mode: 'bitcoin' })).status).toBe(400);
    const paid = await api().post(F(`/students/${fresh.id}/advance-payment`)).set(fin.h).send({ mode: 'upi', reference: 'UPI-YEAR' });
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({ amount: 11000, mode: 'upi' });
    expect(paid.body.allocations).toHaveLength(11);
    const acct = (await api().get(F(`/students/${fresh.id}/account`)).set(fin.h)).body;
    expect(acct.totals).toMatchObject({ concession: 1000, paid: 11000, pending: 5000 }); // only the admission fee is still owed
    const march = acct.charges.find((c) => c.label === 'Tuition fee — March 2027');
    expect(march).toMatchObject({ status: 'paid', concession: 1000 });
    expect(march.concessions[0].reason).toContain('1 month of tuition free');
    expect((await api().get(F(`/students/${fresh.id}/advance-plan`)).set(fin.h)).body).toMatchObject({ eligible: false, reason: 'There are no monthly fees left to pay' });
    expect((await api().post(F(`/students/${fresh.id}/advance-payment`)).set(fin.h).send({ mode: 'cash' })).status).toBe(409); // cannot be claimed twice
    // a student who already paid some months, or has a concession, does not qualify
    expect((await api().get(F(`/students/${sid2}/advance-plan`)).set(fin.h)).body).toMatchObject({ eligible: false, reason: expect.stringMatching(/part-paid or have a concession/) });
    expect((await api().get(F(`/students/${W.scholar.id}/advance-plan`)).set(fin.h)).body.eligible).toBe(false);
  });

  it('the discount follows the school\'s policy: a percentage, a different minimum, or switched off', async () => {
    const other = await admit('Percent Payer');
    await api().post(F('/assign')).set(fin.h).send({ structureId: structure._id, studentIds: [other.id] });
    await api().put(F('/policy')).set(fin.h).send({ dueDay: 10, advanceDiscount: { enabled: true, minMonths: 12, type: 'percent', value: 10 } });
    expect((await api().get(F(`/students/${other.id}/advance-plan`)).set(fin.h)).body).toMatchObject({ eligible: true, discount: 1200, payable: 10800, offer: '10% off tuition' });
    await api().put(F('/policy')).set(fin.h).send({ dueDay: 10, advanceDiscount: { enabled: true, minMonths: 12, type: 'months', value: 2 } });
    expect((await api().get(F(`/students/${other.id}/advance-plan`)).set(fin.h)).body).toMatchObject({ discount: 2000, payable: 10000 });
    await api().put(F('/policy')).set(fin.h).send({ dueDay: 10, advanceDiscount: { enabled: false, minMonths: 12, type: 'months', value: 1 } });
    expect((await api().get(F(`/students/${other.id}/advance-plan`)).set(fin.h)).body).toMatchObject({ eligible: false, reason: 'This school does not offer an advance-payment discount' });
    // back to the default so the remaining tests see the usual policy
    await api().put(F('/policy')).set(fin.h).send({ dueDay: 10, advanceDiscount: { enabled: true, minMonths: 12, type: 'months', value: 1 } });
    expect((await api().get(F('/policy')).set(fin.h)).body.advanceDiscount).toMatchObject({ type: 'months', value: 1 });
  });

  it('a changed due day applies to students billed afterwards', async () => {
    await api().put(F('/policy')).set(fin.h).send({ dueDay: 5, advanceDiscount: { enabled: true, minMonths: 12, type: 'months', value: 1 } });
    const s5 = (await api().post(F('/structures')).set(fin.h).send(structBody({ name: 'Class 8 Fee (5th)', dueDay: undefined, admissionFee: 0, monthlyFee: 500 }))).body;
    const st = await admit('Fifth Payer');
    await api().post(F('/assign')).set(fin.h).send({ structureId: s5._id, studentIds: [st.id] });
    const c = (await api().get(F(`/students/${st.id}/account`)).set(fin.h)).body.charges;
    expect(c[0].dueDate.endsWith('-05')).toBe(true);
    expect(c.some((x) => x.category === 'Admission')).toBe(false); // a structure with no admission fee bills none
    await api().put(F('/policy')).set(fin.h).send({ dueDay: 10, advanceDiscount: { enabled: true, minMonths: 12, type: 'months', value: 1 } });
  });

  it('dashboard, collection report (net of reversals), class outstanding, reminders and CSV exports', async () => {
    const d = (await api().get(F('/dashboard')).set(fin.h)).body;
    expect(typeof d.collectedToday).toBe('number');
    expect(d.studentsBilled).toBeGreaterThanOrEqual(5); expect(d.studentsUnbilled).toBe(0);
    expect(d.defaulters).toBeGreaterThanOrEqual(2);
    expect(d.recent.length).toBeGreaterThan(0);
    const rep = (await api().get(F(`/reports/collection?from=${addDays(TODAY, -5)}&to=${TODAY}`)).set(fin.h)).body;
    expect(rep.byDay.at(-1).date).toBe(TODAY);
    const paidTotal = rep.byMode.reduce((n, m) => n + m.amount, 0);
    expect(paidTotal).toBeCloseTo(rep.total, 2);
    const classes = (await api().get(F('/reports/classes')).set(fin.h)).body;
    expect(classes[0]).toMatchObject({ className: 'Class 8' });
    expect(classes[0].students).toBeGreaterThanOrEqual(5);
    // reminders go to students with overdue money, once per day
    const r1 = (await api().post(F('/reminders')).set(fin.h).send({})).body;
    expect(r1.matched).toBeGreaterThanOrEqual(1);
    expect(r1.sent).toBe(r1.matched);
    expect((await api().post(F('/reminders')).set(fin.h).send({})).body.sent).toBe(0); // deduplicated
    const csv = await api().get(F('/export/dues.csv')).set(fin.h);
    expect(csv.text.split('\n')[0]).toBe('Admission No,Student,Class,Section,Guardian,Phone,Billed,Paid,Pending,Overdue,Next due');
    expect((await api().get(F('/export/payments.csv')).set(fin.h)).text).toContain('RCPT');
    expect((await api().get('/api/school/export/students.csv').set(fin.h)).status).toBe(403);
  });

  it('new admissions are billed automatically by every auto-assign structure of their class; unpaid dues block a casual withdrawal', async () => {
    const auto = (await api().post(F('/structures')).set(fin.h).send(structBody({ name: 'Class 8 Auto', admissionFee: 500, monthlyFee: 100, autoAssign: true }))).body;
    expect(auto.autoAssign).toBe(true);
    const adm = await api().post('/api/school/students').set(W.h).send({ name: 'New Arrival', dob: '2013-09-09', sectionId: W.sec8B._id, guardians: [{ name: 'Parent Name', relationship: 'Father', phone: '9876543210' }] });
    expect(adm.body.billed).toBe(1);
    const nl = await login(adm.body.credentials.loginId, adm.body.credentials.temporaryPassword, 'student');
    // joined mid-year (13 Nov): admission plus tuition for November to March only
    const fees = (await api().get('/api/student/fees').set(nl.h)).body;
    expect(fees.totals).toMatchObject({ assigned: 1000, pending: 1000 });
    expect(fees.charges.filter((c) => c.category === 'Tuition').map((c) => c.period)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02', '2027-03']);
    // withdrawal: dues must be cleared or knowingly overridden
    const nid = adm.body.student._id;
    expect((await api().get(`/api/school/students/${nid}/clearance`).set(W.h)).body).toMatchObject({ clear: false, pendingDues: 1000 });
    const blocked = await api().post(`/api/school/students/${nid}/withdraw`).set(W.h).send({ reason: 'Moving away', outcome: 'withdrawn' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details).toMatchObject({ code: 'CLEARANCE_REQUIRED', pendingDues: 1000 });
    expect((await api().post(`/api/school/students/${nid}/withdraw`).set(W.h).send({ reason: 'Moving away', outcome: 'withdrawn', overrideClearance: true })).status).toBe(200);
    // withdrawn students keep their ledger: the dues are still on record for Finance
    expect((await api().get(F(`/students/${nid}/account`)).set(fin.h)).body.totals.pending).toBe(1000);
  });
});
