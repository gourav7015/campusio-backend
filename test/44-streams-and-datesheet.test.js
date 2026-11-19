import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';

const A = (p) => `/api/school${p}`;
const TODAY = todayStr('Asia/Kolkata');
const sched = (n) => { let d = addDays(TODAY, n); while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, 1); return d; };
const days = (n) => { const out = []; let d = sched(10); while (out.length < n) { out.push(d); d = sched((new Date(`${d}T00:00:00Z`) - new Date(`${TODAY}T00:00:00Z`)) / 864e5 + 1); } return out; };

describe('Classes 11 and 12 have streams; each exam has a class-wise date sheet', () => {
  let root; let W; let med; let com; let c8;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'ds'); c8 = W.c8; });
  afterAll(teardown);

  it('the Class 11 and 12 streams are classes of their own, in the same order as the grades', async () => {
    for (const name of ['Class 11 Medical', 'Class 11 Non-Medical', 'Class 11 Commerce', 'Class 11 Arts', 'Class 12 Medical', 'Class 12 Arts']) {
      const r = await api().post(A('/classes')).set(W.h).send({ name });
      expect(r.status, name).toBe(201);
      expect(r.body.level).toBe(Number(name.split(' ')[1]));
    }
    // typed loosely it is still found; a made-up stream is refused
    expect((await api().post(A('/classes')).set(W.h).send({ name: 'class 12 non medical' })).body).toMatchObject({ name: 'Class 12 Non-Medical', stream: 'non_medical' });
    expect((await api().post(A('/classes')).set(W.h).send({ name: 'Class 11 Sports' })).status).toBe(400);
    const classes = (await api().get(A('/classes')).set(W.h)).body;
    med = classes.find((c) => c.name === 'Class 11 Medical'); com = classes.find((c) => c.name === 'Class 11 Commerce');
    expect(med.stream).toBe('medical');
  });

  it('the standard examinations are added once, for every class', async () => {
    const r = await api().post(A('/exams/standard')).set(W.h).send({});
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ created: 6 });
    expect((await api().post(A('/exams/standard')).set(W.h).send({})).body).toMatchObject({ created: 0, existing: 6 });
    const exams = (await api().get(A('/exams')).set(W.h)).body;
    expect(exams.map((e) => e.name)).toEqual(expect.arrayContaining(['Unit Test 1', 'Unit Test 2', 'Half-Yearly', 'Unit Test 3', 'Unit Test 4', 'Final Exam']));
    expect(exams.find((e) => e.name === 'Final Exam').type).toBe('annual');
    expect(exams.find((e) => e.name === 'Unit Test 1').classIds.length).toBeGreaterThanOrEqual(8);
  });

  it('each stream has its own subjects; the date sheet is filled class by class and saved together', async () => {
    const ut1 = (await api().get(A('/exams')).set(W.h)).body.find((e) => e.name === 'Unit Test 1');
    expect((await api().post(A(`/exams/${ut1._id}/datesheet/standard-subjects`)).set(W.h).send({ classId: med._id })).body.created).toBe(5);
    expect((await api().post(A(`/exams/${ut1._id}/datesheet/standard-subjects`)).set(W.h).send({ classId: com._id })).body.created).toBe(5);
    const m = (await api().get(A(`/exams/${ut1._id}/datesheet?classId=${med._id}`)).set(W.h)).body;
    const c = (await api().get(A(`/exams/${ut1._id}/datesheet?classId=${com._id}`)).set(W.h)).body;
    expect(m.subjects.map((s) => s.subject).sort()).toEqual(['Biology', 'Chemistry', 'English', 'Physical Education', 'Physics']);
    expect(c.subjects.map((s) => s.subject).sort()).toEqual(['Accountancy', 'Business Studies', 'Economics', 'English', 'Mathematics']);
    const d1 = sched(10); const d2 = sched(11);
    const rows = m.subjects.map((s, i) => ({ subjectId: s.subjectId, date: i % 2 ? d1 : d2, startTime: '09:00', endTime: '11:00', room: i === 0 ? '' : undefined }));
    // two papers at the same time on one day: refused, nothing saved
    const clash = await api().put(A(`/exams/${ut1._id}/datesheet`)).set(W.h).send({ classId: med._id, rows: [{ ...rows[1], date: d1 }, { ...rows[3], date: d1 }] });
    expect(clash.status).toBe(409);
    expect((await api().get(A(`/exams/${ut1._id}/datesheet?classId=${med._id}`)).set(W.h)).body.subjects.every((s) => !s.date)).toBe(true);
    const five = days(5); const spread = m.subjects.map((s, i) => ({ subjectId: s.subjectId, date: five[i], startTime: '09:00', endTime: '11:00' }));
    const ok = await api().put(A(`/exams/${ut1._id}/datesheet`)).set(W.h).send({ classId: med._id, rows: spread });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200); expect(ok.body.saved).toBe(5);
    const after = (await api().get(A(`/exams/${ut1._id}/datesheet?classId=${med._id}`)).set(W.h)).body.subjects;
    expect(after.map((s) => s.date)).toEqual([...after.map((s) => s.date)].sort());
    expect(after.every((s) => s.startTime === '09:00')).toBe(true);
    // swapping the times of two papers in one save works (the rows are checked against each other, not the old values)
    const swap = spread.map((r, i) => (i < 2 ? { ...r, date: spread[0].date, startTime: i ? '09:00' : '13:00', endTime: i ? '11:00' : '15:00' } : r));
    expect((await api().put(A(`/exams/${ut1._id}/datesheet`)).set(W.h).send({ classId: med._id, rows: swap })).status).toBe(200);
    // a date can be cleared
    const clear = spread.map((r, i) => (i === 4 ? { subjectId: r.subjectId, date: '' } : r));
    expect((await api().put(A(`/exams/${ut1._id}/datesheet`)).set(W.h).send({ classId: med._id, rows: clear })).body.cleared).toBe(1);
    // Commerce's sheet is separate and untouched
    expect((await api().get(A(`/exams/${ut1._id}/datesheet?classId=${com._id}`)).set(W.h)).body.subjects.every((s) => !s.date)).toBe(true);
    // the examination's own dates follow the sheets
    const e = (await api().get(A(`/exams/${ut1._id}`)).set(W.h)).body;
    expect(e.startDate).toBe(spread[0].date); expect(e.marksDeadline > e.endDate).toBe(true);
  });

  it('an extra subject can be added to one class; a sub-admin without the exams permission cannot touch the date sheet', async () => {
    const ut2 = (await api().get(A('/exams')).set(W.h)).body.find((e) => e.name === 'Unit Test 2');
    const add = await api().post(A(`/exams/${ut2._id}/datesheet/subjects`)).set(W.h).send({ classId: com._id, name: 'Informatics Practices' });
    expect(add.status).toBe(201);
    expect((await api().get(A(`/exams/${ut2._id}/datesheet?classId=${com._id}`)).set(W.h)).body.subjects.map((s) => s.subject)).toContain('Informatics Practices');
    expect((await api().get(A(`/exams/${ut2._id}/datesheet?classId=${com._id}`)).set(W.teacher1.h)).status).toBe(403);
  });
});
