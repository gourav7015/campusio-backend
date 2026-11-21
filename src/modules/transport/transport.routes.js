import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { parse, isDateStr, HttpError } from '../../core/utils.js';
import { upload, saveFile } from '../../services/files.js';
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

const docBody = z.object({ number: z.string().trim().max(40).optional(), issuedOn: z.string().refine(isDateStr, 'Use YYYY-MM-DD').optional().or(z.literal('')), expiresOn: z.string().refine(isDateStr, 'Use YYYY-MM-DD').optional().or(z.literal('')), notes: z.string().trim().max(300).optional(), title: z.string().trim().max(60).optional() });
/** The copy of a document must be a PDF or a picture (PNG, JPG), up to the upload limit. Anything else is deleted and refused. */
const checkCopy = async (file) => {
  if (!file) return;
  if (!['application/pdf', 'image/png', 'image/jpeg'].includes(file.mimetype)) { await fs.promises.unlink(file.path).catch(() => {}); throw new HttpError(400, 'Upload a PDF, PNG or JPG', 'BAD_REQUEST'); }
};
const withCopy = async (req, bus) => { await checkCopy(req.file); return req.file ? saveFile(req, req.file, { kind: 'document', ownerType: 'bus', ownerId: bus, visibility: 'owner' }) : null; };
r.get('/buses/:id/documents', async (req, res) => res.json(await svc.listBusDocuments(req.ctx, req.params.id)));
r.put('/buses/:id/documents/:type', upload.single('file'), async (req, res) => {
  const body = parse(docBody, req.body); const ctx = { ...req.ctx, actorName: req.user.name };
  const saved = await withCopy(req, req.params.id);
  const out = await svc.saveBusDocument(ctx, req.params.id, req.params.type, body, saved);
  await audit(req, 'transport.document_saved', 'Bus', req.params.id, `Recorded ${out.label}${out.expiresOn ? ` valid until ${out.expiresOn}` : ''}`);
  res.json(out);
});
r.post('/buses/:id/documents', upload.single('file'), async (req, res) => {
  const body = parse(docBody, req.body); const ctx = { ...req.ctx, actorName: req.user.name };
  const saved = await withCopy(req, req.params.id);
  const out = await svc.saveBusDocument(ctx, req.params.id, 'other', body, saved);
  await audit(req, 'transport.document_saved', 'Bus', req.params.id, `Recorded ${out.label}`);
  res.status(201).json(out);
});
r.delete('/buses/:id/documents/:docId', async (req, res) => { await svc.removeBusDocument(req.ctx, req.params.id, req.params.docId); await audit(req, 'transport.document_removed', 'Bus', req.params.id, 'Removed a vehicle document'); res.json({ ok: true }); });
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
