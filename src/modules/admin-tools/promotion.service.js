import { StudentEnrolment, Student, Section, ClassModel, AcademicYear, User, Session } from '../../models/index.js';
import { notFound, bad, conflict } from '../../core/utils.js';
import { autoAssignForEnrolment } from '../finance/finance.service.js';

const ACTIONS = ['promote', 'retain', 'complete', 'transfer_out', 'withdraw'];
const STATUS = { promote: 'promoted', retain: 'retained', complete: 'completed', transfer_out: 'transferred_out', withdraw: 'withdrawn' };

async function years(tenantId, fromYearId, toYearId) {
  const [from, to] = await Promise.all([AcademicYear.findOne({ _id: fromYearId, tenantId }), AcademicYear.findOne({ _id: toYearId, tenantId })]);
  if (!from || !to) throw notFound('Academic year not found');
  if (String(from._id) === String(to._id)) throw bad('Choose two different academic years');
  if (to.startDate <= from.startDate) throw bad('The target year must start after the source year');
  if (to.status === 'closed') throw conflict('The target academic year is closed');
  return { from, to };
}

/** Preview only: proposes an action + destination for every active student, writes nothing. */
export async function preview(tenantId, { fromYearId, toYearId }) {
  const { from, to } = await years(tenantId, fromYearId, toYearId);
  const [enrols, classes, fromSecs, toSecs] = await Promise.all([
    StudentEnrolment.find({ tenantId, yearId: from._id, status: 'active' }).lean(), ClassModel.find({ tenantId, status: 'active' }).sort({ level: 1 }).lean(),
    Section.find({ tenantId, yearId: from._id }).lean(), Section.find({ tenantId, yearId: to._id, status: 'active' }).lean(),
  ]);
  const students = new Map((await Student.find({ tenantId, _id: { $in: enrols.map((e) => e.studentId) }, status: 'active' }).select('name admissionNo').lean()).map((s) => [String(s._id), s]));
  const CL = new Map(classes.map((c) => [String(c._id), c])); const FS = new Map(fromSecs.map((s) => [String(s._id), s]));
  const used = new Map(); // section -> planned count
  const existing = await StudentEnrolment.aggregate([{ $match: { tenantId, yearId: to._id, status: 'active' } }, { $group: { _id: '$sectionId', n: { $sum: 1 } } }]);
  existing.forEach((e) => used.set(String(e._id), e.n));
  const items = [];
  const sorted = enrols.filter((e) => students.has(String(e.studentId))).sort((a, b) => students.get(String(a.studentId)).name.localeCompare(students.get(String(b.studentId)).name));
  for (const e of sorted) {
    const cur = CL.get(String(e.classId));
    const next = classes.find((c) => c.level > (cur?.level ?? 0));
    const action = next ? 'promote' : 'complete';
    const item = { enrolmentId: e._id, studentId: e.studentId, name: students.get(String(e.studentId)).name, admissionNo: students.get(String(e.studentId)).admissionNo, fromClass: cur?.name, fromSection: FS.get(String(e.sectionId))?.name, action, warnings: [] };
    if (action === 'promote') {
      const candidates = toSecs.filter((s) => String(s.classId) === String(next._id));
      const sameName = candidates.find((s) => s.name === FS.get(String(e.sectionId))?.name && (used.get(String(s._id)) || 0) < s.capacity);
      const pick = sameName || [...candidates].sort((a, b) => (used.get(String(a._id)) || 0) / a.capacity - (used.get(String(b._id)) || 0) / b.capacity).find((s) => (used.get(String(s._id)) || 0) < s.capacity);
      item.toClassId = next._id; item.toClass = next.name;
      if (pick) { item.toSectionId = pick._id; item.toSection = pick.name; used.set(String(pick._id), (used.get(String(pick._id)) || 0) + 1); }
      else item.warnings.push(candidates.length ? `No room in ${next.name} sections` : `No sections created for ${next.name} in ${to.name}`);
    }
    items.push(item);
  }
  return {
    fromYear: { id: from._id, name: from.name }, toYear: { id: to._id, name: to.name }, items, actions: ACTIONS,
    availableSections: toSecs.map((s) => ({ id: s._id, name: s.name, classId: s.classId, className: CL.get(String(s.classId))?.name, capacity: s.capacity, planned: used.get(String(s._id)) || 0 })),
    summary: { total: items.length, promote: items.filter((i) => i.action === 'promote').length, complete: items.filter((i) => i.action === 'complete').length, needsAttention: items.filter((i) => i.warnings.length).length },
  };
}

