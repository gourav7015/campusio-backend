import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';

describe('Library feedback: class on loans, delete a book', () => {
  let root; let W; let lib;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'libfb');
    const l = await api().post('/api/school/staff').set(W.h).send({ name: 'Liam Library', email: 'liam@libfb.test', role: 'library', phone: '9833333333', dob: '1984-04-04' });
    lib = await login(l.body.loginId, l.body.temporaryPassword, 'library');
  });
  afterAll(teardown);
  const L = (p) => `/api/library${p}`;
  const add = (over = {}) => api().post(L('/books')).set(lib.h).send({ title: 'Wings of Fire', author: 'Kalam', category: 'Biography', price: 100, copies: 2, ...over });

  it('loans carry the borrower class and section; teachers show as Teacher', async () => {
    const b = (await add()).body;
    const sid = W.students[0].student._id;
    await api().post(L('/issue')).set(lib.h).send({ accessionNo: b.accessionNos[0], borrowerType: 'student', borrowerId: sid });
    await api().post(L('/issue')).set(lib.h).send({ accessionNo: b.accessionNos[1], borrowerType: 'teacher', borrowerId: W.t1.teacher._id });
    const rows = (await api().get(L('/loans?status=issued')).set(lib.h)).body.items;
    const mine = rows.find((r) => r.borrowerType === 'student');
    expect(mine).toMatchObject({ className: 'Class 8', sectionName: 'A', classLabel: '8-A' });
    expect(rows.find((r) => r.borrowerType === 'teacher')).toMatchObject({ className: null, classLabel: 'Teacher' });
    // search by class text, export carries the column
    expect((await api().get(L('/loans?status=issued&q=8-A')).set(lib.h)).body.total).toBe(1);
    expect((await api().get(L('/export/loans.csv')).set(lib.h)).text).toContain('Class');
    // the Admin's view-only copy returns the same
    expect((await api().get('/api/school/library/loans?status=issued').set(W.h)).body.items.find((r) => r.borrowerType === 'student').classLabel).toBe('8-A');
  });

  it('deleting a book: erased when never lent, archived when it has history, refused while on loan, never for the Admin', async () => {
    const fresh = (await add({ title: 'Never Lent', isbn: '', copies: 2 })).body;
    const del = await api().delete(L(`/books/${fresh.book._id}`)).set(lib.h);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ mode: 'deleted', copies: 2 });
    expect((await api().get(L(`/books/${fresh.book._id}`)).set(lib.h)).status).toBe(404);
    expect((await api().delete(L(`/books/${fresh.book._id}`)).set(lib.h)).status).toBe(404); // a second librarian

    const used = (await add({ title: 'Lent Once', isbn: '', copies: 1 })).body;
    const sid = W.students[1].student._id;
    await api().post(L('/issue')).set(lib.h).send({ accessionNo: used.accessionNos[0], borrowerType: 'student', borrowerId: sid });
    const blocked = await api().delete(L(`/books/${used.book._id}`)).set(lib.h);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error?.message || blocked.body.message || JSON.stringify(blocked.body)).toMatch(/on loan/i);
    await api().post(L('/return')).set(lib.h).send({ accessionNo: used.accessionNos[0] });
    const arch = await api().delete(L(`/books/${used.book._id}`)).set(lib.h);
    expect(arch.body.mode).toBe('archived');
    expect((await api().get(L('/books')).set(lib.h)).body.items.map((x) => x.title)).not.toContain('Lent Once');
    // history intact
    expect((await api().get(L('/loans?status=returned')).set(lib.h)).body.items.some((r) => r.book === 'Lent Once')).toBe(true);

    const keep = (await add({ title: 'Keep', isbn: '', copies: 1 })).body;
    expect((await api().delete(`/api/school/library/books/${keep.book._id}`).set(W.h)).status).toBe(403);
    expect((await api().delete(L(`/books/${keep.book._id}`)).set(W.teacher1.h)).status).toBe(403);
  });
});
