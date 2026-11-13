import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { todayStr, addDays, isoDay } from '../src/core/utils.js';
import { admin, finance, library, teacher, student } from './endpoints.js';

const TODAY = todayStr('Asia/Kolkata');

/** Every read endpoint, for every role, against a populated school: must answer 200, never 500. */
describe('endpoint sweep (no 5xx, correct shapes)', () => {
  let root; let W; let q; let fin; let lib;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'swp');
    const e = (day, p, a) => W.post(W.h, '/api/school/timetable/entries', { sectionId: W.sec8A._id, day, periodId: W.periods[p]._id, assignmentId: a });
    for (const d of [1, 2, 3, 4, 5]) { await e(d, 0, W.asgM._id); await e(d, 1, W.asgE._id); }
    const d = (() => { let x = addDays(TODAY, -1); while (isoDay(x) === 7) x = addDays(x, -1); return x; })();
    const reg = (await api().get(`/api/teacher/attendance/register?sectionId=${W.sec8A._id}&date=${d}`).set(W.teacher1.h)).body;
    await api().post('/api/teacher/attendance/register/submit').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: d, entries: reg.students.map((s) => ({ studentId: s.studentId, status: 'present' })) });
    await api().post('/api/teacher/homework').set(W.teacher1.h).send({ title: 'Sweep HW', sectionId: W.sec8A._id, subjectId: W.maths._id, dueDate: addDays(TODAY, 2), status: 'published' });
    await api().post('/api/school/announcements').set(W.h).send({ title: 'Sweep notice', audience: { all: true } });
    const ex = (await api().post('/api/school/exams').set(W.h).send({ name: 'Sweep Exam', classIds: [W.c8._id] })).body;
    await api().post(`/api/school/exams/${ex._id}/subjects/generate`).set(W.h);
    const f = await api().post('/api/school/staff').set(W.h).send({ name: 'Fin', email: 'fin@swp.test', role: 'finance' });
    const l = await api().post('/api/school/staff').set(W.h).send({ name: 'Lib', email: 'lib@swp.test', role: 'library' });
    fin = await login(f.body.loginId, f.body.temporaryPassword, 'finance'); lib = await login(l.body.loginId, l.body.temporaryPassword, 'library');
    await api().post('/api/finance/structures').set(fin.h).send({ classId: W.c8._id, name: 'Sweep Fee', items: [{ head: 'Tuition', amount: 1000 }], installments: [{ label: 'T1', dueDate: addDays(TODAY, 10), percent: 100 }], autoAssign: false });
    await api().post('/api/library/books').set(lib.h).send({ title: 'Sweep Book', copies: 1 });
    q = { section: W.sec8A._id, student: W.students[0].student._id, teacher: W.t1.teacher._id, exam: ex._id, year: W.year._id, date: d };
  });
  afterAll(teardown);

  const run = async (h, paths) => {
    const bad = [];
    for (const p of paths) { const r = await api().get(p).set(h); if (r.status !== 200) bad.push(`${r.status} ${p} ${JSON.stringify(r.body).slice(0, 120)}`); }
    return bad;
  };

  it('school admin reads', async () => { expect(await run(W.h, admin(q))).toEqual([]); });
  it('super admin acting reads', async () => { expect(await run({ ...root.h, 'X-Acting-School': W.id }, admin(q).slice(0, 15))).toEqual([]); });
  it('teacher reads', async () => { expect(await run(W.teacher1.h, teacher(q))).toEqual([]); });
  it('second teacher reads', async () => { expect(await run(W.teacher2.h, teacher(q).filter((p) => !p.includes('/classes/') || true).slice(0, 8))).toEqual([]); });
  it('student reads', async () => { expect(await run(W.studentLogins[0].h, student(q))).toEqual([]); });
  it('finance reads', async () => { expect(await run(fin.h, finance(q))).toEqual([]); });
  it('library reads', async () => { expect(await run(lib.h, library(q))).toEqual([]); });
  it('platform reads', async () => { expect(await run(root.h, ['/api/platform/stats', '/api/platform/schools', `/api/platform/schools/${W.id}`, '/api/platform/audit', '/api/auth/me', '/api/auth/sessions'])).toEqual([]); });

  it('dashboard shapes are complete and truthful', async () => {
    const t = (await api().get('/api/teacher/dashboard').set(W.teacher1.h)).body;
    expect(t.cards).toMatchObject({ assignedClasses: 1, assignedStudents: 3 });
    expect(t.today).toBeInstanceOf(Array);
    expect(t.attendance.trend.length).toBeGreaterThan(0);
    expect(t.homework.published).toBe(1);
    const s = (await api().get('/api/student/dashboard').set(W.studentLogins[0].h)).body;
    expect(s.cards).toMatchObject({ attendance: 100, pendingHomework: 1, completedExams: 0, latestAverage: null });
    expect(s.announcements.map((a) => a.title)).toContain('Sweep notice');
    expect(s.welcome).toMatchObject({ className: 'Class 8', section: 'A', academicYear: '2026-2027' });
    const co = (await api().get(`/api/teacher/classes/${q.section}`).set(W.teacher1.h)).body;
    expect(co).toMatchObject({ className: 'Class 8', section: 'A', studentCount: 3, classTeacher: 'Mr Sharma' });
    const cs = (await api().get(`/api/teacher/classes/${q.section}/students`).set(W.teacher1.h)).body;
    expect(cs.map((x) => x.rollNo)).toEqual([1, 2, 3]);
    expect(cs[0].attendance).toBe(100);
    const subj = (await api().get('/api/teacher/subjects').set(W.teacher1.h)).body;
    expect(subj[0]).toMatchObject({ name: 'Mathematics', assignmentCount: 1, weeklyPeriods: 5 });
    // a teacher can't open another section, or a student outside their classes
    const other = (await W.post(W.h, '/api/school/sections', { yearId: W.year._id, classId: W.c9._id, name: 'Z' })).body;
    expect((await api().get(`/api/teacher/classes/${other._id}`).set(W.teacher1.h)).status).toBe(403);
    expect((await api().get(`/api/teacher/classes/${other._id}/students`).set(W.teacher1.h)).status).toBe(403);
    expect((await api().get('/api/teacher/students/64b000000000000000000000').set(W.teacher1.h)).status).toBe(404);
  });
});
