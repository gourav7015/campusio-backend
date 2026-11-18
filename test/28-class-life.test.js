import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';
import { StudentRemark, Notification } from '../src/models/index.js';
import { runRemarkReminders } from '../src/modules/class-life/class-life.service.js';

const TODAY = todayStr('Asia/Kolkata');

describe('Class life: remarks the family must acknowledge, chat, contact updates, monitors, regularise, photos', () => {
  let root; let W; let sid; let S; let T; let T2;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'cl');
    sid = W.students[0].student._id; S = W.studentLogins[0].h; T = W.teacher1.h; T2 = W.teacher2.h; // Mr Sharma is class teacher of 8-A, Mrs Gupta teaches English there
    await api().put('/api/school/settings').set(W.h).send({ workingDays: [1, 2, 3, 4, 5, 6, 7] });
  });
  afterAll(teardown);

  it('a remark notifies the family, who acknowledge it; reminders go out once a day until they do', async () => {
    const r = await api().post(`/api/teacher/students/${sid}/remarks`).set(T).send({ text: 'Homework was incomplete three times', category: 'homework' });
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ category: 'homework', requireAck: true });
    expect((await api().post(`/api/teacher/students/${W.students[1].student._id}/remarks`).set(T).send({ text: 'x y z' })).status).toBe(201);
    expect((await api().post(`/api/teacher/students/${sid}/remarks`).set(W.teacher1.h).send({ text: 'ab' })).status).toBe(400);
    const list = (await api().get('/api/student/remarks').set(S)).body;
    expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ acknowledged: false, teacher: 'Mr Sharma' });
    expect((await api().get('/api/student/dashboard').set(S)).body.toDo.remarksToAcknowledge).toBe(1);
    // yesterday's remark, still open: a reminder today, but only one a day
    await StudentRemark.updateOne({ _id: r.body._id }, { $set: { date: addDays(TODAY, -1) } });
    const school = W.id;
    expect(await runRemarkReminders(school, TODAY)).toBe(1);
    expect(await runRemarkReminders(school, TODAY)).toBe(0);
    expect(await Notification.countDocuments({ tenantId: school, title: /Reminder/ })).toBe(1);
    expect((await api().get('/api/teacher/remarks?pending=true').set(T)).body.some((x) => x.student === 'Aarav Singh' && !x.acknowledged)).toBe(true);
    // another student cannot acknowledge it; the family can
    expect((await api().post(`/api/student/remarks/${r.body._id}/acknowledge`).set(W.studentLogins[1].h).send({})).status).toBe(404);
    expect((await api().post(`/api/student/remarks/${r.body._id}/acknowledge`).set(S).send({})).status).toBe(200);
    expect(await runRemarkReminders(school, addDays(TODAY, 1))).toBe(1); // only the other family's open remark: this one is acknowledged, so no more nudges
    expect((await api().get('/api/teacher/remarks').set(T)).body.find((x) => x.student === 'Aarav Singh').acknowledged).toBe(true);
  });

  it('parent and teacher chat: the family writes to their own teachers only, and each side sees unread messages', async () => {
    const teachers = (await api().get('/api/student/chat-teachers').set(S)).body;
    expect(teachers.map((t) => t.name).sort()).toEqual(['Mr Sharma', 'Mrs Gupta']);
    expect(teachers.find((t) => t.name === 'Mr Sharma').role).toBe('Class teacher');
    const c = await api().post('/api/student/chats').set(S).send({ teacherId: teachers.find((t) => t.name === 'Mrs Gupta').teacherId, text: 'Which chapter is the test on?' });
    expect(c.status).toBe(201);
    const threads = (await api().get('/api/teacher/chats').set(T2)).body;
    expect(threads).toHaveLength(1); expect(threads[0]).toMatchObject({ unread: 1, student: 'Aarav Singh' });
    expect((await api().get('/api/teacher/chats').set(T)).body).toHaveLength(0); // not Mr Sharma's conversation
    expect((await api().get(`/api/teacher/chats/${c.body._id}`).set(T)).status).toBe(404);
    const open = (await api().get(`/api/teacher/chats/${c.body._id}`).set(T2)).body;
    expect(open.messages.map((m) => m.text)).toEqual(['Which chapter is the test on?']);
    expect((await api().get('/api/teacher/chats').set(T2)).body[0].unread).toBe(0);
    await api().post(`/api/teacher/chats/${c.body._id}/messages`).set(T2).send({ text: 'Chapter 4' });
    const mine = (await api().get('/api/student/chats').set(S)).body;
    expect(mine[0]).toMatchObject({ unread: 1, teacher: 'Mrs Gupta', lastPreview: 'Chapter 4' });
    expect((await api().get('/api/student/chats').set(W.studentLogins[1].h)).body).toHaveLength(0); // another family sees nothing
    expect((await api().get(`/api/student/chats/${c.body._id}`).set(W.studentLogins[1].h)).status).toBe(404);
    // a teacher starts one with a student of theirs, not with anyone else's
    expect((await api().post('/api/teacher/chats').set(T).send({ studentId: sid, text: 'Hello' })).status).toBe(201);
    expect((await api().post('/api/student/chats').set(S).send({ teacherId: '64b000000000000000000000', text: 'Hi' })).status).toBe(403);
    expect((await api().get('/api/student/dashboard').set(S)).body.toDo.unreadChats).toBe(2);
  });

  it('the class teacher (only) updates a student\'s contact details; a student cannot', async () => {
    const ok = await api().patch(`/api/teacher/students/${sid}`).set(T).send({ phone: '9000011111', guardian: { phone: '9000022222' } });
    expect(ok.status).toBe(200);
    const p = (await api().get('/api/student/profile').set(S)).body;
    expect(p.personal.phone).toBe('9000011111'); expect(p.guardians[0].phone).toBe('9000022222');
    expect((await api().patch(`/api/teacher/students/${sid}`).set(T2).send({ phone: '9000099999' })).status).toBe(403); // subject teacher
    expect((await api().patch(`/api/teacher/students/${sid}`).set(T).send({ name: 'New Name' })).status).toBe(400); // identity is not editable here
    expect((await api().patch('/api/student/profile').set(S).send({ phone: '9000033333' })).status).toBe(403);
    expect((await api().patch('/api/teacher/profile').set(T).send({ phone: '1' })).status).toBe(403); // teachers' own details: office only
    expect((await api().get(`/api/teacher/students/${sid}`).set(T)).body.contact.phone).toBe('9000011111');
  });

  it('the class teacher picks up to five monitors, who show on registers and in the student profile', async () => {
    const sec = W.sec8A._id;
    const set = await api().put(`/api/teacher/classes/${sec}/monitors`).set(T).send({ studentIds: [sid, W.students[1].student._id] });
    expect(set.status).toBe(200);
    expect((await api().put(`/api/teacher/classes/${sec}/monitors`).set(T2).send({ studentIds: [sid] })).status).toBe(403);
    expect((await api().put(`/api/school/monitors/${sec}`).set(W.h).send({ studentIds: [W.students[2].student._id, '64b000000000000000000000'] })).status).toBe(400); // not a student of the class
    const reg = (await api().get(`/api/teacher/attendance/register?sectionId=${sec}&date=${TODAY}`).set(T)).body;
    expect(reg.students.filter((s) => s.monitor).map((s) => s.name).sort()).toEqual(['Aarav Singh', 'Bhavna Rao']);
    expect((await api().get('/api/student/profile').set(S)).body.academic.monitor).toBe(true);
    expect((await api().get('/api/student/profile').set(W.studentLogins[2].h)).body.academic.monitor).toBe(false);
    expect((await api().put(`/api/school/monitors/${sec}`).set(W.h).send({ studentIds: [W.students[2].student._id] })).status).toBe(200); // the admin may change them too
  });

  it('the class teacher regularises an absent or late mark within a week, with a reason, and it is kept on record', async () => {
    const sec = W.sec8A._id; const day = addDays(TODAY, -2);
    const entries = W.students.map((s, i) => ({ studentId: s.student._id, status: i === 0 ? 'absent' : i === 1 ? 'late' : 'present' }));
    expect((await api().put('/api/teacher/attendance/register').set(T).send({ sectionId: sec, date: day, entries })).status).toBe(200);
    expect((await api().post('/api/teacher/attendance/register/submit').set(T).send({ sectionId: sec, date: day, entries })).status).toBe(200);
    const body = (studentId, extra = {}) => ({ sectionId: sec, date: day, studentId, reason: 'Came in after the bell; the bus was late', ...extra });
    expect((await api().post('/api/teacher/attendance/regularise').set(T2).send(body(sid))).status).toBe(403);
    expect((await api().post('/api/teacher/attendance/regularise').set(T).send(body(sid, { reason: '' }))).status).toBe(400);
    expect((await api().post('/api/teacher/attendance/regularise').set(T).send(body(W.students[2].student._id))).status).toBe(400); // present already
    expect((await api().post('/api/teacher/attendance/regularise').set(T).send(body(sid, { date: addDays(TODAY, -30) }))).status).toBe(400);
    expect((await api().post('/api/teacher/attendance/regularise').set(T).send(body(sid))).status).toBe(200);
    const reg = (await api().get(`/api/teacher/attendance/register?sectionId=${sec}&date=${day}`).set(T)).body;
    expect(reg.students.find((s) => s.name === 'Aarav Singh')).toMatchObject({ status: 'present', regularised: true, corrected: true });
    expect((await api().post('/api/teacher/attendance/regularise').set(T).send(body(W.students[1].student._id, { reason: 'Medical visit, note given' }))).status).toBe(200);
  });

  it('a student and a teacher add their own photo (a teacher sees the photos of their own students)', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const up = await api().post('/api/student/profile/photo').set(S).attach('file', png, { filename: 'me.png', contentType: 'image/png' });
    expect(up.status).toBe(200);
    const fileId = (await api().get('/api/student/profile').set(S)).body.personal.photoFileId;
    expect(fileId).toBeTruthy();
    expect((await api().post(`/api/shared/files/${fileId}/link`).set(S).send({})).status).toBe(200);
    expect((await api().post(`/api/shared/files/${fileId}/link`).set(T).send({})).status).toBe(200); // class teacher
    expect((await api().post(`/api/shared/files/${fileId}/link`).set(W.studentLogins[1].h).send({})).status).toBe(404); // another family
    const tup = await api().post('/api/teacher/profile/photo').set(T).attach('file', png, { filename: 'sir.png', contentType: 'image/png' });
    expect(tup.status).toBe(200);
    expect((await api().get('/api/teacher/profile').set(T)).body.photoFileId).toBeTruthy();
    expect((await api().post('/api/teacher/profile/photo').set(T).attach('file', Buffer.from('hello'), { filename: 'x.txt', contentType: 'text/plain' })).status).toBe(400);
  });
});
