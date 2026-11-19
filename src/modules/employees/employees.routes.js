import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/utils.js';
import * as svc from './employees.service.js';

const query = z.object({
  category: z.enum(svc.CATEGORIES).optional(), q: z.string().trim().max(100).optional(), designation: z.string().trim().max(60).optional(),
  login: z.enum(['has', 'none']).optional(), subjectId: z.string().regex(/^[a-f0-9]{24}$/i).optional(), classId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  classTeacher: z.enum(['yes']).optional(), desk: z.string().trim().max(30).optional(), attendanceDesk: z.enum(['yes']).optional(),
  bus: z.enum(['on', 'off']).optional(), licence: z.enum(['expired', 'expiring', 'missing']).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('active'), limit: z.coerce.number().int().min(1).max(1000).default(500),
});

/** The School Admin's directory of every employee: teaching, non-teaching, officers and transport crew. Read-only; each kind is managed on its own page. */
export const adminRoutes = Router();
adminRoutes.get('/employees', async (req, res) => res.json(await svc.listEmployees(req.ctx, parse(query, req.query))));
