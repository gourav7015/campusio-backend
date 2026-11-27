import { Router } from 'express';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as v from './leave.validation.js';
import * as svc from './leave.service.js';
import { grantsOf } from '../leave-grants/leave-grants.service.js';
import { affectedPeriods } from '../timetable/timetable.service.js';

export const teacherRoutes = Router();
teacherRoutes.get('/leave', async (req, res) => res.json({ applications: await svc.listMine(req.ctx), balances: await svc.balances(req.ctx, req.ctx.teacher._id), grants: await grantsOf(req.ctx, 'teacher', req.ctx.teacher._id) }));
teacherRoutes.post('/leave', async (req, res) => {
  const l = await svc.apply(req.ctx, parse(v.applyBody, req.body));
  await audit(req, 'leave.applied', 'LeaveApplication', l._id, `Leave ${l.startDate} to ${l.endDate}`);
  res.status(201).json(l);
});
teacherRoutes.post('/leave/:id/submit', async (req, res) => res.json(await svc.submitDraft(req.ctx, req.params.id)));
const withdrawLeave = async (req, res) => {
  const l = await svc.cancel(req.ctx, req.params.id);
  await audit(req, 'leave.withdrawn', 'LeaveApplication', l._id, `Leave withdrawn: ${l.startDate} to ${l.endDate}`);
  res.json(l);
};
teacherRoutes.post('/leave/:id/withdraw', withdrawLeave);
teacherRoutes.post('/leave/:id/cancel', withdrawLeave); // the old name still works

export const adminRoutes = Router();
adminRoutes.get('/leave', async (req, res) => res.json(await svc.listAll(req.ctx, req.query)));
adminRoutes.get('/leave/teachers', async (req, res) => res.json(await svc.substituteChoices(req.ctx)));
adminRoutes.get('/leave/:id/affected-periods', async (req, res) => res.json(await affectedPeriods(req.tenantId, req.params.id)));
adminRoutes.post('/leave/:id/decide', async (req, res) => {
  const l = await svc.decide(req.ctx, req.params.id, parse(v.decideBody, req.body));
  await audit(req, `leave.${l.status}`, 'LeaveApplication', l._id, `Leave ${l.status}`);
  res.json(l);
});
