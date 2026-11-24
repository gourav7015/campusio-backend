import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import { parse, forbidden, isDateStr, HttpError } from '../../core/utils.js';
import { upload, saveFile } from '../../services/files.js';
import { MODES } from './finance.validation.js';
import { audit } from '../../services/audit.js';
import { SchoolProfile } from '../../models/index.js';
import * as svc from './expenses.service.js';
import * as vendors from './vendors.service.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
const expenseBody = z.object({
  date, department: z.string().trim().min(2).max(60), work: z.string().trim().max(80).optional(), title: z.string().trim().min(3).max(120),
  vendor: z.string().trim().max(80).optional(), vendorId: id.nullable().optional(), nature: z.enum(['revenue', 'capital']).default('revenue'), billNo: z.string().trim().max(40).optional(), amount: z.number().positive().max(100_000_000), notes: z.string().max(500).optional(),
});
const listQuery = z.object({ status: z.enum(['all', 'pending', 'approved', 'rejected']).default('all'), department: z.string().optional(), from: date.optional(), to: date.optional(), yearId: id.optional(), nature: z.enum(['revenue', 'capital']).optional(), vendorId: id.optional(), payment: z.enum(['unpaid', 'paid']).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) });
const budgetBody = z.object({ yearId: id.optional(), kind: z.enum(['revenue', 'capital']).default('revenue'), department: z.string().trim().min(2).max(60), work: z.string().trim().max(80).optional(), allocated: z.number().min(0).max(1_000_000_000), notes: z.string().max(300).optional() });
const onlyFinance = (req) => { if (req.user.role !== 'finance') throw forbidden('Only the Finance team can see or change this'); };

/** Mounted inside the Finance routes: the Finance portal changes things, the School Admin's window only reads (the window refuses writes). */
export const expenseRoutes = Router();
const r = expenseRoutes;
r.get('/expenses', async (req, res) => res.json(await svc.listExpenses(req.ctx, parse(listQuery, req.query))));
r.post('/expenses', async (req, res) => {
  const e = await svc.createExpense(req.ctx, parse(expenseBody, req.body), req.user);
  await audit(req, 'expense.submitted', 'Expense', e._id, `Submitted expense "${e.title}" ₹${e.amount} for approval`);
  res.status(201).json(e);
});
r.patch('/expenses/:id', async (req, res) => { const e = await svc.updateExpense(req.ctx, req.params.id, parse(expenseBody.partial(), req.body)); await audit(req, 'expense.updated', 'Expense', e._id, `Edited expense "${e.title}"`); res.json(e); });
r.delete('/expenses/:id', async (req, res) => { await svc.deleteExpense(req.ctx, req.params.id); await audit(req, 'expense.deleted', 'Expense', req.params.id, 'Deleted an expense'); res.json({ ok: true }); });

// bills and quotes that go with an expense to the approver (PDF, PNG or JPG)
const checkCopy = async (file) => {
  if (!file) throw new HttpError(400, 'Choose a file to attach', 'BAD_REQUEST');
  if (!['application/pdf', 'image/png', 'image/jpeg'].includes(file.mimetype)) { await fs.promises.unlink(file.path).catch(() => {}); throw new HttpError(400, 'Upload a PDF, PNG or JPG', 'BAD_REQUEST'); }
};
r.post('/expenses/:id/attachments', upload.single('file'), async (req, res) => {
  await checkCopy(req.file);
  const saved = await saveFile(req, req.file, { kind: 'document', ownerType: 'expense', ownerId: req.params.id, visibility: 'owner' });
  const e = await svc.addAttachment(req.ctx, req.params.id, saved);
  await audit(req, 'expense.file_added', 'Expense', e._id, `Attached ${saved.originalName} to "${e.title}"`);
  res.status(201).json(e);
});
r.delete('/expenses/:id/attachments/:fileId', async (req, res) => {
  const e = await svc.removeAttachment(req.ctx, req.params.id, id.parse(req.params.fileId));
  await audit(req, 'expense.file_removed', 'Expense', e._id, `Removed a file from "${e.title}"`);
  res.json(e);
});
const payBody = z.object({ mode: z.enum(MODES), reference: z.string().trim().max(60).optional(), paidOn: date.optional(), note: z.string().max(200).optional() });
r.post('/expenses/:id/pay', async (req, res) => {
  const e = await svc.payExpense(req.ctx, req.params.id, parse(payBody, req.body), req.user);
  await audit(req, 'expense.paid', 'Expense', e._id, `Paid "${e.title}" ₹${e.amount} by ${e.paymentMode}`);
  res.json(e);
});

