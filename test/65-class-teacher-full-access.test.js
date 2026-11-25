import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';

/** The class teacher has full access to their own class: the register, the monitors, the class report, and the marks and tests of every subject. A subject teacher keeps only their own subject. */
describe('class teacher: full access to their own class', () => {
  let root; let W; let exam; let esEng; let esMaths; let kid;
  const T = (p) => `/api/teacher${p}`;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'cta');
    exam = (await api().post('/api/school/exams').set(W.h).send({ name: 'Half Yearly', type: 'half_yearly', classIds: [W.c8._id], startDate: addDays(todayStr(), 6), endDate: addDays(todayStr(), 8), marksDeadline: addDays(todayStr(), 12) })).body;
    await api().post(`/api/school/exams/${exam._id}/subjects/generate`).set(W.h);
    const d = (await api().get(`/api/school/exams/${exam._id}`).set(W.h)).body;
    esEng = d.subjects.find((s) => s.subject === 'English'); esMaths = d.subjects.find((s) => s.subject === 'Mathematics');
  });
  afterAll(teardown);

  it('the sign-in answer says who is a class teacher, so the portal shows the My class tab only to them', async () => {
    expect((await api().get('/api/auth/me').set(W.teacher1.h)).body.user.isClassTeacher).toBe(true);
    expect((await api().get('/api/auth/me').set(W.teacher2.h)).body.user.isClassTeacher).toBe(false);
  });

  it('the class teacher enters and submits marks for a subject he does not teach; the subject teacher of that subject is unaffected', async () => {
    const sheet = (await api().get(T(`/marks/sheet?examSubjectId=${esEng._id}&sectionId=${W.sec8A._id}`)).set(W.teacher1.h));
    expect(sheet.status).toBe(200);
    const students = sheet.body.students; kid = students[0].studentId;
    const marks = students.map((s, i) => ({ studentId: s.studentId, values: { marks: 50 + i } }));
    expect((await api().put(T('/marks/sheet')).set(W.teacher1.h).send({ examSubjectId: esEng._id, sectionId: W.sec8A._id, marks })).status).toBe(200);
    expect((await api().post(T('/marks/sheet/submit')).set(W.teacher1.h).send({ examSubjectId: esEng._id, sectionId: W.sec8A._id })).status).toBe(200);
    // the English teacher sees the submitted sheet and can no longer change it
    expect((await api().put(T('/marks/sheet')).set(W.teacher2.h).send({ examSubjectId: esEng._id, sectionId: W.sec8A._id, marks: marks.slice(0, 1) })).status).toBe(409);
  });

  it('the class teacher can add a class test in any subject of his class; a subject teacher cannot add one in a subject they do not teach', async () => {
    const body = { name: 'Surprise Quiz', type: 'class_test', sectionId: W.sec8A._id, subjectId: esEng.subjectId, date: todayStr(), components: [{ label: 'Marks', max: 20 }] };
    const ok = await api().post(T('/exams')).set(W.teacher1.h).send(body);
    expect([200, 201]).toContain(ok.status);
    const no = await api().post(T('/exams')).set(W.teacher2.h).send({ ...body, name: 'Not allowed', subjectId: esMaths.subjectId });
    expect(no.status).toBe(403);
  });

  it('the class teacher\'s page for a student has the whole picture, including marks not published yet; a subject teacher gets the thin view', async () => {
    const d = (await api().get(T(`/students/${kid}`)).set(W.teacher1.h)).body;
    expect(d.full).toBeTruthy();
    expect(d.full.guardians.length).toBeGreaterThan(0);
    expect(d.full.personal).toHaveProperty('dob');
    expect(d.full).toHaveProperty('bus');
    // English was entered and submitted above but not published: the class teacher can see it
    expect(d.full.pending.find((p) => p.subject === 'English')).toMatchObject({ exam: 'Half Yearly', status: 'submitted', obtained: 50, max: 100 });
    // fees and personal documents are not part of it
    expect(JSON.stringify(d)).not.toMatch(/outstanding|receiptNo|documents/i);
    // a subject teacher of the same student gets no such file
    expect((await api().get(T(`/students/${kid}`)).set(W.teacher2.h)).body.full).toBeNull();
  });
});
