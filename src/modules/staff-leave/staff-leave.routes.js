import { Router } from 'express';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as v from './staff-leave.validation.js';
import * as svc from './staff-leave.service.js';
import { editStaffLeave } from '../scheduling/scheduling.service.js';
import { z } from 'zod';
import { isDateStr } from '../../core/utils.js';

/** The leave desk for one group of staff. */
export function leaveDeskRoutes(group) {
  const r = Router();
  r.get('/', async (req, res) => res.json(await svc.listForGroup(req.ctx, group, parse(v.listQuery, req.query))));
  r.post('/', async (req, res) => {
    const l = await svc.record(req.ctx, group, parse(v.recordBody, req.body));
    await audit(req, 'staff_leave.recorded', 'StaffLeave', l._id, `Recorded ${l.leaveType} leave ${l.startDate} to ${l.endDate}`);
    res.status(201).json(l);
  });
  r.get('/policy', (req, res) => res.json({ approver: svc.adminKeepsTransportLeave(req.ctx) && group === 'transport' ? 'admin' : 'self' }));
  r.post('/:id/pass-to-admin', async (req, res) => {
    const l = await svc.passToAdmin(req.ctx, group, req.params.id);
    await audit(req, 'staff_leave.passed_to_admin', 'StaffLeave', l._id, `Passed ${l.startDate} to ${l.endDate} leave to the School Admin`);
    res.json(l);
  });
  r.post('/:id/decide', async (req, res) => {
    const l = await svc.decide(req.ctx, group, req.params.id, parse(v.decideBody, req.body));
    await audit(req, `staff_leave.${l.status}`, 'StaffLeave', l._id, `Leave ${l.status}: ${l.startDate} to ${l.endDate}`);
    res.json(l);
  });
  r.patch('/:id', async (req, res) => {
    const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
    const b = parse(z.object({ leaveType: z.enum(['casual', 'sick', 'earned', 'other', 'unpaid']), startDate: date, endDate: date, reason: z.string().trim().min(3).max(500), halfDay: z.boolean().optional(), halfSession: z.enum(['first', 'second']).optional() }).partial(), req.body);
    const l = await editStaffLeave(req.ctx, group, req.params.id, b);
    await audit(req, 'staff_leave.edited', 'StaffLeave', l._id, `Edited leave: ${l.leaveType} ${l.startDate} to ${l.endDate}`);
    res.json(l);
  });
  return r;
}

export const adminRoutes = Router();
adminRoutes.use('/staff-leave', leaveDeskRoutes('general'));
adminRoutes.use('/transport-leave', leaveDeskRoutes('transport')); // transport staff leave that came to the School Admin to decide (and the rest, for information)
