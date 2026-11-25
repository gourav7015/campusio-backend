import { flagOn } from '../../services/flags.js';
import mongoose from 'mongoose';
import { PaymentOrder, StudentCharge, Student } from '../../models/index.js';
import { gateway } from '../../services/gateway/index.js';
import { readWebhook } from '../../services/gateway/signing.js';
import { collectPayment, outstanding, emailReceipt } from '../finance/finance.service.js';
import { schoolToday } from '../../services/context.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { bad, conflict, notFound, HttpError, round2 } from '../../core/utils.js';

/**
 * Online fee payment. The flow is the same for the test gateway and for Razorpay:
 *   1. startPayment      the server works out the amount from the student's open dues and asks the gateway for an order
 *   2. the person pays   (Razorpay's checkout window, or our test window)
 *   3. verifyCheckout    the browser hands back a signed result, which we verify before believing it
 *   3b. handleWebhook    the gateway also tells us by itself (a signed webhook), in case the browser was closed
 *   4. settle            exactly once, whichever of 3 and 3b arrives first: the normal receipt is issued and the dues are cleared
 */
const HOUR = 60 * 60 * 1000;
const paise = (rupees) => Math.round(rupees * 100);

/** What the student's fee page needs to know about online payment. */
/** Online payment is available for a school only when its feature switch is on (it is off unless the Platform Admin turns it on), the school has not turned it off, and a gateway is configured. */
export const onlineEnabled = (settings) => !!gateway() && flagOn(settings, 'onlinePayments') && settings?.finance?.onlinePayments !== false;

export function onlineInfo(ctx) {
  const gw = gateway();
  const on = onlineEnabled(ctx.settings);
  return { enabled: on, provider: on ? gw.name : null, testMode: on ? !!gw.publicInfo().testMode : false, maxAmount: config.payments.maxAmount };
}

export const orderView = (o) => ({
  id: o._id, status: o.status, amount: o.amount, receiptNo: o.receiptNo, paymentId: o.paymentId, failureReason: o.failureReason, note: o.note,
  paidAt: o.paidAt, createdAt: o.createdAt, provider: o.provider,
});

// ───────────── 1. start ─────────────
export async function startPayment(ctx, student, { chargeIds }) {
  const gw = gateway();
  if (!gw || !onlineInfo(ctx).enabled) throw conflict('Online payment is not available yet. Please pay at the school office.');
  const filter = { tenantId: ctx.tenantId, studentId: student._id, status: 'open', ...(chargeIds?.length ? { _id: { $in: chargeIds } } : {}) };
  const charges = (await StudentCharge.find(filter).lean()).filter((c) => outstanding(c) > 0);
  if (chargeIds?.length && charges.length !== new Set(chargeIds).size) throw bad('Some of these dues are already paid. Please refresh the page.');
  if (!charges.length) throw conflict('You have nothing outstanding to pay.');
  const amount = round2(charges.reduce((n, c) => n + outstanding(c), 0));
  if (amount > config.payments.maxAmount) throw bad(`Online payments are limited to ₹${config.payments.maxAmount} at a time. Choose fewer dues, or pay the rest at the school office.`);
  const ids = charges.map((c) => String(c._id)).sort();
  const checkout = (o) => ({ orderId: o._id, providerOrderId: o.providerOrderId, amount: o.amount, amountPaise: paise(o.amount), currency: o.currency, ...gw.publicInfo(), schoolName: ctx.school?.name, studentName: student.name });

  // asking twice for the same dues gives the same order, so a double-click or a second tab never creates two payments
  const live = await PaymentOrder.find({ tenantId: ctx.tenantId, studentId: student._id, provider: gw.name, status: 'created', createdAt: { $gt: new Date(Date.now() - config.payments.orderMinutes * 60 * 1000) } });
  const same = live.find((o) => o.amount === amount && [...o.chargeIds].map(String).sort().join() === ids.join());
  if (same) return checkout(same);
  if (live.length) await PaymentOrder.updateMany({ _id: { $in: live.map((o) => o._id) } }, { status: 'expired' });

  const _id = new mongoose.Types.ObjectId();
  const remote = await gw.createOrder({ amountPaise: paise(amount), receipt: `fee_${_id}`, notes: { orderId: String(_id), studentId: String(student._id) } });
  const order = await PaymentOrder.create({ _id, tenantId: ctx.tenantId, studentId: student._id, userId: student.userId, provider: gw.name, providerOrderId: remote.id, amount, chargeIds: ids });
  return checkout(order);
}

