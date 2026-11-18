import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';

describe('Defaulters, class by class (Finance, and the Admin read-only)', () => {
  let root; let W; let fin; let sec9; let nine;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'dfc');
    const s = await api().post('/api/school/staff').set(W.h).send({ name: 'Fiona Finance', email: 'fiona@dfc.test', role: 'finance' });
    fin = await login(s.body.loginId, s.body.temporaryPassword, 'finance');
    sec9 = (await api().post('/api/school/sections').set(W.h).send({ yearId: W.year._id, classId: W.c9._id, name: 'A', capacity: 30 })).body;
    nine = [];
    for (const n of ['Esha Nair', 'Farid Khan']) nine.push((await api().post('/api/school/students').set(W.h).send({ name: n, dob: '2012-05-05', sectionId: sec9._id, admissionDate: '2026-04-15', guardians: [{ name: `Parent of ${n}`, relationship: 'Mother', phone: '9876500000', isPrimary: true }] })).body);
    const st8 = (await api().post('/api/finance/structures').set(fin.h).send({ classId: W.c8._id, name: 'Class 8 Fee', admissionFee: 5000, monthlyFee: 1000, dueDay: 10, autoAssign: false })).body;
    const st9 = (await api().post('/api/finance/structures').set(fin.h).send({ classId: W.c9._id, name: 'Class 9 Fee', admissionFee: 2000, monthlyFee: 500, dueDay: 10, autoAssign: false })).body;
    await api().post('/api/finance/assign').set(fin.h).send({ structureId: st8._id, all: true });
    await api().post('/api/finance/assign').set(fin.h).send({ structureId: st9._id, studentIds: [nine[0].student._id] }); // only one of the two Class 9 students is billed
  });
  afterAll(teardown);
  const F = (p) => `/api/finance${p}`;

  it('gives one row per class with counts and overdue money, sections inside it, and classes with none are kept', async () => {
    const r = await api().get(F('/reports/defaulters-by-class')).set(fin.h);
    expect(r.status).toBe(200);
    expect(r.body.items.map((c) => c.className)).toEqual(['Class 8', 'Class 9']); // by level
    const [c8, c9] = r.body.items;
    expect(c8).toMatchObject({ studentsBilled: 3, defaulters: 3, percentDefaulting: 100 });
    expect(c8.sections.map((s) => [s.name, s.studentsBilled, s.defaulters])).toEqual([['A', 3, 3], ['B', 0, 0]]);
    expect(c9).toMatchObject({ studentsBilled: 1, defaulters: 1 }); // the unbilled student is not a defaulter and not counted
    // the class totals equal what the student list adds up to
    const list8 = (await api().get(F(`/students?status=overdue&classId=${W.c8._id}`)).set(fin.h)).body;
    expect(list8.total).toBe(3); expect(c8.overdueAmount).toBe(list8.totals.overdue);
    expect(list8.items.every((s) => s.daysOverdue > 0 && s.className === 'Class 8' && s.section === 'A')).toBe(true);
    expect(r.body.totals).toMatchObject({ studentsBilled: 4, defaulters: 4 });
    expect(r.body.totals.overdueAmount).toBeCloseTo(c8.overdueAmount + c9.overdueAmount, 2);
  });

  it('filters by class or section, pages the students beyond a fixed cap, and exports', async () => {
    const one = (await api().get(F(`/reports/defaulters-by-class?sectionId=${W.sec8A._id}`)).set(fin.h)).body;
    expect(one.items.map((c) => c.className)).toEqual(['Class 8']);
    expect(one.items[0].sections.map((x) => x.name)).toEqual(['A']); expect(one.totals).toMatchObject({ studentsBilled: 3, defaulters: 3 });
    const p1 = (await api().get(F('/students?status=overdue&limit=2&page=1')).set(fin.h)).body;
    const p2 = (await api().get(F('/students?status=overdue&limit=2&page=2')).set(fin.h)).body;
    expect(p1.total).toBe(4); expect(p1.items).toHaveLength(2); expect(p2.items).toHaveLength(2);
    expect(new Set([...p1.items, ...p2.items].map((s) => s.studentId)).size).toBe(4);
    const csv = await api().get(F('/export/defaulters-by-class.csv')).set(fin.h);
    expect(csv.status).toBe(200); expect(csv.text.split('\n')[0]).toContain('Defaulters'); expect(csv.text).toContain('Class 9');
    expect((await api().get(F('/reports/defaulters-by-class?classId=zzz')).set(fin.h)).status).toBe(400);
  });

  it('the School Admin sees the same, read-only; others cannot', async () => {
    const adm = await api().get('/api/school/finance/reports/defaulters-by-class').set(W.h);
    expect(adm.status).toBe(200); expect(adm.body.totals.defaulters).toBe(4);
    expect((await api().get(F('/reports/defaulters-by-class')).set(W.teacher1.h)).status).toBe(403);
    expect((await api().get('/api/student/fees').set(W.studentLogins[0].h)).status).toBe(200);
    expect((await api().get('/api/finance/reports/defaulters-by-class').set(W.studentLogins[0].h)).status).toBe(403);
  });
});
