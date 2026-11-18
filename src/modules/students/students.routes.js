import { Router } from 'express';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as v from './students.validation.js';
import * as svc from './students.service.js';
import { clearanceFor } from '../../services/clearance.js';

const r = Router();
const ctx = (req) => ({ tenantId: req.tenantId, actorId: req.user._id });

r.get('/students', async (req, res) => res.json(await svc.listStudents(req.tenantId, parse(v.listQuery, req.query))));

r.get('/students/fee-preview', async (req, res) => res.json(await svc.feePreview(req.tenantId, parse(v.feePreviewQuery, req.query))));

r.post('/students/bulk', async (req, res) => {
  const b = parse(v.bulkBody, req.body);
  const out = await svc.bulkUpdate(ctx(req), b);
  await audit(req, 'student.bulk_changed', 'Student', null, `Bulk ${b.action} for ${out.done} of ${out.requested} student(s)`, { action: b.action, failed: out.failed.length });
  res.json(out);
});
r.post('/students', async (req, res) => {
  const out = await svc.admitStudent(ctx(req), parse(v.admitBody, req.body));
  await audit(req, 'student.admitted', 'Student', out.student._id, `Admitted ${out.student.name} (${out.student.admissionNo})`);
  if (out.discount) await audit(req, 'student.admission_discount', 'Student', out.student._id, `Gave ${out.student.name} a personal discount of ${out.discount.type === 'percent' ? `${out.discount.value}%` : `₹${out.discount.value}`} on tuition (₹${out.discount.applied} off): ${out.discount.reason}`);
  res.status(201).json(out);
});

r.get('/students/:id', async (req, res) => res.json(await svc.getStudent(req.tenantId, req.params.id)));

r.patch('/students/:id', async (req, res) => {
  const s = await svc.updateStudent(req.tenantId, req.params.id, parse(v.updateStudentBody, req.body));
  await audit(req, 'student.updated', 'Student', s._id, `Updated ${s.name}`);
  res.json(s);
});

r.post('/students/:id/transfer', async (req, res) => {
  const out = await svc.transferStudent(ctx(req), req.params.id, parse(v.transferBody, req.body));
  await audit(req, 'student.transferred', 'Student', req.params.id, 'Moved student to a new section', { toSectionId: out.enrolment.sectionId, reason: out.transfer.reason });
  res.json(out);
});

r.get('/students/:id/clearance', async (req, res) => {
  await svc.getStudent(req.tenantId, req.params.id);
  res.json(await clearanceFor(req.tenantId, 'student', req.params.id));
});
r.post('/students/:id/withdraw', async (req, res) => {
  const body = parse(v.withdrawBody, req.body);
  const { student } = await svc.withdrawStudent(req.tenantId, req.params.id, body);
  await audit(req, `student.${body.outcome}`, 'Student', student._id, `${student.name}: ${body.reason}`);
  res.json(student);
});

r.post('/students/:id/reactivate', async (req, res) => {
  const s = await svc.reactivateStudent(req.tenantId, req.params.id);
  await audit(req, 'student.reactivated', 'Student', s._id, `Reactivated ${s.name}`);
  res.json(s);
});

r.delete('/students/:id', async (req, res) => {
  const s = await svc.archiveStudent(req.tenantId, req.params.id);
  await audit(req, 'student.archived', 'Student', s._id, `Archived ${s.name}`);
  res.json(s);
});

r.post('/students/:id/reset-password', async (req, res) => {
  const out = await svc.resetStudentPassword(req.tenantId, req.params.id);
  await audit(req, 'user.password_reset', 'Student', req.params.id, 'Reset student password');
  res.json(out);
});

export default r;
