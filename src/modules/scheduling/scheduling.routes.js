import { Router } from 'express';
import { z } from 'zod';
import { parse, isDateStr } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import { Teacher } from '../../models/index.js';
import { teacherDay } from '../../services/timetable.js';
import * as svc from './scheduling.service.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
const decide = z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() });

export const teacherRoutes = Router();
const t = teacherRoutes;
t.get('/swaps', async (req, res) => res.json(await svc.mySwaps(req.ctx)));
t.get('/swaps/colleagues', async (req, res) => res.json((await Teacher.find({ tenantId: req.tenantId, status: 'active', _id: { $ne: req.ctx.teacher._id } }).select('name employeeId').sort({ name: 1 }).lean())));
t.get('/swaps/periods', async (req, res) => {
  const q = parse(z.object({ date, teacherId: id.optional() }), req.query);
  const teacherId = q.teacherId || req.ctx.teacher._id;
  const rows = await teacherDay({ tenantId: req.tenantId, yearId: req.ctx.year._id, teacherId, date: q.date, today: req.ctx.today, tz: req.ctx.settings.timezone });
  res.json(rows.filter((r) => !r.substitute).map((r) => ({ entryId: r.entryId, period: r.period, time: `${r.startTime}–${r.endTime}`, section: `${r.className} ${r.section}`, subject: r.subject })));
});
t.post('/swaps', async (req, res) => {
  const s = await svc.requestSwap(req.ctx, req.user, parse(z.object({ date, fromEntryId: id, toTeacherId: id, toEntryId: id.optional(), reason: z.string().trim().max(300).optional() }), req.body));
  await audit(req, 'swap.requested', 'SwapRequest', s._id, `Asked to swap a period on ${s.date}`);
  res.status(201).json(s);
});
t.post('/swaps/:id/respond', async (req, res) => {
  const s = await svc.respondSwap(req.ctx, req.params.id, parse(z.object({ accept: z.boolean(), note: z.string().trim().max(300).optional() }), req.body));
  await audit(req, 'swap.answered', 'SwapRequest', s._id, `${s.peerStatus} a swap request`);
  res.json(s);
});
t.post('/swaps/:id/cancel', async (req, res) => res.json(await svc.cancelSwap(req.ctx, req.params.id)));

t.get('/attendance/exceptions', async (req, res) => res.json(await svc.listExceptions(req.ctx, { teacherId: req.ctx.teacher._id })));
t.post('/attendance/exceptions', async (req, res) => {
  const e = await svc.requestException(req.ctx, req.user, parse(z.object({ sectionId: id, date, reason: z.string().trim().min(3).max(300) }), req.body));
  await audit(req, 'attendance.exception_requested', 'AttendanceException', e._id, `Asked to take attendance on ${e.date}`);
  res.status(201).json(e);
});

t.get('/period-attendance', async (req, res) => {
  const d = parse(z.object({ date: date.optional() }), req.query).date || req.ctx.today;
  const rows = await teacherDay({ tenantId: req.tenantId, yearId: req.ctx.year._id, teacherId: req.ctx.teacher._id, date: d, today: req.ctx.today, tz: req.ctx.settings.timezone });
  res.json({ date: d, periods: await svc.teacherPeriodDay(req.ctx, d, rows) });
});
t.get('/period-attendance/register', async (req, res) => res.json(await svc.periodRegister(req.ctx, parse(z.object({ entryId: id, date }), req.query))));
t.put('/period-attendance/register', async (req, res) => {
  const b = parse(z.object({ entryId: id, date, entries: z.array(z.object({ studentId: id, status: z.enum(['present', 'absent', 'late', 'half_day', 'leave', 'excused']) })).max(300) }), req.body);
  res.json(await svc.savePeriodRegister(req.ctx, req.user, b));
});

export const studentRoutes = Router();
studentRoutes.get('/period-attendance', async (req, res) => res.json(await svc.studentPeriods(req.ctx, parse(z.object({ date: date.optional() }), req.query).date || req.ctx.today)));

export const adminRoutes = Router();
const a = adminRoutes;
a.get('/swaps', async (req, res) => res.json(await svc.adminSwaps(req.ctx, req.query)));
a.post('/approvals/swaps/:id', async (req, res) => {
  const s = await svc.decideSwap(req.ctx, req.params.id, parse(decide, req.body), req.user);
  await audit(req, `swap.${s.status}`, 'SwapRequest', s._id, `${s.status === 'approved' ? 'Approved' : 'Rejected'} a period swap on ${s.date}`);
  res.json(s);
});
a.get('/attendance-exceptions', async (req, res) => res.json(await svc.listExceptions(req.ctx, req.query)));
a.post('/attendance-exceptions', async (req, res) => {
  const e = await svc.createApprovedException(req.ctx, req.user, parse(z.object({ sectionId: id, date, reason: z.string().trim().min(3).max(300) }), req.body));
  await audit(req, 'attendance.exception_allowed', 'AttendanceException', e._id, `Allowed attendance on ${e.date}`);
  res.status(201).json(e);
});
a.post('/approvals/attendance-exceptions/:id', async (req, res) => {
  const e = await svc.decideException(req.ctx, req.params.id, parse(decide, req.body), req.user);
  await audit(req, `attendance.exception_${e.status}`, 'AttendanceException', e._id, `${e.status} attendance on ${e.date}`);
  res.json(e);
});
a.get('/period-attendance', async (req, res) => { const q = parse(z.object({ sectionId: id, date: date.optional() }), req.query); res.json(await svc.adminPeriodOverview(req.ctx, { sectionId: q.sectionId, date: q.date || req.ctx.today })); });
a.patch('/leave/:id', async (req, res) => {
  const b = parse(z.object({ leaveType: z.enum(['casual', 'sick', 'earned', 'other', 'unpaid']), startDate: date, endDate: date, reason: z.string().trim().min(3).max(500), editNote: z.string().trim().max(200), halfDay: z.boolean().optional(), halfSession: z.enum(['first', 'second']).optional() }).partial(), req.body);
  const l = await svc.editTeacherLeave(req.ctx, req.params.id, b, req.user);
  await audit(req, 'leave.edited', 'LeaveApplication', l._id, `Admin edited a leave: ${l.leaveType} ${l.startDate} to ${l.endDate}`);
  res.json(l);
});
