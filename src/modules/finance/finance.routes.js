import { Router } from 'express';
import { z } from 'zod';
import { parse, notFound, conflict } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import { Student, Payment, StudentEnrolment, Section, ClassModel, AcademicYear } from '../../models/index.js';
import * as v from './finance.validation.js';
import * as svc from './finance.service.js';
import { listOnline } from '../payments/payments.service.js';

import { expenseRoutes } from './expenses.routes.js';

const r = Router();
r.use(expenseRoutes);

r.get('/dashboard', async (req, res) => res.json(await svc.dashboard(req.ctx, parse(v.rangeQuery.pick({ from: true, to: true }), req.query))));

// lookups for filters (only class/section names, no academic data)
r.get('/lookups', async (req, res) => {
  const [years, classes, sections] = await Promise.all([
    AcademicYear.find({ tenantId: req.tenantId }).sort({ startDate: -1 }).select('name isCurrent').lean(), ClassModel.find({ tenantId: req.tenantId, status: 'active' }).sort({ level: 1 }).select('name').lean(),
    Section.find({ tenantId: req.tenantId, yearId: req.ctx.year?._id, status: 'active' }).select('name classId').lean(),
  ]);
  res.json({ years, classes, sections });
});

// fee structures
r.get('/structures', async (req, res) => res.json(await svc.listStructures(req.ctx, { yearId: req.query.yearId })));
r.post('/structures', async (req, res) => {
  const s = await svc.createStructure(req.ctx, parse(v.structureBody, req.body));
  await audit(req, 'fees.structure_created', 'FeeStructure', s._id, `Created fee structure ${s.name}`);
  res.status(201).json(s);
});
r.patch('/structures/:id', async (req, res) => res.json(await svc.updateStructure(req.ctx, req.params.id, parse(v.structurePatch, req.body))));
r.delete('/structures/:id', async (req, res) => { await svc.deleteStructure(req.ctx, req.params.id); res.json({ ok: true }); });
r.post('/assign', async (req, res) => {
  const out = await svc.assignStructure(req.ctx, parse(v.assignBody, req.body));
  await audit(req, 'fees.assigned', 'FeeStructure', req.body.structureId, `Billed ${out.assigned} student(s) (${out.skipped} already billed)`, out);
  res.json(out);
});

// students & dues
r.get('/students', async (req, res) => res.json(await svc.listDues(req.ctx, parse(v.duesQuery, req.query))));
r.get('/students/:id/account', async (req, res) => {
  const s = await Student.findOne({ _id: req.params.id, tenantId: req.tenantId }).select('name admissionNo status guardians').lean();
  if (!s) throw notFound('Student not found');
  const enr = await StudentEnrolment.findOne({ tenantId: req.tenantId, studentId: s._id, status: 'active' }).sort({ createdAt: -1 }).lean();
  const [sec, cls] = enr ? await Promise.all([Section.findById(enr.sectionId).lean(), ClassModel.findById(enr.classId).lean()]) : [];
  res.json({ student: { id: s._id, name: s.name, admissionNo: s.admissionNo, status: s.status, className: cls?.name, section: sec?.name, rollNo: enr?.rollNo, guardian: s.guardians?.[0]?.name, guardianPhone: s.guardians?.[0]?.phone }, ...(await svc.studentAccount(req.tenantId, s._id, req.ctx.today)) });
});

// the standing personal discount (every month, from now on)
const pdBody = z.object({ type: z.enum(['percent', 'per_month']), value: z.number().positive().max(10_000_000), reason: z.string().trim().min(3).max(200) });
r.put('/students/:id/personal-discount', async (req, res) => {
  const out = await svc.setPersonalDiscount(req.ctx, req.params.id, parse(pdBody, req.body), req.user.name);
  await audit(req, 'fees.personal_discount', 'Student', req.params.id, `Set a personal discount on tuition: ${out.personalDiscount.type === 'percent' ? `${out.personalDiscount.value}%` : `₹${out.personalDiscount.value} a month`} (${out.personalDiscount.reason})`);
  res.json(out);
});
r.delete('/students/:id/personal-discount', async (req, res) => {
  const out = await svc.clearPersonalDiscount(req.ctx, req.params.id, req.user.name);
  await audit(req, 'fees.personal_discount_removed', 'Student', req.params.id, 'Removed the personal discount');
  res.json(out);
});

// charges & concessions
r.post('/charges', async (req, res) => {
  const c = await svc.createCharge(req.ctx, parse(v.chargeBody, req.body));
  await audit(req, 'fees.charge_created', 'StudentCharge', c._id, `Charge "${c.label}" ${c.amount}`);
  res.status(201).json(c);
});
r.post('/charges/bulk', async (req, res) => {
  const b = parse(v.bulkChargeBody, req.body);
  const out = await svc.createChargesBulk(req.ctx, b);
  if (!b.preview) await audit(req, 'fees.charges_bulk', 'StudentCharge', null, `Charge "${b.label}" of ${b.amount} added for ${out.applied} student(s)`);
  res.status(b.preview ? 200 : 201).json(out);
});
r.post('/charges/:id/concession', async (req, res) => {
  const body = parse(v.concessionBody, req.body);
  const c = await svc.addConcession(req.ctx, req.params.id, body, req.user.name);
  await audit(req, 'fees.concession', 'StudentCharge', c._id, `Concession ${body.amount} on "${c.label}": ${body.reason}`);
  res.json(c);
});

