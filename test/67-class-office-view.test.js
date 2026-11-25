import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';

/** A class teacher sees his own class the way the school office does, and nothing else: read-only, his own sections and their students only. */
describe('class teacher: the office view of his own class', () => {
  let root; let W; let outsider; let mineId; let O;
  const OF = (p) => `/api/teacher/office${p}`;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'cof');
    // a student of 8-B: not in the class teacher's own section (8-A)
    const r = await api().post('/api/school/students').set(W.h).send({ name: 'Outsider Kid', dob: '2013-07-07', sectionId: W.sec8B._id, admissionDate: '2026-04-15', guardians: [{ email: 'g@fixture.test', name: 'Parent Name', relationship: 'Mother', phone: '9876543210' }] });
    outsider = r.body._id || r.body.student?._id || r.body.id;
    mineId = (await api().get(`/api/school/sections/${W.sec8A._id}/students`).set(W.h)).body[0].studentId;
    O = (p) => api().get(OF(p)).set(W.teacher1.h);
  });
  afterAll(teardown);

  it('he gets the office\'s own views of his section: the insight, the students, the homework, the exam analysis, the library', async () => {
    const insight = await O(`/sections/${W.sec8A._id}/insight`);
    expect(insight.status).toBe(200); expect(insight.body).toMatchObject({ className: 'Class 8', section: 'A' });
    const students = await O(`/sections/${W.sec8A._id}/students`);
    expect(students.status).toBe(200); expect(students.body.length).toBeGreaterThan(0);
    expect((await O(`/sections/${W.sec8A._id}/homework?date=${new Date().toLocaleDateString('en-CA')}`)).status).toBe(200);
    expect((await O(`/analysis/exams?sectionId=${W.sec8A._id}`)).status).toBe(200);
    expect((await O(`/library/class-borrowers?sectionId=${W.sec8A._id}`)).status).toBe(200);
  });

  it('the exam analysis tells which students are monitors, so the list can be narrowed to them', async () => {
    const before = (await O(`/analysis/exams?sectionId=${W.sec8A._id}`)).body;
    expect(before.students.length).toBeGreaterThan(0);
    expect(before.students.every((s) => s.monitor === false)).toBe(true);
    expect((await api().put(`/api/teacher/classes/${W.sec8A._id}/monitors`).set(W.teacher1.h).send({ studentIds: [mineId] })).status).toBe(200);
    const after = (await O(`/analysis/exams?sectionId=${W.sec8A._id}`)).body;
    expect(after.students.filter((s) => s.monitor).map((s) => String(s.studentId))).toEqual([String(mineId)]);
  });

  it('every detail of a student of his class: the record, the overview, the marks, the fees', async () => {
    const st = await O(`/students/${mineId}`);
    expect(st.status).toBe(200); expect(st.body).toHaveProperty('guardians');
    expect((await O(`/students/${mineId}/overview`)).status).toBe(200);
    expect((await O(`/analysis/students/${mineId}`)).status).toBe(200);
    expect((await O(`/finance/students/${mineId}/account`)).status).toBe(200);
  });

  it('nothing outside his own class: other sections, their students, class-wide queries and every other endpoint are refused', async () => {
    expect(String(outsider)).toMatch(/^[a-f0-9]{24}$/); // a real student of another section, so the refusals below are about the section and not a bad address
    expect((await api().get(`/api/school/students/${outsider}`).set(W.h)).status).toBe(200);
    expect((await O(`/sections/${W.sec8B._id}/insight`)).status).toBe(403);
    expect((await O(`/sections/${W.sec8B._id}/students`)).status).toBe(403);
    expect((await O(`/students/${outsider}`)).status).toBe(403);
    expect((await O(`/students/${outsider}/overview`)).status).toBe(403);
    expect((await O(`/finance/students/${outsider}/account`)).status).toBe(403);
    expect((await O(`/analysis/exams?sectionId=${W.sec8B._id}`)).status).toBe(403);
    expect((await O(`/analysis/exams?classId=${W.c8._id}`)).status).toBe(403); // a whole class is not his
    expect((await O('/students')).status).toBe(403); // the school-wide list
    expect((await O('/teachers')).status).toBe(403);
    expect((await O('/finance/students')).status).toBe(403);
  });

  it('read-only: no change can be made through this door', async () => {
    for (const [m, p, b] of [['post', '/students', { name: 'X' }], ['patch', `/students/${mineId}`, { name: 'Hacked' }], ['put', `/sections/${W.sec8A._id}/class-teacher`, {}], ['delete', `/students/${mineId}`]]) {
      expect((await api()[m](OF(p)).set(W.teacher1.h).send(b || {})).status, `${m} ${p}`).toBe(403);
    }
    expect((await api().get(`/api/school/students/${mineId}`).set(W.h)).body.name).not.toBe('Hacked');
  });

  it('a subject teacher who is not the class teacher, a student and a school admin get nothing here', async () => {
    expect((await api().get(OF(`/sections/${W.sec8A._id}/insight`)).set(W.teacher2.h)).status).toBe(403);
    expect((await api().get(OF(`/students/${mineId}`)).set(W.teacher2.h)).status).toBe(403);
    expect((await api().get(OF(`/sections/${W.sec8A._id}/insight`)).set(W.studentLogins[0].h)).status).toBe(403);
    expect((await api().get(OF(`/sections/${W.sec8A._id}/insight`)).set(W.h)).status).toBe(403); // the admin has his own door
  });
});
