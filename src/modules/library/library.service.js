import {
  Book, BookCopy, LibraryIssue, Student, Teacher, StudentEnrolment, Section, ClassModel, StudentCharge, School,
} from '../../models/index.js';
import { notFound, conflict, bad, daysBetween, addDays, escapeRegex, toCsv, round2, eachDate } from '../../core/utils.js';
import { nextSeq, settingsOf, loadSchool } from '../../services/context.js';
import { notifyUsers } from '../../services/notify.js';

const mk = (a) => new Map(a.map((x) => [String(x._id), x]));
export const rulesOf = (settings) => settings.library;

// ───────────── catalog ─────────────
async function newAccessionNos(tenantId, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`LB${String(await nextSeq(tenantId, 'accession')).padStart(5, '0')}`);
  return out;
}

export async function createBook(ctx, { copies, ...body }) {
  if (body.isbn && (await Book.exists({ tenantId: ctx.tenantId, isbn: body.isbn, status: 'active' }))) throw conflict(`A book with ISBN ${body.isbn} already exists. Add copies to it instead.`);
  const book = await Book.create({ ...body, tenantId: ctx.tenantId });
  const nos = await newAccessionNos(ctx.tenantId, copies);
  await BookCopy.insertMany(nos.map((accessionNo) => ({ tenantId: ctx.tenantId, bookId: book._id, accessionNo })));
  return { book, accessionNos: nos };
}

export async function addCopies(ctx, bookId, count) {
  const book = await Book.findOne({ _id: bookId, tenantId: ctx.tenantId });
  if (!book) throw notFound('Book not found');
  if (book.status !== 'active') throw conflict('This book is archived');
  const nos = await newAccessionNos(ctx.tenantId, count);
  await BookCopy.insertMany(nos.map((accessionNo) => ({ tenantId: ctx.tenantId, bookId: book._id, accessionNo })));
  return nos;
}

export async function updateBook(ctx, id, body) {
  const b = await Book.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!b) throw notFound('Book not found');
  if (body.status === 'archived' && (await LibraryIssue.exists({ tenantId: ctx.tenantId, bookId: b._id, status: 'issued' }))) throw conflict('Copies of this book are on loan. Archive it after they are returned.');
  Object.assign(b, body);
  return b.save();
}

export async function setCopyStatus(ctx, copyId, { status, notes }) {
  const c = await BookCopy.findOne({ _id: copyId, tenantId: ctx.tenantId });
  if (!c) throw notFound('Copy not found');
  if (c.status === 'issued') throw conflict('This copy is on loan. Return it first.');
  c.status = status; if (notes !== undefined) c.notes = notes;
  return c.save();
}

export async function listBooks(tenantId, q) {
  const f = { tenantId, status: 'active' };
  if (q.category) f.category = q.category;
  if (q.q) { const rx = new RegExp(escapeRegex(q.q), 'i'); f.$or = [{ title: rx }, { author: rx }, { isbn: rx }, { category: rx }]; }
  const copyAgg = await BookCopy.aggregate([{ $match: { tenantId } }, { $group: { _id: '$bookId', total: { $sum: { $cond: [{ $eq: ['$status', 'withdrawn'] }, 0, 1] } }, available: { $sum: { $cond: [{ $eq: ['$status', 'available'] }, 1, 0] } }, issued: { $sum: { $cond: [{ $eq: ['$status', 'issued'] }, 1, 0] } } } }]);
  const C = new Map(copyAgg.map((c) => [String(c._id), c]));
  let books = await Book.find(f).sort({ title: 1 }).lean();
  books = books.map((b) => ({ ...b, total: C.get(String(b._id))?.total || 0, available: C.get(String(b._id))?.available || 0, issued: C.get(String(b._id))?.issued || 0 }));
  if (q.availability === 'available') books = books.filter((b) => b.available > 0);
  return { total: books.length, items: books.slice((q.page - 1) * q.limit, q.page * q.limit), categories: (await Book.distinct('category', { tenantId, status: 'active' })).filter(Boolean).sort() };
}

