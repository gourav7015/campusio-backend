import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');
const workingDay = (back) => { let d = addDays(TODAY, -back); while (new Date(`${d}T00:00:00Z`).getUTCDay() === 0) d = addDays(d, -1); return d; };

describe('The class teacher can edit an earlier register', () => {
  let root; let W;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'te'); });
  afterAll(teardown);

  it('changes a submitted register of an earlier date; history is kept and the student is told', async () => {
    const d = workingDay(4);
    const q = (date) => `/api/teacher/attendance/register?sectionId=${W.sec8A._id}&date=${date}`;
    const reg = (await api().get(q(d)).set(W.teacher1.h)).body;
    const all = reg.students.map((s) => ({ studentId: s.studentId, status: 'present' }));
    expect((await api().post('/api/teacher/attendance/register/submit').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: d, entries: all })).status).toBe(200);
    const after = (await api().get(q(d)).set(W.teacher1.h)).body;
    expect(after).toMatchObject({ canEdit: true, canCorrect: false });
    // Aarav was in fact absent, and another is a half day in the second session
    const edit = all.map((e, i) => (i === 0 ? { ...e, status: 'absent' } : i === 1 ? { ...e, status: 'half_day', halfSession: 'second' } : e));
    const r = await api().post('/api/teacher/attendance/register/submit').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: d, entries: edit });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ edited: true, changed: 2 });
    expect(r.body.totals).toMatchObject({ absent: 1, half_day: 1 });
    const now = (await api().get(q(d)).set(W.teacher1.h)).body.students;
    expect(now[0].status).toBe('absent'); expect(now[1]).toMatchObject({ status: 'half_day', halfSession: 'second' });
    // the student sees the new status, flagged as corrected, and was told
    const hist = (await api().get('/api/student/attendance/history').set(W.studentLogins[0].h)).body.find((x) => x.date === d);
    expect(hist).toMatchObject({ status: 'absent', corrected: true });
    expect(JSON.stringify((await api().get('/api/student/notifications?category=attendance').set(W.studentLogins[0].h)).body)).toContain('Attendance corrected');
    // the change is in the school's audit log
    expect((await api().get('/api/school/audit?action=attendance.edited').set(W.h)).body).toHaveLength(1);
  });

  it('only the class teacher, only for a real working day in the past', async () => {
    const d = workingDay(4);
    expect((await api().post('/api/teacher/attendance/register/submit').set(W.teacher2.h).send({ sectionId: W.sec8A._id, date: d, entries: [] })).status).toBe(403);
    const future = addDays(TODAY, 3);
    expect((await api().post('/api/teacher/attendance/register/submit').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: future, entries: [] })).status).toBe(400);
  });
});
