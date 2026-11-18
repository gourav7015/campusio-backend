import { z } from 'zod';
import { isDateStr } from '../../core/utils.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');

export const announcementBody = z.object({
  title: z.string().trim().min(3).max(150), body: z.string().max(5000).optional(),
  category: z.enum(['urgent', 'holiday', 'examination', 'event', 'homework', 'general']).default('general'),
  audience: z.object({ all: z.boolean().default(true), roles: z.array(z.enum(['teacher', 'student'])).default([]), sectionIds: z.array(id).default([]) })
    .refine((a) => a.all || a.roles.length || a.sectionIds.length, 'Choose who should receive this'),
  publishAt: z.string().datetime().optional(), status: z.enum(['draft', 'published']).default('published'),
});
export const announcementPatch = announcementBody.partial();

export const eventBody = z.object({
  title: z.string().trim().min(2).max(150), description: z.string().max(1000).optional(),
  type: z.enum(['holiday', 'exam', 'event', 'ptm', 'deadline', 'other']).default('event'), kind: z.enum(['school', 'government']).default('school'),
  startDate: date, endDate: date.optional(), sectionIds: z.array(id).default([]),
});
export const eventPatch = eventBody.partial();
export const calendarQuery = z.object({ from: date.optional(), to: date.optional(), yearId: id.optional() });

export const notificationQuery = z.object({
  category: z.enum(['homework', 'attendance', 'examination', 'results', 'announcements', 'timetable', 'leave', 'fees', 'library', 'system', 'remarks', 'chat', 'approvals', 'helpdesk']).optional(),
  unread: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const messageBody = z.object({ subject: z.string().trim().min(3).max(150), body: z.string().trim().min(3).max(3000) });
export const teacherNoticeBody = z.object({
  title: z.string().trim().min(3).max(150), body: z.string().max(3000).optional(),
  category: z.enum(['urgent', 'homework', 'examination', 'event', 'general']).default('general'),
  sectionIds: z.array(id).min(1, 'Choose at least one class').max(20),
});
