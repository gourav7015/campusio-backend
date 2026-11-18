import crypto from 'node:crypto';
import { config } from '../../core/config.js';
import { checkoutSignature, webhookSignature, verifyCheckout, verifyWebhook } from './signing.js';

/**
 * The test gateway. It follows Razorpay's contract step by step (create an order, get a signed result back, receive a signed webhook)
 * so the whole payment flow can be built and tested with no account. No money moves and no network call is made.
 */
const id = (prefix) => `${prefix}_mock_${crypto.randomBytes(8).toString('hex')}`;
const secret = () => config.payments.mockSecret;

export const mockGateway = {
  name: 'mock',
  testMode: true,
  publicInfo: () => ({ provider: 'mock', keyId: 'rzp_test_mock', testMode: true }),
  async createOrder({ amountPaise }) { return { id: id('order'), amountPaise, currency: 'INR' }; },
  verifyCheckout: (p) => verifyCheckout(secret(), p),
  verifyWebhook: (raw, sig) => verifyWebhook(secret(), raw, sig),

  // used only by the test checkout screen: play the part of the bank and of Razorpay
  newPaymentId: () => id('pay'),
  signCheckout: (orderId, paymentId) => checkoutSignature(secret(), orderId, paymentId),
  /** A webhook exactly as Razorpay would send it: the raw text and its signature header. */
  makeWebhook(event, { orderId, paymentId, amountPaise, reason }) {
    const payment = { entity: { id: paymentId, order_id: orderId, amount: amountPaise, currency: 'INR', status: event === 'payment.failed' ? 'failed' : 'captured', ...(reason ? { error_description: reason } : {}) } };
    const raw = JSON.stringify({ entity: 'event', event, payload: { payment } });
    return { raw, signature: webhookSignature(secret(), raw) };
  },
};
