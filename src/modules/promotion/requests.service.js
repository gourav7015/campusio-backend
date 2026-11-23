import { PromotionRequest, Section, ClassModel, AcademicYear, StudentEnrolment, User, Teacher } from '../../models/index.js';
import { classReadiness } from '../structure/class-structure.service.js';
import { nextClassFor } from '../admin-tools/promotion.service.js';
import { notFound, bad, conflict, forbidden } from '../../core/utils.js';
import { notifyUsers } from '../../services/notify.js';

/**
 * A class teacher asks the office to let their class move into the next academic year; the office approves (which lets the teacher do the
 * move), rejects, or moves the class itself. The request is the approval step, so no class changes year on its own.
 */
const OPEN = { open: true };
const fresh = (r) => ({ id: r._id, status: r.status, label: r.label, note: r.note, waiting: r.waiting, requestedByName: r.requestedByName, createdAt: r.createdAt, decidedByName: r.decidedByName, decidedAt: r.decidedAt, decisionNote: r.decisionNote, toYearId: r.toYearId, sectionId: r.sectionId, yearId: r.yearId });
export const shape = fresh;

/** The people who decide: every full School Admin, and sub-admins who were given Approvals. */
async function deciders(tenantId) {
  const admins = await User.find({ tenantId, role: 'school_admin', status: 'active' }).select('_id adminLevel permissions').lean();
  return admins.filter((u) => u.adminLevel !== 'sub' || (u.permissions || []).includes('approvals')).map((u) => u._id);
}

export async function create(ctx, { sectionId, toYearId, note }) {
  if (!ctx.scope.classTeacherSectionIds.includes(String(sectionId))) throw forbidden('You can ask only for the class you are class teacher of');
  const [section, to] = await Promise.all([Section.findOne({ _id: sectionId, tenantId: ctx.tenantId, yearId: ctx.year._id }).lean(), AcademicYear.findOne({ _id: toYearId, tenantId: ctx.tenantId })]);
  if (!section) throw notFound('That class is not in this academic year');
  if (!to || to.startDate <= ctx.year.startDate || to.status === 'closed') throw bad('Choose a later academic year that is not closed');
  const waiting = await StudentEnrolment.countDocuments({ tenantId: ctx.tenantId, sectionId, yearId: ctx.year._id, status: 'active' });
  if (!waiting) throw bad('Nobody is waiting in this class');
  const cls = await ClassModel.findById(section.classId).select('name').lean();
  const label = `${cls?.name || ''} ${section.name}`.trim();
  let r;
  try {
    r = await PromotionRequest.create({ tenantId: ctx.tenantId, yearId: ctx.year._id, toYearId: to._id, sectionId, classId: section.classId, label, teacherId: ctx.teacher._id, requestedBy: ctx.actorId, requestedByName: ctx.teacher.name, note: note || undefined, waiting });
  } catch (e) { if (e.code === 11000) throw conflict('There is already an open request for this class'); throw e; }
  await notifyUsers(ctx.tenantId, await deciders(ctx.tenantId), { category: 'approvals', title: `${label} is ready to move to ${to.name}`, body: `${ctx.teacher.name} (class teacher) asks to move ${waiting} students.${note ? ` Note: ${note}` : ''}`, link: { type: 'promotion', id: String(r._id) }, dedupeKey: `promo:${r._id}:asked` });
  return r;
}

export async function withdraw(ctx, id) {
  const r = await PromotionRequest.findOneAndUpdate({ _id: id, tenantId: ctx.tenantId, teacherId: ctx.teacher._id, status: 'pending' }, { status: 'withdrawn', open: false }, { new: true });
  if (!r) throw notFound('There is no waiting request of yours to withdraw');
  return r;
}

export const forTeacher = (ctx, sectionIds) => PromotionRequest.find({ tenantId: ctx.tenantId, yearId: ctx.year._id, sectionId: { $in: sectionIds } }).sort({ createdAt: -1 }).lean();

/** The office's list: waiting requests first, then the latest decisions. Each says where the class goes and whether the next year is set up for it. */
export async function listForOffice(tenantId, { status } = {}) {
  const rows = await PromotionRequest.find({ tenantId, ...(status === 'open' ? OPEN : status ? { status } : {}) }).sort({ createdAt: -1 }).limit(200).lean();
  const years = new Map((await AcademicYear.find({ tenantId, _id: { $in: rows.flatMap((r) => [r.yearId, r.toYearId]) } }).select('name').lean()).map((y) => [String(y._id), y.name]));
  const classes = await ClassModel.find({ tenantId, status: 'active' }).lean();
  const out = [];
  for (const r of rows) {
    const cur = classes.find((c) => String(c._id) === String(r.classId));
    const { next } = nextClassFor(classes, cur);
    let destination = { finishes: true };
    if (next) {
      const [ready] = await classReadiness(tenantId, r.toYearId, [next._id]);
      destination = ready ? { className: next.name, ready: ready.ready, noClassTeacher: ready.noClassTeacher, noTeacher: ready.noTeacher, noSubjects: ready.noSubjects } : { className: next.name, ready: false, noSections: true };
    }
    out.push({ ...fresh(r), fromYear: years.get(String(r.yearId)), toYear: years.get(String(r.toYearId)), destination });
  }
  return out;
}

export async function pendingCount(tenantId) { return PromotionRequest.countDocuments({ tenantId, status: 'pending' }); }

export async function decide(ctx, id, { approve, note }, user) {
  const r = await PromotionRequest.findOneAndUpdate({ _id: id, tenantId: ctx.tenantId, status: 'pending' }, { status: approve ? 'approved' : 'rejected', open: !!approve, decidedBy: user._id, decidedByName: user.name, decidedAt: new Date(), decisionNote: note || undefined }, { new: true });
  if (!r) throw conflict('This request has already been decided, withdrawn, or the class was moved by the office');
  const t = await Teacher.findById(r.teacherId).select('userId').lean();
  await notifyUsers(ctx.tenantId, [t?.userId], { category: 'approvals', title: approve ? `${r.label}: you can move your class on` : `${r.label}: request not approved`, body: approve ? 'The office approved it. Open "Move my class on" to review the students and confirm.' : `The office did not approve it${note ? `: ${note}` : '.'}`, link: { type: 'promotion', id: String(r._id) }, dedupeKey: `promo:${r._id}:${approve ? 'yes' : 'no'}` });
  return r;
}

/** After students have been moved: a request closes once nobody is left waiting in its class (whoever did the move). */
export async function settle(tenantId, sectionIds) {
  const ids = [...new Set(sectionIds.map(String))];
  if (!ids.length) return;
  const open = await PromotionRequest.find({ tenantId, sectionId: { $in: ids }, ...OPEN }).lean();
  for (const r of open) {
    const left = await StudentEnrolment.countDocuments({ tenantId, sectionId: r.sectionId, yearId: r.yearId, status: 'active' });
    if (!left) await PromotionRequest.updateOne({ _id: r._id, ...OPEN }, { status: 'completed', open: false, completedAt: new Date() });
  }
}
