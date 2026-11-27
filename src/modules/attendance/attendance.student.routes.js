import { Router } from 'express';
import { parse } from '../../core/utils.js';
import * as v from './attendance.validation.js';
import * as svc from './attendance.service.js';

const r = Router();

r.get('/attendance/summary', async (req, res) => res.json(await svc.studentSummary(req.ctx, { registerOnly: req.query.source === 'register' })));
r.get('/attendance/calendar', async (req, res) => res.json(await svc.studentCalendar(req.ctx, parse(v.monthQuery, req.query).month)));
r.get('/attendance/heatmap', async (req, res) => res.json(await svc.studentHeatmap(req.ctx)));
r.get('/attendance/monthly', async (req, res) => res.json(await svc.studentMonthly(req.ctx, { registerOnly: req.query.source === 'register' })));
r.get('/attendance/history', async (req, res) => res.json(await svc.studentHistory(req.ctx, parse(v.rangeQuery, req.query), { registerOnly: req.query.source === 'register' })));
// Students may report a suspected error; they can never edit attendance.
r.get('/attendance/queries', async (req, res) => res.json(await svc.listOwnQueries(req.ctx)));
r.post('/attendance/queries', async (req, res) => res.status(201).json(await svc.raiseQuery(req.ctx, parse(v.queryBody, req.body))));

export default r;
