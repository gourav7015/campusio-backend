import { StudentEnrolment, Student, Section, ClassModel, AcademicYear, User, Session } from '../../models/index.js';
import { notFound, bad, conflict } from '../../core/utils.js';
import { autoAssignForEnrolment } from '../finance/finance.service.js';
import { classSpan } from '../../services/yearSpan.js';
import { classProgress, activeInYear } from '../promotion/progress.service.js';
import { classStructure, classReadiness, sectionGaps } from '../structure/class-structure.service.js';

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

/** The class a student moves up into: the next level; in Classes 11 and 12 the same stream. From the stream-less Class 10 a stream is chosen (plain Class 11 if the school has none). */
export function nextClassFor(classes, cur) {
  const nextLevel = classes.map((c) => c.level).filter((l) => l > (cur?.level ?? 0)).sort((a, b) => a - b)[0];
  const atNext = classes.filter((c) => c.level === nextLevel);
  const next = (cur?.stream && atNext.find((c) => c.stream === cur.stream)) || atNext.find((c) => !c.stream) || atNext[0];
  return { next, atNext, needsStream: !!next && !cur?.stream && atNext.length > 1 && !atNext.some((c) => !c.stream) };
}

/** Preview only: proposes an action + destination for every active student, writes nothing. */
export async function preview(tenantId, { fromYearId, toYearId, classIds }, today = new Date().toISOString().slice(0, 10)) {
  const { from, to } = await years(tenantId, fromYearId, toYearId);
  const progress = await classProgress(tenantId, from._id, today);
  const chosen = new Set((classIds || []).map(String));
  const [enrols, classes, fromSecs, toSecs] = await Promise.all([
    StudentEnrolment.find({ tenantId, yearId: from._id, status: 'active', ...(chosen.size ? { classId: { $in: [...chosen] } } : {}) }).lean(), ClassModel.find({ tenantId, status: 'active' }).sort({ level: 1 }).lean(),
    Section.find({ tenantId, yearId: from._id }).lean(), Section.find({ tenantId, yearId: to._id, status: 'active' }).lean(),
  ]);
  const students = new Map((await Student.find({ tenantId, _id: { $in: enrols.map((e) => e.studentId) }, status: 'active' }).select('name admissionNo').lean()).map((s) => [String(s._id), s]));
  const CL = new Map(classes.map((c) => [String(c._id), c])); const FS = new Map(fromSecs.map((s) => [String(s._id), s]));
  const used = new Map(); // section -> planned count
  const existing = await StudentEnrolment.aggregate([{ $match: { tenantId, yearId: to._id, status: 'active' } }, { $group: { _id: '$sectionId', n: { $sum: 1 } } }]);
  existing.forEach((e) => used.set(String(e._id), e.n));
  const CT = new Map((await classStructure(tenantId, to._id)).classes.flatMap((c) => c.sections.map((x) => [String(x.id), x.classTeacher?.name])));
  const items = [];
  const sorted = enrols.filter((e) => students.has(String(e.studentId))).sort((a, b) => students.get(String(a.studentId)).name.localeCompare(students.get(String(b.studentId)).name));
  for (const e of sorted) {
    const cur = CL.get(String(e.classId));
    const { next, needsStream } = nextClassFor(classes, cur);
    const action = next ? 'promote' : 'complete';
    const span = classSpan(from, e.classId);
    const item = { classId: e.classId, sessionEnds: span.endDate, notices: span.endDate >= today ? [`This class's session runs to ${span.endDate}`] : [], enrolmentId: e._id, studentId: e.studentId, name: students.get(String(e.studentId)).name, admissionNo: students.get(String(e.studentId)).admissionNo, fromClass: cur?.name, fromSection: FS.get(String(e.sectionId))?.name, action, warnings: [] };
    if (action === 'promote') {
      const candidates = toSecs.filter((s) => String(s.classId) === String(next._id));
      const sameName = candidates.find((s) => s.name === FS.get(String(e.sectionId))?.name && (used.get(String(s._id)) || 0) < s.capacity);
      const pick = sameName || [...candidates].sort((a, b) => (used.get(String(a._id)) || 0) / a.capacity - (used.get(String(b._id)) || 0) / b.capacity).find((s) => (used.get(String(s._id)) || 0) < s.capacity);
      item.toClassId = next._id; item.toClass = next.name;
      if (needsStream) item.warnings.push('Choose this student\'s stream: Medical, Non-Medical, Commerce or Arts (pick the section)');
      if (pick) { item.toSectionId = pick._id; item.toSection = pick.name; used.set(String(pick._id), (used.get(String(pick._id)) || 0) + 1); }
      else item.warnings.push(candidates.length ? `No room in ${next.name} sections` : `No sections created for ${next.name} in ${to.name}`);
    }
    items.push(item);
  }
  return {
    fromYear: { id: from._id, name: from.name }, toYear: { id: to._id, name: to.name }, items, actions: ACTIONS,
    availableSections: toSecs.map((s) => ({ id: s._id, name: s.name, classId: s.classId, className: CL.get(String(s.classId))?.name, capacity: s.capacity, planned: used.get(String(s._id)) || 0, classTeacher: CT.get(String(s._id)) || null, yearName: to.name })),
    // is the next year set up for the classes students are going into: sections, subjects, class teachers, subject teachers
    readiness: await classReadiness(tenantId, to._id, [...new Set([...items.map((i) => i.toClassId), ...items.map((i) => i.classId)].filter(Boolean).map(String))]),
    // every class of the source year and where it stands, so it is clear which classes are in this promotion and which are left alone
    classes: progress.classes.map((c) => ({ classId: c.classId, className: c.className, status: c.status, statusLabel: c.statusLabel, endDate: c.endDate, sessionEnded: c.sessionEnded, waiting: c.waiting, moved: c.moved, inScope: (!chosen.size || chosen.has(String(c.classId))) && c.waiting > 0 })),
    summary: { total: items.length, promote: items.filter((i) => i.action === 'promote').length, complete: items.filter((i) => i.action === 'complete').length, needsAttention: items.filter((i) => i.warnings.length).length },
  };
}

