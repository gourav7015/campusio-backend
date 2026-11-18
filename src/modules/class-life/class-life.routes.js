import { Router } from 'express';
import { z } from 'zod';
import { parse, isDateStr } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as svc from './class-life.service.js';
import { upload, saveFile, removeFileBytes } from '../../services/files.js';
import { File } from '../../models/index.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const text = z.string().trim().min(1).max(1000);

export const teacherRoutes = Router();
const t = teacherRoutes;
t.post('/students/:id/remarks', async (req, res) => {
  const b = parse(z.object({ text: z.string().trim().min(3).max(500), category: z.enum(['remark', 'homework', 'behaviour', 'guideline']).default('remark'), requireAck: z.boolean().default(true) }), req.body);
  res.status(201).json(await svc.addRemark(req.ctx, req.params.id, b));
});
t.get('/remarks', async (req, res) => res.json(await svc.teacherRemarks(req.ctx, { pending: req.query.pending === 'true' })));
t.post('/remarks/:id/remind', async (req, res) => res.json(await svc.remindNow(req.ctx, req.params.id)));
t.patch('/students/:id', async (req, res) => {
  const b = parse(z.object({ phone: z.string().trim().max(20), address: z.string().trim().max(300), email: z.string().trim().email(), guardian: z.object({ name: z.string().trim().min(2).max(100), phone: z.string().trim().max(20), email: z.string().trim().email() }).partial() }).partial().strict(), req.body);
  const s = await svc.updateStudentContact(req.ctx, req.params.id, b);
  await audit(req, 'student.contact_updated', 'Student', s._id, `Class teacher updated the details of ${s.name}`, { fields: Object.keys(b) });
  res.json({ ok: true });
});
t.get('/chats', async (req, res) => res.json(await svc.teacherThreads(req.ctx)));
t.post('/chats', async (req, res) => res.status(201).json(await svc.startFromTeacher(req.ctx, req.user, parse(z.object({ studentId: id, text }), req.body))));
t.get('/chats/:id', async (req, res) => res.json(await svc.openThread(req.ctx, req.params.id, 'teacher')));
t.post('/chats/:id/messages', async (req, res) => res.status(201).json(await svc.reply(req.ctx, req.user, req.params.id, 'teacher', parse(z.object({ text }), req.body).text)));
t.put('/classes/:sectionId/monitors', async (req, res) => {
  const out = await svc.setMonitors(req.ctx, req.params.sectionId, parse(z.object({ studentIds: z.array(id).max(5) }), req.body).studentIds);
  await audit(req, 'class.monitors_set', 'Section', req.params.sectionId, `Set ${out.monitorIds.length} monitor(s)`);
  res.json(out);
});
t.post('/attendance/regularise', async (req, res) => {
  const b = parse(z.object({ sectionId: id, date: z.string().refine(isDateStr), studentId: id, reason: z.string().trim().min(3).max(300) }), req.body);
  const rec = await svc.regularise(req.ctx, req.user, b);
  await audit(req, 'attendance.regularised', 'AttendanceRecord', rec._id, `Regularised attendance for ${b.date}: ${b.reason}`);
  res.json({ ok: true, status: rec.status });
});

t.post('/profile/photo', upload.single('file'), async (req, res) => {
  if (!req.file || !/^image\//.test(req.file.mimetype)) return res.status(400).json({ error: 'Upload an image', code: 'BAD_REQUEST' });
  const f = await saveFile(req, req.file, { kind: 'photo', ownerType: 'teacher', ownerId: req.ctx.teacher._id });
  const old = req.ctx.teacher.photoFileId;
  req.ctx.teacher.photoFileId = f._id; await req.ctx.teacher.save();
  if (old) { const of = await File.findById(old); if (of) { await removeFileBytes(of); await of.deleteOne(); } }
  res.json({ id: f._id });
});

export const studentRoutes = Router();
const s = studentRoutes;
s.get('/remarks', async (req, res) => res.json(await svc.studentRemarks(req.ctx)));
s.post('/remarks/:id/acknowledge', async (req, res) => res.json(await svc.acknowledge(req.ctx, req.params.id, req.user.name)));
s.get('/chat-teachers', async (req, res) => res.json(await svc.chatTeachersFor(req.ctx)));
s.get('/chats', async (req, res) => res.json(await svc.studentThreads(req.ctx)));
s.post('/chats', async (req, res) => res.status(201).json(await svc.startFromStudent(req.ctx, req.user, parse(z.object({ teacherId: id, text }), req.body))));
s.get('/chats/:id', async (req, res) => res.json(await svc.openThread(req.ctx, req.params.id, 'student')));
s.post('/chats/:id/messages', async (req, res) => res.status(201).json(await svc.reply(req.ctx, req.user, req.params.id, 'student', parse(z.object({ text }), req.body).text)));

export const adminRoutes = Router();
adminRoutes.put('/monitors/:sectionId', async (req, res) => {
  const out = await svc.setMonitors(req.ctx, req.params.sectionId, parse(z.object({ studentIds: z.array(id).max(5) }), req.body).studentIds);
  await audit(req, 'class.monitors_set', 'Section', req.params.sectionId, `Set ${out.monitorIds.length} monitor(s)`);
  res.json(out);
});
