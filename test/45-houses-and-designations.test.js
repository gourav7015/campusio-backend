import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';

const A = (p) => `/api/school${p}`;

describe('Houses and ranks are the school\'s own', () => {
  let root; let W; let houses;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'hd'); });
  afterAll(teardown);

  it('there are no built-in houses; the school names its own', async () => {
    const r = (await api().get(A('/houses')).set(W.h)).body;
    expect(r.houses).toEqual([]); expect(r.unplaced.students).toBe(3);
    houses = [];
    for (const [name, color] of [['Aravali', '#1d4ed8'], ['Nilgiri', '#dc2626']]) {
      const c = await api().post(A('/houses')).set(W.h).send({ name, color, motto: 'Together' });
      expect(c.status).toBe(201); houses.push(c.body);
    }
    // each house has its own colour
    expect((await api().post(A('/houses')).set(W.h).send({ name: 'Vindhya', color: '#DC2626' })).status).toBe(409);
    expect((await api().patch(A(`/houses/${houses[0]._id}`)).set(W.h).send({ color: '#dc2626' })).status).toBe(409);
    expect((await api().patch(A(`/houses/${houses[0]._id}`)).set(W.h).send({ color: '#1d4ed8', motto: 'Together' })).status).toBe(200); // keeping its own is fine
    expect((await api().post(A('/houses')).set(W.h).send({ name: 'aravali' })).status).toBe(409); // the same name in other capitals
    expect((await api().post(A('/houses')).set(W.teacher1.h).send({ name: 'Himalaya' })).status).toBe(403);
  });

  it('a student or teacher can be only in a house the school has made', async () => {
    const sid = W.students[0].student._id;
    expect((await api().patch(A(`/students/${sid}`)).set(W.h).send({ house: 'Red' })).status).toBe(400);
    expect((await api().patch(A(`/students/${sid}`)).set(W.h).send({ house: 'nilgiri' })).body.house).toBe('Nilgiri'); // spelt as the school has it
    const tid = W.t1.teacher._id;
    expect((await api().patch(A(`/teachers/${tid}`)).set(W.h).send({ house: 'Green' })).status).toBe(400);
    expect((await api().put(A(`/houses/teachers/${tid}`)).set(W.h).send({ house: 'Aravali' })).body.house).toBe('Aravali');
    const mine = (await api().get('/api/teacher/house').set(W.teacher1.h)).body;
    expect(mine.house.name).toBe('Aravali'); expect(mine.teachers.map((t) => t.name)).toContain('Mr Sharma');
    expect((await api().get('/api/teacher/house').set(W.teacher2.h)).body.house).toBe(null);
  });

  it('everyone without a house can be placed evenly, and a renamed house follows its people', async () => {
    const d = await api().post(A('/houses/distribute')).set(W.h).send({});
    expect(d.body).toMatchObject({ students: 2, teachers: 1 }); // one student and one teacher were already placed
    const list = (await api().get(A('/houses')).set(W.h)).body;
    expect(list.houses.map((h) => h.students).sort()).toEqual([1, 2]); expect(list.unplaced).toEqual({ students: 0, teachers: 0 });
    const aravali = list.houses.find((h) => h.name === 'Aravali');
    expect((await api().patch(A(`/houses/${aravali._id}`)).set(W.h).send({ name: 'Aravalli' })).status).toBe(200);
    const roster = (await api().get(A(`/houses/${aravali._id}`)).set(W.h)).body;
    expect(roster.house.name).toBe('Aravalli'); expect(roster.teachers.length).toBeGreaterThan(0);
    // a house with people in it cannot be deleted
    expect((await api().delete(A(`/houses/${aravali._id}`)).set(W.h)).status).toBe(409);
  });

  it('a teacher\'s rank must be registered; the school can add its own', async () => {
    const list = (await api().get(A('/teacher-designations')).set(W.h)).body;
    expect(list.map((d) => d.name)).toEqual(expect.arrayContaining(['PGT', 'TGT', 'PRT', 'Head of Department']));
    const tid = W.t1.teacher._id;
    expect((await api().patch(A(`/teachers/${tid}`)).set(W.h).send({ designation: 'Super Duper Teacher' })).status).toBe(400);
    const ok = await api().patch(A(`/teachers/${tid}`)).set(W.h).send({ designation: 'pgt' });
    expect(ok.status).toBe(200); expect(ok.body.designation).toBe('PGT');
    expect((await api().post(A('/teacher-designations')).set(W.h).send({ name: 'Sports Coordinator' })).status).toBe(201);
    expect((await api().patch(A(`/teachers/${W.t2.teacher._id}`)).set(W.h).send({ designation: 'Sports Coordinator' })).status).toBe(200);
    // one that someone holds is archived, not deleted
    const pgt = (await api().get(A('/teacher-designations')).set(W.h)).body.find((d) => d.name === 'PGT');
    expect(pgt.staff).toBe(1);
    expect((await api().delete(A(`/teacher-designations/${pgt._id}`)).set(W.h)).status).toBe(409);
    // a non-teaching person cannot hold a teaching rank, and the staff list never offers it
    expect((await api().get(A('/designations')).set(W.h)).body.map((d) => d.name)).not.toContain('PGT');
    // the non-teaching list has the usual jobs, including the PT teacher
    expect((await api().get(A('/designations')).set(W.h)).body.map((d) => d.name)).toEqual(expect.arrayContaining(['PT Teacher', 'Accountant', 'Lab Assistant']));
  });
});
