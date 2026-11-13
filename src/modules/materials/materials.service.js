import { StudyMaterial, Subject, Teacher, File, Section, ClassModel, TeachingAssignment } from '../../models/index.js';
import { notFound, conflict, bad, forbidden, escapeRegex } from '../../core/utils.js';
import { notifyUsers, studentUserIdsInSections } from '../../services/notify.js';
import { removeFileBytes } from '../../services/files.js';

const visibleNow = (m, today) => m.status === 'published' && (!m.publishDate || m.publishDate <= today) && (!m.expiryDate || m.expiryDate >= today);

function assertScope(ctx, sectionId, subjectId) {
  if (ctx.role === 'teacher' && !ctx.scope.canTeach(sectionId, subjectId)) throw forbidden('You are not assigned to teach this subject in this section');
}
function assertOwn(ctx, m) {
  if (ctx.role === 'teacher' && String(m.teacherId) !== String(ctx.teacher._id)) throw forbidden('You can change only your own materials');
}

async function decorate(tenantId, rows, today) {
  const [subjects, sections, teachers, files] = await Promise.all([
    Subject.find({ tenantId, _id: { $in: rows.map((m) => m.subjectId) } }).select('name code').lean(),
    Section.find({ tenantId, _id: { $in: rows.map((m) => m.sectionId) } }).lean(),
    Teacher.find({ tenantId, _id: { $in: rows.map((m) => m.teacherId) } }).select('name').lean(),
    File.find({ tenantId, _id: { $in: rows.map((m) => m.fileId).filter(Boolean) } }).select('originalName size mime').lean(),
  ]);
  const classes = await ClassModel.find({ tenantId, _id: { $in: sections.map((s) => s.classId) } }).lean();
  const mk = (a) => new Map(a.map((x) => [String(x._id), x]));
  const S = mk(subjects); const SEC = mk(sections); const T = mk(teachers); const F = mk(files); const C = mk(classes);
  return rows.map((m) => {
    const sec = SEC.get(String(m.sectionId));
    return {
      ...m, visible: visibleNow(m, today), subject: S.get(String(m.subjectId))?.name, teacher: T.get(String(m.teacherId))?.name,
      section: sec?.name, className: C.get(String(sec?.classId))?.name, file: m.fileId ? F.get(String(m.fileId)) : undefined,
      isNew: m.createdAt && Date.now() - new Date(m.createdAt).getTime() < 7 * 86400000,
    };
  });
}

export async function listForStaff(ctx, q) {
  const f = { tenantId: ctx.tenantId, yearId: q.yearId || ctx.year._id };
  if (ctx.role === 'teacher') { f.teacherId = ctx.teacher._id; f.sectionId = { $in: ctx.scope.allAssignments.map((a) => a.sectionId) }; }
  if (q.sectionId) f.sectionId = q.sectionId;
  if (q.subjectId) f.subjectId = q.subjectId;
  if (q.status) f.status = q.status;
  if (q.from || q.to) f.createdAt = { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lte: new Date(`${q.to}T23:59:59Z`) } : {}) };
  return decorate(ctx.tenantId, await StudyMaterial.find(f).sort({ createdAt: -1 }).limit(300).lean(), ctx.today);
}

export async function createMaterial(ctx, body, file) {
  assertScope(ctx, body.sectionId, body.subjectId);
  const section = await Section.findOne({ _id: body.sectionId, tenantId: ctx.tenantId });
  if (!section) throw notFound('Section not found');
  if (!file && !body.externalUrl) throw bad('Upload a file or provide an external link');
  if (file && body.externalUrl) throw bad('Provide either a file or an external link, not both');
  if (body.expiryDate && body.publishDate && body.expiryDate < body.publishDate) throw bad('Expiry date cannot be before the publish date');
  let teacherId = ctx.teacher?._id;
  if (!teacherId) {
    const a = await TeachingAssignment.findOne({ tenantId: ctx.tenantId, sectionId: body.sectionId, subjectId: body.subjectId, open: true });
    if (!a) throw bad('No teacher is assigned to this subject in that section');
    teacherId = a.teacherId;
  }
  const m = await StudyMaterial.create({ ...body, tenantId: ctx.tenantId, yearId: section.yearId, teacherId, fileId: file?._id, publishDate: body.publishDate || ctx.today });
  if (file) { file.ownerType = 'material'; file.ownerId = String(m._id); await file.save(); }
  if (m.status === 'published') await announce(ctx, m);
  return m;
}

