import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import { staffRoutes, designationRoutes } from '../support-staff/support-staff.routes.js';
import { attendanceRoutes } from '../staff-attendance/staff-attendance.routes.js';
import { leaveDeskRoutes } from '../staff-leave/staff-leave.routes.js';
import * as v from './transport.validation.js';
import * as svc from './transport.service.js';

/**
 * The Transport desk. Mounted for the Transport officer (full access) and for the School Admin (view-only):
 * buses, who drives and conducts them, routes and stops, riders, and the transport staff and designations.
 */
export const transportRouter = Router();
const r = transportRouter;
r.get('/dashboard', async (req, res) => res.json(await svc.dashboard(req.ctx)));
r.get('/lookups', async (req, res) => res.json(await svc.lookups(req.ctx)));
r.get('/students', async (req, res) => res.json(await svc.findStudents(req.ctx, parse(z.object({ sectionId: z.string().regex(/^[a-f0-9]{24}$/i).optional(), q: z.string().max(60).optional() }), req.query))));
r.get('/buses', async (req, res) => res.json(await svc.listBuses(req.ctx)));
r.post('/buses', async (req, res) => {
  const b = await svc.createBus(req.ctx, parse(v.busBody, req.body));
  await audit(req, 'transport.bus_created', 'Bus', b._id, `Added bus ${b.busNo}`);
  res.status(201).json(b);
});
r.get('/buses/:id', async (req, res) => res.json(await svc.getBus(req.ctx, req.params.id)));
r.patch('/buses/:id', async (req, res) => {
  const b = await svc.updateBus(req.ctx, req.params.id, parse(v.busPatch, req.body));
  await audit(req, 'transport.bus_updated', 'Bus', b._id, `Updated bus ${b.busNo}`);
  res.json(b);
});
r.delete('/buses/:id', async (req, res) => { await svc.deleteBus(req.ctx, req.params.id); await audit(req, 'transport.bus_deleted', 'Bus', req.params.id, 'Deleted a bus'); res.json({ ok: true }); });
r.post('/assign', async (req, res) => {
  const out = await svc.assign(req.ctx, parse(v.assignBody, req.body));
  await audit(req, 'transport.assigned', 'Bus', req.body.busId, `Assigned ${out.assigned} student(s) to a bus`);
  res.json(out);
});
r.delete('/students/:studentId', async (req, res) => { await svc.unassign(req.ctx, req.params.studentId); res.json({ ok: true }); });
r.use('/staff', staffRoutes('transport'));
r.use('/designations', designationRoutes('transport'));
r.use('/attendance', attendanceRoutes(['transport'])); // the officer marks the transport crew; the admin can read it
r.use('/leave', leaveDeskRoutes('transport')); // and approves their leave

/** Student portal: read-only, own bus only. */
export const studentRoutes = Router();
studentRoutes.get('/transport', async (req, res) => res.json({ bus: await svc.busOfStudent(req.tenantId, req.ctx.student._id) }));
