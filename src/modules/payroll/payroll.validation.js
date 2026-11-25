import { z } from 'zod';
import { isDateStr } from '../../core/utils.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const amount = z.number().min(0).max(10_000_000);
export const MODES = ['bank_transfer', 'cash', 'cheque', 'upi', 'other'];

export const payItem = z.object({
  label: z.string().trim().min(2).max(40), kind: z.enum(['fixed', 'percent']).default('fixed'), value: amount,
}).refine((i) => i.kind !== 'percent' || i.value <= 100, { message: 'A percentage cannot exceed 100', path: ['value'] });
const items = z.array(payItem).max(15).default([]);
const noDuplicateLabels = (o) => new Set([...o.allowances, ...o.deductions].map((i) => i.label.toLowerCase())).size === o.allowances.length + o.deductions.length;
const dupMsg = { message: 'Each allowance/deduction name must be unique' };

export const levelBody = z.object({
  name: z.string().trim().min(2).max(50), description: z.string().max(200).optional(), order: z.number().int().min(0).max(999).default(0), appliesTo: z.enum(['teaching', 'non_teaching']).default('teaching'),
  basic: z.number().positive().max(10_000_000), allowances: items, deductions: items,
}).refine(noDuplicateLabels, dupMsg);
export const levelPatch = z.object({
  name: z.string().trim().min(2).max(50), description: z.string().max(200), order: z.number().int().min(0).max(999),
  basic: z.number().positive().max(10_000_000), allowances: items, deductions: items, status: z.enum(['active', 'archived']),
}).partial();

/** Set or revise a teacher's salary. Give a level (its structure is copied) and/or explicit figures (they win). */
export const salaryBody = z.object({
  levelId: id.optional(), basic: z.number().positive().max(10_000_000).optional(), allowances: items.optional(), deductions: items.optional(),
  effectiveFrom: date, reason: z.string().trim().max(200).optional(),
}).refine((b) => b.levelId || b.basic, { message: 'Choose a pay level or enter a basic salary', path: ['basic'] });
export const bulkSalaryBody = z.object({ levelId: id, personIds: z.array(id).min(1).max(1000), effectiveFrom: date, reason: z.string().trim().max(200).optional() });

/**
 * An increment (or reduction) of basic pay from a date: a percentage, or a fixed rupee amount added to each person's basic.
 * It goes to a group (`scope`) or, when `personIds` is given, to exactly those people (the ones ticked or filtered in the list).
 * `roundTo` rounds each new basic to the nearest 1, 10, 50 or 100 rupees. `preview` only shows the effect.
 */
export const incrementBody = z.object({
  scope: z.enum(['all', 'teachers', 'staff']).default('all'),
  personIds: z.array(id).min(1, 'Pick at least one person').max(1000).optional(),
  mode: z.enum(['percent', 'amount']).default('percent'),
  percent: z.number().min(-50, 'At most 50% less').max(100, 'At most 100% more').optional(),
  amount: z.number().min(-1_000_000, 'At most ₹10,00,000 less').max(1_000_000, 'At most ₹10,00,000 more').optional(),
  roundTo: z.number().int().refine((n) => [1, 10, 50, 100].includes(n), 'Round to 1, 10, 50 or 100').default(1),
  effectiveFrom: date, reason: z.string().trim().max(200).optional(), preview: z.boolean().default(false),
}).superRefine((b, ctx) => {
  if (b.mode === 'percent' && !b.percent) ctx.addIssue({ code: 'custom', path: ['percent'], message: 'Enter a percentage' });
  if (b.mode === 'amount' && !b.amount) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Enter an amount' });
});
/** A one-time bonus on one month's payroll (a draft run): a fixed amount, or a percentage of each person's basic. */
export const bonusBody = z.object({
  label: z.string().trim().min(2).max(60), mode: z.enum(['fixed', 'percent_basic']), value: z.number().positive().max(10_000_000),
  scope: z.enum(['all', 'teachers', 'staff']).default('all'), reason: z.string().trim().max(200).optional(), preview: z.boolean().default(false),
}).refine((b) => b.mode === 'fixed' || b.value <= 1000, { message: 'A percentage bonus can be at most 1000% of basic', path: ['value'] });

export const payrollSettingsBody = z.object({ generateDay: z.number().int().min(0, 'Use a day from 1 to 28, or 0 for off').max(28, 'Use a day from 1 to 28, or 0 for off') });

export const runBody = z.object({ month });
export const adjustBody = z.object({
  adjustments: z.array(z.object({ label: z.string().trim().min(2).max(60), type: z.enum(['earning', 'deduction']), amount: z.number().positive().max(10_000_000), reason: z.string().trim().max(200).optional() })).max(10),
});
export const payBody = z.object({ paidOn: date.optional(), mode: z.enum(MODES).default('bank_transfer'), reference: z.string().trim().max(60).optional(), payslipIds: z.array(id).max(2000).optional() });
export const listQuery = z.object({ q: z.string().optional(), levelId: id.optional(), status: z.enum(['all', 'with', 'without']).default('all'), type: z.enum(['all', 'teachers', 'staff']).default('all') });

export const installmentBody = z.object({ amount: z.number().positive().max(10_000_000), paidOn: date.optional(), mode: z.enum(MODES).default('bank_transfer'), reference: z.string().trim().max(60).optional(), note: z.string().trim().max(120).optional() });
