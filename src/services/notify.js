import { Notification, User } from '../models/index.js';
import { config } from '../core/config.js';
import { isEmailEnabled, sendNotificationEmail } from './email.js';

/**
 * Create in-app notifications. dedupeKey makes a repeat call for the same event harmless.
 * The in-app notification is the source of truth; when email is set up, people with an address on file also get it by email
 * (only for the categories in config.mail.categories, and never if they switched email, or that category, off).
 * (Runs inline; swap for a queue worker when BullMQ/Redis is introduced.)
 */
export async function notifyUsers(tenantId, userIds, { category, title, body, link, dedupeKey }) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (!ids.length) return 0;
  const users = await User.find({ _id: { $in: ids }, tenantId, status: 'active' }).select('notificationPrefs email name');
  const mail = isEmailEnabled() && config.mail.categories.has(category);
  let n = 0;
  for (const u of users) {
    if (u.notificationPrefs && u.notificationPrefs[category] === false) continue;
    try {
      await Notification.create({ tenantId, userId: u._id, category, title, body, link, dedupeKey: dedupeKey ? `${dedupeKey}` : undefined });
      n++;
    } catch (e) {
      if (e.code !== 11000) throw e;
      continue; // already notified for this event: no second email either
    }
    if (mail && u.email && u.notificationPrefs?.email !== false) {
      sendNotificationEmail(u.email, {
        subject: title, heading: title, lines: [body || ''].filter(Boolean),
        button: { label: 'Open AtKaksha', url: config.mail.appUrl },
        footer: 'You get this email because of a notification in your AtKaksha account.',
      });
    }
  }
  return n;
}

import { StudentEnrolment, Student } from '../models/index.js';
/** User ids of students currently enrolled (active) in the given sections. */
export async function studentUserIdsInSections(tenantId, sectionIds) {
  const enr = await StudentEnrolment.find({ tenantId, sectionId: { $in: sectionIds }, status: 'active' }).select('studentId');
  const students = await Student.find({ tenantId, _id: { $in: enr.map((e) => e.studentId) } }).select('userId');
  return students.map((s) => s.userId).filter(Boolean);
}
