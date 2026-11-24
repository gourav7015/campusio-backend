import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';
import { Notification } from '../src/models/index.js';

const TODAY = todayStr('Asia/Kolkata');
// a working day well ahead, so leave dates never fall on a Sunday or in the past
const nextMonday = (() => { let d = addDays(TODAY, 14); while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1); return d; })();

describe('Transport staff leave: approved by the officer, or passed to the School Admin; calendars for every desk', () => {
  let root; let W; let tr; let driver; let conductor; let bus;
  const T = (p) => `/api/transport${p}`;
  const adminNotes = () => Notification.find({ tenantId: W.id, category: 'leave', 'link.type': 'staff_leave' }).sort({ createdAt: 1 }).lean();
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'tl');
    const c = await api().post('/api/school/staff').set(W.h).send({ name: 'Tara Transport', email: 'tara@tl.test', role: 'transport', phone: '9833333333', dob: '1984-04-04' });
    tr = await login(c.body.loginId, c.body.temporaryPassword, 'transport');
    const des = (await api().get(T('/designations')).set(tr.h)).body; const id = (n) => des.find((d) => d.name === n)._id;
    driver = (await api().post(T('/staff')).set(tr.h).send({ name: 'Ramesh Bhai', designationId: id('Driver'), phone: '9876500001' })).body;
    conductor = (await api().post(T('/staff')).set(tr.h).send({ name: 'Suresh Bhai', designationId: id('Conductor'), phone: '9876500002' })).body;
  });
  afterAll(teardown);

  it('the officer records a leave and approves it; the School Admin is told as well', async () => {
    const l = await api().post(T('/leave')).set(tr.h).send({ staffId: driver._id, leaveType: 'casual', startDate: nextMonday, endDate: nextMonday, reason: 'Family function' });
    expect(l.status).toBe(201);
    expect(l.body).toMatchObject({ status: 'approved', awaitingAdmin: false });
    const notes = await adminNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toMatch(/recorded and approved by the Transport officer/);
    expect(notes[0].body).toContain('Ramesh Bhai');
    // the admin can see it, but it is not waiting for them
    const seen = (await api().get('/api/school/transport-leave').set(W.h)).body;
    expect(seen).toHaveLength(1); expect(seen[0].status).toBe('approved');
  });

  it('the officer can pass a leave on instead of approving it: only the admin can then decide', async () => {
    const day = addDays(nextMonday, 7);
    const l = (await api().post(T('/leave')).set(tr.h).send({ staffId: conductor._id, leaveType: 'sick', startDate: day, endDate: day, reason: 'Fever', sendToAdmin: true })).body;
    expect(l).toMatchObject({ status: 'submitted', awaitingAdmin: true });
    expect((await adminNotes()).at(-1).title).toMatch(/needs your approval/);
    const mine = (await api().get(T('/leave?status=submitted')).set(tr.h)).body;
    expect(mine[0]).toMatchObject({ canDecide: false, canPassOn: false }); // out of the officer's hands
    expect((await api().post(T(`/leave/${l._id}/decide`)).set(tr.h).send({ decision: 'approve' })).status).toBe(403);
    const theirs = (await api().get('/api/school/transport-leave?status=submitted').set(W.h)).body;
    expect(theirs[0]).toMatchObject({ canDecide: true });
    const done = await api().post(`/api/school/transport-leave/${l._id}/decide`).set(W.h).send({ decision: 'approve', remark: 'Get well soon' });
    expect(done.status).toBe(200); expect(done.body).toMatchObject({ status: 'approved', awaitingAdmin: false });
    expect((await Notification.find({ tenantId: W.id, title: /approved by the School Admin/ }).lean()).length).toBe(1); // the officer hears back
    expect((await api().post(`/api/school/transport-leave/${l._id}/decide`).set(W.h).send({ decision: 'reject' })).status).toBe(409); // already decided
    // a teacher or student has nothing to do with it
    expect((await api().post(`/api/school/transport-leave/${l._id}/decide`).set(W.teacher1.h).send({ decision: 'approve' })).status).toBe(403);
  });

  it('a waiting application can be passed on afterwards, and passing it twice changes nothing', async () => {
    const day = addDays(nextMonday, 14);
    // make the officer's own decision pending first by switching the school to officer approval and recording through the admin's desk setting off
    const l = (await api().post(T('/leave')).set(tr.h).send({ staffId: driver._id, leaveType: 'casual', startDate: day, endDate: day, reason: 'Wedding', sendToAdmin: true })).body;
    expect((await api().post(T(`/leave/${l._id}/pass-to-admin`)).set(tr.h)).status).toBe(200); // already with the admin: harmless
    expect((await api().post(`/api/school/transport-leave/${l._id}/decide`).set(W.h).send({ decision: 'reject', remark: 'Too many drivers off that day' })).body.status).toBe('rejected');
    expect((await api().post(T(`/leave/${l._id}/pass-to-admin`)).set(tr.h)).status).toBe(409); // decided leave cannot be passed on
    expect((await api().post(`/api/school/transport-leave/${l._id}/pass-to-admin`).set(W.h)).status).toBe(400); // the admin has no one above to pass it to
  });

  it('the desk withdraws a leave that is waiting or approved but not begun; the staff member and the admin are told', async () => {
    const rec = await api().post(T('/leave')).set(tr.h).send({ staffId: conductor._id, leaveType: 'casual', startDate: addDays(nextMonday, 21), endDate: addDays(nextMonday, 21), reason: 'Wedding' });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201); const l = rec.body;
    expect(l.status).toBe('approved');
    const w = await api().post(T(`/leave/${l._id}/withdraw`)).set(tr.h); expect(w.status).toBe(200); expect(w.body).toMatchObject({ status: 'cancelled' }); expect(w.body.withdrawnAt).toBeTruthy();
    expect((await adminNotes()).some((n) => /cancelled/i.test(n.title))).toBe(true);
    expect((await api().post(T(`/leave/${l._id}/withdraw`)).set(tr.h)).status).toBe(409); // already withdrawn
    expect((await api().post(T('/leave/000000000000000000000000/withdraw')).set(tr.h)).status).toBe(404);
    expect((await api().post(`/api/school/transport-leave/${l._id}/withdraw`).set(W.h)).status).toBe(409); // the admin's desk sees the same record
  });

  it('the school can keep leave approval for its admin: then everything the officer records goes to the admin', async () => {
    expect((await api().get(T('/leave/policy')).set(tr.h)).body.approver).toBe('self');
    expect((await api().put('/api/school/settings').set(W.h).send({ transportLeaveApprover: 'admin' })).status).toBe(200);
    expect((await api().get(T('/leave/policy')).set(tr.h)).body.approver).toBe('admin');
    const day = addDays(nextMonday, 21);
    const l = (await api().post(T('/leave')).set(tr.h).send({ staffId: driver._id, leaveType: 'casual', startDate: day, endDate: day, reason: 'Medical check' })).body;
    expect(l).toMatchObject({ status: 'submitted', awaitingAdmin: true }); // the officer did not ask for this: the school's rule did
    expect((await api().post(T(`/leave/${l._id}/decide`)).set(tr.h).send({ decision: 'approve' })).status).toBe(403);
    expect((await api().post(`/api/school/transport-leave/${l._id}/decide`).set(W.h).send({ decision: 'approve' })).body.status).toBe('approved');
    expect((await api().put('/api/school/settings').set(W.h).send({ transportLeaveApprover: 'officer' })).status).toBe(200);
    expect((await api().put('/api/school/settings').set(W.h).send({ transportLeaveApprover: 'nobody' })).status).toBe(400);
  });

  it('a sub-admin sees transport leave only with the staff attendance permission', async () => {
    const mk = async (name, email, permissions) => { const c = await api().post('/api/school/sub-admins').set(W.h).send({ name, email, permissions, phone: '9833311111', dob: '1983-03-03' }); return (await login(c.body.loginId, c.body.temporaryPassword, 'admin')).h; };
    const desk = await mk('Desk A', 'a@tl.test', ['attendance']);
    const staffDesk = await mk('Desk B', 'b@tl.test', ['staff_attendance']);
    expect((await api().get('/api/school/transport-leave').set(desk)).status).toBe(403);
    expect((await api().get('/api/school/transport-leave').set(staffDesk)).status).toBe(200);
  });

  describe('the school calendar in every portal', () => {
    it('the admin adds an event; finance, library, transport, staff, teacher and student all see it; class-only events stay with their class', async () => {
      const day = addDays(TODAY, 5);
      expect((await api().post('/api/school/events').set(W.h).send({ title: 'Annual Day', type: 'event', startDate: day })).status).toBe(201);
      expect((await api().post('/api/school/events').set(W.h).send({ title: 'Class 8-A trip', type: 'event', startDate: day, sectionIds: [W.sec8A._id] })).status).toBe(201);
      const q = `?from=${addDays(TODAY, 0)}&to=${addDays(TODAY, 10)}`;
      const fin = await api().post('/api/school/staff').set(W.h).send({ name: 'Fiona', email: 'f@tl.test', role: 'finance', phone: '9833333333', dob: '1984-04-04' });
      const lib = await api().post('/api/school/staff').set(W.h).send({ name: 'Lila', email: 'l@tl.test', role: 'library', phone: '9833333333', dob: '1984-04-04' });
      const f = await login(fin.body.loginId, fin.body.temporaryPassword, 'finance'); const l = await login(lib.body.loginId, lib.body.temporaryPassword, 'library');
      for (const [name, h, base] of [['finance', f.h, '/api/finance'], ['library', l.h, '/api/library'], ['transport', tr.h, '/api/transport']]) {
        const cal = (await api().get(`${base}/calendar${q}`).set(h)).body;
        expect(cal.map((e) => e.title), name).toEqual(['Annual Day']); // not the class-only trip
      }
      expect((await api().get(`/api/teacher/calendar${q}`).set(W.teacher1.h)).body.map((e) => e.title)).toContain('Annual Day');
      expect((await api().get(`/api/student/calendar${q}`).set(W.studentLogins[0].h)).body.map((e) => e.title)).toContain('Annual Day');
      // read-only: no desk can change the calendar, and a student cannot read a desk's route
      expect((await api().post('/api/finance/calendar').set(f.h).send({ title: 'x' })).status).toBe(404);
      expect((await api().get('/api/finance/calendar').set(W.studentLogins[0].h)).status).toBe(403);
    });
  });
});
