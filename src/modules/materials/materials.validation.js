import { z } from 'zod';
import { isDateStr } from '../../core/utils.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
export const materialTypes = ['pdf', 'image', 'document', 'presentation', 'video', 'worksheet'];

export const materialBody = z.object({
  title: z.string().trim().min(2).max(150), description: z.string().max(2000).optional(), chapter: z.string().max(100).optional(),
  sectionId: id, subjectId: id, materialType: z.enum(materialTypes).default('pdf'),
  externalUrl: z.string().url().refine((u) => /^https?:\/\//i.test(u), 'Only http(s) links are allowed').optional(),
  publishDate: date.optional(), expiryDate: date.optional(), status: z.enum(['draft', 'published']).default('draft'),
});
export const materialPatch = materialBody.omit({ sectionId: true, subjectId: true, status: true }).partial();
export const listQuery = z.object({
  sectionId: id.optional(), subjectId: id.optional(), status: z.enum(['draft', 'published', 'unpublished', 'archived']).optional(),
  from: date.optional(), to: date.optional(), yearId: id.optional(),
});
export const studentQuery = z.object({
  subjectId: id.optional(), chapter: z.string().optional(), type: z.enum(materialTypes).optional(), teacherId: id.optional(), q: z.string().optional(), from: date.optional(), yearId: id.optional(),
});
