import { Router } from 'express';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import { upload, saveFile } from '../../services/files.js';
import * as v from './comms.validation.js';
import * as ann from './announcements.service.js';
import * as cal from './calendar.service.js';
import * as notif from './notifications.service.js';

const viewerOf = (req) => {
  if (req.user.role === 'teacher') return { role: 'teacher', sectionIds: req.ctx.scope.sectionIds, userId: req.user._id };
  if (req.user.role === 'student') return { role: 'student', sectionIds: req.ctx.sectionIds, userId: req.user._id };
  return { role: req.user.role, sectionIds: [], userId: req.user._id };
};

// ── announcements read side (every portal) ──
function readRoutes() {
  const r = Router();
  r.get('/announcements', async (req, res) => res.json(await ann.listFor(req.ctx, viewerOf(req))));
  r.get('/announcements/:id', async (req, res) => res.json(await ann.getFor(req.ctx, viewerOf(req), req.params.id)));
  r.post('/announcements/:id/read', async (req, res) => { await ann.markRead(req.ctx, viewerOf(req), req.params.id); res.json({ ok: true }); });
  r.get('/notifications', async (req, res) => res.json(await notif.list(req.ctx, req.user._id, parse(v.notificationQuery, req.query))));
  r.post('/notifications/read-all', async (req, res) => res.json({ updated: await notif.markAllRead(req.ctx, req.user._id, req.query.category) }));
  r.post('/notifications/:id/read', async (req, res) => res.json(await notif.markRead(req.ctx, req.user._id, req.params.id)));
  return r;
}

export const teacherRoutes = readRoutes();
teacherRoutes.get('/calendar', async (req, res) => {
  const { from, to } = parse(v.calendarQuery, req.query);
  const scope = req.ctx.scope;
  const { Section } = await import('../../models/index.js');
  const secs = await Section.find({ tenantId: req.tenantId, _id: { $in: scope.sectionIds } }).select('classId').lean();
  res.json(await cal.feed(req.ctx, { from, to }, { sectionIds: scope.sectionIds, classIds: secs.map((s) => s.classId), teacherId: req.ctx.teacher._id }));
});
teacherRoutes.post('/announcements', async (req, res) => {
  const a = await ann.createForTeacher(req.ctx, parse(v.teacherNoticeBody, req.body), req.user);
  await audit(req, 'announcement.created', 'Announcement', a._id, `Class notice "${a.title}"`);
  res.status(201).json(a);
});
teacherRoutes.delete('/announcements/:id', async (req, res) => {
  const a = await ann.remove(req.ctx, req.params.id, { role: 'teacher', userId: req.user._id });
  await audit(req, 'announcement.deleted', 'Announcement', a._id, `Deleted class notice "${a.title}"`);
  res.json({ ok: true });
});
teacherRoutes.delete('/messages/:id', async (req, res) => { await notif.retractMessage(req.ctx, req.user._id, req.params.id); res.json({ ok: true }); });
teacherRoutes.get('/messages', async (req, res) => res.json(await notif.myMessages(req.ctx, req.user._id)));
teacherRoutes.post('/messages', async (req, res) => res.status(201).json(await notif.sendToAdmin(req.ctx, req.user, parse(v.messageBody, req.body))));

export const studentRoutes = readRoutes();
studentRoutes.get('/calendar', async (req, res) => {
  const { from, to } = parse(v.calendarQuery, req.query);
  const classIds = [...new Set(req.ctx.enrolments.map((e) => String(e.classId)))];
  res.json(await cal.feed(req.ctx, { from, to }, { sectionIds: req.ctx.sectionIds, classIds }));
});

export const adminRoutes = readRoutes();
adminRoutes.post('/announcements', async (req, res) => {
  const a = await ann.create(req.ctx, parse(v.announcementBody, req.body), req.user);
  await audit(req, 'announcement.created', 'Announcement', a._id, `Announcement "${a.title}"`);
  res.status(201).json(a);
});
adminRoutes.patch('/announcements/:id', async (req, res) => res.json(await ann.update(req.ctx, req.params.id, parse(v.announcementPatch, req.body))));
adminRoutes.delete('/announcements/:id', async (req, res) => {
  const a = await ann.remove(req.ctx, req.params.id, { role: req.user.role, userId: req.user._id });
  await audit(req, 'announcement.deleted', 'Announcement', a._id, `Deleted announcement "${a.title}"`);
  res.json({ ok: true });
});
adminRoutes.post('/announcements/:id/archive', async (req, res) => res.json(await ann.archive(req.ctx, req.params.id)));
adminRoutes.post('/announcements/:id/attachments', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded', code: 'BAD_REQUEST' });
  const file = await saveFile(req, req.file, { kind: 'announcement', ownerType: 'announcement', ownerId: req.params.id, visibility: 'school' });
  res.status(201).json(await ann.attach(req.ctx, req.params.id, file));
});
adminRoutes.get('/events', async (req, res) => res.json(await cal.listEvents(req.ctx, parse(v.calendarQuery, req.query))));
adminRoutes.post('/events', async (req, res) => {
  const e = await cal.createEvent(req.ctx, parse(v.eventBody, req.body));
  await audit(req, 'event.created', 'CalendarEvent', e._id, `Calendar: ${e.title}`);
  res.status(201).json(e);
});
adminRoutes.patch('/events/:id', async (req, res) => res.json(await cal.updateEvent(req.ctx, req.params.id, parse(v.eventPatch, req.body))));
adminRoutes.delete('/events/:id', async (req, res) => { await cal.deleteEvent(req.ctx, req.params.id); res.json({ ok: true }); });
adminRoutes.get('/messages', async (req, res) => res.json(await notif.inbox(req.ctx)));
adminRoutes.post('/messages/:id/read', async (req, res) => res.json(await notif.markMessageRead(req.ctx, req.params.id)));
