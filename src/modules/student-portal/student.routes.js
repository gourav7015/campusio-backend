import { Router } from 'express';
import { z } from 'zod';
import { parse, isDateStr } from '../../core/utils.js';
import { upload, saveFile } from '../../services/files.js';
import * as svc from './student.service.js';

const r = Router();
r.get('/dashboard', async (req, res) => res.json(await svc.dashboard(req.ctx)));
r.get('/years', async (req, res) => res.json(await svc.myYears(req.ctx)));
r.get('/profile', async (req, res) => res.json(await svc.profile(req.ctx)));
r.patch('/profile', async (req, res) => {
  const body = parse(z.object({ phone: z.string().max(20), address: z.string().max(300), email: z.string().email() }).partial().strict(), req.body);
  res.json(await svc.updateProfile(req.ctx, body));
});
r.post('/profile/photo', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded', code: 'BAD_REQUEST' });
  if (!/^image\//.test(req.file.mimetype)) return res.status(400).json({ error: 'Upload an image', code: 'BAD_REQUEST' });
  const file = await saveFile(req, req.file, { kind: 'photo', ownerType: 'student', ownerId: req.ctx.student._id });
  res.json(await svc.setPhoto(req.ctx, file));
});
r.get('/timetable', async (req, res) => {
  const q = parse(z.object({ view: z.enum(['day', 'week', 'subject']).default('day'), date: z.string().refine(isDateStr).optional() }), req.query);
  res.json(await svc.timetable(req.ctx, q));
});
r.get('/documents', async (req, res) => res.json(await svc.documents(req.ctx)));
export default r;
