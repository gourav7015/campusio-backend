import { Router } from 'express';
import { z } from 'zod';
import { parse, bad } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as svc from './payments.service.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const startBody = z.object({ chargeIds: z.array(id).max(60).optional() });
const verifyBody = z.object({ orderId: z.string().min(5).max(80), paymentId: z.string().min(5).max(80), signature: z.string().min(10).max(200) });
const mockBody = z.object({ outcome: z.enum(['success', 'failure', 'webhook_only']) });

/** The student (and parent) side. Mounted inside the student portal, so the student is always the signed-in one. */
export const studentRoutes = Router();
studentRoutes.post('/fees/pay', async (req, res) => {
  const out = await svc.startPayment(req.ctx, req.ctx.student, parse(startBody, req.body));
  await audit(req, 'fees.online_started', 'PaymentOrder', out.orderId, `Started an online payment of ${out.amount}`);
  res.status(201).json(out);
});
studentRoutes.post('/fees/pay/verify', async (req, res) => {
  const o = await svc.verifyCheckout(req.ctx, req.ctx.student, parse(verifyBody, req.body));
  if (o.status === 'paid') await audit(req, 'fees.online_paid', 'PaymentOrder', o.id, `Paid ${o.amount} online, receipt ${o.receiptNo}`);
  res.json(o);
});
studentRoutes.get('/fees/orders/:id', async (req, res) => res.json(await svc.getOrder(req.ctx, req.ctx.student, req.params.id)));
studentRoutes.post('/fees/orders/:id/test-pay', async (req, res) => res.json(await svc.mockPay(req.ctx, req.ctx.student, req.params.id, parse(mockBody, req.body).outcome)));

/** The gateway calls this by itself. Open to the internet, so the only thing that lets a message in is the signature on it. */
export const webhookRoutes = Router();
webhookRoutes.post('/webhook', async (req, res) => {
  if (!req.rawBody) throw bad('Send the event as JSON');
  res.json(await svc.handleWebhook(req.rawBody.toString('utf8'), req.get('x-razorpay-signature')));
});