export async function getBook(ctx, id) {
  const book = await Book.findOne({ _id: id, tenantId: ctx.tenantId }).lean();
  if (!book) throw notFound('Book not found');
  const [copies, open, history] = await Promise.all([
    BookCopy.find({ tenantId: ctx.tenantId, bookId: id }).sort({ accessionNo: 1 }).lean(),
    LibraryIssue.find({ tenantId: ctx.tenantId, bookId: id, status: 'issued' }).lean(), LibraryIssue.find({ tenantId: ctx.tenantId, bookId: id }).sort({ createdAt: -1 }).limit(30).lean(),
  ]);
  const names = await borrowerNames(ctx.tenantId, [...open, ...history]);
  const byCopy = new Map(open.map((o) => [String(o.copyId), o]));
  return { ...book, copies: copies.map((c) => ({ ...c, loan: byCopy.get(String(c._id)) && { borrower: names.get(String(byCopy.get(String(c._id)).borrowerId)), dueDate: byCopy.get(String(c._id)).dueDate } })), history: history.map((h) => ({ ...h, borrower: names.get(String(h.borrowerId)) })) };
}

async function borrowerNames(tenantId, issues) {
  const sIds = issues.filter((i) => i.borrowerType === 'student').map((i) => i.borrowerId); const tIds = issues.filter((i) => i.borrowerType === 'teacher').map((i) => i.borrowerId);
  const [s, t] = await Promise.all([Student.find({ tenantId, _id: { $in: sIds } }).select('name admissionNo').lean(), Teacher.find({ tenantId, _id: { $in: tIds } }).select('name employeeId').lean()]);
  const m = new Map();
  s.forEach((x) => m.set(String(x._id), `${x.name} (${x.admissionNo})`)); t.forEach((x) => m.set(String(x._id), `${x.name} (${x.employeeId})`));
  return m;
}

// ───────────── borrowers ─────────────
export async function searchBorrowers(ctx, { type, q }) {
  const rx = new RegExp(escapeRegex(q), 'i');
  let people = [];
  if (type === 'student') {
    const students = await Student.find({ tenantId: ctx.tenantId, status: 'active', $or: [{ name: rx }, { admissionNo: rx }] }).select('name admissionNo').limit(15).lean();
    const enr = await StudentEnrolment.find({ tenantId: ctx.tenantId, studentId: { $in: students.map((s) => s._id) }, status: 'active' }).lean();
    const [secs, classes] = await Promise.all([Section.find({ tenantId: ctx.tenantId, _id: { $in: enr.map((e) => e.sectionId) } }).lean(), ClassModel.find({ tenantId: ctx.tenantId }).lean()]);
    const S = mk(secs); const C = mk(classes); const E = new Map(enr.map((e) => [String(e.studentId), e]));
    people = students.map((s) => ({ id: s._id, type, name: s.name, code: s.admissionNo, detail: E.get(String(s._id)) ? `${C.get(String(E.get(String(s._id)).classId))?.name} ${S.get(String(E.get(String(s._id)).sectionId))?.name}` : '' }));
  } else {
    const teachers = await Teacher.find({ tenantId: ctx.tenantId, status: 'active', $or: [{ name: rx }, { employeeId: rx }] }).select('name employeeId designation').limit(15).lean();
    people = teachers.map((t) => ({ id: t._id, type, name: t.name, code: t.employeeId, detail: t.designation || 'Teacher' }));
  }
  const loans = await LibraryIssue.find({ tenantId: ctx.tenantId, status: 'issued', borrowerType: type, borrowerId: { $in: people.map((p) => p.id) } }).lean();
  const unpaidFines = type === 'student' ? await StudentCharge.aggregate([{ $match: { tenantId: ctx.tenantId, kind: 'library_fine', status: 'open', studentId: { $in: people.map((p) => p.id) } } }, { $group: { _id: '$studentId', n: { $sum: { $subtract: [{ $subtract: ['$amount', '$concession'] }, '$paidAmount'] } } } }]) : [];
  const F = new Map(unpaidFines.map((f) => [String(f._id), f.n]));
  const rules = rulesOf(ctx.settings);
  return people.map((p) => {
    const mine = loans.filter((l) => String(l.borrowerId) === String(p.id));
    return { ...p, openLoans: mine.length, overdue: mine.filter((l) => l.dueDate < ctx.today).length, unpaidFine: round2(F.get(String(p.id)) || 0), limit: rules.maxBooks[type] };
  });
}

