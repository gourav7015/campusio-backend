import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { todayStr } from '../src/core/utils.js';
import { StaffMember } from '../src/models/index.js';

const TODAY = todayStr('Asia/Kolkata');

describe('Employees directory, officers as employees, and the Staff portal attendance desk', () => {
  let root; let W; let fin; let lib; let tr; let clerk; let sweeper; let driver; let clerkLogin;
  const mk = async (name, email, role) => { const c = await api().post('/api/school/staff').set(W.h).send({ name, email, role, phone: '9833333333', dob: '1984-04-04' }); expect(c.status).toBe(201); return { ...c.body, h: (await login(c.body.loginId, c.body.temporaryPassword, role)).h }; };
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'emp');
    fin = await mk('Fiona Finance', 'f@emp.test', 'finance'); lib = await mk('Lila Library', 'l@emp.test', 'library'); tr = await mk('Tara Transport', 't@emp.test', 'transport');
    const des = [...(await api().get('/api/school/designations').set(W.h)).body, ...(await api().get('/api/transport/designations').set(tr.h)).body]; const id = (n) => des.find((d) => d.name === n)._id;
    clerk = (await api().post('/api/school/support-staff').set(W.h).send({ name: 'Chhaya Clerk', designationId: id('Office Clerk'), phone: '9000000001', email: 'clerk@fixture.test', dob: '1984-04-04' })).body;
    sweeper = (await api().post('/api/school/support-staff').set(W.h).send({ name: 'Sunil Sweeper', designationId: id('Sweeper'), phone: '9000000002', email: 'clerk@fixture.test', dob: '1984-04-04' })).body;
    driver = (await api().post('/api/transport/staff').set(tr.h).send({ name: 'Dinesh Driver', designationId: id('Driver'), phone: '9000000003' })).body;
  });
  afterAll(teardown);

  it('one directory lists every kind of employee, each in its own category', async () => {
    const all = (await api().get('/api/school/employees').set(W.h)).body;
    expect(all.counts).toMatchObject({ teaching: 2, non_teaching: 2, office: 3, transport: 1, all: 8 });
    const names = (c) => all.items.filter((i) => i.category === c).map((i) => i.name).sort();
    expect(names('teaching')).toEqual(['Mr Sharma', 'Mrs Gupta']);
    expect(names('non_teaching')).toEqual(['Chhaya Clerk', 'Sunil Sweeper']);
    expect(names('office')).toEqual(['Fiona Finance', 'Lila Library', 'Tara Transport']);
    expect(names('transport')).toEqual(['Dinesh Driver']);
    expect(all.items.find((i) => i.name === 'Fiona Finance')).toMatchObject({ designation: 'Finance Officer', desk: 'Finance', hasLogin: true });
    expect(all.items.find((i) => i.name === 'Tara Transport')).toMatchObject({ designation: 'Transport Officer', category: 'office' }); // an officer, not transport crew
    expect(all.items.find((i) => i.name === 'Dinesh Driver')).toMatchObject({ designation: 'Driver', category: 'transport' });
    // filter, search, designation
    expect((await api().get('/api/school/employees?category=office').set(W.h)).body.items).toHaveLength(3);
    expect((await api().get('/api/school/employees?q=clerk').set(W.h)).body.items.map((i) => i.name)).toEqual(['Chhaya Clerk']);
    expect((await api().get('/api/school/employees?designation=Driver').set(W.h)).body.items).toHaveLength(1);
    expect((await api().get('/api/school/employees').set(W.teacher1.h)).status).toBe(403);
    // officers are not repeated in the non-teaching list
    expect((await api().get('/api/school/support-staff').set(W.h)).body.items.map((s) => s.name).sort()).toEqual(['Chhaya Clerk', 'Sunil Sweeper']);
  });

  it('each tab offers its own filters, and choosing one never hides the other choices', async () => {
    const get = async (qs) => (await api().get(`/api/school/employees?${qs}`).set(W.h)).body;
    // the designation choices belong to the tab, and stay the same after one is chosen (they used to shrink to the chosen one)
    const before = await get('category=non_teaching');
    expect(before.designations.map((d) => d.name)).toEqual(['Office Clerk', 'Sweeper']);
    const chosen = await get('category=non_teaching&designation=Sweeper');
    expect(chosen.items.map((i) => i.name)).toEqual(['Sunil Sweeper']);
    expect(chosen.designations.map((d) => d.name)).toEqual(['Office Clerk', 'Sweeper']);
    expect(chosen.counts).toMatchObject({ non_teaching: 2, all: 8 }); // the tab counts do not change with filters
    // a teaching tab never lists the designations of other tabs
    expect((await get('category=teaching')).designations.map((d) => d.name)).toEqual(['Teacher']);
    expect((await get('category=transport')).designations.map((d) => d.name)).toEqual(['Driver']);
    // teaching: by subject, by class, and class teachers
    const t = await get('category=teaching');
    expect(t.options.subjects.map((x) => x.name)).toEqual(['English', 'Mathematics']);
    expect(t.options.classes.map((x) => x.name)).toEqual(['Class 8']);
    const maths = t.options.subjects.find((x) => x.name === 'Mathematics').id;
    expect((await get(`category=teaching&subjectId=${maths}`)).items.map((i) => i.name)).toEqual(['Mr Sharma']);
    expect((await get(`category=teaching&classId=${t.options.classes[0].id}`)).items).toHaveLength(2);
    expect((await get('category=teaching&classTeacher=yes')).items.map((i) => [i.name, i.classTeacherOf])).toEqual([['Mr Sharma', 'Class 8 A']]);
    expect((await get('category=teaching')).items.find((i) => i.name === 'Mr Sharma')).toMatchObject({ subjects: ['Mathematics'], classes: ['Class 8'] });
    // officers by desk, crew by bus, anyone by sign-in
    expect((await get('category=office')).options.desks.sort()).toEqual(['Finance', 'Library', 'Transport']);
    expect((await get('category=office&desk=Library')).items.map((i) => i.name)).toEqual(['Lila Library']);
    expect((await get('category=transport&bus=off')).items.map((i) => i.name)).toEqual(['Dinesh Driver']);
    expect((await get('category=transport&bus=on')).items).toHaveLength(0);
    expect((await get('category=non_teaching&login=none')).items).toHaveLength(2);
    expect((await get('category=non_teaching&login=has')).items).toHaveLength(0);
    expect((await get('login=has')).items.length).toBe(5); // two teachers and three officers
    expect((await api().get('/api/school/employees?subjectId=nope').set(W.h)).status).toBe(400);
  });

  it('an officer made before this feature still shows up (rows are made on demand), and a disabled login is inactive', async () => {
    await StaffMember.deleteMany({ tenantId: W.id, deskRole: { $exists: true } }); // as if the school's data pre-dates the feature
    expect((await api().get('/api/school/employees?category=office').set(W.h)).body.items).toHaveLength(3);
    expect((await api().patch(`/api/school/staff/${lib.id}`).set(W.h).send({ status: 'disabled' })).status).toBe(200);
    expect((await api().get('/api/school/employees?category=office').set(W.h)).body.items.map((i) => i.name).sort()).toEqual(['Fiona Finance', 'Tara Transport']);
    expect((await api().get('/api/school/employees?category=office&status=inactive').set(W.h)).body.items.map((i) => i.name)).toEqual(['Lila Library']);
    await api().patch(`/api/school/staff/${lib.id}`).set(W.h).send({ status: 'active' });
  });

  it('the attendance registers have a group for each kind: teaching, non-teaching, office; transport stays with the Transport officer', async () => {
    const reg = (g) => api().get(`/api/school/staff-attendance/register?group=${g}`).set(W.h);
    expect((await reg('teachers')).body.rows.map((r) => r.name).sort()).toEqual(['Mr Sharma', 'Mrs Gupta']);
    expect((await reg('general')).body.rows.map((r) => r.name).sort()).toEqual(['Chhaya Clerk', 'Sunil Sweeper']);
    expect((await reg('office')).body.rows.map((r) => r.name).sort()).toEqual(['Fiona Finance', 'Lila Library', 'Tara Transport']);
    expect((await reg('transport')).status).toBe(403); // not the admin's register
    expect((await api().get(`/api/transport/attendance/register?group=transport`).set(tr.h)).body.rows.map((r) => r.name)).toEqual(['Dinesh Driver']);
    const tara = (await reg('office')).body.rows.find((r) => r.name === 'Tara Transport');
    const save = await api().put('/api/school/staff-attendance/register').set(W.h).send({ group: 'office', date: TODAY, submit: true, entries: [{ personId: tara.personId, status: 'absent', remark: 'Sick' }] });
    expect(save.status).toBe(200); expect(save.body.totals.absent).toBe(1);
  });

  it('transport crew have no sign-in; other staff have one only when they are given the office desk', async () => {
    expect((await api().post(`/api/transport/staff/${driver._id}/login`).set(tr.h)).status).toBe(403);
    const no = await api().post(`/api/school/support-staff/${sweeper._id}/login`).set(W.h);
    expect(no.status).toBe(400); expect(no.body.error).toMatch(/office desk/); // a sweeper has no office duties
    for (const s of [sweeper, clerk]) expect((await api().patch(`/api/school/support-staff/${s._id}`).set(W.h).send({ canMarkAttendance: true })).status).toBe(200);
    expect((await api().post(`/api/school/support-staff/${sweeper._id}/login`).set(W.h)).status).toBe(201);
    const c = await api().post(`/api/school/support-staff/${clerk._id}/login`).set(W.h);
    expect(c.status).toBe(201);
    clerkLogin = await login(c.body.loginId, c.body.temporaryPassword, 'staff');
  });

  it('a staff member given the office desk takes attendance from the Staff portal; nobody else can reach it', async () => {
    const desk = (p) => `/api/staff/attendance-desk${p}`;
    expect((await api().get('/api/auth/me').set(clerkLogin.h)).body.user.canMarkAttendance).toBe(true);
    expect((await api().patch(`/api/transport/staff/${driver._id}`).set(tr.h).send({ canMarkAttendance: true })).status).toBe(400); // crew cannot
    for (const [g, names] of [['teachers', ['Mr Sharma', 'Mrs Gupta']], ['general', ['Chhaya Clerk', 'Sunil Sweeper']], ['office', ['Fiona Finance', 'Lila Library', 'Tara Transport']]]) {
      expect((await api().get(desk(`/register?group=${g}`)).set(clerkLogin.h)).body.rows.map((r) => r.name).sort(), g).toEqual(names);
    }
    expect((await api().get(desk('/register?group=transport')).set(clerkLogin.h)).status).toBe(403); // never the transport crew
    const rows = (await api().get(desk('/register?group=teachers')).set(clerkLogin.h)).body.rows;
    const save = await api().put(desk('/register')).set(clerkLogin.h).send({ group: 'teachers', date: TODAY, submit: true, entries: [{ personId: rows[0].personId, status: 'absent', remark: 'On duty elsewhere' }] });
    expect(save.status).toBe(200); expect(save.body.totals.absent).toBe(1);
    // the admin sees the same register: one place, whoever took it
    expect((await api().get(`/api/school/staff-attendance/register?group=teachers`).set(W.h)).body.rows.find((r) => r.personId === rows[0].personId).status).toBe('absent');
    // the rest of the Staff portal is the same desk: employees (no transport crew), leave of non-teaching staff, queries
    const emp = (await api().get('/api/staff/employees?category=non_teaching').set(clerkLogin.h)).body;
    expect(emp.items.map((i) => i.name)).toEqual([]); // both were given the office desk, so they are listed with the desk holders
    expect((await api().get('/api/staff/employees?category=office').set(clerkLogin.h)).body.items.map((i) => i.name)).toEqual(expect.arrayContaining(['Chhaya Clerk', 'Sunil Sweeper'])); expect(emp.items.map((i) => i.name)).not.toContain('Ramesh Driver');
    expect((await api().get('/api/staff/employees?category=transport').set(clerkLogin.h)).status).toBe(403);
    expect((await api().get('/api/staff/leave').set(clerkLogin.h)).status).toBe(200);
    // other portals cannot reach the desk
    expect((await api().get(desk('/register?group=teachers')).set(W.teacher1.h)).status).toBe(403);
    expect((await api().get(desk('/register?group=teachers')).set(fin.h)).status).toBe(403);
    // the desk cannot be taken away while the person has a sign-in; the admin removes the sign-in (deactivates the person) first
    expect((await api().patch(`/api/school/support-staff/${clerk._id}`).set(W.h).send({ canMarkAttendance: false })).status).toBe(409);
    // removing the sign-in ends the session, keeps the person, and takes the desk away
    expect((await api().post(`/api/school/support-staff/${clerk._id}/remove-login`).set(W.h)).status).toBe(200);
    expect((await api().get('/api/staff/profile').set(clerkLogin.h)).status).toBe(401);
    expect((await api().get('/api/school/support-staff?q=Chhaya').set(W.h)).body.items[0]).toMatchObject({ name: 'Chhaya Clerk', hasLogin: false, canMarkAttendance: false });
  });

  it('the admin can add a staff member with a Staff portal login in one step, from the desk logins page', async () => {
    const des = (await api().get('/api/school/designations').set(W.h)).body;
    const peon = des.find((d) => d.name === 'Peon')._id;
    expect((await api().post('/api/school/staff').set(W.h).send({ name: 'No Title', role: 'staff', phone: '9833333333', dob: '1984-04-04', email: 'staff@fixture.test' })).status).toBe(400); // a job title is needed
    const c = await api().post('/api/school/staff').set(W.h).send({ name: 'Pappu Peon', role: 'staff', designationId: peon, canMarkAttendance: true, phone: '9833333333', dob: '1984-04-04', email: 'staff@fixture.test' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ role: 'staff', name: 'Pappu Peon' });
    expect(c.body.loginId).toMatch(/^emp\.s\d{4}$/); expect(c.body.temporaryPassword).toBeTruthy();
    const me = await login(c.body.loginId, c.body.temporaryPassword, 'staff');
    expect((await api().get('/api/auth/me').set(me.h)).body.user.canMarkAttendance).toBe(true); // and the attendance desk was given at the same time
    expect((await api().get('/api/school/employees?category=office&q=Pappu').set(W.h)).body.items[0]).toMatchObject({ name: 'Pappu Peon', hasLogin: true, canMarkAttendance: true, desk: 'Office', lastActiveAt: expect.anything() });
  });

  it('a desk role is held by a person: an existing employee is given the role, keeps their record, and the role itself is never a payable person', async () => {
    const des = (await api().get('/api/school/designations').set(W.h)).body;
    const gita = (await api().post('/api/school/support-staff').set(W.h).send({ name: 'Gita Sharma', designationId: des.find((d) => d.name === 'Office Clerk')._id, phone: '9111111111', email: 'clerk@fixture.test', dob: '1984-04-04' })).body;
    const make = (body) => api().post('/api/school/staff').set(W.h).send({ role: 'finance', email: 'gita@emp.test', ...body, phone: '9833333333', dob: '1984-04-04' });
    expect((await make({ staffMemberId: '0'.repeat(24) })).status).toBe(404);
    expect((await make({ staffMemberId: driver._id })).status).toBe(400); // transport crew cannot hold an officer role
    expect((await make({ staffMemberId: sweeper._id })).status).toBe(409); // already has a login
    const ok = await make({ staffMemberId: gita._id });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ name: 'Gita Sharma', role: 'finance' }); // the login carries the person's own name
    const asFinance = await login(ok.body.loginId, ok.body.temporaryPassword, 'finance');
    expect(asFinance.user.name).toBe('Gita Sharma');
    expect((await make({ staffMemberId: gita._id, email: 'again@emp.test' })).status).toBe(409);
    // she is one person in the directory: an office clerk who holds the Finance desk, with her own staff number
    const emp = (await api().get('/api/school/employees?q=Gita').set(W.h)).body.items;
    expect(emp).toHaveLength(1);
    expect(emp[0]).toMatchObject({ name: 'Gita Sharma', category: 'office', designation: 'Office Clerk', code: gita.staffId, desk: 'Finance', hasLogin: true }); // she keeps her own job title and also holds the Finance desk
    expect((await api().get('/api/school/support-staff?q=Gita').set(W.h)).body.items).toHaveLength(0); // no longer in the non-teaching list
    // the desk logins list shows the person, the role they hold and their staff number; a role-named account can be given a real name
    const list = (await api().get('/api/school/staff').set(W.h)).body;
    expect(list.find((u) => u.name === 'Gita Sharma')).toMatchObject({ role: 'finance', title: 'Office Clerk', code: gita.staffId, phone: '9111111111' });
    const renamed = await api().patch(`/api/school/staff/${fin.id}`).set(W.h).send({ name: 'Farah Khan', phone: '9222222222' });
    expect(renamed.status).toBe(200);
    expect((await api().get('/api/school/employees?q=Farah').set(W.h)).body.items[0]).toMatchObject({ name: 'Farah Khan', phone: '9222222222', designation: 'Finance Officer' });
    // payroll lists people, never the title itself
    const pay = (await api().get('/api/school/payroll/salaries').set(W.h)).body.items.map((x) => x.name);
    expect(pay).toContain('Gita Sharma'); expect(pay).not.toContain('Finance Officer');
  });
});
