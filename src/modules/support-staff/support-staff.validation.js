import { z } from 'zod';
import { isDateStr } from '../../core/utils.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
const text = (n) => z.string().trim().max(n);

export const designationBody = z.object({
  name: z.string().trim().min(2).max(40), group: z.enum(['transport', 'general', 'teaching']).default('general'), busRole: z.enum(['driver', 'conductor']).nullable().optional(),
}).refine((d) => !d.busRole || d.group === 'transport', { message: 'Only a transport designation can be a driver or conductor', path: ['busRole'] });
export const designationPatch = z.object({ name: z.string().trim().min(2).max(40), status: z.enum(['active', 'archived']), busRole: z.enum(['driver', 'conductor']).nullable() }).partial();

import { bankFields } from '../teachers/teachers.validation.js';
export const staffBody = bankFields.extend({
  name: z.string().trim().min(2).max(100), designationId: id, phone: text(20).optional(), email: z.string().trim().toLowerCase().email().optional().or(z.literal('')), gender: z.enum(['male', 'female', 'other']).optional(), dob: date.optional(), bloodGroup: text(5).optional(),
  address: text(300).optional(), joiningDate: date.optional(), licenseNo: text(40).optional(), licenseExpiry: date.optional(), idProof: text(60).optional(),
  emergencyContact: z.object({ name: text(80).optional(), phone: text(20).optional() }).optional(), notes: text(300).optional(), canMarkAttendance: z.boolean().optional(),
  alsoBusRoles: z.array(z.enum(['driver', 'conductor'])).max(2).optional(),
});
export const staffPatch = staffBody.partial();
export const listQuery = z.object({
  q: z.string().optional(), designationId: id.optional(), group: z.enum(['transport', 'general']).optional(), status: z.enum(['active', 'inactive', 'all']).default('active'),
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50),
});
