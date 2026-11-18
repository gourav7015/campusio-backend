import { z } from 'zod';
import { isDateStr } from '../../core/utils.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
const money = z.number().positive().max(10_000_000);
export const MODES = ['cash', 'upi', 'cheque', 'bank_transfer', 'card', 'other'];

const MONTHLY_AFTER = ['once', 'monthly', 'yearly'];
export const structureBody = z.object({
  yearId: id.optional(), classId: id.nullable().optional(), name: z.string().trim().min(3).max(80), autoAssign: z.boolean().default(true),
  admissionFee: z.number().min(0).max(1_000_000).default(0), monthlyFee: z.number().positive().max(1_000_000), dueDay: z.number().int().min(1).max(28).optional(),
  extras: z.array(z.object({ head: z.string().trim().min(2).max(40), amount: money, frequency: z.enum(MONTHLY_AFTER).default('once') })).max(8).default([]),
});
export const structurePatch = z.object({ name: z.string().trim().min(3).max(80), autoAssign: z.boolean(), status: z.enum(['active', 'archived']) }).partial();

export const policyBody = z.object({
  dueDay: z.number().int().min(1).max(28),
  advanceDiscount: z.object({ enabled: z.boolean(), minMonths: z.number().int().min(1).max(12), type: z.enum(['months', 'percent']), value: z.number().positive().max(100) })
    .refine((d) => d.type !== 'months' || d.value <= 6, { message: 'Free months cannot be more than 6', path: ['value'] }),
});
export const advanceBody = z.object({ mode: z.enum(MODES), reference: z.string().trim().max(60).optional(), paidOn: date.optional(), note: z.string().max(200).optional() });

export const assignBody = z.object({
  structureId: id, studentIds: z.array(id).max(1000).optional(), sectionId: id.optional(), all: z.boolean().optional(),
  concession: z.object({ type: z.enum(['percent', 'amount']), value: z.number().positive(), reason: z.string().trim().min(3).max(200) }).optional(),
}).refine((b) => b.studentIds?.length || b.sectionId || b.all, { message: 'Choose students, a section, or everyone the structure applies to' });

export const chargeBody = z.object({ studentId: id, label: z.string().trim().min(3).max(80), amount: money, dueDate: date.optional() });
export const concessionBody = z.object({ amount: money, reason: z.string().trim().min(3).max(200) });
export const paymentBody = z.object({
  studentId: id, amount: money, mode: z.enum(MODES), reference: z.string().trim().max(60).optional(), paidOn: date.optional(), note: z.string().max(200).optional(), chargeIds: z.array(id).max(50).optional(),
});
export const reverseBody = z.object({ reason: z.string().trim().min(3).max(200) });
export const duesQuery = z.object({
  q: z.string().optional(), sectionId: id.optional(), classId: id.optional(), status: z.enum(['all', 'overdue', 'pending', 'clear']).default('all'),
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const rangeQuery = z.object({ from: date.optional(), to: date.optional(), mode: z.enum([...MODES, 'online']).optional(), q: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) });
export const remindBody = z.object({ studentIds: z.array(id).max(1000).optional(), onlyOverdue: z.boolean().default(true) });
