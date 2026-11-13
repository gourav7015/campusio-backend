import { Homework, Subject, Teacher, File, Section, ClassModel } from '../../models/index.js';
import { notFound, conflict, bad, forbidden, addDays } from '../../core/utils.js';
import { notifyUsers, studentUserIdsInSections } from '../../services/notify.js';
import { removeFileBytes } from '../../services/files.js';

/** Scheduled homework becomes visible automatically once its publish time passes. */
export function effectiveStatus(h, now = new Date()) {
  if (h.status === 'scheduled' && h.publishAt && h.publishAt <= now) return 'published';
  return h.status;
}
export function teacherTab(h, today, now) {
  const s = effectiveStatus(h, now);
  if (s === 'archived') return 'archived';
  if (s === 'draft') return 'draft';
  if (s === 'scheduled') return 'scheduled';
  return h.dueDate < today ? 'completed' : 'published';
}

function assertScope(ctx, sectionId, subjectId) {
  if (ctx.role !== 'teacher') return;
  if (!ctx.scope.canTeach(sectionId, subjectId)) throw forbidden('You are not assigned to teach this subject in this section');
}

async function decorate(tenantId, rows, today, now) {
  const [subjects, sections, teachers] = await Promise.all([
    Subject.find({ tenantId, _id: { $in: rows.map((h) => h.subjectId) } }).select('name code').lean(),
    Section.find({ tenantId, _id: { $in: rows.map((h) => h.sectionId) } }).lean(),
    Teacher.find({ tenantId, _id: { $in: rows.map((h) => h.teacherId) } }).select('name').lean(),
  ]);
  const classes = await ClassModel.find({ tenantId, _id: { $in: sections.map((s) => s.classId) } }).lean();
  const S = new Map(subjects.map((x) => [String(x._id), x])); const SEC = new Map(sections.map((x) => [String(x._id), x]));
  const T = new Map(teachers.map((x) => [String(x._id), x])); const C = new Map(classes.map((x) => [String(x._id), x]));
  const files = await File.find({ tenantId, _id: { $in: rows.flatMap((h) => h.attachments || []) } }).select('originalName size mime').lean();
  const F = new Map(files.map((x) => [String(x._id), x]));
  return rows.map((h) => {
    const sec = SEC.get(String(h.sectionId));
    return {
      ...h, effectiveStatus: effectiveStatus(h, now), tab: teacherTab(h, today, now),
      subject: S.get(String(h.subjectId))?.name, subjectCode: S.get(String(h.subjectId))?.code, teacher: T.get(String(h.teacherId))?.name,
      section: sec?.name, className: C.get(String(sec?.classId))?.name,
      attachmentFiles: (h.attachments || []).map((id) => F.get(String(id))).filter(Boolean),
    };
  });
}

export async function listForStaff(ctx, q) {
  const f = { tenantId: ctx.tenantId, yearId: q.yearId || ctx.year._id };
  if (ctx.role === 'teacher') { f.sectionId = { $in: ctx.scope.allAssignments.map((a) => a.sectionId) }; f.teacherId = ctx.teacher._id; }
  if (q.sectionId) f.sectionId = q.sectionId;
  if (q.subjectId) f.subjectId = q.subjectId;
  const rows = await Homework.find(f).sort({ dueDate: -1, createdAt: -1 }).limit(300).lean();
  const now = new Date();
  const out = await decorate(ctx.tenantId, rows, ctx.today, now);
  return q.tab === 'all' ? out : out.filter((h) => h.tab === q.tab);
}

export async function getForStaff(ctx, id) {
  const h = await Homework.findOne({ _id: id, tenantId: ctx.tenantId }).lean();
  if (!h) throw notFound('Homework not found');
  if (ctx.role === 'teacher' && !ctx.scope.allAssignments.some((a) => String(a.sectionId) === String(h.sectionId) && String(a.subjectId) === String(h.subjectId))) {
    throw forbidden('This homework is not in your assigned classes');
  }
  return (await decorate(ctx.tenantId, [h], ctx.today, new Date()))[0];
}

