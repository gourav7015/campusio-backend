import { z } from 'zod';
import { isDateStr } from '../../core/utils.js';
import { componentsInput } from '../../core/components.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
export const EXAM_TYPES = ['unit_test', 'class_test', 'surprise_test', 'half_yearly', 'annual', 'practical', 'other'];
export const TEACHER_EXAM_TYPES = ['unit_test', 'class_test', 'surprise_test', 'other'];

export const examBody = z.object({
  name: z.string().trim().min(2).max(80), type: z.enum(EXAM_TYPES).default('unit_test'), yearId: id.optional(),
  classIds: z.array(id).min(1, 'Select at least one class'), startDate: date.optional(), endDate: date.optional(), marksDeadline: date.optional(),
}).refine((e) => !e.startDate || !e.endDate || e.endDate >= e.startDate, { message: 'End date cannot be before start date', path: ['endDate'] });
export const examPatch = z.object({
  name: z.string().trim().min(2).max(80), type: z.enum(EXAM_TYPES), classIds: z.array(id).min(1), startDate: date, endDate: date, marksDeadline: date,
  status: z.enum(['draft', 'scheduled', 'archived']),
}).partial();

export const examSubjectBody = z.object({
  classId: id, subjectId: id, date: date.optional(), startTime: time.optional(), endTime: time.optional(), room: z.string().max(20).optional(),
  components: componentsInput.optional(), passMarks: z.number().min(0).max(3000).optional(), marksDeadline: date.optional(),
}).refine((e) => !e.startTime || !e.endTime || e.endTime > e.startTime, { message: 'End time must be after start time', path: ['endTime'] });

/** A teacher adds a test for one of their own sections + subjects (class test, surprise test, unit test…). */
export const teacherExamBody = z.object({
  name: z.string().trim().min(2).max(80), type: z.enum(TEACHER_EXAM_TYPES), sectionId: id, subjectId: id, date,
  startTime: time.optional(), endTime: time.optional(), room: z.string().max(20).optional(),
  components: componentsInput, passMarks: z.number().min(0).max(3000).optional(), marksDeadline: date.optional(),
  notifyStudents: z.boolean().optional(),
}).refine((e) => !e.startTime || !e.endTime || e.endTime > e.startTime, { message: 'End time must be after start time', path: ['endTime'] });
export const teacherExamPatch = z.object({
  name: z.string().trim().min(2).max(80), date, marksDeadline: date, components: componentsInput, passMarks: z.number().min(0).max(3000),
}).partial();

export const publishBody = z.object({ sectionId: id.optional(), all: z.boolean().optional() });
export const returnBody = z.object({ reason: z.string().trim().min(3).max(300) });
export const correctBody = z.object({
  values: z.record(z.number().min(0).nullable()).optional(), absent: z.boolean().optional(), exempt: z.boolean().optional(), reason: z.string().trim().min(3).max(300),
});
export const remarkBody = z.object({ studentId: id, teacherRemark: z.string().max(500).optional(), principalRemark: z.string().max(500).optional() });

const entry = z.object({
  studentId: id, values: z.record(z.number().nullable()).optional(),
  absent: z.boolean().optional(), exempt: z.boolean().optional(), remarks: z.string().max(200).optional(),
});
export const sheetQuery = z.object({ examSubjectId: id, sectionId: id });
export const sheetBody = z.object({ examSubjectId: id, sectionId: id, marks: z.array(entry).max(300) });
export const importBody = z.object({
  examSubjectId: id, sectionId: id, skipInvalid: z.boolean().optional(), dryRun: z.boolean().optional(),
  rows: z.array(z.object({
    admissionNo: z.string().optional(), rollNo: z.coerce.number().optional(), values: z.record(z.coerce.number()).optional(),
    absent: z.coerce.boolean().optional(), exempt: z.coerce.boolean().optional(), remarks: z.string().optional(),
  })).min(1).max(300),
});
export const listQuery = z.object({ yearId: id.optional() });
export const resultsQuery = z.object({ sectionId: id.optional() });
