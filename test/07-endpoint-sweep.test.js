import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { todayStr, addDays, isoDay } from '../src/core/utils.js';

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

  const admin = (q) => [
    '/api/school/dashboard', '/api/school/years', '/api/school/classes', '/api/school/sections', '/api/school/subjects', `/api/school/offerings?yearId=${q.year}`, '/api/school/settings',
    '/api/school/students', `/api/school/students?sectionId=${q.section}&q=a`, `/api/school/students/${q.student}`, `/api/school/students/${q.student}/documents`,
    '/api/school/teachers', `/api/school/teachers/${q.teacher}`, '/api/school/teaching-assignments', '/api/school/class-teachers',
    '/api/school/timetable/periods', '/api/school/timetable/entries', '/api/school/timetable/unresolved', `/api/school/timetable/section/${q.section}`, '/api/school/substitutions',
    `/api/school/attendance/overview?date=${q.date}`, `/api/school/attendance/register?sectionId=${q.section}&date=${q.date}`, `/api/school/attendance/history?sectionId=${q.section}`, '/api/school/attendance/queries',
    '/api/school/leave', '/api/school/homework', '/api/school/homework?tab=published', '/api/school/materials', '/api/school/exams', `/api/school/exams/${q.exam}`, `/api/school/exams/${q.exam}/sheets`, `/api/school/exams/${q.exam}/results`,
    '/api/school/announcements', '/api/school/events', '/api/school/messages', '/api/school/notifications', '/api/school/audit', '/api/school/search?q=sha', '/api/school/reports/summary', '/api/school/imports',
    '/api/school/export/students.csv', '/api/school/export/teachers.csv', '/api/school/attendance-overview', '/api/school/staff', `/api/school/students/${q.student}/clearance`,
    '/api/school/finance/dashboard', '/api/school/finance/structures', '/api/school/finance/students', '/api/school/finance/payments', '/api/school/finance/reports/collection', '/api/school/finance/reports/classes', '/api/school/finance/lookups',
    '/api/school/library/dashboard', '/api/school/library/books', '/api/school/library/loans', '/api/school/library/settings',
  ];
  const finance = () => ['/api/finance/dashboard', '/api/finance/lookups', '/api/finance/structures', '/api/finance/students', '/api/finance/students?status=overdue', `/api/finance/students/${q.student}/account`, '/api/finance/payments', '/api/finance/reports/collection', '/api/finance/reports/classes', '/api/finance/export/dues.csv', '/api/finance/export/payments.csv', '/api/auth/me', '/api/auth/sessions'];
  const library = () => ['/api/library/dashboard', '/api/library/books', '/api/library/books?availability=available', '/api/library/loans', '/api/library/loans?status=overdue', '/api/library/borrowers?type=student&q=aar', '/api/library/borrowers?type=teacher&q=sha', '/api/library/settings', '/api/library/export/inventory.csv', '/api/library/export/loans.csv', '/api/auth/me'];
  const teacher = (q) => [
    '/api/teacher/dashboard', '/api/teacher/years', '/api/teacher/profile', '/api/teacher/timetable', `/api/teacher/timetable?date=${q.date}`, '/api/teacher/classes', `/api/teacher/classes/${q.section}`, `/api/teacher/classes/${q.section}/students`,
    `/api/teacher/students/${q.student}`, '/api/teacher/subjects', '/api/teacher/performance', '/api/teacher/search?q=aar', `/api/teacher/attendance/register?sectionId=${q.section}&date=${q.date}`,
    `/api/teacher/attendance/history?sectionId=${q.section}`, '/api/teacher/attendance/overview', '/api/teacher/attendance/queries', '/api/teacher/leave', '/api/teacher/homework', '/api/teacher/homework?tab=draft',
    '/api/teacher/materials', '/api/teacher/exams', '/api/teacher/marks/corrections', '/api/teacher/announcements', '/api/teacher/notifications', '/api/teacher/calendar', '/api/teacher/messages',
    `/api/teacher/performance/class/${q.section}`, '/api/teacher/library/loans', '/api/teacher/library/books',
  ];
  const student = () => [
    '/api/student/dashboard', '/api/student/profile', '/api/student/timetable', '/api/student/timetable?view=week', '/api/student/timetable?view=subject', '/api/student/documents',
    '/api/student/attendance/summary', '/api/student/attendance/calendar', '/api/student/attendance/monthly', '/api/student/attendance/history', '/api/student/attendance/queries',
    '/api/student/homework', '/api/student/homework?tab=due_soon', '/api/student/materials', '/api/student/exams/schedule', '/api/student/results', '/api/student/performance',
    '/api/student/announcements', '/api/student/notifications', '/api/student/calendar',
    '/api/student/fees', '/api/student/library/loans', '/api/student/library/books', '/api/student/class-results', '/api/student/attendance/heatmap',
  ];
  const run = async (h, paths) => {
    const bad = [];
    for (const p of paths) { const r = await api().get(p).set(h); if (r.status !== 200) bad.push(`${r.status} ${p} ${JSON.stringify(r.body).slice(0, 120)}`); }
    return bad;
  };

  it('school admin reads', async () => { expect(await run(W.h, admin(q))).toEqual([]); });
  it('super admin acting reads', async () => { expect(await run({ ...root.h, 'X-Acting-School': W.id }, admin(q).slice(0, 15))).toEqual([]); });
  it('teacher reads', async () => { expect(await run(W.teacher1.h, teacher(q))).toEqual([]); });
  it('second teacher reads', async () => { expect(await run(W.teacher2.h, teacher(q).filter((p) => !p.includes('/classes/') || true).slice(0, 8))).toEqual([]); });
  it('student reads', async () => { expect(await run(W.studentLogins[0].h, student())).toEqual([]); });
  it('finance reads', async () => { expect(await run(fin.h, finance())).toEqual([]); });
  it('library reads', async () => { expect(await run(lib.h, library())).toEqual([]); });
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
