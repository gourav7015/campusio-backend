import { Ticket, User, School } from '../../models/index.js';
import { notifyUsers } from '../../services/notify.js';
import { nextSeq } from '../../services/context.js';
import { sendNotificationEmail } from '../../services/email.js';
import { config } from '../../core/config.js';
import { bad, conflict, notFound, escapeRegex, HttpError } from '../../core/utils.js';
import { signFileToken } from '../../services/files.js';

/**
 * Help desk. Everyone who signs in to a school (School Admin, teacher, student, staff, finance, library, transport) writes to Campusio support:
 *   scope 'platform'  handled by the Super Admin side; the support inbox (or every Super Admin) is emailed.
 *   scope 'school'    a person asks their own school's admin. Supported here but not switched on: no route reaches it today.
 * Every person involved also gets an in-app notification (category 'helpdesk'), and an email when email is set up.
 */
/** How much one person may send. Every ticket and reply can send an email, so a flood would use up the mail allowance for everyone. */
export const LIMITS = { newPerHour: 5, repliesPerHourPerTicket: 15, autoCloseDays: 7 };
const HOUR = 60 * 60 * 1000;
const tooMany = (what) => new HttpError(429, `You are sending ${what} too quickly. Please wait a little and try again.`, 'RATE_LIMIT');
const attachmentsOf = (files = []) => files.map((f) => ({ fileId: f._id, name: f.originalName, mime: f.mime, size: f.size }));

const snippet = (s, n = 140) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const link = (t, toHandler = false) => ({ type: toHandler && t.scope === 'school' ? 'ticket_inbox' : 'ticket', id: String(t._id) }); // where the notification opens: the school's ticket inbox, or the person's own ticket list
const pageFor = (scope) => (scope === 'platform' ? '/platform/helpdesk' : '/helpdesk');

/** School admins who handle school tickets: the full admins, and sub-admins who hold the communication permission. */
async function schoolHandlerIds(tenantId) {
  const admins = await User.find({ tenantId, role: 'school_admin', status: 'active' }).select('adminLevel permissions').lean();
  return admins.filter((a) => a.adminLevel !== 'sub' || (a.permissions || []).includes('communication')).map((a) => a._id);
}

/** Tell the handling side about something the requester did (a new ticket or a new reply). */
async function tellHandlers(t, { title, body, school, key = String(t.messages.length) }) {
  if (t.scope === 'school') {
    await notifyUsers(t.tenantId, await schoolHandlerIds(t.tenantId), { category: 'helpdesk', title, body: snippet(body), link: link(t, true), dedupeKey: `tkt:${t._id}:${key}:h` });
    return;
  }
  // platform tickets are emailed to the support inbox, or to every Super Admin when no inbox is set; they also show (with a count) in the platform help desk
  const to = config.mail.supportTo ? [config.mail.supportTo] : (await User.find({ role: 'super_admin', status: 'active', email: { $exists: true, $ne: '' } }).select('email').lean()).map((u) => u.email);
  for (const addr of new Set(to)) {
    sendNotificationEmail(addr, {
      subject: `[${t.reference}] ${t.subject}`, heading: title,
      lines: [`${school?.name || 'A school'} · ${t.raisedBy.name} (${t.raisedBy.role})${t.raisedBy.email ? ` <${t.raisedBy.email}>` : ''}`, `Category: ${t.category} · Priority: ${t.priority}`, body],
      button: { label: 'Open in the help desk', url: `${config.mail.appUrl}${pageFor('platform')}?open=${t._id}` },
      replyTo: t.raisedBy.email || undefined,
    });
  }
}
const tellRequester = (t, title, body, key = `m${t.messages.length}`) => notifyUsers(t.tenantId, [t.raisedBy.userId], { category: 'helpdesk', title, body: snippet(body), link: link(t), dedupeKey: `tkt:${t._id}:r:${key}` });

// ── shapes ──
const row = (t, extra = {}) => ({
  _id: t._id, reference: t.reference, scope: t.scope, subject: t.subject, category: t.category, priority: t.priority, status: t.status,
  raisedBy: t.raisedBy, assignedTo: t.assignedTo?.userId ? t.assignedTo : null, lastActivityAt: t.lastActivityAt, lastReplyBy: t.lastReplyBy,
  replies: Math.max(0, t.messages.filter((m) => !m.internal).length - 1), createdAt: t.createdAt, ...extra,
});
/** The conversation. The person who raised the ticket never sees internal notes. */
const view = (t, { handler, school }) => ({
  ...row(t, school ? { school: { _id: school._id, name: school.name, code: school.code } } : {}),
  resolvedAt: t.resolvedAt, closedAt: t.closedAt,
  messages: t.messages.filter((m) => handler || !m.internal).map((m) => ({ _id: m._id, authorName: m.authorName, authorRole: m.authorRole, body: m.body, internal: m.internal, at: m.at, attachments: (m.attachments || []).map((a) => ({ fileId: a.fileId, name: a.name, mime: a.mime, size: a.size })), fromRequester: String(m.authorId) === String(t.raisedBy.userId) })),
});
const schoolOf = async (t) => School.findById(t.tenantId).select('name code').lean();

