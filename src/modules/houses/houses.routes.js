import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as svc from './houses.service.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const color = z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a colour like #1d4ed8').or(z.literal(''));
const body = z.object({ name: z.string().trim().min(2).max(30), color: color.optional(), motto: z.string().trim().max(80).optional() });
const patch = body.partial().extend({ status: z.enum(['active', 'archived']).optional() });

export const adminRoutes = Router();
adminRoutes.get('/houses', async (req, res) => res.json(await svc.listHouses(req.ctx)));
adminRoutes.post('/houses', async (req, res) => {
  const h = await svc.createHouse(req.ctx, parse(body, req.body));
  await audit(req, 'house.created', 'House', h._id, `Added the house ${h.name}`);
  res.status(201).json(h);
});
adminRoutes.post('/houses/distribute', async (req, res) => {
  const out = await svc.distribute(req.ctx);
  await audit(req, 'house.distributed', 'House', null, `Placed ${out.students} student(s) and ${out.teachers} teacher(s) in houses`);
  res.json(out);
});
adminRoutes.get('/houses/:id', async (req, res) => res.json(await svc.houseRoster(req.ctx, req.params.id)));
adminRoutes.patch('/houses/:id', async (req, res) => {
  const h = await svc.updateHouse(req.ctx, req.params.id, parse(patch, req.body));
  await audit(req, 'house.updated', 'House', h._id, `Updated the house ${h.name}`);
  res.json(h);
});
adminRoutes.delete('/houses/:id', async (req, res) => { await svc.deleteHouse(req.ctx, req.params.id); await audit(req, 'house.deleted', 'House', req.params.id, 'Deleted a house'); res.json({ ok: true }); });
adminRoutes.put('/houses/teachers/:teacherId', async (req, res) => {
  const t = await svc.setTeacherHouse(req.ctx, req.params.teacherId, parse(z.object({ house: z.string().max(30) }), req.body).house);
  await audit(req, 'house.teacher_placed', 'Teacher', t._id, `${t.name}: house ${t.house || 'none'}`);
  res.json({ ok: true, house: t.house || '' });
});

/** A teacher sees the house they mentor: its other teachers and its students. */
export const teacherRoutes = Router();
teacherRoutes.get('/house', async (req, res) => {
  const house = req.ctx.teacher.house;
  if (!house) return res.json({ house: null });
  const { House } = await import('../../models/index.js');
  res.json({ house: await House.findOne({ tenantId: req.tenantId, name: house }).lean(), ...(await svc.rosterOf(req.ctx, house)) });
});
