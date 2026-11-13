import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, makeSchool, login } from './helpers.js';

describe('smoke: onboarding chain', () => {
  let root;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); });
  afterAll(teardown);

  it('super admin creates a school + admin; admin sets up structure', async () => {
    const s = await makeSchool(root, 'dps');
    const year = await api().post('/api/school/years').set(s.h).send({ name: '2026-2027', startDate: '2026-04-01', endDate: '2027-03-31' });
    expect(year.status).toBe(201);
    expect(year.body.isCurrent).toBe(true);
    const cls = await api().post('/api/school/classes').set(s.h).send({ name: 'Class 8', level: 8 });
    const sec = await api().post('/api/school/sections').set(s.h).send({ yearId: year.body._id, classId: cls.body._id, name: 'A', capacity: 2 });
    expect(sec.status).toBe(201);
    const st = await api().post('/api/school/students').set(s.h).send({
      name: 'Rahul Sharma', dob: '2013-05-01', sectionId: sec.body._id, guardians: [{ name: 'Mr Sharma', relationship: 'Father', phone: '9876543210' }],
    });
    expect(st.status).toBe(201);
    expect(st.body.student.admissionNo).toMatch(/^ADM2026/);
    const stLogin = await login(st.body.credentials.loginId, st.body.credentials.temporaryPassword);
    expect(stLogin.user.role).toBe('student');
  });
});
