import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');
const workingDay = () => { let d = addDays(TODAY, -1); while (new Date(`${d}T00:00:00Z`).getUTCDay() === 0) d = addDays(d, -1); return d; };

describe('Student attendance: a half day counts as half a day attended', () => {
  let root; let W;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'hd2'); });
  afterAll(teardown);

  it('the class teacher marks a half day; it is counted as half in the percentage, and shown in the totals', async () => {
    const d = workingDay();
    const reg = (await api().get(`/api/teacher/attendance/register?sectionId=${W.sec8A._id}&date=${d}`).set(W.teacher1.h)).body;
    const [a, b, c] = reg.students;
    const sub = await api().post('/api/teacher/attendance/register/submit').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: d, entries: [{ studentId: a.studentId, status: 'present' }, { studentId: b.studentId, status: 'half_day' }, { studentId: c.studentId, status: 'absent' }] });
    expect(sub.status).toBe(200);
    expect(sub.body.totals ?? sub.body.session?.totals ?? sub.body).toBeTruthy();
    // the admin's overview counts it separately
    const ov = (await api().get(`/api/school/attendance/overview?date=${d}`).set(W.h)).body;
    expect(ov.totals).toMatchObject({ present: 1, half_day: 1, absent: 1 });
    // the student with the half day: 0.5 of 1 day attended = 50%
    const me = (await api().get('/api/student/attendance/summary').set(W.studentLogins.find((s) => s.student?._id === b.studentId || s.studentId === b.studentId)?.h || W.studentLogins[1].h)).body;
    const summary = me.summary || me;
    expect(summary.half_day).toBe(1);
    expect(summary.percentage).toBe(50);
    expect((await api().post('/api/teacher/attendance/register/submit').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: addDays(d, -1), entries: [{ studentId: a.studentId, status: 'sometimes' }] })).status).toBe(400);
  });

  it('a half day says which session was attended, for students and for staff alike', async () => {
    const day = (() => { let x = addDays(TODAY, -3); while (new Date(`${x}T00:00:00Z`).getUTCDay() === 0) x = addDays(x, -1); return x; })();
    // students: the class teacher marks one half day for the second session and one without saying (the first session is assumed)
    const reg = (await api().get(`/api/teacher/attendance/register?sectionId=${W.sec8A._id}&date=${day}`).set(W.teacher1.h)).body;
    const [a, b, c] = reg.students;
    const sub = await api().post('/api/teacher/attendance/register/submit').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: day, entries: [{ studentId: a.studentId, status: 'half_day', halfSession: 'second' }, { studentId: b.studentId, status: 'half_day' }, { studentId: c.studentId, status: 'present', halfSession: 'second' }] });
    expect(sub.status).toBe(200);
    const after = (await api().get(`/api/school/attendance/register?sectionId=${W.sec8A._id}&date=${day}`).set(W.h)).body.students;
    expect(after.find((x) => x.studentId === a.studentId)).toMatchObject({ status: 'half_day', halfSession: 'second' });
    expect(after.find((x) => x.studentId === b.studentId)).toMatchObject({ status: 'half_day', halfSession: 'first' });
    expect(after.find((x) => x.studentId === c.studentId).halfSession).toBeNull(); // a session only means something for a half day
    // the admin corrects the session, with a reason
    expect((await api().post('/api/school/attendance/correct').set(W.h).send({ sectionId: W.sec8A._id, date: day, studentId: b.studentId, status: 'half_day', halfSession: 'second', reason: 'Left after lunch, not before' })).status).toBe(200);
    expect((await api().get(`/api/school/attendance/register?sectionId=${W.sec8A._id}&date=${day}`).set(W.h)).body.students.find((x) => x.studentId === b.studentId).halfSession).toBe('second');
    expect((await api().post('/api/teacher/attendance/register/submit').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: addDays(day, -1), entries: [{ studentId: a.studentId, status: 'half_day', halfSession: 'third' }] })).status).toBe(400);
    // staff: the same on the teachers' register
    const sreg = (await api().get(`/api/school/staff-attendance/register?group=teachers&date=${day}`).set(W.h)).body;
    const t = sreg.rows[0];
    const saved = await api().put('/api/school/staff-attendance/register').set(W.h).send({ group: 'teachers', date: day, submit: false, entries: [{ personId: t.personId, status: 'half_day', halfSession: 'second' }] });
    expect(saved.status).toBe(200);
    expect(saved.body.rows.find((r) => r.personId === t.personId)).toMatchObject({ status: 'half_day', halfSession: 'second' });
    const t2 = sreg.rows[1];
    const noSession = await api().put('/api/school/staff-attendance/register').set(W.h).send({ group: 'teachers', date: day, submit: true, entries: [{ personId: t2.personId, status: 'half_day' }] });
    expect(noSession.body.rows.find((r) => r.personId === t2.personId)).toMatchObject({ status: 'half_day', halfSession: 'first' });
    expect(noSession.body.rows.find((r) => r.personId === t.personId)).toMatchObject({ halfSession: 'second' }); // the draft kept the session
    expect((await api().post('/api/school/staff-attendance/correct').set(W.h).send({ group: 'teachers', date: day, personId: t2.personId, status: 'half_day', halfSession: 'second', reason: 'Came in the afternoon' })).body.rows.find((r) => r.personId === t2.personId).halfSession).toBe('second');
  });
});
