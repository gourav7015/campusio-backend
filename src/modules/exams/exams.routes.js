import { Router } from 'express';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as v from './exams.validation.js';
import * as svc from './exams.service.js';
import * as dsh from './datesheet.service.js';
import * as marks from './marks.service.js';
import * as results from './results.service.js';
import { ReportCard } from '../../models/index.js';
import { notFound } from '../../core/utils.js';

// ───────────── School Admin ─────────────
export const adminRoutes = Router();
adminRoutes.get('/exams', async (req, res) => res.json(await svc.listExams(req.ctx)));
adminRoutes.post('/exams', async (req, res) => {
  const e = await svc.createExam(req.ctx, parse(v.examBody, req.body));
  await audit(req, 'exam.created', 'Examination', e._id, `Created examination ${e.name}`);
  res.status(201).json(e);
});
adminRoutes.post('/exams/standard', async (req, res) => {
  const out = await dsh.addStandardExams(req.ctx);
  await audit(req, 'exam.standard_added', 'Examination', null, `Added the standard examinations (${out.created} new)`);
  res.status(201).json(out);
});
adminRoutes.get('/exams/:id/datesheet', async (req, res) => res.json(await dsh.getDatesheet(req.ctx, req.params.id, parse(v.datesheetQuery, req.query).classId)));
adminRoutes.put('/exams/:id/datesheet', async (req, res) => {
  const b = parse(v.datesheetBody, req.body);
  const out = await dsh.saveDatesheet(req.ctx, req.params.id, b);
  await audit(req, 'exam.datesheet_saved', 'Examination', req.params.id, `Saved the date sheet (${out.saved} papers)`);
  res.json(out);
});
adminRoutes.post('/exams/:id/datesheet/standard-subjects', async (req, res) => res.json(await dsh.addStandardSubjects(req.ctx, req.params.id, parse(v.datesheetQuery, req.body).classId)));
adminRoutes.post('/exams/:id/datesheet/subjects', async (req, res) => { const b = parse(v.addSubjectBody, req.body); res.status(201).json(await dsh.addSubjectToClass(req.ctx, req.params.id, b.classId, b.name)); });
adminRoutes.get('/exams/:id', async (req, res) => res.json(await svc.getExam(req.ctx, req.params.id)));
adminRoutes.patch('/exams/:id', async (req, res) => res.json(await svc.updateExam(req.ctx, req.params.id, parse(v.examPatch, req.body))));
adminRoutes.delete('/exams/:id', async (req, res) => { await svc.deleteExam(req.ctx, req.params.id); res.json({ ok: true }); });
adminRoutes.put('/exams/:id/subjects', async (req, res) => res.json(await svc.upsertExamSubject(req.ctx, req.params.id, parse(v.examSubjectBody, req.body))));
adminRoutes.post('/exams/:id/subjects/generate', async (req, res) => res.json(await svc.generateSubjects(req.ctx, req.params.id)));
adminRoutes.delete('/exams/:id/subjects/:esId', async (req, res) => { await svc.deleteExamSubject(req.ctx, req.params.id, req.params.esId); res.json({ ok: true }); });
adminRoutes.post('/exams/:id/publish-schedule', async (req, res) => {
  const e = await svc.publishSchedule(req.ctx, req.params.id);
  await audit(req, 'exam.schedule_published', 'Examination', e._id, `Published schedule for ${e.name}`);
  res.json(e);
});

