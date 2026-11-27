import { Router } from 'express';
import { z } from 'zod';
import { parse, isDateStr } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import { Teacher } from '../../models/index.js';
import { teacherDay } from '../../services/timetable.js';
import * as svc from './scheduling.service.js';
import * as mode from '../attendance/attendance.mode.js';
import { modeOn } from '../../services/attendanceMode.js';

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
  const rows = await teacherDay({ tenantId: req.tenantId, yearId: req.ctx.year._id, teacherId, date: q.date, today: req.ctx.today, tz: req.ctx.settings.timezone, periodWise: modeOn(req.ctx.settings.attendance, q.date) });
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
  const rows = await teacherDay({ tenantId: req.tenantId, yearId: req.ctx.year._id, teacherId: req.ctx.teacher._id, date: d, today: req.ctx.today, tz: req.ctx.settings.timezone, periodWise: modeOn(req.ctx.settings.attendance, d) });
  const out = await svc.teacherPeriodDay(req.ctx, d, rows);
  res.json({ date: d, enabled: out.enabled, periods: out.rows });
});
t.get('/class-periods', async (req, res) => { const q = parse(z.object({ sectionId: id, date: date.optional() }), req.query); res.json(await svc.sectionDay(req.ctx, { sectionId: q.sectionId, date: q.date || req.ctx.today })); });
t.get('/period-attendance/register', async (req, res) => res.json(await svc.periodRegister(req.ctx, parse(z.object({ entryId: id, date }), req.query))));
const periodBody = z.object({ entryId: id, date, entries: z.array(z.object({ studentId: id, status: z.enum(['present', 'absent', 'late', 'half_day', 'leave', 'excused']) })).max(300) });
t.put('/period-attendance/register', async (req, res) => res.json(await svc.savePeriodRegister(req.ctx, req.user, { ...parse(periodBody, req.body), submit: false })));
t.post('/period-attendance/register/submit', async (req, res) => {
  const b = parse(periodBody, req.body);
  const out = await svc.savePeriodRegister(req.ctx, req.user, { ...b, submit: true });
  await audit(req, out.edited ? 'attendance.period_edited' : 'attendance.period_submitted', 'PeriodAttendanceSession', out.id, `${out.edited ? 'Changed' : 'Submitted'} a period register for ${b.date}`);
  res.json(out);
});

export const studentRoutes = Router();
studentRoutes.get('/period-attendance', async (req, res) => res.json(await svc.studentPeriods(req.ctx, parse(z.object({ date: date.optional() }), req.query).date || req.ctx.today)));
studentRoutes.get('/period-attendance/subjects', async (req, res) => res.json(await svc.studentSubjects(req.ctx)));
studentRoutes.get('/period-attendance/subjects/:subjectId', async (req, res) => res.json(await svc.studentSubjectPeriods(req.ctx, parse(z.object({ subjectId: z.union([id, z.literal('other')]) }), req.params).subjectId)));

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
a.get('/period-attendance', async (req, res) => { const q = parse(z.object({ sectionId: id, date: date.optional() }), req.query); res.json(await svc.sectionDay(req.ctx, { sectionId: q.sectionId, date: q.date || req.ctx.today })); });
a.put('/period-attendance/correct', async (req, res) => {
  const b = parse(z.object({ sectionId: id, date, periodId: id, studentId: id, status: z.enum(['present', 'absent', 'late', 'half_day', 'leave', 'excused']), reason: z.string().trim().min(3).max(300) }), req.body);
  const out = await svc.correctPeriod(req.ctx, req.user, b);
  await audit(req, 'attendance.period_corrected', 'PeriodAttendanceSession', null, `Corrected a period on ${b.date}`, { reason: b.reason, to: b.status });
  res.json(out);
});
a.post('/period-attendance/remind', async (req, res) => res.json(await svc.remindPeriod(req.ctx, parse(z.object({ sectionId: id, date, periodId: id }), req.body))));
// the way the school takes student attendance: once a day or period by period. Not available to sub-admins (it changes the whole school).
a.get('/attendance-mode', async (req, res) => res.json(await mode.modeInfo(req.ctx)));
a.put('/attendance-mode', async (req, res) => {
  const b = parse(z.object({ periodWise: z.boolean(), from: date }), req.body);
  const out = await mode.setMode(req.ctx, req.user, b);
  await audit(req, 'attendance.mode_changed', 'School', req.tenantId, out.cancelled ? 'Withdrew a booked change of how attendance is taken' : `Attendance will be taken ${b.periodWise ? 'period by period' : 'once a day'} from ${b.from}`);
  res.json(out);
});
a.patch('/leave/:id', async (req, res) => {
  const b = parse(z.object({ leaveType: z.enum(['casual', 'sick', 'earned', 'other', 'unpaid']), startDate: date, endDate: date, reason: z.string().trim().min(3).max(500), editNote: z.string().trim().max(200), halfDay: z.boolean().optional(), halfSession: z.enum(['first', 'second']).optional() }).partial(), req.body);
  const l = await svc.editTeacherLeave(req.ctx, req.params.id, b, req.user);
  await audit(req, 'leave.edited', 'LeaveApplication', l._id, `Admin edited a leave: ${l.leaveType} ${l.startDate} to ${l.endDate}`);
  res.json(l);
});