// ───────────── 4. settle (once) ─────────────
/** Turn a paid order into a normal fee receipt. Safe to call any number of times and from any number of places. */
export async function settle(orderId, providerPaymentId) {
  const claimed = await PaymentOrder.findOneAndUpdate({ _id: orderId, status: { $in: ['created', 'failed', 'expired'] } }, { $set: { status: 'processing', providerPaymentId } }, { new: true });
  if (!claimed) return PaymentOrder.findById(orderId); // already paid, being settled, or waiting for finance: nothing more to do
  try {
    const student = await Student.findById(claimed.studentId).select('name');
    const { today } = await schoolToday(claimed.tenantId);
    const p = await collectPayment({ tenantId: claimed.tenantId, actorId: claimed.userId, today }, {
      studentId: claimed.studentId, amount: claimed.amount, mode: 'online', reference: providerPaymentId, chargeIds: claimed.chargeIds.map(String), note: `Paid online (${claimed.provider})`,
    }, `${student?.name || 'Student'} (online)`);
    const paid = await PaymentOrder.findByIdAndUpdate(claimed._id, { status: 'paid', paymentId: p._id, receiptNo: p.receiptNo, paidAt: new Date(), failureReason: undefined }, { new: true });
    await emailReceipt(claimed.tenantId, p._id); // the receipt goes to the family by email on its own; a mail problem never undoes the payment
    return paid;
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) {
      // the gateway has the money but the dues no longer match (the office may have taken cash meanwhile): finance must settle this by hand
      logger.warn('online payment needs review', { orderId: String(claimed._id), error: e.message });
      return PaymentOrder.findByIdAndUpdate(claimed._id, { status: 'needs_review', note: `Money received but not matched to the dues: ${e.message}` }, { new: true });
    }
    await PaymentOrder.updateOne({ _id: claimed._id, status: 'processing' }, { status: 'created' }); // a temporary fault: the next webhook delivery tries again
    throw e;
  }
}

// ───────────── 3. the browser's result ─────────────
export async function verifyCheckout(ctx, student, { orderId, paymentId, signature }) {
  const order = await PaymentOrder.findOne({ tenantId: ctx.tenantId, studentId: student._id, providerOrderId: orderId });
  if (!order) throw notFound('Payment not found');
  const gw = gateway();
  if (!gw || gw.name !== order.provider) throw conflict('This payment can no longer be confirmed here. Please contact the school office.');
  if (!gw.verifyCheckout({ orderId: order.providerOrderId, paymentId, signature })) {
    throw bad('We could not confirm this payment. If money was deducted it will be matched automatically within a few minutes; if not, please contact the school office.');
  }
  return orderView(await settle(order._id, paymentId));
}

export async function getOrder(ctx, student, id) {
  const o = await PaymentOrder.findOne({ _id: id, tenantId: ctx.tenantId, studentId: student._id });
  if (!o) throw notFound('Payment not found');
  return orderView(o);
}

