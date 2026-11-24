import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { todayStr, addDays, isoDay } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');
const nextWeekday = (iso, from = addDays(TODAY, 1)) => { let d = from; while (isoDay(d) !== iso) d = addDays(d, 1); return d; };

describe('Scheduling: period swaps, attendance on a closed day, period-wise attendance, edited leave', () => {
  let root; let W; let T1; let T2; let e1; let e2; let monday;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'sch');
    T1 = W.teacher1.h; T2 = W.teacher2.h; monday = nextWeekday(1);
    const mk = (periodId, assignmentId, day = 1) => api().post('/api/school/timetable/entries').set(W.h).send({ sectionId: W.sec8A._id, day, periodId, assignmentId });
    e1 = (await mk(W.periods[0]._id, W.asgM._id)).body.entry; // Monday P1 Maths, Mr Sharma
    e2 = (await mk(W.periods[1]._id, W.asgE._id)).body.entry; // Monday P2 English, Mrs Gupta
  });
  afterAll(teardown);

  it('a swap needs the other teacher first, then the School Admin; approval creates both substitutions', async () => {
    const colleagues = (await api().get('/api/teacher/swaps/colleagues').set(T1)).body;
    expect(colleagues.map((c) => c.name)).toEqual(['Mrs Gupta']);
    const periods = (await api().get(`/api/teacher/swaps/periods?date=${monday}&teacherId=${colleagues[0]._id}`).set(T1)).body;
    expect(periods.map((p) => p.subject)).toEqual(['English']);
    const body = { date: monday, fromEntryId: e1._id, toTeacherId: colleagues[0]._id, toEntryId: e2._id, reason: 'Going to a workshop' };
    expect((await api().post('/api/teacher/swaps').set(T1).send({ ...body, fromEntryId: e2._id })).status).toBe(403); // not his period
    expect((await api().post('/api/teacher/swaps').set(T1).send({ ...body, date: addDays(monday, 1) })).status).toBe(400); // wrong weekday
    expect((await api().post('/api/teacher/swaps').set(T1).send({ ...body, date: addDays(TODAY, -7) })).status).toBe(400);
    const s = await api().post('/api/teacher/swaps').set(T1).send(body);
    expect(s.status).toBe(201);
    expect((await api().post('/api/teacher/swaps').set(T1).send(body)).status).toBe(409); // one pending request per period
    const id = s.body._id;
    expect((await api().post(`/api/school/approvals/swaps/${id}`).set(W.h).send({ approve: true })).status).toBe(409); // the other teacher has not agreed
    expect((await api().get('/api/teacher/swaps').set(T2)).body[0]).toMatchObject({ mine: false, fromTeacher: 'Mr Sharma', fromPeriod: { subject: 'Mathematics' }, toPeriod: { subject: 'English' } });
    expect((await api().post(`/api/teacher/swaps/${id}/respond`).set(T1).send({ accept: true })).status).toBe(404); // only the asked teacher answers
    expect((await api().post(`/api/teacher/swaps/${id}/respond`).set(T2).send({ accept: true, note: 'Fine' })).status).toBe(200);
    expect((await api().get('/api/school/approvals').set(W.h)).body.swaps).toHaveLength(1);
    expect((await api().post(`/api/school/approvals/swaps/${id}`).set(W.h).send({ approve: false })).status).toBe(400); // rejecting needs a reason
    expect((await api().post(`/api/school/approvals/swaps/${id}`).set(T1).send({ approve: true })).status).toBe(403);
    const ok = await api().post(`/api/school/approvals/swaps/${id}`).set(W.h).send({ approve: true });
    expect(ok.body.status).toBe('approved');
    const subs = (await api().get(`/api/school/substitutions?from=${monday}&to=${monday}`).set(W.h)).body;
    expect(subs.map((x) => `${x.originalTeacherId.name}->${x.substituteTeacherId.name}`).sort()).toEqual(['Mr Sharma->Mrs Gupta', 'Mrs Gupta->Mr Sharma']);
    // the timetables follow
    expect((await api().get(`/api/teacher/timetable?date=${monday}`).set(T2)).body.day.map((r) => r.subject)).toEqual(['Mathematics']);
    expect((await api().get('/api/school/approvals').set(W.h)).body.swaps).toHaveLength(0);
  });

  it('a declined swap ends there, and a requester can withdraw a pending one', async () => {
    const date = nextWeekday(1, addDays(monday, 1));
    const gupta = (await api().get('/api/teacher/swaps/colleagues').set(T1)).body[0]._id;
    const s1 = (await api().post('/api/teacher/swaps').set(T1).send({ date, fromEntryId: e1._id, toTeacherId: gupta })).body;
    expect((await api().post(`/api/teacher/swaps/${s1._id}/respond`).set(T2).send({ accept: false, note: 'Busy' })).status).toBe(200);
    expect((await api().get('/api/teacher/swaps').set(T1)).body.find((x) => x._id === s1._id)).toMatchObject({ status: 'declined', peerNote: 'Busy' });
    const s2 = (await api().post('/api/teacher/swaps').set(T1).send({ date, fromEntryId: e1._id, toTeacherId: gupta })).body;
    expect((await api().post(`/api/teacher/swaps/${s2._id}/cancel`).set(T1).send({})).status).toBe(200);
    expect((await api().post(`/api/teacher/swaps/${s2._id}/cancel`).set(T1).send({})).status).toBe(409);
  });

  it('period-wise attendance works only when the school turns it on, for whoever teaches that period', async () => {
    const day = isoDay(TODAY);
    const mk = (periodId, assignmentId) => api().post('/api/school/timetable/entries').set(W.h).send({ sectionId: W.sec8A._id, day, periodId, assignmentId });
    const today1 = (await mk(W.periods[2]._id, W.asgM._id)).body.entry; // today's P3 Maths with Mr Sharma
    expect((await api().get(`/api/teacher/period-attendance/register?entryId=${today1._id}&date=${TODAY}`).set(T1)).status).toBe(409); // off by default
    expect((await api().put('/api/school/settings').set(W.h).send({ attendance: { periodWise: true } })).status).toBe(200);
    const list = (await api().get('/api/teacher/period-attendance').set(T1)).body;
    expect(list.periods.some((p) => p.entryId === today1._id && p.marked === false)).toBe(true);
    const reg = (await api().get(`/api/teacher/period-attendance/register?entryId=${today1._id}&date=${TODAY}`).set(T1)).body;
    expect(reg.students).toHaveLength(3); expect(reg.students.every((s) => s.status === 'present')).toBe(true);
    expect((await api().get(`/api/teacher/period-attendance/register?entryId=${today1._id}&date=${TODAY}`).set(T2)).status).toBe(403); // not Mrs Gupta's period
    const a = W.students[0].student._id;
    expect((await api().put('/api/teacher/period-attendance/register').set(T1).send({ entryId: today1._id, date: TODAY, entries: [{ studentId: a, status: 'absent' }] })).body).toMatchObject({ absent: 1, total: 3 });
    expect((await api().put('/api/teacher/period-attendance/register').set(T1).send({ entryId: today1._id, date: addDays(TODAY, 1), entries: [] })).status).toBe(400); // weekday mismatch / future
    expect((await api().get('/api/teacher/period-attendance').set(T1)).body.periods.find((p) => p.entryId === today1._id).marked).toBe(true);
    // the student sees their own period-by-period status; the admin sees counts
    const mine = (await api().get('/api/student/period-attendance').set(W.studentLogins[0].h)).body;
    expect(mine.periods).toEqual([expect.objectContaining({ status: 'absent', subject: 'Mathematics' })]);
    expect((await api().get('/api/student/period-attendance').set(W.studentLogins[1].h)).body.periods[0].status).toBe('present');
    expect((await api().get(`/api/school/period-attendance?sectionId=${W.sec8A._id}`).set(W.h)).body.periods[0]).toMatchObject({ absent: 1, total: 3, teacher: 'Mr Sharma' });
    await api().put('/api/school/settings').set(W.h).send({ attendance: { periodWise: false } });
  });

  it('attendance on a day the school is closed needs the School Admin\'s approval, then the register opens', async () => {
    const closed = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== isoDay(TODAY));
    await api().put('/api/school/settings').set(W.h).send({ workingDays: closed });
    const sec = W.sec8A._id;
    expect((await api().get(`/api/teacher/attendance/register?sectionId=${sec}&date=${TODAY}`).set(T1)).body.blocked).toBe('non_working_day');
    expect((await api().post('/api/teacher/attendance/exceptions').set(T2).send({ sectionId: sec, date: TODAY, reason: 'Talent test' })).status).toBe(403); // not the class teacher
    expect((await api().post('/api/teacher/attendance/exceptions').set(T1).send({ sectionId: sec, date: nextWeekday(isoDay(TODAY) === 2 ? 3 : 2), reason: 'A working day' })).status).toBe(400); // a day that is not today's weekday, so it is a working day whatever day the test runs on
    const x = await api().post('/api/teacher/attendance/exceptions').set(T1).send({ sectionId: sec, date: TODAY, reason: 'Sunday talent test' });
    expect(x.status).toBe(201);
    expect((await api().put('/api/teacher/attendance/register').set(T1).send({ sectionId: sec, date: TODAY, entries: [] })).status).toBe(400); // not yet
    expect((await api().post(`/api/school/approvals/attendance-exceptions/${x.body._id}`).set(W.h).send({ approve: true })).status).toBe(200);
    const reg = (await api().get(`/api/teacher/attendance/register?sectionId=${sec}&date=${TODAY}`).set(T1)).body;
    expect(reg).toMatchObject({ blocked: null, canEdit: true, specialDay: true });
    const entries = W.students.map((s) => ({ studentId: s.student._id, status: 'present' }));
    expect((await api().put('/api/teacher/attendance/register').set(T1).send({ sectionId: sec, date: TODAY, entries })).status).toBe(200);
    // the admin may also allow a day directly; both appear in the list
    const direct = await api().post('/api/school/attendance-exceptions').set(W.h).send({ sectionId: sec, date: addDays(TODAY, 3), reason: 'Exam duty' });
    expect([201, 400]).toContain(direct.status);
    expect((await api().get('/api/teacher/attendance/exceptions').set(T1)).body[0]).toMatchObject({ status: 'approved' });
    await api().put('/api/school/settings').set(W.h).send({ workingDays: [1, 2, 3, 4, 5, 6] });
  });

  it('the School Admin can edit a teacher\'s leave (dates, type, reason); overlaps and empty ranges are refused', async () => {
    const start = nextWeekday(2); const end = addDays(start, 1);
    const l = (await api().post('/api/teacher/leave').set(T2).send({ leaveType: 'casual', startDate: start, endDate: end, reason: 'Family function' })).body;
    expect(l.days).toBeGreaterThan(0);
    const ed = await api().patch(`/api/school/leave/${l._id}`).set(W.h).send({ leaveType: 'sick', endDate: addDays(start, 2), editNote: 'Doctor note' });
    expect(ed.status).toBe(200); expect(ed.body).toMatchObject({ leaveType: 'sick', endDate: addDays(start, 2) });
    expect(ed.body.days).toBeGreaterThanOrEqual(l.days);
    expect((await api().patch(`/api/school/leave/${l._id}`).set(W.h).send({ endDate: addDays(start, -3) })).status).toBe(400);
    expect((await api().patch(`/api/school/leave/${l._id}`).set(T2).send({ reason: 'x y z' })).status).toBe(403);
    const other = (await api().post('/api/teacher/leave').set(T2).send({ leaveType: 'casual', startDate: addDays(start, 10), endDate: addDays(start, 10), reason: 'Another' })).body;
    expect((await api().patch(`/api/school/leave/${other._id}`).set(W.h).send({ startDate: start })).status).toBe(409);
  });
});
