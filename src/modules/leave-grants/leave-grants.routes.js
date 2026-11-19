import { Router } from 'express';
import { z } from 'zod';
import { parse, forbidden } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as svc from './leave-grants.service.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const groupQuery = z.object({ group: z.enum(['teachers', 'general', 'transport']) });
const grantBody = z.object({
  personType: z.enum(['teacher', 'staff']), personId: id, leaveType: z.enum(['casual', 'sick', 'earned', 'other']),
  days: z.number().min(0.5).max(60).refine((n) => n * 2 === Math.floor(n * 2), 'Use whole or half days'), reason: z.string().trim().min(3).max(300),
});
const historyQuery = z.object({ personType: z.enum(['teacher', 'staff']), personId: id });

/** A sub-admin sees teachers with the teacher permission, and staff with the staff permission. */
const mayOf = (req, personType) => {
  const u = req.user;
  if (u.role !== 'school_admin' || u.adminLevel !== 'sub') return true;
  return (u.permissions || []).includes(personType === 'teacher' ? 'teachers' : 'staff_attendance');
};

export const adminRoutes = Router();
adminRoutes.get('/leave-balances', async (req, res) => {
  const { group } = parse(groupQuery, req.query);
  if (!mayOf(req, group === 'teachers' ? 'teacher' : 'staff')) throw forbidden('Your sub-admin account does not include this group');
  res.json(await svc.listBalances(req.ctx, group));
});
adminRoutes.get('/leave-balances/grants', async (req, res) => {
  const q = parse(historyQuery, req.query);
  if (!mayOf(req, q.personType)) throw forbidden('Your sub-admin account does not include this group');
  res.json(await svc.grantsOf(req.ctx, q.personType, q.personId));
});
adminRoutes.post('/leave-balances/grants', async (req, res) => {
  const b = parse(grantBody, req.body);
  if (!mayOf(req, b.personType)) throw forbidden('Your sub-admin account does not include this group');
  const { grant, name } = await svc.addGrant(req.ctx, b);
  await audit(req, 'leave.granted', 'LeaveGrant', grant._id, `Gave ${name} ${b.days} extra day(s) of ${b.leaveType} leave: ${b.reason}`);
  res.status(201).json(grant);
});
adminRoutes.delete('/leave-balances/grants/:id', async (req, res) => {
  const g = await svc.getGrant(req.ctx, req.params.id);
  if (!mayOf(req, g.personType)) throw forbidden('Your sub-admin account does not include this group');
  await svc.removeGrant(req.ctx, g);
  await audit(req, 'leave.grant_withdrawn', 'LeaveGrant', g._id, `Withdrew ${g.days} extra day(s) of ${g.leaveType} leave`);
  res.json({ ok: true });
});
