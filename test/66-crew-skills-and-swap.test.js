import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';

describe('Transport crew: a person can hold both skills (driver and conductor), and crews can be swapped', () => {
  let root; let W; let tr; let id; let D1; let D2; let C1; let C2; let A; let B;
  const T = (p) => `/api/transport${p}`;
  const staff = (body) => api().post(T('/staff')).set(tr.h).send(body);
  const bus = (body) => api().post(T('/buses')).set(tr.h).send({ capacity: 40, ...body });
  const get = async (b) => (await api().get(T(`/buses/${b._id}`)).set(tr.h)).body;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'crw');
    const c = await api().post('/api/school/staff').set(W.h).send({ name: 'Tara Transport', email: 'tara@crw.test', role: 'transport', phone: '9833333333', dob: '1984-04-04' });
    tr = await login(c.body.loginId, c.body.temporaryPassword, 'transport');
    const des = (await api().get(T('/designations')).set(tr.h)).body; id = (n) => des.find((d) => d.name === n)._id;
    D1 = (await staff({ name: 'Dinesh Driver', designationId: id('Driver'), alsoBusRoles: ['conductor'], phone: '9876500001' })).body; // can also conduct
    D2 = (await staff({ name: 'Dilip Driver', designationId: id('Driver'), phone: '9876500002' })).body;
    C1 = (await staff({ name: 'Chetan Conductor', designationId: id('Conductor'), phone: '9876500003' })).body;
    C2 = (await staff({ name: 'Chirag Conductor', designationId: id('Conductor'), phone: '9876500004' })).body;
  });
  afterAll(teardown);

  it('a driver can also be marked as a conductor; the seats they can fill are listed, and only transport staff can have extra seats', async () => {
    expect(D1).toMatchObject({ busRole: 'driver', busRoles: ['driver', 'conductor'], alsoBusRoles: ['conductor'] });
    expect(D2.busRoles).toEqual(['driver']);
    const same = await staff({ name: 'Chandu Conductor', designationId: id('Conductor'), alsoBusRoles: ['conductor', 'driver'] }); // the seat the title already carries is not repeated
    expect(same.body).toMatchObject({ busRoles: ['conductor', 'driver'], alsoBusRoles: ['driver'] });
    const general = (await api().get('/api/school/designations').set(W.h)).body.find((d) => d.group === 'general');
    expect((await api().post('/api/school/support-staff').set(W.h).send({ name: 'Peon Pappu', designationId: general._id, alsoBusRoles: ['driver'] })).status).toBe(400);
    expect((await api().get(T('/staff')).set(tr.h)).body.items.find((s) => s.name === 'Dinesh Driver').busRoles).toEqual(['driver', 'conductor']);
  });

  it('crew rules: the right skill for the seat, nobody on two buses, nobody in both seats of one bus', async () => {
    A = (await bus({ busNo: 'GJ-1', driverId: D1._id, conductorId: C2._id })).body;
    B = (await bus({ busNo: 'GJ-2', driverId: D2._id, conductorId: C1._id })).body;
    expect(A.driverId).toBe(D1._id);
    expect((await bus({ busNo: 'GJ-3', driverId: C1._id })).status).toBe(400); // a conductor without the skill cannot drive
    expect((await bus({ busNo: 'GJ-3', driverId: D1._id })).status).toBe(409); // already on GJ-1
    expect((await bus({ busNo: 'GJ-3', conductorId: D1._id })).status).toBe(409); // not even in the other seat
    expect((await bus({ busNo: 'GJ-3', driverId: D2._id, conductorId: D2._id })).status).toBe(400); // one person, two seats
    const spare = await bus({ busNo: 'GJ-4', conductorId: (await staff({ name: 'Dev Driver', designationId: id('Driver'), alsoBusRoles: ['conductor'] })).body._id });
    expect(spare.status).toBe(201); // a driver with the conductor skill can sit in the conductor's seat
  });

  it('swap: previewed first, then applied; the same crews cannot be swapped for nothing', async () => {
    const pre = await api().post(T('/buses/swap')).set(tr.h).send({ busId: A._id, otherBusId: B._id, what: 'driver', preview: true });
    expect(pre.status).toBe(200);
    expect(pre.body.changes).toEqual(expect.arrayContaining([expect.objectContaining({ busNo: 'GJ-1', seat: 'driver', from: 'Dinesh Driver', to: 'Dilip Driver' }), expect.objectContaining({ busNo: 'GJ-2', seat: 'driver', from: 'Dilip Driver', to: 'Dinesh Driver' })]));
    expect((await get(A)).driverId).toBe(D1._id); // a preview saves nothing
    expect((await api().post(T('/buses/swap')).set(tr.h).send({ busId: A._id, otherBusId: B._id, what: 'driver' })).status).toBe(200);
    expect(await get(A)).toMatchObject({ driverId: D2._id, conductorId: C2._id });
    expect(await get(B)).toMatchObject({ driverId: D1._id, conductorId: C1._id });
    expect((await api().post(T('/buses/swap')).set(tr.h).send({ busId: A._id, otherBusId: B._id, what: 'both' })).status).toBe(200); // both seats at once
    expect(await get(A)).toMatchObject({ driverId: D1._id, conductorId: C1._id });
    expect((await api().post(T('/buses/swap')).set(tr.h).send({ busId: A._id, otherBusId: A._id, what: 'driver' })).status).toBe(400);
    expect((await api().post(T('/buses/swap')).set(tr.h).send({ busId: A._id, what: 'driver' })).status).toBe(400); // the other bus is missing
  });

  it('swap driver and conductor of one bus only when both can fill the other seat; a skill that is in use cannot be removed', async () => {
    // GJ-1 now has Dinesh (driver, can conduct) and Chetan (conductor only): Chetan cannot drive
    const no = await api().post(T('/buses/swap')).set(tr.h).send({ busId: A._id, what: 'roles' });
    expect(no.status).toBe(400); expect(no.body.error).toMatch(/Chetan Conductor cannot be the driver/);
    expect((await api().patch(T(`/staff/${C1._id}`)).set(tr.h).send({ alsoBusRoles: ['driver'] })).body.busRoles).toEqual(['conductor', 'driver']);
    expect((await api().post(T('/buses/swap')).set(tr.h).send({ busId: A._id, what: 'roles' })).status).toBe(200);
    expect(await get(A)).toMatchObject({ driverId: C1._id, conductorId: D1._id });
    // Dinesh now conducts GJ-1: removing his "can also conduct" skill would leave the seat unfillable
    expect((await api().patch(T(`/staff/${D1._id}`)).set(tr.h).send({ alsoBusRoles: [] })).status).toBe(409);
    expect((await api().patch(T(`/staff/${D2._id}`)).set(tr.h).send({ alsoBusRoles: ['conductor'] })).status).toBe(200); // adding is always fine
  });

  it('only the Transport officer swaps crews', async () => {
    const body = { busId: A._id, otherBusId: B._id, what: 'driver' };
    expect((await api().post(T('/buses/swap')).set(W.teacher1.h).send(body)).status).toBe(403);
    expect((await api().post('/api/school/transport/buses/swap').set(W.h).send(body)).status).toBeGreaterThanOrEqual(403);
  });
});
