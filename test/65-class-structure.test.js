import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';

describe('Class structure: subjects per class, teachers assigned by hand, and gaps shown', () => {
  let root; let W; let y2;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'cs'); });
  afterAll(teardown);
  const S = (id) => `/api/school/offerings/structure?yearId=${id}`;

  it('shows each class with its sections, subjects and who teaches them, and lists what is missing', async () => {
    const s = (await api().get(S(W.year._id)).set(W.h)).body;
    const c8 = s.classes.find((c) => c.className === 'Class 8');
    expect(c8.sections.map((x) => x.name)).toEqual(['A', 'B']);
    expect(c8.sections.find((x) => x.name === 'A').classTeacher.name).toBe('Mr Sharma');
    expect(c8.subjects.map((x) => x.subject).sort()).toEqual(['English', 'Mathematics']);
    expect(c8.subjects.find((x) => x.subject === 'Mathematics').teachers.find((t) => t.teacher === 'Mr Sharma')).toBeTruthy();
    // Section B has no class teacher and nobody teaching either subject
    expect(c8.gaps.noClassTeacher).toEqual(['B']);
    expect(c8.gaps.noTeacher).toEqual(expect.arrayContaining([{ subject: 'English', sections: ['B'] }, { subject: 'Mathematics', sections: ['B'] }]));
    expect(s.summary).toMatchObject({ sectionsWithoutClassTeacher: 1, subjectsWithoutTeacher: 2 });
  });

  it('the dashboards of the office and of the class teacher both show the gaps', async () => {
    const d = (await api().get('/api/school/dashboard').set(W.h)).body;
    expect(d.coverage).toMatchObject({ sectionsWithoutClassTeacher: 1, subjectsWithoutTeacher: 2 });
    expect(d.coverage.classes[0]).toMatchObject({ className: 'Class 8', noClassTeacher: ['B'] });
    // Mr Sharma is class teacher of 8A only: its subjects are all taught, so nothing is missing there until a subject is added
    expect((await api().get('/api/teacher/dashboard').set(W.teacher1.h)).body.classGaps).toEqual([]);
  });

  it('subjects are added to and removed from a class; a new subject has no teacher until one is assigned', async () => {
    const add = (b) => api().post('/api/school/offerings').set(W.h).send({ yearId: W.year._id, classId: W.c8._id, ...b });
    expect((await add({})).status).toBe(400);
    const sci = await add({ subject: 'Science', weeklyPeriods: 4 }); expect(sci.status).toBe(201);
    expect((await add({ subject: 'science' })).status).toBe(409); // already a subject of the class
    const tgap = (await api().get('/api/teacher/dashboard').set(W.teacher1.h)).body.classGaps;
    expect(tgap).toEqual([{ sectionId: W.sec8A._id, section: 'Class 8 A', subjectsWithoutTeacher: ['Science'], noSubjects: false }]); // the class teacher sees it
    // a teacher is assigned by hand, and the gap in 8A closes
    const asg = await api().post('/api/school/teaching-assignments').set(W.h).send({ teacherId: W.t2.teacher._id, sectionId: W.sec8A._id, subject: 'Science' });
    expect(asg.status).toBe(201);
    expect((await api().get('/api/teacher/dashboard').set(W.teacher1.h)).body.classGaps).toEqual([]);
    // with a teacher on it the subject cannot be removed; one nobody teaches can
    const del = await api().delete(`/api/school/offerings/${sci.body._id}`).set(W.h); expect(del.status).toBe(409); expect(del.body.error).toMatch(/End them first/);
    const art = await add({ subject: 'Art' });
    expect((await api().delete(`/api/school/offerings/${art.body._id}`).set(W.h)).status).toBe(200);
    expect((await api().delete(`/api/school/offerings/${art.body._id}`).set(W.h)).status).toBe(404);
    // ending the teacher keeps it as history: removal is refused
    await api().post(`/api/school/teaching-assignments/${asg.body._id}/end`).set(W.h).send({});
    const hist = await api().delete(`/api/school/offerings/${sci.body._id}`).set(W.h); expect(hist.status).toBe(400); expect(hist.body.error).toMatch(/kept as history/);
    expect((await api().post('/api/school/offerings').set(W.teacher1.h).send({ yearId: W.year._id, classId: W.c8._id, subject: 'X Y' })).status).toBe(403);
  });

  it('the school keeps a list of subjects: add, rename, give to many classes at once, delete only what nobody uses', async () => {
    const add = (name) => api().post('/api/school/subjects').set(W.h).send({ name });
    expect((await add('x')).status).toBe(400);
    const music = await add('Music'); expect(music.status).toBe(201);
    expect((await add('music')).status).toBe(409); // same name, any capitals
    const usage = (y) => api().get(`/api/school/subjects/usage?yearId=${y}`).set(W.h);
    expect((await usage(W.year._id)).body.find((s) => s.name === 'Music').classes).toEqual([]);
    // one subject to two classes in one go; a class that has it is skipped
    const bulk = (classIds) => api().post('/api/school/offerings/bulk').set(W.h).send({ yearId: W.year._id, subjectId: music.body._id, classIds, weeklyPeriods: 2 });
    expect((await bulk([W.c8._id, W.c9._id])).body).toEqual({ created: 2, skipped: 0 });
    expect((await bulk([W.c8._id])).body).toEqual({ created: 0, skipped: 1 });
    expect((await usage(W.year._id)).body.find((s) => s.name === 'Music').classes.map((c) => c.className)).toEqual(['Class 8', 'Class 9']);
    expect((await api().post('/api/school/offerings/bulk').set(W.teacher1.h).send({ yearId: W.year._id, subjectId: music.body._id, classIds: [W.c8._id] })).status).toBe(403);
    // renaming keeps it in the classes; a name already taken is refused
    expect((await api().patch(`/api/school/subjects/${music.body._id}`).set(W.h).send({ name: 'English' })).status).toBe(409);
    expect((await api().patch(`/api/school/subjects/${music.body._id}`).set(W.h).send({ name: 'Music and Dance' })).status).toBe(200);
    expect((await usage(W.year._id)).body.find((s) => s.name === 'Music and Dance').classes).toHaveLength(2);
    // in use by classes: cannot be deleted; once taken out of them, it can
    const used = await api().delete(`/api/school/subjects/${music.body._id}`).set(W.h); expect(used.status).toBe(409); expect(used.body.error).toMatch(/Remove it from the classes first/);
    for (const c of (await usage(W.year._id)).body.find((s) => s.name === 'Music and Dance').classes) await api().delete(`/api/school/offerings/${c.offeringId}`).set(W.h);
    expect((await api().delete(`/api/school/subjects/${music.body._id}`).set(W.h)).status).toBe(200);
    expect((await usage(W.year._id)).body.some((s) => s.name === 'Music and Dance')).toBe(false);
    const taught = (await usage(W.year._id)).body.find((s) => s.name === 'Mathematics');
    expect((await api().delete(`/api/school/subjects/${taught.id}`).set(W.h)).status).toBe(409); // teachers and classes use it
  });

  it('a teacher can be in charge of only one class at a time', async () => {
    // Mr Sharma is class teacher of 8A: he cannot also take 8B, but he can swap once he is released
    const to8B = (t) => api().put(`/api/school/sections/${W.sec8B._id}/class-teacher`).set(W.h).send({ teacherId: t });
    const refused = await to8B(W.t1.teacher._id); expect(refused.status).toBe(409); expect(refused.body.error).toMatch(/already the class teacher of Class 8 A/);
    expect((await to8B(W.t2.teacher._id)).status).toBe(200); // Mrs Gupta is free
    const s = (await api().get(S(W.year._id)).set(W.h)).body;
    expect(s.summary.teachersInChargeOfTwo).toEqual([]);
    expect((await api().put(`/api/school/sections/${W.sec8A._id}/class-teacher`).set(W.h).send({ teacherId: W.t2.teacher._id })).status).toBe(409); // she is busy with 8B now
    await api().delete(`/api/school/sections/${W.sec8B._id}/class-teacher`).set(W.h);
    expect((await to8B(W.t1.teacher._id)).status).toBe(409); // still in charge of 8A
  });

  it('the next year gets the same sections and subjects, with no teachers unless asked for; every class shows as needing teachers', async () => {
    const r = await api().post('/api/school/years/rollover').set(W.h).send({ fromYearId: W.year._id, name: '2027-2028', startDate: '2027-04-01', endDate: '2028-03-31' });
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ subjectTeachers: 0, classTeachers: 0 });
    y2 = r.body.year;
    const s = (await api().get(S(y2._id)).set(W.h)).body;
    const c8 = s.classes.find((c) => c.className === 'Class 8');
    expect(c8.subjects.length).toBeGreaterThanOrEqual(3); expect(c8.gaps.noClassTeacher).toEqual(['A', 'B']);
    expect(s.summary.subjectsWithoutTeacher).toBeGreaterThan(0);
    // the office adds a subject for the new class only; last year's class keeps its own
    await api().post('/api/school/offerings').set(W.h).send({ yearId: y2._id, classId: W.c8._id, subject: 'Computer Science' });
    expect((await api().get(S(y2._id)).set(W.h)).body.classes.find((c) => c.className === 'Class 8').subjects.map((x) => x.subject)).toContain('Computer Science');
    expect((await api().get(S(W.year._id)).set(W.h)).body.classes.find((c) => c.className === 'Class 8').subjects.map((x) => x.subject)).not.toContain('Computer Science');
  });
});
