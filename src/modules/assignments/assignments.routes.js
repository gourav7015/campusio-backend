import { Router } from 'express';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as v from '../teachers/teachers.validation.js';
import * as svc from './assignments.service.js';

const r = Router();

r.get('/teaching-assignments', async (req, res) => res.json(await svc.listAssignments(req.tenantId, req.query)));
r.post('/teaching-assignments', async (req, res) => {
  const a = await svc.createAssignment(req.tenantId, parse(v.assignmentBody, req.body));
  await audit(req, 'assignment.created', 'TeachingAssignment', a._id, 'Assigned teacher to subject and section');
  res.status(201).json(a);
});
r.post('/teaching-assignments/:id/end', async (req, res) => {
  const out = await svc.endAssignment(req.tenantId, req.params.id, parse(v.endAssignmentBody, req.body).effectiveTo);
  await audit(req, 'assignment.ended', 'TeachingAssignment', req.params.id, 'Ended teaching assignment', { unresolvedPeriods: out.unresolvedPeriods });
  res.json(out);
});

r.get('/class-teachers', async (req, res) => res.json(await svc.listClassTeachers(req.tenantId, req.query)));
r.put('/sections/:id/class-teacher', async (req, res) => {
  const a = await svc.setClassTeacher(req.tenantId, req.params.id, parse(v.classTeacherBody, req.body));
  await audit(req, 'class_teacher.set', 'Section', req.params.id, 'Assigned class teacher');
  res.json(a);
});
r.delete('/sections/:id/class-teacher', async (req, res) => {
  await svc.clearClassTeacher(req.tenantId, req.params.id);
  await audit(req, 'class_teacher.cleared', 'Section', req.params.id, 'Removed class teacher');
  res.json({ ok: true });
});

export default r;