export async function commit(ctx, { fromYearId, toYearId, items, confirm, closeFromYear, makeCurrent, acknowledgeGaps }) {
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
  // a class moves as a whole, all its sections together: everyone still in it (moved up, kept back, finishing school, leaving) must be in this promotion
  const perClass = new Map();
  for (const it of items) { const k = String(enrolments.get(String(it.enrolmentId)).classId); perClass.set(k, (perClass.get(k) || 0) + 1); }
  for (const [classId, n] of perClass) {
    const stillIn = await StudentEnrolment.countDocuments({ tenantId, yearId: from._id, classId, status: 'active' });
    if (n !== stillIn) {
      const cls = await ClassModel.findById(classId).select('name').lean();
      throw conflict(`${cls?.name || 'A class'} moves as a whole class, with all its sections together. ${stillIn - n} of its ${stillIn} students are missing from this promotion.`);
    }
  }
  // students are moved into sections that have their class teacher and subject teachers; if the next year is not set up yet, the office has to say so on purpose
  if (!acknowledgeGaps) {
    const gaps = await sectionGaps(tenantId, to._id, [...sections.keys()]);
    if (gaps.length) throw conflict(`The next year is not fully set up for ${gaps.length} of the sections students are going into (${gaps.slice(0, 3).map((g) => `${g.section}: ${[g.noClassTeacher && 'no class teacher', g.subjectsWithoutTeacher.length && `no teacher for ${g.subjectsWithoutTeacher.join(', ')}`, g.noSubjects && 'no subjects'].filter(Boolean).join(', ')}`).join('; ')}${gaps.length > 3 ? '…' : ''}). Assign them on Subjects and teachers, or confirm to promote anyway.`, { code: 'NOT_READY', gaps });
  }
  // a year may be closed only when nobody is left in it: classes that have not moved on are still running
  if (closeFromYear) { const waiting = await activeInYear(tenantId, from._id); if (waiting > items.length) throw conflict(`${waiting - items.length} students of ${from.name} are still in classes that have not moved on, so ${from.name} cannot be closed yet`); }
  // claim every student atomically first, so the same enrolment cannot be moved twice (two people, or a repeated click); undone if any of it fails
  const claimed = [];
  const undo = async () => { if (claimed.length) await StudentEnrolment.updateMany({ _id: { $in: claimed }, tenantId }, { status: 'active', $unset: { endDate: 1 } }); };
  for (const it of items) {
    const e = enrolments.get(String(it.enrolmentId));
    const span = classSpan(from, e.classId); // the old record ends when its class's session ended (or today, if it is moved early), not at the school-wide year end
    const r = await StudentEnrolment.updateOne({ _id: e._id, tenantId, status: 'active' }, { status: STATUS[it.action], endDate: span.endDate < ctx.today ? span.endDate : ctx.today });
    if (!r.modifiedCount) { await undo(); throw conflict('A student in the list has already been processed'); }
    claimed.push(e._id);
  }
  const created = [];
  try {
  for (const it of items) {
    const e = enrolments.get(String(it.enrolmentId));
    const stu = students.get(String(e.studentId));
    if (it.action === 'promote' || it.action === 'retain') {
      const sec = sections.get(String(it.toSectionId));
      const ne = await StudentEnrolment.create({ tenantId, studentId: e.studentId, yearId: to._id, classId: sec.classId, sectionId: sec._id, rollNo: rolls.get(String(it.enrolmentId)), startDate: to.startDate });
      created.push(ne._id);
      await autoAssignForEnrolment(tenantId, ne, ctx.actorId).catch(() => 0); // unpaid dues of the old year simply stay open
      result[it.action === 'promote' ? 'promoted' : 'retained']++;
    } else if (it.action === 'complete') { await Student.updateOne({ _id: e.studentId }, { status: 'completed' }); result.completed++; }
    else {
      await Student.updateOne({ _id: e.studentId }, { status: STATUS[it.action] });
      if (stu?.userId) { await User.updateOne({ _id: stu.userId }, { status: 'disabled' }); await Session.updateMany({ userId: stu.userId, revokedAt: null }, { revokedAt: new Date() }); }
      result[it.action === 'withdraw' ? 'withdrawn' : 'transferredOut']++;
    }
  }
  } catch (err) { await StudentEnrolment.deleteMany({ _id: { $in: created }, tenantId }); await undo(); throw err; }
  if (makeCurrent) { await AcademicYear.updateMany({ tenantId }, { isCurrent: false }); to.isCurrent = true; to.status = 'active'; await to.save(); }
  if (closeFromYear) { from.status = 'closed'; from.isCurrent = false; await from.save(); }
  return { ...result, fromYear: from.name, toYear: to.name };
}