// ───────────── 3b. the gateway's own message ─────────────
export async function handleWebhook(rawBody, signature) {
  const gw = gateway();
  if (!gw) throw new HttpError(404, 'Not found', 'NOT_FOUND');
  if (!gw.verifyWebhook(rawBody, signature)) throw new HttpError(400, 'Invalid signature', 'BAD_SIGNATURE');
  let body; try { body = JSON.parse(rawBody); } catch { throw bad('Unreadable body'); }
  const ev = readWebhook(body);
  if (!ev.type) return { ok: true, ignored: true };
  const order = await PaymentOrder.findOne({ providerOrderId: ev.orderId });
  if (!order || order.provider !== gw.name) return { ok: true, ignored: true }; // not ours: acknowledge so the gateway stops retrying
  if (ev.type === 'failed') {
    await PaymentOrder.updateOne({ _id: order._id, status: 'created' }, { status: 'failed', failureReason: ev.reason, providerPaymentId: ev.paymentId });
    return { ok: true };
  }
  if (ev.amountPaise != null && ev.amountPaise !== paise(order.amount)) {
    await PaymentOrder.updateOne({ _id: order._id, status: { $in: ['created', 'failed', 'expired'] } }, { status: 'needs_review', providerPaymentId: ev.paymentId, note: `The gateway reports ₹${ev.amountPaise / 100} but ₹${order.amount} was asked for` });
    return { ok: true };
  }
  await settle(order._id, ev.paymentId);
  return { ok: true };
}

// ───────────── the test checkout window (mock gateway only) ─────────────
/** Play the part of the bank. success: what Razorpay's checkout hands the browser. failure / webhook_only: a signed webhook, sent exactly as Razorpay would. */
export async function mockPay(ctx, student, id, outcome) {
  const gw = gateway();
  if (!gw || gw.name !== 'mock') throw notFound('Not found');
  const order = await PaymentOrder.findOne({ _id: id, tenantId: ctx.tenantId, studentId: student._id });
  if (!order || order.provider !== 'mock') throw notFound('Payment not found');
  if (order.status === 'paid') throw conflict('This order is already paid');
  const paymentId = gw.newPaymentId();
  if (outcome === 'success') return { razorpay_order_id: order.providerOrderId, razorpay_payment_id: paymentId, razorpay_signature: gw.signCheckout(order.providerOrderId, paymentId) };
  const failed = outcome === 'failure';
  const w = gw.makeWebhook(failed ? 'payment.failed' : 'payment.captured', { orderId: order.providerOrderId, paymentId, amountPaise: paise(order.amount), reason: failed ? 'Test: the bank declined the payment' : undefined });
  await handleWebhook(w.raw, w.signature); // through the very same code the real webhook uses
  return failed ? { failed: true, reason: 'Test: the bank declined the payment' } : { delivered: true };
}

// ───────────── finance ─────────────
export async function listOnline(ctx, { status, limit = 100 }) {
  const rows = await PaymentOrder.find({ tenantId: ctx.tenantId, ...(status ? { status } : {}) }).sort({ createdAt: -1 }).limit(limit).populate('studentId', 'name admissionNo');
  const counts = Object.fromEntries((await PaymentOrder.aggregate([{ $match: { tenantId: new mongoose.Types.ObjectId(String(ctx.tenantId)) } }, { $group: { _id: '$status', n: { $sum: 1 } } }])).map((c) => [c._id, c.n]));
  return { counts, orders: rows.map((o) => ({ ...orderView(o), student: o.studentId ? { _id: o.studentId._id, name: o.studentId.name, admissionNo: o.studentId.admissionNo } : null, providerPaymentId: o.providerPaymentId })) };
}

/** Orders nobody paid are closed; a payment stuck half-way is handed to finance rather than left hanging. */
export async function tidyOrders(now = new Date()) {
  const a = await PaymentOrder.updateMany({ status: 'created', createdAt: { $lt: new Date(now.getTime() - config.payments.orderMinutes * 60 * 1000) } }, { status: 'expired' });
  const b = await PaymentOrder.updateMany({ status: 'processing', updatedAt: { $lt: new Date(now.getTime() - HOUR / 6) } }, { status: 'needs_review', note: 'Settling was interrupted. Check the receipts before doing anything else.' });
  return a.modifiedCount + b.modifiedCount;
}
