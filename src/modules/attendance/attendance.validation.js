import { z } from 'zod';
import { isDateStr } from '../../core/utils.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
export const status = z.enum(['present', 'absent', 'late', 'leave', 'excused']);

export const registerQuery = z.object({ sectionId: id, date });
export const saveBody = z.object({
  sectionId: id, date, remarks: z.string().max(300).optional(),
  entries: z.array(z.object({ studentId: id, status, remarks: z.string().max(200).optional() })).max(300),
});
export const correctBody = z.object({ sectionId: id, date, studentId: id, status, reason: z.string().trim().min(3).max(300) });
export const historyQuery = z.object({ sectionId: id, from: date.optional(), to: date.optional() });
export const overviewQuery = z.object({ date: date.optional(), yearId: id.optional() });
export const monthQuery = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional(), yearId: id.optional() });
export const rangeQuery = z.object({ from: date.optional(), to: date.optional(), yearId: id.optional() });
export const queryBody = z.object({ date, message: z.string().trim().min(5).max(500) });
export const resolveQueryBody = z.object({ status: z.enum(['resolved', 'rejected']), response: z.string().trim().min(2).max(500) });
export const requestCorrectionBody = z.object({ sectionId: id, date, note: z.string().trim().min(5).max(500) });
