import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/utils.js';
import { teacherDay, teacherWeek, periodsOf } from '../../services/timetable.js';
import { teacherPerformance } from '../../services/analytics.js';
import { isDateStr } from '../../core/utils.js';
import * as svc from './teacher.service.js';
import { personAttendance } from '../staff-attendance/staff-attendance.service.js';
import { selfPunchRoutes } from '../staff-punch/staff-punch.routes.js';

const r = Router();
const dateQ = z.object({ date: z.string().refine(isDateStr).optional() });

r.get('/dashboard', async (req, res) => res.json(await svc.dashboard(req.ctx)));
r.use(selfPunchRoutes((req) => ({ type: 'teacher', id: req.ctx.teacher._id, group: 'teachers' })));
r.get('/my-attendance', async (req, res) => res.json(await personAttendance(req.ctx, 'teacher', req.ctx.teacher._id, { joiningDate: req.ctx.teacher.joiningDate, group: 'teachers' })));
r.get('/years', async (req, res) => res.json(await svc.myYears(req.ctx)));
r.get('/profile', async (req, res) => res.json(await svc.profile(req.ctx)));
r.patch('/profile', async (req, res) => res.json(await svc.updateProfile(req.ctx, parse(z.object({ phone: z.string().max(20).optional(), address: z.string().max(300).optional() }), req.body))));

r.get('/timetable', async (req, res) => {
  const { date } = parse(dateQ, req.query);
  const c = req.ctx; const d = date || c.today;
  const base = { tenantId: c.tenantId, yearId: c.year._id, teacherId: c.teacher._id, date: d, today: c.today, tz: c.settings.timezone };
  res.json({ date: d, day: await teacherDay(base), week: await teacherWeek({ ...base, days: c.settings.workingDays }), periods: await periodsOf(c.tenantId) });
});

r.get('/classes', async (req, res) => res.json(await svc.myClasses(req.ctx)));
r.get('/classes/:sectionId', async (req, res) => res.json(await svc.classOverview(req.ctx, req.params.sectionId)));
r.get('/classes/:sectionId/students', async (req, res) => res.json(await svc.classStudents(req.ctx, req.params.sectionId)));
r.get('/students/:id', async (req, res) => res.json(await svc.studentDetail(req.ctx, req.params.id)));
r.post('/students/:id/remarks', async (req, res) => res.status(201).json(await svc.addRemark(req.ctx, req.params.id, parse(z.object({ text: z.string().trim().min(3).max(500) }), req.body).text)));
r.get('/subjects', async (req, res) => res.json(await svc.mySubjects(req.ctx)));
r.get('/performance', async (req, res) => res.json(await teacherPerformance(req.ctx)));
r.get('/performance/class/:sectionId', async (req, res) => res.json(await svc.classPerformance(req.ctx, req.params.sectionId)));
r.get('/search', async (req, res) => res.json(await svc.search(req.ctx, String(req.query.q || '').trim())));

export default r;
