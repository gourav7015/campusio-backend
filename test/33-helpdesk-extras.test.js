import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, makeSchool, seedWorld, login } from './helpers.js';
import { setMailTransport, flushEmails } from '../src/services/email.js';
import { config } from '../src/core/config.js';
import { User, Ticket, File } from '../src/models/index.js';
import { LIMITS, autoCloseResolved } from '../src/modules/helpdesk/helpdesk.service.js';

let sent = [];
const PDF = Buffer.from('%PDF-1.4 screenshot');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('Help desk: attachments, limits, desk logins, counts', () => {
  let root; let W; let S; let T; let fin; let other;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin();
    config.mail.supportTo = ''; config.mail.appUrl = 'https://app.example.test';
    W = await seedWorld(root, 'hx'); S = W.studentLogins[0].h; T = W.teacher1.h; other = await makeSchool(root, 'ox');
    const f = await api().post('/api/school/staff').set(W.h).send({ name: 'Fiona Finance', email: 'fiona@hx.test', role: 'finance', phone: '9833333333', dob: '1984-04-04' });
    fin = await login(f.body.loginId, f.body.temporaryPassword, 'finance');
    await User.updateOne({ role: 'super_admin' }, { $set: { email: 'root@platform.test' } });
  });
  afterAll(() => { setMailTransport(null); return teardown(); });
  beforeEach(() => { sent = []; setMailTransport(async (m) => { sent.push(m); return { id: 'x' }; }); });

  it('files can be attached to a ticket and a reply; the right people can open them and nobody else', async () => {
    const c = await api().post('/api/student/tickets').set(S).field('subject', 'Page is blank').field('body', 'See the screenshot').attach('files', PNG, { filename: 'shot.png', contentType: 'image/png' });
    expect(c.status).toBe(201);
    expect(c.body.messages[0].attachments).toHaveLength(1);
    expect(c.body.messages[0].attachments[0]).toMatchObject({ name: 'shot.png', mime: 'image/png' });
    const id = c.body._id; const fid = c.body.messages[0].attachments[0].fileId;
    const own = await api().post(`/api/student/tickets/${id}/files/${fid}/link`).set(S);
    expect(own.status).toBe(200);
    expect((await api().get(own.body.url)).status).toBe(200); // the signed link opens the file
    expect((await api().post(`/api/student/tickets/${id}/files/${fid}/link`).set(W.studentLogins[1].h)).status).toBe(404); // another student
    expect((await api().post(`/api/teacher/tickets/${id}/files/${fid}/link`).set(T)).status).toBe(404);
    const adm = await api().post(`/api/platform/helpdesk/${id}/files/${fid}/link`).set(root.h);
    expect(adm.status).toBe(200); // AtKaksha support opens it
    expect((await api().post(`/api/school/helpdesk/${id}/files/${fid}/link`).set(W.h)).status).toBe(404); // the school's own admin has no part in it
    expect((await api().post(`/api/school/helpdesk/${id}/files/${fid}/link`).set(other.h)).status).toBe(404); // another school's admin
    // a private note's attachment is for the handling side only
    const note = await api().post(`/api/platform/helpdesk/${id}/replies`).set(root.h).field('body', 'Looks like the old cache').field('internal', 'true').attach('files', PDF, { filename: 'log.pdf', contentType: 'application/pdf' });
    expect(note.status).toBe(201);
    const nfid = note.body.messages.at(-1).attachments[0].fileId;
    expect((await api().post(`/api/platform/helpdesk/${id}/files/${nfid}/link`).set(root.h)).status).toBe(200);
    expect((await api().post(`/api/student/tickets/${id}/files/${nfid}/link`).set(S)).status).toBe(404);
    // a file AtKaksha support attaches to a normal reply (filed under the school the ticket came from) can be opened by the person who asked
    const open = await api().post(`/api/platform/helpdesk/${id}/replies`).set(root.h).field('body', 'Steps are in the PDF').attach('files', PDF, { filename: 'steps.pdf', contentType: 'application/pdf' });
    expect(open.status).toBe(201);
    const pfid = open.body.messages.at(-1).attachments[0].fileId;
    const pl2 = await api().post(`/api/student/tickets/${id}/files/${pfid}/link`).set(S);
    expect(pl2.status).toBe(200); expect((await api().get(pl2.body.url)).status).toBe(200);
    expect((await File.findById(pfid)).tenantId.toString()).toBe(W.id);
    const forged = await api().get(`/api/files/download/${nfid}?token=x`);
    expect(forged.status).toBe(403);
    const asStudent = (await api().get(`/api/student/tickets/${id}`).set(S)).body;
    expect(asStudent.messages).toHaveLength(2); // the question and AtKaksha's PDF reply; the private note is not shown
    // a student's own token for the private file does not work either (the download re-checks the permission)
    const { signFileToken } = await import('../src/services/files.js');
    const sid = (await api().get('/api/auth/me').set(S)).body.user;
    expect((await api().get(`/api/files/download/${nfid}?token=${encodeURIComponent(signFileToken(nfid, sid.id || sid._id))}`)).status).toBe(404);
    // a reply from the student with a file, and the platform administrator can open files of a platform ticket
    expect((await api().post(`/api/student/tickets/${id}/replies`).set(S).field('body', 'Another picture').attach('files', PDF, { filename: 'a.pdf', contentType: 'application/pdf' })).body.messages.at(-1).attachments).toHaveLength(1);
    const p = await api().post('/api/school/helpdesk').set(W.h).field('subject', 'Billing question').field('body', 'Invoice attached').attach('files', PDF, { filename: 'invoice.pdf', contentType: 'application/pdf' });
    expect(p.status).toBe(201);
    const pl = await api().post(`/api/platform/helpdesk/${p.body._id}/files/${p.body.messages[0].attachments[0].fileId}/link`).set(root.h);
    expect(pl.status).toBe(200);
    expect((await api().get(pl.body.url)).status).toBe(200);
  });

  it('bad files are refused and nothing is left behind', async () => {
    const before = await File.countDocuments({ kind: 'ticket' });
    expect((await api().post('/api/teacher/tickets').set(T).field('subject', 'Fake image').field('body', 'Not a real png').attach('files', Buffer.from('MZ not an image'), { filename: 'x.png', contentType: 'image/png' })).status).toBe(400);
    expect((await api().post('/api/teacher/tickets').set(T).field('subject', 'Program').field('body', 'An exe').attach('files', Buffer.from('MZ'), { filename: 'x.exe', contentType: 'application/x-msdownload' })).status).toBe(400);
    expect((await api().post('/api/teacher/tickets').set(T).field('subject', 'Too many').field('body', 'Four files').attach('files', PDF, 'a.pdf').attach('files', PDF, 'b.pdf').attach('files', PDF, 'c.pdf').attach('files', PDF, 'd.pdf')).status).toBeGreaterThanOrEqual(400);
    expect((await api().post('/api/teacher/tickets').set(T).field('subject', 'x').field('body', 'subject too short').attach('files', PDF, { filename: 'a.pdf', contentType: 'application/pdf' })).status).toBe(400); // validation fails after the upload
    expect(await File.countDocuments({ kind: 'ticket' })).toBe(before);
    expect(await Ticket.countDocuments({ subject: { $in: ['Fake image', 'Program', 'Too many', 'x'] } })).toBe(0);
  });

  it('a person cannot flood the help desk with tickets or replies', async () => {
    const stu = W.studentLogins[1].h;
    for (let i = 0; i < LIMITS.newPerHour; i++) expect((await api().post('/api/student/tickets').set(stu).send({ subject: `Question ${i}`, body: 'Please help me' })).status).toBe(201);
    const over = await api().post('/api/student/tickets').set(stu).send({ subject: 'One more', body: 'Please help me' });
    expect(over.status).toBe(429); expect(over.body.code).toBe('RATE_LIMIT');
    expect((await api().post('/api/teacher/tickets').set(T).send({ subject: 'A teacher is separate', body: 'Different person' })).status).toBe(201); // the limit is per person
    const tid = (await api().get('/api/student/tickets').set(stu)).body[0]._id;
    for (let i = 0; i < LIMITS.repliesPerHourPerTicket - 1; i++) expect((await api().post(`/api/student/tickets/${tid}/replies`).set(stu).send({ body: `more ${i}` })).status).toBe(201); // the first message already counts
    expect((await api().post(`/api/student/tickets/${tid}/replies`).set(stu).send({ body: 'too many' })).status).toBe(429);
  });

  it('finance, library and transport desks can write to AtKaksha support too', async () => {
    const c = await api().post('/api/finance/tickets').set(fin.h).send({ subject: 'Receipt printer', body: 'The printer is offline' });
    expect(c.status).toBe(201); expect(c.body.scope).toBe('platform');
    expect((await api().get('/api/finance/tickets').set(fin.h)).body).toHaveLength(1);
    expect((await api().get(`/api/finance/tickets/${c.body._id}`).set(S)).status).toBe(403); // a student has no finance access
    expect((await api().get('/api/platform/helpdesk?q=Receipt').set(root.h)).body.tickets.some((t) => t.subject === 'Receipt printer' && t.raisedBy.role === 'finance')).toBe(true); // it reaches AtKaksha support, not the school office
    for (const [role, path] of [['library', 'library'], ['transport', 'transport']]) {
      const u = await api().post('/api/school/staff').set(W.h).send({ name: `${role} desk`, email: `${role}@hx.test`, role, phone: '9833333333', dob: '1984-04-04' });
      const h = (await login(u.body.loginId, u.body.temporaryPassword, role)).h;
      expect((await api().post(`/api/${path}/tickets`).set(h).send({ subject: `${role} problem`, body: 'Please look' })).status).toBe(201);
    }
  });

  it('menu counts: handlers see unanswered tickets, requesters see tickets that were answered; the platform sees every school', async () => {
    const mine = (h) => api().get('/api/student/tickets/summary').set(h);
    const before = (await api().get('/api/platform/helpdesk/summary').set(root.h)).body.count;
    expect(before).toBeGreaterThan(0);
    const stu = W.studentLogins[2].h;
    const t = (await api().post('/api/student/tickets').set(stu).send({ subject: 'Count me', body: 'Please help me' })).body;
    expect((await api().get('/api/platform/helpdesk/summary').set(root.h)).body.count).toBe(before + 1);
    expect((await mine(stu)).body.count).toBe(0);
    await api().post(`/api/platform/helpdesk/${t._id}/replies`).set(root.h).send({ body: 'Answered' });
    expect((await mine(stu)).body.count).toBe(1); // waiting for the student
    expect((await api().get('/api/platform/helpdesk/summary').set(root.h)).body.count).toBe(before);
    expect((await api().get('/api/platform/helpdesk/summary').set(root.h)).body.count).toBeGreaterThanOrEqual(1);
    expect((await api().get('/api/platform/helpdesk/summary').set(W.h)).status).toBe(403);
    expect((await api().get('/api/school/helpdesk/summary').set(root.h).set('X-Acting-School', W.id)).body.count).toBe(0); // a platform administrator acting in a school
  });

  it('closing tells AtKaksha support; resolved tickets close themselves after a week', async () => {
    const stu = W.studentLogins[2].h;
    const t = (await api().post('/api/student/tickets').set(stu).send({ subject: 'Close me', body: 'Please help me' })).body;
    await flushEmails(); sent = [];
    await User.updateOne({ role: 'school_admin', tenantId: W.id }, { $set: { email: 'admin@hx.test' } });
    await api().post(`/api/student/tickets/${t._id}/close`).set(stu);
    await flushEmails();
    expect(sent.some((m) => m.to === 'root@platform.test' && /was closed by/.test(m.html))).toBe(true);
    const r = (await api().post('/api/student/tickets').set(W.studentLogins[0].h).send({ subject: 'Old resolved', body: 'Please help me' })).body;
    await api().patch(`/api/platform/helpdesk/${r._id}`).set(root.h).send({ status: 'resolved' });
    expect(await autoCloseResolved()).toBe(0); // resolved just now
    expect(await autoCloseResolved(new Date(Date.now() + (LIMITS.autoCloseDays + 1) * 86400000))).toBeGreaterThanOrEqual(1);
    expect((await api().get(`/api/platform/helpdesk/${r._id}`).set(root.h)).body.status).toBe('closed');
  });

  it('with no support inbox set, a new platform ticket is emailed to the Super Admins', async () => {
    await api().post('/api/school/helpdesk').set(W.h).send({ subject: 'Who gets this', body: 'No inbox is set' });
    await flushEmails();
    expect(sent.some((m) => m.to === 'root@platform.test' && /Who gets this/.test(m.subject))).toBe(true);
    expect(sent.find((m) => m.to === 'root@platform.test').html).toContain('/platform/helpdesk?open=');
  });
});
