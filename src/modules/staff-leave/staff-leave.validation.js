import { z } from 'zod';
import { isDateStr } from '../../core/utils.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
const TYPES = ['casual', 'sick', 'earned', 'other', 'unpaid'];
const range = (l) => l.endDate >= l.startDate;
const rangeMsg = { message: 'End date cannot be before start date', path: ['endDate'] };

export const applyBody = z.object({ leaveType: z.enum(TYPES), startDate: date, endDate: date, reason: z.string().trim().min(3).max(500), halfDay: z.boolean().optional(), halfSession: z.enum(['first', 'second']).optional() }).refine(range, rangeMsg);
/** A desk records a leave for someone who cannot apply themselves (no login yet, or away). It is approved straight away. */
export const recordBody = z.object({ staffId: id, leaveType: z.enum(TYPES), startDate: date, endDate: date, reason: z.string().trim().min(3).max(500), halfDay: z.boolean().optional(), halfSession: z.enum(['first', 'second']).optional(), sendToAdmin: z.boolean().optional() }).refine(range, rangeMsg);
export const decideBody = z.object({ decision: z.enum(['approve', 'reject']), remark: z.string().max(300).optional() });
export const listQuery = z.object({ status: z.enum(['submitted', 'approved', 'rejected', 'cancelled']).optional() });
