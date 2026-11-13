import { Router } from 'express';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as v from './attendance.validation.js';
import * as svc from './attendance.service.js';

const r = Router();

r.get('/attendance/register', async (req, res) => res.json(await svc.getRegister(req.ctx, parse(v.registerQuery, req.query))));
r.put('/attendance/register', async (req, res) => res.json(await svc.saveRegister(req.ctx, parse(v.saveBody, req.body), { submit: false })));
r.post('/attendance/register/submit', async (req, res) => {
  const body = parse(v.saveBody, req.body);
  const out = await svc.saveRegister(req.ctx, body, { submit: true });
  await audit(req, 'attendance.submitted', 'AttendanceSession', out.session._id, `Attendance submitted for ${body.date}`);
  res.json(out);
});
// Submitted registers are locked for teachers; they ask the admin to correct them.
r.post('/attendance/request-correction', async (req, res) => {
  const body = parse(v.requestCorrectionBody, req.body);
  const m = await svc.requestCorrection(req.ctx, req.user, body);
  await audit(req, 'attendance.correction_requested', 'AttendanceSession', null, `Correction requested for ${body.date}`);
  res.status(201).json(m);
});
r.get('/attendance/history', async (req, res) => res.json(await svc.sectionHistory(req.ctx, parse(v.historyQuery, req.query))));

/** Today's register state + weekly trend across the teacher's sections. */
r.get('/attendance/overview', async (req, res) => {
  const ids = req.ctx.scope.sectionIds;
  res.json({ date: req.ctx.today, trend: await svc.trend(req.ctx, ids, 7) });
});

r.get('/attendance/queries', async (req, res) => res.json(await svc.listQueries(req.ctx, { status: req.query.status, sectionIds: req.ctx.scope.classTeacherSectionIds })));
r.post('/attendance/queries/:id/resolve', async (req, res) => {
  res.json(await svc.resolveQuery(req.ctx, req.params.id, parse(v.resolveQueryBody, req.body), req.ctx.scope.classTeacherSectionIds));
});

export default r;
