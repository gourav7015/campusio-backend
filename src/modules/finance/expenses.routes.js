import { Router } from 'express';
import { z } from 'zod';
import { parse, forbidden, isDateStr } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import { SchoolProfile } from '../../models/index.js';
import * as svc from './expenses.service.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
const expenseBody = z.object({
  date, department: z.string().trim().min(2).max(60), work: z.string().trim().max(80).optional(), title: z.string().trim().min(3).max(120),
  vendor: z.string().trim().max(80).optional(), billNo: z.string().trim().max(40).optional(), amount: z.number().positive().max(100_000_000), notes: z.string().max(500).optional(),
});
const listQuery = z.object({ status: z.enum(['all', 'pending', 'approved', 'rejected']).default('all'), department: z.string().optional(), from: date.optional(), to: date.optional(), yearId: id.optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) });
const budgetBody = z.object({ yearId: id.optional(), department: z.string().trim().min(2).max(60), work: z.string().trim().max(80).optional(), allocated: z.number().min(0).max(1_000_000_000), notes: z.string().max(300).optional() });
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
approvalRoutes.get('/approvals', async (req, res) => {
  const sched = await import('../scheduling/scheduling.service.js');
  const [expenses, swaps, exceptions] = await Promise.all([svc.pendingApprovals(req.ctx), sched.adminSwaps(req.ctx, { status: 'awaiting' }), sched.listExceptions(req.ctx, { status: 'pending' })]);
  res.json({ expenses, swaps, exceptions, counts: { expenses: expenses.length, swaps: swaps.length, exceptions: exceptions.length } });
});
approvalRoutes.post('/approvals/expenses/:id', async (req, res) => {
  const b = parse(z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() }), req.body);
  const e = await svc.decideExpense(req.ctx, req.params.id, b, req.user);
  await audit(req, `expense.${e.status}`, 'Expense', e._id, `${e.status === 'approved' ? 'Approved' : 'Rejected'} expense "${e.title}" ₹${e.amount}${b.note ? `: ${b.note}` : ''}`);
  res.json(e);
});