// ───────────── vendors: Finance keeps the list, the School Admin approves ─────────────
const opt = (schema) => z.union([z.literal(''), schema]).optional();
const vendorBody = z.object({
  name: z.string().trim().min(2).max(120), category: z.string().trim().max(60).optional(), contactPerson: z.string().trim().max(80).optional(),
  phone: opt(z.string().trim().regex(/^[0-9+\-\s()]{7,20}$/, 'Phone number looks wrong')), email: opt(z.string().trim().email('Email looks wrong').max(120)),
  address: z.string().trim().max(200).optional(), city: z.string().trim().max(60).optional(), state: z.string().trim().max(60).optional(), pincode: opt(z.string().trim().regex(/^\d{6}$/, 'Pincode is 6 digits')),
  gstin: opt(z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, 'That is not a valid GSTIN')), pan: opt(z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'That is not a valid PAN')),
  bankName: z.string().trim().max(80).optional(), accountName: z.string().trim().max(80).optional(), accountNo: opt(z.string().trim().regex(/^\d{6,20}$/, 'Account number is 6 to 20 digits')),
  ifsc: opt(z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'That is not a valid IFSC')), upi: z.string().trim().max(60).optional(), paymentTerms: z.string().trim().max(120).optional(), notes: z.string().max(500).optional(),
});
const vendorList = z.object({ status: z.enum(['all', 'pending', 'approved', 'rejected', 'inactive']).default('all'), category: z.string().optional(), q: z.string().max(80).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(25) });
const MAX_IMPORT = 2000;
r.get('/vendors', async (req, res) => res.json(await vendors.listVendors(req.ctx, parse(vendorList, req.query))));
r.get('/vendors/approved', async (req, res) => res.json(await vendors.approvedVendors(req.ctx)));
r.get('/vendors/export.csv', async (req, res) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="vendors.csv"'); res.send(await vendors.exportVendors(req.ctx)); });
r.post('/vendors/import', async (req, res) => {
  const rows = z.array(z.record(z.string(), z.any())).min(1, 'The file has no rows').max(MAX_IMPORT, `Up to ${MAX_IMPORT} vendors at a time`).parse(req.body?.rows);
  const check = (row) => { const t = vendorBody.safeParse(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v == null ? undefined : String(v)]).filter(([, v]) => v !== ''))); return t.success ? { ok: true, value: t.data } : { ok: false, error: t.error.issues.map((i) => i.message).join('; ') }; };
  const out = await vendors.importVendors(req.ctx, rows, req.user, check);
  await audit(req, 'vendor.imported', 'Vendor', undefined, `Imported ${out.created} vendor(s), ${out.skipped} skipped`);
  res.status(201).json(out);
});
r.post('/vendors', async (req, res) => {
  const v = await vendors.createVendor(req.ctx, parse(vendorBody, req.body), req.user);
  await audit(req, 'vendor.submitted', 'Vendor', v._id, `Added vendor ${v.name} (${v.code}) for approval`);
  res.status(201).json(v);
});
r.patch('/vendors/:id', async (req, res) => { const v = await vendors.updateVendor(req.ctx, req.params.id, parse(vendorBody.partial(), req.body), req.user); await audit(req, 'vendor.updated', 'Vendor', v._id, `Edited vendor ${v.name}`); res.json(v); });
r.post('/vendors/:id/active', async (req, res) => { const v = await vendors.setVendorActive(req.ctx, req.params.id, parse(z.object({ active: z.boolean() }), req.body).active); await audit(req, v.status === 'inactive' ? 'vendor.switched_off' : 'vendor.switched_on', 'Vendor', v._id, `${v.name} is now ${v.status}`); res.json(v); });
r.delete('/vendors/:id', async (req, res) => { await vendors.deleteVendor(req.ctx, req.params.id); await audit(req, 'vendor.deleted', 'Vendor', req.params.id, 'Deleted a vendor'); res.json({ ok: true }); });
r.get('/budgets', async (req, res) => res.json(await svc.listBudgets(req.ctx, req.query.yearId && id.parse(req.query.yearId))));
r.put('/budgets', async (req, res) => { const b = await svc.saveBudget(req.ctx, parse(budgetBody, req.body)); await audit(req, 'budget.saved', 'Budget', b._id, `Budget for ${b.department}${b.work ? ` / ${b.work}` : ''}: ₹${b.allocated}`); res.json(b); });
r.delete('/budgets/:id', async (req, res) => { await svc.deleteBudget(req.ctx, req.params.id); await audit(req, 'budget.deleted', 'Budget', req.params.id, 'Deleted a budget'); res.json({ ok: true }); });

