import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { Notification } from '../src/models/index.js';

/** A Monday far enough ahead to be a working day and clear of every other test's dates. */
const monday = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 45); while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();

describe('A sub-admin who only approves leave, and queries a teacher sends to one person', () => {
  let root; let W; let approver; let comms; let attend; let desk; let other;
  const A = (p) => `/api/school${p}`;
  const mk = async (name, permissions) => {
    const c = await api().post(A('/sub-admins')).set(W.h).send({ name, permissions });
    expect(c.status).toBe(201);
    return { ...(await login(c.body.loginId, c.body.temporaryPassword, 'admin')), id: c.body.id, name };
  };
  const got = (u, title) => Notification.countDocuments({ tenantId: W.id, userId: u.user._id || u.user.id, title: new RegExp(title) });

  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'la');
    approver = await mk('Leave Approver', ['leave_approval']);
    comms = await mk('Comms Desk', ['communication']);
    attend = await mk('Attendance Desk', ['staff_attendance']);
    other = await mk('Student Desk', ['students']);
    const des = (await api().get(A('/designations')).set(W.h)).body;
    const clerk = (await api().post(A('/support-staff')).set(W.h).send({ name: 'Chhaya Clerk', designationId: des.find((d) => d.name === 'Office Clerk')._id, canMarkAttendance: true, email: 'clerk@la.test', phone: '9833333333', dob: '1984-04-04' })).body;
    const c = await api().post(A(`/support-staff/${clerk._id}/login`)).set(W.h);
    desk = await login(c.body.loginId, c.body.temporaryPassword, 'staff');
  });
  afterAll(teardown);

  it('is a permission of its own, listed for the School Admin to hand out', async () => {
    const opts = (await api().get(A('/sub-admins/options')).set(W.h)).body;
    expect(opts.permissions.find((p) => p.key === 'leave_approval')?.label).toBe("Approve teachers' leave");
  });

  it('can decide teachers\' leave and arrange substitutes, and nothing else', async () => {
    const l = await api().post('/api/teacher/leave').set(W.teacher1.h).send({ leaveType: 'casual', startDate: monday, endDate: monday, reason: 'Family function' });
    expect(l.status).toBe(201);
    expect((await api().get(A('/leave')).set(approver.h)).body.map((x) => x._id)).toContain(l.body._id);
    expect((await api().get(A(`/leave/${l.body._id}/affected-periods`)).set(approver.h)).status).toBe(200);
    const subs = await api().get(A('/leave/teachers')).set(approver.h); // the names for choosing a substitute, without opening the teacher records
    expect(subs.status).toBe(200); expect(subs.body.map((t) => t.name)).toEqual(expect.arrayContaining(['Mr Sharma', 'Mrs Gupta']));
    expect((await api().get(A('/substitutions')).set(approver.h)).status).toBe(200);
    for (const p of ['/teachers', '/students', '/staff-attendance/register?group=teachers', '/payroll/summary', '/settings', '/announcements']) expect((await api().get(A(p)).set(approver.h)).status, p).toBe(403);
    expect((await api().post(A('/leave-balances/grants')).set(approver.h).send({ personType: 'teacher', personId: W.t1.teacher._id, leaveType: 'casual', days: 1, reason: 'No' })).status).toBe(403);
    for (const who of [comms, attend, other]) expect((await api().post(A(`/leave/${l.body._id}/decide`)).set(who.h).send({ decision: 'approve' })).status).toBe(403);
    const d = await api().post(A(`/leave/${l.body._id}/decide`)).set(approver.h).send({ decision: 'approve', remark: 'Fine' });
    expect(d.status).toBe(200); expect(d.body.status).toBe('approved');
  });

  it('is told about leave, and so is the School Admin; the other sub-admins are not', async () => {
    const day = new Date(`${monday}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 7);
    const next = day.toISOString().slice(0, 10);
    expect((await api().post('/api/teacher/leave').set(W.teacher2.h).send({ leaveType: 'casual', startDate: next, endDate: next, reason: 'Medical check' })).status).toBe(201);
    expect(await got(approver, 'New leave application')).toBe(2); // one for each application so far
    expect(await Notification.countDocuments({ tenantId: W.id, title: 'New leave application' })).toBe(4); // two applications, each told to the School Admin and the approver
    for (const who of [comms, attend, other]) expect(await got(who, 'New leave application')).toBe(0);
  });

  it('a teacher can choose whom to ask: the admin, sub-admins who take queries, and the desk, with no one else', async () => {
    const r = (await api().get('/api/teacher/queries/recipients').set(W.teacher1.h)).body;
    const names = r.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['Leave Approver', 'Comms Desk', 'Attendance Desk', 'Chhaya Clerk']));
    expect(names).not.toContain('Student Desk');
    expect(r.find((x) => x.name === 'Chhaya Clerk').title).toBe('Office desk');
    expect(r.every((x) => x.userId && x.name && x.title && Object.keys(x).length === 3)).toBe(true);
    expect((await api().get('/api/student/queries/recipients').set(W.studentLogins[0].h)).status).toBe(404);
  });

  it('a query addressed to one person is seen and notified to that person only (the School Admin can still see it)', async () => {
    const to = (await api().get('/api/teacher/queries/recipients').set(W.teacher1.h)).body.find((x) => x.name === 'Leave Approver');
    const bad = await api().post('/api/teacher/queries').set(W.teacher1.h).send({ subject: 'Wrong person', body: 'This goes nowhere.', sentTo: String(other.user._id || other.user.id) });
    expect(bad.status).toBe(400);
    const q = await api().post('/api/teacher/queries').set(W.teacher1.h).send({ subject: 'About my leave balance', body: 'Please tell me how many casual days I have left.', sentTo: to.userId });
    expect(q.status).toBe(201); expect(q.body.sentTo.name).toBe('Leave Approver');
    // who is told
    expect(await got(approver, 'New ticket')).toBe(1);
    for (const who of [comms, attend]) expect(await got(who, 'New ticket')).toBe(0);
    expect(await Notification.countDocuments({ tenantId: W.id, userId: desk.user._id || desk.user.id, title: /New ticket/ })).toBe(0);
    // who can open it
    const id = q.body._id;
    expect((await api().get(A(`/queries/${id}`)).set(approver.h)).status).toBe(200);
    expect((await api().get(A(`/queries/${id}`)).set(W.h)).status).toBe(200);
    for (const who of [comms, attend]) expect((await api().get(A(`/queries/${id}`)).set(who.h)).status).toBe(404);
    expect((await api().get(`/api/staff/queries/${id}`).set(desk.h)).status).toBe(404);
    const inboxOf = async (h, base = A('/queries')) => JSON.stringify((await api().get(base).set(h)).body);
    expect(await inboxOf(approver.h)).toContain('About my leave balance');
    expect(await inboxOf(comms.h)).not.toContain('About my leave balance');
    expect(await inboxOf(desk.h, '/api/staff/queries')).not.toContain('About my leave balance');
    // the count beside the menu is for the person it was sent to
    expect((await api().get(A('/queries/summary')).set(approver.h)).body.count).toBe(1);
    expect((await api().get(A('/queries/summary')).set(comms.h)).body.count).toBe(0);
    expect((await api().get(A('/queries/summary')).set(W.h)).body.count).toBe(0);
    // answered by that person, read by the teacher
    expect((await api().post(A(`/queries/${id}/replies`)).set(approver.h).send({ body: 'You have 10 days left.' })).status).toBe(201);
    const mine = (await api().get(`/api/teacher/queries/${id}`).set(W.teacher1.h)).body;
    expect(mine.messages.at(-1).body).toBe('You have 10 days left.'); expect(mine.sentTo.name).toBe('Leave Approver');
    // handing it to someone else lets that person in, and tells them
    expect((await api().patch(A(`/queries/${id}`)).set(approver.h).send({ assignedTo: String(comms.user._id || comms.user.id) })).status).toBe(200);
    expect((await api().get(A(`/queries/${id}`)).set(comms.h)).status).toBe(200);
    expect(await got(comms, 'was handed to you')).toBe(1);
  });

  it('a query sent to the whole office still reaches the admin, the attendance and communication sub-admins and the desk', async () => {
    const q = await api().post('/api/teacher/queries').set(W.teacher2.h).send({ subject: 'Question for everyone', body: 'Anyone at the office can answer this.', sentTo: '' });
    expect(q.status).toBe(201); expect(q.body.sentTo).toBeNull();
    for (const who of [comms, attend]) expect((await api().get(A(`/queries/${q.body._id}`)).set(who.h)).status).toBe(200);
    expect((await api().get(`/api/staff/queries/${q.body._id}`).set(desk.h)).status).toBe(200);
    expect((await api().get(A(`/queries/${q.body._id}`)).set(other.h)).status).toBe(403); // a sub-admin without any query permission never reaches the inbox
  });
});
