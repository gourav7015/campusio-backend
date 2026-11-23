import { StudentEnrolment, Student, StudentCharge, AttendanceRecord, ReportCard, Marks, User } from '../../models/index.js';
import { notFound, conflict, bad } from '../../core/utils.js';

/**
 * Correct a wrong move: put one student back in the class they were moved from. Allowed only while nothing has been recorded for them in
 * the new year (no attendance, no report card, nothing paid), so no history is lost or rewritten. The student is then waiting in their old class
 * again and can be moved properly. Leaving the school (transfer, withdrawal) is reinstated from the student's own page, not here.
 */
export async function undoMove(ctx, enrolmentId) {
  const { tenantId } = ctx;
  const old = await StudentEnrolment.findOne({ _id: enrolmentId, tenantId });
  if (!old) throw notFound('Enrolment not found');
  if (!['promoted', 'retained', 'completed'].includes(old.status)) throw bad('Only a student who was moved up, kept back or finished school can be put back');
  const student = await Student.findOne({ _id: old.studentId, tenantId });
  const next = old.status === 'completed' ? null : await StudentEnrolment.findOne({ tenantId, studentId: old.studentId, status: 'active', startDate: { $gte: old.startDate }, yearId: { $ne: old.yearId } }).sort({ startDate: 1 });
  if (old.status !== 'completed' && !next) throw conflict('The student has already moved again, or left the school: nothing to put back');
  if (await StudentEnrolment.exists({ tenantId, studentId: old.studentId, yearId: old.yearId, status: 'active' })) throw conflict('The student is already active in that year');
  if (next) {
    const [att, cards, paid, marked] = await Promise.all([
      AttendanceRecord.exists({ tenantId, studentId: old.studentId, yearId: next.yearId }), ReportCard.exists({ tenantId, studentId: old.studentId, yearId: next.yearId }),
      StudentCharge.exists({ tenantId, studentId: old.studentId, yearId: next.yearId, paidAmount: { $gt: 0 } }), Marks.exists({ tenantId, enrolmentId: next._id }),
    ]);
    if (att || cards || paid || marked) throw conflict('Something has already been recorded for this student in the new year (attendance, marks, a report card or a payment), so the move cannot be undone here');
    // the bills made for the new year are removed with the new enrolment; nothing in them was paid
    await StudentCharge.deleteMany({ tenantId, studentId: old.studentId, yearId: next.yearId, paidAmount: { $not: { $gt: 0 } } });
    await StudentEnrolment.deleteOne({ _id: next._id, tenantId });
  }
  old.status = 'active'; old.endDate = undefined; await old.save();
  if (student && student.status === 'completed') { student.status = 'active'; await student.save(); if (student.userId) await User.updateOne({ _id: student.userId, status: 'disabled' }, { status: 'active' }); }
  return { studentId: old.studentId, name: student?.name, enrolmentId: old._id };
}
