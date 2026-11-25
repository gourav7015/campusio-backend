import { forbidden } from '../../core/utils.js';
import { StudentEnrolment, Payment } from '../../models/index.js';

/**
 * The class teacher's view of his own class is the school office's own view: the same read endpoints (insight, students, homework, exam analysis, fees, library),
 * mounted for him under /api/teacher/office. This guard is the whole security of it:
 *  - reads only; nothing can be changed through this door;
 *  - only the listed read endpoints exist here (anything else is refused, whatever the admin API offers);
 *  - and every one of them is checked against the sections this teacher is the CLASS TEACHER of (a subject teacher gets nothing),
 *    through the section in the address, the section in the query, or the section the student or payment belongs to.
 */
const ID = '[a-f0-9]{24}';
const RULES = [
  { re: new RegExp(`^/sections/(${ID})/(insight|students|homework)$`), by: 'section' },
  { re: new RegExp(`^/students/(${ID})(/overview)?$`), by: 'student' },
  { re: new RegExp(`^/analysis/students/(${ID})$`), by: 'student' },
  { re: new RegExp(`^/finance/students/(${ID})/account$`), by: 'student' },
  { re: new RegExp(`^/finance/payments/(${ID})/receipt\\.pdf$`), by: 'payment' },
  { re: /^\/analysis\/exams$/, by: 'query' },
  { re: /^\/library\/class-borrowers$/, by: 'query' },
];

export async function classOfficeGuard(req, _res, next) {
  if (!['GET', 'HEAD'].includes(req.method)) throw forbidden('This view of your class is read-only. Changes are made by the school office, or from your own pages.');
  const mine = req.ctx.scope.classTeacherSectionIds;
  if (!mine.length) throw forbidden('Only the class teacher can see a class this way');
  const rule = RULES.find((r) => r.re.test(req.path));
  if (!rule) throw forbidden('That page is not part of the class view');
  const own = (sectionId) => mine.includes(String(sectionId));
  const m = req.path.match(rule.re);
  let ok = false;
  if (rule.by === 'section') ok = own(m[1]);
  else if (rule.by === 'query') ok = !!req.query.sectionId && !req.query.classId && own(req.query.sectionId);
  else {
    let studentId = m[1];
    if (rule.by === 'payment') studentId = (await Payment.findOne({ _id: m[1], tenantId: req.tenantId }).select('studentId').lean())?.studentId;
    ok = !!studentId && !!(await StudentEnrolment.exists({ tenantId: req.tenantId, studentId, sectionId: { $in: mine }, yearId: req.ctx.year._id }));
  }
  if (!ok) throw forbidden('That is not a student or section of your class');
  next();
}
