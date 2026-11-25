import { z } from 'zod';
import { isDateStr } from '../../core/utils.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');

export const bookBody = z.object({
  title: z.string().trim().min(2).max(150), author: z.string().trim().max(100).optional(), isbn: z.string().trim().max(20).optional(), category: z.string().trim().max(40).optional(),
  publisher: z.string().max(80).optional(), edition: z.string().max(30).optional(), language: z.string().max(30).optional(), shelf: z.string().max(30).optional(),
  referenceOnly: z.boolean().optional(), price: z.number().min(0).max(100000).default(0), description: z.string().max(1000).optional(), copies: z.number().int().min(1).max(200).default(1),
});
export const bookPatch = bookBody.omit({ copies: true }).partial().extend({ status: z.enum(['active', 'archived']).optional() });
export const addCopiesBody = z.object({ count: z.number().int().min(1).max(200) });
export const copyStatusBody = z.object({ status: z.enum(['available', 'damaged', 'lost', 'withdrawn']), notes: z.string().max(200).optional() });
export const booksQuery = z.object({ q: z.string().optional(), category: z.string().optional(), availability: z.enum(['all', 'available', 'out', 'reference']).default('all'), shelf: z.string().optional(), language: z.string().optional(), author: z.string().optional(), sort: z.enum(['title', 'newest', 'popular']).default('title'), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(30) });

export const issueBody = z.object({ accessionNo: z.string().trim().min(1).optional(), copyId: id.optional(), borrowerType: z.enum(['student', 'teacher']), borrowerId: id, days: z.number().int().min(1).max(180).optional() })
  .refine((b) => b.accessionNo || b.copyId, { message: 'Scan or enter the accession number', path: ['accessionNo'] });
export const returnBody = z.object({
  issueId: id.optional(), accessionNo: z.string().trim().optional(), condition: z.enum(['good', 'damaged', 'lost']).default('good'), damageFine: z.number().min(0).max(100000).optional(),
  waiveFine: z.boolean().optional(), waiveReason: z.string().trim().max(200).optional(), returnedOn: date.optional(),
}).refine((b) => b.issueId || b.accessionNo, { message: 'Scan or enter the accession number', path: ['accessionNo'] })
  .refine((b) => !b.waiveFine || (b.waiveReason && b.waiveReason.length >= 3), { message: 'Give a reason to waive a fine', path: ['waiveReason'] });
export const loansQuery = z.object({ status: z.enum(['issued', 'returned', 'lost', 'overdue', 'all']).default('issued'), q: z.string().optional(), borrowerType: z.enum(['student', 'teacher']).optional(), borrowerId: id.optional(), classId: id.optional(), sectionId: id.optional(), category: z.string().optional(), dueFrom: date.optional(), dueTo: date.optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const borrowerQuery = z.object({ type: z.enum(['student', 'teacher']).default('student'), q: z.string().trim().optional(), classId: id.optional(), sectionId: id.optional(), show: z.enum(['all', 'canBorrow', 'hasBooks', 'overdue', 'fine']).default('all') })
  .refine((b) => b.q || b.classId || b.sectionId || b.show !== 'all', { message: 'Type a name or choose a class', path: ['q'] });
export const suggestQuery = z.object({ q: z.string().trim().max(60).optional(), mode: z.enum(['issue', 'return']).default('issue'), limit: z.coerce.number().int().min(1).max(30).default(8), category: z.string().optional(), shelf: z.string().optional(), language: z.string().optional(), author: z.string().optional(), show: z.enum(['all', 'available', 'overdue']).default('all') })
  .refine((b) => b.q || b.category || b.shelf || b.language || b.author || b.show !== 'all' || b.mode === 'return', { message: 'Type something or choose a filter', path: ['q'] });
export const settingsBody = z.object({
  loanDays: z.object({ student: z.number().int().min(1).max(180), teacher: z.number().int().min(1).max(365) }),
  maxBooks: z.object({ student: z.number().int().min(1).max(20), teacher: z.number().int().min(1).max(50) }),
  finePerDay: z.number().min(0).max(1000), maxRenewals: z.number().int().min(0).max(10), blockIfOverdue: z.boolean(),
}).partial();
