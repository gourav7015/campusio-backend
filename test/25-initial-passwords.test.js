import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { renderPasswordFormat, initialPassword } from '../src/services/initialPassword.js';

describe('starting-password format', () => {
  it('renders the bank-style default and the other tokens', () => {
    expect(renderPasswordFormat('{NAME4}{DDMMYYYY}', { name: 'Aarav Singh', dob: '2013-01-10' })).toBe('AARA10012013');
    expect(renderPasswordFormat('{NAME4}{DDMMYYYY}', { name: 'Om Rao', dob: '2013-01-10' })).toBe('OMRA10012013'); // short names use the letters they have
    expect(renderPasswordFormat('{NAME4}{DDMMYYYY}', { name: 'Ó  Ng', dob: '2013-01-10' })).toBe('OXNG10012013'.replace('OXNG', 'ONGX')); // accents and spaces dropped, padded
    expect(renderPasswordFormat('{name4}@{DDMM}', { name: 'Priya Das', dob: '2010-12-05' })).toBe('priy@0512');
    expect(renderPasswordFormat('{NAME3}{YY}{PHONE4}', { name: 'Kamla Devi', dob: '1990-02-03', phone: '+91 98765 43210' })).toBe('KAM903210');
  });
  it('gives nothing (so a random password is used) when the details are missing or the result is weak', () => {
    const s = { passwordFormat: '{NAME4}{DDMMYYYY}' };
    expect(initialPassword(s, { name: 'Aarav Singh' })).toBeNull(); // no date of birth
    expect(initialPassword(s, { name: '1234', dob: '2013-01-10' })).toBeNull(); // no letters in the name
    expect(initialPassword({ passwordFormat: '' }, { name: 'Aarav Singh', dob: '2013-01-10' })).toBeNull(); // the school chose random
    expect(initialPassword({ passwordFormat: '{YY}' }, { name: 'Aarav Singh', dob: '2013-01-10' })).toBeNull(); // too short and no letter
    expect(initialPassword(s, { name: 'Aarav Singh', dob: '2013-01-10' })).toBe('AARA10012013');
  });
});

describe('starting passwords through the app', () => {
  let root; let W;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'pw'); });
  afterAll(teardown);
  const signIn = (loginId, password, portal) => api().post('/api/auth/login').send({ loginId, password, portal });

  it('a new student gets name + date of birth, signs in with it, and must choose their own password', async () => {
    const a = await api().post('/api/school/students').set(W.h).send({ name: 'Riya Kapoor', dob: '2012-03-04', sectionId: W.sec8B._id, admissionDate: '2026-04-15', guardians: [{ email: 'guardian@fixture.test', name: 'Parent', relationship: 'Mother', phone: '9876500000', isPrimary: true }] });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.credentials.temporaryPassword).toBe('RIYA04032012');
    const r = await signIn(a.body.credentials.loginId, 'RIYA04032012', 'student');
    expect(r.status).toBe(200); expect(r.body.user.mustChangePassword).toBe(true);
  });

  it('a bulk import gives every row its own format password without anyone typing one', async () => {
    const rows = [
      { name: 'Aditi Rao', dob: '2013-05-06', className: 'Class 8', section: 'B', guardianName: 'Mr Rao', guardianPhone: '9876500001', guardianEmail: 'guardian@fixture.test', admissionDate: '2026-04-15' },
      { name: 'Vikram Nair', dob: '2013-07-08', className: 'Class 8', section: 'B', guardianName: 'Mr Nair', guardianPhone: '9876500002', guardianEmail: 'guardian@fixture.test', admissionDate: '2026-04-15' },
    ];
    const r = await api().post('/api/school/imports/students').set(W.h).send({ rows, dryRun: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.credentials.map((c) => c.temporaryPassword).sort()).toEqual(['ADIT06052013', 'VIKR08072013']);
  });

  it('teachers and staff get it too, a reset returns to it, and the school can switch to random or change the format', async () => {
    const t = await api().post('/api/school/teachers').set(W.h).send({ name: 'Meena Iyer', employeeId: 'T777', email: 'meena@pw.test', dob: '1985-09-30', subjects: ['Science'], phone: '9822200000' });
    expect(t.body.credentials.temporaryPassword).toBe('MEEN30091985');
    const reset1 = await api().post(`/api/school/teachers/${t.body.teacher._id}/reset-password`).set(W.h).send({});
    expect(reset1.body.temporaryPassword).toBe('MEEN30091985');
    // a format a school can choose
    expect((await api().put('/api/school/settings').set(W.h).send({ passwordFormat: '{name4}{YYYY}' })).status).toBe(200);
    expect((await api().put('/api/school/settings').set(W.h).send({ passwordFormat: 'hello' })).status).toBe(400); // no token
    expect((await api().put('/api/school/settings').set(W.h).send({ passwordFormat: '{NAME4}{bogus}' })).status).toBe(400);
    const t2 = await api().post('/api/school/teachers').set(W.h).send({ name: 'Arjun Mehta', employeeId: 'T778', email: 'arjun@pw.test', dob: '1980-01-02', subjects: ['Science'], phone: '9822200000' });
    expect(t2.body.credentials.temporaryPassword).toBe('arju1980');
    expect((await api().put('/api/school/settings').set(W.h).send({ passwordFormat: '' })).status).toBe(200);
    const t3 = await api().post('/api/school/teachers').set(W.h).send({ name: 'Sunita Pal', employeeId: 'T779', email: 'sunita@pw.test', dob: '1980-01-02', subjects: ['Science'], phone: '9822200000' });
    expect(t3.body.credentials.temporaryPassword).not.toMatch(/^SUNI/i);
  });

  it('office roles and school admins still get random passwords: their logins are made by the Admin and the Platform only', async () => {
    const f = await api().post('/api/school/staff').set(W.h).send({ name: 'Fiona Finance', email: 'fiona@pw.test', role: 'finance', phone: '9833333333', dob: '1984-04-04' });
    expect(f.status).toBe(201); expect(f.body.temporaryPassword).not.toMatch(/^FION/);
    // nobody but the School Admin can create a finance login, and nobody but the Platform a school admin
    expect((await api().post('/api/school/staff').set(W.teacher1.h).send({ name: 'X Y', email: 'x@pw.test', role: 'finance', phone: '9833333333', dob: '1984-04-04' })).status).toBe(403);
    expect((await api().post('/api/school/staff').set(W.h).send({ name: 'Admin Two', email: 'a2@pw.test', role: 'school_admin', phone: '9833333333', dob: '1984-04-04' })).status).toBe(400);
    expect((await api().post('/api/platform/schools').set(W.h).send({ name: 'Nope School', code: 'nope' })).status).toBe(403);
  });
});
