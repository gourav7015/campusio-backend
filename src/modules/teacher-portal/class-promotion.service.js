import { Section, ClassModel, AcademicYear, StudentEnrolment, PromotionRequest } from '../../models/index.js';
import { forbidden, bad } from '../../core/utils.js';
import { classSpan } from '../../services/yearSpan.js';
import { classStatus, STATUS_LABEL } from '../promotion/progress.service.js';
import { preview as previewPromotion, commit as commitPromotion } from '../admin-tools/promotion.service.js';
import * as requests from '../promotion/requests.service.js';
import { audit } from '../../services/audit.js';

/**
 * Year-end promotion done by the class teacher, for their own class only, with the office's approval. Classes do not all finish together
 * (Class 12 may end in February and start again in March while Class 7 is still in the old session), so a class teacher tells the office their
 * class is ready ("Session is ending"); once approved they review the students and move the class on. They may promote, repeat the year or
 * complete a student; leaving the school (transfer, withdrawal) stays with the office.
 */
const mine = (ctx, sectionId) => {
  if (!ctx.scope.classTeacherSectionIds.includes(String(sectionId))) throw forbidden('You can move on only the class you are class teacher of');
};

export async function overview(ctx) {
  const ids = ctx.scope.classTeacherSectionIds;
  const [sections, classes, years, reqs] = await Promise.all([
    Section.find({ tenantId: ctx.tenantId, _id: { $in: ids }, yearId: ctx.year._id }).lean(), ClassModel.find({ tenantId: ctx.tenantId }).select('name').lean(),
    AcademicYear.find({ tenantId: ctx.tenantId, startDate: { $gt: ctx.year.startDate }, status: { $ne: 'closed' } }).sort({ startDate: 1 }).lean(),
    requests.forTeacher(ctx, ids),
  ]);
  const CL = new Map(classes.map((c) => [String(c._id), c.name]));
  const counts = await StudentEnrolment.aggregate([{ $match: { tenantId: ctx.tenantId, sectionId: { $in: sections.map((s) => s._id) }, yearId: ctx.year._id } }, { $group: { _id: { s: '$sectionId', st: '$status' }, n: { $sum: 1 } } }]);
  const n = (sid, st) => counts.filter((c) => String(c._id.s) === String(sid) && st.includes(c._id.st)).reduce((a, c) => a + c.n, 0);
  return {
    year: { id: ctx.year._id, name: ctx.year.name }, toYears: years.map((y) => ({ id: y._id, name: y.name, startDate: y.startDate })),
    sections: sections.map((s) => {
      const span = classSpan(ctx.year, s.classId);
      const waiting = n(s._id, ['active']); const moved = n(s._id, ['promoted', 'retained', 'completed']);
      const mineReqs = reqs.filter((r) => String(r.sectionId) === String(s._id));
      const open = mineReqs.find((r) => r.open); const last = open || mineReqs[0];
      const status = classStatus({ year: ctx.year, span, today: ctx.today, waiting, moved, openRequest: !!open });
      // canAsk does not depend on the next year existing: the page says when it has not been set up instead of hiding the button
      return {
        id: s.id || s._id, name: `${CL.get(String(s.classId)) || ''} ${s.name}`.trim(), endDate: span.endDate, ended: span.endDate < ctx.today, waiting, moved,
        status, statusLabel: STATUS_LABEL[status], request: last ? requests.shape(last) : null,
        canAsk: !open && waiting > 0, canMove: open?.status === 'approved' && waiting > 0,
      };
    }),
  };
}

/** The approved request that lets this teacher move this class into this year. */
async function approved(ctx, sectionId, toYearId) {
  const r = await PromotionRequest.findOne({ tenantId: ctx.tenantId, sectionId, yearId: ctx.year._id, open: true }).lean();
  if (!r || r.status !== 'approved') throw bad(r ? 'Your request is still waiting for the office to approve it' : 'Tell the office this class is ready first: use "Session is ending, ask the office"');
  if (String(r.toYearId) !== String(toYearId)) throw bad('The office approved moving this class into a different academic year');
  return r;
}

export async function ask(ctx, body) { mine(ctx, body.sectionId); return requests.shape(await requests.create(ctx, body)); }
export const withdraw = async (ctx, id) => requests.shape(await requests.withdraw(ctx, id));

export async function preview(ctx, { sectionId, toYearId }) {
  mine(ctx, sectionId);
  await approved(ctx, sectionId, toYearId);
  return previewPromotion(ctx.tenantId, { fromYearId: ctx.year._id, toYearId, sectionIds: [sectionId] }, ctx.today);
}

export async function commit(req, { sectionId, toYearId, items }) {
  const ctx = req.ctx;
  mine(ctx, sectionId);
  await approved(ctx, sectionId, toYearId);
  const section = await Section.findById(sectionId).select('name').lean();
  // every student named must be in this class, still waiting
  const own = new Set((await StudentEnrolment.find({ tenantId: ctx.tenantId, sectionId, yearId: ctx.year._id, status: 'active' }).select('_id').lean()).map((e) => String(e._id)));
  if (items.some((i) => !own.has(i.enrolmentId))) throw bad('A student in the list is not in your class, or has already been moved on');
  const out = await commitPromotion(ctx, { fromYearId: ctx.year._id, toYearId, items, confirm: true, closeFromYear: false, makeCurrent: false, acknowledgeGaps: true }) // the office approved the move knowing what the next year has set up;
  await audit(req, 'promotion.class_teacher', 'Section', sectionId, `Class teacher moved on ${items.length} students of ${section?.name || 'a class'} into ${out.toYear} (${out.promoted} promoted, ${out.retained} repeating, ${out.completed} completed)`);
  return out;
}