// GSTIN, PAN and bank details: the Finance team only, not even the School Admin's window
const profileBody = z.object({ gstin: z.string().trim().toUpperCase().regex(/^$|^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, 'That is not a valid GSTIN').optional(), pan: z.string().trim().toUpperCase().regex(/^$|^[A-Z]{5}\d{4}[A-Z]$/, 'That is not a valid PAN').optional(), tan: z.string().trim().toUpperCase().max(10).optional(),
  bankName: z.string().trim().max(80).optional(), accountName: z.string().trim().max(80).optional(), accountNo: z.string().trim().regex(/^$|^\d{6,20}$/, 'Account number is 6 to 20 digits').optional(), ifsc: z.string().trim().toUpperCase().regex(/^$|^[A-Z]{4}0[A-Z0-9]{6}$/, 'That is not a valid IFSC').optional(), branch: z.string().trim().max(80).optional(), upi: z.string().trim().max(60).optional() });
r.get('/school-finance-profile', async (req, res) => { onlyFinance(req); res.json((await SchoolProfile.findOne({ tenantId: req.tenantId }).lean())?.finance || {}); });
r.put('/school-finance-profile', async (req, res) => {
  onlyFinance(req);
  const b = parse(profileBody, req.body);
  const p = await SchoolProfile.findOneAndUpdate({ tenantId: req.tenantId }, { $set: Object.fromEntries(Object.entries(b).map(([k, v]) => [`finance.${k}`, v])) }, { upsert: true, new: true });
  await audit(req, 'school.finance_profile', 'SchoolProfile', p._id, 'Updated the school tax and bank details');
  res.json(p.finance);
});

/** School Admin portal: the approvals inbox. */
export const approvalRoutes = Router();
/** How many things wait for the admin's decision: the red number beside Approvals in the menu. */
approvalRoutes.get('/approvals/summary', async (req, res) => {
  const sched = await import('../scheduling/scheduling.service.js');
  const [expenses, swaps, exceptions, vendorsWaiting] = await Promise.all([svc.pendingApprovals(req.ctx), sched.adminSwaps(req.ctx, { status: 'awaiting' }), sched.listExceptions(req.ctx, { status: 'pending' }), vendors.pendingVendors(req.ctx)]);
  res.json({ count: expenses.length + swaps.length + exceptions.length + vendorsWaiting.length });
});
approvalRoutes.get('/approvals', async (req, res) => {
  const sched = await import('../scheduling/scheduling.service.js');
  const [expenses, swaps, exceptions, vendorsWaiting] = await Promise.all([svc.pendingApprovals(req.ctx), sched.adminSwaps(req.ctx, { status: 'awaiting' }), sched.listExceptions(req.ctx, { status: 'pending' }), vendors.pendingVendors(req.ctx)]);
  res.json({ expenses, vendors: vendorsWaiting, swaps, exceptions, counts: { expenses: expenses.length, vendors: vendorsWaiting.length, swaps: swaps.length, exceptions: exceptions.length } });
});
approvalRoutes.post('/approvals/expenses/:id', async (req, res) => {
  const b = parse(z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() }), req.body);
  const e = await svc.decideExpense(req.ctx, req.params.id, b, req.user);
  await audit(req, `expense.${e.status}`, 'Expense', e._id, `${e.status === 'approved' ? 'Approved' : 'Rejected'} expense "${e.title}" ₹${e.amount}${b.note ? `: ${b.note}` : ''}`);
  res.json(e);
});
approvalRoutes.post('/approvals/vendors/decide', async (req, res) => {
  const b = parse(z.object({ approve: z.boolean(), ids: z.array(id).max(2000).optional(), note: z.string().trim().max(300).optional() }), req.body);
  const out = await vendors.decideVendors(req.ctx, b, req.user);
  await audit(req, b.approve ? 'vendor.approved' : 'vendor.rejected', 'Vendor', undefined, `${b.approve ? 'Approved' : 'Rejected'} ${out.decided} vendor(s)${b.note ? `: ${b.note}` : ''}`);
  res.json(out);
});
approvalRoutes.post('/approvals/vendors/:id', async (req, res) => {
  const b = parse(z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() }), req.body);
  const v = await vendors.decideVendor(req.ctx, req.params.id, b, req.user);
  await audit(req, `vendor.${v.status}`, 'Vendor', v._id, `${v.status === 'approved' ? 'Approved' : 'Rejected'} vendor ${v.name}${b.note ? `: ${b.note}` : ''}`);
  res.json(v);
});