adminRoutes.get('/exams/:id/sheets', async (req, res) => res.json(await svc.listSheets(req.ctx, req.params.id)));
adminRoutes.get('/sheets/:id', async (req, res) => res.json(await svc.getSheetForReview(req.ctx, req.params.id)));
adminRoutes.post('/sheets/:id/start-review', async (req, res) => res.json(await svc.startReview(req.ctx, req.params.id)));
adminRoutes.post('/sheets/:id/approve', async (req, res) => {
  const s = await svc.approveSheet(req.ctx, req.params.id);
  await audit(req, 'marks.approved', 'MarksSheet', s._id, 'Approved marks sheet');
  res.json(s);
});
adminRoutes.post('/sheets/:id/return', async (req, res) => {
  const { reason } = parse(v.returnBody, req.body);
  const s = await svc.returnSheet(req.ctx, req.params.id, reason);
  await audit(req, 'marks.returned', 'MarksSheet', s._id, 'Returned marks for correction', { reason });
  res.json(s);
});
adminRoutes.post('/exams/:id/publish', async (req, res) => {
  const out = await svc.publishExam(req.ctx, req.params.id, parse(v.publishBody, req.body));
  await audit(req, 'results.published', 'Examination', req.params.id, `Published results (${out.published.length} section(s))`, out);
  res.json(out);
});
adminRoutes.post('/marks/:id/correct', async (req, res) => {
  const body = parse(v.correctBody, req.body);
  const m = await svc.correctPublishedMark(req.ctx, req.params.id, body, req.user.name);
  await audit(req, 'marks.corrected', 'Marks', m._id, 'Corrected published marks', { reason: body.reason });
  res.json(m);
});
adminRoutes.put('/exams/:id/remarks', async (req, res) => res.json(await svc.saveRemark(req.ctx, req.params.id, parse(v.remarkBody, req.body))));
adminRoutes.get('/exams/:id/results', async (req, res) => res.json(await svc.examResults(req.ctx, req.params.id, parse(v.resultsQuery, req.query))));
adminRoutes.get('/report-cards/:id', async (req, res) => res.json(await svc.reportCardOf(req.ctx, req.params.id)));
adminRoutes.get('/report-cards/:id/pdf', async (req, res) => {
  const c = await ReportCard.findOne({ _id: req.params.id, tenantId: req.tenantId });
  if (!c) throw notFound('Report card not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="report-card-${c.snapshot.student.admissionNo}-v${c.version}.pdf"`);
  await results.renderReportCardPdf(c, res);
});
// admin may also take marks entry for any section (permission table: "Enter assigned marks – School Admin: Yes")
adminRoutes.get('/marks/sheet', async (req, res) => res.json(await marks.getSheet(req.ctx, parse(v.sheetQuery, req.query))));
adminRoutes.put('/marks/sheet', async (req, res) => res.json(await marks.saveSheet(req.ctx, parse(v.sheetBody, req.body))));
adminRoutes.post('/marks/sheet/submit', async (req, res) => res.json(await marks.submitSheet(req.ctx, parse(v.sheetQuery, req.body))));

// ───────────── Teacher ─────────────
export const teacherRoutes = Router();
teacherRoutes.get('/exams', async (req, res) => res.json(await marks.teacherExamList(req.ctx, { classView: req.query.classView === '1' })));
teacherRoutes.post('/exams', async (req, res) => {
  const out = await marks.createTeacherExam(req.ctx, parse(v.teacherExamBody, req.body), req.user.name);
  await audit(req, 'exam.teacher_created', 'Examination', out.exam._id, `Added ${out.exam.name} (${out.exam.type})`);
  res.status(201).json(out);
});
teacherRoutes.patch('/exams/:id', async (req, res) => res.json(await marks.updateTeacherExam(req.ctx, req.params.id, parse(v.teacherExamPatch, req.body))));
teacherRoutes.delete('/exams/:id', async (req, res) => {
  await marks.deleteTeacherExam(req.ctx, req.params.id);
  await audit(req, 'exam.teacher_deleted', 'Examination', req.params.id, 'Deleted a test');
  res.json({ ok: true });
});
teacherRoutes.get('/marks/sheet', async (req, res) => res.json(await marks.getSheet(req.ctx, parse(v.sheetQuery, req.query))));
teacherRoutes.put('/marks/sheet', async (req, res) => res.json(await marks.saveSheet(req.ctx, parse(v.sheetBody, req.body))));
teacherRoutes.post('/marks/sheet/submit', async (req, res) => {
  const body = parse(v.sheetQuery, req.body);
  const s = await marks.submitSheet(req.ctx, body);
  await audit(req, 'marks.submitted', 'MarksSheet', s._id, 'Submitted marks for approval');
  res.json(s);
});
teacherRoutes.post('/marks/import', async (req, res) => res.json(await marks.importMarks(req.ctx, parse(v.importBody, req.body))));
teacherRoutes.get('/marks/corrections', async (req, res) => res.json(await marks.correctionRequests(req.ctx)));

// ───────────── Student ─────────────
export const studentRoutes = Router();
studentRoutes.get('/exams/schedule', async (req, res) => res.json(await results.schedule(req.ctx)));
studentRoutes.get('/results', async (req, res) => res.json(await results.resultsList(req.ctx)));
studentRoutes.get('/results/:examId', async (req, res) => res.json(await results.resultDetail(req.ctx, req.params.examId)));
studentRoutes.get('/results/:examId/pdf', async (req, res) => {
  const card = await ReportCard.findOne({ tenantId: req.tenantId, studentId: req.ctx.student._id, examId: req.params.examId, isCurrent: true });
  if (!card) throw notFound('Result not published');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="report-card-${card.snapshot.exam.name.replace(/\W+/g, '-')}.pdf"`);
  await results.renderReportCardPdf(card, res);
});
studentRoutes.get('/class-results', async (req, res) => res.json(await results.classExams(req.ctx)));
studentRoutes.get('/class-results/:examId', async (req, res) => res.json(await results.classExamDetail(req.ctx, req.params.examId)));
studentRoutes.get('/class-ranking', async (req, res) => res.json(await results.classRanking(req.ctx, req.query.scope === 'class' ? 'class' : 'section')));
studentRoutes.get('/class-analysis', async (req, res) => res.json(await results.classAnalysis(req.ctx)));
studentRoutes.get('/performance', async (req, res) => res.json(await results.performance(req.ctx, { examId: req.query.examId })));
