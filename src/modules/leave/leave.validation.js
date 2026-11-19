import { z } from 'zod';
import { isDateStr } from '../../core/utils.js';

const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
export const applyBody = z.object({
  leaveType: z.enum(['casual', 'sick', 'earned', 'other', 'unpaid']), startDate: date, endDate: date, reason: z.string().trim().min(3).max(500), draft: z.boolean().optional(), halfDay: z.boolean().optional(), halfSession: z.enum(['first', 'second']).optional(),
}).refine((l) => l.endDate >= l.startDate, { message: 'End date cannot be before start date', path: ['endDate'] });
export const decideBody = z.object({ decision: z.enum(['approve', 'reject']), remark: z.string().max(300).optional() });
