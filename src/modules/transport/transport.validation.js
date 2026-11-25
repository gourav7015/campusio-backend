import { z } from 'zod';
import { isDateStr } from '../../core/utils.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

export const busBody = z.object({
  busNo: z.string().trim().min(1).max(20), registrationNo: z.string().trim().max(20).optional(), vehicleModel: z.string().trim().max(60).optional(),
  capacity: z.number().int().min(1).max(120).default(40), status: z.enum(['active', 'maintenance', 'retired']).default('active'),
  routeName: z.string().trim().max(80).optional(), startTime: time.optional(), endTime: time.optional(),
  monthlyFare: z.number().min(0).max(100000).default(0),
  stops: z.array(z.object({ name: z.string().trim().min(1).max(60), pickupTime: time.optional(), dropTime: time.optional(), fare: z.number().min(0).max(100000).optional() })).max(40).default([]),
  driverId: id.nullable().optional(), conductorId: id.nullable().optional(),
  insuranceExpiry: date.optional(), fitnessExpiry: date.optional(), pollutionExpiry: date.optional(), notes: z.string().max(300).optional(),
});
export const busPatch = busBody.partial();
export const assignBody = z.object({ busId: id, studentIds: z.array(id).min(1).max(200), stop: z.string().trim().max(60).optional() });

/** Swap crew between two buses, or the driver and conductor of one bus with each other. */
export const swapBody = z.object({
  busId: id, otherBusId: id.optional(), what: z.enum(['driver', 'conductor', 'both', 'roles']), preview: z.boolean().default(false),
});
