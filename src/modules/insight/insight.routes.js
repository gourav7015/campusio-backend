import { Router } from 'express';
import { z } from 'zod';
import { parse, isDateStr } from '../../core/utils.js';
import * as svc from './insight.service.js';

/** School Admin: read-only analysis of classes, exams and individual students. */
const r = Router();
const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const analysisQuery = z.object({ classId: id.optional(), sectionId: id.optional() }).refine((q) => q.classId || q.sectionId, { message: 'Choose a class' });

r.get('/sections/:id/insight', async (req, res) => res.json(await svc.sectionInsight(req.ctx, req.params.id)));
const rangeQ = z.object({ range: z.enum(['month', 'quarter', 'year']).default('year') });
r.get('/sections/:id/period-attendance', async (req, res) => res.json(await svc.sectionPeriodAttendance(req.ctx, req.params.id, parse(rangeQ, req.query).range)));
r.get('/sections/:id/day-attendance', async (req, res) => res.json(await svc.sectionDayAttendance(req.ctx, req.params.id, parse(rangeQ, req.query).range)));
r.get('/sections/:id/students', async (req, res) => res.json(await svc.sectionStudents(req.ctx, req.params.id)));
r.get('/sections/:id/homework', async (req, res) => {
  const { date, weekStart } = parse(z.object({ date: z.string().refine(isDateStr).optional(), weekStart: z.string().refine(isDateStr).optional() }), req.query);
  res.json(await svc.sectionHomework(req.ctx, req.params.id, date || req.ctx.today, weekStart));
});
r.get('/analysis/overview', async (req, res) => res.json(await svc.examOverview(req.ctx)));
r.get('/analysis/students/:id', async (req, res) => res.json(await svc.studentMarks(req.ctx, req.params.id)));
r.get('/analysis/exams', async (req, res) => res.json(await svc.classAnalysis(req.ctx, parse(analysisQuery, req.query))));
r.get('/teachers/:id/overview', async (req, res) => res.json(await svc.teacherOverview(req.ctx, req.params.id)));
r.get('/students/:id/overview', async (req, res) => res.json(await svc.studentOverview(req.ctx, req.params.id)));
r.get('/students/:id/attendance-subject/:subjectId', async (req, res) => res.json(await svc.studentSubjectPeriods(req.ctx, req.params.id, parse(z.object({ subjectId: z.union([id, z.literal('other')]) }), req.params).subjectId)));
export default r;