// ───────────── circulation ─────────────
async function borrowerOf(ctx, type, id) {
  const b = type === 'student' ? await Student.findOne({ _id: id, tenantId: ctx.tenantId }) : await Teacher.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!b) throw notFound(`${type === 'student' ? 'Student' : 'Teacher'} not found`);
  if (b.status !== 'active') throw conflict(`This ${type} is not active`);
  return b;
}

export async function issueBook(ctx, body) {
  const rules = rulesOf(ctx.settings);
  const copy = body.copyId ? await BookCopy.findOne({ _id: body.copyId, tenantId: ctx.tenantId }) : await BookCopy.findOne({ tenantId: ctx.tenantId, accessionNo: new RegExp(`^${escapeRegex(body.accessionNo)}$`, 'i') });
  if (!copy) throw notFound('No copy with that accession number');
  const book = await Book.findOne({ _id: copy.bookId, tenantId: ctx.tenantId });
  if (copy.status !== 'available') throw conflict(`This copy is ${copy.status === 'issued' ? 'already on loan' : copy.status}`);
  const borrower = await borrowerOf(ctx, body.borrowerType, body.borrowerId);
  const open = await LibraryIssue.find({ tenantId: ctx.tenantId, borrowerType: body.borrowerType, borrowerId: borrower._id, status: 'issued' }).lean();
  const limit = rules.maxBooks[body.borrowerType];
  if (open.length >= limit) throw conflict(`${borrower.name} already has ${open.length} book(s) — the limit is ${limit}`);
  if (open.some((o) => String(o.bookId) === String(book._id))) throw conflict('This person already has a copy of this book');
  if (rules.blockIfOverdue && open.some((o) => o.dueDate < ctx.today)) throw conflict('This person has an overdue book. Return it before borrowing another.');
  if (body.borrowerType === 'student') {
    const fine = await StudentCharge.exists({ tenantId: ctx.tenantId, studentId: borrower._id, kind: 'library_fine', status: 'open' });
    if (fine) throw conflict('This student has an unpaid library fine. It must be paid at the finance desk first.');
  }
  const claimed = await BookCopy.findOneAndUpdate({ _id: copy._id, status: 'available' }, { status: 'issued' });
  if (!claimed) throw conflict('This copy was just issued to someone else');
  const days = body.days || rules.loanDays[body.borrowerType];
  try {
    const issue = await LibraryIssue.create({ tenantId: ctx.tenantId, copyId: copy._id, bookId: book._id, borrowerType: body.borrowerType, borrowerId: borrower._id, borrowerUserId: borrower.userId, issuedOn: ctx.today, dueDate: addDays(ctx.today, days), issuedBy: ctx.actorId });
    await notifyUsers(ctx.tenantId, [borrower.userId], { category: 'library', title: 'Book issued', body: `${book.title} — due ${issue.dueDate}`, link: { type: 'library', id: String(issue._id) }, dedupeKey: `libi:${issue._id}` });
    return { issue, book, borrower: { id: borrower._id, name: borrower.name } };
  } catch (e) { await BookCopy.updateOne({ _id: copy._id }, { status: 'available' }); throw e; }
}

