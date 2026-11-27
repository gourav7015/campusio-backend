import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { todayStr, addDays, isoDay } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');
const TOMORROW = addDays(TODAY, 1);

describe('Student attendance: once a day OR period by period', () => {
  let root; let W; let O; let T1; let T2; let A; let B; let C; let ent;
  const notesOf = async (login, cat = 'attendance') => (await api().get(`/api/student/notifications?category=${cat}`).set(login.h)).body.items || [];
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'mode'); O = await seedWorld(root, 'other');
    T1 = W.teacher1.h; T2 = W.teacher2.h;
    [A, B, C] = W.students.map((s) => s.student._id);
    await api().put('/api/school/settings').set(W.h).send({ workingDays: [1, 2, 3, 4, 5, 6, 7] }); // so the tests do not depend on the weekday
    const day = isoDay(TODAY);
    const mk = (periodId, assignmentId) => api().post('/api/school/timetable/entries').set(W.h).send({ sectionId: W.sec8A._id, day, periodId, assignmentId });
    ent = [(await mk(W.periods[0]._id, W.asgM._id)).body.entry, (await mk(W.periods[1]._id, W.asgE._id)).body.entry, (await mk(W.periods[2]._id, W.asgM._id)).body.entry];
  }, 120000);
  afterAll(teardown);

  it('a school takes attendance once a day until it chooses otherwise; the settings form cannot change the way', async () => {
    const info = (await api().get('/api/school/attendance-mode').set(W.h)).body;
    expect(info).toMatchObject({ periodWise: false, pending: null, earliest: TODAY, dayRule: { presentPct: 75, halfPct: 40 } });
    expect((await api().put('/api/school/settings').set(W.h).send({ attendance: { periodWise: true } })).status).toBe(200);
    expect((await api().get('/api/school/attendance-mode').set(W.h)).body.periodWise).toBe(false); // ignored
    expect((await api().get('/api/teacher/period-attendance/register').query({ entryId: ent[0]._id, date: TODAY }).set(T1)).status).toBe(409);
    expect((await api().get('/api/student/period-attendance').set(W.studentLogins[0].h)).body).toMatchObject({ enabled: false, periods: [] });
  });

  it('the day rule is checked: half a day must need fewer periods than a full day', async () => {
    expect((await api().put('/api/school/settings').set(W.h).send({ attendance: { dayRule: { presentPct: 50, halfPct: 60 } } })).status).toBe(400);
    expect((await api().put('/api/school/settings').set(W.h).send({ attendance: { dayRule: { presentPct: 75, halfPct: 40 } } })).status).toBe(200);
  });

  it('a change is refused for a past date, and only AtKaksha can make it: the School Admin, a teacher and a student are all refused', async () => {
    expect((await api().put(`/api/platform/schools/${W.id}/attendance-mode`).set(root.h).send({ periodWise: true, from: addDays(TODAY, -1) })).status).toBe(400);
    expect((await api().put(`/api/platform/schools/${W.id}/attendance-mode`).set(root.h).send({ periodWise: false, from: TODAY })).status).toBe(409); // already that way
    const own = await api().put('/api/school/attendance-mode').set(W.h).send({ periodWise: true, from: TODAY });
    expect(own.status).toBe(403); expect(JSON.stringify(own.body)).toMatch(/plan with AtKaksha/); // the School Admin can look, not change
    expect((await api().get('/api/school/attendance-mode').set(W.h)).status).toBe(200);
    expect((await api().put(`/api/platform/schools/${W.id}/attendance-mode`).set(W.h).send({ periodWise: true, from: TODAY })).status).toBe(403); // the platform door is for the Super Admin only
    expect((await api().put('/api/school/attendance-mode').set(T1).send({ periodWise: true, from: TODAY })).status).toBe(403);
    expect((await api().put('/api/school/attendance-mode').set(W.studentLogins[0].h).send({ periodWise: true, from: TODAY })).status).toBe(403);
  });

  it('switching on: teachers and students learn it, and the daily register closes', async () => {
    expect((await api().put(`/api/platform/schools/${W.id}/attendance-mode`).set(root.h).send({ periodWise: true, from: TODAY })).status).toBe(200);
    expect((await api().get('/api/auth/me').set(T1)).body.user).toMatchObject({ periodWise: true });
    expect((await api().get('/api/auth/me').set(W.studentLogins[0].h)).body.user).toMatchObject({ periodWise: true, attendanceChange: null });
    expect((await notesOf(W.studentLogins[0])).some((n) => /period by period/.test(n.body))).toBe(true);
    const reg = (await api().get(`/api/teacher/attendance/register?sectionId=${W.sec8A._id}&date=${TODAY}`).set(T1)).body;
    expect(reg.blocked).toBe('period_wise');
    expect((await api().put('/api/teacher/attendance/register').set(T1).send({ sectionId: W.sec8A._id, date: TODAY, entries: [] })).status).toBe(409);
    expect((await api().get('/api/teacher/dashboard').set(T1)).body.permissions.takeAttendance).toBe(false);
    // the way is the same for the whole school, and another school is not touched
    expect((await api().get('/api/school/attendance-mode').set(O.h)).body.periodWise).toBe(false);
  });

  it('a period register: nothing is pre-filled, submit needs everyone, the day appears once half the periods are in, and is never read as absent before', async () => {
    const reg = (await api().get('/api/teacher/period-attendance/register').query({ entryId: ent[0]._id, date: TODAY }).set(T1)).body;
    expect(reg.students.every((s) => s.status === null)).toBe(true);
    expect((await api().post('/api/teacher/period-attendance/register/submit').set(T1).send({ entryId: ent[0]._id, date: TODAY, entries: [{ studentId: A, status: 'absent' }] })).status).toBe(400);
    const body = (e, s) => ({ entryId: e._id, date: TODAY, entries: [A, B, C].map((id, i) => ({ studentId: id, status: s[i] })) });
    expect((await api().post('/api/teacher/period-attendance/register/submit').set(T1).send(body(ent[0], ['absent', 'present', 'late']))).body).toMatchObject({ submitted: true, absent: 1, day: 'incomplete' });
    // one period of three is not enough for a day: nothing is stored, nobody is absent
    expect((await api().get('/api/student/attendance/history').set(W.studentLogins[0].h)).body).toEqual([]);
    const ov1 = (await api().get(`/api/school/attendance/overview?date=${TODAY}`).set(W.h)).body;
    expect(ov1.periodWise).toBe(true);
    expect(ov1.rows.find((r) => r.section === 'A')).toMatchObject({ status: 'in_progress', totals: null, periods: { expected: 3, submitted: 1 } });
    // the second period (Mrs Gupta): half of the day is in, so the day is worked out
    expect((await api().post('/api/teacher/period-attendance/register/submit').set(T2).send(body(ent[1], ['absent', 'present', 'present']))).body).toMatchObject({ day: 'complete' });
    expect((await api().get('/api/student/attendance/history').set(W.studentLogins[0].h)).body[0]).toMatchObject({ date: TODAY, status: 'absent' });
    expect((await api().get('/api/student/attendance/history').set(W.studentLogins[2].h)).body[0]).toMatchObject({ status: 'late' }); // late in the first period, present after
    // the third: Aarav missed all but P3 (2 of 6 = 33%: absent), Bhavna 4 of 6 (67%: half day), Chirag in all (late)
    await api().post('/api/teacher/period-attendance/register/submit').set(T1).send(body(ent[2], ['present', 'absent', 'present']));
    expect((await api().get('/api/student/attendance/history').set(W.studentLogins[0].h)).body[0].status).toBe('absent');
    expect((await api().get('/api/student/attendance/history').set(W.studentLogins[1].h)).body[0].status).toBe('half_day');
    const sum = (await api().get('/api/student/attendance/summary').set(W.studentLogins[1].h)).body;
    expect(sum.half_day).toBe(1);
  });

  it('the family is told when a lesson is missed after the child was in earlier, not when they were away from the start', async () => {
    const b = await notesOf(W.studentLogins[1]);
    expect(b.some((n) => /Missed a period/.test(n.title))).toBe(true); // Bhavna: present P1, P2, absent P3
    const a = await notesOf(W.studentLogins[0]);
    expect(a.some((n) => /Missed a period/.test(n.title))).toBe(false); // Aarav was away from the first period
  });

  it('the day view, for the class teacher and the admin, lists periods, cells and each student\'s day; others cannot', async () => {
    const q = `sectionId=${W.sec8A._id}&date=${TODAY}`;
    const t = (await api().get(`/api/teacher/class-periods?${q}`).set(T1)).body;
    const adm = (await api().get(`/api/school/period-attendance?${q}`).set(W.h)).body;
    for (const d of [t, adm]) {
      expect(d).toMatchObject({ enabled: true, complete: true, expected: 3, submitted: 3, rule: { presentPct: 75, halfPct: 40 } });
      expect(d.periods.map((p) => p.subject)).toEqual(['Mathematics', 'English', 'Mathematics']);
      const aarav = d.students.find((s) => s.name === 'Aarav Singh');
      expect(Object.values(aarav.cells)).toEqual(['absent', 'absent', 'present']);
      expect(aarav.day.status).toBe('absent');
    }
    expect(t.periods[0]).toMatchObject({ mine: true, teacher: 'Mr Sharma' }); expect(t.periods[1].mine).toBe(false);
    expect((await api().get(`/api/teacher/class-periods?${q}`).set(T2)).status).toBe(403);
    expect((await api().get(`/api/school/period-attendance?${q}`).set(O.h)).status).toBe(404); // another school
    const ov = (await api().get(`/api/school/attendance/overview?date=${TODAY}`).set(W.h)).body;
    expect(ov.rows.find((r) => r.section === 'A')).toMatchObject({ status: 'submitted', periods: { expected: 3, submitted: 3 }, totals: { absent: 1, half_day: 1, late: 1 } });
    expect(ov.rows.find((r) => r.section === 'B')).toMatchObject({ status: 'not_marked' });
  });

  it('a teacher may change their own submitted period (kept in history); the day follows; a period of someone else is refused', async () => {
    const e = [{ studentId: A, status: 'absent' }, { studentId: B, status: 'present' }, { studentId: C, status: 'present' }];
    expect((await api().post('/api/teacher/period-attendance/register/submit').set(T2).send({ entryId: ent[0]._id, date: TODAY, entries: e })).status).toBe(403);
    const out = await api().post('/api/teacher/period-attendance/register/submit').set(T1).send({ entryId: ent[0]._id, date: TODAY, entries: e });
    expect(out.body).toMatchObject({ edited: true, changed: 1 });
    expect((await api().get('/api/student/attendance/history').set(W.studentLogins[1].h)).body[0].status).toBe('half_day'); // 2/2/0 first period absent: still 4 of 6
    const periodNow = (await api().get('/api/student/period-attendance').set(W.studentLogins[2].h)).body;
    expect(periodNow.periods[0].status).toBe('present'); // Chirag was late, now present
    expect(periodNow.day).toMatchObject({ status: 'present', source: 'periods' });
  });

  it('only the admin corrects a period, with a reason; it is logged, the family is told and the day is worked out again', async () => {
    const pid = W.periods[2]._id;
    const c = { sectionId: W.sec8A._id, date: TODAY, periodId: pid, studentId: B, status: 'present' };
    expect((await api().put('/api/school/period-attendance/correct').set(W.h).send({ ...c, reason: '' })).status).toBe(400);
    expect((await api().put('/api/teacher/period-attendance/correct').set(T1).send({ ...c, reason: 'Mistake' })).status).toBe(404); // no such teacher route
    const ok = await api().put('/api/school/period-attendance/correct').set(W.h).send({ ...c, reason: 'Was in the lab' });
    expect(ok.status).toBe(200);
    expect((await api().put('/api/school/period-attendance/correct').set(W.h).send({ ...c, reason: 'Again' })).status).toBe(400); // unchanged
    expect([404, 409]).toContain((await api().put('/api/school/period-attendance/correct').set(O.h).send({ ...c, reason: 'Other school' })).status); // another school: refused
    expect((await api().get('/api/student/attendance/history').set(W.studentLogins[1].h)).body[0].status).toBe('present'); // 6 of 6
    expect((await notesOf(W.studentLogins[1])).some((n) => n.title === 'Attendance corrected')).toBe(true);
    // a daily correction cannot reach a day that was worked out from periods
    expect((await api().post('/api/school/attendance/correct').set(W.h).send({ sectionId: W.sec8A._id, date: TODAY, studentId: B, status: 'absent', reason: 'Wrong place' })).status).toBe(409);
  });

  it('the student sees every lesson of the day and attendance by subject; the office can ask a teacher to mark a waiting period', async () => {
    const p = (await api().get('/api/student/period-attendance').set(W.studentLogins[0].h)).body;
    expect(p.periods.map((x) => `${x.subject}:${x.status}`)).toEqual(['Mathematics:absent', 'English:absent', 'Mathematics:present']);
    const subj = (await api().get('/api/student/period-attendance/subjects').set(W.studentLogins[0].h)).body.subjects;
    expect(subj.find((s) => s.subject === 'Mathematics')).toMatchObject({ periods: 2, attended: 1, percentage: 50 });
    expect(subj.find((s) => s.subject === 'English')).toMatchObject({ periods: 1, percentage: 0 });
    // a fourth lesson nobody has marked
    const p4 = (await api().post('/api/school/timetable/periods').set(W.h).send({ name: 'Period 4', order: 4, startTime: '10:00', endTime: '10:40' })).body;
    await api().post('/api/school/timetable/entries').set(W.h).send({ sectionId: W.sec8A._id, day: isoDay(TODAY), periodId: p4._id, assignmentId: W.asgE._id });
    const board = (await api().get(`/api/school/attendance/overview?date=${TODAY}`).set(W.h)).body.rows.find((r) => r.section === 'A');
    expect(board).toMatchObject({ status: 'in_progress', periods: { expected: 4, submitted: 3, missing: [{ period: 'Period 4', teacher: 'Mrs Gupta', subject: 'English' }] } });
    const ask = { sectionId: W.sec8A._id, date: TODAY, periodId: p4._id };
    expect((await api().post('/api/school/period-attendance/remind').set(W.h).send(ask)).body).toMatchObject({ ok: true, asked: 'Mrs Gupta', sent: true });
    expect((await api().post('/api/school/period-attendance/remind').set(W.h).send(ask)).body.sent).toBe(false); // not twice in an hour
    expect(((await api().get('/api/teacher/notifications').set(T2)).body.items || []).some((n) => /Please mark your period/.test(n.title))).toBe(true);
    expect((await api().post('/api/school/period-attendance/remind').set(W.h).send({ ...ask, periodId: W.periods[0]._id })).status).toBe(409); // already submitted
    // the day that was already worked out stays (3 of 4 periods are in)
    expect((await api().get('/api/student/attendance/history').set(W.studentLogins[0].h)).body[0].status).toBe('absent');
  });

  it('switching back is booked for tomorrow because period registers were started today; it can be withdrawn; history stays', async () => {
    expect((await api().put(`/api/platform/schools/${W.id}/attendance-mode`).set(root.h).send({ periodWise: false, from: TODAY })).status).toBe(400);
    expect((await api().put(`/api/platform/schools/${W.id}/attendance-mode`).set(root.h).send({ periodWise: false, from: TOMORROW })).body).toMatchObject({ ok: true, from: TOMORROW });
    expect((await api().get('/api/auth/me').set(T1)).body.user).toMatchObject({ periodWise: true, attendanceChange: { from: TOMORROW, periodWise: false } });
    const info = (await api().get('/api/school/attendance-mode').set(W.h)).body;
    expect(info).toMatchObject({ periodWise: true, pending: { from: TOMORROW, periodWise: false }, earliest: TOMORROW });
    expect(info.openCount).toBeGreaterThan(0);
    // tomorrow the daily register is back, today stays period by period
    expect((await api().get(`/api/teacher/attendance/register?sectionId=${W.sec8A._id}&date=${TOMORROW}`).set(T1)).body.blocked).not.toBe('period_wise');
    expect((await api().get(`/api/teacher/attendance/register?sectionId=${W.sec8A._id}&date=${TODAY}`).set(T1)).body.blocked).toBe('period_wise');
    // withdraw it: ask for what is in force now
    expect((await api().put(`/api/platform/schools/${W.id}/attendance-mode`).set(root.h).send({ periodWise: true, from: TOMORROW })).body).toMatchObject({ cancelled: true });
    expect((await api().get('/api/school/attendance-mode').set(W.h)).body.pending).toBeNull();
    expect((await api().put(`/api/platform/schools/${W.id}/attendance-mode`).set(root.h).send({ periodWise: true, from: TOMORROW })).status).toBe(409);
  });
});
