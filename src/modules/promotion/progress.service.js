import { StudentEnrolment, Section, ClassModel, AcademicYear } from '../../models/index.js';
import { classSpan } from '../../services/yearSpan.js';
import { notFound } from '../../core/utils.js';

/**
 * Where each class is in an academic year. The status is worked out from the class's dates, its students and any open request, never stored,
 * so it cannot drift from what is really in the records:
 *   upcoming               the class's session has not begun
 *   active                 running (also after its end date, until it is moved on: see `sessionEnded`)
 *   promotion_in_progress  some students have moved on and some are still waiting
 *   completed              every student has been moved on (or finished school)
 *   archived               the academic year is closed (read-only history)
 * A class moves as a whole (all its sections together), so "promotion in progress" only shows when some of its students were put back or held behind.
 * One class's status never depends on another class.
 */
export const STATUS_LABEL = { upcoming: 'Upcoming', active: 'Active', promotion_in_progress: 'Promotion in progress', completed: 'Completed', archived: 'Archived' };
const MOVED = ['promoted', 'retained', 'completed'];

export function classStatus({ year, span, today, waiting, moved }) {
  if (year.status === 'closed') return 'archived';
  if (moved > 0 && waiting > 0) return 'promotion_in_progress';
  if (waiting === 0 && moved > 0) return 'completed';
  if (today < span.startDate) return 'upcoming';
  return 'active';
}

/** Every class that has sections or students in the year, with its status, dates, head-count and the sections' open requests. */
export async function classProgress(tenantId, yearId, today, { classIds } = {}) {
  const year = await AcademicYear.findOne({ _id: yearId, tenantId });
  if (!year) throw notFound('Academic year not found');
  const [classes, sections, counts] = await Promise.all([
    ClassModel.find({ tenantId, status: 'active', ...(classIds?.length ? { _id: { $in: classIds } } : {}) }).sort({ level: 1 }).lean(),
    Section.find({ tenantId, yearId }).lean(),
    StudentEnrolment.aggregate([{ $match: { tenantId, yearId: year._id } }, { $group: { _id: { s: '$sectionId', st: '$status' }, n: { $sum: 1 } } }]),
  ]);
  const n = (sid, sts) => counts.filter((c) => String(c._id.s) === String(sid) && sts.includes(c._id.st)).reduce((a, c) => a + c.n, 0);
  const rows = [];
  for (const c of classes) {
    const secs = sections.filter((s) => String(s.classId) === String(c._id));
    if (!secs.length) continue;
    const span = classSpan(year, c._id);
    const sectionRows = secs.map((s) => ({ id: s._id, name: s.name, waiting: n(s._id, ['active']), moved: n(s._id, MOVED) }));
    const waiting = sectionRows.reduce((a, s) => a + s.waiting, 0); const moved = sectionRows.reduce((a, s) => a + s.moved, 0);
    const status = classStatus({ year, span, today, waiting, moved });
    rows.push({ classId: c._id, className: c.name, level: c.level, status, statusLabel: STATUS_LABEL[status], startDate: span.startDate, endDate: span.endDate, ownDates: span.custom, sessionEnded: span.endDate < today, waiting, moved, sections: sectionRows });
  }
  return { year: { id: year._id, name: year.name, status: year.status, isCurrent: year.isCurrent, startDate: year.startDate, endDate: year.endDate }, classes: rows };
}

/** Whether any student is still active in the year: a year may be closed only when none is. */
export const activeInYear = (tenantId, yearId) => StudentEnrolment.countDocuments({ tenantId, yearId, status: 'active' });
