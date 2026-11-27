import { Router } from 'express';
import { z } from 'zod';
import { parse, isDateStr } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import { upload, saveFile } from '../../services/files.js';
import * as v from './homework.validation.js';
import * as svc from './homework.service.js';

function staffRoutes() {
  const r = Router();
  r.get('/homework', async (req, res) => res.json(await svc.listForStaff(req.ctx, parse(v.listQuery, req.query))));
  r.post('/homework', async (req, res) => {
    const h = await svc.createHomework(req.ctx, parse(v.homeworkBody, req.body), req.user.name);
    await audit(req, 'homework.created', 'Homework', h._id, `Homework "${h.title}" (${h.status})`);
    res.status(201).json(h);
  });
  r.get('/homework/:id', async (req, res) => res.json(await svc.getForStaff(req.ctx, req.params.id)));
  r.patch('/homework/:id', async (req, res) => res.json(await svc.updateHomework(req.ctx, req.params.id, parse(v.homeworkPatch, req.body), req.user.name)));
  for (const action of ['publish', 'schedule', 'unpublish', 'archive']) {
    r.post(`/homework/:id/${action}`, async (req, res) => {
      const { publishAt } = parse(z.object({ publishAt: z.string().datetime().optional() }), req.body);
      const h = await svc.setHomeworkStatus(req.ctx, req.params.id, action, req.user.name, publishAt);
      await audit(req, `homework.${action}`, 'Homework', h._id, `Homework "${h.title}" ${action}`);
      res.json(h);
    });
  }
  r.delete('/homework/:id', async (req, res) => { await svc.deleteHomework(req.ctx, req.params.id); res.json({ ok: true }); });
  r.post('/homework/:id/attachments', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded', code: 'BAD_REQUEST' });
    const file = await saveFile(req, req.file, { kind: 'homework', ownerType: 'homework', ownerId: req.params.id });
    res.status(201).json(await svc.attachFile(req.ctx, req.params.id, file));
  });
  r.delete('/homework/:id/attachments/:fileId', async (req, res) => res.json(await svc.detachFile(req.ctx, req.params.id, req.params.fileId)));
  return r;
}
export const adminRoutes = staffRoutes();
export const teacherRoutes = staffRoutes();

export const studentRoutes = Router();
studentRoutes.get('/homework', async (req, res) => res.json(await svc.listForStudent(req.ctx, parse(v.studentQuery, req.query))));
studentRoutes.get('/homework-day', async (req, res) => res.json(await svc.dayForStudent(req.ctx, parse(z.object({ date: z.string().refine(isDateStr).optional(), weekStart: z.string().refine(isDateStr).optional() }), req.query))));
studentRoutes.get('/homework/:id', async (req, res) => res.json(await svc.getForStudent(req.ctx, req.params.id)));
