import { z } from 'zod';
import { TICKET_CATEGORIES } from '../../models/index.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const category = z.enum(TICKET_CATEGORIES);
const STATUSES = ['open', 'pending', 'resolved', 'closed'];

export const createBody = z.object({
  subject: z.string().trim().min(3).max(150), body: z.string().trim().min(3).max(5000),
  category: category.default('general'), priority: z.enum(['low', 'normal', 'high']).default('normal'),
  sentTo: id.optional().or(z.literal('').transform(() => undefined)), // a school query may be addressed to one person; empty = the whole office
});
// a reply may arrive as JSON or as a form with files, where every value is text, so "true" is accepted as well as true
const flag = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]).default(false);
export const replyBody = z.object({ body: z.string().trim().min(1).max(5000), internal: flag });
/** What the handling side may change. */
export const patchBody = z.object({
  status: z.enum(STATUSES).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), category: category.optional(),
  assignedTo: id.nullable().optional(),
}).refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export const listQuery = z.object({
  status: z.enum(STATUSES).optional(), open: z.enum(['true', 'false']).optional(), // open=true: anything not resolved or closed
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), category: category.optional(),
  q: z.string().trim().max(100).optional(), mine: z.enum(['true', 'false']).optional(), schoolId: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30), skip: z.coerce.number().int().min(0).default(0),
});
