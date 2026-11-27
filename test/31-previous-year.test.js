import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { addPreviousYear, previousClassName } from '../src/sample-previous-year.js';

describe('a student keeps the results of earlier academic years', () => {
  let W; let prev; let S;
  beforeAll(async () => {
    await setup(); await reset(); const root = await makeSuperAdmin(); W = await seedWorld(root, 'pyr');
    prev = await addPreviousYear({ tenantId: W.id, classNames: ['Class 8'] });
    S = W.studentLogins[0].h;
  });
  afterAll(teardown);

  it('the sample data gives the earlier class six standard examinations and a result for each student', async () => {
    expect(prev).toMatchObject({ year: '2025-2026', classes: ['Class 7 (was Class 8)'], exams: 6, students: 3, enrolments: 3 });
    expect(prev.reportCards).toBe(18);
    expect(await addPreviousYear({ tenantId: W.id, classNames: ['Class 8'] })).toMatchObject({ exams: 0, enrolments: 0, reportCards: 0 }); // re-running changes nothing
    expect(previousClassName('UKG')).toBe('LKG');
    expect(previousClassName('LKG')).toBeNull();
    expect(previousClassName('Class 12 Commerce')).toBe('Class 11 Commerce');
    expect(previousClassName('Class 11 Arts')).toBe('Class 10');
  });

  it('the student can list the years they were at the school, newest first, with the class they were in', async () => {
    const years = (await api().get('/api/student/years').set(S)).body;
    expect(years.map((y) => [y.name, y.className, y.status])).toEqual([['2026-2027', 'Class 8', 'active'], ['2025-2026', 'Class 7', 'promoted']]);
    expect(years[0].current).toBe(true);
    expect(years[1].current).toBe(false);
  });

  it('results, the class list and the class analysis of the earlier year are all readable', async () => {
    const y = (await api().get('/api/student/years').set(S)).body[1];
    const q = `?yearId=${y.id}`;
    const results = (await api().get(`/api/student/results${q}`).set(S)).body;
    expect(results.filter((r) => r.status === 'published')).toHaveLength(6);
    expect(results.map((r) => r.name)).toEqual(expect.arrayContaining(['Unit Test 1', 'Half-Yearly', 'Final Exam']));
    const mine = (await api().get(`/api/student/results${q}`).set(S)).body[0];
    const detail = (await api().get(`/api/student/results/${mine.examId}${q}`).set(S)).body;
    expect(detail.subjects.length).toBeGreaterThan(0);
    const cls = (await api().get(`/api/student/class-ranking${q}&scope=class`).set(S)).body;
    expect(cls).toMatchObject({ size: 3, tests: 6, lastExam: { name: 'Final Exam' } });
    // ranked by the latest examination, best first
    const lasts = cls.rows.map((r) => r.lastAverage);
    expect(lasts).toEqual([...lasts].sort((a, b) => b - a));
    expect(cls.rows.map((r) => r.rank)[0]).toBe(1);
    const a = (await api().get(`/api/student/class-analysis${q}`).set(S)).body;
    expect(a).toMatchObject({ ready: true, classSize: 3 });
    expect(a.tests).toHaveLength(6);
    // this year is untouched
    expect((await api().get('/api/student/results').set(S)).body.filter((r) => r.status === 'published').length).toBe(0);
  });
});
