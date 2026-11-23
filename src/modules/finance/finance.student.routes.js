import { Router } from 'express';
import { Payment } from '../../models/index.js';
import { notFound } from '../../core/utils.js';
import * as svc from './finance.service.js';
import { onlineInfo } from '../payments/payments.service.js';

/** Student fee information: strictly read-only and strictly their own account. */
const r = Router();

r.get('/fees', async (req, res) => {
  const acct = await svc.studentAccount(req.tenantId, req.ctx.student._id, req.ctx.today);
  const cat = new Map();
  for (const c of acct.charges) { if (!c.category) continue; const e = cat.get(c.category) || { name: c.category, total: 0, paid: 0, months: 0 }; e.total += c.amount - (c.concession || 0); e.paid += c.paidAmount || 0; if (c.period) e.months += 1; cat.set(c.category, e); }
  const plan = await svc.advancePlan(req.ctx, req.ctx.student._id);
  res.json({
    totals: acct.totals,
    installments: acct.installments,
    online: onlineInfo(req.ctx),
    categories: [...cat.values()],
    advanceOffer: { eligible: plan.eligible, offer: plan.offer, months: plan.months, discount: plan.discount, payable: plan.payable, reason: plan.reason },
    charges: acct.charges.map((c) => ({ id: c._id, label: c.label, kind: c.kind, category: c.category, period: c.period, amount: c.amount, concession: c.concession, net: c.net, paid: c.paidAmount, outstanding: c.outstanding, dueDate: c.dueDate, status: c.status, overdue: c.overdue })),
    payments: acct.payments.map((p) => ({ id: p._id, receiptNo: p.receiptNo, kind: p.kind, amount: p.amount, mode: p.mode, paidOn: p.paidOn, status: p.status, allocations: p.allocations.map((a) => a.label), chargeIds: p.allocations.map((a) => String(a.chargeId)) })),
  });
});

r.get('/fees/receipts/:id.pdf', async (req, res) => {
  const p = await Payment.findOne({ _id: req.params.id, tenantId: req.tenantId, studentId: req.ctx.student._id });
  if (!p) throw notFound('Receipt not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="receipt-${p.receiptNo}.pdf"`);
  await svc.renderReceipt(req.tenantId, p, res);
});
export default r;
