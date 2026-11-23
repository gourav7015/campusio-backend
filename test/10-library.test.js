import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';
import { LibraryIssue } from '../src/models/index.js';

const TODAY = todayStr('Asia/Kolkata');

describe('Library portal: catalogue, circulation, fines (into Finance), clearance', () => {
  let root; let W; let lib; let fin; let book; let sid; let tid;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'lib');
    const l = await api().post('/api/school/staff').set(W.h).send({ name: 'Liam Library', email: 'liam@lib.test', role: 'library', phone: '9833333333', dob: '1984-04-04' });
    const f = await api().post('/api/school/staff').set(W.h).send({ name: 'Fiona Finance', email: 'fiona@lib.test', role: 'finance', phone: '9833333333', dob: '1984-04-04' });
    lib = await login(l.body.loginId, l.body.temporaryPassword, 'library');
    fin = await login(f.body.loginId, f.body.temporaryPassword, 'finance');
    sid = W.students[0].student._id; tid = W.t1.teacher._id;
  });
  afterAll(teardown);
  const L = (p) => `/api/library${p}`;
  const issue = (accessionNo, borrowerId = sid, borrowerType = 'student', extra = {}) => api().post(L('/issue')).set(lib.h).send({ accessionNo, borrowerType, borrowerId, ...extra });
  const ret = (body) => api().post(L('/return')).set(lib.h).send(body);
  const bookBody = (over = {}) => ({ title: 'Wings of Fire', author: 'A. P. J. Abdul Kalam', isbn: '9788173711466', category: 'Biography', price: 250, copies: 3, shelf: 'B-2', ...over });

  it('Library staff add books with auto-numbered copies; duplicates, search and copy status work', async () => {
    expect((await api().post(L('/books')).set(lib.h).send({ ...bookBody(), copies: 0 })).status).toBe(400);
    expect((await api().post(L('/books')).set(W.teacher1.h).send(bookBody())).status).toBe(403);
    const out = (await api().post(L('/books')).set(lib.h).send(bookBody())).body;
    book = out.book;
    expect(out.accessionNos).toEqual(['LB00001', 'LB00002', 'LB00003']);
    expect((await api().post(L('/books')).set(lib.h).send(bookBody())).status).toBe(409); // same ISBN
    await api().post(L('/books')).set(lib.h).send(bookBody({ title: 'Malgudi Days', isbn: '', author: 'R. K. Narayan', category: 'Fiction', price: 180, copies: 1 }));
    const all = (await api().get(L('/books')).set(lib.h)).body;
    expect(all.total).toBe(2);
    expect(all.items.find((b) => b.title === 'Wings of Fire')).toMatchObject({ total: 3, available: 3, issued: 0 });
    expect((await api().get(L('/books?q=narayan')).set(lib.h)).body.items.map((b) => b.title)).toEqual(['Malgudi Days']);
    expect((await api().get(L('/books?category=Biography')).set(lib.h)).body.total).toBe(1);
    expect((await api().post(L(`/books/${book._id}/copies`)).set(lib.h).send({ count: 2 })).body.accessionNos).toEqual(['LB00005', 'LB00006']); // LB00004 went to Malgudi Days
    const detail = (await api().get(L(`/books/${book._id}`)).set(lib.h)).body;
    expect(detail.copies).toHaveLength(5);
    const c = detail.copies.find((x) => x.accessionNo === 'LB00006');
    expect((await api().patch(L(`/copies/${c._id}`)).set(lib.h).send({ status: 'damaged', notes: 'torn cover' })).body.status).toBe('damaged');
    expect((await api().get(L('/books?availability=available')).set(lib.h)).body.items.find((b) => b.title === 'Wings of Fire').available).toBe(4);
  });

  it('issuing: borrower search, loan period, limits, one copy per book, no double issue', async () => {
    const found = (await api().get(L('/borrowers?type=student&q=aarav')).set(lib.h)).body;
    expect(found[0]).toMatchObject({ name: 'Aarav Singh', openLoans: 0, limit: 2, detail: 'Class 8 A' });
    expect((await api().get(L('/borrowers?type=teacher&q=sharma')).set(lib.h)).body[0]).toMatchObject({ name: 'Mr Sharma', limit: 5 });
    const i1 = await issue('LB00001');
    expect(i1.status).toBe(201);
    expect(i1.body.issue).toMatchObject({ issuedOn: TODAY, dueDate: addDays(TODAY, 14), status: 'issued' }); // students get 14 days
    expect((await issue('LB00001', W.students[1].student._id)).status).toBe(409); // already on loan
    expect((await issue('lb00002')).status).toBe(409); // same book twice for the same student
    expect((await issue('LB00006', W.students[1].student._id)).status).toBe(409); // damaged copy
    expect((await issue('NOPE')).status).toBe(404);
    expect((await issue('LB00004')).status).toBe(201); // second book for Aarav
    expect((await issue('LB00002', sid)).status).toBe(409);
    const third = await api().post(L('/books')).set(lib.h).send(bookBody({ title: 'Gitanjali', isbn: '', copies: 1, category: 'Poetry' }));
    const limit = await issue(third.body.accessionNos[0]);
    expect(limit.status).toBe(409);
    expect(limit.body.error).toMatch(/limit is 2/);
    // teachers borrow longer and may hold more
    const t = await issue('LB00002', tid, 'teacher');
    expect(t.body.issue.dueDate).toBe(addDays(TODAY, 30));
    expect((await api().get(L('/borrowers?type=student&q=aarav')).set(lib.h)).body[0].openLoans).toBe(2);
    // the catalogue shows availability only; copy-level info is for library staff
    const stuCat = (await api().get('/api/student/library/books?q=wings').set(W.studentLogins[1].h)).body.items[0];
    expect(stuCat).toMatchObject({ title: 'Wings of Fire', available: 2, total: 5 });
    expect(stuCat).not.toHaveProperty('copies');
    expect((await api().get('/api/teacher/library/books').set(W.teacher2.h)).status).toBe(200);
    expect((await api().get('/api/student/library/books').set(fin.h)).status).toBe(403);
  });

  it('students and teachers see their own loans; nobody else\'s', async () => {
    const mine = (await api().get('/api/student/library/loans').set(W.studentLogins[0].h)).body;
    expect(mine.current.map((l) => l.book).sort()).toEqual(['Malgudi Days', 'Wings of Fire']);
    expect(mine).toMatchObject({ limit: 2, history: [] });
    expect((await api().get('/api/student/library/loans').set(W.studentLogins[1].h)).body.current).toHaveLength(0);
    expect((await api().get('/api/teacher/library/loans').set(W.teacher1.h)).body.current.map((l) => l.accessionNo)).toEqual(['LB00002']);
    expect((await api().get('/api/teacher/library/loans').set(W.teacher2.h)).body.current).toHaveLength(0);
    expect((await api().get('/api/student/dashboard').set(W.studentLogins[0].h)).body.library).toEqual({ onLoan: 2, overdue: 0 });
  });

  it('renewals: once, only while not overdue', async () => {
    const loan = (await api().get(L('/loans?q=LB00004')).set(lib.h)).body.items[0];
    const r = await api().post(L(`/loans/${loan._id}/renew`)).set(lib.h);
    expect(r.body).toMatchObject({ renewals: 1, dueDate: addDays(TODAY, 28) });
    expect((await api().post(L(`/loans/${loan._id}/renew`)).set(lib.h)).status).toBe(409); // limit of 1
  });

  it('overdue: blocks new loans, lists with the fine so far, reminders are sent once a day', async () => {
    const loan = (await api().get(L('/loans?q=LB00001')).set(lib.h)).body.items[0];
    await LibraryIssue.updateOne({ _id: loan._id }, { dueDate: addDays(TODAY, -5) });
    const od = (await api().get(L('/loans?status=overdue')).set(lib.h)).body.items;
    expect(od).toHaveLength(1);
    expect(od[0]).toMatchObject({ book: 'Wings of Fire', borrower: 'Aarav Singh (' + W.students[0].student.admissionNo + ')', daysLate: 5, fineSoFar: 10 }); // ₹2 a day
    const blocked = await issue('LB00003', sid);
    expect(blocked.status).toBe(409);
    expect((await api().get(L('/borrowers?type=student&q=aarav')).set(lib.h)).body[0].overdue).toBe(1);
    expect((await api().post(L(`/loans/${loan._id}/renew`)).set(lib.h)).status).toBe(409); // overdue → no renewal
    expect((await api().post(L('/reminders')).set(lib.h)).body).toEqual({ sent: 1, overdue: 1 });
    expect((await api().post(L('/reminders')).set(lib.h)).body.sent).toBe(0);
    expect((await api().get('/api/student/notifications?category=library').set(W.studentLogins[0].h)).body.items.some((n) => n.title === 'Overdue book')).toBe(true);
    expect((await api().get('/api/student/dashboard').set(W.studentLogins[0].h)).body.library).toEqual({ onLoan: 2, overdue: 1 });
  });

  it('returning a late book creates a fine in the student\'s FEES; unpaid fines block borrowing until Finance collects them', async () => {
    const r = await ret({ accessionNo: 'LB00001' });
    expect(r.status).toBe(200);
    expect(r.body.fine).toMatchObject({ amount: 10, lateDays: 5, charged: true, waived: false });
    expect(r.body.issue.status).toBe('returned');
    // it shows up on the student's fee page and in Finance's ledger
    const fees = (await api().get('/api/student/fees').set(W.studentLogins[0].h)).body;
    expect(fees.charges.find((c) => c.kind === 'library_fine')).toMatchObject({ label: expect.stringContaining('Library fine — Wings of Fire (5 day(s) late)'), amount: 10, outstanding: 10 });
    expect((await api().get(`/api/finance/students/${sid}/account`).set(fin.h)).body.charges.some((c) => c.kind === 'library_fine')).toBe(true);
    expect((await api().get('/api/student/notifications?category=library').set(W.studentLogins[0].h)).body.items.some((n) => /fine ₹10/.test(n.body))).toBe(true);
    // the book is back in stock, but the student must settle the fine before borrowing again
    const again = await issue('LB00001', sid);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/unpaid library fine/);
    expect((await api().get(L('/borrowers?type=student&q=aarav')).set(lib.h)).body[0].unpaidFine).toBe(10);
    await api().post('/api/finance/payments').set(fin.h).send({ studentId: sid, amount: 10, mode: 'cash', chargeIds: (await api().get(`/api/finance/students/${sid}/account`).set(fin.h)).body.charges.filter((c) => c.kind === 'library_fine').map((c) => c._id) });
    expect((await issue('LB00001', sid)).status).toBe(201);
    expect((await api().get('/api/student/library/loans').set(W.studentLogins[0].h)).body.history[0]).toMatchObject({ book: 'Wings of Fire', daysLate: 5, fine: 10, finePaid: true });
  });

  it('lost and damaged books, and waived fines (with a reason)', async () => {
    const s2 = W.students[1].student._id;
    await issue('LB00003', s2);
    expect((await ret({ accessionNo: 'LB00003', condition: 'lost' })).body.fine).toMatchObject({ amount: 250, lost: 250, charged: true }); // priced at the book's value
    const detail = (await api().get(L(`/books/${book._id}`)).set(lib.h)).body;
    expect(detail.copies.find((c) => c.accessionNo === 'LB00003').status).toBe('lost');
    expect((await issue('LB00003', W.students[2].student._id)).status).toBe(409); // lost copies can't be lent
    expect((await api().get('/api/student/fees').set(W.studentLogins[1].h)).body.totals.pending).toBe(250);
    // damaged returns carry an extra fine; the copy leaves circulation; waiving needs a reason
    await issue('LB00005', W.students[2].student._id);
    expect((await ret({ accessionNo: 'LB00005', condition: 'damaged', damageFine: 40, waiveFine: true })).status).toBe(400);
    const w = await ret({ accessionNo: 'LB00005', condition: 'damaged', damageFine: 40, waiveFine: true, waiveReason: 'Accidental, first time' });
    expect(w.body.fine).toMatchObject({ amount: 40, waived: true, charged: false });
    expect(w.body.issue.fineNote).toMatch(/Waived: Accidental/);
    expect((await api().get('/api/student/fees').set(W.studentLogins[2].h)).body.charges).toHaveLength(0); // nothing billed
    expect((await api().get(L(`/books/${book._id}`)).set(lib.h)).body.copies.find((c) => c.accessionNo === 'LB00005').status).toBe('damaged');
    expect((await ret({ accessionNo: 'LB00005' })).status).toBe(404); // not on loan any more
    // a teacher's late return is recorded but not billed (no student fee account)
    const tl = (await api().get(L('/loans?q=LB00002')).set(lib.h)).body.items[0];
    await LibraryIssue.updateOne({ _id: tl._id }, { dueDate: addDays(TODAY, -3) });
    expect((await ret({ issueId: tl._id })).body.fine).toMatchObject({ amount: 6, charged: false });
  });

  it('clearance: a student or teacher with books out cannot be withdrawn/deactivated without an explicit override', async () => {
    const s3 = W.students[2].student._id;
    expect((await issue('LB00007', s3)).status).toBe(201); // Gitanjali
    const c = (await api().get(`/api/school/students/${s3}/clearance`).set(W.h)).body;
    expect(c.clear).toBe(false);
    expect(c.openLoans.length).toBeGreaterThan(0);
    const blocked = await api().post(`/api/school/students/${s3}/withdraw`).set(W.h).send({ reason: 'Moved city', outcome: 'withdrawn' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.code).toBe('CLEARANCE_REQUIRED');
    // teacher: gets a book, deactivation is refused until it is returned
    const g = await api().post('/api/library/books').set(lib.h).send(bookBody({ title: 'Grammar Guide', isbn: '', copies: 1, category: 'Reference' }));
    await issue(g.body.accessionNos[0], tid, 'teacher');
    const d = await api().post(`/api/school/teachers/${tid}/deactivate`).set(W.h).send({});
    expect(d.status).toBe(409);
    expect(d.body.details).toMatchObject({ code: 'CLEARANCE_REQUIRED' });
    await ret({ accessionNo: g.body.accessionNos[0] });
  });

  it('dashboard, reports, CSV exports, library rules, and the admin\'s view-only window', async () => {
    const d = (await api().get(L('/dashboard')).set(lib.h)).body;
    expect(d).toMatchObject({ titles: 4 });
    expect(d.onLoan).toBeGreaterThan(0);
    expect(d.topBooks[0].title).toBe('Wings of Fire');
    expect(d.categories.map((c) => c.category).sort()).toEqual(['Biography', 'Fiction', 'Poetry', 'Reference']);
    expect(d.finesThisMonth).toBeGreaterThan(0);
    expect(d.trend).toHaveLength(14);
    expect((await api().get(L('/export/inventory.csv')).set(lib.h)).text.split('\n')[0]).toBe('Title,Author,ISBN,Category,Shelf,Copies,Available,On loan,Price');
    expect((await api().get(L('/export/loans.csv?status=all')).set(lib.h)).text).toContain('Wings of Fire');
    expect((await api().get('/api/school/export/students.csv').set(lib.h)).status).toBe(403);
    // the school can change the rules; they apply to the next loan
    expect((await api().put(L('/settings')).set(lib.h).send({ loanDays: { student: 7, teacher: 30 }, finePerDay: 5 })).body).toMatchObject({ loanDays: { student: 7, teacher: 30 }, finePerDay: 5, maxBooks: { student: 2, teacher: 5 } });
    expect((await api().put(L('/settings')).set(lib.h).send({ finePerDay: -1 })).status).toBe(400);
    const s3 = W.students[2].student._id; // (Bhavna still owes the fine for the lost book)
    const i = await issue('LB00002', s3);
    expect(i.body.issue.dueDate).toBe(addDays(TODAY, 7));
    await ret({ accessionNo: 'LB00002' });
    // School Admin: view-only
    expect((await api().get('/api/school/library/dashboard').set(W.h)).status).toBe(200);
    expect((await api().post('/api/school/library/issue').set(W.h).send({ accessionNo: 'LB00001', borrowerType: 'student', borrowerId: s3 })).status).toBe(403);
    expect((await api().get('/api/school/dashboard').set(W.h)).body.library).toMatchObject({ overdue: expect.any(Number) });
  });
});
