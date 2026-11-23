import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';

describe('Class-wise session dates and viewing a past year', () => {
  let root; let W;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'cw'); });
  afterAll(teardown);

  it('a class can run on its own dates; a class not listed follows the school year', async () => {
    const y = W.year;
    const bad = await api().patch(`/api/school/years/${y._id}`).set(W.h).send({ classWindows: [{ classId: W.c9._id, startDate: '2026-03-01', endDate: '2026-02-01' }] });
    expect(bad.status).toBe(400);
    const dup = await api().patch(`/api/school/years/${y._id}`).set(W.h).send({ classWindows: [{ classId: W.c9._id, startDate: '2026-02-01', endDate: '2027-03-31' }, { classId: W.c9._id, startDate: '2026-02-01', endDate: '2027-03-31' }] });
    expect(dup.status).toBe(400);
    const unknown = await api().patch(`/api/school/years/${y._id}`).set(W.h).send({ classWindows: [{ classId: '64b000000000000000000000', startDate: '2026-02-01', endDate: '2027-03-31' }] });
    expect(unknown.status).toBe(404);
    const ok = await api().patch(`/api/school/years/${y._id}`).set(W.h).send({ classWindows: [{ classId: W.c9._id, startDate: '2026-02-01', endDate: '2027-01-31' }] });
    expect(ok.status).toBe(200);
    expect(ok.body.classWindows).toHaveLength(1);
    // billing: class 9 pays from February 2026 to January 2027 (12 months); class 8 still follows April to March
    const { billingMonths } = await import('../src/modules/finance/finance.service.js');
    const { classSpan } = await import('../src/services/yearSpan.js');
    const year = ok.body;
    expect(billingMonths(year, '2026-01-01', W.c9._id)[0]).toBe('2026-02');
    expect(billingMonths(year, '2026-01-01', W.c9._id).at(-1)).toBe('2027-01');
    expect(billingMonths(year, '2026-01-01', W.c8._id)[0]).toBe('2026-04');
    expect(billingMonths(year, '2026-01-01', W.c8._id).at(-1)).toBe('2027-03');
    expect(classSpan(year, W.c9._id).custom).toBe(true);
    expect(classSpan(year, W.c8._id).custom).toBe(false);
  });

  it('every admin screen accepts ?yearId= for a closed year and the data is still there', async () => {
    const y = W.year;
    const other = (await api().post('/api/school/years').set(W.h).send({ name: '2027-2028', startDate: '2027-04-01', endDate: '2028-03-31' })).body;
    await api().post(`/api/school/years/${other._id}/current`).set(W.h).send({});
    // a year closes only once every class has left it: while students are still active in it, closing is refused
    expect((await api().post(`/api/school/years/${y._id}/close`).set(W.h).send({})).status).toBe(409);
    const { StudentEnrolment: Enr } = await import('../src/models/index.js');
    await Enr.updateMany({ tenantId: W.id, yearId: y._id }, { status: 'promoted' }); // the year-end promotion has moved everyone on
    expect((await api().post(`/api/school/years/${y._id}/close`).set(W.h).send({})).status).toBe(200);
    for (const path of ['/api/school/students', '/api/school/sections', '/api/school/teaching-assignments', '/api/school/timetable/entries', '/api/school/finance/structures']) {
      const r = await api().get(`${path}${path.includes('?') ? '&' : '?'}yearId=${y._id}`).set(W.h);
      expect([200, 404], `${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`).toContain(r.status);
    }
    const students = await api().get(`/api/school/students?yearId=${y._id}`).set(W.h);
    expect(students.body.items.length).toBe(3);
    const secs = await api().get(`/api/school/sections?yearId=${y._id}`).set(W.h);
    expect(secs.body.length).toBeGreaterThan(0);
    // after the year-end promotion the old enrolments are closed ("promoted"); last year's classes must still list their students
    const { StudentEnrolment } = await import('../src/models/index.js');
    await StudentEnrolment.updateMany({ tenantId: W.id, yearId: y._id }, { status: 'promoted' });
    const past = (await api().get(`/api/school/students?yearId=${y._id}&sectionId=${W.sec8A._id}`).set(W.h)).body;
    expect(past.items).toHaveLength(3);
    expect(past.items[0].enrolment).toMatchObject({ className: 'Class 8', section: 'A' });
    const pastSecs = (await api().get(`/api/school/sections?yearId=${y._id}`).set(W.h)).body;
    expect(pastSecs.find((x) => x._id === W.sec8A._id).studentCount).toBe(3);
    expect((await api().get(`/api/school/students?sectionId=${W.sec8A._id}`).set(W.h)).body.items).toHaveLength(0); // the current year has not got them
    // a student sees the closed year's own timetable/results when it is asked for
    const mine = await api().get(`/api/student/profile?yearId=${y._id}`).set(W.studentLogins[0].h);
    expect(mine.status).toBe(200);
  });
});