// ── requester side (the person who has the problem) ──
export async function createTicket(ctx, user, scope, body, { _id, files } = {}) {
  const recent = await Ticket.countDocuments({ tenantId: ctx.tenantId, 'raisedBy.userId': user._id, createdAt: { $gt: new Date(Date.now() - HOUR) } });
  if (recent >= LIMITS.newPerHour) throw tooMany('tickets');
  const number = await nextSeq(ctx.tenantId, `ticket:${scope}`);
  const reference = scope === 'platform' ? `${String(ctx.school.code || 'SCH').toUpperCase()}-${number}` : `T-${String(number).padStart(4, '0')}`;
  const t = await Ticket.create({
    ...(_id ? { _id } : {}), tenantId: ctx.tenantId, scope, number, reference, subject: body.subject, category: body.category, priority: body.priority,
    raisedBy: { userId: user._id, name: user.name, role: user.role, email: user.email },
    messages: [{ authorId: user._id, authorName: user.name, authorRole: user.role, body: body.body, attachments: attachmentsOf(files) }],
  });
  await tellRequester(t, `We received your ticket ${t.reference}`, `${t.subject} — we will reply here and by email.`);
  await tellHandlers(t, { title: `New ticket ${t.reference}: ${t.subject}`, body: body.body, school: ctx.school });
  return view(t, { handler: false });
}
export async function listMine(ctx, userId, scope, query) {
  const filter = { tenantId: ctx.tenantId, scope, 'raisedBy.userId': userId, ...(query.status ? { status: query.status } : {}) };
  const rows = await Ticket.find(filter).sort({ lastActivityAt: -1 }).skip(query.skip).limit(query.limit);
  return rows.map((t) => row(t));
}
async function mine(ctx, userId, scope, id) {
  const t = await Ticket.findOne({ _id: id, tenantId: ctx.tenantId, scope, 'raisedBy.userId': userId });
  if (!t) throw notFound('Ticket not found');
  return t;
}
export async function getMine(ctx, userId, scope, id) { return view(await mine(ctx, userId, scope, id), { handler: false }); }
export async function replyMine(ctx, user, scope, id, body, { files } = {}) {
  const t = await mine(ctx, user._id, scope, id);
  if (t.status === 'closed') throw conflict('This ticket is closed. Please raise a new one.');
  const since = Date.now() - HOUR;
  if (t.messages.filter((m) => String(m.authorId) === String(user._id) && m.at.getTime() > since).length >= LIMITS.repliesPerHourPerTicket) throw tooMany('replies');
  t.messages.push({ authorId: user._id, authorName: user.name, authorRole: user.role, body: body.body, attachments: attachmentsOf(files) });
  t.status = 'open'; t.resolvedAt = undefined; t.lastReplyBy = 'requester'; t.lastActivityAt = new Date();
  await t.save();
  await tellHandlers(t, { title: `New reply on ${t.reference}: ${t.subject}`, body: body.body, school: ctx.school });
  return view(t, { handler: false });
}
export async function closeMine(ctx, userId, scope, id) {
  const t = await mine(ctx, userId, scope, id);
  if (t.status !== 'closed') {
    t.status = 'closed'; t.closedAt = new Date(); t.lastActivityAt = new Date(); await t.save();
    await tellHandlers(t, { title: `${t.reference} was closed by ${t.raisedBy.name}`, body: t.subject, school: ctx.school, key: 'closed' });
  }
  return view(t, { handler: false });
}
/** The count shown beside the menu item: tickets waiting for this person (they were answered), or for a handler, tickets nobody has answered yet. */
export async function mySummary(ctx, userId, scope) {
  return { count: await Ticket.countDocuments({ tenantId: ctx.tenantId, scope, 'raisedBy.userId': userId, status: 'pending' }) };
}

// ── handling side ──
/** `scope` fixes which tickets this person can reach; `tenantId` limits school tickets to the admin's own school (platform tickets span schools). */
const reach = (scope, tenantId) => ({ scope, ...(scope === 'school' ? { tenantId } : {}) });