export async function returnBook(ctx, body) {
  const rules = rulesOf(ctx.settings);
  let issue;
  if (body.issueId) issue = await LibraryIssue.findOne({ _id: body.issueId, tenantId: ctx.tenantId, status: 'issued' });
  else {
    const copy = await BookCopy.findOne({ tenantId: ctx.tenantId, accessionNo: new RegExp(`^${escapeRegex(body.accessionNo)}$`, 'i') });
    if (!copy) throw notFound('No copy with that accession number');
    issue = await LibraryIssue.findOne({ tenantId: ctx.tenantId, copyId: copy._id, status: 'issued' });
  }
  if (!issue) throw notFound('That book is not currently on loan');
  const book = await Book.findById(issue.bookId);
  const returnedOn = body.returnedOn || ctx.today;
  if (returnedOn < issue.issuedOn || returnedOn > ctx.today) throw bad('Return date must be between the issue date and today');
  const lateDays = Math.max(0, daysBetween(issue.dueDate, returnedOn));
  const lateFine = round2(lateDays * rules.finePerDay);
  const damage = body.condition === 'damaged' ? round2(body.damageFine || 0) : 0;
  const lost = body.condition === 'lost' ? round2(book?.price || 0) : 0;
  const total = round2(lateFine + damage + lost);
  const charge = total > 0 && !body.waiveFine;

  issue.returnedOn = returnedOn; issue.returnedBy = ctx.actorId; issue.returnCondition = body.condition; issue.fineDays = lateDays;
  issue.fineAmount = total; issue.fineWaived = !!body.waiveFine && total > 0; issue.fineNote = body.waiveFine ? `Waived: ${body.waiveReason}` : undefined;
  issue.status = body.condition === 'lost' ? 'lost' : 'returned';
  if (charge && issue.borrowerType === 'student') {
    const parts = [lateDays ? `${lateDays} day(s) late` : null, damage ? 'damaged' : null, lost ? 'lost' : null].filter(Boolean).join(', ');
    const c = await StudentCharge.create({ tenantId: ctx.tenantId, studentId: issue.borrowerId, kind: 'library_fine', label: `Library fine — ${book?.title} (${parts})`, category: 'Library', amount: total, dueDate: ctx.today, source: { type: 'libraryIssue', id: String(issue._id) }, createdBy: ctx.actorId });
    issue.fineChargeId = c._id;
  }
  await issue.save();
  await BookCopy.updateOne({ _id: issue.copyId }, { status: body.condition === 'good' ? 'available' : body.condition });
  if (issue.borrowerUserId) {
    await notifyUsers(ctx.tenantId, [issue.borrowerUserId], { category: 'library', title: 'Book returned', body: `${book?.title}${charge && issue.borrowerType === 'student' ? ` — fine ₹${total} added to your fees` : ''}`, link: { type: 'library', id: String(issue._id) }, dedupeKey: `libr:${issue._id}` });
  }
  return { issue, book, fine: { amount: total, lateDays, lateFine, damage, lost, waived: issue.fineWaived, charged: charge && issue.borrowerType === 'student' } };
}

export async function renewIssue(ctx, id) {
  const rules = rulesOf(ctx.settings);
  const issue = await LibraryIssue.findOne({ _id: id, tenantId: ctx.tenantId, status: 'issued' });
  if (!issue) throw notFound('Loan not found');
  if (issue.dueDate < ctx.today) throw conflict('An overdue book cannot be renewed. Return it first.');
  if (issue.renewals >= rules.maxRenewals) throw conflict(`This book has already been renewed ${issue.renewals} time(s) (the limit)`);
  issue.dueDate = addDays(issue.dueDate, rules.loanDays[issue.borrowerType]);
  issue.renewals += 1;
  return issue.save();
}

