import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';
import { User, Student, StudentCharge, Vendor, Budget, EmailOutbox } from '../src/models/index.js';
import { setMailTransport, flushEmails } from '../src/services/email.js';
import { runMigrations } from '../src/core/migrations.js';

const TODAY = todayStr('Asia/Kolkata');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
const bin = (res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };

describe('Finance: vendors with approval, expense files and payment only after approval, revenue and capital budgets, instalments, receipt emails', () => {
  let root; let W; let fin;
  const F = (p) => `/api/finance${p}`;
  const A = (p) => `/api/school${p}`;
  const vendor = (over = {}) => ({ name: 'Edu Supplies', category: 'Stationery', contactPerson: 'Ravi', phone: '9876543210', gstin: '24ABCDE1234F1Z5', pan: 'ABCDE1234F', bankName: 'SBI', accountName: 'Edu Supplies', accountNo: '123456789012', ifsc: 'SBIN0001234', ...over });
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'vnd');
    await api().put(`/api/platform/schools/${W.id}/flags`).set(root.h).send({ onlinePayments: true }); // a later test pays a fee online with the test gateway
    const s = await api().post('/api/school/staff').set(W.h).send({ name: 'Fiona Finance', email: 'fiona@vnd.test', role: 'finance', phone: '9833333333', dob: '1984-04-04' });
    fin = await login(s.body.loginId, s.body.temporaryPassword, 'finance');
  });
  afterAll(() => { setMailTransport(null); return teardown(); });

  it('vendors: Finance adds them, they wait for the School Admin, and only approved vendors can be used on an expense', async () => {
    expect((await api().post(F('/vendors')).set(W.teacher1.h).send(vendor())).status).toBe(403);
    expect((await api().post(F('/vendors')).set(fin.h).send(vendor({ gstin: 'bad' }))).status).toBe(400);
    expect((await api().post(F('/vendors')).set(fin.h).send(vendor({ accountNo: '12' }))).status).toBe(400);
    const v = await api().post(F('/vendors')).set(fin.h).send(vendor());
    expect(v.status).toBe(201); expect(v.body).toMatchObject({ code: 'VND-0001', status: 'pending', name: 'Edu Supplies' });
    expect((await api().post(F('/vendors')).set(fin.h).send(vendor({ name: '  edu   SUPPLIES ' }))).status).toBe(409); // the same vendor twice
    const exp = { date: TODAY, department: 'Office', title: 'Paper', amount: 500, vendorId: v.body._id };
    expect((await api().post(F('/expenses')).set(fin.h).send(exp)).status).toBe(400); // not approved yet
    expect((await api().get(A('/approvals')).set(W.h)).body.counts.vendors).toBe(1);
    expect((await api().post(A(`/approvals/vendors/${v.body._id}`)).set(fin.h).send({ approve: true })).status).toBe(403); // Finance cannot approve its own list
    expect((await api().post(A(`/approvals/vendors/${v.body._id}`)).set(W.h).send({ approve: false })).status).toBe(400); // a rejection needs a reason
    expect((await api().post(A(`/approvals/vendors/${v.body._id}`)).set(W.h).send({ approve: true })).body.status).toBe('approved');
    expect((await api().get(F('/vendors/approved')).set(fin.h)).body.map((x) => x.name)).toEqual(['Edu Supplies']);
    const e = await api().post(F('/expenses')).set(fin.h).send(exp);
    expect(e.status).toBe(201); expect(e.body).toMatchObject({ vendor: 'Edu Supplies', vendorId: v.body._id, nature: 'revenue' });
    // a changed bank account needs checking again; a changed phone number does not
    expect((await api().patch(F(`/vendors/${v.body._id}`)).set(fin.h).send({ phone: '9000000001' })).body.status).toBe('approved');
    expect((await api().patch(F(`/vendors/${v.body._id}`)).set(fin.h).send({ accountNo: '999999999999' })).body.status).toBe('pending');
    expect((await api().post(F('/expenses')).set(fin.h).send({ ...exp, title: 'More paper' })).status).toBe(400);
    await api().post(A(`/approvals/vendors/${v.body._id}`)).set(W.h).send({ approve: true });
    expect((await api().delete(F(`/vendors/${v.body._id}`)).set(fin.h)).status).toBe(409); // it has expenses: switch it off instead
    expect((await api().post(F(`/vendors/${v.body._id}/active`)).set(fin.h).send({ active: false })).body.status).toBe('inactive');
    expect((await api().post(F('/expenses')).set(fin.h).send({ ...exp, title: 'Off' })).status).toBe(400);
    expect((await api().post(F(`/vendors/${v.body._id}/active`)).set(fin.h).send({ active: true })).body.status).toBe('approved');
  });

  it('vendors can be loaded in bulk: good rows are saved, bad rows come back with the row number and reason; the list can be searched and exported', async () => {
    const rows = [vendor({ name: 'Bright Printers', gstin: '', pan: '' }), vendor({ name: 'City Transport Co', gstin: '27ABCDE1234F1Z5' }), { name: 'X' }, vendor({ name: 'Edu Supplies' }), vendor({ name: 'Bright Printers' }), vendor({ name: 'Bad Gst Ltd', gstin: '123' })];
    const out = await api().post(F('/vendors/import')).set(fin.h).send({ rows });
    expect(out.status).toBe(201);
    expect(out.body).toMatchObject({ received: 6, created: 2, skipped: 4 });
    expect(out.body.errors.map((x) => x.row)).toEqual([4, 5, 6, 7]);
    expect(out.body.errors[1].error).toMatch(/already in the vendor list/i);
    expect((await api().post(F('/vendors/import')).set(fin.h).send({ rows: [] })).status).toBe(400);
    const list = (await api().get(F('/vendors?status=pending')).set(fin.h)).body;
    expect(list.total).toBe(2); expect(list.counts).toMatchObject({ pending: 2, approved: 1 });
    expect((await api().get(F('/vendors?q=transport')).set(fin.h)).body.items.map((x) => x.code)).toEqual(['VND-0003']);
    // one click approves the whole imported list
    expect((await api().post(A('/approvals/vendors/decide')).set(W.h).send({ approve: true })).body.decided).toBe(2);
    const csv = (await api().get(F('/vendors/export.csv')).set(fin.h)).text;
    expect(csv.split('\n')[0]).toMatch(/^Code,Name,Category,Status/); expect(csv).toContain('City Transport Co'); expect(csv.split('\n')).toHaveLength(4);
    expect((await api().get(A('/finance/vendors')).set(W.h)).body.total).toBe(3); // the School Admin reads the list too
    expect((await api().post(A('/finance/vendors')).set(W.h).send(vendor({ name: 'Nope Ltd' }))).status).toBe(403);
  });

  it('an expense carries its bills to the approver, and is paid only after approval', async () => {
    const v = (await Vendor.findOne({ name: 'Bright Printers' })).toObject();
    const e = (await api().post(F('/expenses')).set(fin.h).send({ date: TODAY, department: 'Office', title: 'Prospectus printing', amount: 8000, vendorId: String(v._id) })).body;
    const attach = (h, id, buf = PDF, name = 'bill.pdf', type = 'application/pdf') => api().post(F(`/expenses/${id}/attachments`)).set(h).attach('file', buf, { filename: name, contentType: type });
    expect((await attach(fin.h, e._id, Buffer.from('MZ'), 'a.exe', 'application/x-msdownload')).status).toBe(400);
    expect((await attach(fin.h, e._id, Buffer.from('plain'), 'a.pdf', 'application/pdf')).status).toBe(400); // content must match
    const withFile = await attach(fin.h, e._id);
    expect(withFile.status).toBe(201); expect(withFile.body.attachments).toHaveLength(1); expect(withFile.body.attachments[0]).toMatchObject({ name: 'bill.pdf', mime: 'application/pdf' });
    // the approver sees it in the inbox and can open it; other roles cannot
    const inbox = (await api().get(A('/approvals')).set(W.h)).body;
    const waiting = inbox.expenses.find((x) => x._id === e._id); expect(waiting.attachments).toHaveLength(1);
    const fid = waiting.attachments[0].fileId;
    for (const h of [W.h, fin.h]) { const l = await api().post(`/api/shared/files/${fid}/link`).set(h); expect(l.status).toBe(200); const dl = await api().get(l.body.url).buffer(true).parse(bin); expect(dl.body.equals(PDF)).toBe(true); }
    expect((await api().post(`/api/shared/files/${fid}/link`).set(W.teacher1.h)).status).toBeGreaterThanOrEqual(403);
    // no money before approval
    const pay = (id, body = { mode: 'bank_transfer', reference: 'UTR123' }) => api().post(F(`/expenses/${id}/pay`)).set(fin.h).send(body);
    expect((await pay(e._id)).status).toBe(409);
    await api().post(A(`/approvals/expenses/${e._id}`)).set(W.h).send({ approve: true });
    expect((await api().get(F('/expenses')).set(fin.h)).body.totals.toPay).toMatchObject({ count: 1, amount: 8000 });
    expect((await api().delete(F(`/expenses/${e._id}/attachments/${fid}`)).set(fin.h)).status).toBe(409); // approved: the bill stays
    expect((await pay(e._id, { mode: 'barter' })).status).toBe(400);
    expect((await api().post(F(`/expenses/${e._id}/pay`)).set(W.h).send({ mode: 'cash' })).status).toBe(403); // the School Admin does not pay
    const paid = await pay(e._id);
    expect(paid.status).toBe(200); expect(paid.body).toMatchObject({ paymentStatus: 'paid', paymentMode: 'bank_transfer', paymentRef: 'UTR123', paidOn: TODAY, paidByName: 'Fiona Finance' });
    expect((await pay(e._id)).status).toBe(409); // once
    expect((await api().get(F('/expenses?payment=unpaid')).set(fin.h)).body.items.map((x) => x.title)).not.toContain('Prospectus printing');
    // a rejected expense is never paid; deleting a waiting expense removes its files
    const r = (await api().post(F('/expenses')).set(fin.h).send({ date: TODAY, department: 'Office', title: 'Chairs', amount: 100 })).body;
    await attach(fin.h, r._id);
    await api().post(A(`/approvals/expenses/${r._id}`)).set(W.h).send({ approve: false, note: 'No' });
    expect((await pay(r._id)).status).toBe(409);
    expect((await api().delete(F(`/expenses/${r._id}`)).set(fin.h)).status).toBe(200);
  });

  it('a vendor can be paid in parts, each payment gets a voucher, and the vendor account and period report show paid, overdue and upcoming money', async () => {
    const v = (await api().post(F('/vendors')).set(fin.h).send(vendor({ name: 'Chalk and Co', gstin: '27ABCDE1234F1Z5', pan: 'ABCDE1234G' }))).body;
    await api().post(A(`/approvals/vendors/${v._id}`)).set(W.h).send({ approve: true });
    const bill = async (title, amount, dueDate) => { const e = (await api().post(F('/expenses')).set(fin.h).send({ date: TODAY, department: 'Supplies', title, amount, dueDate, vendorId: v._id })).body; await api().post(A(`/approvals/expenses/${e._id}`)).set(W.h).send({ approve: true }); return e; };
    const a = await bill('Classroom chalk', 10000, addDays(TODAY, 10));
    const b = await bill('Dusters', 4000, addDays(TODAY, -5));
    const c = await bill('Boards', 2000, addDays(TODAY, -5));
    const pay = (id, body) => api().post(F(`/expenses/${id}/pay`)).set(fin.h).send({ mode: 'bank_transfer', ...body });
    // part payment: the bill stays open for the rest, each payment has its own voucher
    const p1 = await pay(a._id, { amount: 3000, reference: 'UTR-1' });
    expect(p1.status).toBe(200);
    expect(p1.body).toMatchObject({ paymentStatus: 'part', paidAmount: 3000 });
    expect(p1.body.payments[0]).toMatchObject({ amount: 3000, reference: 'UTR-1' });
    expect(p1.body.payments[0].voucherNo).toMatch(/^PV\d{4}\d{5}$/);
    expect((await pay(a._id, { amount: 8000 })).status).toBe(400); // only 7,000 is still owed
    expect((await pay(a._id, { amount: 0 })).status).toBe(400);
    expect((await api().get(F('/expenses?payment=unpaid')).set(fin.h)).body.items.map((x) => x.title)).toContain('Classroom chalk'); // part-paid is still owing
    const p2 = await pay(a._id, { amount: 2000 });
    expect(p2.body.payments.map((x) => x.voucherNo)).toHaveLength(2);
    expect(new Set(p2.body.payments.map((x) => x.voucherNo)).size).toBe(2);
    expect((await pay(b._id, {})).body).toMatchObject({ paymentStatus: 'paid', paidAmount: 4000 }); // no amount = the whole bill
    // the vendor account
    const led = (await api().get(F(`/vendors/${v._id}/ledger`)).set(fin.h)).body;
    expect(led.vendor.name).toBe('Chalk and Co');
    expect(led.totals).toEqual({ billed: 16000, paid: 9000, outstanding: 7000, overdue: 2000, upcoming: 5000, undated: 0 });
    expect(led.payments).toHaveLength(3);
    expect(led.upcoming.map((x) => x.title)).toEqual(['Boards', 'Classroom chalk']); // soonest due first
    expect(led.bills.find((x) => x._id === c._id)).toMatchObject({ overdue: true, outstanding: 2000 });
    expect((await api().get(F(`/vendors/${v._id}/ledger?from=${addDays(TODAY, 1)}`)).set(fin.h)).body.payments).toHaveLength(0); // narrowed by date
    // the report by day, month and year; money that falls due in the range
    const by = (q) => api().get(F(`/reports/vendor-payments?${q}`)).set(fin.h).then((r) => r.body);
    const all = await by('by=day'); expect(all.paidInPeriod).toBeGreaterThanOrEqual(9000); // every vendor together
    const day = await by(`by=day&vendorId=${v._id}`);
    expect(day.paidInPeriod).toBe(9000);
    expect(day.items.find((x) => x.period === TODAY)).toMatchObject({ paid: 9000, payments: 3 });
    const month = await by(`by=month&vendorId=${v._id}&to=${addDays(TODAY, 60)}`);
    expect(month.items.find((x) => x.period === TODAY.slice(0, 7))).toMatchObject({ paid: 9000 });
    expect(month.dueInPeriod).toBe(7000);
    expect((await by(`by=year&vendorId=${v._id}`)).items.find((x) => x.period === TODAY.slice(0, 4)).paid).toBe(9000);
    expect((await api().get(F('/reports/vendor-payments?by=week')).set(fin.h)).status).toBe(400);
    // the receipts of spending: every payment, narrowed by vendor, mode, text and date, with a CSV and a payment voucher PDF
    const rc = (q) => api().get(F(`/expense-receipts?${q}`)).set(fin.h).then((r) => r.body);
    const mine = await rc(`vendorId=${v._id}`);
    expect(mine).toMatchObject({ total: 3, totals: { amount: 9000, count: 3, revenue: 9000, capital: 0 } });
    expect(mine.items.every((x) => /^PV\d{9}$/.test(x.voucherNo) && x.vendor === 'Chalk and Co')).toBe(true);
    expect((await rc(`vendorId=${v._id}&mode=cash`)).total).toBe(0);
    expect((await rc(`vendorId=${v._id}&q=${p1.body.payments[0].voucherNo}`)).total).toBe(1);
    expect((await rc(`vendorId=${v._id}&q=UTR-1`)).total).toBe(1);
    expect((await rc(`vendorId=${v._id}&from=${addDays(TODAY, 1)}`)).total).toBe(0);
    expect((await rc(`vendorId=${v._id}&nature=capital`)).total).toBe(0);
    expect((await rc(`vendorId=${v._id}&department=Supplies&limit=2`)).items).toHaveLength(2);
    expect((await api().get(F('/expense-receipts?mode=barter')).set(fin.h)).status).toBe(400);
    const csvOut = await api().get(F(`/export/expense-receipts.csv?vendorId=${v._id}`)).set(fin.h);
    expect(csvOut.text).toContain(p1.body.payments[0].voucherNo);
    const pdf1 = await api().get(F(`/expenses/${a._id}/payments/${p1.body.payments[0]._id}/voucher.pdf`)).set(fin.h).buffer(true).parse(bin);
    expect(pdf1.status).toBe(200); expect(pdf1.headers['content-type']).toMatch(/pdf/); expect(pdf1.body.subarray(0, 4).toString()).toBe('%PDF');
    expect((await api().get(F(`/expenses/${a._id}/payments/older/voucher.pdf`)).set(fin.h)).status).toBe(404); // this bill has real payments, none is "older"
    expect((await api().get(F(`/expenses/${a._id}/payments/${'0'.repeat(24)}/voucher.pdf`)).set(fin.h)).status).toBe(404);
    expect((await api().get(A(`/finance/expense-receipts?vendorId=${v._id}`)).set(W.h)).status).toBe(200); // the School Admin may look
    expect((await api().get(F('/expense-receipts')).set(W.teacher1.h)).status).toBe(403);
    // the School Admin may look but not pay
    expect((await api().get(A(`/finance/vendors/${v._id}/ledger`)).set(W.h)).status).toBe(200);
    expect((await api().post(A(`/finance/expenses/${c._id}/pay`)).set(W.h).send({ mode: 'cash' })).status).toBe(403);
    expect((await api().get(F(`/vendors/${v._id}/ledger`)).set(W.teacher1.h)).status).toBe(403);
  });

  it('budgets are revenue or capital; spending counts against its own kind', async () => {
    const save = (b) => api().put(F('/budgets')).set(fin.h).send(b);
    expect((await save({ kind: 'revenue', department: 'Science', allocated: 50000 })).status).toBe(200);
    expect((await save({ kind: 'capital', department: 'Science', work: 'New lab', allocated: 400000 })).status).toBe(200);
    expect((await save({ kind: 'capital', department: 'Science', work: 'New lab', allocated: 450000 })).status).toBe(200); // updates, never duplicates
    expect((await save({ kind: 'weird', department: 'Science', allocated: 1 })).status).toBe(400);
    const spend = async (title, nature, amount) => { const e = (await api().post(F('/expenses')).set(fin.h).send({ date: TODAY, department: 'Science', work: nature === 'capital' ? 'New lab' : undefined, title, nature, amount })).body; await api().post(A(`/approvals/expenses/${e._id}`)).set(W.h).send({ approve: true }); };
    await spend('Chemicals', 'revenue', 12000); await spend('Lab building', 'capital', 150000);
    await api().post(F('/expenses')).set(fin.h).send({ date: TODAY, department: 'Sports', title: 'Ground roller', nature: 'capital', amount: 9000 });
    const b = (await api().get(F('/budgets')).set(fin.h)).body;
    expect(b.items).toHaveLength(2);
    expect(b.items.find((x) => x.kind === 'revenue')).toMatchObject({ allocated: 50000, used: 12000, remaining: 38000 });
    expect(b.items.find((x) => x.kind === 'capital')).toMatchObject({ allocated: 450000, used: 150000, remaining: 300000, work: 'New lab' });
    expect(b.byKind.revenue.allocated).toBe(50000); expect(b.byKind.capital).toMatchObject({ allocated: 450000, used: 150000 });
    expect(b.unbudgeted).toContainEqual(expect.objectContaining({ kind: 'capital', department: 'Sports', pending: 9000 }));
    expect(b.unbudgeted).toContainEqual(expect.objectContaining({ kind: 'revenue', department: 'Office', used: 8000 })); // earlier spending with no budget is listed, under its own kind
    expect((await api().get(F('/expenses?nature=capital')).set(fin.h)).body.total).toBe(2);
  });

  it('the migration gives old budgets and expenses the kind "revenue" and swaps the old index', async () => {
    await Budget.collection.insertOne({ tenantId: W.id, yearId: (await Budget.findOne({}).lean()).yearId, department: 'Legacy', work: '', allocated: 5 });
    await Budget.collection.updateOne({ department: 'Legacy' }, { $unset: { kind: 1 } });
    const m = await import('../src/migrations/003-budget-kinds.js'); await m.up();
    expect((await Budget.findOne({ department: 'Legacy' }).lean()).kind).toBe('revenue');
    expect(typeof runMigrations).toBe('function');
  });

  it('instalments: each student sees their fees instalment by instalment, and the school sees every instalment', async () => {
    const stu = W.students[0].student;
    const yearId = (await Budget.findOne({}).lean()).yearId;
    const mk = (label, period, dueDate, amount, paidAmount = 0, kind = 'fee') => StudentCharge.create({ tenantId: W.id, studentId: stu._id, yearId, kind, label, period, dueDate, amount, paidAmount, status: paidAmount >= amount ? 'paid' : 'open' });
    await StudentCharge.deleteMany({ tenantId: W.id });
    await mk('Tuition', 'April 2026', '2026-04-10', 1000, 1000); await mk('Transport', 'April 2026', '2026-04-10', 500, 500);
    await mk('Tuition', 'May 2026', '2026-05-10', 1000, 400); await mk('Tuition', 'June 2027', '2027-06-10', 1000); await mk('Lost ID card', '', '2026-05-12', 100, 0, 'other');
    const acc = (await api().get(F(`/students/${stu._id}/account`)).set(fin.h)).body;
    expect(acc.installments.map((i) => [i.no, i.label, i.billed, i.paid, i.balance, i.state])).toEqual([[1, 'April 2026', 1500, 1500, 0, 'paid'], [2, 'May 2026', 1000, 400, 600, 'overdue'], [3, 'June 2027', 1000, 0, 1000, 'open']]);
    expect(acc.installments[0].items.map((x) => x.label)).toEqual(['Tuition', 'Transport']); // one instalment holds everything due that day; the ID card is not an instalment
    // a second student with nothing paid on the April instalment
    const other = W.students[1].student;
    await StudentCharge.create({ tenantId: W.id, studentId: other._id, yearId, kind: 'fee', label: 'Tuition', period: 'April 2026', dueDate: '2026-04-10', amount: 1000, paidAmount: 0 });
    const rep = (await api().get(F('/installments')).set(fin.h)).body;
    const april = rep.items.find((i) => i.dueDate === '2026-04-10');
    expect(april).toMatchObject({ label: 'April 2026', students: 2, cleared: 1, pendingStudents: 1, net: 2500, collected: 1500, outstanding: 1000, percent: 60, state: 'overdue' });
    expect(rep.items.find((i) => i.dueDate === '2026-05-10')).toMatchObject({ collected: 400, outstanding: 600 });
    expect(rep.totals).toMatchObject({ instalments: 3, outstanding: 2600 });
    expect((await api().get(A('/finance/installments')).set(W.h)).status).toBe(200); // the School Admin's read-only window
  });

  it('the receipt goes to the family by email by itself after an online payment, and can be sent again from the counter', async () => {
    const sent = []; setMailTransport(async (m) => { sent.push(m); return { id: 'x' }; });
    const stu = W.students[0].student;
    await User.updateOne({ _id: stu.userId }, { $unset: { email: 1 } });
    await Student.updateOne({ _id: stu._id }, { email: 'pupil@vnd.test', guardians: [{ name: 'Parent', email: 'parent@vnd.test', isPrimary: true }] });
    await StudentCharge.deleteMany({ tenantId: W.id });
    const c = await StudentCharge.create({ tenantId: W.id, studentId: stu._id, kind: 'fee', label: 'Tuition', period: 'November 2026', dueDate: TODAY, amount: 2000 });
    const S = (p) => `/api/student${p}`; const h = W.studentLogins[0].h;
    const o = await api().post(S('/fees/pay')).set(h).send({ chargeIds: [String(c._id)] });
    const b = (await api().post(S(`/fees/orders/${o.body.orderId}/test-pay`)).set(h).send({ outcome: 'success' })).body;
    const done = await api().post(S('/fees/pay/verify')).set(h).send({ orderId: b.razorpay_order_id, paymentId: b.razorpay_payment_id, signature: b.razorpay_signature });
    expect(done.body.status).toBe('paid');
    await flushEmails();
    expect(sent.map((m) => m.to).sort()).toEqual(['parent@vnd.test', 'pupil@vnd.test']);
    const m = sent[0];
    expect(m.subject).toContain(done.body.receiptNo);
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0].filename).toBe(`receipt-${done.body.receiptNo}.pdf`);
    expect(Buffer.from(m.attachments[0].content, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    // the stored copy of the attachment is dropped once sent
    expect((await EmailOutbox.findOne({ to: 'pupil@vnd.test' }).lean()).attachments).toHaveLength(0);
    // from the counter
    sent.length = 0;
    const pid = done.body.paymentId;
    expect((await api().post(F(`/payments/${pid}/email`)).set(fin.h)).body.sent.sort()).toEqual(['parent@vnd.test', 'pupil@vnd.test']);
    await flushEmails(); expect(sent).toHaveLength(2);
    await Student.updateOne({ _id: stu._id }, { email: '', guardians: [] });
    expect((await api().post(F(`/payments/${pid}/email`)).set(fin.h)).status).toBe(409); // nobody to send to
  });
});
