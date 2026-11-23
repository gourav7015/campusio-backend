import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';

describe('structure, admissions, transfers and history', () => {
  let root; let W;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'sch'); });
  afterAll(teardown);
  const guardian = [{ email: 'guardian@fixture.test', name: 'Parent Name', relationship: 'Father', phone: '9876543210' }];

  it('keeps exactly one current academic year', async () => {
    const y2 = await api().post('/api/school/years').set(W.h).send({ name: '2027-2028', startDate: '2027-04-01', endDate: '2028-03-31' });
    expect(y2.body.isCurrent).toBe(false);
    await api().post(`/api/school/years/${y2.body._id}/set-current`).set(W.h);
    const list = (await api().get('/api/school/years').set(W.h)).body;
    expect(list.filter((y) => y.isCurrent)).toHaveLength(1);
    await api().post(`/api/school/years/${W.year._id}/set-current`).set(W.h);
    expect((await api().post('/api/school/years').set(W.h).send({ name: 'bad', startDate: '2027-05-01', endDate: '2027-01-01' })).status).toBe(400);
  });

  it('enforces section capacity, duplicate admission numbers and required guardian', async () => {
    // 8-A has capacity 3 and 3 students already
    const full = await api().post('/api/school/students').set(W.h).send({ name: 'Extra Kid', dob: '2013-05-05', sectionId: W.sec8A._id, guardians: guardian });
    expect(full.status).toBe(409);
    expect(full.body.error).toMatch(/full/i);
    const noGuardian = await api().post('/api/school/students').set(W.h).send({ name: 'No Guardian', dob: '2013-05-05', sectionId: W.sec8B._id, guardians: [] });
    expect(noGuardian.status).toBe(400);
    const ok = await api().post('/api/school/students').set(W.h).send({ name: 'Dev Patel', dob: '2013-05-05', sectionId: W.sec8B._id, admissionNo: 'MANUAL-1', guardians: guardian });
    expect(ok.status).toBe(201);
    const dupNo = await api().post('/api/school/students').set(W.h).send({ name: 'Another One', dob: '2013-06-06', sectionId: W.sec8B._id, admissionNo: 'MANUAL-1', guardians: guardian });
    expect(dupNo.status).toBe(409);
    const dupIdentity = await api().post('/api/school/students').set(W.h).send({ name: 'dev patel', dob: '2013-05-05', sectionId: W.sec8B._id, guardians: guardian });
    expect(dupIdentity.status).toBe(409);
    expect(dupIdentity.body.details.code).toBe('DUPLICATE_IDENTITY');
    const confirmed = await api().post('/api/school/students').set(W.h).send({ name: 'dev patel', dob: '2013-05-05', sectionId: W.sec8B._id, guardians: guardian, confirmDuplicate: true });
    expect(confirmed.status).toBe(201);
  });

  it('generates sequential unique roll numbers and reuses none inside a section', async () => {
    const list = (await api().get(`/api/school/students?sectionId=${W.sec8A._id}`).set(W.h)).body.items;
    expect(list.map((s) => s.enrolment.rollNo).sort()).toEqual([1, 2, 3]);
  });

  it('transfers a student to a new section preserving history and old attendance', async () => {
    const aarav = W.students[0].student._id;
    // attendance in the old section first
    const T = W.teacher1.h;
    const reg = (await api().get(`/api/teacher/attendance/register?sectionId=${W.sec8A._id}&date=2026-11-10`).set(T)).body;
    const entries = reg.students.map((s) => ({ studentId: s.studentId, status: 'present' }));
    const sub = await api().post('/api/teacher/attendance/register/submit').set(T).send({ sectionId: W.sec8A._id, date: '2026-11-10', entries });
    if (sub.status !== 200) console.log(JSON.stringify(sub.body));
    expect(sub.status).toBe(200);

    const bad = await api().post(`/api/school/students/${aarav}/transfer`).set(W.h).send({ toSectionId: W.sec8A._id, reason: 'same section' });
    expect(bad.status).toBe(400);
    const tr = await api().post(`/api/school/students/${aarav}/transfer`).set(W.h).send({ toSectionId: W.sec8B._id, reason: 'Parent request', effectiveDate: '2026-11-11' });
    expect(tr.status).toBe(200);
    const detail = (await api().get(`/api/school/students/${aarav}`).set(W.h)).body;
    expect(detail.enrolments.filter((e) => e.status === 'active')).toHaveLength(1);
    expect(detail.enrolments.find((e) => e.status === 'section_changed').section).toBe('A');
    expect(detail.transfers[0]).toMatchObject({ reason: 'Parent request', fromSection: 'A', toSection: 'B' });
    // old register on the old date still contains him; new date doesn't
    const old = (await api().get(`/api/teacher/attendance/register?sectionId=${W.sec8A._id}&date=2026-11-10`).set(T)).body;
    expect(old.students.map((s) => s.name)).toContain('Aarav Singh');
    const after = (await api().get(`/api/teacher/attendance/register?sectionId=${W.sec8A._id}&date=2026-11-12`).set(T)).body;
    expect(after.students.map((s) => s.name)).not.toContain('Aarav Singh');
    // the student's own attendance still counts the old record
    const att = (await api().get('/api/student/attendance/summary').set(W.studentLogins[0].h)).body;
    expect(att.present).toBe(1);
    // and he is now on the 8-B timetable/section for the student portal
    const dash = (await api().get('/api/student/dashboard').set(W.studentLogins[0].h)).body;
    expect(dash.welcome.section).toBe('B');
  });

  it('only LKG, UKG and Class 1-12 can exist; the level always follows the name', async () => {
    const C = '/api/school/classes';
    for (const name of ['Class 13', 'Class 0', 'class 130', 'Nursery', 'Class 8A', '13', '']) expect((await api().post(C).set(W.h).send({ name })).status).toBe(400);
    expect((await api().post(C).set(W.h).send({ name: 'Class 8' })).status).toBe(409); // already there
    const lkg = await api().post(C).set(W.h).send({ name: 'lkg', level: 99 }); // case-insensitive; a client-supplied level is ignored
    expect(lkg.status).toBe(201); expect(lkg.body).toMatchObject({ name: 'LKG', level: -2 });
    const c12 = await api().post(C).set(W.h).send({ name: '12' });
    expect(c12.body).toMatchObject({ name: 'Class 12', level: 12 });
    expect((await api().patch(`${C}/${c12.body._id}`).set(W.h).send({ name: 'Class 13' })).status).toBe(400); // cannot be renamed to an invalid class
    expect((await api().patch(`${C}/${c12.body._id}`).set(W.h).send({ status: 'archived' })).body.status).toBe('archived');
    const names = (await api().get(C).set(W.h)).body.map((c) => c.name);
    expect(names.slice(0, 2)).toEqual(['LKG', 'Class 8']); // ordered by level
  });

  it('"create next year" carries the set-up over: sections, subjects and teachers; students stay put until promotion', async () => {
    const body = { fromYearId: W.year._id, name: '2028-2029', startDate: '2028-04-01', endDate: '2029-03-31', copyTeachers: true };
    expect((await api().post('/api/school/years/rollover').set(W.teacher1.h).send(body)).status).toBe(403);
    expect((await api().post('/api/school/years/rollover').set(W.h).send({ ...body, startDate: '2026-01-01' })).status).toBe(400); // must follow the source year
    expect((await api().post('/api/school/years/rollover').set(W.h).send({ ...body, endDate: '2028-01-01' })).status).toBe(400);
    const r = await api().post('/api/school/years/rollover').set(W.h).send(body);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ sections: 2, offerings: 2, subjectTeachers: 2, classTeachers: 1, year: { name: '2028-2029', status: 'upcoming', isCurrent: false } });
    expect((await api().post('/api/school/years/rollover').set(W.h).send(body)).status).toBe(409); // already exists
    const secs = (await api().get(`/api/school/sections?yearId=${r.body.year._id}`).set(W.h)).body;
    expect(secs.map((s) => s.name).sort()).toEqual(['A', 'B']);
    expect(secs.every((s) => s.studentCount === 0)).toBe(true);
    const asg = (await api().get(`/api/school/teaching-assignments?yearId=${r.body.year._id}&open=true`).set(W.h)).body;
    expect(asg.map((a) => `${a.teacherId.name}:${a.subjectId.name}`).sort()).toEqual(['Mr Sharma:Mathematics', 'Mrs Gupta:English']);
    expect((await api().get('/api/school/years').set(W.h)).body.find((y) => y.isCurrent).name).toBe('2026-2027'); // the current year is untouched
    // and the promotion page can now target it
    const prev = await api().post('/api/school/promotions/preview').set(W.h).send({ fromYearId: W.year._id, toYearId: r.body.year._id });
    expect(prev.status).toBe(200);
  });

  it('refuses unsafe deletes and supports withdraw / archive rules', async () => {
    expect((await api().delete(`/api/school/classes/${W.c8._id}`).set(W.h)).status).toBe(409);
    expect((await api().delete(`/api/school/sections/${W.sec8A._id}`).set(W.h)).status).toBe(409);
    // the school's subject list: a subject classes and teachers use cannot be deleted; a new one can be added
    expect((await api().delete(`/api/school/subjects/${W.maths._id}`).set(W.h)).status).toBe(409);
    expect((await api().post('/api/school/subjects').set(W.h).send({ name: 'Mathematics' })).status).toBe(409); // already a subject (any capitals)
    // reduce capacity below enrolled count
    expect((await api().patch(`/api/school/sections/${W.sec8A._id}`).set(W.h).send({ capacity: 1 })).status).toBe(409);
    // student with attendance cannot be archived, can be withdrawn
    const bhavna = W.students[1].student._id;
    const reg = await api().delete(`/api/school/students/${bhavna}`).set(W.h);
    expect(reg.status).toBe(409);
    const w = await api().post(`/api/school/students/${bhavna}/withdraw`).set(W.h).send({ reason: 'Moved city', outcome: 'transferred_out' });
    expect(w.status).toBe(200);
    expect(w.body.status).toBe('transferred_out');
    expect((await api().get('/api/auth/me').set(W.studentLogins[1].h)).status).toBe(401); // login disabled, session killed
    // a brand-new student with no history can be archived
    const fresh = (await api().post('/api/school/students').set(W.h).send({ name: 'Mistake Entry', dob: '2013-09-09', sectionId: W.sec8B._id, guardians: guardian })).body;
    expect((await api().delete(`/api/school/students/${fresh.student._id}`).set(W.h)).body.status).toBe('archived');
  });

  it('teacher lifecycle: assignment rules, deactivation keeps history, class teacher unique', async () => {
    const dupAssign = await api().post('/api/school/teaching-assignments').set(W.h).send({ teacherId: W.t2.teacher._id, sectionId: W.sec8A._id, subjectId: W.maths._id });
    expect(dupAssign.status).toBe(409);
    // assigning a subject nobody has used yet creates the subject and its class offering on the spot
    const art = await api().post('/api/school/teaching-assignments').set(W.h).send({ teacherId: W.t2.teacher._id, sectionId: W.sec8B._id, subject: '  art  &  craft ', weeklyPeriods: 3 });
    expect(art.status).toBe(201);
    const subs = (await api().get('/api/school/subjects').set(W.h)).body;
    expect(subs.filter((x) => /art/i.test(x.name))).toHaveLength(1);
    expect((await api().get(`/api/school/teaching-assignments?sectionId=${W.sec8B._id}`).set(W.h)).body[0].offeringId.weeklyPeriods).toBe(3);
    // the same name (any case) is the same subject
    const again = await api().post('/api/school/teaching-assignments').set(W.h).send({ teacherId: W.t1.teacher._id, sectionId: W.sec8B._id, subject: 'MATHEMATICS' });
    expect(again.status).toBe(201);
    expect((await api().get('/api/school/subjects').set(W.h)).body.filter((x) => /^math/i.test(x.name))).toHaveLength(1);
    expect((await api().post('/api/school/teaching-assignments').set(W.h).send({ teacherId: W.t1.teacher._id, sectionId: W.sec8B._id })).status).toBe(400);
    const dupEmp = await api().post('/api/school/teachers').set(W.h).send({ name: 'Copy Teacher', employeeId: 'T001', phone: '9822200000', dob: '1984-04-04', email: 'teacher@fixture.test' });
    expect(dupEmp.status).toBe(409);
    // Mrs Gupta replaces Mr Sharma as class teacher: only one open
    await api().put(`/api/school/sections/${W.sec8A._id}/class-teacher`).set(W.h).send({ teacherId: W.t2.teacher._id });
    const cts = (await api().get('/api/school/class-teachers').set(W.h)).body;
    expect(cts.filter((c) => String(c.sectionId._id) === String(W.sec8A._id) && c.open)).toHaveLength(1);
    // deactivate Mrs Gupta: disabled, assignments ended, row retained
    const d = await api().post(`/api/school/teachers/${W.t2.teacher._id}/deactivate`).set(W.h);
    expect(d.status).toBe(200);
    expect((await api().get('/api/auth/me').set(W.teacher2.h)).status).toBe(401);
    const t = (await api().get(`/api/school/teachers/${W.t2.teacher._id}`).set(W.h)).body;
    expect(t.status).toBe('inactive');
    expect(t.assignments.every((a) => a.open === false)).toBe(true);
  });

  it('password reset gives a one-time temporary password and forces a change', async () => {
    const out = await api().post(`/api/school/students/${W.students[2].student._id}/reset-password`).set(W.h);
    expect(out.status).toBe(200);
    const l = await api().post('/api/auth/login').send({ loginId: out.body.loginId, password: out.body.temporaryPassword, portal: 'student' });
    expect(l.body.user.mustChangePassword).toBe(true);
  });
});
