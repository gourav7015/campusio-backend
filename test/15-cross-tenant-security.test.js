import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';
import { admin, finance, library, teacher, student } from './endpoints.js';

const TODAY = todayStr('Asia/Kolkata');
const HEX = /[0-9a-f]{24}/g;

/**
 * Broken-access-control audit. School A is a fully populated school; School B is a second, unrelated school.
 * Every B user must be unable to read, change or delete anything of A, by id, by list, by header or by body.
 */
describe('cross-tenant isolation (IDOR) across every role', () => {
  let root; let A; let B; let aIds; let aFin; let aLib; let bFin; let bLib; let q; let aFile; const owned = {};
  const staff = async (W, role, tag) => { const r = await api().post('/api/school/staff').set(W.h).send({ name: `${tag} ${role}`, email: `${role}@${tag}.test`, role, phone: '9833333333', dob: '1984-04-04' }); return login(r.body.loginId, r.body.temporaryPassword, role); };

  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin();
    A = await seedWorld(root, 'tna'); B = await seedWorld(root, 'tnb');
    aFin = await staff(A, 'finance', 'tna'); aLib = await staff(A, 'library', 'tna'); bFin = await staff(B, 'finance', 'tnb'); bLib = await staff(B, 'library', 'tnb');
    await api().post('/api/school/announcements').set(A.h).send({ title: 'A notice', audience: { all: true } });
    const ex = (await api().post('/api/school/exams').set(A.h).send({ name: 'A Exam', classIds: [A.c8._id] })).body;
    await api().post(`/api/school/exams/${ex._id}/subjects/generate`).set(A.h);
    await api().post('/api/finance/structures').set(aFin.h).send({ classId: A.c8._id, name: 'A Fee', admissionFee: 5000, monthlyFee: 1000, dueDay: 10, autoAssign: false });
    await api().post('/api/library/books').set(aLib.h).send({ title: 'A Book', copies: 2 });
    const hw = (await api().post('/api/teacher/homework').set(A.teacher1.h).send({ title: 'A HW', sectionId: A.sec8A._id, subjectId: A.maths._id, dueDate: addDays(TODAY, 2), status: 'published' })).body;
    const up = await api().post(`/api/teacher/homework/${hw._id}/attachments`).set(A.teacher1.h).attach('file', Buffer.from('%PDF-1.4 secret'), { filename: 'secret.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    aFile = String((await mongoose.model('File').findOne({ tenantId: A.id, kind: 'homework' }))._id);
    // every id that belongs to school A, from the database itself
    const set = new Set([A.id]);
    for (const name of mongoose.modelNames()) {
      const M = mongoose.model(name);
      if (M.schema.path('tenantId')) (await M.distinct('_id', { tenantId: A.id })).forEach((x) => set.add(String(x)));
    }
    aIds = set;
    for (const name of mongoose.modelNames()) { const M = mongoose.model(name); if (M.schema.path('tenantId')) { const d = await M.findOne({ tenantId: A.id }).lean(); if (d) owned[name] = String(d._id); } }
    q = { section: A.sec8A._id, student: A.students[0].student._id, teacher: A.t1.teacher._id, exam: ex._id, year: A.year._id, date: addDays(TODAY, -1) };
  });
  afterAll(teardown);

  const leaks = (res) => (res.status === 200 ? (JSON.stringify(res.body).match(HEX) || []).filter((id) => aIds.has(id)) : []);

  it('has real data for school A to protect', () => {
    expect(aIds.size).toBeGreaterThan(40);
    for (const m of ['Student', 'Teacher', 'Class', 'Section', 'AcademicYear', 'Announcement', 'Examination', 'FeeStructure', 'Book', 'Homework', 'File']) expect(owned[m], m).toBeTruthy();
  });

  const reads = [
    ['school admin', () => B.h, () => admin(q)], ['teacher', () => B.teacher1.h, () => teacher(q)], ['student', () => B.studentLogins[0].h, () => student(q)],
    ['finance', () => bFin.h, () => finance(q)], ['library', () => bLib.h, () => library(q)],
  ];
  for (const [role, h, paths] of reads) {
    it(`B ${role}: no read endpoint returns anything that belongs to A (A's ids in the URL)`, async () => {
      const bad = [];
      for (const p of paths()) {
        const r = await api().get(p).set(h());
        if (r.status >= 500) bad.push(`${r.status} ${p}`);
        const l = leaks(r); if (l.length) bad.push(`LEAK ${p}: ${l.slice(0, 2).join(',')}`);
      }
      expect(bad).toEqual([]);
    });
  }

  it('a direct read of an A record by id is a 404/403 for every B role that has such a route', async () => {
    const probes = [
      [B.h, `/api/school/students/${owned.Student}`], [B.h, `/api/school/teachers/${owned.Teacher}`], [B.h, `/api/school/exams/${owned.Examination}`],
      [B.h, `/api/school/students/${owned.Student}/clearance`], [B.h, `/api/school/timetable/section/${owned.Section}`],
      [B.teacher1.h, `/api/teacher/classes/${owned.Section}`], [B.teacher1.h, `/api/teacher/students/${owned.Student}`],
      [bFin.h, `/api/finance/students/${owned.Student}/account`], [bLib.h, `/api/library/books/${owned.Book}`],
    ];
    for (const [h, p] of probes) { const r = await api().get(p).set(h); expect([400, 403, 404], `${p} -> ${r.status}`).toContain(r.status); }
  });

  it("B cannot change or delete A's records (writes by id)", async () => {
    const w = [
      ['patch', 'school', `/students/${owned.Student}`, { name: 'Hacked' }], ['post', 'school', `/students/${owned.Student}/withdraw`, {}], ['post', 'school', `/students/${owned.Student}/reset-password`, {}],
      ['patch', 'school', `/teachers/${owned.Teacher}`, { name: 'Hacked' }], ['post', 'school', `/teachers/${owned.Teacher}/deactivate`, {}], ['post', 'school', `/teachers/${owned.Teacher}/reset-password`, {}],
      ['patch', 'school', `/classes/${owned.Class}`, { name: 'Class 1' }], ['delete', 'school', `/classes/${owned.Class}`],
      ['patch', 'school', `/sections/${owned.Section}`, { capacity: 1 }], ['delete', 'school', `/sections/${owned.Section}`],
      ['patch', 'school', `/years/${owned.AcademicYear}`, { name: 'Hacked' }], ['post', 'school', `/years/${owned.AcademicYear}/close`, {}], ['post', 'school', `/years/${owned.AcademicYear}/set-current`, {}],
      ['post', 'school', `/announcements/${owned.Announcement}/archive`, {}], ['delete', 'school', `/documents/${owned.File}`],
      ['patch', 'finance', `/structures/${owned.FeeStructure}`, { name: 'Hacked' }], ['delete', 'finance', `/structures/${owned.FeeStructure}`],
      ['patch', 'library', `/books/${owned.Book}`, { title: 'Hacked' }], ['post', 'library', `/books/${owned.Book}/copies`, { count: 1 }],
      ['patch', 'teacher', `/homework/${owned.Homework}`, { title: 'Hacked' }], ['delete', 'teacher', `/homework/${owned.Homework}`],
    ];
    const bad = [];
    for (const [method, area, path, body] of w) {
      const h = area === 'finance' ? bFin.h : area === 'library' ? bLib.h : area === 'teacher' ? B.teacher1.h : B.h;
      let r = api()[method](`/api/${area}${path}`).set(h); if (body) r = r.send(body);
      const res = await r;
      if (![400, 403, 404].includes(res.status)) bad.push(`${method.toUpperCase()} /api/${area}${path} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
    // and nothing of A changed
    const M = (n) => mongoose.model(n);
    expect((await M('Student').findById(owned.Student)).name).toBe('Aarav Singh');
    expect((await M('Teacher').findById(owned.Teacher)).status).toBe('active');
    expect(await M('Class').exists({ _id: owned.Class })).toBeTruthy();
    expect(await M('Section').exists({ _id: owned.Section })).toBeTruthy();
    expect((await M('Book').findById(owned.Book)).title).toBe('A Book');
  });

  it('a tenant id in the body, query or X-Acting-School header from a non-Super-Admin changes nothing', async () => {
    const made = await api().post('/api/school/classes').set(B.h).send({ name: 'Class 5', tenantId: A.id });
    expect(made.status).toBe(201);
    expect(String((await mongoose.model('Class').findById(made.body._id)).tenantId)).toBe(B.id);
    for (const who of [B.h, B.teacher1.h, bFin.h]) {
      const r = await api().get(who === B.teacher1.h ? '/api/teacher/dashboard' : who === bFin.h ? '/api/finance/dashboard' : '/api/school/students').set({ ...who, 'X-Acting-School': A.id });
      expect(leaks(r)).toEqual([]);
    }
    const list = await api().get(`/api/school/students?tenantId=${A.id}&limit=100`).set({ ...B.h, 'X-Acting-School': A.id });
    expect(leaks(list)).toEqual([]);
    expect(list.body.total).toBe(3);
  });

  it("files: B cannot obtain a download link for A's file, and a forged token opens nothing", async () => {
    expect(aFile, 'the attachment id').toBeTruthy();
    const mine = await api().post(`/api/shared/files/${aFile}/link`).set(A.teacher1.h);
    expect(mine.status).toBe(200);
    for (const who of [B.h, B.teacher1.h, B.studentLogins[0].h]) expect([403, 404]).toContain((await api().post(`/api/shared/files/${aFile}/link`).set(who)).status);
    expect((await api().get(`/api/files/download/${aFile}?token=forged`)).status).toBeGreaterThanOrEqual(400);
    expect((await api().get(`/api/files/download/${aFile}`)).status).toBeGreaterThanOrEqual(400);
  });

  it('a School A user token never works after the school is suspended, and B is unaffected', async () => {
    const off = await api().patch(`/api/platform/schools/${A.id}`).set(root.h).send({ status: 'suspended' });
    expect(off.status).toBe(200);
    expect([401, 403]).toContain((await api().get('/api/school/years').set(A.h)).status);
    expect([401, 403]).toContain((await api().get('/api/teacher/dashboard').set(A.teacher1.h)).status);
    expect((await api().get('/api/school/years').set(B.h)).status).toBe(200);
    await api().patch(`/api/platform/schools/${A.id}`).set(root.h).send({ status: 'active' });
  });
});
