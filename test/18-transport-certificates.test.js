import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');

describe('Transport dashboard lists every certificate, not only the problems', () => {
  let root; let W; let tr;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'cert');
    const c = await api().post('/api/school/staff').set(W.h).send({ name: 'Tara Transport', email: 'tara@cert.test', role: 'transport' });
    tr = await login(c.body.loginId, c.body.temporaryPassword, 'transport');
  });
  afterAll(teardown);
  const T = (p) => `/api/transport${p}`;

  it('shows valid, expiring, expired and missing dates; the alerts list is unchanged', async () => {
    const des = (await api().get(T('/designations')).set(tr.h)).body;
    const driver = (await api().post(T('/staff')).set(tr.h).send({ name: 'Ramesh', designationId: des.find((d) => d.name === 'Driver')._id, licenseNo: 'GJ01', licenseExpiry: addDays(TODAY, 90), joiningDate: '2020-06-01' })).body;
    const mk = (over) => api().post(T('/buses')).set(tr.h).send({ capacity: 40, status: 'active', ...over });
    expect((await mk({ busNo: 'B1', insuranceExpiry: addDays(TODAY, 200), fitnessExpiry: addDays(TODAY, 10), pollutionExpiry: addDays(TODAY, -3), driverId: driver._id })).status).toBe(201);
    expect((await mk({ busNo: 'B2' })).status).toBe(201); // no dates at all
    expect((await mk({ busNo: 'B3', status: 'retired', insuranceExpiry: addDays(TODAY, -40) })).status).toBe(201); // retired: not listed
    const d = (await api().get(T('/dashboard')).set(tr.h)).body;
    const b1 = d.certificates.filter((c) => c.bus === 'B1');
    expect(b1).toHaveLength(5); // insurance, fitness, pollution, registration (not recorded yet), driver licence
    expect(Object.fromEntries(b1.map((c) => [c.doc, c.state]))).toEqual({ insurance: 'valid', fitness: 'expiring', pollution: 'expired', registration: 'missing', licence: 'valid' });
    expect(b1.find((c) => c.doc === 'pollution').daysLeft).toBe(-3);
    expect(b1.find((c) => c.doc === 'licence').label).toContain('Ramesh');
    const b2 = d.certificates.filter((c) => c.bus === 'B2');
    expect(b2).toHaveLength(4); // four "not on file" rows (insurance, fitness, pollution, registration), no licence row without a driver
    expect(b2.every((c) => c.state === 'missing' && c.date === null)).toBe(true);
    expect(d.certificates.some((c) => c.bus === 'B3')).toBe(false);
    // expired first, then expiring, then missing, then valid
    const order = d.certificates.map((c) => c.state);
    expect(order.indexOf('expired')).toBeLessThan(order.indexOf('expiring'));
    expect(order.indexOf('expiring')).toBeLessThan(order.indexOf('missing'));
    expect(order.indexOf('missing')).toBeLessThan(order.indexOf('valid'));
    // alerts keep their old meaning: only expired or due within 30 days
    expect(d.alerts.map((a) => `${a.bus}:${a.field}`).sort()).toEqual(['B1:fitness', 'B1:pollution', 'B3:insurance']);
    // the Admin's view-only copy sees the same
    expect((await api().get('/api/school/transport/dashboard').set(W.h)).body.certificates).toHaveLength(d.certificates.length);
  });
});
