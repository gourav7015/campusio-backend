import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, login, makeSuperAdmin, seedWorld } from './helpers.js';
import { StaffMember, EmailOutbox } from '../src/models/index.js';
import { setMailTransport, flushEmails } from '../src/services/email.js';

describe('Desk logins: every desk is listed, an employee is assigned to it, and a reset asks for the password first', () => {
  let root; let W; let des; let stand; let office; let clerk; let sweeper; let tr; let driver;
  const A = (p) => `/api/school${p}`;
  const list = async () => (await api().get(A('/staff')).set(W.h)).body;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'dsk');
    const mk = (b) => api().post(A('/staff')).set(W.h).send({ phone: '9833333333', dob: '1984-04-04', ...b });
    stand = (await mk({ name: 'Accounts Officer', email: 'finance@dsk.test', role: 'finance' })).body; // a desk made without naming an employee: a stand-in
    tr = (await mk({ name: 'Tara Transport', email: 't@dsk.test', role: 'transport' })).body;
    des = (await api().get(A('/designations')).set(W.h)).body; const id = (n) => des.find((d) => d.name === n)._id;
    office = (await mk({ name: 'Pappu Peon', role: 'staff', designationId: id('Office Clerk'), email: 'peon@dsk.test' }));
    clerk = (await api().post(A('/support-staff')).set(W.h).send({ name: 'Chhaya Clerk', designationId: id('Office Clerk'), phone: '9000000001', email: 'clerk@dsk.test', dob: '1984-04-04' })).body;
    sweeper = (await api().post(A('/support-staff')).set(W.h).send({ name: 'Sunil Sweeper', designationId: id('Sweeper'), phone: '9000000002', email: 'sw@dsk.test', dob: '1984-04-04' })).body;
    const trh = (await login(tr.loginId, tr.temporaryPassword, 'transport')).h;
    const tdes = (await api().get('/api/transport/designations').set(trh)).body;
    driver = (await api().post('/api/transport/staff').set(trh).send({ name: 'Raju Driver', designationId: tdes.find((d) => d.name === 'Driver')._id, phone: '9000000003' })).body;
  });
  afterAll(() => { setMailTransport(null); return teardown(); });

  it('the office desk login appears in the list (it used to be missing), with its employee', async () => {
    expect(office.status).toBe(201);
    const rows = await list();
    const o = rows.find((r) => r.role === 'staff');
    expect(o).toBeTruthy(); expect(o.personName).toBe('Pappu Peon'); expect(o.status).toBe('active');
    expect(rows.map((r) => r.role).sort()).toEqual(['finance', 'staff', 'transport']);
  });

  it('a desk without a named employee says so; an assigned one does not', async () => {
    const rows = await list();
    expect(rows.find((r) => r.role === 'finance').assigned).toBe(false); // "Accounts Officer" is only the desk\'s stand-in
    expect(rows.find((r) => r.role === 'transport').assigned).toBe(true);
  });

  it('an existing employee is given the desk: the sign-in stays, the person changes, the stand-in goes', async () => {
    const before = await login(stand.loginId, stand.temporaryPassword, 'finance').catch(() => null);
    const bad = await api().post(A(`/staff/${stand.id}/assign`)).set(W.h).send({ staffMemberId: driver._id });
    expect(bad.status).toBe(400); // transport crew cannot hold an officer desk
    expect((await api().post(A(`/staff/${stand.id}/assign`)).set(W.teacher1.h).send({ staffMemberId: clerk._id })).status).toBe(403);
    const ok = await api().post(A(`/staff/${stand.id}/assign`)).set(W.h).send({ staffMemberId: clerk._id });
    expect(ok.status).toBe(200); expect(ok.body.name).toBe('Chhaya Clerk');
    const row = (await list()).find((r) => r.role === 'finance');
    expect(row).toMatchObject({ loginId: stand.loginId, personName: 'Chhaya Clerk', assigned: true, name: 'Chhaya Clerk' });
    expect(await StaffMember.countDocuments({ name: 'Accounts Officer' })).toBe(0); // the stand-in had no records, so it is removed
    const c = await StaffMember.findById(clerk._id); expect(String(c.userId)).toBe(String(stand.id)); expect(c.deskRole).toBe('finance');
    // the same desk login still signs in
    if (before) expect(before.token).toBeTruthy();
    // she cannot be given a second desk, and the desk cannot be given to her twice
    expect((await api().post(A(`/staff/${tr.id}/assign`)).set(W.h).send({ staffMemberId: clerk._id })).status).toBe(409);
    expect((await api().post(A(`/staff/${stand.id}/assign`)).set(W.h).send({ staffMemberId: clerk._id })).status).toBe(400);
    // a desk can pass to someone else later; the first person is released but stays on the staff list
    expect((await api().post(A(`/staff/${stand.id}/assign`)).set(W.h).send({ staffMemberId: sweeper._id })).status).toBe(200);
    const released = await StaffMember.findById(clerk._id); expect(released.userId).toBeUndefined(); expect(released.deskRole).toBeUndefined();
  });

  it('the office desk is given to another employee the same way; they keep their own job title and the first one is released', async () => {
    const officeUser = (await list()).find((r) => r.role === 'staff');
    const first = await StaffMember.findOne({ userId: officeUser._id });
    const spare = (await api().post(A('/support-staff')).set(W.h).send({ name: 'Mohan Mali', designationId: des.find((d) => d.name === 'Office Clerk')._id, phone: '9000000004', email: 'mm@dsk.test', dob: '1984-04-04' })).body;
    const r = await api().post(A(`/staff/${officeUser._id}/assign`)).set(W.h).send({ staffMemberId: spare._id });
    expect(r.status).toBe(200);
    const now = await StaffMember.findById(spare._id);
    expect(String(now.userId)).toBe(String(officeUser._id)); expect(now.canMarkAttendance).toBe(true); expect(String(now.designationId)).toBe(String(spare.designationId)); expect(now.deskRole).toBeUndefined();
    const old = await StaffMember.findById(first._id); expect(old.userId).toBeUndefined(); expect(old.canMarkAttendance).toBe(false); // released, still on the staff list
    expect((await list()).find((x) => x.role === 'staff')).toMatchObject({ personName: 'Mohan Mali', assigned: true });
  });

  it('a desk login is made without a name, email, mobile or date of birth, and its login id can be seen first', async () => {
    const prev = (role, extra = '') => api().get(A(`/staff/login-preview?role=${role}${extra}`)).set(W.h);
    expect((await prev('library')).body.loginId).toBe('dsk.library'); // the school code, a dot and the desk
    const lib = await api().post(A('/staff')).set(W.h).send({ role: 'library' });
    expect(lib.status).toBe(201); expect(lib.body.loginId).toBe('dsk.library'); expect(lib.body.temporaryPassword).toBeTruthy();
    expect((await prev('library')).body.loginId).toBe('dsk.library2'); // the next free one
    const row = (await list()).find((r) => r.loginId === 'dsk.library');
    expect(row).toMatchObject({ role: 'library', assigned: false }); // nobody on the desk yet
    // the office desk belongs to an employee on the staff list: it needs one, shows its login id, and the employee keeps their job title
    expect((await api().post(A('/staff')).set(W.h).send({ role: 'staff' })).status).toBe(400);
    const emp = (await api().post(A('/support-staff')).set(W.h).send({ name: 'Geeta Guard', designationId: des.find((d) => d.name === 'Office Clerk')._id, phone: '9000000009' })).body; // no email, no date of birth
    const p2 = (await prev('staff', `&staffMemberId=${emp._id}`)).body.loginId; expect(p2).toBe(`dsk.${emp.staffId}`.toLowerCase());
    const off = await api().post(A('/staff')).set(W.h).send({ role: 'staff', staffMemberId: emp._id });
    expect(off.status).toBe(201); expect(off.body.loginId).toBe(p2);
    const e = await StaffMember.findById(emp._id); expect(e.canMarkAttendance).toBe(true); expect(String(e.designationId)).toBe(String(emp.designationId));
    expect((await api().post(A('/staff')).set(W.h).send({ role: 'staff', staffMemberId: emp._id })).status).toBe(409); // already has a login
  });

  it('Reset password uses the password that was typed or generated in the dialog, and checks it', async () => {
    const reset_ = (id, b) => api().post(A(`/staff/${id}/reset-password`)).set(W.h).send(b);
    expect((await reset_(tr.id, { password: 'short1' })).status).toBe(400);
    expect((await reset_(tr.id, { password: 'onlyletterspassword' })).status).toBe(400);
    expect((await reset_(tr.id, { password: 'Password123' })).status).toBe(400); // too common
    const ok = await reset_(tr.id, { password: 'Chosen-Desk-Pass-77' });
    expect(ok.status).toBe(200); expect(ok.body.temporaryPassword).toBe('Chosen-Desk-Pass-77');
    const l = await api().post('/api/auth/login').send({ loginId: tr.loginId, password: 'Chosen-Desk-Pass-77', portal: 'transport' });
    expect(l.status).toBe(200); expect(l.body.user.mustChangePassword).toBe(true); // the person still chooses their own at first sign-in
    // no password given: one is made, as before
    expect((await reset_(tr.id, {})).body.temporaryPassword).toBeTruthy();
    // the same for a student
    const s = W.students[0].student._id;
    const st = await api().post(A(`/students/${s}/reset-password`)).set(W.h).send({ password: 'Typed-Student-Pass-5' });
    expect(st.body.temporaryPassword).toBe('Typed-Student-Pass-5');
    expect((await api().post(A(`/students/${s}/reset-password`)).set(W.h).send({ password: 'x' })).status).toBe(400);
  });

  it('when a desk or staff login is made or its password is reset, the person who holds it is emailed the login id and temporary password', async () => {
    const sent = []; setMailTransport(async (m) => { sent.push(m); return { id: 'x' }; });
    const rows = await list();
    const o = rows.find((r) => r.role === 'staff'); // whoever holds the office desk by now
    await StaffMember.updateOne({ userId: o._id }, { email: 'desk.holder@dsk.test' });
    const reset = await api().post(A(`/staff/${o._id}/reset-password`)).set(W.h).send({});
    expect(reset.status).toBe(200);
    expect(reset.body.emailedTo).toMatch(/@dsk\.test$/); expect(reset.body.emailedTo).not.toBe('desk.holder@dsk.test'); // masked, for the admin to see where it went
    await flushEmails();
    const mail = sent.find((m) => m.to === 'desk.holder@dsk.test');
    expect(mail.subject).toMatch(/password/i);
    expect(mail.text).toContain(`Login id: ${reset.body.loginId}`);
    expect(mail.text).toContain(`Temporary password: ${reset.body.temporaryPassword}`);
    expect(mail.text).toMatch(/choose your own/);
    // an officer desk whose holder has no email on record: nothing is sent, and the admin is told
    const fin = (await list()).find((r) => r.role === 'finance');
    await StaffMember.updateOne({ userId: fin._id }, { $unset: { email: 1 } });
    const noMail = await api().post(A(`/staff/${fin._id}/reset-password`)).set(W.h).send({});
    expect(noMail.body.emailNote).toBe('no_address'); expect(noMail.body.emailedTo).toBeUndefined();
    await flushEmails();
    expect(sent.filter((m) => m.to !== 'desk.holder@dsk.test')).toHaveLength(0); // nothing went anywhere else
    // email not set up on the server: the admin is told that instead
    setMailTransport(null);
    const off = await api().post(A(`/staff/${o._id}/reset-password`)).set(W.h).send({});
    expect(off.body.emailNote).toBe('mail_off');
    expect(await EmailOutbox.countDocuments({ to: 'desk.holder@dsk.test' })).toBe(1);
    // a School Admin only
    expect((await api().post(A(`/staff/${o._id}/reset-password`)).set(W.teacher1.h).send({})).status).toBe(403);
  });
});
