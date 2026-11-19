import { z } from 'zod';
import { isDateStr } from '../../core/utils.js';

const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const phone = z.string().regex(/^[0-9+\-\s()]{7,18}$/, 'Invalid phone number');

export const guardianSchema = z.object({
  name: z.string().trim().min(2), relationship: z.string().trim().min(2), phone, email: z.string().email().optional().or(z.literal('')), isPrimary: z.boolean().optional(),
});

export const profileFields = {
  name: z.string().trim().min(2).max(100), dob: date, gender: z.enum(['male', 'female', 'other', '']).optional(),
  address: z.string().max(300).optional(), phone: phone.optional().or(z.literal('')), email: z.string().email().optional().or(z.literal('')),
  house: z.string().max(40).optional(), bloodGroup: z.string().max(5).optional(),
  guardians: z.array(guardianSchema).min(1, 'At least one guardian is required').max(4),
  emergencyContact: z.object({ name: z.string(), phone: z.string() }).optional(),
};

export const admitBody = z.object({
  ...profileFields,
  admissionNo: z.string().trim().min(1).max(30).optional(), admissionDate: date.optional(),
  yearId: id.optional(), classId: id.optional(), sectionId: id, rollNo: z.number().int().positive().optional(),
  loginId: z.string().optional(), password: z.string().optional(), confirmDuplicate: z.boolean().optional(),
  // a personal discount on tuition, given once at admission. Needs a reason; Finance sees it on the student's charges.
  discount: z.object({ type: z.enum(['percent', 'amount']), value: z.number().positive().max(10_000_000), reason: z.string().trim().min(3).max(200) })
    .refine((d) => d.type !== 'percent' || d.value <= 100, { message: 'A percentage discount must be between 0 and 100', path: ['value'] }).optional(),
});
export const feePreviewQuery = z.object({ sectionId: id, admissionDate: date.optional() });

export const updateStudentBody = z.object({ ...profileFields, admissionNo: z.string().trim().min(1).max(30) }).partial();
export const withdrawBody = z.object({ reason: z.string().trim().min(3), date: date.optional(), outcome: z.enum(['withdrawn', 'transferred_out']).default('withdrawn'), overrideClearance: z.boolean().optional() });
export const transferBody = z.object({ toSectionId: id, effectiveDate: date.optional(), reason: z.string().trim().min(3), rollNo: z.number().int().positive().optional() });
export const listQuery = z.object({
  q: z.string().optional(), yearId: id.optional(), classId: id.optional(), sectionId: id.optional(),
  status: z.enum(['active', 'withdrawn', 'transferred_out', 'completed', 'archived']).optional(),
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const bulkBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('house'), studentIds: z.array(id).min(1).max(500), house: z.string().trim().max(30) }),
  z.object({ action: z.literal('transfer'), studentIds: z.array(id).min(1).max(500), toSectionId: id, effectiveDate: date.optional(), reason: z.string().trim().min(3).max(200) }),
]);
