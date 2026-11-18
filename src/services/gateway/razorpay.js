import { config } from '../../core/config.js';
import { verifyCheckout, verifyWebhook } from './signing.js';
import { HttpError } from '../../core/utils.js';

/**
 * The real Razorpay. Plain HTTPS calls (no SDK to install). This file is written against Razorpay's public documentation and has not yet
 * been run against a live account: test it with Razorpay's test keys (rzp_test_...) before going live.
 */
const z = () => config.payments.razorpay;
const auth = () => `Basic ${Buffer.from(`${z().keyId}:${z().keySecret}`).toString('base64')}`;

export const razorpayGateway = {
  name: 'razorpay',
  testMode: false,
  publicInfo: () => ({ provider: 'razorpay', keyId: z().keyId, testMode: z().keyId.startsWith('rzp_test_') }),
  async createOrder({ amountPaise, receipt, notes }) {
    let res;
    try {
      res = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST', headers: { Authorization: auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: String(receipt).slice(0, 40), notes }),
        signal: AbortSignal.timeout(15000),
      });
    } catch { throw new HttpError(502, 'The payment service could not be reached. Please try again in a moment.', 'GATEWAY_UNREACHABLE'); }
    if (!res.ok) throw new HttpError(502, 'The payment service refused to start this payment. Please try again later.', 'GATEWAY_ERROR');
    const o = await res.json();
    return { id: o.id, amountPaise: o.amount, currency: o.currency };
  },
  verifyCheckout: (p) => verifyCheckout(z().keySecret, p),
  verifyWebhook: (raw, sig) => verifyWebhook(z().webhookSecret, raw, sig),
};
