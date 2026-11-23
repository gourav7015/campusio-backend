import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, login, makeSuperAdmin, seedWorld } from './helpers.js';
import { Notification } from '../src/models/index.js';

/**
 * Inside one school: a student sees only their own things, a teacher only their own classes' students, a desk only its own work.
 * (Across schools is covered by 15-cross-tenant-security.)
 */
describe('people in the same school cannot see each other\'s records', () => {
  let root; let W; let fin; let payB; let kidB; let outside;
  const A = () => W.studentLogins[0].h; const B = () => W.studentLogins[1].h;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'iso');
    const s = await api().post('/api/school/staff').set(W.h).send({ name: 'Fiona Finance', email: 'fiona@iso.test', role: 'finance', phone: '9833333333', dob: '1984-04-04' });
    fin = await login(s.body.loginId, s.body.temporaryPassword, 'finance');
    kidB = W.students[1].student;
    const ch = await api().post('/api/finance/charges').set(fin.h).send({ studentId: kidB._id, label: 'Lost ID card', amount: 200, dueDate: '2026-12-01' });
    expect(ch.status).toBe(201);
    const pay = await api().post('/api/finance/payments').set(fin.h).send({ studentId: kidB._id, amount: 200, mode: 'cash' });
    expect(pay.status).toBe(201); payB = pay.body.payment || pay.body;
    // a student in a class that Mr Sharma does not teach
    outside = (await api().post('/api/school/students').set(W.h).send({ name: 'Outside Kid', dob: '2013-05-05', sectionId: W.sec8B._id, admissionDate: '2026-04-15', guardians: [{ name: 'Parent', relationship: 'Father', phone: '9876500099', email: 'p@iso.test', isPrimary: true }] })).body;
  });
  afterAll(teardown);

  it('a student reads their own receipt, and another student gets nothing for the same address', async () => {
    const id = payB._id || payB.id;
    expect((await api().get(`/api/student/fees/receipts/${id}.pdf`).set(B())).status).toBe(200);
    const other = await api().get(`/api/student/fees/receipts/${id}.pdf`).set(A());
    expect([403, 404]).toContain(other.status);
    expect((await api().get(`/api/student/fees/receipts/${id}.pdf`).set(W.teacher1.h)).status).toBe(403); // a teacher has no student fee pages at all
  });

  it('a student\'s own pages show only their own money', async () => {
    const mine = (await api().get('/api/student/fees').set(B())).body;
    const theirs = (await api().get('/api/student/fees').set(A())).body;
    expect(mine.payments).toHaveLength(1); expect(theirs.payments ?? []).toHaveLength(0);
    expect(JSON.stringify(theirs)).not.toContain('Lost ID card');
  });

  it('a help desk ticket is visible only to the person who raised it', async () => {
    const t = await api().post('/api/student/tickets').set(B()).send({ subject: 'Fee question', body: 'Please check my fee' });
    expect(t.status).toBe(201);
    expect((await api().get(`/api/student/tickets/${t.body._id || t.body.id}`).set(B())).status).toBe(200);
    expect((await api().get(`/api/student/tickets/${t.body._id || t.body.id}`).set(A())).status).toBe(404);
    expect((await api().get('/api/student/tickets').set(A())).body.items ?? (await api().get('/api/student/tickets').set(A())).body).not.toEqual(expect.arrayContaining([expect.objectContaining({ subject: 'Fee question' })]));
  });

  it('a notification belongs to one person: someone else cannot mark it read', async () => {
    const n = await Notification.findOne({ userId: W.studentLogins[1].user.id || W.studentLogins[1].user._id });
    expect(n).toBeTruthy(); // the school's admission sends the student a notification
    const r = await api().post(`/api/student/notifications/${n._id}/read`).set(A());
    expect([403, 404]).toContain(r.status);
    expect((await Notification.findById(n._id)).readAt ?? (await Notification.findById(n._id)).read).toBeFalsy();
  });

  it('a teacher sees only the students of the classes they teach', async () => {
    expect((await api().get(`/api/teacher/students/${W.students[0].student._id}`).set(W.teacher1.h)).status).toBe(200); // Mr Sharma teaches 8-A
    const no = await api().get(`/api/teacher/students/${outside.student._id}`).set(W.teacher1.h);
    expect([403, 404]).toContain(no.status);
  });

  it('a student cannot use a teacher\'s, finance\'s or admin\'s pages, and the other way round', async () => {
    for (const url of ['/api/teacher/dashboard', '/api/finance/dashboard', '/api/school/dashboard', '/api/library/dashboard', '/api/transport/dashboard', '/api/platform/schools']) {
      expect([401, 403]).toContain((await api().get(url).set(A())).status);
    }
    expect((await api().get('/api/student/dashboard').set(W.teacher1.h)).status).toBe(403);
    expect((await api().get('/api/student/dashboard').set(fin.h)).status).toBe(403);
    expect((await api().get('/api/teacher/dashboard').set(fin.h)).status).toBe(403);
    expect((await api().get('/api/student/dashboard')).status).toBe(401); // nobody signed in
  });
});
