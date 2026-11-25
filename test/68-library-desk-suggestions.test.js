import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';

describe('Library desk: suggestions while typing, forgiving accession numbers, more filters', () => {
  let root; let W; let lib; let sid; let sid2;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'libs');
    const l = await api().post('/api/school/staff').set(W.h).send({ name: 'Liam Library', email: 'liam@libs.test', role: 'library', phone: '9833333333', dob: '1984-04-04' });
    lib = await login(l.body.loginId, l.body.temporaryPassword, 'library');
    sid = W.students[0].student._id; sid2 = W.students[1].student._id;
    const add = (b) => api().post('/api/library/books').set(lib.h).send(b);
    await add({ title: 'Wings of Fire', author: 'A. P. J. Abdul Kalam', category: 'Biography', shelf: 'B-2', language: 'English', price: 250, copies: 4 });
    await add({ title: 'Malgudi Days', author: 'R. K. Narayan', category: 'Fiction', shelf: 'F-1', language: 'English', price: 180, copies: 1 });
    await add({ title: 'Godaan', author: 'Premchand', category: 'Fiction', shelf: 'F-3', language: 'Hindi', price: 120, copies: 1 });
  });
  afterAll(teardown);
  const L = (p) => `/api/library${p}`;
  const get = async (p) => (await api().get(L(p)).set(lib.h)).body;

  it('suggests copies by accession number (with or without the zero padding), title or author', async () => {
    expect((await get('/copies/suggest?q=1')).map((c) => c.accessionNo)).toContain('LB00001');
    const byNo = await get('/copies/suggest?q=LB5');
    expect(byNo[0]).toMatchObject({ accessionNo: 'LB00005', title: 'Malgudi Days', status: 'available' });
    expect((await get('/copies/suggest?q=narayan')).map((c) => c.title)).toEqual(['Malgudi Days']);
    // a title with many copies shows a few of them, not the whole shelf
    expect((await get('/copies/suggest?q=wings')).length).toBe(3);
    expect((await api().get(L('/copies/suggest?q=')).set(lib.h)).status).toBe(400);
  });

  it('a typed number such as LB1 or 1 works for issuing and returning', async () => {
    const i = await api().post(L('/issue')).set(lib.h).send({ accessionNo: 'lb1', borrowerType: 'student', borrowerId: sid });
    expect(i.status).toBe(201);
    expect(i.body.book.title).toBe('Wings of Fire');
    // suggestions for the issue desk show it as on loan, with who has it
    const s = (await get('/copies/suggest?q=LB00001')).find((c) => c.accessionNo === 'LB00001');
    expect(s).toMatchObject({ status: 'issued', loan: { borrower: expect.stringContaining('(') } });
    // the return desk only offers books that are out
    expect((await get('/copies/suggest?q=wings&mode=return')).map((c) => c.accessionNo)).toEqual(['LB00001']);
    expect((await get('/copies/suggest?q=narayan&mode=return'))).toEqual([]);
    const r = await api().post(L('/return')).set(lib.h).send({ accessionNo: '1' });
    expect(r.status).toBe(200);
    expect((await api().post(L('/issue')).set(lib.h).send({ accessionNo: 'LB99999', borrowerType: 'student', borrowerId: sid })).status).toBe(404);
  });

  it('borrowers can be found by class and filtered by what they hold', async () => {
    const lookups = await get('/lookups');
    expect(lookups.classes.length).toBeGreaterThan(0);
    const inClass = await get(`/borrowers?type=student&classId=${lookups.classes[0]._id}`);
    expect(inClass.length).toBeGreaterThan(0);
    expect(inClass[0]).toHaveProperty('canBorrow');
    expect((await api().get(L('/borrowers?type=student')).set(lib.h)).status).toBe(400); // nothing to search by
    await api().post(L('/issue')).set(lib.h).send({ accessionNo: 'LB2', borrowerType: 'student', borrowerId: sid2 });
    const holding = await get('/borrowers?type=student&show=hasBooks');
    expect(holding.map((p) => String(p.id))).toEqual([String(sid2)]);
    expect((await get('/borrowers?type=student&show=overdue'))).toEqual([]);
  });

  it('the catalogue filters by shelf, language, author, availability and sort order', async () => {
    expect((await get('/books?language=Hindi')).items.map((b) => b.title)).toEqual(['Godaan']);
    expect((await get('/books?shelf=F-1')).items.map((b) => b.title)).toEqual(['Malgudi Days']);
    expect((await get('/books?author=Premchand')).total).toBe(1);
    const all = await get('/books');
    expect(all.languages).toEqual(['English', 'Hindi']);
    expect(all.shelves).toEqual(['B-2', 'F-1', 'F-3']);
    // every copy of Godaan out → "all copies out"
    await api().post(L('/issue')).set(lib.h).send({ accessionNo: 'LB6', borrowerType: 'student', borrowerId: sid });
    expect((await get('/books?availability=out')).items.map((b) => b.title)).toEqual(['Godaan']);
    expect((await get('/books?sort=popular')).items[0].title).toBe('Wings of Fire'); // lent most often
  });

  it('loans can be filtered by borrower type, class, category and due date', async () => {
    const lookups = await get('/lookups');
    expect((await get('/loans?borrowerType=teacher')).total).toBe(0);
    expect((await get('/loans?category=Fiction')).items.map((l) => l.book)).toEqual(expect.arrayContaining(['Godaan']));
    expect((await get('/loans?category=Biography&status=all')).items.every((l) => l.book === 'Wings of Fire')).toBe(true);
    expect((await get('/loans?dueFrom=2000-01-01&dueTo=2000-01-02')).total).toBe(0);
    const total = (await get('/loans')).total;
    const byClass = (await Promise.all(lookups.classes.map((c) => get(`/loans?classId=${c._id}`)))).reduce((n, r) => n + r.total, 0);
    expect(byClass).toBe(total);
  });

  it('a book can be library-use-only (never lent), and single copies can be deleted', async () => {
    const dict = (await api().post(L('/books')).set(lib.h).send({ title: 'Oxford Dictionary', author: 'Oxford', category: 'Reference', copies: 2, referenceOnly: true })).body;
    expect(dict.book.referenceOnly).toBe(true);
    const [a1, a2] = dict.accessionNos;
    // cannot be issued, however it is asked for
    const no = await api().post(L('/issue')).set(lib.h).send({ accessionNo: a1, borrowerType: 'student', borrowerId: sid });
    expect(no.status).toBe(409);
    expect(no.body.error).toMatch(/library only/);
    // the desk shows it, but not as something to lend; "Available to borrow" leaves it out
    expect((await get(`/copies/suggest?q=${a1}`))[0]).toMatchObject({ referenceOnly: true, status: 'available' });
    expect((await get('/books?availability=available')).items.map((b) => b.title)).not.toContain('Oxford Dictionary');
    expect((await get('/books?availability=reference')).items.map((b) => b.title)).toEqual(['Oxford Dictionary']);
    expect((await get('/books?availability=out')).items.map((b) => b.title)).not.toContain('Oxford Dictionary');
    // the family and staff catalogue carry the flag
    expect((await api().get('/api/student/library/books?q=oxford').set(W.studentLogins[0].h)).body.items[0]).toMatchObject({ referenceOnly: true });
    // turning the flag off makes it lendable
    expect((await api().patch(L(`/books/${dict.book._id}`)).set(lib.h).send({ referenceOnly: false })).body.referenceOnly).toBe(false);
    const ok = await api().post(L('/issue')).set(lib.h).send({ accessionNo: a1, borrowerType: 'student', borrowerId: sid });
    expect(ok.status).toBe(201);
    // delete a copy: never lent -> erased; on loan -> refused; lent before -> withdrawn, history kept
    expect((await api().delete(L(`/copies/${ok.body.issue.copyId}`)).set(lib.h)).status).toBe(409);
    const copies = (await get(`/books/${dict.book._id}`)).copies;
    const free = copies.find((c) => c.accessionNo === a2);
    expect((await api().delete(L(`/copies/${free._id}`)).set(lib.h)).body).toMatchObject({ mode: 'deleted', accessionNo: a2 });
    expect((await get(`/books/${dict.book._id}`)).copies.map((c) => c.accessionNo)).toEqual([a1]);
    await api().post(L('/return')).set(lib.h).send({ accessionNo: a1 });
    expect((await api().delete(L(`/copies/${ok.body.issue.copyId}`)).set(lib.h)).body).toMatchObject({ mode: 'withdrawn' });
    expect((await get(`/books/${dict.book._id}`)).copies[0].status).toBe('withdrawn');
    expect((await api().delete(L(`/copies/${ok.body.issue.copyId}`)).set(W.teacher1.h)).status).toBe(403);
  });

  it('the desk can browse by filters without typing, and filter what is on loan', async () => {
    expect((await api().get(L('/copies/suggest')).set(lib.h)).status).toBe(400); // nothing to go on
    const fic = await get('/copies/suggest?category=Fiction&limit=10');
    expect(fic.map((c) => c.title).sort()).toEqual(['Godaan', 'Malgudi Days']); // one copy of each title when browsing
    expect((await get('/copies/suggest?language=Hindi')).map((c) => c.title)).toEqual(['Godaan']);
    expect((await get('/copies/suggest?shelf=B-2&show=available')).every((c) => c.status === 'available' && c.shelf === 'B-2')).toBe(true);
    // typing and filtering together
    expect((await get('/copies/suggest?q=days&category=Biography')).length).toBe(0);
    expect((await get('/copies/suggest?q=days&category=Fiction')).map((c) => c.title)).toEqual(['Malgudi Days']);
    // the return desk lists everything on loan with nothing typed, and can show only the overdue ones
    await api().post(L('/issue')).set(lib.h).send({ accessionNo: 'LB6', borrowerType: 'student', borrowerId: W.students[2].student._id });
    const out = await get('/copies/suggest?mode=return&limit=30');
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.status === 'issued' && c.loan)).toBe(true);
    expect(await get('/copies/suggest?mode=return&show=overdue')).toEqual([]);
    expect((await get('/copies/suggest?mode=return&category=Fiction')).every((c) => c.category === 'Fiction')).toBe(true);
  });
});
