import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, login, makeSuperAdmin, seedWorld } from './helpers.js';
import { Student, User, Payment, StudentRemark, Notification, EmailOutbox, Session } from '../src/models/index.js';
import { runRetention } from '../src/services/retention.js';

const A = (p) => `/api/school/privacy${p}`;

describe('Privacy: consent record, one student’s data as a download, erasure of a former student, retention', () => {
  let root; let W; let sid; let adm;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'prv');
    sid = W.students[0].student._id; adm = W.students[0].student.admissionNo;
  });
  afterAll(teardown);

  it('records and clears the guardian consent, and counts who has none', async () => {
    expect((await api().get(A('/consent-summary')).set(W.h)).body).toEqual({ activeStudents: 3, withConsent: 0, without: 3 });
    expect((await api().put(A(`/students/${sid}/consent`)).set(W.h).send({ givenOn: 'yesterday', guardianName: 'X Y' })).status).toBe(400);
    const ok = await api().put(A(`/students/${sid}/consent`)).set(W.h).send({ givenOn: '2026-04-15', guardianName: 'Parent of Aarav', relationship: 'Father', note: 'Signed admission form' });
    expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ givenOn: '2026-04-15', guardianName: 'Parent of Aarav', recordedByName: expect.any(String) });
    expect((await api().get(A('/consent-summary')).set(W.h)).body.withConsent).toBe(1);
    expect((await api().delete(A(`/students/${sid}/consent`)).set(W.h)).status).toBe(200);
    expect((await api().get(A('/consent-summary')).set(W.h)).body.withConsent).toBe(0);
  });

  it('only the School Admin can use these, and only for their own school', async () => {
    expect((await api().get(A(`/students/${sid}/export`)).set(W.teacher1.h)).status).toBe(403);
    expect((await api().get(A(`/students/${sid}/export`)).set(W.studentLogins[0].h)).status).toBe(403);
    // a sub-admin (even with the students permission) does not get privacy tools
    const sub = (await api().post('/api/school/sub-admins').set(W.h).send({ name: 'Clerk', email: 'clerk@prv.test', permissions: ['students'] })).body;
    const sl = await login(sub.loginId, sub.temporaryPassword, 'admin');
    expect((await api().get(A(`/students/${sid}/export`)).set(sl.h)).status).toBe(403);
    // another school cannot reach this student
    const other = await seedWorld(root, 'oth');
    expect((await api().get(A(`/students/${sid}/export`)).set(other.h)).status).toBe(404);
    expect((await api().post(A(`/students/${sid}/erase`)).set(other.h).send({ confirmAdmissionNo: adm, reason: 'test only' })).status).toBe(404);
  });

  it('exports everything held about the student in one document', async () => {
    await api().put(A(`/students/${sid}/consent`)).set(W.h).send({ givenOn: '2026-04-15', guardianName: 'Parent of Aarav' });
    const r = await api().get(A(`/students/${sid}/export`)).set(W.h);
    expect(r.status).toBe(200); expect(r.headers['content-disposition']).toContain(`student-${adm}-data.json`);
    expect(r.body.student).toMatchObject({ name: 'Aarav Singh', admissionNo: adm }); expect(r.body.student.guardians[0].name).toContain('Parent of Aarav');
    expect(r.body.login.loginId).toBeTruthy(); expect(r.body.student.consent.guardianName).toBe('Parent of Aarav');
    expect(Object.keys(r.body.records)).toContain('StudentEnrolment');
    // nothing about another student is in it
    expect(JSON.stringify(r.body)).not.toContain('Bhavna Rao');
  });

  it('an active student cannot be erased; a former student can, once the admission number is typed', async () => {
    const body = { confirmAdmissionNo: adm, reason: 'Family asked for deletion' };
    expect((await api().post(A(`/students/${sid}/erase`)).set(W.h).send(body)).status).toBe(409);
    await api().patch(`/api/school/students/${sid}`).set(W.h).send({ status: 'withdrawn' }); // may be refused by clearance; set directly if so
    await Student.updateOne({ _id: sid }, { $set: { status: 'withdrawn' } });
    await StudentRemark.create({ tenantId: W.id, studentId: sid, teacherId: W.t1.teacher._id, text: 'Aarav was rude to Bhavna', date: '2026-05-01' });
    expect((await api().post(A(`/students/${sid}/erase`)).set(W.h).send({ ...body, confirmAdmissionNo: 'WRONG' })).status).toBe(400);
    const gone = await api().post(A(`/students/${sid}/erase`)).set(W.h).send(body);
    expect(gone.status).toBe(200);
    const s = await Student.findById(sid).lean();
    expect(s.name).toBe(`Former student ${adm}`); expect(s.guardians).toEqual([]); expect(s.dob).toBeUndefined(); expect(s.consent).toBeUndefined(); expect(s.anonymisedAt).toBeTruthy();
    expect(s.admissionNo).toBe(adm); // the record number stays, so fees and marks stay attached
    const u = await User.findById(W.students[0].user?._id || s.userId).lean();
    expect(u.status).toBe('disabled'); expect(u.loginId).toMatch(/^erased-/); expect(u.email).toBeUndefined();
    expect((await StudentRemark.findOne({ studentId: sid })).text).toBe('[removed]');
    // the old login no longer works, and the other students are untouched
    expect((await api().get('/api/auth/me').set(W.studentLogins[0].h)).status).toBe(401);
    expect((await Student.findById(W.students[1].student._id)).name).toBe('Bhavna Rao');
    expect((await api().post(A(`/students/${sid}/erase`)).set(W.h).send(body)).status).toBe(409); // once only
    expect(await Payment.countDocuments({ studentId: sid })).toBe(0); // (none were made here; the ledger is never touched by erasure)
  });

  it('old notifications, mail records and ended sessions are cleared; accounts are not', async () => {
    const old = new Date(Date.now() - 400 * 24 * 3600 * 1000); const mid = new Date(Date.now() - 200 * 24 * 3600 * 1000);
    const u = (await User.findOne({ role: 'school_admin', tenantId: W.id }))._id;
    await Notification.collection.insertMany([
      { tenantId: W.id, userId: u, title: 'old unread', createdAt: old, updatedAt: old },
      { tenantId: W.id, userId: u, title: 'read long ago', readAt: mid, createdAt: mid, updatedAt: mid },
      { tenantId: W.id, userId: u, title: 'recent', createdAt: new Date(), updatedAt: new Date() },
    ]);
    await EmailOutbox.collection.insertOne({ to: 'a@b.test', subject: 'old', status: 'sent', createdAt: mid, updatedAt: mid });
    await Session.collection.insertOne({ userId: u, jti: 'old-session', revokedAt: old, createdAt: old, updatedAt: old });
    const out = await runRetention();
    expect(out).toMatchObject({ notifications: 2, emails: 1, sessions: 1 });
    expect(await Notification.countDocuments({ title: 'recent' })).toBe(1);
    expect(await runRetention()).toBeNull(); // nothing more to clear
  });
});
