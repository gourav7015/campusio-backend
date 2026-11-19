import { z } from 'zod';
import { isDateStr } from '../../core/utils.js';

const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

const text = (n) => z.string().trim().max(n);
/** Where salary is paid, and the statutory ids payroll reports need. All optional. */
export const bankFields = z.object({
  bank: z.object({
    accountName: text(80).optional(), accountNo: z.string().trim().regex(/^\d{6,18}$/, 'Account number is 6 to 18 digits').optional().or(z.literal('')),
    ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks like HDFC0001234').optional().or(z.literal('')), bankName: text(60).optional(), upi: text(60).optional(),
  }).optional(),
  statutory: z.object({
    uan: z.string().trim().regex(/^\d{12}$/, 'UAN is 12 digits').optional().or(z.literal('')), esiNo: z.string().trim().regex(/^\d{10,17}$/, 'ESI number is 10 to 17 digits').optional().or(z.literal('')),
    pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'PAN looks like ABCDE1234F').optional().or(z.literal('')),
  }).optional(),
});
export const teacherBody = bankFields.extend({
  name: z.string().trim().min(2).max(100), employeeId: z.string().trim().min(1).max(30),
  email: z.string().email().optional().or(z.literal('')), phone: z.string().max(20).optional(), dob: date.optional(),
  qualification: z.string().max(120).optional(), designation: z.string().max(80).optional(), designationId: z.string().regex(/^[a-f0-9]{24}$/i).optional().or(z.literal('')), house: z.string().trim().max(40).optional(), joiningDate: date.optional(), address: z.string().max(300).optional(),
  subjects: z.array(z.string().trim().min(2).max(40)).max(10).optional(), loginId: z.string().optional(), password: z.string().optional(),
});
export const teacherPatch = teacherBody.omit({ loginId: true, password: true }).partial();
export const listQuery = z.object({
  q: z.string().optional(), status: z.enum(['active', 'inactive']).optional(),
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const assignmentBody = z.object({
  teacherId: id, sectionId: id, subjectId: id.optional(), subject: z.string().trim().min(2).max(40).optional(), weeklyPeriods: z.number().int().min(1).max(20).optional(), effectiveFrom: date.optional(),
}).refine((a) => a.subjectId || a.subject, { message: 'Enter the subject', path: ['subject'] });
export const endAssignmentBody = z.object({ effectiveTo: date.optional() });
export const classTeacherBody = z.object({ teacherId: id, effectiveFrom: date.optional() });
