import { Router } from 'express';
import { z } from 'zod';
import { parse, isDateStr } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as svc from './privacy.service.js';

/** School Admin only (the path is not in any sub-admin permission). Consent record, one student's data as a download, and erasure of a student who has left. */
export const adminRoutes = Router();
const a = adminRoutes;
const ctxOf = (req) => ({ tenantId: req.tenantId, actorId: req.user._id, actorName: req.user.name });
const text = (n) => z.string().trim().max(n).optional();
const consentBody = z.object({ givenOn: z.string().refine(isDateStr, 'Use YYYY-MM-DD'), guardianName: z.string().trim().min(2).max(80), relationship: text(40), note: text(300) });
const eraseBody = z.object({ confirmAdmissionNo: z.string().min(1).max(60), reason: z.string().trim().min(3).max(300) });

a.get('/privacy/consent-summary', async (req, res) => res.json(await svc.consentSummary(req.tenantId)));
a.get('/privacy/students/:id', async (req, res) => res.json(await svc.privacyStatus(req.tenantId, req.params.id)));
a.put('/privacy/students/:id/consent', async (req, res) => {
  const out = await svc.setConsent(ctxOf(req), req.params.id, parse(consentBody, req.body));
  await audit(req, 'privacy.consent_recorded', 'Student', req.params.id, 'Recorded guardian consent');
  res.json(out);
});
a.delete('/privacy/students/:id/consent', async (req, res) => { await svc.clearConsent(ctxOf(req), req.params.id); await audit(req, 'privacy.consent_removed', 'Student', req.params.id, 'Removed the consent record'); res.json({ ok: true }); });
a.get('/privacy/students/:id/export', async (req, res) => {
  const out = await svc.exportStudent(ctxOf(req), req.params.id);
  await audit(req, 'privacy.exported', 'Student', req.params.id, `Downloaded all data held about ${out.student.name}`);
  res.setHeader('Content-Disposition', `attachment; filename="student-${out.student.admissionNo}-data.json"`);
  res.json(out);
});
a.post('/privacy/students/:id/erase', async (req, res) => {
  const b = parse(eraseBody, req.body);
  const out = await svc.anonymiseStudent(ctxOf(req), req.params.id, b);
  await audit(req, 'privacy.erased', 'Student', req.params.id, `Erased a former student's personal details: ${b.reason}`);
  res.json(out);
});
