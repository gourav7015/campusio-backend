import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { todayStr, addDays, isoDay } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');
const YESTERDAY = addDays(TODAY, -1);

describe('Period by period attendance is shown by subject, and earlier once-a-day days stay on their own', () => {
  let W; let T1; let T2; let A; let B; let C; let ent; let stu;
  beforeAll(async () => {
    await setup(); await reset(); const root = await makeSuperAdmin(); W = await seedWorld(root, 'sub');
    T1 = W.teacher1.h; T2 = W.teacher2.h; [A, B, C] = W.students.map((s) => s.student._id); stu = W.studentLogins[0].h;
    await api().put('/api/school/settings').set(W.h).send({ workingDays: [1, 2, 3, 4, 5, 6, 7] });
    // yesterday the class teacher took one register for the whole day
    await api().put('/api/teacher/attendance/register').set(T1).send({ sectionId: W.sec8A._id, date: YESTERDAY, entries: [{ studentId: A, status: 'absent' }, { studentId: B, status: 'present' }, { studentId: C, status: 'present' }] });
    expect((await api().post('/api/teacher/attendance/register/submit').set(T1).send({ sectionId: W.sec8A._id, date: YESTERDAY, entries: [{ studentId: A, status: 'absent' }, { studentId: B, status: 'present' }, { studentId: C, status: 'present' }] })).status).toBe(200);
    // from today every period has its own register
    expect((await api().put('/api/school/attendance-mode').set(W.h).send({ periodWise: true, from: TODAY })).status).toBe(200);
    const day = isoDay(TODAY);
    const mk = (periodId, assignmentId) => api().post('/api/school/timetable/entries').set(W.h).send({ sectionId: W.sec8A._id, day, periodId, assignmentId });
    ent = [(await mk(W.periods[0]._id, W.asgM._id)).body.entry, (await mk(W.periods[1]._id, W.asgE._id)).body.entry, (await mk(W.periods[2]._id, W.asgM._id)).body.entry];
    const send = (h, e, s) => api().post('/api/teacher/period-attendance/register/submit').set(h).send({ entryId: e._id, date: TODAY, entries: [A, B, C].map((id, i) => ({ studentId: id, status: s[i] })) });
    await send(T1, ent[0], ['absent', 'present', 'late']);   // Mathematics
    await send(T2, ent[1], ['absent', 'present', 'present']); // English
    await send(T1, ent[2], ['present', 'absent', 'present']); // Mathematics
  }, 120000);
  afterAll(teardown);

  it('gives each subject its own count, percentage and what to do next, the ones needing attention first', async () => {
    const d = (await api().get('/api/student/period-attendance/subjects').set(stu)).body; // Aarav: absent, absent, present
    expect(d.target).toBe(75);
    expect(d.totals).toMatchObject({ periods: 3, attended: 1, absent: 2, percentage: 33.3, below: 2 });
    expect(d.subjects.map((s) => s.subject)).toEqual(['English', 'Mathematics']); // 0% first
    const m = d.subjects.find((s) => s.subject === 'Mathematics');
    expect(m).toMatchObject({ periods: 2, attended: 1, absent: 1, percentage: 50, state: 'low', recent: ['absent', 'present'] });
    expect(m.needed).toBe(2); // attend the next 2 in a row: (1 + 2) / (2 + 2) = 75%
    const e = d.subjects.find((s) => s.subject === 'English');
    expect(e).toMatchObject({ periods: 1, attended: 0, state: 'low', needed: 3 });
    expect(d.weekly.at(-1)).toMatchObject({ periods: 3 });
    // Chirag: late, present, present: all counted as present
    const c = (await api().get('/api/student/period-attendance/subjects').set(W.studentLogins[2].h)).body;
    expect(c.totals).toMatchObject({ periods: 3, attended: 3, percentage: 100, below: 0 });
    expect(c.subjects.every((s) => s.state === 'good' && s.canMiss >= 0)).toBe(true);
  });

  it('lists every period of one subject, newest first, and only the student\'s own', async () => {
    const subjects = (await api().get('/api/student/period-attendance/subjects').set(stu)).body.subjects;
    const m = subjects.find((s) => s.subject === 'Mathematics');
    const rows = (await api().get(`/api/student/period-attendance/subjects/${m.subjectId}`).set(stu)).body;
    expect(rows.subject).toBe('Mathematics');
    expect(rows.rows.map((r) => r.status)).toEqual(['absent', 'present']);
    expect(rows.rows[0]).toMatchObject({ date: TODAY, period: 'Period 1' });
    expect((await api().get('/api/student/period-attendance/subjects/not-an-id').set(stu)).status).toBe(400);
  });

  it('keeps the earlier once-a-day days apart from the days worked out from periods', async () => {
    const all = (await api().get('/api/student/attendance/summary').set(stu)).body;
    const reg = (await api().get('/api/student/attendance/summary?source=register').set(stu)).body;
    expect(all.workingDays).toBe(2); expect(reg.workingDays).toBe(1); expect(reg.absent).toBe(1);
    expect((await api().get('/api/student/attendance/history?source=register').set(stu)).body.map((r) => r.date)).toEqual([YESTERDAY]);
    expect((await api().get('/api/student/attendance/monthly?source=register').set(stu)).body.reduce((n, m) => n + m.workingDays, 0)).toBe(1);
  });

  it('gives the School Admin and the class teacher the same view of a student, and nobody else', async () => {
    const o = (await api().get(`/api/school/students/${A}/overview`).set(W.h)).body.attendance;
    expect(o.periodWise).toBe(true); expect(o.days).toEqual([]);
    expect(o.periods.totals).toMatchObject({ periods: 3, attended: 1 });
    expect(o.earlier).toMatchObject({ workingDays: 1, absent: 1, until: YESTERDAY });
    const m = o.periods.subjects.find((s) => s.subject === 'Mathematics');
    expect((await api().get(`/api/school/students/${A}/attendance-subject/${m.subjectId}`).set(W.h)).body.rows).toHaveLength(2);
    // the class teacher (Mr Sharma) reads it through the office view; a teacher who is not the class teacher cannot
    expect((await api().get(`/api/teacher/office/students/${A}/overview`).set(T1)).body.attendance.periods.totals.periods).toBe(3);
    expect((await api().get(`/api/teacher/office/students/${A}/attendance-subject/${m.subjectId}`).set(T1)).status).toBe(200);
    expect((await api().get(`/api/teacher/office/students/${A}/attendance-subject/${m.subjectId}`).set(T2)).status).toBe(403);
    // the whole class at once: every student, in lessons
    const cls = (await api().get(`/api/school/sections/${W.sec8A._id}/period-attendance`).set(W.h)).body;
    expect(cls.periodWise).toBe(true); expect(cls.target).toBe(75);
    expect(cls.students.map((x) => x.name)).toEqual(['Aarav Singh', 'Bhavna Rao', 'Chirag Das']);
    expect(cls.students[0]).toMatchObject({ periods: 3, attended: 1, absent: 2, percentage: 33.3, state: 'low', below: 2 });
    expect(cls.students[2]).toMatchObject({ percentage: 100, state: 'good', below: 0 });
    expect(cls.totals).toMatchObject({ students: 3, marked: 3, below: 2 }); // Bhavna (2 of 3) is below as well
    expect(cls.subjects.map((x) => x.subject).sort()).toEqual(['English', 'Mathematics']);
    expect((await api().get(`/api/teacher/office/sections/${W.sec8A._id}/period-attendance`).set(T1)).status).toBe(200);
    expect((await api().get(`/api/teacher/office/sections/${W.sec8A._id}/period-attendance`).set(T2)).status).toBe(403); // not the class teacher
    expect((await api().get(`/api/school/sections/${W.sec8B._id}/period-attendance`).set(W.h)).body.students).toEqual([]);
  });
});
