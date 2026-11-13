import { Router } from 'express';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import { upload, saveFile } from '../../services/files.js';
import * as v from './materials.validation.js';
import * as svc from './materials.service.js';

/** multipart bodies arrive as strings; JSON bodies as typed values. Normalise before validating. */
const normalise = (b) => ({ ...b });

function staffRoutes() {
  const r = Router();
  r.get('/materials', async (req, res) => res.json(await svc.listForStaff(req.ctx, parse(v.listQuery, req.query))));
  r.post('/materials', upload.single('file'), async (req, res) => {
    const body = parse(v.materialBody, normalise(req.body));
    const file = req.file ? await saveFile(req, req.file, { kind: 'material', ownerType: 'material' }) : null;
    const m = await svc.createMaterial(req.ctx, body, file);
    await audit(req, 'material.created', 'StudyMaterial', m._id, `Material "${m.title}"`);
    res.status(201).json(m);
  });
  r.patch('/materials/:id', async (req, res) => res.json(await svc.updateMaterial(req.ctx, req.params.id, parse(v.materialPatch, req.body))));
  for (const action of ['publish', 'unpublish', 'archive']) {
    r.post(`/materials/:id/${action}`, async (req, res) => {
      const m = await svc.setStatus(req.ctx, req.params.id, action);
      await audit(req, `material.${action}`, 'StudyMaterial', m._id, `Material "${m.title}" ${action}`);
      res.json(m);
    });
  }
  r.post('/materials/:id/file', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded', code: 'BAD_REQUEST' });
    const file = await saveFile(req, req.file, { kind: 'material', ownerType: 'material', ownerId: req.params.id });
    res.json(await svc.replaceFile(req.ctx, req.params.id, file));
  });
  r.delete('/materials/:id', async (req, res) => { await svc.deleteMaterial(req.ctx, req.params.id); res.json({ ok: true }); });
  return r;
}
export const adminRoutes = staffRoutes();
export const teacherRoutes = staffRoutes();

export const studentRoutes = Router();
studentRoutes.get('/materials', async (req, res) => res.json(await svc.listForStudent(req.ctx, parse(v.studentQuery, req.query))));
studentRoutes.get('/materials/:id', async (req, res) => res.json(await svc.getForStudent(req.ctx, req.params.id)));