async function announce(ctx, h) {
  const ids = await studentUserIdsInSections(ctx.tenantId, [h.sectionId]);
  const subj = await Subject.findById(h.subjectId).select('name');
  await notifyUsers(ctx.tenantId, ids, {
    category: 'homework', title: `New ${subj?.name || ''} homework`, body: `${h.title} — due ${h.dueDate}`, link: { type: 'homework', id: String(h._id) }, dedupeKey: `hw:${h._id}`,
  });
}

export async function createHomework(ctx, body, byName) {
  assertScope(ctx, body.sectionId, body.subjectId);
  const section = await Section.findOne({ _id: body.sectionId, tenantId: ctx.tenantId });
  if (!section) throw notFound('Section not found');
  const assignedDate = body.assignedDate || ctx.today;
  if (body.dueDate < assignedDate) throw bad('Due date cannot be before the assigned date');
  if (body.status === 'scheduled' && (!body.publishAt || new Date(body.publishAt) <= new Date())) throw bad('Choose a future publish time for scheduled homework');
  let teacherId = ctx.teacher?._id;
  if (!teacherId) {
    const { TeachingAssignment } = await import('../../models/index.js');
    const a = await TeachingAssignment.findOne({ tenantId: ctx.tenantId, sectionId: body.sectionId, subjectId: body.subjectId, open: true });
    if (!a) throw bad('No teacher is assigned to this subject in that section');
    teacherId = a.teacherId;
  }
  const h = await Homework.create({
    ...body, tenantId: ctx.tenantId, yearId: section.yearId, teacherId, assignedDate, publishAt: body.publishAt ? new Date(body.publishAt) : undefined,
    publishedAt: body.status === 'published' ? new Date() : undefined, editHistory: [{ by: ctx.actorId, byName, changes: ['Created'] }],
  });
  if (h.status === 'published') await announce(ctx, h);
  return h;
}

export async function updateHomework(ctx, id, body, byName) {
  const h = await Homework.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!h) throw notFound('Homework not found');
  assertScope(ctx, h.sectionId, h.subjectId);
  if (ctx.role === 'teacher' && String(h.teacherId) !== String(ctx.teacher._id)) throw forbidden('You can edit only your own homework');
  if (h.status === 'archived') throw conflict('Archived homework cannot be edited');
  const changes = [];
  for (const [k, v] of Object.entries(body)) {
    const cur = h[k] instanceof Date ? h[k].toISOString() : h[k];
    if (v !== undefined && String(cur ?? '') !== String(v ?? '')) { changes.push(k); h[k] = k === 'publishAt' ? new Date(v) : v; }
  }
  if (h.dueDate < h.assignedDate) throw bad('Due date cannot be before the assigned date');
  if (changes.length) h.editHistory.push({ by: ctx.actorId, byName, changes });
  await h.save();
  if (changes.includes('dueDate') && effectiveStatus(h) === 'published') {
    const ids = await studentUserIdsInSections(ctx.tenantId, [h.sectionId]);
    await notifyUsers(ctx.tenantId, ids, { category: 'homework', title: 'Homework deadline changed', body: `${h.title} is now due ${h.dueDate}`, link: { type: 'homework', id: String(h._id) }, dedupeKey: `hwd:${h._id}:${h.dueDate}` });
  }
  return h;
}

