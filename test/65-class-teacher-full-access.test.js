import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';

/** The class teacher sees everything of their own class: the register, the monitors, the class report, and the marks sheets of every subject (to read). Marks and tests are entered only by the teacher of that subject. */
describe('class teacher: sees all of their own class, enters marks only for their own subjects', () => {
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

  it('the class teacher can look at every subject\'s marks sheet of his class, but only the subject\'s own teacher can enter, change or submit it', async () => {
    const look = await api().get(T(`/marks/sheet?examSubjectId=${esEng._id}&sectionId=${W.sec8A._id}`)).set(W.teacher1.h);
    expect(look.status).toBe(200); expect(look.body.canEdit).toBe(false); expect(look.body.readOnlyForYou).toBe(true);
    const students = look.body.students; kid = students[0].studentId;
    const marks = students.map((s, i) => ({ studentId: s.studentId, values: { marks: 50 + i } }));
    // not his subject: refused, with a reason he can read
    const no = await api().put(T('/marks/sheet')).set(W.teacher1.h).send({ examSubjectId: esEng._id, sectionId: W.sec8A._id, marks });
    expect(no.status).toBe(403); expect(JSON.stringify(no.body)).toMatch(/Only the teacher of this subject/);
    expect((await api().post(T('/marks/sheet/submit')).set(W.teacher1.h).send({ examSubjectId: esEng._id, sectionId: W.sec8A._id })).status).toBe(403);
    // the English teacher enters and submits it
    const mine = await api().get(T(`/marks/sheet?examSubjectId=${esEng._id}&sectionId=${W.sec8A._id}`)).set(W.teacher2.h);
    expect(mine.body.canEdit).toBe(true); expect(mine.body.readOnlyForYou).toBe(false);
    expect((await api().put(T('/marks/sheet')).set(W.teacher2.h).send({ examSubjectId: esEng._id, sectionId: W.sec8A._id, marks })).status).toBe(200);
    expect((await api().post(T('/marks/sheet/submit')).set(W.teacher2.h).send({ examSubjectId: esEng._id, sectionId: W.sec8A._id })).status).toBe(200);
    // the class teacher follows it: listed with who teaches it, and not enterable by him
    expect((await api().get(T('/exams')).set(W.teacher1.h)).body.some((r) => r.examSubjectId === esEng._id)).toBe(false); // the Marks page lists only the subjects he teaches
    const row = (await api().get(T('/exams?classView=1')).set(W.teacher1.h)).body.find((r) => r.examSubjectId === esEng._id && r.sectionId === W.sec8A._id);
    expect(row).toMatchObject({ viaClassTeacher: true, canEnter: false, teacher: 'Mrs Gupta', status: 'submitted' });
    const own = (await api().get(T('/exams?classView=1')).set(W.teacher1.h)).body.find((r) => r.examSubjectId === esMaths._id && r.sectionId === W.sec8A._id);
    expect(own).toMatchObject({ viaClassTeacher: false, canEnter: true });
  });

  it('a class test can be added only in a subject the teacher teaches, class teacher or not', async () => {
    const body = { name: 'Surprise Quiz', type: 'class_test', sectionId: W.sec8A._id, subjectId: esEng.subjectId, date: todayStr(), components: [{ label: 'Marks', max: 20 }] };
    expect((await api().post(T('/exams')).set(W.teacher1.h).send(body)).status).toBe(403); // English is Mrs Gupta's, even in Mr Sharma's own class
    expect([200, 201]).toContain((await api().post(T('/exams')).set(W.teacher2.h).send(body)).status);
    expect((await api().post(T('/exams')).set(W.teacher2.h).send({ ...body, name: 'Not allowed', subjectId: esMaths.subjectId })).status).toBe(403);
    expect([200, 201]).toContain((await api().post(T('/exams')).set(W.teacher1.h).send({ ...body, name: 'Maths quiz', subjectId: esMaths.subjectId })).status);
  });

  it('the class teacher\'s page for a student has the whole picture, including marks not published yet; a subject teacher gets the thin view', async () => {
    const d = (await api().get(T(`/students/${kid}`)).set(W.teacher1.h)).body;
    expect(d.full).toBeTruthy();
    expect(d.full.guardians.length).toBeGreaterThan(0);
    expect(d.full.personal).toHaveProperty('dob');
    expect(d.full).toHaveProperty('bus');
    // English was entered and submitted by its own teacher but not published: the class teacher can see it
    expect(d.full.pending.find((p) => p.subject === 'English')).toMatchObject({ exam: 'Half Yearly', status: 'submitted', obtained: 50, max: 100 });
    // fees and personal documents are not part of it
    expect(JSON.stringify(d)).not.toMatch(/outstanding|receiptNo|documents/i);
    // a subject teacher of the same student gets no such file
    expect((await api().get(T(`/students/${kid}`)).set(W.teacher2.h)).body.full).toBeNull();
  });
});