export async function listLoans(ctx, q) {
  const f = { tenantId: ctx.tenantId };
  if (q.status === 'overdue') { f.status = 'issued'; f.dueDate = { $lt: ctx.today }; } else if (q.status !== 'all') f.status = q.status;
  if (q.borrowerType) f.borrowerType = q.borrowerType;
  if (q.borrowerId) f.borrowerId = q.borrowerId;
  let rows = await LibraryIssue.find(f).sort({ dueDate: 1, createdAt: -1 }).limit(1000).lean();
  const [books, names, copies] = await Promise.all([Book.find({ tenantId: ctx.tenantId, _id: { $in: rows.map((r) => r.bookId) } }).select('title author').lean(), borrowerNames(ctx.tenantId, rows), BookCopy.find({ tenantId: ctx.tenantId, _id: { $in: rows.map((r) => r.copyId) } }).select('accessionNo').lean()]);
  const B = mk(books); const C = mk(copies);
  const rate = rulesOf(ctx.settings).finePerDay;
  rows = rows.map((r) => {
    const late = r.status === 'issued' ? Math.max(0, daysBetween(r.dueDate, ctx.today)) : r.fineDays || 0;
    return { ...r, book: B.get(String(r.bookId))?.title, author: B.get(String(r.bookId))?.author, accessionNo: C.get(String(r.copyId))?.accessionNo, borrower: names.get(String(r.borrowerId)), overdue: r.status === 'issued' && r.dueDate < ctx.today, daysLate: late, fineSoFar: r.status === 'issued' ? round2(late * rate) : r.fineAmount };
  });
  if (q.q) { const rx = new RegExp(escapeRegex(q.q), 'i'); rows = rows.filter((r) => rx.test(r.book || '') || rx.test(r.borrower || '') || rx.test(r.accessionNo || '')); }
  return { total: rows.length, items: rows.slice((q.page - 1) * q.limit, q.page * q.limit) };
}

export async function remindOverdue(ctx) {
  const rows = (await listLoans(ctx, { status: 'overdue', page: 1, limit: 1000 })).items;
  let sent = 0;
  for (const r of rows) sent += await notifyUsers(ctx.tenantId, [r.borrowerUserId], { category: 'library', title: 'Overdue book', body: `${r.book} was due ${r.dueDate} (${r.daysLate} day(s) late, fine so far ₹${r.fineSoFar}). Please return it.`, link: { type: 'library', id: String(r._id) }, dedupeKey: `libod:${ctx.today}:${r._id}` });
  return { sent, overdue: rows.length };
}

