import { z } from 'zod';
import { isDateStr } from '../../core/utils.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');

export const periodBody = z.object({ name: z.string().trim().min(1).max(30), order: z.number().int().min(1).max(30), startTime: time, endTime: time, type: z.enum(['lesson', 'break']).default('lesson') })
  .refine((p) => p.endTime > p.startTime, { message: 'End time must be after start time', path: ['endTime'] });
export const periodPatch = z.object({ name: z.string().trim().min(1).max(30), order: z.number().int().min(1).max(30), startTime: time, endTime: time, type: z.enum(['lesson', 'break']) }).partial();

export const entryBody = z.object({ sectionId: id, day: z.number().int().min(1).max(7), periodId: id, assignmentId: id, room: z.string().max(20).optional() });
export const entryPatch = z.object({ assignmentId: id, room: z.string().max(20) }).partial();
export const entriesQuery = z.object({ sectionId: id.optional(), teacherId: id.optional(), yearId: id.optional() });
export const substitutionBody = z.object({ entryId: id, date, substituteTeacherId: id, reason: z.string().max(200).optional(), leaveId: id.optional() });
export const dateQuery = z.object({ date: date.optional(), yearId: id.optional() });
