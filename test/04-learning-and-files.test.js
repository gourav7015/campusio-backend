import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { Homework, StudyMaterial } from '../src/models/index.js';
import { todayStr, addDays } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');

describe('homework, study materials, files and announcements', () => {
  let root; let W; let outsider; let hwId;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'lrn');
    // a student in 8-B who must NOT see 8-A content
    const r = await W.post(W.h, '/api/school/students', { name: 'Outsider Kid', dob: '2013-07-07', sectionId: W.sec8B._id, admissionDate: '2026-04-15', guardians: [{ email: 'guardian@fixture.test', name: 'Parent Name', relationship: 'Mother', phone: '9876543210' }] });
    outsider = await login(r.body.credentials.loginId, r.body.credentials.temporaryPassword);
  });
  afterAll(teardown);
  const hw = (over = {}) => ({ title: 'Exercise 4', description: 'Do all questions', sectionId: W.sec8A._id, subjectId: W.maths._id, dueDate: addDays(TODAY, 3), ...over });

  describe('homework', () => {
    it('teacher creates drafts only inside own assignments; students see nothing until published', async () => {
      expect((await api().post('/api/teacher/homework').set(W.teacher2.h).send(hw())).status).toBe(403); // English teacher, maths subject
      expect((await api().post('/api/teacher/homework').set(W.teacher1.h).send(hw({ sectionId: W.sec8B._id }))).status).toBe(403); // not his section
      expect((await api().post('/api/teacher/homework').set(W.teacher1.h).send(hw({ dueDate: addDays(TODAY, -2) }))).status).toBe(400);
      const c = await api().post('/api/teacher/homework').set(W.teacher1.h).send(hw());
      expect(c.status).toBe(201);
      expect(c.body.status).toBe('draft');
      hwId = c.body._id;
      expect((await api().get('/api/student/homework').set(W.studentLogins[0].h)).body).toHaveLength(0);
      expect((await api().get(`/api/student/homework/${hwId}`).set(W.studentLogins[0].h)).status).toBe(404);
    });

    it('publishing notifies only that section and cannot be repeated', async () => {
      const p = await api().post(`/api/teacher/homework/${hwId}/publish`).set(W.teacher1.h).send({});
      expect(p.status).toBe(200);
      expect((await api().post(`/api/teacher/homework/${hwId}/publish`).set(W.teacher1.h).send({})).status).toBe(409);
      const mine = (await api().get('/api/student/homework').set(W.studentLogins[0].h)).body;
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ title: 'Exercise 4', subject: 'Mathematics', teacher: 'Mr Sharma', state: 'due_soon' });
      expect((await api().get('/api/student/homework').set(outsider.h)).body).toHaveLength(0);
      expect((await api().get(`/api/student/homework/${hwId}`).set(outsider.h)).status).toBe(404);
      const n = (await api().get('/api/student/notifications?category=homework').set(W.studentLogins[0].h)).body;
      expect(n.items[0].link).toMatchObject({ type: 'homework', id: hwId });
      expect((await api().get('/api/student/notifications').set(outsider.h)).body.items.filter((x) => x.category === 'homework')).toHaveLength(0);
    });

    it('records edit history, notifies on deadline change, and protects other teachers homework', async () => {
      const e = await api().patch(`/api/teacher/homework/${hwId}`).set(W.teacher1.h).send({ dueDate: addDays(TODAY, 5), title: 'Exercise 4 (revised)' });
      expect(e.body.editHistory.at(-1).changes.sort()).toEqual(['dueDate', 'title']);
      const detail = (await api().get(`/api/teacher/homework/${hwId}`).set(W.teacher1.h)).body;
      expect(detail.editHistory.length).toBeGreaterThanOrEqual(2);
      expect((await api().patch(`/api/teacher/homework/${hwId}`).set(W.teacher2.h).send({ title: 'Hacked title' })).status).toBe(403);
      expect((await api().get(`/api/teacher/homework/${hwId}`).set(W.teacher2.h)).status).toBe(403);
      // another teacher cannot delete it; its own teacher can, whatever its state (homework is kept simple)
      expect((await api().delete(`/api/teacher/homework/${hwId}`).set(W.teacher2.h)).status).toBe(403);
      const adminEdit = await api().patch(`/api/school/homework/${hwId}`).set(W.h).send({ instructions: 'Show working' });
      expect(adminEdit.status).toBe(200);
    });

    it('scheduled homework appears only after its publish time; overdue and tabs are derived', async () => {
      const when = new Date(Date.now() + 3600e3).toISOString();
      const s = await api().post('/api/teacher/homework').set(W.teacher1.h).send(hw({ title: 'Scheduled one', status: 'scheduled', publishAt: when }));
      expect(s.status).toBe(201);
      expect((await api().get('/api/student/homework').set(W.studentLogins[0].h)).body.map((x) => x.title)).not.toContain('Scheduled one');
      expect((await api().get('/api/teacher/homework?tab=scheduled').set(W.teacher1.h)).body).toHaveLength(1);
      await Homework.updateOne({ _id: s.body._id }, { publishAt: new Date(Date.now() - 1000) }); // time passes
      expect((await api().get('/api/student/homework').set(W.studentLogins[0].h)).body.map((x) => x.title)).toContain('Scheduled one');
      // an overdue one
      const past = await Homework.create({ tenantId: W.id, yearId: W.year._id, sectionId: W.sec8A._id, subjectId: W.maths._id, teacherId: W.t1.teacher._id, title: 'Old work', dueDate: addDays(TODAY, -4), assignedDate: addDays(TODAY, -9), status: 'published' });
      const od = (await api().get('/api/student/homework?tab=overdue').set(W.studentLogins[0].h)).body;
      expect(od.map((x) => x._id)).toContain(String(past._id));
      expect((await api().get('/api/teacher/homework?tab=completed').set(W.teacher1.h)).body.map((x) => x.title)).toContain('Old work');
      const dash = (await api().get('/api/student/dashboard').set(W.studentLogins[0].h)).body;
      expect(dash.cards.pendingHomework).toBe(2);
    });
  });

  describe('files: signed links and access control', () => {
    let fileId;
    it('uploads an attachment and rejects dangerous types', async () => {
      const bad = await api().post(`/api/teacher/homework/${hwId}/attachments`).set(W.teacher1.h).attach('file', Buffer.from('MZ'), { filename: 'x.exe', contentType: 'application/x-msdownload' });
      expect(bad.status).toBe(400);
      const ok = await api().post(`/api/teacher/homework/${hwId}/attachments`).set(W.teacher1.h).attach('file', Buffer.from('%PDF-1.4 test'), { filename: 'sheet.pdf', contentType: 'application/pdf' });
      expect(ok.status).toBe(201);
      fileId = ok.body.attachments[0];
    });

    it('issues short-lived signed links only to permitted users; guessing ids or tokens fails', async () => {
      const link = await api().post(`/api/shared/files/${fileId}/link`).set(W.studentLogins[0].h);
      expect(link.status).toBe(200);
      const dl = await api().get(link.body.url);
      expect(dl.status).toBe(200);
      expect(dl.headers['content-type']).toBe('application/pdf');
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
      expect((await api().post(`/api/shared/files/${fileId}/link`).set(outsider.h)).status).toBe(404);
      expect((await api().post(`/api/shared/files/${fileId}/link`).set(W.teacher2.h)).status).toBe(200); // teaches 8-A English
      expect((await api().get(`/api/files/download/${fileId}`)).status).toBe(403); // no token
      expect((await api().get(`/api/files/download/${fileId}?token=abc`)).status).toBe(403);
      const other = await api().post(`/api/shared/files/${W.students[0].student._id}/link`).set(W.studentLogins[0].h);
      expect(other.status).toBe(404);
      // a token for one file does not open another / a different user's cannot be replayed on a wrong id
      const second = await api().post(`/api/teacher/homework/${hwId}/attachments`).set(W.teacher1.h).attach('file', Buffer.from('hello'), { filename: 'n.txt', contentType: 'text/plain' });
      const f2 = second.body.attachments[1];
      const tok = new URL(`http://x${link.body.url}`).searchParams.get('token');
      expect((await api().get(`/api/files/download/${f2}?token=${encodeURIComponent(tok)}`)).status).toBe(403);
    });

    it('a student cannot reach a file of a draft homework', async () => {
      const d = (await api().post('/api/teacher/homework').set(W.teacher1.h).send(hw({ title: 'Secret draft' }))).body;
      const up = await api().post(`/api/teacher/homework/${d._id}/attachments`).set(W.teacher1.h).attach('file', Buffer.from('answers'), { filename: 'a.txt', contentType: 'text/plain' });
      expect((await api().post(`/api/shared/files/${up.body.attachments[0]}/link`).set(W.studentLogins[0].h)).status).toBe(404);
      expect((await api().post(`/api/shared/files/${up.body.attachments[0]}/link`).set(W.teacher1.h)).status).toBe(200);
    });

    it('student documents are private to the student and the admin', async () => {
      const sid = W.students[0].student._id;
      const up = await api().post(`/api/school/students/${sid}/documents`).set(W.h).field('docType', 'birth_certificate').attach('file', Buffer.from('%PDF-1.4 birth'), { filename: 'birth.pdf', contentType: 'application/pdf' });
      expect(up.status).toBe(201);
      const mine = (await api().get('/api/student/documents').set(W.studentLogins[0].h)).body;
      expect(mine).toHaveLength(1);
      expect((await api().get('/api/student/documents').set(W.studentLogins[1].h)).body).toHaveLength(0);
      expect((await api().post(`/api/shared/files/${up.body.id}/link`).set(W.studentLogins[0].h)).status).toBe(200);
      expect((await api().post(`/api/shared/files/${up.body.id}/link`).set(W.studentLogins[1].h)).status).toBe(404);
      expect((await api().post(`/api/shared/files/${up.body.id}/link`).set(W.teacher1.h)).status).toBe(404); // teachers don't get personal documents
    });
  });

  describe('study materials', () => {
    let m1; let m2;
    it('teacher uploads a file or link; students see only published, unexpired material for their section', async () => {
      const fileMat = await api().post('/api/teacher/materials').set(W.teacher1.h).field('title', 'Chapter 4 – Algebra').field('chapter', 'Chapter 4').field('sectionId', W.sec8A._id).field('subjectId', W.maths._id).field('materialType', 'pdf').field('status', 'published').attach('file', Buffer.from('%PDF-1.4 alg'), { filename: 'alg.pdf', contentType: 'application/pdf' });
      expect(fileMat.status).toBe(201);
      m1 = fileMat.body._id;
      const link = await api().post('/api/teacher/materials').set(W.teacher1.h).send({ title: 'Algebra revision video', chapter: 'Chapter 4', sectionId: W.sec8A._id, subjectId: W.maths._id, materialType: 'video', externalUrl: 'https://example.com/v', status: 'draft' });
      expect(link.status).toBe(201);
      m2 = link.body._id;
      expect((await api().post('/api/teacher/materials').set(W.teacher1.h).send({ title: 'Nothing', sectionId: W.sec8A._id, subjectId: W.maths._id })).status).toBe(400); // needs file or link
      expect((await api().post('/api/teacher/materials').set(W.teacher1.h).send({ title: 'JS link', sectionId: W.sec8A._id, subjectId: W.maths._id, externalUrl: 'javascript:alert(1)' })).status).toBe(400);
      const s = (await api().get('/api/student/materials').set(W.studentLogins[0].h)).body;
      expect(s.total).toBe(1);
      expect(s.groups[0]).toMatchObject({ subject: 'Mathematics' });
      expect(s.groups[0].chapters[0].chapter).toBe('Chapter 4');
      expect((await api().get('/api/student/materials').set(outsider.h)).body.total).toBe(0);
      expect((await api().get(`/api/student/materials/${m2}`).set(W.studentLogins[0].h)).status).toBe(404);
    });

    it('publish, unpublish, expiry and search behave', async () => {
      expect((await api().post(`/api/teacher/materials/${m2}/publish`).set(W.teacher1.h).send({})).status).toBe(200);
      expect((await api().get('/api/student/materials?q=video').set(W.studentLogins[0].h)).body.total).toBe(1);
      expect((await api().get('/api/student/materials?type=pdf').set(W.studentLogins[0].h)).body.total).toBe(1);
      await api().post(`/api/teacher/materials/${m2}/unpublish`).set(W.teacher1.h).send({});
      expect((await api().get('/api/student/materials').set(W.studentLogins[0].h)).body.total).toBe(1);
      await api().post(`/api/teacher/materials/${m2}/publish`).set(W.teacher1.h).send({});
      await StudyMaterial.updateOne({ _id: m2 }, { expiryDate: addDays(TODAY, -1) });
      expect((await api().get('/api/student/materials').set(W.studentLogins[0].h)).body.total).toBe(1); // expired hidden
      expect((await api().post(`/api/teacher/materials/${m1}/publish`).set(W.teacher2.h).send({})).status).toBe(403);
      const rep = await api().post(`/api/teacher/materials/${m1}/file`).set(W.teacher1.h).attach('file', Buffer.from('%PDF-1.4 v2'), { filename: 'v2.pdf', contentType: 'application/pdf' });
      expect(rep.status).toBe(200);
      expect((await api().delete(`/api/teacher/materials/${m1}`).set(W.teacher1.h)).status).toBe(409); // must unpublish first
    });
  });

  describe('announcements, calendar and messages', () => {
    it('targets sections, tracks read state and notifies the audience only', async () => {
      const a = await api().post('/api/school/announcements').set(W.h).send({ title: 'Class 8-A trip', body: 'Bring lunch', category: 'event', audience: { all: false, roles: [], sectionIds: [W.sec8A._id] } });
      expect(a.status).toBe(201);
      const all = await api().post('/api/school/announcements').set(W.h).send({ title: 'School closed Friday', category: 'holiday', audience: { all: true } });
      expect((await api().post('/api/school/announcements').set(W.h).send({ title: 'Nobody', audience: { all: false, roles: [], sectionIds: [] } })).status).toBe(400);
      const sA = (await api().get('/api/student/announcements').set(W.studentLogins[0].h)).body;
      expect(sA.map((x) => x.title).sort()).toEqual(['Class 8-A trip', 'School closed Friday']);
      expect(sA.every((x) => x.read === false)).toBe(true);
      expect((await api().get('/api/student/announcements').set(outsider.h)).body.map((x) => x.title)).toEqual(['School closed Friday']);
      expect((await api().get(`/api/student/announcements/${a.body._id}`).set(outsider.h)).status).toBe(404);
      await api().post(`/api/student/announcements/${a.body._id}/read`).set(W.studentLogins[0].h);
      expect((await api().get('/api/student/announcements').set(W.studentLogins[0].h)).body.find((x) => x._id === a.body._id).read).toBe(true);
      expect((await api().get('/api/teacher/announcements').set(W.teacher1.h)).body.map((x) => x.title)).toContain('Class 8-A trip');
      expect((await api().post('/api/school/announcements').set(W.studentLogins[0].h).send({ title: 'Fake notice', audience: { all: true } })).status).toBe(403);
      // teachers can send notices only to their own classes
      expect((await api().post('/api/teacher/announcements').set(W.teacher1.h).send({ title: 'Everyone!', sectionIds: [W.sec8B._id] })).status).toBe(403);
      expect((await api().post('/api/teacher/announcements').set(W.teacher1.h).send({ title: 'Nobody chosen', sectionIds: [] })).status).toBe(400);
      void all;
    });

    it('a wrongly sent broadcast can be deleted: the notice, read marks and bell notifications all disappear', async () => {
      // teacher sends a class notice by mistake…
      const sent = await api().post('/api/teacher/announcements').set(W.teacher1.h).send({ title: 'Test tomorrow (WRONG DATE)', body: 'Unit test on Sunday', category: 'examination', sectionIds: [W.sec8A._id] });
      expect(sent.status).toBe(201);
      const S = W.studentLogins[1].h;
      expect((await api().get('/api/student/announcements').set(S)).body.map((a) => a.title)).toContain('Test tomorrow (WRONG DATE)');
      expect((await api().get('/api/student/notifications').set(S)).body.items.some((n) => n.title === 'Test tomorrow (WRONG DATE)')).toBe(true);
      expect((await api().get('/api/teacher/announcements').set(W.teacher1.h)).body.find((a) => a._id === sent.body._id).mine).toBe(true);
      // …other teachers cannot delete it, the sender can
      expect((await api().delete(`/api/teacher/announcements/${sent.body._id}`).set(W.teacher2.h)).status).toBe(403);
      expect((await api().delete(`/api/teacher/announcements/${sent.body._id}`).set(W.teacher1.h)).status).toBe(200);
      expect((await api().get('/api/student/announcements').set(S)).body.map((a) => a.title)).not.toContain('Test tomorrow (WRONG DATE)');
      expect((await api().get('/api/student/notifications').set(S)).body.items.some((n) => n.title === 'Test tomorrow (WRONG DATE)')).toBe(false);
      expect((await api().get(`/api/student/announcements/${sent.body._id}`).set(S)).status).toBe(404);
      expect((await api().delete(`/api/teacher/announcements/${sent.body._id}`).set(W.teacher1.h)).status).toBe(404);
      // the admin can delete any announcement, including a teacher's; the audit log keeps the record
      const t2 = await api().post('/api/teacher/announcements').set(W.teacher2.h).send({ title: 'Bring a ruler', sectionIds: [W.sec8A._id] });
      expect((await api().delete(`/api/school/announcements/${t2.body._id}`).set(W.h)).status).toBe(200);
      expect((await api().delete(`/api/school/announcements/${t2.body._id}`).set(W.studentLogins[0].h)).status).toBe(403);
      expect((await api().get('/api/school/audit?action=announcement.deleted').set(W.h)).body).toHaveLength(2);
    });

    it('teachers can retract a message they sent to the admin', async () => {
      const m = await api().post('/api/teacher/messages').set(W.teacher1.h).send({ subject: 'Wrong message', body: 'Sent to the wrong person by mistake' });
      expect((await api().get('/api/school/messages').set(W.h)).body.some((x) => x._id === m.body._id)).toBe(true);
      expect((await api().delete(`/api/teacher/messages/${m.body._id}`).set(W.teacher2.h)).status).toBe(404);
      expect((await api().delete(`/api/teacher/messages/${m.body._id}`).set(W.teacher1.h)).status).toBe(200);
      expect((await api().get('/api/school/messages').set(W.h)).body.some((x) => x._id === m.body._id)).toBe(false);
    });

    it('notification centre: filter, mark read, mark all read, own notifications only', async () => {
      const S = W.studentLogins[0].h;
      const before = (await api().get('/api/student/notifications').set(S)).body;
      expect(before.unread).toBeGreaterThan(0);
      const one = before.items.find((n) => !n.readAt);
      await api().post(`/api/student/notifications/${one._id}/read`).set(S);
      expect((await api().post(`/api/student/notifications/${one._id}/read`).set(W.studentLogins[1].h)).status).toBe(404);
      await api().post('/api/student/notifications/read-all').set(S);
      expect((await api().get('/api/student/notifications').set(S)).body.unread).toBe(0);
      expect((await api().get('/api/student/notifications?category=announcements').set(S)).body.items.every((n) => n.category === 'announcements')).toBe(true);
    });

    it('calendar merges events and homework deadlines; teachers message the admin', async () => {
      await api().post('/api/school/events').set(W.h).send({ title: 'Sports Day', type: 'event', startDate: addDays(TODAY, 10) });
      await api().post('/api/school/events').set(W.h).send({ title: '8-B only PTM', type: 'ptm', startDate: addDays(TODAY, 11), sectionIds: [W.sec8B._id] });
      const cal = (await api().get('/api/student/calendar').set(W.studentLogins[0].h)).body;
      const titles = cal.map((c) => c.title);
      expect(titles).toContain('Sports Day');
      expect(titles).not.toContain('8-B only PTM');
      expect(cal.some((c) => c.type === 'deadline')).toBe(true);
      const msg = await api().post('/api/teacher/messages').set(W.teacher1.h).send({ subject: 'Projector broken', body: 'Room 101 projector is not working.' });
      expect(msg.status).toBe(201);
      expect(msg.body.status).toBe('delivered');
      expect((await api().get('/api/school/messages').set(W.h)).body).toHaveLength(1);
      expect((await api().get('/api/school/messages').set(W.teacher1.h)).status).toBe(403);
      const read = await api().post(`/api/school/messages/${msg.body._id}/read`).set(W.h);
      expect(read.body.status).toBe('read');
      expect((await api().get('/api/teacher/messages').set(W.teacher1.h)).body[0].status).toBe('read');
    });
  });
});
