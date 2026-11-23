import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/utils.js';
import { classStructure as classStructureOf, addSubjectToClass, removeSubjectFromClass, subjectUsage, createSubject, renameSubject, deleteSubject, addSubjectToClasses } from './class-structure.service.js';
import { audit } from '../../services/audit.js';
import * as v from './structure.validation.js';
import * as svc from './structure.service.js';

const r = Router();
const T = (req) => req.tenantId;
const objectId = z.string().regex(/^[a-f0-9]{24}$/i);

// academic years
r.get('/years', async (req, res) => res.json(await svc.listYears(T(req))));
r.post('/years', async (req, res) => {
  const y = await svc.createYear(T(req), parse(v.yearBody, req.body));
  await audit(req, 'year.created', 'AcademicYear', y._id, `Created academic year ${y.name}`);
  res.status(201).json(y);
});
r.post('/years/rollover', async (req, res) => {
  const out = await svc.rolloverYear(T(req), req.user._id, parse(v.rolloverBody, req.body));
  await audit(req, 'year.rolled_over', 'AcademicYear', out.year._id, `Created ${out.year.name} from the previous year: ${out.sections} sections, ${out.offerings} subjects, ${out.subjectTeachers} subject teachers, ${out.classTeachers} class teachers`);
  res.status(201).json(out);
});
r.patch('/years/:id', async (req, res) => {
  const y = await svc.updateYear(T(req), req.params.id, parse(v.yearPatch, req.body));
  await audit(req, 'year.updated', 'AcademicYear', y._id, `Updated academic year ${y.name}`);
  res.json(y);
});
r.post('/years/:id/set-current', async (req, res) => {
  const y = await svc.setCurrentYear(T(req), req.params.id);
  await audit(req, 'year.set_current', 'AcademicYear', y._id, `${y.name} is now the current year`);
  res.json(y);
});
r.post('/years/:id/close', async (req, res) => {
  const y = await svc.closeYear(T(req), req.params.id);
  await audit(req, 'year.closed', 'AcademicYear', y._id, `Closed academic year ${y.name}`);
  res.json(y);
});

// classes
r.get('/classes', async (req, res) => res.json(await svc.listClasses(T(req))));
r.post('/classes', async (req, res) => {
  const c = await svc.createClass(T(req), parse(v.classBody, req.body));
  await audit(req, 'class.created', 'Class', c._id, `Created ${c.name}`);
  res.status(201).json(c);
});
r.patch('/classes/:id', async (req, res) => res.json(await svc.updateClass(T(req), req.params.id, parse(v.classPatch, req.body))));
r.delete('/classes/:id', async (req, res) => {
  await svc.deleteClass(T(req), req.params.id);
  await audit(req, 'class.deleted', 'Class', req.params.id, 'Deleted class');
  res.json({ ok: true });
});

// sections
r.get('/sections', async (req, res) => res.json(await svc.listSections(T(req), req.query)));
r.post('/sections', async (req, res) => {
  const s = await svc.createSection(T(req), parse(v.sectionBody, req.body));
  await audit(req, 'section.created', 'Section', s._id, `Created section ${s.name}`);
  res.status(201).json(s);
});
r.patch('/sections/:id', async (req, res) => {
  const s = await svc.updateSection(T(req), req.params.id, parse(v.sectionPatch, req.body));
  await audit(req, 'section.updated', 'Section', s._id, `Updated section ${s.name}`);
  res.json(s);
});
r.delete('/sections/:id', async (req, res) => {
  await svc.deleteSection(T(req), req.params.id);
  await audit(req, 'section.deleted', 'Section', req.params.id, 'Deleted section');
  res.json({ ok: true });
});

// subjects
r.get('/subjects', async (req, res) => res.json(await svc.listSubjects(T(req))));
// the school's subjects: added here (or on the spot through a teacher), then given to the classes that study them
r.get('/subjects/usage', async (req, res) => res.json(await subjectUsage(T(req), parse(z.object({ yearId: objectId }), req.query).yearId)));
r.post('/subjects', async (req, res) => {
  const s = await createSubject(T(req), parse(z.object({ name: z.string().trim().min(2).max(80) }), req.body));
  await audit(req, 'subject.created', 'Subject', s._id, `Added the subject ${s.name}`);
  res.status(201).json(s);
});
r.patch('/subjects/:id', async (req, res) => {
  const s = await renameSubject(T(req), req.params.id, parse(z.object({ name: z.string().trim().min(2).max(80) }), req.body));
  await audit(req, 'subject.renamed', 'Subject', s._id, `Renamed a subject to ${s.name}`);
  res.json(s);
});
r.delete('/subjects/:id', async (req, res) => {
  const out = await deleteSubject(T(req), req.params.id);
  await audit(req, 'subject.deleted', 'Subject', req.params.id, 'Deleted a subject nobody used');
  res.json(out);
});

// subject offerings
r.get('/offerings/structure', async (req, res) => res.json(await classStructureOf(T(req), parse(z.object({ yearId: objectId }), req.query).yearId)));
r.post('/offerings/bulk', async (req, res) => {
  const b = parse(z.object({ yearId: objectId, subjectId: objectId, classIds: z.array(objectId).min(1).max(60), weeklyPeriods: z.number().int().min(1).max(40).optional() }), req.body);
  const out = await addSubjectToClasses(T(req), b);
  await audit(req, 'offering.added', 'SubjectOffering', null, `Gave a subject to ${out.created} classes`);
  res.status(201).json(out);
});
r.post('/offerings', async (req, res) => {
  const b = parse(z.object({ yearId: objectId, classId: objectId, subject: z.string().trim().max(80).optional(), subjectId: objectId.optional(), weeklyPeriods: z.number().int().min(1).max(40).optional() }).refine((x) => x.subject || x.subjectId, { message: 'Enter the subject name' }), req.body);
  const o = await addSubjectToClass(T(req), b);
  await audit(req, 'offering.added', 'SubjectOffering', o._id, 'Added a subject to a class');
  res.status(201).json(o);
});
r.delete('/offerings/:id', async (req, res) => {
  const out = await removeSubjectFromClass(T(req), req.params.id);
  await audit(req, 'offering.removed', 'SubjectOffering', req.params.id, 'Removed a subject from a class');
  res.json(out);
});
r.get('/offerings', async (req, res) => res.json(await svc.listOfferings(T(req), req.query)));
r.post('/offerings/copy', async (req, res) => {
  const out = await svc.copyOfferings(T(req), parse(v.copyOfferingsBody, req.body));
  await audit(req, 'offering.copied', 'SubjectOffering', null, `Copied offerings (${out.created} created)`);
  res.json(out);
});
r.patch('/offerings/:id', async (req, res) => res.json(await svc.updateOffering(T(req), req.params.id, parse(v.offeringPatch, req.body))));

// school settings
r.get('/settings', async (req, res) => res.json(await svc.getSettings(T(req))));
r.put('/settings', async (req, res) => {
  const s = await svc.updateSettings(T(req), parse(v.settingsBody, req.body));
  await audit(req, 'settings.updated', 'School', T(req), 'Updated school settings');
  res.json(s);
});

export default r;
