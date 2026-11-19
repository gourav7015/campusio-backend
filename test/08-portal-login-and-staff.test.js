import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { todayStr, addDays, isoDay } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');

describe('one login page per role, staff accounts, heat map', () => {
  let root; let W; let fin; let lib;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'prt'); });
  afterAll(teardown);
  const tryLogin = (loginId, password, portal) => api().post('/api/auth/login').send({ loginId, password, portal });

  it('a login must come through the portal that matches the account\'s role', async () => {
    expect((await api().post('/api/auth/login').send({ loginId: 'admin@prt.test', password: 'Admin@12345' })).status).toBe(400); // portal is required
    expect((await tryLogin('admin@prt.test', 'Admin@12345', 'admin')).status).toBe(200);
    const wrong = await tryLogin('admin@prt.test', 'Admin@12345', 'student');
    // the wrong door answers exactly like a wrong password, so it never confirms that the credentials are right
    const badPw = await tryLogin('admin@prt.test', 'Wrong@12345', 'admin');
    expect(wrong.status).toBe(401); expect(wrong.status).toBe(badPw.status);
    expect(wrong.body).toEqual(badPw.body); expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    expect((await tryLogin('admin@prt.test', 'Admin@12345', 'platform')).status).toBe(401); // an admin cannot use the platform URL
    expect((await tryLogin('root@platform.test', 'Root@12345', 'admin')).status).toBe(401); // nor the super admin the school one
    expect((await tryLogin('root@platform.test', 'Root@12345', 'platform')).status).toBe(200);
    // the portal is only revealed once the password is right — a wrong password learns nothing
    const bad = await tryLogin('admin@prt.test', 'wrong', 'student');
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('Invalid login id or password');
    expect((await tryLogin('nobody@prt.test', 'x', 'teacher')).status).toBe(401);
    expect((await tryLogin(W.t1.credentials.loginId, W.t1.credentials.temporaryPassword, 'teacher')).status).toBe(200);
    expect((await tryLogin(W.t1.credentials.loginId, W.t1.credentials.temporaryPassword, 'student')).status).toBe(401);
    expect((await tryLogin(W.students[0].credentials.loginId, W.students[0].credentials.temporaryPassword, 'student')).status).toBe(200);
    expect((await tryLogin(W.students[0].credentials.loginId, W.students[0].credentials.temporaryPassword, 'teacher')).status).toBe(401);
    expect((await tryLogin('admin@prt.test', 'Admin@12345', 'bogus')).status).toBe(400);
  });

  it('School Admin creates Finance and Library staff; they can only use their own portals', async () => {
    const f = await api().post('/api/school/staff').set(W.h).send({ name: 'Fiona Finance', email: 'fiona@prt.test', role: 'finance' });
    const l = await api().post('/api/school/staff').set(W.h).send({ name: 'Liam Library', email: 'liam@prt.test', role: 'library' });
    expect([f.status, l.status]).toEqual([201, 201]);
    expect((await api().post('/api/school/staff').set(W.h).send({ name: 'Bad', email: 'x@prt.test', role: 'school_admin' })).status).toBe(400); // admins are only created by the Super Admin
    expect((await api().post('/api/school/staff').set(W.h).send({ name: 'Dup', email: 'fiona@prt.test', role: 'finance' })).status).toBe(409);
    expect((await api().post('/api/school/staff').set(W.teacher1.h).send({ name: 'Sneaky', email: 's@prt.test', role: 'finance' })).status).toBe(403);
    expect((await api().post('/api/school/staff').set({ ...root.h, 'X-Acting-School': W.id }).send({ name: 'Acted Clerk', email: 'acted@prt.test', role: 'finance' })).status).toBe(201);
    fin = await login(f.body.loginId, f.body.temporaryPassword, 'finance');
    lib = await login(l.body.loginId, l.body.temporaryPassword, 'library');
    expect((await tryLogin(f.body.loginId, f.body.temporaryPassword, 'library')).status).toBe(401);
    expect((await api().get('/api/finance/dashboard').set(fin.h)).status).toBe(200);
    expect((await api().get('/api/library/dashboard').set(fin.h)).status).toBe(403); // finance cannot use the library desk
    expect((await api().get('/api/finance/dashboard').set(lib.h)).status).toBe(403);
    expect((await api().get('/api/library/dashboard').set(lib.h)).status).toBe(200);
    // neither can touch the school's academic data, nor can students/teachers reach their desks
    for (const who of [fin, lib]) {
      expect((await api().get('/api/school/students').set(who.h)).status).toBe(403);
      expect((await api().get('/api/teacher/dashboard').set(who.h)).status).toBe(403);
      expect((await api().post('/api/school/staff').set(who.h).send({ name: 'x', email: 'y@prt.test', role: 'finance' })).status).toBe(403);
    }
    expect((await api().get('/api/finance/dashboard').set(W.teacher1.h)).status).toBe(403);
    expect((await api().get('/api/library/dashboard').set(W.studentLogins[0].h)).status).toBe(403);
    // the admin sees both staff, can disable (sessions die) and reset passwords
    const list = (await api().get('/api/school/staff').set(W.h)).body;
    expect(list.map((x) => x.role).sort()).toEqual(['finance', 'finance', 'library']);
    expect((await api().patch(`/api/school/staff/${f.body.id}`).set(W.h).send({ status: 'disabled' })).status).toBe(200);
    expect((await api().get('/api/finance/dashboard').set(fin.h)).status).toBe(401);
    expect((await tryLogin(f.body.loginId, f.body.temporaryPassword, 'finance')).status).toBe(403);
    await api().patch(`/api/school/staff/${f.body.id}`).set(W.h).send({ status: 'active' });
    const reset = await api().post(`/api/school/staff/${f.body.id}/reset-password`).set(W.h);
    expect((await tryLogin(reset.body.loginId, reset.body.temporaryPassword, 'finance')).body.user.mustChangePassword).toBe(true);
  });

  it('students see an attendance heat map of the whole year so far; unmarked days are blank, never absent', async () => {
    const d = (() => { let x = addDays(TODAY, -2); while (isoDay(x) === 7) x = addDays(x, -1); return x; })();
    const reg = (await api().get(`/api/teacher/attendance/register?sectionId=${W.sec8A._id}&date=${d}`).set(W.teacher1.h)).body;
    await api().post('/api/teacher/attendance/register/submit').set(W.teacher1.h).send({ sectionId: W.sec8A._id, date: d, entries: reg.students.map((s, i) => ({ studentId: s.studentId, status: i === 0 ? 'absent' : 'present' })) });
    const hm = (await api().get('/api/student/attendance/heatmap').set(W.studentLogins[0].h)).body;
    expect(hm.from).toBe('2026-04-01');
    expect(hm.to).toBe(TODAY);
    expect(hm.days[0].date).toBe('2026-04-01');
    expect(hm.days.at(-1).date).toBe(TODAY);
    expect(hm.days.filter((x) => x.status)).toHaveLength(1);
    expect(hm.days.find((x) => x.date === d)).toMatchObject({ status: 'absent', working: true });
    expect(hm.days.find((x) => x.date === addDays(d, -1) && isoDay(x.date) !== 7)?.status ?? null).toBeNull();
    expect(hm.days.filter((x) => isoDay(x.date) === 7).every((x) => x.working === false)).toBe(true);
    expect((await api().get('/api/student/attendance/heatmap').set(W.studentLogins[1].h)).body.days.find((x) => x.date === d).status).toBe('present'); // each student sees only their own
  });
});