export async function commit(ctx, { fromYearId, toYearId, items, confirm, closeFromYear, makeCurrent }) {
  if (!confirm) throw bad('Review the preview and confirm the promotion');
  const { tenantId } = ctx;
  const { from, to } = await years(tenantId, fromYearId, toYearId);
  const enrolments = new Map((await StudentEnrolment.find({ tenantId, _id: { $in: items.map((i) => i.enrolmentId) } })).map((e) => [String(e._id), e]));
  const sectionIds = [...new Set(items.map((i) => i.toSectionId).filter(Boolean))];
  const sections = new Map((await Section.find({ tenantId, yearId: to._id, _id: { $in: sectionIds }, status: 'active' })).map((s) => [String(s._id), s]));
  // validate everything before writing anything
  const planned = new Map();
  const bySection = new Map();
  for (const it of items) {
    const e = enrolments.get(String(it.enrolmentId));
    if (!e || String(e.yearId) !== String(from._id)) throw bad('An item does not belong to the source academic year');
    if (!ACTIONS.includes(it.action)) throw bad(`Unknown action ${it.action}`);
    if (e.status !== 'active') throw conflict('A student in the list has already been processed');
    if (it.action === 'promote' || it.action === 'retain') {
      const sec = sections.get(String(it.toSectionId));
      if (!sec) throw bad('A destination section is missing or not in the target year');
      planned.set(String(sec._id), (planned.get(String(sec._id)) || 0) + 1);
      if (!bySection.has(String(sec._id))) bySection.set(String(sec._id), []);
      bySection.get(String(sec._id)).push(it);
    }
  }
  for (const [sid, n] of planned) {
    const sec = sections.get(sid);
    const have = await StudentEnrolment.countDocuments({ tenantId, sectionId: sid, status: 'active' });
    if (have + n > sec.capacity) throw conflict(`Section ${sec.name} would exceed its capacity (${have + n}/${sec.capacity})`);
  }
  const students = new Map((await Student.find({ tenantId, _id: { $in: [...enrolments.values()].map((e) => e.studentId) } }).select('name userId')).map((s) => [String(s._id), s]));
  const result = { promoted: 0, retained: 0, completed: 0, transferredOut: 0, withdrawn: 0 };
  // roll numbers regenerated per destination section, alphabetical, continuing after any existing students
  const rolls = new Map();
  for (const [sid, list] of bySection) {
    const last = await StudentEnrolment.findOne({ tenantId, sectionId: sid, status: 'active' }).sort({ rollNo: -1 }).select('rollNo');
    list.sort((a, b) => (students.get(String(enrolments.get(String(a.enrolmentId)).studentId))?.name || '').localeCompare(students.get(String(enrolments.get(String(b.enrolmentId)).studentId))?.name || ''));
    list.forEach((it, i) => rolls.set(String(it.enrolmentId), (last?.rollNo || 0) + i + 1));
  }
  for (const it of items) {
    const e = enrolments.get(String(it.enrolmentId));
    const stu = students.get(String(e.studentId));
    e.status = STATUS[it.action]; e.endDate = from.endDate;
    await e.save();
    if (it.action === 'promote' || it.action === 'retain') {
      const sec = sections.get(String(it.toSectionId));
      const ne = await StudentEnrolment.create({ tenantId, studentId: e.studentId, yearId: to._id, classId: sec.classId, sectionId: sec._id, rollNo: rolls.get(String(it.enrolmentId)), startDate: to.startDate });
      await autoAssignForEnrolment(tenantId, ne, ctx.actorId).catch(() => 0); // unpaid dues of the old year simply stay open
      result[it.action === 'promote' ? 'promoted' : 'retained']++;
    } else if (it.action === 'complete') { await Student.updateOne({ _id: e.studentId }, { status: 'completed' }); result.completed++; }
    else {
      await Student.updateOne({ _id: e.studentId }, { status: STATUS[it.action] });
      if (stu?.userId) { await User.updateOne({ _id: stu.userId }, { status: 'disabled' }); await Session.updateMany({ userId: stu.userId, revokedAt: null }, { revokedAt: new Date() }); }
      result[it.action === 'withdraw' ? 'withdrawn' : 'transferredOut']++;
    }
  }
  if (makeCurrent) { await AcademicYear.updateMany({ tenantId }, { isCurrent: false }); to.isCurrent = true; to.status = 'active'; await to.save(); }
  if (closeFromYear) { from.status = 'closed'; from.isCurrent = false; await from.save(); }
  return { ...result, fromYear: from.name, toYear: to.name };
}