export async function inbox(scope, tenantId, query, actorId) {
  const filter = { ...reach(scope, tenantId) };
  if (query.status) filter.status = query.status;
  else if (query.open === 'true') filter.status = { $in: ['open', 'pending'] };
  if (query.priority) filter.priority = query.priority;
  if (query.category) filter.category = query.category;
  if (query.mine === 'true') filter['assignedTo.userId'] = actorId;
  if (query.schoolId && scope === 'platform') filter.tenantId = query.schoolId;
  if (query.q) { const rx = new RegExp(escapeRegex(query.q), 'i'); filter.$or = [{ subject: rx }, { reference: rx }, { 'raisedBy.name': rx }]; }
  const [rows, total, counts] = await Promise.all([
    Ticket.find(filter).sort({ lastActivityAt: -1 }).skip(query.skip).limit(query.limit).populate('tenantId', 'name code'),
    Ticket.countDocuments(filter),
    Ticket.aggregate([{ $match: reach(scope, tenantId) }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const byStatus = { open: 0, pending: 0, resolved: 0, closed: 0 };
  counts.forEach((c) => { byStatus[c._id] = c.n; });
  return { total, counts: byStatus, tickets: rows.map((t) => row(t, { school: t.tenantId?.name ? { _id: t.tenantId._id, name: t.tenantId.name, code: t.tenantId.code } : null })) };
}
async function load(scope, tenantId, id) {
  const t = await Ticket.findOne({ _id: id, ...reach(scope, tenantId) });
  if (!t) throw notFound('Ticket not found');
  return t;
}
/** Which school a ticket belongs to (used to file attachments under the right school). */
export async function tenantOf(scope, tenantId, id) { return (await load(scope, tenantId, id)).tenantId; }
export async function getForHandler(scope, tenantId, id) {
  const t = await load(scope, tenantId, id);
  return view(t, { handler: true, school: await schoolOf(t) });
}
export async function replyAsHandler(scope, tenantId, user, id, body, { files } = {}) {
  const t = await load(scope, tenantId, id);
  if (t.status === 'closed' && !body.internal) throw conflict('This ticket is closed. Reopen it to reply.');
  t.messages.push({ authorId: user._id, authorName: user.name, authorRole: user.role, body: body.body, internal: body.internal, attachments: attachmentsOf(files) });
  if (!body.internal) {
    if (t.status === 'open' || t.status === 'resolved') t.status = 'pending'; // now waiting for the person who raised it
    t.resolvedAt = undefined; t.lastReplyBy = 'handler'; t.lastActivityAt = new Date();
    if (!t.assignedTo?.userId) t.assignedTo = { userId: user._id, name: user.name };
  }
  await t.save();
  if (!body.internal) await tellRequester(t, `Reply on your ticket ${t.reference}`, body.body);
  return view(t, { handler: true, school: await schoolOf(t) });
}
export async function updateAsHandler(scope, tenantId, user, id, patch) {
  const t = await load(scope, tenantId, id);
  const before = t.status;
  if (patch.priority) t.priority = patch.priority;
  if (patch.category) t.category = patch.category;
  if (patch.assignedTo !== undefined) {
    if (patch.assignedTo === null) t.assignedTo = undefined;
    else {
      const who = await User.findOne({ _id: patch.assignedTo, status: 'active', role: scope === 'platform' ? 'super_admin' : 'school_admin', ...(scope === 'school' ? { tenantId } : {}) }).select('name');
      if (!who) throw bad(scope === 'platform' ? 'Assign to a platform administrator' : 'Assign to an admin of this school');
      t.assignedTo = { userId: who._id, name: who.name };
    }
  }
  if (patch.status && patch.status !== t.status) {
    t.status = patch.status;
    if (patch.status === 'resolved') t.resolvedAt = new Date();
    if (patch.status === 'closed') t.closedAt = new Date();
    if (patch.status === 'open' || patch.status === 'pending') { t.resolvedAt = undefined; t.closedAt = undefined; }
  }
  t.lastActivityAt = new Date();
  await t.save();
  if (t.status !== before && ['resolved', 'closed'].includes(t.status)) await tellRequester(t, `Your ticket ${t.reference} was ${t.status}`, t.subject, `${t.status}:${Date.now()}`);
  return view(t, { handler: true, school: await schoolOf(t) });
}

/** Tickets nobody has answered yet (status open): the count for the handler's menu. */
export async function handlerSummary(scope, tenantId) {
  return { count: await Ticket.countDocuments({ ...reach(scope, tenantId), status: 'open' }) };
}

/**
 * A short-lived download link for one attachment, after checking that it really belongs to this ticket (and is not on a private note
 * unless the person is on the handling side). The download itself checks the permission again.
 */
export function attachmentLink(t, fileId, user, { handler }) {
  const m = t.messages.find((x) => (handler || !x.internal) && (x.attachments || []).some((a) => String(a.fileId) === String(fileId)));
  if (!m) throw notFound('File not found');
  const a = m.attachments.find((x) => String(x.fileId) === String(fileId));
  return { url: `/api/files/download/${fileId}?token=${encodeURIComponent(signFileToken(fileId, user._id))}`, name: a.name, expiresInSeconds: config.fileLinkTtlSeconds };
}
export async function linkMine(ctx, user, scope, id, fileId) { return attachmentLink(await mine(ctx, user._id, scope, id), fileId, user, { handler: false }); }
export async function linkForHandler(scope, tenantId, user, id, fileId) { return attachmentLink(await load(scope, tenantId, id), fileId, user, { handler: true }); }

/** Resolved tickets that nobody reopened are closed after a week, so the inbox does not fill up. */
export async function autoCloseResolved(now = new Date()) {
  const cutoff = new Date(now.getTime() - LIMITS.autoCloseDays * 24 * HOUR);
  const r = await Ticket.updateMany({ status: 'resolved', resolvedAt: { $lt: cutoff } }, { $set: { status: 'closed', closedAt: now } });
  return r.modifiedCount;
}
