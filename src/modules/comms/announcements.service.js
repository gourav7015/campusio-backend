import { Announcement, AnnouncementRead, User, Teacher, StudentEnrolment, Student, TeachingAssignment, ClassTeacherAssignment, File, Notification } from '../../models/index.js';
import { notFound, forbidden } from '../../core/utils.js';
import { removeFileBytes } from '../../services/files.js';
import { notifyUsers } from '../../services/notify.js';

/** Which users an announcement targets (used to notify, never to authorise reading). */
export async function audienceUserIds(tenantId, audience) {
  const ids = new Set();
  const roles = audience.all ? ['teacher', 'student'] : audience.roles;
  if (roles.length && !audience.sectionIds.length) {
    (await User.find({ tenantId, role: { $in: roles }, status: 'active' }).select('_id')).forEach((u) => ids.add(String(u._id)));
  }
  if (audience.sectionIds.length) {
    const enr = await StudentEnrolment.find({ tenantId, sectionId: { $in: audience.sectionIds }, status: 'active' }).select('studentId');
    if (!audience.roles.length || audience.roles.includes('student')) {
      (await Student.find({ tenantId, _id: { $in: enr.map((e) => e.studentId) } }).select('userId')).forEach((s) => s.userId && ids.add(String(s.userId)));
    }
    if (!audience.roles.length || audience.roles.includes('teacher')) {
      const [ta, ct] = await Promise.all([
        TeachingAssignment.find({ tenantId, sectionId: { $in: audience.sectionIds }, open: true }).select('teacherId'),
        ClassTeacherAssignment.find({ tenantId, sectionId: { $in: audience.sectionIds }, open: true }).select('teacherId'),
      ]);
      (await Teacher.find({ tenantId, _id: { $in: [...ta, ...ct].map((a) => a.teacherId) } }).select('userId')).forEach((t) => t.userId && ids.add(String(t.userId)));
    }
  }
  return [...ids];
}

const liveNow = (a, now = new Date()) => a.status === 'published' && (!a.publishAt || a.publishAt <= now);

/** Read access: role + audience (sections the viewer teaches / is enrolled in). */
export function visibleTo(a, { role, sectionIds = [] }) {
  if (role === 'school_admin' || role === 'super_admin') return true;
  if (!liveNow(a)) return false;
  const aud = a.audience || {};
  if (aud.all) return true;
  const sec = (aud.sectionIds || []).map(String);
  if (sec.length) return sec.some((s) => sectionIds.includes(s)) && (!aud.roles?.length || aud.roles.includes(role));
  return (aud.roles || []).includes(role);
}

async function withReadState(tenantId, userId, rows) {
  const reads = await AnnouncementRead.find({ tenantId, userId, announcementId: { $in: rows.map((a) => a._id) } }).select('announcementId').lean();
  const rs = new Set(reads.map((r) => String(r.announcementId)));
  const files = await File.find({ tenantId, _id: { $in: rows.flatMap((a) => a.attachments || []) } }).select('originalName size').lean();
  const F = new Map(files.map((f) => [String(f._id), f]));
  return rows.map((a) => ({ ...a, mine: !!userId && String(a.createdBy) === String(userId), read: rs.has(String(a._id)), attachmentFiles: (a.attachments || []).map((id) => F.get(String(id))).filter(Boolean) }));
}

export async function listFor(ctx, { role, sectionIds, userId }, { limit = 50 } = {}) {
  const rows = await Announcement.find({ tenantId: ctx.tenantId }).sort({ createdAt: -1 }).limit(200).lean();
  // a sender always sees (and can delete) what they sent, even when it targets students only
  const mine = rows.filter((a) => visibleTo(a, { role, sectionIds }) || String(a.createdBy) === String(userId)).slice(0, limit);
  return withReadState(ctx.tenantId, userId, mine);
}
export async function getFor(ctx, viewer, id) {
  const a = await Announcement.findOne({ _id: id, tenantId: ctx.tenantId }).lean();
  if (!a || !(visibleTo(a, viewer) || String(a.createdBy) === String(viewer.userId))) throw notFound('Announcement not found');
  return (await withReadState(ctx.tenantId, viewer.userId, [a]))[0];
}
export async function markRead(ctx, viewer, id) {
  await getFor(ctx, viewer, id);
  await AnnouncementRead.updateOne({ announcementId: id, userId: viewer.userId }, { $setOnInsert: { tenantId: ctx.tenantId } }, { upsert: true });
}

async function publishFanout(ctx, a) {
  if (!liveNow(a)) return;
  const ids = await audienceUserIds(ctx.tenantId, a.audience);
  await notifyUsers(ctx.tenantId, ids, { category: 'announcements', title: a.category === 'urgent' ? `URGENT: ${a.title}` : a.title, body: (a.body || '').slice(0, 140), link: { type: 'announcement', id: String(a._id) }, dedupeKey: `ann:${a._id}` });
}

export async function create(ctx, body, creator) {
  const a = await Announcement.create({
    ...body, tenantId: ctx.tenantId, publishAt: body.publishAt ? new Date(body.publishAt) : undefined, createdBy: ctx.actorId,
    createdByName: creator?.name, createdByRole: creator?.role,
  });
  await publishFanout(ctx, a);
  return a;
}

/** A teacher may send a class notice only to sections they teach (class teacher or subject teacher). */
export async function createForTeacher(ctx, body, creator) {
  const allowed = new Set(ctx.scope.sectionIds);
  if (body.sectionIds.some((id) => !allowed.has(String(id)))) throw forbidden('You can send notices only to your own classes');
  return create(ctx, { title: body.title, body: body.body, category: body.category, audience: { all: false, roles: ['student'], sectionIds: body.sectionIds }, status: 'published' }, creator);
}

/**
 * Retract a broadcast: removes the notice, everyone's read marks and the bell notifications it created.
 * Admin may remove any notice; a teacher only their own. The audit log keeps a record of the removal.
 */
export async function remove(ctx, id, { role, userId }) {
  const a = await Announcement.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!a) throw notFound('Announcement not found');
  if (role === 'teacher' && String(a.createdBy) !== String(userId)) throw forbidden('You can delete only notices you sent');
  const files = await File.find({ tenantId: ctx.tenantId, _id: { $in: a.attachments } });
  for (const f of files) { await removeFileBytes(f); await f.deleteOne(); }
  await Promise.all([
    AnnouncementRead.deleteMany({ announcementId: a._id }),
    Notification.deleteMany({ tenantId: ctx.tenantId, 'link.type': 'announcement', 'link.id': String(a._id) }),
  ]);
  await a.deleteOne();
  return a;
}

export async function update(ctx, id, body) {
  const a = await Announcement.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!a) throw notFound('Announcement not found');
  Object.assign(a, body, body.publishAt ? { publishAt: new Date(body.publishAt) } : {});
  await a.save();
  await publishFanout(ctx, a);
  return a;
}
export async function archive(ctx, id) {
  const a = await Announcement.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!a) throw notFound('Announcement not found');
  a.status = 'archived';
  return a.save();
}
export async function attach(ctx, id, file) {
  const a = await Announcement.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!a) throw notFound('Announcement not found');
  a.attachments.push(file._id);
  return a.save();
}
export { forbidden };