// ───────────── dashboard & reports ─────────────
export async function dashboard(ctx) {
  const month = ctx.today.slice(0, 7);
  const [titles, copyAgg, issuedToday, returnedToday, overdue, fines, top, cats, recent, trend] = await Promise.all([
    Book.countDocuments({ tenantId: ctx.tenantId, status: 'active' }),
    BookCopy.aggregate([{ $match: { tenantId: ctx.tenantId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    LibraryIssue.countDocuments({ tenantId: ctx.tenantId, issuedOn: ctx.today }), LibraryIssue.countDocuments({ tenantId: ctx.tenantId, returnedOn: ctx.today }),
    LibraryIssue.countDocuments({ tenantId: ctx.tenantId, status: 'issued', dueDate: { $lt: ctx.today } }),
    LibraryIssue.aggregate([{ $match: { tenantId: ctx.tenantId, returnedOn: { $gte: `${month}-01`, $lte: `${month}-31` }, fineWaived: false } }, { $group: { _id: null, n: { $sum: '$fineAmount' } } }]),
    LibraryIssue.aggregate([{ $match: { tenantId: ctx.tenantId } }, { $group: { _id: '$bookId', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 5 }]),
    Book.aggregate([{ $match: { tenantId: ctx.tenantId, status: 'active' } }, { $group: { _id: { $ifNull: ['$category', 'Uncategorised'] }, titles: { $sum: 1 } } }, { $sort: { titles: -1 } }]),
    listLoans(ctx, { status: 'all', page: 1, limit: 8 }),
    LibraryIssue.find({ tenantId: ctx.tenantId, $or: [{ issuedOn: { $gte: addDays(ctx.today, -13) } }, { returnedOn: { $gte: addDays(ctx.today, -13) } }] }).select('issuedOn returnedOn').lean(),
  ]);
  const cp = Object.fromEntries(copyAgg.map((c) => [c._id, c.n]));
  const topBooks = mk(await Book.find({ tenantId: ctx.tenantId, _id: { $in: top.map((t) => t._id) } }).select('title').lean());
  return {
    today: ctx.today, titles, copies: Object.values(cp).reduce((a, b) => a + b, 0) - (cp.withdrawn || 0), available: cp.available || 0, onLoan: cp.issued || 0, lost: cp.lost || 0, damaged: cp.damaged || 0,
    issuedToday, returnedToday, overdue, finesThisMonth: round2(fines[0]?.n || 0),
    topBooks: top.map((t) => ({ title: topBooks.get(String(t._id))?.title, issues: t.n })), categories: cats.map((c) => ({ category: c._id, titles: c.titles })),
    trend: eachDate(addDays(ctx.today, -13), ctx.today).map((date) => ({ date, issued: trend.filter((t) => t.issuedOn === date).length, returned: trend.filter((t) => t.returnedOn === date).length })),
    recent: recent.items,
  };
}

export async function exportInventory(ctx) {
  const { items } = await listBooks(ctx.tenantId, { page: 1, limit: 100000, availability: 'all' });
  return toCsv(items, [{ label: 'Title', get: (b) => b.title }, { label: 'Author', get: (b) => b.author }, { label: 'ISBN', get: (b) => b.isbn }, { label: 'Category', get: (b) => b.category }, { label: 'Shelf', get: (b) => b.shelf }, { label: 'Copies', get: (b) => b.total }, { label: 'Available', get: (b) => b.available }, { label: 'On loan', get: (b) => b.issued }, { label: 'Price', get: (b) => b.price }]);
}
export async function exportLoans(ctx, status) {
  const { items } = await listLoans(ctx, { status: status || 'all', page: 1, limit: 100000 });
  return toCsv(items, [{ label: 'Accession', get: (r) => r.accessionNo }, { label: 'Book', get: (r) => r.book }, { label: 'Borrower', get: (r) => r.borrower }, { label: 'Type', get: (r) => r.borrowerType }, { label: 'Issued', get: (r) => r.issuedOn }, { label: 'Due', get: (r) => r.dueDate }, { label: 'Returned', get: (r) => r.returnedOn }, { label: 'Status', get: (r) => r.status }, { label: 'Days late', get: (r) => r.daysLate }, { label: 'Fine', get: (r) => r.fineSoFar }]);
}

// ───────────── settings ─────────────
export async function updateSettings(ctx, body) {
  const school = await School.findById(ctx.tenantId);
  const cur = settingsOf(school).library;
  school.settings = { ...settingsOf(school), library: { ...cur, ...body, loanDays: { ...cur.loanDays, ...(body.loanDays || {}) }, maxBooks: { ...cur.maxBooks, ...(body.maxBooks || {}) } } };
  school.markModified('settings');
  await school.save();
  return settingsOf(school).library;
}
export async function getSettings(tenantId) { return settingsOf(await loadSchool(tenantId)).library; }

// ───────────── student / teacher self-service ─────────────
export async function myLoans(ctx, type, borrowerId) {
  const q = { status: 'all', borrowerType: type, borrowerId, page: 1, limit: 200 };
  const { items } = await listLoans(ctx, q);
  const charges = await StudentCharge.find({ tenantId: ctx.tenantId, _id: { $in: items.map((i) => i.fineChargeId).filter(Boolean) } }).select('status').lean();
  const C = mk(charges);
  const rows = items.map((i) => ({ _id: i._id, book: i.book, author: i.author, accessionNo: i.accessionNo, issuedOn: i.issuedOn, dueDate: i.dueDate, returnedOn: i.returnedOn, status: i.status, overdue: i.overdue, daysLate: i.daysLate, fine: i.fineSoFar, fineWaived: i.fineWaived, finePaid: i.fineChargeId ? C.get(String(i.fineChargeId))?.status === 'paid' : null, renewals: i.renewals }));
  return { current: rows.filter((r) => r.status === 'issued'), history: rows.filter((r) => r.status !== 'issued'), rules: rulesOf(ctx.settings), limit: rulesOf(ctx.settings).maxBooks[type] };
}

/**
 * Class-wise borrowers: who in a class (or one section) has borrowed a book this academic year, who is holding one now, and who never has.
 * Used by the School Admin (view-only) and the Library desk.
 */
export async function classBorrowers(ctx, { classId, sectionId, filter = 'all' }) {
  let sections;
  if (sectionId) { const s = await Section.findOne({ _id: sectionId, tenantId: ctx.tenantId }).lean(); if (!s) throw notFound('Section not found'); sections = [s]; classId = s.classId; }
  else sections = await Section.find({ tenantId: ctx.tenantId, classId, yearId: ctx.year._id, status: 'active' }).sort({ name: 1 }).lean();
  const cls = await ClassModel.findOne({ _id: classId, tenantId: ctx.tenantId }).lean();
  if (!cls) throw notFound('Class not found');
  const enrols = await StudentEnrolment.find({ tenantId: ctx.tenantId, sectionId: { $in: sections.map((s) => s._id) }, yearId: ctx.year._id, status: 'active' }).sort({ rollNo: 1 }).lean();
  const ids = enrols.map((e) => e.studentId);
  const [students, issues] = await Promise.all([
    Student.find({ tenantId: ctx.tenantId, _id: { $in: ids } }).select('name admissionNo').lean(),
    LibraryIssue.find({ tenantId: ctx.tenantId, borrowerType: 'student', borrowerId: { $in: ids }, issuedOn: { $gte: ctx.year.startDate } }).sort({ issuedOn: -1 }).lean(),
  ]);
  const books = mk(await Book.find({ tenantId: ctx.tenantId, _id: { $in: issues.map((i) => i.bookId) } }).select('title').lean());
  const S = mk(students); const SEC = mk(sections);
  const by = new Map();
  for (const i of issues) { const k = String(i.borrowerId); if (!by.has(k)) by.set(k, []); by.get(k).push(i); }
  let rows = enrols.map((e) => {
    const mine = by.get(String(e.studentId)) || []; const holding = mine.filter((i) => i.status === 'issued');
    return {
      studentId: e.studentId, rollNo: e.rollNo, name: S.get(String(e.studentId))?.name, admissionNo: S.get(String(e.studentId))?.admissionNo, section: SEC.get(String(e.sectionId))?.name,
      borrowed: mine.length, holding: holding.map((i) => ({ title: books.get(String(i.bookId))?.title, dueDate: i.dueDate, overdue: i.dueDate < ctx.today })),
      overdue: holding.filter((i) => i.dueDate < ctx.today).length, lastIssuedOn: mine[0]?.issuedOn || null, lastBook: mine[0] ? books.get(String(mine[0].bookId))?.title : null,
    };
  });
  const summary = { students: rows.length, borrowedAny: rows.filter((r) => r.borrowed > 0).length, neverBorrowed: rows.filter((r) => !r.borrowed).length, holdingNow: rows.filter((r) => r.holding.length).length, overdue: rows.filter((r) => r.overdue).length };
  if (filter === 'borrowed') rows = rows.filter((r) => r.borrowed > 0);
  else if (filter === 'never') rows = rows.filter((r) => !r.borrowed);
  else if (filter === 'holding') rows = rows.filter((r) => r.holding.length);
  return { classId, className: cls.name, sectionId: sectionId || null, sections: sections.map((s) => ({ id: s._id, name: s.name })), summary, students: rows };
}
