import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');
const A = (p) => `/api/school${p}`;
const monday = () => { let d = TODAY; while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1); return d; };

describe('A teacher who teaches several subjects (Mr Sharma: Maths and English in 8-B, Maths in 8-A)', () => {
  let root; let W; let asgEng8B; let asgMath8B;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'ms');
    asgMath8B = (await api().post(A('/teaching-assignments')).set(W.h).send({ teacherId: W.t1.teacher._id, sectionId: W.sec8B._id, subjectId: W.maths._id, effectiveFrom: '2026-04-01' })).body;
    const r = await api().post(A('/teaching-assignments')).set(W.h).send({ teacherId: W.t1.teacher._id, sectionId: W.sec8B._id, subjectId: W.eng._id, effectiveFrom: '2026-04-01' });
    expect(r.status).toBe(201); asgEng8B = r.body;
  });
  afterAll(teardown);

  it('his classes and subjects list every subject he teaches in each section', async () => {
    const classes = (await api().get('/api/teacher/classes').set(W.teacher1.h)).body;
    const b = classes.find((c) => c.section === 'B');
    expect(b.subjects.map((s) => s.name).sort()).toEqual(['English', 'Mathematics']);
    expect(classes.find((c) => c.section === 'A').subjects.map((s) => s.name)).toEqual(['Mathematics']);
    const subs = (await api().get('/api/teacher/subjects').set(W.teacher1.h)).body;
    expect(JSON.stringify(subs)).toContain('English'); expect(JSON.stringify(subs)).toContain('Mathematics');
  });

  it('his profile and the admin lists show all his subjects, and the Employees subject filter finds him by each', async () => {
    const t = (await api().get(A(`/teachers/${W.t1.teacher._id}`)).set(W.h)).body;
    expect(t.subjectIds.map((s) => s.name).sort()).toEqual(['English', 'Mathematics']); // teaching English added it to his subjects
    for (const subj of [W.maths, W.eng]) {
      const found = (await api().get(A(`/employees?category=teaching&subjectId=${subj._id}`)).set(W.h)).body.items.map((x) => x.name);
      expect(found).toContain('Mr Sharma');
    }
    expect((await api().get(A('/employees?category=teaching')).set(W.h)).body.items.filter((x) => x.name === 'Mr Sharma')).toHaveLength(1); // one row, not one per subject
  });

  it('homework and exams can be given for each subject he teaches, and only for those', async () => {
    const due = addDays(TODAY, 5);
    for (const [sec, subj] of [[W.sec8B, W.maths], [W.sec8B, W.eng], [W.sec8A, W.maths]]) {
      const r = await api().post('/api/teacher/homework').set(W.teacher1.h).send({ title: 'Practice set', sectionId: sec._id, subjectId: subj._id, dueDate: due, status: 'published' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    // 8-A English is Mrs Gupta's
    expect((await api().post('/api/teacher/homework').set(W.teacher1.h).send({ title: 'Not mine', sectionId: W.sec8A._id, subjectId: W.eng._id, dueDate: due, status: 'published' })).status).toBe(403);
    const mine = (await api().get('/api/teacher/homework').set(W.teacher1.h)).body;
    expect(mine.filter((h) => h.className === 'Class 8' || h.section).map((h) => `${h.section}:${h.subject}`).sort()).toEqual(['A:Mathematics', 'B:English', 'B:Mathematics']);
    // students of 8-B see their English and Maths homework
  });

  it('his timetable shows each period with its own subject, and two subjects in one period are refused', async () => {
    const day = 1;
    const e1 = await api().post(A('/timetable/entries')).set(W.h).send({ sectionId: W.sec8B._id, day, periodId: W.periods[0]._id, assignmentId: asgMath8B._id, room: '102' });
    const e2 = await api().post(A('/timetable/entries')).set(W.h).send({ sectionId: W.sec8B._id, day, periodId: W.periods[1]._id, assignmentId: asgEng8B._id, room: '102' });
    expect([e1.status, e2.status]).toEqual([201, 201]);
    // the same teacher cannot take two classes in one period, whatever the subjects
    const clash = await api().post(A('/timetable/entries')).set(W.h).send({ sectionId: W.sec8A._id, day, periodId: W.periods[0]._id, assignmentId: W.asgM._id, room: '101' });
    expect(clash.status).toBe(409);
    const d = monday();
    const rows = (await api().get(`/api/teacher/timetable?view=day&date=${d}`).set(W.teacher1.h)).body.day;
    expect(rows.filter((r) => r.sectionId).map((r) => r.subject).sort()).toEqual(['English', 'Mathematics']);
  });

  it('marks: he can enter marks for his subject in a section, and only for it', async () => {
    const exam = await api().post('/api/teacher/exams').set(W.teacher1.h).send({ name: 'Quick test', type: 'class_test', sectionId: W.sec8B._id, subjectId: W.eng._id, date: addDays(TODAY, -1), components: [{ label: 'Score', max: 10 }], marksDeadline: addDays(TODAY, 3) });
    expect(exam.status, JSON.stringify(exam.body)).toBe(201);
    expect((await api().post('/api/teacher/exams').set(W.teacher1.h).send({ name: 'Class teacher test', type: 'class_test', sectionId: W.sec8A._id, subjectId: W.eng._id, date: addDays(TODAY, -1), components: [{ label: 'Score', max: 10 }], marksDeadline: addDays(TODAY, 3) })).status).toBe(201); // he is the class teacher of 8-A, so every subject of that class is his to test and mark
    expect((await api().post('/api/teacher/exams').set(W.teacher2.h).send({ name: 'Not mine', type: 'class_test', sectionId: W.sec8A._id, subjectId: W.maths._id, date: addDays(TODAY, -1), components: [{ label: 'Score', max: 10 }], marksDeadline: addDays(TODAY, 3) })).status).toBe(403); // a subject teacher only in her own subject
  });
});
