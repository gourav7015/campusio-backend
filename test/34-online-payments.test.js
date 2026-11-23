import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { config } from '../src/core/config.js';
import { StudentCharge, Payment, PaymentOrder } from '../src/models/index.js';
import { mockGateway } from '../src/services/gateway/index.js';
import { checkoutSignature, webhookSignature, readWebhook } from '../src/services/gateway/signing.js';
import { tidyOrders } from '../src/modules/payments/payments.service.js';

describe('Online fee payment with the test gateway (no Razorpay account needed)', () => {
  let root; let W; let fin; let A; let B; let structure;
  const S = (p) => `/api/student${p}`;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'pay');
    const s = await api().post('/api/school/staff').set(W.h).send({ name: 'Fiona Finance', email: 'fiona@pay.test', role: 'finance', phone: '9833333333', dob: '1984-04-04' });
    fin = await login(s.body.loginId, s.body.temporaryPassword, 'finance');
    structure = (await api().post('/api/finance/structures').set(fin.h).send({ classId: W.c8._id, name: 'Class 8 Fee', admissionFee: 5000, monthlyFee: 1000, dueDay: 10, autoAssign: false })).body;
    await api().post('/api/finance/assign').set(fin.h).send({ structureId: structure._id, all: true });
    A = W.studentLogins[0].h; B = W.studentLogins[1].h;
  });
  afterAll(teardown);

  /** Play the bank: start a payment and return what the browser would get back after paying. */
  const start = async (h = A, body = {}) => api().post(S('/fees/pay')).set(h).send(body);
  const pay = async (h, orderId, outcome = 'success') => api().post(S(`/fees/orders/${orderId}/test-pay`)).set(h).send({ outcome });
  const verify = (h, r) => api().post(S('/fees/pay/verify')).set(h).send({ orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature });

  it('the fee page says online payment is available and in test mode', async () => {
    const f = (await api().get(S('/fees')).set(A)).body;
    expect(f.online).toMatchObject({ enabled: true, provider: 'mock', testMode: true });
  });

  it('a student pays one due: the server fixes the amount, and a normal receipt is issued', async () => {
    const fees = (await api().get(S('/fees')).set(A)).body;
    const admission = fees.charges.find((c) => c.category === 'Admission');
    const o = await start(A, { chargeIds: [admission.id] });
    expect(o.status).toBe(201);
    expect(o.body).toMatchObject({ amount: 5000, amountPaise: 500000, currency: 'INR', provider: 'mock', testMode: true });
    expect(o.body.providerOrderId).toMatch(/^order_mock_/);
    // asking again for the same dues gives the same order (no double orders)
    expect((await start(A, { chargeIds: [admission.id] })).body.orderId).toBe(o.body.orderId);
    const browser = (await pay(A, o.body.orderId, 'success')).body;
    expect(browser.razorpay_signature).toBeTruthy();
    const done = await verify(A, browser);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'paid', amount: 5000 });
    expect(done.body.receiptNo).toMatch(/^RCPT/);
    const after = (await api().get(S('/fees')).set(A)).body;
    expect(after.totals.paid).toBe(5000);
    expect(after.charges.find((c) => c.category === 'Admission')).toMatchObject({ status: 'paid', outstanding: 0 });
    expect(after.payments[0]).toMatchObject({ amount: 5000, mode: 'online', receiptNo: done.body.receiptNo });
    // the browser telling us twice, and the webhook arriving afterwards, change nothing
    expect((await verify(A, browser)).body.status).toBe('paid');
    const w = mockGateway.makeWebhook('payment.captured', { orderId: browser.razorpay_order_id, paymentId: browser.razorpay_payment_id, amountPaise: 500000 });
    expect((await request(await appOf()).post('/api/payments/webhook').set('x-razorpay-signature', w.signature).set('content-type', 'application/json').send(w.raw)).status).toBe(200);
    expect(await Payment.countDocuments({ studentId: W.students[0].student._id, mode: 'online' })).toBe(1);
    // the school's own receipt PDF works for it, and finance sees it in the ledger and the online list
    expect((await api().get(S(`/fees/receipts/${after.payments[0].id}.pdf`)).set(A)).status).toBe(200);
    const online = (await api().get('/api/finance/online-payments').set(fin.h)).body;
    expect(online.counts.paid).toBe(1);
    expect(online.orders.find((x) => x.status === 'paid')).toMatchObject({ amount: 5000, student: { name: expect.any(String) } });
  });

  it('with no dues chosen, everything outstanding is paid; the amount can never come from the browser', async () => {
    const o = await start(B, { amount: 1, chargeIds: undefined });
    expect(o.status).toBe(201);
    expect(o.body.amount).toBe(17000); // 5000 + 12 x 1000, whatever the browser sent
    expect((await start(B, { chargeIds: ['0'.repeat(24)] })).status).toBe(400); // not this student's dues
    const mine = (await api().get(S('/fees')).set(A)).body.charges.map((c) => c.id);
    expect((await start(B, { chargeIds: [mine[3]] })).status).toBe(400); // another student's dues
  });

  it('a signature that does not match is refused and nothing is paid', async () => {
    const o = (await start(B)).body;
    const good = (await pay(B, o.orderId, 'success')).body;
    const forged = { ...good, razorpay_signature: checkoutSignature('not-the-secret', good.razorpay_order_id, good.razorpay_payment_id) };
    expect((await verify(B, forged)).status).toBe(400);
    expect((await verify(B, { ...good, razorpay_payment_id: 'pay_mock_other' })).status).toBe(400); // a real signature for a different payment id
    expect(await PaymentOrder.countDocuments({ _id: o.orderId, status: 'paid' })).toBe(0);
    expect((await verify(A, good)).status).toBe(404); // another student cannot settle it
    expect((await api().get(S(`/fees/orders/${o.orderId}`)).set(A)).status).toBe(404);
    expect((await api().get(S(`/fees/orders/${o.orderId}`)).set(B)).body.status).toBe('created');
  });

  it('the browser may be closed after paying: the signed webhook alone settles it', async () => {
    const o = (await start(B, { chargeIds: [(await api().get(S('/fees')).set(B)).body.charges.find((c) => c.category === 'Admission').id] })).body;
    expect((await pay(B, o.orderId, 'webhook_only')).body).toEqual({ delivered: true });
    const s = (await api().get(S(`/fees/orders/${o.orderId}`)).set(B)).body;
    expect(s.status).toBe('paid'); expect(s.receiptNo).toBeTruthy();
  });

  it('webhooks: a wrong or missing signature is refused; unknown orders and other events are acknowledged and ignored', async () => {
    const app = await appOf();
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: 'order_mock_nope', amount: 100 } } } });
    const post = (sig, raw = body) => request(app).post('/api/payments/webhook').set('content-type', 'application/json').set(sig ? { 'x-razorpay-signature': sig } : {}).send(raw);
    expect((await post(undefined)).status).toBe(400);
    expect((await post('deadbeef')).status).toBe(400);
    expect((await post(webhookSignature('wrong-secret', body))).status).toBe(400);
    const ok = await post(webhookSignature(config.payments.mockSecret, body));
    expect(ok.status).toBe(200); expect(ok.body.ignored).toBe(true);
    const other = JSON.stringify({ event: 'refund.created', payload: {} });
    expect((await post(webhookSignature(config.payments.mockSecret, other), other)).body.ignored).toBe(true);
    expect(readWebhook({ event: 'order.paid', payload: { order: { entity: { id: 'o1', amount_paid: 500 } }, payment: { entity: { id: 'p1' } } } })).toMatchObject({ type: 'paid', orderId: 'o1', paymentId: 'p1' });
  });

  it('a declined payment leaves nothing paid and the person can try again', async () => {
    const C = W.studentLogins[2].h;
    const o = (await start(C)).body;
    const r = await pay(C, o.orderId, 'failure');
    expect(r.body).toMatchObject({ failed: true });
    const s = (await api().get(S(`/fees/orders/${o.orderId}`)).set(C)).body;
    expect(s).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('declined') });
    expect((await api().get(S('/fees')).set(C)).body.totals.paid).toBe(0);
    expect((await start(C)).status).toBe(201); // a new attempt
    const retried = (await pay(C, o.orderId, 'success')).body; // the first order can still be paid (Razorpay allows a retry on the same order)
    expect((await verify(C, retried)).body.status).toBe('paid');
  });

  it('if the dues changed after the order (cash taken at the desk), the money is flagged for finance, not lost or double-counted', async () => {
    const stu = W.students[1].student;
    const D = B; // B's earlier full-amount order is still open
    const o = (await start(D, { chargeIds: (await api().get(S('/fees')).set(D)).body.charges.filter((c) => c.category === 'Tuition' && c.status === 'open').slice(0, 2).map((c) => c.id) })).body;
    // the office takes the same dues in cash first
    const due = (await api().get(S('/fees')).set(D)).body.charges.filter((c) => c.category === 'Tuition' && c.status === 'open').slice(0, 2).map((c) => c.id);
    const cash = await api().post('/api/finance/payments').set(fin.h).send({ studentId: stu._id, amount: 2000, mode: 'cash', chargeIds: due });
    expect(cash.status).toBe(201);
    const r = (await pay(D, o.orderId, 'success')).body;
    const out = await verify(D, r);
    expect(out.status).toBe(200);
    expect(out.body.status).toBe('needs_review');
    expect(await Payment.countDocuments({ studentId: stu._id, mode: 'online' })).toBe(1); // only the earlier genuine online payment
    const online = (await api().get('/api/finance/online-payments?status=needs_review').set(fin.h)).body;
    expect(online.orders).toHaveLength(1); expect(online.orders[0].note).toMatch(/Money received/);
  });

  it('limits and switches: too large is refused, nothing outstanding is refused, orders time out, and it can be switched off', async () => {
    const E = W.studentLogins[2].h; // C paid everything above
    expect((await start(E)).status).toBe(409);
    const was = config.payments.maxAmount;
    config.payments.maxAmount = 100;
    const F = W.studentLogins[0].h;
    const big = await start(F);
    expect(big.status).toBe(400); expect(big.body.error).toMatch(/limited to/);
    config.payments.maxAmount = was;
    const o = (await start(F)).body;
    await PaymentOrder.collection.updateOne({ _id: new (await import('mongoose')).default.Types.ObjectId(o.orderId) }, { $set: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) } }); // timestamps cannot be rewritten through the model
    expect(await tidyOrders()).toBeGreaterThanOrEqual(1);
    expect((await api().get(S(`/fees/orders/${o.orderId}`)).set(F)).body.status).toBe('expired');
    config.payments.provider = 'off';
    try {
      expect((await start(F)).status).toBe(409);
      expect((await api().get(S('/fees')).set(F)).body.online.enabled).toBe(false);
      expect((await api().post(S(`/fees/orders/${o.orderId}/test-pay`)).set(F).send({ outcome: 'success' })).status).toBe(404); // the test window does not exist when the gateway is off
      const body = JSON.stringify({ event: 'payment.captured', payload: {} });
      expect((await request(await appOf()).post('/api/payments/webhook').set('content-type', 'application/json').set('x-razorpay-signature', webhookSignature(config.payments.mockSecret, body)).send(body)).status).toBe(404);
    } finally { config.payments.provider = 'mock'; }
  });

  it('only students pay; teachers and staff cannot, and a platform admin cannot', async () => {
    expect((await api().post(S('/fees/pay')).set(W.teacher1.h).send({})).status).toBe(403);
    expect((await api().post(S('/fees/pay')).set(fin.h).send({})).status).toBe(403);
    expect((await api().post(S('/fees/pay')).send({})).status).toBe(401);
    expect((await api().get('/api/finance/online-payments').set(A)).status).toBe(403);
    expect((await api().get('/api/school/finance/online-payments').set(W.h)).status).toBe(200); // the School Admin may look
    expect((await api().get('/api/finance/online-payments').set(W.h)).status).toBe(403);
  });

  it('the test gateway can never be switched on in production', async () => {
    const { execFileSync } = await import('node:child_process');
    const run = (env) => { try { execFileSync('node', ['-e', "import('./src/core/config.js').then(()=>console.log('LOADED'))"], { env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(48), CORS_ORIGIN: 'https://app.example.com', ...env }, stdio: 'pipe' }); return 'LOADED'; } catch (e) { return String(e.stderr); } };
    expect(run({ PAYMENT_PROVIDER: 'mock' })).toMatch(/not allowed in production/);
    expect(run({ PAYMENT_PROVIDER: 'razorpay' })).toMatch(/RAZORPAY_KEY_ID/);
    expect(run({ PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'rzp_test_1', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' })).toBe('LOADED');
    expect(run({})).toBe('LOADED'); // default in production is off
  });
});

async function appOf() { const { createApp } = await import('../src/app.js'); return createApp(); }
