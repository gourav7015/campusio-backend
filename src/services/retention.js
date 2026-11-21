import { Notification, Session, EmailOutbox, ImportBatch } from '../models/index.js';

/**
 * Housekeeping that keeps old personal data from piling up (the schedule is written down in docs/DATA_RETENTION.md):
 *  - read in-app notifications after 180 days, unread after 365
 *  - sent or failed outgoing emails after 14 days (the outbox also expires them itself)
 *  - ended sessions after 30 days (they hold the device and address of a sign-in)
 * Fee, payment, payroll, attendance and marks records are never removed here: the school's accounts and the student's record need them.
 */
export async function runRetention(now = new Date()) {
  const days = (n) => new Date(now.getTime() - n * 24 * 3600 * 1000);
  const [readN, unreadN, mails, sessions] = await Promise.all([
    Notification.deleteMany({ createdAt: { $lt: days(180) }, readAt: { $exists: true, $ne: null } }),
    Notification.deleteMany({ createdAt: { $lt: days(365) } }),
    EmailOutbox.deleteMany({ status: { $in: ['sent', 'failed'] }, createdAt: { $lt: days(14) } }),
    Session.deleteMany({ $or: [{ revokedAt: { $lt: days(30) } }, { expiresAt: { $lt: days(30) } }] }),
  ]);
  const out = { notifications: readN.deletedCount + unreadN.deletedCount, emails: mails.deletedCount, sessions: sessions.deletedCount };
  return Object.values(out).some(Boolean) ? out : null;
}
