import { z } from 'zod';

export const PORTALS = { student: 'student', teacher: 'teacher', finance: 'finance', library: 'library', transport: 'transport', staff: 'staff', admin: 'school_admin', platform: 'super_admin' };
export const loginBody = z.object({ loginId: z.string().min(1).max(120), password: z.string().min(1).max(200), portal: z.enum(Object.keys(PORTALS)) });
export const changePasswordBody = z.object({ currentPassword: z.string(), newPassword: z.string() });
export const preferencesBody = z.object({
  language: z.enum(['en', 'hi']).optional(),
  notificationPrefs: z.record(z.boolean()).optional(),
});
export const secondStepBody = z.object({ challenge: z.string().min(10).max(2000), code: z.string().min(6).max(30) });
export const passwordOnly = z.object({ password: z.string().min(1).max(200) });
export const codeBody = z.object({ code: z.string().min(6).max(30) });
export const passwordAndCode = z.object({ password: z.string().min(1).max(200), code: z.string().min(6).max(30) });
export const forgotBody = z.object({ loginId: z.string().min(1).max(120) });
export const resetBody = z.object({ token: z.string().min(20).max(200), newPassword: z.string().min(1).max(200), code: z.string().max(30).optional() });