export async function setHomeworkStatus(ctx, id, action, byName, publishAt) {
  const h = await Homework.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!h) throw notFound('Homework not found');
  assertScope(ctx, h.sectionId, h.subjectId);
  if (ctx.role === 'teacher' && String(h.teacherId) !== String(ctx.teacher._id)) throw forbidden('You can change only your own homework');
  if (action === 'publish') {
    if (h.status === 'published') throw conflict('Already published');
    h.status = 'published'; h.publishedAt = new Date(); h.publishAt = undefined;
  } else if (action === 'schedule') {
    if (!publishAt || new Date(publishAt) <= new Date()) throw bad('Choose a future publish time');
    h.status = 'scheduled'; h.publishAt = new Date(publishAt);
  } else if (action === 'unpublish') {
    if (h.status !== 'published') throw conflict('Only published homework can be moved back to draft');
    h.status = 'draft';
  } else if (action === 'archive') h.status = 'archived';
  else throw bad('Unknown action');
  h.editHistory.push({ by: ctx.actorId, byName, changes: [action] });
  await h.save();
  if (action === 'publish') await announce(ctx, h);
  return h;
}

export async function deleteHomework(ctx, id) {
  const h = await Homework.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!h) throw notFound('Homework not found');
  assertScope(ctx, h.sectionId, h.subjectId);
  if (ctx.role === 'teacher' && String(h.teacherId) !== String(ctx.teacher._id)) throw forbidden('You can delete only your own homework');
  if (h.status !== 'draft') throw conflict('Only drafts can be deleted. Archive published homework instead.');
  const files = await File.find({ tenantId: ctx.tenantId, _id: { $in: h.attachments } });
  for (const f of files) { await removeFileBytes(f); await f.deleteOne(); }
  await h.deleteOne();
}

export async function attachFile(ctx, id, file) {
  const h = await Homework.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!h) throw notFound('Homework not found');
  assertScope(ctx, h.sectionId, h.subjectId);
  if (ctx.role === 'teacher' && String(h.teacherId) !== String(ctx.teacher._id)) throw forbidden('You can change only your own homework');
  h.attachments.push(file._id);
  h.editHistory.push({ by: ctx.actorId, changes: [`attachment: ${file.originalName}`] });
  await h.save();
  return h;
}
export async function detachFile(ctx, id, fileId) {
  const h = await Homework.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!h) throw notFound('Homework not found');
  assertScope(ctx, h.sectionId, h.subjectId);
  h.attachments = h.attachments.filter((f) => String(f) !== String(fileId));
  await h.save();
  const f = await File.findOne({ _id: fileId, tenantId: ctx.tenantId });
  if (f) { await removeFileBytes(f); await f.deleteOne(); }
  return h;
}

// ── student ──
export async function listForStudent(ctx, q) {
  if (!ctx.sectionIds.length) return [];
  const now = new Date();
  const f = { tenantId: ctx.tenantId, yearId: ctx.year._id, sectionId: { $in: ctx.sectionIds }, status: { $in: ['published', 'scheduled'] } };
  if (q.subjectId) f.subjectId = q.subjectId;
  const rows = (await Homework.find(f).sort({ dueDate: 1 }).lean()).filter((h) => effectiveStatus(h, now) === 'published');
  const dec = await decorate(ctx.tenantId, rows, ctx.today, now);
  const soon = addDays(ctx.today, 3);
  const withState = dec.map((h) => ({
    ...h, editHistory: undefined, state: h.dueDate < ctx.today ? 'overdue' : h.dueDate <= soon ? 'due_soon' : 'pending',
    daysLeft: Math.round((new Date(`${h.dueDate}T00:00:00Z`) - new Date(`${ctx.today}T00:00:00Z`)) / 86400000),
  }));
  switch (q.tab) {
    case 'pending': return withState.filter((h) => h.state !== 'overdue');
    case 'due_soon': return withState.filter((h) => h.state === 'due_soon');
    case 'overdue': return withState.filter((h) => h.state === 'overdue');
    case 'completed': return []; // online submission is a later release; nothing can be "submitted" yet
    default: return withState;
  }
}
export async function getForStudent(ctx, id) {
  const list = await listForStudent(ctx, { tab: 'all' });
  const h = list.find((x) => String(x._id) === String(id));
  if (!h) throw notFound('Homework not found');
  return h;
}
