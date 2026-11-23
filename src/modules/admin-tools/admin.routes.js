import { Router } from 'express';
import { z } from 'zod';
import { parse, isDateStr } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import { upload, saveFile } from '../../services/files.js';
import * as svc from './admin.service.js';
import * as promo from './promotion.service.js';
import * as imp from './imports.service.js';
import * as xp from './exports.service.js';
import { classProgress } from '../promotion/progress.service.js';
import { undoMove } from '../promotion/undo.service.js';
import { overview } from '../attendance/attendance.service.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i);
const r = Router();

r.get('/dashboard', async (req, res) => res.json(await svc.dashboard(req.ctx)));
r.get('/audit/facets', async (req, res) => res.json(await svc.auditSummary(req.ctx, req.query)));
r.get('/audit', async (req, res) => res.json(await svc.listAudit(req.ctx, req.query)));
r.get('/search', async (req, res) => res.json(await svc.search(req.ctx, String(req.query.q || '').trim())));
r.get('/reports/summary', async (req, res) => res.json(await svc.reportsSummary(req.ctx)));

// exports: same permissions as the screens they mirror
const csv = (res, name, body) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.send(body); };
// the Export centre: any list, narrowed by filters, with the columns the school ticks
r.get('/export/catalog', async (req, res) => res.json(await xp.catalog(req.ctx, req.user)));
r.get('/export/preview', async (req, res) => res.json(await xp.build(req.ctx, req.user, req.query, { preview: true })));
r.get('/export/download', async (req, res) => {
  const out = await xp.build(req.ctx, req.user, req.query);
  await audit(req, 'export.download', 'Export', null, `Exported ${String(req.query.dataset).replace(/_/g, ' ')} (${out.total} rows)`);
  csv(res, out.name, out.csv);
});
r.get('/export/students.csv', async (req, res) => { await audit(req, 'export.students', 'Student', null, 'Exported students'); csv(res, 'students.csv', await svc.exportStudents(req.ctx)); });
r.get('/export/teachers.csv', async (req, res) => { await audit(req, 'export.teachers', 'Teacher', null, 'Exported teachers'); csv(res, 'teachers.csv', await svc.exportTeachers(req.ctx)); });
r.get('/export/attendance.csv', async (req, res) => {
  const q = parse(z.object({ sectionId: id, from: z.string().refine(isDateStr).optional(), to: z.string().refine(isDateStr).optional() }), req.query);
  csv(res, 'attendance.csv', await svc.exportAttendance(req.ctx, q));
});
r.get('/export/results.csv', async (req, res) => csv(res, 'results.csv', await svc.exportResults(req.ctx, parse(z.object({ examId: id }), req.query).examId)));

// promotion
const promoBody = z.object({ fromYearId: id, toYearId: id, sectionIds: z.array(id).max(200).optional(), classIds: z.array(id).max(100).optional() });
r.get('/promotions/progress', async (req, res) => res.json(await classProgress(req.tenantId, parse(z.object({ yearId: id }), req.query).yearId, req.ctx.today)));
r.post('/promotions/undo', async (req, res) => {
  const { enrolmentId } = parse(z.object({ enrolmentId: id }), req.body);
  const out = await undoMove(req.ctx, enrolmentId);
  await audit(req, 'promotion.undone', 'Student', out.studentId, `Put ${out.name || 'a student'} back in the class they were moved from`);
  res.json(out);
});
r.post('/promotions/preview', async (req, res) => res.json(await promo.preview(req.tenantId, parse(promoBody, req.body), req.ctx.today)));
r.post('/promotions/commit', async (req, res) => {
  const body = parse(promoBody.extend({
    confirm: z.boolean(), closeFromYear: z.boolean().optional(), makeCurrent: z.boolean().optional(), acknowledgeGaps: z.boolean().optional(),
    items: z.array(z.object({ enrolmentId: id, action: z.enum(['promote', 'retain', 'complete', 'transfer_out', 'withdraw']), toSectionId: id.optional() })).min(1).max(3000),
  }), req.body);
  const out = await promo.commit(req.ctx, body);
  await audit(req, 'promotion.committed', 'AcademicYear', body.toYearId, `Promotion ${out.fromYear} → ${out.toYear}: ${out.promoted} promoted, ${out.retained} repeating, ${out.completed} completed${body.classIds?.length ? ` (${body.classIds.length} chosen classes)` : ' (all classes)'}`, out);
  res.json(out);
});

// bulk import / data dump
r.get('/imports', async (req, res) => res.json(await imp.listBatches(req.tenantId)));
r.post('/imports/students', async (req, res) => {
  const out = await imp.importStudents(req.ctx, parse(imp.rowsBody, req.body));
  if (out.committed) await audit(req, 'import.students', 'ImportBatch', out.batchId, `Imported ${out.created} students`, { total: out.total, skipped: out.skipped });
  res.json(out);
});
r.post('/imports/teachers', async (req, res) => {
  const out = await imp.importTeachers(req.ctx, parse(imp.rowsBody, req.body));
  if (out.committed) await audit(req, 'import.teachers', 'ImportBatch', out.batchId, `Imported ${out.created} teachers`, { total: out.total, skipped: out.skipped });
  res.json(out);
});
r.post('/imports/:id/rollback', async (req, res) => {
  const out = await imp.rollback(req.tenantId, req.params.id);
  await audit(req, 'import.rolled_back', 'ImportBatch', req.params.id, `Rolled back import (${out.removed} removed)`, out);
  res.json(out);
});

// documents + photos for students / teachers
for (const [path, t] of [['students', 'student'], ['teachers', 'teacher']]) {
  r.get(`/${path}/:id/documents`, async (req, res) => {
    await svc.ownerExists(req.ctx, t, req.params.id);
    res.json(await svc.listDocuments(req.ctx, t, req.params.id));
  });
  r.post(`/${path}/:id/documents`, upload.single('file'), async (req, res) => {
    await svc.ownerExists(req.ctx, t, req.params.id);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded', code: 'BAD_REQUEST' });
    const docType = parse(z.object({ docType: z.string().min(2).max(40).default('other') }), req.body).docType;
    const f = await saveFile(req, req.file, { kind: 'document', ownerType: t, ownerId: req.params.id, docType });
    await audit(req, 'document.uploaded', t, req.params.id, `Uploaded ${docType}`);
    res.status(201).json({ id: f._id, name: f.originalName, type: docType });
  });
  r.post(`/${path}/:id/photo`, upload.single('file'), async (req, res) => {
    const owner = await svc.ownerExists(req.ctx, t, req.params.id);
    if (!req.file || !/^image\//.test(req.file.mimetype)) return res.status(400).json({ error: 'Upload an image', code: 'BAD_REQUEST' });
    const f = await saveFile(req, req.file, { kind: 'photo', ownerType: t, ownerId: req.params.id });
    const old = owner.photoFileId;
    owner.photoFileId = f._id; await owner.save();
    if (old) await svc.deleteDocument(req.ctx, old).catch(() => {});
    res.json({ id: f._id });
  });
}
r.delete('/documents/:id', async (req, res) => { await svc.deleteDocument(req.ctx, req.params.id); await audit(req, 'document.deleted', 'File', req.params.id, 'Deleted document'); res.json({ ok: true }); });
r.get('/attendance-overview', async (req, res) => res.json(await overview(req.ctx, req.ctx.today)));
export default r;
