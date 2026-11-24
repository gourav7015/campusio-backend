import { TeamMember, ConnectSettings, ConnectMessage } from '../../models/index.js';
import { config } from '../../core/config.js';
import { notFound } from '../../core/utils.js';
import { sendNotificationEmail } from '../../services/email.js';

/**
 * The public Connect page (atkaksha.in/connect): who to talk to, opening hours, and a message form. The platform administrator manages the team,
 * the wording and hours, and reads the messages. Nothing here belongs to a school.
 */
const REASONS = { demo: 'See a demo', price: 'Pricing and plans', help: 'Help for a school', other: 'Something else' };
export const reasonLabel = (r) => REASONS[r] || r;

const DEFAULTS = () => ({
  title: 'Talk to the people who build AtKaksha',
  intro: 'Reach a person on our team directly, or send a message and we will reply by email.',
  hoursNote: 'Parent, student or teacher? Your school office looks after sign-in and passwords.',
  mailboxes: [
    ['hello', 'Demos, pricing and general questions'], ['support', 'Help for schools already on AtKaksha'], ['billing', 'Invoices and payments'],
    ['privacy', 'Your data and privacy requests'], ['security', 'Report a security problem'],
  ].map(([k, purpose]) => ({ address: `${k}@${(config.mail.from.split('@')[1] || 'atkaksha.com').replace(/[>\s].*$/, '')}`, purpose })),
});

/** The settings document, made on first use. The team starts with the founder from the business card, to be edited or removed from the platform. */
export async function getSettings() {
  let s = await ConnectSettings.findOne({ key: 'connect' });
  if (!s) s = await ConnectSettings.create({ key: 'connect', ...DEFAULTS() });
  if (!s.seeded) {
    await ConnectSettings.updateOne({ _id: s._id }, { $set: { seeded: true } });
    if (!(await TeamMember.estimatedDocumentCount())) await TeamMember.create({ name: 'Gourav Sharma', role: 'Founder, AtKaksha', about: 'Building AtKaksha. Talk to me about the product, or anything you want to see in it.', topics: ['Product', 'Partnerships', 'Feedback'], email: s.mailboxes?.[0]?.address || '', languages: 'English, Hindi', tone: 1, order: 1 });
  }
  return s;
}

const card = (m) => ({ id: m._id, name: m.name, role: m.role || '', about: m.about || '', topics: m.topics || [], phone: m.phone || '', whatsapp: m.whatsapp || '', email: m.email || '', languages: m.languages || '', tone: m.tone || 1, visible: m.visible, order: m.order });

/** What the public page shows: the visible team in their order, the hours and the mailboxes. */
export async function publicView() {
  const s = await getSettings();
  const team = (await TeamMember.find({ visible: true }).sort({ order: 1, createdAt: 1 }).lean()).map(card).map(({ visible: _v, order: _o, ...rest }) => rest);
  return { title: s.title, intro: s.intro, hours: { days: s.hoursDays, opens: s.opensAt, closes: s.closesAt, timezone: s.timezone, note: s.hoursNote || '' }, mailboxes: s.mailboxes.map((m) => ({ address: m.address, purpose: m.purpose })), team };
}

// ───────────── the platform administrator's side ─────────────
export async function adminTeam() { await getSettings(); return (await TeamMember.find().sort({ order: 1, createdAt: 1 }).lean()).map(card); }
export async function addMember(body) {
  const last = await TeamMember.findOne().sort({ order: -1 }).select('order').lean();
  return card((await TeamMember.create({ ...body, order: (last?.order || 0) + 1 })).toObject());
}
export async function updateMember(id, body) {
  const m = await TeamMember.findByIdAndUpdate(id, { $set: body }, { new: true, runValidators: true });
  if (!m) throw notFound('Team member not found');
  return card(m.toObject());
}
export async function removeMember(id) { const m = await TeamMember.findByIdAndDelete(id); if (!m) throw notFound('Team member not found'); return m; }
/** The new order: ids in the order wanted. People left out keep their place after them. */
export async function reorder(ids) {
  await Promise.all(ids.map((id, i) => TeamMember.updateOne({ _id: id }, { $set: { order: i + 1 } })));
  return adminTeam();
}
export async function saveSettings(body) {
  await getSettings();
  return ConnectSettings.findOneAndUpdate({ key: 'connect' }, { $set: body }, { new: true, runValidators: true });
}

// ───────────── messages ─────────────
export async function submitMessage(body, ip) {
  const s = await getSettings();
  let ref; do { ref = `AK-${Math.floor(10000 + Math.random() * 90000)}`; } while (await ConnectMessage.exists({ ref }));
  const m = await ConnectMessage.create({ ref, ...body, ip });
  const to = (body.reason === 'help' ? s.supportTo : s.helloTo) || config.mail.supportTo;
  const lines = [
    `Reason: ${reasonLabel(m.reason)}`, `From: ${(m.name)} <${(m.email)}>`, `School: ${(m.school)}`,
    ...(m.phone ? [`Mobile: ${(m.phone)}`] : []), ...(m.size ? [`Students: ${(m.size)}`] : []), ...(m.bestTime ? [`Best time for a call: ${(m.bestTime)}`] : []),
    ...(m.message ? [`Message: ${(m.message)}`] : []), `Reference: ${m.ref}`,
  ];
  // the team is told; the sender gets a copy of what they sent (both only when email is set up; the message is kept in any case)
  if (to) sendNotificationEmail(to, { subject: `[Connect ${m.ref}] ${reasonLabel(m.reason)}: ${m.school}`, heading: 'A message from the Connect page', lines, replyTo: m.email });
  sendNotificationEmail(m.email, { subject: `We have your message (${m.ref})`, heading: 'Thank you, we have your message', lines: [`Hello ${(m.name)},`, `We received your message about "${reasonLabel(m.reason)}" and will reply within one working day. Your reference is ${m.ref}.`], footer: 'You got this email because someone used this address on the AtKaksha Connect page. If it was not you, you can ignore it.' });
  return { ref: m.ref };
}
export const listMessages = (status) => ConnectMessage.find(status ? { status } : {}).sort({ createdAt: -1 }).limit(300).lean();
export async function setMessageStatus(id, status, userId) {
  const m = await ConnectMessage.findByIdAndUpdate(id, { $set: { status, handledBy: status === 'handled' ? userId : undefined, handledAt: status === 'handled' ? new Date() : undefined } }, { new: true });
  if (!m) throw notFound('Message not found');
  return m;
}
export async function removeMessage(id) { const m = await ConnectMessage.findByIdAndDelete(id); if (!m) throw notFound('Message not found'); }
export const newMessageCount = () => ConnectMessage.countDocuments({ status: 'new' });
