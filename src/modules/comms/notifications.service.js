import { Notification, Message, User } from '../../models/index.js';
import { notFound } from '../../core/utils.js';
import { notifyUsers } from '../../services/notify.js';

export async function list(ctx, userId, q) {
  const f = { tenantId: ctx.tenantId, userId };
  if (q.category) f.category = q.category;
  if (q.unread === 'true') f.readAt = null;
  const [items, unread] = await Promise.all([
    Notification.find(f).sort({ createdAt: -1 }).limit(q.limit).lean(),
    Notification.countDocuments({ tenantId: ctx.tenantId, userId, readAt: null }),
  ]);
  return { unread, items };
}
export async function markRead(ctx, userId, id) {
  const n = await Notification.findOneAndUpdate({ _id: id, tenantId: ctx.tenantId, userId }, { readAt: new Date() }, { new: true });
  if (!n) throw notFound('Notification not found');
  return n;
}
export async function markAllRead(ctx, userId, category) {
  const r = await Notification.updateMany({ tenantId: ctx.tenantId, userId, readAt: null, ...(category ? { category } : {}) }, { readAt: new Date() });
  return r.modifiedCount;
}
export const unreadCount = (tenantId, userId) => Notification.countDocuments({ tenantId, userId, readAt: null });

// ── teacher → admin messages (delivery status recorded) ──
export async function sendToAdmin(ctx, user, body) {
  const m = await Message.create({ tenantId: ctx.tenantId, fromUserId: user._id, fromName: user.name, fromRole: user.role, ...body });
  const admins = await User.find({ tenantId: ctx.tenantId, role: 'school_admin', status: 'active' }).select('_id');
  await notifyUsers(ctx.tenantId, admins.map((a) => a._id), { category: 'system', title: `Message from ${user.name}`, body: body.subject, link: { type: 'message', id: String(m._id) }, dedupeKey: `msg:${m._id}` });
  return m;
}
export const myMessages = (ctx, userId) => Message.find({ tenantId: ctx.tenantId, fromUserId: userId }).sort({ createdAt: -1 }).limit(50).lean();
export const inbox = (ctx) => Message.find({ tenantId: ctx.tenantId, toRole: 'school_admin' }).sort({ createdAt: -1 }).limit(100).lean();
export async function markMessageRead(ctx, id) {
  const m = await Message.findOneAndUpdate({ _id: id, tenantId: ctx.tenantId }, { status: 'read', readAt: new Date() }, { new: true });
  if (!m) throw notFound('Message not found');
  return m;
}

/** A teacher can retract a message they sent to the admin (e.g. sent by mistake). */
export async function retractMessage(ctx, userId, id) {
  const m = await Message.findOne({ _id: id, tenantId: ctx.tenantId, fromUserId: userId });
  if (!m) throw notFound('Message not found');
  await Notification.deleteMany({ tenantId: ctx.tenantId, 'link.type': 'message', 'link.id': String(m._id) });
  await m.deleteOne();
}
