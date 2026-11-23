import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';

describe('Export centre: any list, narrowed by filters, with the columns the school ticks', () => {
  let root; let W;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'xp'); });
  afterAll(teardown);
  const get = (p, h = W.h) => api().get(`/api/school/export/${p}`).set(h);
  const rows = (text) => text.replace(/^\ufeff/, '').trim().split('\n');

  it('lists what can be exported, with the choices for the filters', async () => {
    const c = (await get('catalog')).body;
    expect(c.datasets.map((d) => d.key)).toEqual(expect.arrayContaining(['students', 'student_attendance', 'student_marks', 'student_fees', 'employees', 'employee_attendance', 'payroll']));
    expect(c.options.classes.length).toBeGreaterThan(0); expect(c.options.sections.length).toBeGreaterThan(0);
    expect(c.datasets.find((d) => d.key === 'students').columns.map((x) => x.key)).toContain('guardianPhone');
  });

  it('students can be narrowed to a class or section, and only the ticked columns come out', async () => {
    const all = await get('download?dataset=students'); expect(all.status).toBe(200); expect(all.headers['content-disposition']).toMatch(/students-\d{4}-\d{2}-\d{2}\.csv/);
    const one = await get(`download?dataset=students&sectionIds=${W.sec8B._id}&columns=admissionNo,name,class,section`);
    expect(rows(one.text)[0]).toBe('Admission No,Student,Class,Section');
    expect(rows(one.text).length).toBe(1 + (await get(`preview?dataset=students&sectionIds=${W.sec8B._id}`)).body.total);
    const inA = (await get(`preview?dataset=students&sectionIds=${W.sec8A._id}`)).body.total; const inB = (await get(`preview?dataset=students&sectionIds=${W.sec8B._id}`)).body.total;
    expect(inA + inB).toBe((await get(`preview?dataset=students&classIds=${W.c8._id}`)).body.total);
    expect((await get('download?dataset=students&columns=nope')).status).toBe(400); // at least one real column
  });

  it('attendance comes as a summary per student or day by day, for the dates chosen', async () => {
    const s = await get(`preview?dataset=student_attendance&classIds=${W.c8._id}`);
    expect(s.status).toBe(200); expect(s.body.columns).toEqual(expect.arrayContaining(['Present', 'Absent', 'Attendance %']));
    const d = await get(`preview?dataset=student_attendance&layout=daily&from=2026-04-01&to=2026-04-30`);
    expect(d.body.columns).toEqual(expect.arrayContaining(['Date', 'Status'])); expect(d.body.columns).not.toContain('Present');
  });

  it('results, fees, employees, employee attendance and payroll all have a file', async () => {
    for (const q of ['student_marks', 'student_marks&layout=subjects', 'student_fees&feeState=due', 'employees&category=teaching', 'employees&category=non_teaching&designation=Peon', 'employee_attendance&category=teaching', 'employee_attendance&layout=daily', 'payroll&fromMonth=2026-04&toMonth=2026-06&payStatus=paid']) {
      const r = await get(`download?dataset=${q}`); expect(r.status, q).toBe(200); expect(rows(r.text).length, q).toBeGreaterThanOrEqual(1);
    }
    const t = (await get('preview?dataset=employees&category=teaching')).body;
    expect(t.total).toBe(2); expect(t.rows.map((r) => r[1]).sort()).toEqual(['Mr Sharma', 'Mrs Gupta']);
  });

  it('is limited to what the account may see: teachers and sub-admins without the part get nothing', async () => {
    expect((await get('catalog', W.teacher1.h)).status).toBe(403);
    expect((await get('download?dataset=students', W.studentLogins?.[0]?.h || W.teacher1.h)).status).toBe(403);
    const c = (await api().post('/api/school/sub-admins').set(W.h).send({ name: 'Reports Only', permissions: ['reports', 'students'] })).body;
    const sub = await login(c.loginId, c.temporaryPassword, 'admin');
    const keys = (await get('catalog', sub.h)).body.datasets.map((d) => d.key);
    expect(keys).toContain('students'); expect(keys).not.toContain('payroll'); expect(keys).not.toContain('student_fees');
    expect((await get('download?dataset=payroll', sub.h)).status).toBe(400);
    expect((await get('download?dataset=students', sub.h)).status).toBe(200);
  });
});
