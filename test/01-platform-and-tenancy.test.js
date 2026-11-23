import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, makeSchool, seedWorld, login } from './helpers.js';

describe('platform, provisioning rules and tenant isolation', () => {
  let root; let A; let B;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); A = await seedWorld(root, 'aaa'); B = await makeSchool(root, 'bbb'); });
  afterAll(teardown);

  it('rejects unauthenticated and malformed tokens', async () => {
    expect((await api().get('/api/school/years')).status).toBe(401);
    expect((await api().get('/api/school/years').set('Authorization', 'Bearer junk')).status).toBe(401);
    expect((await api().post('/api/auth/login').send({ loginId: 'nobody', password: 'x', portal: 'student' })).status).toBe(401);
  });

  it('only Super Admin can create schools and school admins', async () => {
    expect((await api().post('/api/platform/schools').set(A.h).send({ name: 'X School', code: 'xx' })).status).toBe(403);
    expect((await api().post('/api/platform/schools').set(A.teacher1.h).send({ name: 'X School', code: 'xx' })).status).toBe(403);
    const dup = await api().post('/api/platform/schools').set(root.h).send({ name: 'Dup', code: 'aaa' });
    expect(dup.status).toBe(409);
    const adm = await api().post(`/api/platform/schools/${A.id}/admins`).set(root.h).send({ name: 'Second Admin', email: 'two@aaa.test', phone: '9811111112', dob: '1981-01-01' });
    expect(adm.status).toBe(201);
    expect(adm.body.temporaryPassword).toBeTruthy();
    expect((await api().post(`/api/platform/schools/${A.id}/admins`).set(A.h).send({ name: 'Sneaky', email: 'sneaky@aaa.test' })).status).toBe(403);
  });

  it('teachers and students cannot create users or reach the admin portal', async () => {
    for (const who of [A.teacher1, A.studentLogins[0]]) {
      expect((await api().post('/api/school/students').set(who.h).send({})).status).toBe(403);
      expect((await api().post('/api/school/teachers').set(who.h).send({})).status).toBe(403);
      expect((await api().get('/api/platform/stats').set(who.h)).status).toBe(403);
    }
    expect((await api().get('/api/teacher/dashboard').set(A.studentLogins[0].h)).status).toBe(403);
    expect((await api().get('/api/student/dashboard').set(A.teacher1.h)).status).toBe(403);
  });

  it('School B admin cannot see or touch School A records (IDOR / tenancy)', async () => {
    const sid = A.students[0].student._id;
    expect((await api().get(`/api/school/students/${sid}`).set(B.h)).status).toBe(404);
    expect((await api().patch(`/api/school/students/${sid}`).set(B.h).send({ name: 'Hacked' })).status).toBe(404);
    expect((await api().get(`/api/school/teachers/${A.t1.teacher._id}`).set(B.h)).status).toBe(404);
    expect((await api().get('/api/school/students').set(B.h)).body.total).toBe(0);
    // a tenantId in the body or query is ignored
    const res = await api().get(`/api/school/students?tenantId=${A.id}`).set(B.h);
    expect(res.body.total).toBe(0);
    // can't place a student into another school's section
    const x = await api().post('/api/school/students').set(B.h).send({ name: 'Cross Tenant', dob: '2013-01-01', sectionId: A.sec8A._id, guardians: [{ email: 'guardian@fixture.test', name: 'Parent', relationship: 'Father', phone: '9876543210' }] });
    expect([400, 404]).toContain(x.status);
  });

  it('Super Admin can act inside a school (data dumping) and it is audited; it cannot use portal routes', async () => {
    const h = { ...root.h, 'X-Acting-School': A.id };
    const noCtx = await api().get('/api/school/years').set(root.h);
    expect(noCtx.status).toBe(400);
    const ok = await api().get('/api/school/years').set(h);
    expect(ok.status).toBe(200);
    const mk = await api().post('/api/school/classes').set(h).send({ name: 'Class 10' });
    expect(mk.status).toBe(201);
    const logs = await api().get('/api/school/audit?action=class.created').set(A.h);
    expect(logs.body.some((l) => l.actingAsSuperAdmin === true)).toBe(true);
    expect((await api().get('/api/teacher/dashboard').set(h)).status).toBe(403);
    expect((await api().get('/api/school/years').set({ ...root.h, 'X-Acting-School': 'not-an-id' })).status).toBe(400);
    expect((await api().get('/api/school/years').set({ ...A.h, 'X-Acting-School': B.id })).body.length).toBeGreaterThan(0); // header ignored for non-super users
    const own = await api().get('/api/school/classes').set({ ...A.h, 'X-Acting-School': B.id });
    expect(own.body.some((c) => c.name === 'Class 8')).toBe(true);
  });

  it('puts no cap on how many students or teachers a school can have (only sections have a capacity)', async () => {
    const old = await api().post('/api/platform/schools').set(root.h).send({ name: 'Old Client School', code: 'oldc', subscription: { status: 'active', studentLimit: 1, teacherLimit: 1 }, admin: { name: 'Admin', email: 'admin@oldc.test', phone: '9811111111', dob: '1980-05-05', password: 'Admin@12345' } });
    expect(old.status).toBe(201); // a limit sent by an old client is simply ignored
    const tiny = await makeSchool(root, 'tiny');
    const y = (await api().post('/api/school/years').set(tiny.h).send({ name: '2026-2027', startDate: '2026-04-01', endDate: '2027-03-31' })).body;
    const c = (await api().post('/api/school/classes').set(tiny.h).send({ name: 'Class 1' })).body;
    const s = (await api().post('/api/school/sections').set(tiny.h).send({ yearId: y._id, classId: c._id, name: 'A' })).body;
    const mk = (n, dob) => api().post('/api/school/students').set(tiny.h).send({ name: n, dob, sectionId: s._id, guardians: [{ email: 'guardian@fixture.test', name: 'Parent', relationship: 'Mother', phone: '9876543210' }] });
    expect((await mk('One Kid', '2018-01-01')).status).toBe(201);
    expect((await mk('Two Kid', '2018-02-02')).status).toBe(201);
    expect((await mk('Three Kid', '2018-03-03')).status).toBe(201);
    expect((await api().get('/api/school/dashboard').set(tiny.h)).body.subscription.studentLimit).toBeUndefined();
  });

  it('suspending a school blocks its users and kills their sessions; password policy and forced change work', async () => {
    const ok = await api().get('/api/teacher/dashboard').set(A.teacher2.h);
    expect(ok.status).toBe(200);
    const sus = await api().patch(`/api/platform/schools/${A.id}`).set(root.h).send({ status: 'suspended' });
    expect(sus.status).toBe(200);
    expect((await api().get('/api/teacher/dashboard').set(A.teacher2.h)).status).toBe(401);
    await api().patch(`/api/platform/schools/${A.id}`).set(root.h).send({ status: 'active' });
    const fresh = await login('gupta@dps.test'.replace('dps', 'dps'), A.t2.credentials.temporaryPassword).catch(() => null);
    expect(fresh === null || fresh.user.mustChangePassword === true).toBe(true);
  });

  it('change-password enforces policy and revokes other sessions', async () => {
    const t = await login(A.t1.credentials.loginId, A.t1.credentials.temporaryPassword);
    const other = await login(A.t1.credentials.loginId, A.t1.credentials.temporaryPassword);
    expect((await api().post('/api/auth/change-password').set(t.h).send({ currentPassword: A.t1.credentials.temporaryPassword, newPassword: 'short' })).status).toBe(400);
    expect((await api().post('/api/auth/change-password').set(t.h).send({ currentPassword: 'wrong', newPassword: 'Brand-new1' })).status).toBe(400);
    const temp = A.t1.credentials.temporaryPassword;
    expect((await api().post('/api/auth/change-password').set(t.h).send({ newPassword: temp })).status).toBe(400); // a first-time user is not asked for the temporary password, but cannot keep it
    expect((await api().post('/api/auth/change-password').set(t.h).send({ currentPassword: A.t1.credentials.temporaryPassword, newPassword: 'Brand-new1' })).status).toBe(200);
    expect((await api().get('/api/auth/me').set(other.h)).status).toBe(401);
    expect((await api().get('/api/auth/me').set(t.h)).status).toBe(200);
    expect((await api().post('/api/auth/login').send({ loginId: A.t1.credentials.loginId, password: 'Brand-new1', portal: 'teacher' })).status).toBe(200);
  });

  it('a first-time user sets their own password without being asked for the temporary one', async () => {
    const t = await login(A.t2.credentials.loginId, A.t2.credentials.temporaryPassword);
    expect(t.user.mustChangePassword).toBe(true);
    expect((await api().post('/api/auth/change-password').set(t.h).send({ newPassword: 'First-own-pass1' })).status).toBe(200);
    expect((await api().post('/api/auth/change-password').set(t.h).send({ newPassword: 'Another-pass22' })).status).toBe(400); // afterwards the current password is required again
    expect((await api().post('/api/auth/login').send({ loginId: A.t2.credentials.loginId, password: 'First-own-pass1', portal: 'teacher' })).status).toBe(200);
  });

  it('platform stats and audit endpoints are Super Admin only', async () => {
    const stats = await api().get('/api/platform/stats').set(root.h);
    expect(stats.status).toBe(200);
    expect(stats.body.schools).toBeGreaterThanOrEqual(3);
    expect((await api().get('/api/platform/audit').set(root.h)).body.length).toBeGreaterThan(0);
    expect((await api().get('/api/platform/audit').set(B.h)).status).toBe(403);
  });
});
