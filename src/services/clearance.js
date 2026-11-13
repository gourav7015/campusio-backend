import { LibraryIssue, StudentCharge } from '../models/index.js';
import { round2 } from '../core/utils.js';

/** Before a student/teacher leaves, anything still outstanding (library books, unpaid fees) must be flagged. */
export async function clearanceFor(tenantId, type, id) {
  const loans = await LibraryIssue.find({ tenantId, borrowerType: type, borrowerId: id, status: 'issued' }).populate('bookId', 'title').lean();
  const charges = type === 'student' ? await StudentCharge.find({ tenantId, studentId: id, status: 'open' }).lean() : [];
  const dues = round2(charges.reduce((n, c) => n + (c.amount - (c.concession || 0) - (c.paidAmount || 0)), 0));
  return { openLoans: loans.map((l) => ({ book: l.bookId?.title, dueDate: l.dueDate })), pendingDues: dues, clear: !loans.length && dues <= 0 };
}
