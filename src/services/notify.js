import { Notification, User } from '../models/index.js';

/**
 * Create in-app notifications. dedupeKey makes a repeat call for the same event harmless.
 * (Runs inline; swap for a queue worker when BullMQ/Redis is introduced.)
 */
export async function notifyUsers(tenantId, userIds, { category, title, body, link, dedupeKey }) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (!ids.length) return 0;
  const users = await User.find({ _id: { $in: ids }, tenantId, status: 'active' }).select('notificationPrefs');
  let n = 0;
  for (const u of users) {
    if (u.notificationPrefs && u.notificationPrefs[category] === false) continue;
    try {
      await Notification.create({ tenantId, userId: u._id, category, title, body, link, dedupeKey: dedupeKey ? `${dedupeKey}` : undefined });
      n++;
    } catch (e) {
      if (e.code !== 11000) throw e;
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
