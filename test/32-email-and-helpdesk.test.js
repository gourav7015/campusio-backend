import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, makeSchool, seedWorld, login } from './helpers.js';
import { setMailTransport, flushEmails } from '../src/services/email.js';
import { config } from '../src/core/config.js';
import { User, Notification, Ticket } from '../src/models/index.js';
import { notifyUsers } from '../src/services/notify.js';

let sent = [];
const mails = async () => { await flushEmails(); return sent; };

describe('Email channel and the help desk', () => {
  let root; let W; let T; let S; let other;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin();
    config.mail.supportTo = 'support@campusio.test'; config.mail.replyTo = 'support@campusio.test'; config.mail.appUrl = 'https://app.example.test';
    W = await seedWorld(root, 'hd'); T = W.teacher1.h; S = W.studentLogins[0].h;
    other = await makeSchool(root, 'oth');
  });
  afterAll(() => { setMailTransport(null); return teardown(); });
  beforeEach(() => { sent = []; setMailTransport(async (m) => { sent.push(m); return { id: 'x' }; }); });

  describe('notifications by email', () => {
    it('emails the people who have an address and have not opted out, once per event', async () => {
      const [a, b] = await User.find({ tenantId: W.id, role: { $in: ['teacher', 'student'] } }).limit(2);
      await User.updateOne({ _id: a._id }, { $set: { email: 'a@mail.test' } });
      await User.updateOne({ _id: b._id }, { $set: { email: 'b@mail.test', notificationPrefs: { email: false } } });
      expect(await notifyUsers(W.id, [a._id, b._id], { category: 'system', title: 'Hello <b>there</b>', body: 'Body text', dedupeKey: 'e1' })).toBe(2); // both get the in-app notification
      const out = await mails();
      expect(out).toHaveLength(1); // b switched email off
      expect(out[0]).toMatchObject({ to: 'a@mail.test', subject: 'Hello <b>there</b>' });
      expect(out[0].html).toContain('Hello &lt;b&gt;there&lt;/b&gt;'); // the body is escaped, never raw HTML from a user
      expect(out[0].html).toContain('https://app.example.test');
      sent = [];
      expect(await notifyUsers(W.id, [a._id], { category: 'system', title: 'Hello', dedupeKey: 'e1' })).toBe(0); // same event again: nothing new
      expect(await mails()).toHaveLength(0);
    });

    it('does not email categories that are not configured, and does nothing at all without a mail setup', async () => {
      const [a] = await User.find({ tenantId: W.id, email: 'a@mail.test' });
      await notifyUsers(W.id, [a._id], { category: 'attendance', title: 'Marked absent', dedupeKey: 'e2' });
      expect(await mails()).toHaveLength(0); // attendance is in-app only by default
      expect(await Notification.countDocuments({ userId: a._id, title: 'Marked absent' })).toBe(1);
      setMailTransport(null); // no transport and no RESEND_API_KEY
      await notifyUsers(W.id, [a._id], { category: 'system', title: 'Quiet', dedupeKey: 'e3' });
      expect(await Notification.countDocuments({ userId: a._id, title: 'Quiet' })).toBe(1);
      expect(await mails()).toHaveLength(0);
    });

    it('a failing mail provider never breaks the action that caused the email', async () => {
      const [a] = await User.find({ tenantId: W.id, email: 'a@mail.test' });
      setMailTransport(async () => { throw new Error('provider down'); });
      expect(await notifyUsers(W.id, [a._id], { category: 'system', title: 'Still works', dedupeKey: 'e4' })).toBe(1);
      await flushEmails();
      expect(await Notification.countDocuments({ userId: a._id, title: 'Still works' })).toBe(1);
    });
  });

  describe('everyone writes to AtKaksha support (one place, not the school office)', () => {
    let tid;
    it('a student raises a ticket: AtKaksha support is told by email, the student gets a receipt, the school admin hears nothing', async () => {
      await User.updateOne({ role: 'school_admin', tenantId: W.id }, { $set: { email: 'admin@hd.test' } });
      const stuUser = (await api().get('/api/auth/me').set(S)).body.user;
      expect(stuUser.role).toBe('student');
      await User.updateOne({ _id: stuUser.id || stuUser._id }, { $set: { email: 'stu@mail.test' } });
      const c = await api().post('/api/student/tickets').set(S).send({ subject: 'Cannot see my timetable', body: 'The page is blank since morning', category: 'bug' });
      expect(c.status).toBe(201);
      expect(c.body).toMatchObject({ reference: 'HD-1', scope: 'platform', status: 'open', category: 'bug', priority: 'normal' });
      expect(c.body.messages).toHaveLength(1);
      tid = c.body._id;
      const out = await mails();
      expect(out.map((m) => m.to).sort()).toEqual(['stu@mail.test', 'support@campusio.test']); // the school admin is not involved
      const support = out.find((m) => m.to === 'support@campusio.test');
      expect(support.subject).toBe('[HD-1] Cannot see my timetable');
      expect(support.html).toContain('hd School'); expect(support.html).toContain('(student)');
      expect(support.replyTo).toBe('stu@mail.test');
      expect(await Notification.countDocuments({ tenantId: W.id, category: 'helpdesk' })).toBe(1); // only the student's own receipt
      expect((await api().post('/api/student/tickets').set(S).send({ subject: 'x', body: 'y' })).status).toBe(400);
      expect((await api().post('/api/student/tickets').set(S).send({ subject: 'Valid subject', body: 'Valid body', priority: 'urgent' })).status).toBe(400); // only AtKaksha sets urgent
    });

    it('a person sees only their own tickets; no other person, no school admin and no other school can reach it', async () => {
      expect((await api().get('/api/student/tickets').set(S)).body).toHaveLength(1);
      expect((await api().get('/api/student/tickets').set(W.studentLogins[1].h)).body).toHaveLength(0);
      expect((await api().get(`/api/student/tickets/${tid}`).set(W.studentLogins[1].h)).status).toBe(404);
      expect((await api().get(`/api/teacher/tickets/${tid}`).set(T)).status).toBe(404);
      expect((await api().get(`/api/school/helpdesk/${tid}`).set(W.h)).status).toBe(404); // not even the school admin
      expect((await api().get('/api/school/helpdesk').set(W.h)).body).toHaveLength(0);
      expect((await api().get('/api/school/tickets').set(W.h)).status).toBe(404); // the school has no help desk inbox of its own
      expect((await api().get(`/api/school/helpdesk/${tid}`).set(other.h)).status).toBe(404);
      expect((await api().post(`/api/student/tickets/${tid}/replies`).set(W.studentLogins[1].h).send({ body: 'hijack' })).status).toBe(404);
      expect((await api().patch(`/api/school/tickets/${tid}`).set(W.h).send({ status: 'closed' })).status).toBe(404);
    });

    it('the platform administrator replies (the student hears by email), adds a private note, and resolves it', async () => {
      const inbox = (await api().get('/api/platform/helpdesk?open=true').set(root.h)).body;
      expect(inbox.total).toBe(1); expect(inbox.counts).toMatchObject({ open: 1, pending: 0 });
      expect(inbox.tickets[0]).toMatchObject({ reference: 'HD-1', school: { code: 'hd' }, raisedBy: { role: 'student' } });
      sent = [];
      const r = await api().post(`/api/platform/helpdesk/${tid}/replies`).set(root.h).send({ body: 'We are looking into it' });
      expect(r.status).toBe(201); expect(r.body.status).toBe('pending'); expect(r.body.assignedTo).toBeTruthy();
      const out = await mails();
      expect(out).toHaveLength(1); expect(out[0]).toMatchObject({ to: 'stu@mail.test', subject: 'Reply on your ticket HD-1' });
      sent = [];
      const n = await api().post(`/api/platform/helpdesk/${tid}/replies`).set(root.h).send({ body: 'Probably the cache, check with IT', internal: true });
      expect(n.status).toBe(201);
      expect(await mails()).toHaveLength(0); // a private note tells nobody
      const asStudent = (await api().get(`/api/student/tickets/${tid}`).set(S)).body;
      expect(asStudent.messages.map((m) => m.body)).toEqual(['The page is blank since morning', 'We are looking into it']); // the note is hidden
      expect((await api().get(`/api/platform/helpdesk/${tid}`).set(root.h)).body.messages).toHaveLength(3);
      const res = await api().patch(`/api/platform/helpdesk/${tid}`).set(root.h).send({ status: 'resolved', priority: 'low' });
      expect(res.body).toMatchObject({ status: 'resolved', priority: 'low' });
      expect((await mails()).some((m) => /was resolved/.test(m.subject))).toBe(true);
    });

    it('a reply from the student reopens a resolved ticket; closing is final for the student, and AtKaksha may reopen', async () => {
      const r = await api().post(`/api/student/tickets/${tid}/replies`).set(S).send({ body: 'Still blank' });
      expect(r.status).toBe(201); expect(r.body.status).toBe('open');
      expect((await api().post(`/api/student/tickets/${tid}/replies`).set(S).send({ body: 'x', internal: true })).status).toBe(201); // the internal flag from a requester is ignored, never honoured
      expect((await api().get(`/api/platform/helpdesk/${tid}`).set(root.h)).body.messages.filter((m) => m.internal && m.fromRequester)).toHaveLength(0);
      expect((await api().post(`/api/student/tickets/${tid}/close`).set(S)).body.status).toBe('closed');
      expect((await api().post(`/api/student/tickets/${tid}/replies`).set(S).send({ body: 'one more' })).status).toBe(409);
      expect((await api().post(`/api/platform/helpdesk/${tid}/replies`).set(root.h).send({ body: 'hello' })).status).toBe(409);
      expect((await api().patch(`/api/platform/helpdesk/${tid}`).set(root.h).send({ status: 'open' })).body.status).toBe('open');
    });

    it('every kind of sign-in can raise one: teacher, school admin and sub-admin (but never a platform administrator)', async () => {
      const t2 = await api().post('/api/teacher/tickets').set(T).send({ subject: 'Projector broken in 8-A', body: 'Please send maintenance' });
      expect(t2.body).toMatchObject({ reference: 'HD-2', scope: 'platform' });
      const a = await api().post('/api/school/helpdesk').set(W.h).send({ subject: 'Question about our invoice', body: 'Please resend the March invoice', category: 'billing', priority: 'high' });
      expect(a.status).toBe(201); expect(a.body).toMatchObject({ reference: 'HD-3', priority: 'high' });
      const desk = await api().post('/api/school/sub-admins').set(W.h).send({ name: 'Desk', email: 'desk@hd.test', permissions: ['attendance'] });
      const dh = (await login(desk.body.loginId, desk.body.temporaryPassword, 'admin')).h;
      expect((await api().post('/api/school/helpdesk').set(dh).send({ subject: 'Sub-admin question', body: 'How do I mark staff?' })).status).toBe(201); // no permission needed to ask for help
      expect((await api().get('/api/school/helpdesk').set(dh)).body).toHaveLength(1); // and it sees only its own
      expect((await api().get('/api/school/helpdesk').set(W.h)).body).toHaveLength(1);
      expect((await api().post('/api/school/helpdesk').set(root.h).set('X-Acting-School', W.id).send({ subject: 'Acting', body: 'as the platform' })).status).toBe(403);
      expect((await api().post('/api/student/tickets').set(root.h).send({ subject: 'Platform', body: 'not a student' })).status).toBe(403);
    });

    it('only platform administrators can answer, and they see every school\u2019s tickets', async () => {
      expect((await api().get('/api/platform/helpdesk').set(W.h)).status).toBe(403);
      expect((await api().get('/api/platform/helpdesk').set(T)).status).toBe(403);
      await api().post('/api/student/tickets').set(other.studentH || other.h).send({ subject: 'Other school question', body: 'How do I import students?', category: 'how_to' }).catch(() => {});
      await api().post('/api/school/helpdesk').set(other.h).send({ subject: 'Other school question', body: 'How do I import students?', category: 'how_to' });
      await flushEmails();
      const list = (await api().get('/api/platform/helpdesk?open=true').set(root.h)).body;
      expect(list.total).toBe(5); expect([...new Set(list.tickets.map((t) => t.school.code))].sort()).toEqual(['hd', 'oth']);
      expect((await api().get(`/api/platform/helpdesk?schoolId=${W.id}`).set(root.h)).body.tickets).toHaveLength(4);
      expect((await api().get('/api/platform/helpdesk?q=invoice').set(root.h)).body.tickets).toHaveLength(1);
      expect((await api().get('/api/platform/helpdesk?priority=high').set(root.h)).body.tickets).toHaveLength(1);
      const pid = (await api().get('/api/platform/helpdesk?q=invoice').set(root.h)).body.tickets[0]._id;
      sent = [];
      const r = await api().post(`/api/platform/helpdesk/${pid}/replies`).set(root.h).send({ body: 'Done, the invoice has been resent.' });
      expect(r.status).toBe(201); expect(r.body.status).toBe('pending');
      expect((await mails()).map((m) => m.to)).toEqual(['admin@hd.test']);
      expect((await api().patch(`/api/platform/helpdesk/${pid}`).set(root.h).send({ status: 'resolved' })).body.status).toBe('resolved');
      const mine = (await api().get(`/api/school/helpdesk/${pid}`).set(W.h)).body;
      expect(mine.status).toBe('resolved'); expect(mine.messages.at(-1).body).toBe('Done, the invoice has been resent.');
      expect((await api().get('/api/platform/helpdesk?mine=true').set(root.h)).body.tickets.length).toBeGreaterThanOrEqual(1);
      expect((await api().patch(`/api/platform/helpdesk/${pid}`).set(root.h).send({ assignedTo: W.admin.user.id || W.admin.user._id })).status).toBe(400); // a school admin is not a platform administrator
      expect((await api().patch(`/api/platform/helpdesk/${pid}`).set(root.h).send({})).status).toBe(400);
    });

    it('tickets are numbered per school, and every action leaves an audit entry', async () => {
      expect(await Ticket.countDocuments({ scope: 'school' })).toBe(0); // nothing is ever addressed to a school office
      const refs = (await Ticket.find({ tenantId: other.id }).select('reference')).map((t) => t.reference).sort();
      expect(refs).toEqual(['OTH-1']);
      const { AuditLog } = await import('../src/models/index.js');
      const actions = (await AuditLog.find({ entityType: 'Ticket' }).select('action')).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['ticket.created', 'ticket.replied', 'ticket.note', 'ticket.updated']));
    });
  });
});
