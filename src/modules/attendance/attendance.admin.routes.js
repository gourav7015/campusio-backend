import { Router } from 'express';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as v from './attendance.validation.js';
import * as svc from './attendance.service.js';

const r = Router();

r.get('/attendance/overview', async (req, res) => res.json(await svc.overview(req.ctx, parse(v.overviewQuery, req.query).date || req.ctx.today)));
r.get('/attendance/register', async (req, res) => res.json(await svc.getRegister(req.ctx, parse(v.registerQuery, req.query))));
r.get('/attendance/history', async (req, res) => res.json(await svc.sectionHistory(req.ctx, parse(v.historyQuery, req.query))));

// Admin can take or fix attendance for any section; corrections are always logged.
r.put('/attendance/register', async (req, res) => {
  const out = await svc.saveRegister(req.ctx, parse(v.saveBody, req.body), { submit: false });
  res.json(out);
});
r.post('/attendance/register/submit', async (req, res) => {
  const body = parse(v.saveBody, req.body);
  const out = await svc.saveRegister(req.ctx, body, { submit: true });
  await audit(req, 'attendance.submitted', 'AttendanceSession', out.session._id, `Attendance submitted for ${body.date}`);
  res.json(out);
});
r.post('/attendance/correct', async (req, res) => {
  const body = parse(v.correctBody, req.body);
  const rec = await svc.correctRecord(req.ctx, body, req.user.name);
  await audit(req, 'attendance.corrected', 'AttendanceRecord', rec._id, `Attendance corrected for ${body.date}`, { reason: body.reason, to: body.status });
  res.json(rec);
});

r.get('/attendance/queries', async (req, res) => res.json(await svc.listQueries(req.ctx, { status: req.query.status })));
r.post('/attendance/queries/:id/resolve', async (req, res) => {
  const q = await svc.resolveQuery(req.ctx, req.params.id, parse(v.resolveQueryBody, req.body));
  await audit(req, 'attendance.query_resolved', 'AttendanceQuery', q._id, 'Answered attendance query');
  res.json(q);
});

export default r;