// payments (immutable; reverse instead of edit/delete)
r.get('/online-payments', async (req, res) => res.json(await listOnline(req.ctx, parse(z.object({ status: z.enum(['created', 'processing', 'paid', 'failed', 'expired', 'needs_review']).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }), req.query))));
r.get('/payments', async (req, res) => res.json(await svc.listPayments(req.ctx, parse(v.rangeQuery, req.query))));
r.post('/payments', async (req, res) => {
  const body = parse(v.paymentBody, req.body);
  const p = await svc.collectWithDiscount(req.ctx, body, req.user.name);
  if (p.discountOnly) { await audit(req, 'fees.discount', 'Student', body.studentId, `Discount of ${p.discount} cleared the dues (${body.discount.reason})`); return res.status(200).json(p); }
  await audit(req, 'fees.payment', 'Payment', p._id, `Receipt ${p.receiptNo} for ${p.amount} (${p.mode})${body.discount ? `, after a discount (${body.discount.type === 'percent' ? `${body.discount.value}%` : body.discount.value}: ${body.discount.reason})` : ''}`);
  res.status(201).json(p);
});
r.post('/payments/:id/reverse', async (req, res) => {
  const { reason } = parse(v.reverseBody, req.body);
  const out = await svc.reversePayment(req.ctx, req.params.id, reason, req.user.name);
  await audit(req, 'fees.payment_reversed', 'Payment', out.original._id, `Reversed ${out.original.receiptNo}: ${reason}`);
  res.json(out);
});
r.get('/installments', async (req, res) => res.json(await svc.installmentsReport(req.ctx, {})));
r.post('/payments/:id/email', async (req, res) => {
  const p = await Payment.findOne({ _id: req.params.id, tenantId: req.tenantId });
  if (!p) throw notFound('Payment not found');
  if (p.kind !== 'payment') throw conflict('Only a payment has a receipt to send');
  const sent = await svc.emailReceipt(req.tenantId, p._id);
  if (!sent.length) throw conflict('No email was sent: email is not set up for the school, or the student and guardians have no email address on file.');
  await audit(req, 'fees.receipt_emailed', 'Payment', p._id, `Emailed receipt ${p.receiptNo}`);
  res.json({ sent });
});
r.get('/payments/:id/receipt.pdf', async (req, res) => {
  const p = await Payment.findOne({ _id: req.params.id, tenantId: req.tenantId });
  if (!p) throw notFound('Payment not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="receipt-${p.receiptNo}.pdf"`);
  await svc.renderReceipt(req.tenantId, p, res);
});

// the school's fee policy and paying the whole year in advance
r.get('/policy', async (req, res) => res.json(await svc.getPolicy(req.ctx)));
r.put('/policy', async (req, res) => {
  const out = await svc.updatePolicy(req.ctx, parse(v.policyBody, req.body));
  await audit(req, 'fees.policy_updated', 'School', req.tenantId, `Fee policy: due day ${out.dueDay}, advance discount ${out.advanceDiscount.enabled ? `${out.advanceDiscount.value} ${out.advanceDiscount.type}` : 'off'}`);
  res.json(out);
});
r.get('/students/:id/advance-plan', async (req, res) => res.json(await svc.advancePlan(req.ctx, req.params.id)));
r.post('/students/:id/advance-payment', async (req, res) => {
  const p = await svc.payAdvance(req.ctx, req.params.id, parse(v.advanceBody, req.body), req.user.name);
  await audit(req, 'fees.advance_payment', 'Payment', p._id, `Advance payment, receipt ${p.receiptNo} for ${p.amount}`);
  res.status(201).json(p);
});

// reports, reminders, exports
r.get('/reports/collection', async (req, res) => res.json(await svc.collectionReport(req.ctx, parse(v.rangeQuery, req.query))));
const oid = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
r.get('/reports/defaulters-by-class', async (req, res) => res.json(await svc.defaultersByClass(req.ctx, parse(z.object({ classId: oid.optional(), sectionId: oid.optional() }), req.query))));
r.get('/reports/classes', async (req, res) => res.json(await svc.outstandingByClass(req.ctx)));
r.post('/reminders', async (req, res) => {
  const out = await svc.sendReminders(req.ctx, parse(v.remindBody, req.body));
  await audit(req, 'fees.reminders', 'Student', null, `Sent ${out.sent} fee reminder(s)`);
  res.json(out);
});
const csv = (res, name, body) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.send(body); };
r.get('/export/defaulters-by-class.csv', async (req, res) => csv(res, 'defaulters-by-class.csv', await svc.exportDefaultersByClass(req.ctx)));
r.get('/export/payments.csv', async (req, res) => csv(res, 'payments.csv', await svc.exportPayments(req.ctx, parse(v.rangeQuery, req.query))));
r.get('/export/dues.csv', async (req, res) => csv(res, 'dues.csv', await svc.exportDues(req.ctx, parse(v.duesQuery.partial(), req.query))));
export default r;
