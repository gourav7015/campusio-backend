import { z } from 'zod';

export const PORTALS = { student: 'student', teacher: 'teacher', finance: 'finance', library: 'library', transport: 'transport', staff: 'staff', admin: 'school_admin', platform: 'super_admin' };
export const loginBody = z.object({ loginId: z.string().min(1).max(120), password: z.string().min(1).max(200), portal: z.enum(Object.keys(PORTALS)) });
export const changePasswordBody = z.object({ currentPassword: z.string(), newPassword: z.string() });
export const preferencesBody = z.object({
  language: z.enum(['en', 'hi']).optional(),
  notificationPrefs: z.record(z.boolean()).optional(),
});
