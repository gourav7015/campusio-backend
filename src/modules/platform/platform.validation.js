import { z } from 'zod';

const subscription = z.object({
  plan: z.string().default('starter'),
  status: z.enum(['trial', 'active', 'expired', 'cancelled']).default('trial'),
  startsOn: z.string().optional(),
  expiresOn: z.string().optional(),
});

export const createSchoolBody = z.object({
  name: z.string().trim().min(2),
  code: z.string().regex(/^[a-z0-9-]{2,20}$/i, 'Code: 2-20 letters, numbers or dashes'),
  address: z.string().optional(), phone: z.string().optional(), board: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  subscription: subscription.optional(),
  admin: z.object({ name: z.string().trim().min(2), email: z.string().email(), phone: z.string().trim().max(20), dob: z.string(), password: z.string().optional() }).optional(),
});

export const updateSchoolBody = z.object({
  name: z.string().trim().min(2), address: z.string(), phone: z.string(), board: z.string(), email: z.string(),
  status: z.enum(['active', 'suspended', 'archived']),
}).partial();

export const updateSubscriptionBody = subscription.partial().extend({
  plan: z.string().optional(), status: z.enum(['trial', 'active', 'expired', 'cancelled']).optional(),
});

export const createAdminBody = z.object({
  name: z.string().trim().min(2), email: z.string().email(), phone: z.string().trim().max(20), dob: z.string(), loginId: z.string().optional(), password: z.string().optional(),
});

export const userStatusBody = z.object({ status: z.enum(['active', 'disabled']) });
