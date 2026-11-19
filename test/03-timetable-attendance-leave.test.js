import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { todayStr, addDays, isoDay } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');
const back = (n, wd) => { let d = addDays(TODAY, -n); while (isoDay(d) !== wd) d = addDays(d, -1); return d; };
const lastWorking = (skip = 1) => { let d = addDays(TODAY, -skip); while (isoDay(d) === 7) d = addDays(d, -1); return d; };

describe('timetable, substitutions, attendance and leave', () => {
  let root; let W; let asgM2; let asgE2;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'tt');
    asgM2 = (await W.post(W.h, '/api/school/teaching-assignments', { teacherId: W.t1.teacher._id, sectionId: W.sec8B._id, subjectId: W.maths._id, effectiveFrom: '2026-04-01' })).body;
    asgE2 = (await W.post(W.h, '/api/school/teaching-assignments', { teacherId: W.t2.teacher._id, sectionId: W.sec8B._id, subjectId: W.eng._id, effectiveFrom: '2026-04-01' })).body;
  });
  afterAll(teardown);

  const entry = (sectionId, day, p, assignmentId, room) => api().post('/api/school/timetable/entries').set(W.h).send({ sectionId, day, periodId: W.periods[p]._id, assignmentId, room });

  describe('timetable', () => {
    it('creates entries and detects teacher, room, section and working-day problems', async () => {
      expect((await entry(W.sec8A._id, 1, 0, W.asgM._id)).status).toBe(201);
      expect((await entry(W.sec8A._id, 1, 1, W.asgE._id)).status).toBe(201);
      const teacherClash = await entry(W.sec8B._id, 1, 0, asgM2._id);
      expect(teacherClash.status).toBe(409);
      expect(teacherClash.body.details.type).toBe('teacher');
      const roomClash = await entry(W.sec8B._id, 1, 0, asgE2._id, '101');
      expect(roomClash.status).toBe(409);
      expect(roomClash.body.details.type).toBe('room');
      expect((await entry(W.sec8B._id, 1, 2, asgE2._id)).status).toBe(201); // free slot, own room 102
      expect((await entry(W.sec8A._id, 7, 0, W.asgM._id)).status).toBe(400); // Sunday
      expect((await entry(W.sec8A._id, 2, 0, asgM2._id)).status).toBe(400); // assignment belongs to another section
      // replacing the same slot is an update, not a duplicate
      expect((await entry(W.sec8A._id, 1, 0, W.asgM._id)).status).toBe(201);
      const all = (await api().get(`/api/school/timetable/entries?sectionId=${W.sec8A._id}`).set(W.h)).body;
      expect(all.filter((e) => e.day === 1)).toHaveLength(2);
    });

    it('students see their section timetable, teachers see only their own', async () => {
      await entry(W.sec8A._id, 3, 0, W.asgM._id);
      const monday = back(0, 1);
      const sDay = (await api().get(`/api/student/timetable?view=day&date=${monday}`).set(W.studentLogins[0].h)).body;
      const lessons = sDay.rows.filter((r) => r.subject);
      expect(lessons.map((l) => l.subject)).toEqual(['Mathematics', 'English']);
      expect(lessons[0]).toMatchObject({ teacher: 'Mr Sharma', room: '101' });
      expect(sDay.rows.some((r) => r.free)).toBe(true); // period 3 is a free period
      const tDay = (await api().get(`/api/teacher/timetable?date=${monday}`).set(W.teacher2.h)).body.day;
      expect(tDay.map((r) => r.subject)).toEqual(['English', 'English']); // 8-A P2 and 8-B P1
      const wk = (await api().get('/api/student/timetable?view=week').set(W.studentLogins[0].h)).body;
      expect(wk.week.length).toBe(6);
      const subj = (await api().get('/api/student/timetable?view=subject').set(W.studentLogins[0].h)).body;
      expect(subj.subjects.map((s) => s.subject).sort()).toEqual(['English', 'Mathematics']);
    });

    it('substitutes a teacher for one date and shows it to students and the covering teacher', async () => {
      const monday = back(0, 1);
      const e1 = (await api().get(`/api/school/timetable/entries?sectionId=${W.sec8A._id}`).set(W.h)).body.find((e) => e.day === 1 && e.subject === 'Mathematics');
      expect((await api().post('/api/school/substitutions').set(W.h).send({ entryId: e1._id, date: addDays(monday, 1), substituteTeacherId: W.t2.teacher._id })).status).toBe(400); // wrong weekday
      expect((await api().post('/api/school/substitutions').set(W.h).send({ entryId: e1._id, date: monday, substituteTeacherId: W.t1.teacher._id })).status).toBe(400); // same teacher
      const sub = await api().post('/api/school/substitutions').set(W.h).send({ entryId: e1._id, date: monday, substituteTeacherId: W.t2.teacher._id, reason: 'Sick' });
      expect(sub.status).toBe(201);
      const sDay = (await api().get(`/api/student/timetable?view=day&date=${monday}`).set(W.studentLogins[0].h)).body.rows.filter((r) => r.subject);
      expect(sDay[0]).toMatchObject({ teacher: 'Mrs Gupta', substitute: true, originalTeacher: 'Mr Sharma' });
      const t1 = (await api().get(`/api/teacher/timetable?date=${monday}`).set(W.teacher1.h)).body.day;
      expect(t1.find((r) => r.subject === 'Mathematics')).toBeUndefined();
      const t2 = (await api().get(`/api/teacher/timetable?date=${monday}`).set(W.teacher2.h)).body.day;
      expect(t2.some((r) => r.covering)).toBe(true);
      // the original timetable is still intact
      expect((await api().get(`/api/school/timetable/entries?sectionId=${W.sec8A._id}`).set(W.h)).body.find((e) => e._id === e1._id).teacher).toBe('Mr Sharma');
      const notes = (await api().get('/api/student/notifications').set(W.studentLogins[0].h)).body;
      expect(notes.items.some((n) => n.category === 'timetable')).toBe(true);
    });

    it('ending an assignment flags future periods as unresolved instead of deleting them', async () => {
      const ended = await api().post(`/api/school/teaching-assignments/${W.asgE._id}/end`).set(W.h).send({});
      expect(ended.body.unresolvedPeriods).toBeGreaterThan(0);
      const unresolved = (await api().get('/api/school/timetable/unresolved').set(W.h)).body;
      expect(unresolved.length).toBeGreaterThan(0);
      // after the effective date the ended teacher no longer sees that period; before it, history is intact
      const future = (await api().get(`/api/teacher/timetable?date=${addDays(back(0, 1), 7)}`).set(W.teacher2.h)).body.day;
      expect(future.every((r) => r.sectionId !== String(W.sec8A._id))).toBe(true);
      const past = (await api().get(`/api/teacher/timetable?date=${back(0, 1)}`).set(W.teacher2.h)).body.day;
      expect(past.some((r) => r.sectionId === String(W.sec8A._id))).toBe(true);
      // reassign: new open assignment, then repoint the unresolved entry
      const again = await W.post(W.h, '/api/school/teaching-assignments', { teacherId: W.t2.teacher._id, sectionId: W.sec8A._id, subjectId: W.eng._id });
      expect(again.status).toBe(201);
      W.asgE = again.body;
      const e = unresolved[0];
      expect((await api().patch(`/api/school/timetable/entries/${e._id}`).set(W.h).send({ assignmentId: again.body._id })).status).toBe(200);
      expect((await api().get('/api/school/timetable/unresolved').set(W.h)).body.length).toBe(0);
    });
  });

  describe('attendance', () => {
    const regQ = (sectionId, date) => `/api/teacher/attendance/register?sectionId=${sectionId}&date=${date}`;
    const marks = (reg, status = 'present') => reg.students.map((s) => ({ studentId: s.studentId, status }));

    it('only the CLASS TEACHER takes a section\'s register; other teachers can only look', async () => {
      const d = lastWorking(1);
      // Gupta teaches English in 8-A but is not its class teacher
      const view = (await api().get(regQ(W.sec8A._id, d)).set(W.teacher2.h)).body;
      expect(view.students.length).toBe(3);
      expect(view).toMatchObject({ isClassTeacher: false, canEdit: false });
      const put = await api().put('/api/teacher/attendance/register').set(W.teacher2.h).send({ sectionId: W.sec8A._id, date: d, entries: [{ studentId: view.students[0].studentId, status: 'present' }] });
      expect(put.status).toBe(403);
      expect(put.body.error).toMatch(/class teacher/i);
      expect((await api().post('/api/teacher/attendance/register/submit').set(W.teacher2.h).send({ sectionId: W.sec8A._id, date: d, entries: [] })).status).toBe(403);
      // Sharma is the class teacher of 8-A
      expect(await api().get(regQ(W.sec8A._id, d)).set(W.teacher1.h).then((r) => r.body)).toMatchObject({ isClassTeacher: true, canEdit: true });
      // he teaches maths in 8-B too, which lets him view it but not mark it
      const b = (await api().get(regQ(W.sec8B._id, d)).set(W.teacher1.h)).body;
      expect(b).toMatchObject({ isClassTeacher: false, canEdit: false });
      expect((await api().put('/api/teacher/attendance/register').set(W.teacher1.h).send({ sectionId: W.sec8B._id, date: d, entries: [] })).status).toBe(403);
      // a section nobody gave him at all
      const sec9 = (await W.post(W.h, '/api/school/sections', { yearId: W.year._id, classId: W.c9._id, name: 'A' })).body;
      expect((await api().get(regQ(sec9._id, d)).set(W.teacher1.h)).status).toBe(403);
      // the admin may take any register; the dashboard counts pending registers only for class teachers
      const dash1 = (await api().get('/api/teacher/dashboard').set(W.teacher1.h)).body;
      const dash2 = (await api().get('/api/teacher/dashboard').set(W.teacher2.h)).body;
      expect(dash1.permissions.takeAttendance).toBe(true);
      expect(dash2.permissions.takeAttendance).toBe(false);
      expect(dash2.cards.pendingAttendance).toBe(0);
    });

    it('rejects future dates, non-working days and holidays', async () => {
      const f = await api().put('/api/teacher/attendance/register').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: addDays(TODAY, 3), entries: [] });
      expect(f.status).toBe(400);
      const sunday = back(0, 7);
      expect((await api().put('/api/teacher/attendance/register').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: sunday, entries: [] })).status).toBe(400);
      const hday = lastWorking(2);
      await api().post('/api/school/events').set(W.h).send({ title: 'Founders Day', type: 'holiday', startDate: hday });
      const h = await api().put('/api/teacher/attendance/register').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: hday, entries: [] });
      expect(h.status).toBe(400);
      expect(h.body.error).toMatch(/holiday/i);
      expect((await api().get(regQ(W.sec8A._id, hday)).set(W.teacher1.h)).body.blocked).toMatch(/holiday/);
    });

    it('drafts are invisible to students; unmarked is never absence; submit needs everyone marked', async () => {
      const d = lastWorking(3) === lastWorking(2) ? lastWorking(4) : lastWorking(3);
      const reg = (await api().get(regQ(W.sec8A._id, d)).set(W.teacher1.h)).body;
      const partial = [{ studentId: reg.students[0].studentId, status: 'absent' }];
      expect((await api().put('/api/teacher/attendance/register').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: d, entries: partial })).status).toBe(200);
      const before = (await api().get('/api/student/attendance/summary').set(W.studentLogins[2].h)).body;
      expect(before.workingDays).toBe(0);
      expect(before.percentage).toBeNull();
      const nope = await api().post('/api/teacher/attendance/register/submit').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: d, entries: partial });
      expect(nope.status).toBe(400);
      expect(nope.body.error).toMatch(/not marked/);
      const dup = await api().put('/api/teacher/attendance/register').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: d, entries: [partial[0], partial[0]] });
      expect(dup.status).toBe(400);
      const foreign = await api().put('/api/teacher/attendance/register').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: d, entries: [{ studentId: '64b000000000000000000000', status: 'present' }] });
      expect(foreign.status).toBe(400);
      const all = marks(reg);
      all[0].status = 'absent'; all[1].status = 'late';
      const ok = await api().post('/api/teacher/attendance/register/submit').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: d, entries: all });
      expect(ok.status).toBe(200);
      expect(ok.body.totals).toMatchObject({ present: 1, absent: 1, late: 1 });
      // the class teacher may reopen a submitted register; saving it unchanged changes nothing
      const same = await api().put('/api/teacher/attendance/register').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: d, entries: all });
      expect(same.status).toBe(200); expect(same.body).toMatchObject({ edited: true, changed: 0 });
      const sum = (await api().get('/api/student/attendance/summary').set(W.studentLogins[0].h)).body;
      expect(sum).toMatchObject({ absent: 1, workingDays: 1, percentage: 0 });
      const lateStudent = (await api().get('/api/student/attendance/summary').set(W.studentLogins[1].h)).body;
      expect(lateStudent.percentage).toBe(100); // late counts as present by default
      const notes = (await api().get('/api/student/notifications?category=attendance').set(W.studentLogins[0].h)).body;
      expect(notes.items.length).toBeGreaterThan(0);
      W.attDate = d;
    });

    it('the admin corrects a submitted register with a reason and full history; the teacher has the same register editable', async () => {
      const d = W.attDate;
      const sid = W.students[0].student._id;
      const body = { sectionId: W.sec8A._id, date: d, studentId: sid, status: 'present', reason: 'Parent brought a note' };
      // the class teacher edits her own register directly (see 42-teacher-edits-register); the other teachers cannot
      expect((await api().put('/api/teacher/attendance/register').set(W.teacher2.h).send({ sectionId: W.sec8A._id, date: d, entries: [] })).status).toBe(403);
      expect((await api().post('/api/teacher/attendance/correct').set(W.teacher1.h).send(body)).status).toBe(404); // the route no longer exists
      expect((await api().post('/api/school/attendance/correct').set(W.teacher1.h).send(body)).status).toBe(403);
      const reg = (await api().get(regQ(W.sec8A._id, d)).set(W.teacher1.h)).body;
      expect(reg).toMatchObject({ canEdit: true, canCorrect: false });
      // the class teacher asks the admin instead
      const reqCorr = await api().post('/api/teacher/attendance/request-correction').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: d, note: 'Aarav was present, I marked him absent by mistake' });
      expect(reqCorr.status).toBe(201);
      expect((await api().post('/api/teacher/attendance/request-correction').set(W.teacher2.h).send({ sectionId: W.sec8A._id, date: d, note: 'not the class teacher' })).status).toBe(403);
      const inbox = (await api().get('/api/school/messages').set(W.h)).body;
      expect(inbox.some((m) => /Attendance correction request/.test(m.subject))).toBe(true);
      // the admin: a reason is mandatory, then history records original/new/who/why
      expect((await api().post('/api/school/attendance/correct').set(W.h).send({ ...body, reason: 'x' })).status).toBe(400);
      const ok = await api().post('/api/school/attendance/correct').set(W.h).send(body);
      expect(ok.status).toBe(200);
      expect(ok.body.history[0]).toMatchObject({ from: 'absent', to: 'present', reason: 'Parent brought a note', byName: 'admin School Admin'.replace('admin School Admin', 'tt Admin') });
      expect((await api().get('/api/student/attendance/history').set(W.studentLogins[0].h)).body[0].corrected).toBe(true);
      expect((await api().post('/api/school/attendance/correct').set(W.h).send({ ...body, reason: 'again please' })).status).toBe(400); // unchanged
      expect((await api().get('/api/school/audit?action=attendance.corrected').set(W.h)).body).toHaveLength(1);
    });

    it('students can query attendance but never edit it; the class teacher answers', async () => {
      const S = W.studentLogins[0].h;
      expect((await api().post('/api/student/attendance/register/submit').set(S).send({})).status).toBe(404);
      expect((await api().post('/api/teacher/attendance/correct').set(S).send({})).status).toBe(403);
      const q = await api().post('/api/student/attendance/queries').set(S).send({ date: W.attDate, message: 'I was present that day' });
      expect(q.status).toBe(201);
      const list = (await api().get('/api/teacher/attendance/queries').set(W.teacher1.h)).body;
      expect(list).toHaveLength(1);
      expect((await api().get('/api/teacher/attendance/queries').set(W.teacher2.h)).body.length).toBe(0); // not class teacher
      const res = await api().post(`/api/teacher/attendance/queries/${q.body._id}/resolve`).set(W.teacher1.h).send({ status: 'resolved', response: 'Corrected, thanks' });
      expect(res.body.status).toBe('resolved');
    });

    it('admin overview shows pending vs submitted registers and the calendar marks colours', async () => {
      const ov = (await api().get(`/api/school/attendance/overview?date=${W.attDate}`).set(W.h)).body;
      expect(ov.totals.submitted).toBe(1);
      expect(ov.totals.sections).toBeGreaterThanOrEqual(2);
      expect(ov.rows.find((r) => r.section === 'A').totals.total).toBe(3);
      const cal = (await api().get(`/api/student/attendance/calendar?month=${W.attDate.slice(0, 7)}`).set(W.studentLogins[1].h)).body;
      expect(cal.days.find((x) => x.date === W.attDate).status).toBe('late');
      expect(cal.days.some((x) => x.holiday === 'Founders Day')).toBe(true);
      const csv = await api().get(`/api/school/export/attendance.csv?sectionId=${W.sec8A._id}`).set(W.h);
      expect(csv.text.split('\n')[0]).toBe('Date,Admission No,Student,Status,Remarks');
      expect((await api().get(`/api/school/export/attendance.csv?sectionId=${W.sec8A._id}`).set(W.teacher1.h)).status).toBe(403);
    });
  });

  describe('teacher leave', () => {
    it('applies, blocks overlaps, is decided only by the admin, updates balance and lists affected periods', async () => {
      const monday = addDays(back(0, 1), 7);
      const T = W.teacher1.h;
      expect((await api().post('/api/teacher/leave').set(T).send({ leaveType: 'sick', startDate: monday, endDate: addDays(monday, -1), reason: 'Fever' })).status).toBe(400);
      const l = await api().post('/api/teacher/leave').set(T).send({ leaveType: 'sick', startDate: monday, endDate: monday, reason: 'Fever and rest' });
      expect(l.status).toBe(201);
      expect(l.body.days).toBe(1);
      expect((await api().post('/api/teacher/leave').set(T).send({ leaveType: 'casual', startDate: monday, endDate: monday, reason: 'Overlap' })).status).toBe(409);
      expect((await api().post(`/api/school/leave/${l.body._id}/decide`).set(T).send({ decision: 'approve' })).status).toBe(403);
      expect((await api().post(`/api/school/leave/${l.body._id}/decide`).set(W.teacher2.h).send({ decision: 'approve' })).status).toBe(403);
      const affected = (await api().get(`/api/school/leave/${l.body._id}/affected-periods`).set(W.h)).body;
      expect(affected.length).toBeGreaterThanOrEqual(1);
      expect(affected[0]).toMatchObject({ date: monday, subject: 'Mathematics' });
      const d = await api().post(`/api/school/leave/${l.body._id}/decide`).set(W.h).send({ decision: 'approve', remark: 'Get well' });
      expect(d.body.status).toBe('approved');
      expect((await api().post(`/api/school/leave/${l.body._id}/decide`).set(W.h).send({ decision: 'reject' })).status).toBe(409);
      const mine = (await api().get('/api/teacher/leave').set(T)).body;
      expect(mine.balances.sick).toMatchObject({ allowance: 10, used: 1, remaining: 9 });
      const notes = (await api().get('/api/teacher/notifications').set(T)).body;
      expect(notes.items.some((n) => n.category === 'leave')).toBe(true);
      expect((await api().get('/api/teacher/leave').set(W.teacher2.h)).body.applications).toHaveLength(0); // sees only own
    });
  });
});
