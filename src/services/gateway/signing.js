import crypto from 'node:crypto';

const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');
/** Compare two hex signatures without leaking where they differ. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8'); const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
/** What the browser gets back after paying: HMAC-SHA256 of "order_id|payment_id" with the key secret (this is exactly Razorpay's rule). */
export const checkoutSignature = (secret, orderId, paymentId) => hmac(secret, `${orderId}|${paymentId}`);
/** What a webhook carries: HMAC-SHA256 of the raw request body with the webhook secret (also Razorpay's rule). */
export const webhookSignature = (secret, rawBody) => hmac(secret, rawBody);
export const verifyCheckout = (secret, { orderId, paymentId, signature }) => !!orderId && !!paymentId && safeEqual(checkoutSignature(secret, orderId, paymentId), signature);
export const verifyWebhook = (secret, rawBody, signature) => !!rawBody && !!signature && safeEqual(webhookSignature(secret, rawBody), signature);

/**
 * Turn a Razorpay webhook body into one simple shape. Anything we do not act on gives type null.
 *   payment.captured / order.paid -> paid     payment.failed -> failed
 */
export function readWebhook(body) {
  const pay = body?.payload?.payment?.entity; const ord = body?.payload?.order?.entity;
  const orderId = pay?.order_id || ord?.id;
  if (!orderId) return { type: null };
  if (body.event === 'payment.captured' || body.event === 'order.paid') return { type: 'paid', orderId, paymentId: pay?.id, amountPaise: pay?.amount ?? ord?.amount_paid };
  if (body.event === 'payment.failed') return { type: 'failed', orderId, paymentId: pay?.id, reason: pay?.error_description || pay?.error_reason || 'The payment failed' };
  return { type: null };
}
