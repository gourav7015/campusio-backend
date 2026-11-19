import { z } from 'zod';
import { isDateStr } from '../../core/utils.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
export const GROUPS = ['teachers', 'general', 'office', 'transport']; // office: the school's own officers (finance, librarian, transport officer)
export const STATUSES = ['present', 'absent', 'late', 'half_day', 'leave'];

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
export const importBody = z.object({ group: z.enum(GROUPS), rows: z.array(z.object({ code: z.string().trim().min(1).max(40), date, time })).min(1).max(30000) });
export const registerQuery = z.object({ group: z.enum(GROUPS), date: date.optional() });
export const registerBody = z.object({
  group: z.enum(GROUPS), date, submit: z.boolean().default(false),
  entries: z.array(z.object({ personId: id, status: z.enum(STATUSES), halfSession: z.enum(['first', 'second']).optional(), remark: z.string().trim().max(120).optional(), checkIn: time.nullable().optional(), checkOut: time.nullable().optional() })).max(2000),
});
export const correctBody = z.object({ group: z.enum(GROUPS), date, personId: id, status: z.enum(STATUSES), halfSession: z.enum(['first', 'second']).optional(), reason: z.string().trim().min(3).max(200) });
export const monthQuery = z.object({ group: z.enum(GROUPS), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() });
