import { Router } from 'express';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as v from './staff-leave.validation.js';
import * as svc from './staff-leave.service.js';

/** The leave desk for one group of staff. */
export function leaveDeskRoutes(group) {
  const r = Router();
  r.get('/', async (req, res) => res.json(await svc.listForGroup(req.ctx, group, parse(v.listQuery, req.query))));
  r.post('/', async (req, res) => {
    const l = await svc.record(req.ctx, group, parse(v.recordBody, req.body));
    await audit(req, 'staff_leave.recorded', 'StaffLeave', l._id, `Recorded ${l.leaveType} leave ${l.startDate} to ${l.endDate}`);
    res.status(201).json(l);
  });
  r.post('/:id/decide', async (req, res) => {
    const l = await svc.decide(req.ctx, group, req.params.id, parse(v.decideBody, req.body));
    await audit(req, `staff_leave.${l.status}`, 'StaffLeave', l._id, `Leave ${l.status}: ${l.startDate} to ${l.endDate}`);
    res.json(l);
  });
  return r;
}

export const adminRoutes = Router();
adminRoutes.use('/staff-leave', leaveDeskRoutes('general'));
