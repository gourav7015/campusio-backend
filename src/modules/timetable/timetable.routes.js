import { Router } from 'express';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import { notifyUsers, studentUserIdsInSections } from '../../services/notify.js';
import { Teacher } from '../../models/index.js';
import * as v from './timetable.validation.js';
import * as svc from './timetable.service.js';
import { loadTimetables, timetableCsv, timetablePdf, fileName } from './timetable.export.js';

const r = Router();

async function tellSection(req, sectionId, title, body, key) {
  const ids = await studentUserIdsInSections(req.tenantId, [sectionId]);
  await notifyUsers(req.tenantId, ids, { category: 'timetable', title, body, link: { type: 'timetable' }, dedupeKey: key });
}

r.get('/timetable/periods', async (req, res) => res.json(await svc.listPeriods(req.tenantId)));
r.post('/timetable/periods', async (req, res) => {
  const p = await svc.createPeriod(req.tenantId, parse(v.periodBody, req.body));
  await audit(req, 'timetable.period_created', 'TimetablePeriod', p._id, `Created ${p.name}`);
  res.status(201).json(p);
});
r.patch('/timetable/periods/:id', async (req, res) => res.json(await svc.updatePeriod(req.tenantId, req.params.id, parse(v.periodPatch, req.body))));
r.delete('/timetable/periods/:id', async (req, res) => { await svc.deletePeriod(req.tenantId, req.params.id); res.json({ ok: true }); });

/** Download the timetable: every section, one class, or one section; as a PDF (a page per section) or a CSV. */
r.get('/timetable/export', async (req, res) => {
  const q = parse(v.exportQuery, req.query);
  const t = await loadTimetables(req.ctx, q);
  const name = fileName(t, q);
  if (q.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    return res.send(timetableCsv(t));
  }
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
  await timetablePdf(req.ctx, t, res);
});
r.get('/timetable/entries', async (req, res) => res.json(await svc.listEntries(req.tenantId, parse(v.entriesQuery, req.query))));
r.get('/timetable/unresolved', async (req, res) => res.json(await svc.unresolvedEntries(req.tenantId)));
r.get('/timetable/section/:id', async (req, res) => res.json(await svc.sectionTimetable(req.tenantId, req.params.id, parse(v.dateQuery, req.query).date)));

r.post('/timetable/entries', async (req, res) => {
  const out = await svc.upsertEntry(req.tenantId, parse(v.entryBody, req.body));
  await audit(req, 'timetable.entry_saved', 'TimetableEntry', out.entry._id, 'Saved timetable entry');
  await tellSection(req, out.section._id, 'Timetable updated', 'Your class timetable has been changed.', `tt:${out.section._id}:${Date.now() / 60000 | 0}`);
  res.status(201).json({ entry: out.entry, warnings: out.warnings });
});
r.patch('/timetable/entries/:id', async (req, res) => {
  const out = await svc.updateEntry(req.tenantId, req.params.id, parse(v.entryPatch, req.body));
  await audit(req, 'timetable.entry_updated', 'TimetableEntry', out.entry._id, 'Updated timetable entry');
  await tellSection(req, out.section._id, 'Timetable updated', 'Your class timetable has been changed.', `tt:${out.section._id}:${Date.now() / 60000 | 0}`);
  res.json({ entry: out.entry, warnings: out.warnings });
});
r.delete('/timetable/entries/:id', async (req, res) => {
  const e = await svc.deleteEntry(req.tenantId, req.params.id);
  await audit(req, 'timetable.entry_deleted', 'TimetableEntry', e._id, 'Removed timetable entry');
  await tellSection(req, e.sectionId, 'Timetable updated', 'A period was removed from your timetable.', `tt:${e.sectionId}:${Date.now() / 60000 | 0}`);
  res.json({ ok: true });
});

r.get('/substitutions', async (req, res) => res.json(await svc.listSubstitutions(req.tenantId, req.query)));
r.post('/substitutions', async (req, res) => {
  const { substitution, entry } = await svc.createSubstitution(req.tenantId, parse(v.substitutionBody, req.body), req.user._id);
  await audit(req, 'timetable.substitution', 'Substitution', substitution._id, `Substitute arranged for ${substitution.date}`);
  await tellSection(req, entry.sectionId, 'Substitute teacher', `A substitute teacher will take a period on ${substitution.date}.`, `sub:${substitution._id}`);
  const sub = await Teacher.findById(substitution.substituteTeacherId).select('userId');
  await notifyUsers(req.tenantId, [sub?.userId], { category: 'timetable', title: 'Substitution assigned', body: `You are covering a period on ${substitution.date}.`, link: { type: 'timetable' }, dedupeKey: `sub-t:${substitution._id}` });
  res.status(201).json(substitution);
});
r.delete('/substitutions/:id', async (req, res) => {
  const s = await svc.deleteSubstitution(req.tenantId, req.params.id);
  await audit(req, 'timetable.substitution_removed', 'Substitution', s._id, 'Removed substitution');
  res.json({ ok: true });
});

export default r;
