import { Router } from 'express';
import { z } from 'zod';
import { parse, isDateStr } from '../../core/utils.js';
import * as svc from './insight.service.js';

/** School Admin: read-only analysis of classes, exams and individual students. */
const r = Router();
const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const analysisQuery = z.object({ classId: id.optional(), sectionId: id.optional() }).refine((q) => q.classId || q.sectionId, { message: 'Choose a class' });

r.get('/sections/:id/insight', async (req, res) => res.json(await svc.sectionInsight(req.ctx, req.params.id)));
r.get('/sections/:id/students', async (req, res) => res.json(await svc.sectionStudents(req.ctx, req.params.id)));
r.get('/sections/:id/homework', async (req, res) => {
  const { date } = parse(z.object({ date: z.string().refine(isDateStr).optional() }), req.query);
  res.json(await svc.sectionHomework(req.ctx, req.params.id, date || req.ctx.today));
});
r.get('/analysis/overview', async (req, res) => res.json(await svc.examOverview(req.ctx)));
r.get('/analysis/students/:id', async (req, res) => res.json(await svc.studentMarks(req.ctx, req.params.id)));
r.get('/analysis/exams', async (req, res) => res.json(await svc.classAnalysis(req.ctx, parse(analysisQuery, req.query))));
r.get('/teachers/:id/overview', async (req, res) => res.json(await svc.teacherOverview(req.ctx, req.params.id)));
r.get('/students/:id/overview', async (req, res) => res.json(await svc.studentOverview(req.ctx, req.params.id)));
export default r;
