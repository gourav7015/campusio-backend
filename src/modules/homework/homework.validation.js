import { z } from 'zod';
import { isDateStr } from '../../core/utils.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
export const types = ['written', 'reading', 'project', 'worksheet', 'practical', 'revision', 'other'];

export const homeworkBody = z.object({
  title: z.string().trim().min(3).max(150), description: z.string().max(4000).optional(), instructions: z.string().max(4000).optional(),
  sectionId: id, subjectId: id, type: z.enum(types).default('written'), assignedDate: date.optional(), dueDate: date,
  maxMarks: z.number().positive().max(1000).optional(), submissionRequired: z.boolean().default(false),
  status: z.enum(['draft', 'scheduled', 'published']).default('draft'), publishAt: z.string().datetime().optional(),
});
export const homeworkPatch = homeworkBody.omit({ sectionId: true, subjectId: true, status: true }).partial();
export const listQuery = z.object({
  tab: z.enum(['all', 'draft', 'published', 'scheduled', 'completed', 'archived']).default('all'),
  sectionId: id.optional(), subjectId: id.optional(), yearId: id.optional(),
});
export const studentQuery = z.object({ tab: z.enum(['all', 'pending', 'due_soon', 'overdue', 'completed']).default('all'), subjectId: id.optional(), yearId: id.optional() });
