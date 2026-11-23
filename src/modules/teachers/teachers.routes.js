import { Router } from 'express';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as v from './teachers.validation.js';
import * as svc from './teachers.service.js';

const r = Router();
const ctx = (req) => ({ tenantId: req.tenantId, actorId: req.user._id });

r.get('/teachers', async (req, res) => res.json(await svc.listTeachers(req.tenantId, parse(v.listQuery, req.query))));
r.post('/teachers', async (req, res) => {
  const out = await svc.createTeacher(ctx(req), parse(v.teacherBody, req.body));
  await audit(req, 'teacher.created', 'Teacher', out.teacher._id, `Created teacher ${out.teacher.name}`);
  res.status(201).json(out);
});
r.get('/teachers/:id', async (req, res) => res.json(await svc.getTeacher(req.tenantId, req.params.id)));
r.patch('/teachers/:id', async (req, res) => {
  const t = await svc.updateTeacher(req.tenantId, req.params.id, parse(v.teacherPatch, req.body));
  await audit(req, 'teacher.updated', 'Teacher', t._id, `Updated teacher ${t.name}`);
  res.json(t);
});
r.post('/teachers/:id/deactivate', async (req, res) => {
  const out = await svc.deactivateTeacher(req.tenantId, req.params.id, { overrideClearance: req.body?.overrideClearance === true });
  await audit(req, 'teacher.deactivated', 'Teacher', req.params.id, `Deactivated ${out.teacher.name}`, { unresolvedPeriods: out.endedAssignments });
  res.json({ teacher: out.teacher, unresolvedPeriods: out.endedAssignments });
});
r.post('/teachers/:id/reactivate', async (req, res) => {
  const t = await svc.reactivateTeacher(req.tenantId, req.params.id);
  await audit(req, 'teacher.reactivated', 'Teacher', t._id, `Reactivated ${t.name}`);
  res.json(t);
});
r.post('/teachers/:id/reset-password', async (req, res) => {
  const out = await svc.resetTeacherPassword(req.tenantId, req.params.id, req.body);
  await audit(req, 'user.password_reset', 'Teacher', req.params.id, 'Reset teacher password');
  res.json(out);
});

export default r;