async function announce(ctx, m) {
  const ids = await studentUserIdsInSections(ctx.tenantId, [m.sectionId]);
  const subj = await Subject.findById(m.subjectId).select('name');
  await notifyUsers(ctx.tenantId, ids, { category: 'homework', title: `New ${subj?.name || ''} study material`, body: m.title, link: { type: 'material', id: String(m._id) }, dedupeKey: `sm:${m._id}` });
}

async function load(ctx, id) {
  const m = await StudyMaterial.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!m) throw notFound('Material not found');
  assertScope(ctx, m.sectionId, m.subjectId);
  assertOwn(ctx, m);
  return m;
}

export async function updateMaterial(ctx, id, body) {
  const m = await load(ctx, id);
  if (m.status === 'archived') throw conflict('Archived material cannot be edited');
  Object.assign(m, body);
  if (m.expiryDate && m.publishDate && m.expiryDate < m.publishDate) throw bad('Expiry date cannot be before the publish date');
  return m.save();
}
export async function setStatus(ctx, id, action) {
  const m = await load(ctx, id);
  if (action === 'publish') { if (m.status === 'published') throw conflict('Already published'); m.status = 'published'; }
  else if (action === 'unpublish') { if (m.status !== 'published') throw conflict('Not published'); m.status = 'unpublished'; }
  else if (action === 'archive') m.status = 'archived';
  else throw bad('Unknown action');
  await m.save();
  if (action === 'publish') await announce(ctx, m);
  return m;
}
export async function replaceFile(ctx, id, file) {
  const m = await load(ctx, id);
  const old = m.fileId && (await File.findOne({ _id: m.fileId, tenantId: ctx.tenantId }));
  m.fileId = file._id; m.externalUrl = undefined;
  await m.save();
  file.ownerType = 'material'; file.ownerId = String(m._id); await file.save();
  if (old) { await removeFileBytes(old); await old.deleteOne(); }
  return m;
}
export async function deleteMaterial(ctx, id) {
  const m = await load(ctx, id);
  if (m.status === 'published') throw conflict('Unpublish or archive the material before deleting');
  const f = m.fileId && (await File.findOne({ _id: m.fileId, tenantId: ctx.tenantId }));
  if (f) { await removeFileBytes(f); await f.deleteOne(); }
  await m.deleteOne();
}

// ── student: only published, in-window material for the student's own section(s) ──
export async function listForStudent(ctx, q) {
  if (!ctx.sectionIds.length) return { groups: [], total: 0 };
  const f = { tenantId: ctx.tenantId, yearId: ctx.year._id, sectionId: { $in: ctx.sectionIds }, status: 'published' };
  if (q.subjectId) f.subjectId = q.subjectId;
  if (q.type) f.materialType = q.type;
  if (q.teacherId) f.teacherId = q.teacherId;
  if (q.chapter) f.chapter = new RegExp(escapeRegex(q.chapter), 'i');
  if (q.q) { const rx = new RegExp(escapeRegex(q.q), 'i'); f.$or = [{ title: rx }, { description: rx }, { chapter: rx }]; }
  if (q.from) f.createdAt = { $gte: new Date(q.from) };
  const rows = (await StudyMaterial.find(f).sort({ createdAt: -1 }).lean()).filter((m) => visibleNow(m, ctx.today));
  const dec = await decorate(ctx.tenantId, rows, ctx.today);
  const groups = new Map();
  for (const m of dec) {
    const key = m.subject || 'Other';
    if (!groups.has(key)) groups.set(key, new Map());
    const chap = m.chapter || 'General';
    if (!groups.get(key).has(chap)) groups.get(key).set(chap, []);
    groups.get(key).get(chap).push(m);
  }
  return { total: dec.length, groups: [...groups].map(([subject, chapters]) => ({ subject, chapters: [...chapters].map(([chapter, items]) => ({ chapter, items })) })) };
}
export async function getForStudent(ctx, id) {
  const m = await StudyMaterial.findOne({ _id: id, tenantId: ctx.tenantId, sectionId: { $in: ctx.sectionIds }, status: 'published' }).lean();
  if (!m || !visibleNow(m, ctx.today)) throw notFound('Material not found');
  return (await decorate(ctx.tenantId, [m], ctx.today))[0];
}
export { visibleNow };
