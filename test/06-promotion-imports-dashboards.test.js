import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';

describe('promotion, bulk import, dashboards, profile and sessions', () => {
  let root; let W; let y2; let s8A2; let s9A2;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'prm'); });
  afterAll(teardown);

  describe('year-end promotion', () => {
    it('previews without writing, then commits with overrides while keeping history', async () => {
      y2 = (await W.post(W.h, '/api/school/years', { name: '2027-2028', startDate: '2027-04-01', endDate: '2028-03-31' })).body;
      s8A2 = (await W.post(W.h, '/api/school/sections', { yearId: y2._id, classId: W.c8._id, name: 'A', capacity: 30 })).body;
      s9A2 = (await W.post(W.h, '/api/school/sections', { yearId: y2._id, classId: W.c9._id, name: 'A', capacity: 2 })).body;
      await W.post(W.h, '/api/school/sections', { yearId: y2._id, classId: W.c9._id, name: 'B', capacity: 30 });
      const pv = (await api().post('/api/school/promotions/preview').set(W.h).send({ fromYearId: W.year._id, toYearId: y2._id })).body;
      expect(pv.summary).toMatchObject({ total: 3, promote: 3 });
      expect(pv.items[0]).toMatchObject({ fromClass: 'Class 8', toClass: 'Class 9' });
      // capacity aware: 9-A holds 2, the third spills to 9-B
      expect(pv.items.map((i) => i.toSection).sort()).toEqual(['A', 'A', 'B']);
      expect((await api().post('/api/school/promotions/preview').set(W.h).send({ fromYearId: y2._id, toYearId: W.year._id })).status).toBe(400);
      // nothing written yet
      expect((await api().get(`/api/school/students?yearId=${y2._id}&sectionId=${s9A2._id}`).set(W.h)).body.total).toBe(0);

      const items = pv.items.map((i) => ({ enrolmentId: i.enrolmentId, action: i.action, toSectionId: i.toSectionId }));
      expect((await api().post('/api/school/promotions/commit').set(W.h).send({ fromYearId: W.year._id, toYearId: y2._id, items, confirm: false })).status).toBe(400);
      // retain one student in Class 8, drop another from the school
      items[0] = { enrolmentId: items[0].enrolmentId, action: 'retain', toSectionId: s8A2._id };
      items[1] = { enrolmentId: items[1].enrolmentId, action: 'withdraw' };
      const out = await api().post('/api/school/promotions/commit').set(W.h).send({ fromYearId: W.year._id, toYearId: y2._id, items, confirm: true, makeCurrent: true, closeFromYear: true });
      expect(out.body).toMatchObject({ promoted: 1, retained: 1, withdrawn: 1 });
      const retained = pv.items[0].studentId; const promoted = pv.items[2].studentId;
      const rd = (await api().get(`/api/school/students/${retained}`).set(W.h)).body;
      expect(rd.enrolments.map((e) => `${e.year}:${e.className}:${e.status}`).sort()).toEqual(['2026-2027:Class 8:retained', '2027-2028:Class 8:active']);
      const pd = (await api().get(`/api/school/students/${promoted}`).set(W.h)).body;
      expect(pd.enrolments.map((e) => `${e.year}:${e.className}:${e.status}`).sort()).toEqual(['2026-2027:Class 8:promoted', '2027-2028:Class 9:active']);
      expect(pd.enrolments.find((e) => e.status === 'active').rollNo).toBe(1);
      const years = (await api().get('/api/school/years').set(W.h)).body;
      expect(years.find((y) => y.name === '2026-2027')).toMatchObject({ status: 'closed', isCurrent: false });
      // second run is refused because those enrolments are already processed
      expect((await api().post('/api/school/promotions/commit').set(W.h).send({ fromYearId: W.year._id, toYearId: y2._id, items, confirm: true })).status).toBe(409);
    });

    it('old-year data stays readable and the portals follow the new current year', async () => {
      const old = (await api().get(`/api/school/students?yearId=${W.year._id}`).set(W.h)).body;
      expect(old.year.name).toBe('2026-2027');
      const dash = (await api().get('/api/student/dashboard').set(W.studentLogins[2].h)).body;
      expect(['Class 8', 'Class 9']).toContain(dash.welcome.className);
      expect(dash.welcome.academicYear).toBe('2027-2028');
      const hist = (await api().get(`/api/student/attendance/summary?yearId=${W.year._id}`).set(W.studentLogins[2].h)).body;
      expect(hist.yearName).toBe('2026-2027');
      // teachers still have last year's assignments, but none in the new year until reassigned
      const t = (await api().get('/api/teacher/classes').set(W.teacher1.h)).body;
      expect(t).toHaveLength(0);
      const tOld = (await api().get(`/api/teacher/classes?yearId=${W.year._id}`).set(W.teacher1.h)).body;
      expect(tOld).toHaveLength(1);
      const copy = (await api().post('/api/school/offerings/copy').set(W.h).send({ fromYearId: W.year._id, toYearId: y2._id })).body;
      expect(copy.created).toBe(2);
      expect((await api().post('/api/school/offerings/copy').set(W.h).send({ fromYearId: W.year._id, toYearId: y2._id })).body.created).toBe(0);
    });
  });

  describe('bulk import (data dumping)', () => {
    it('dry-runs with a per-row report, commits only valid rows, returns credentials and can be rolled back', async () => {
      const rows = [
        { name: 'Imported One', dob: '2012-03-04', className: 'Class 8', section: 'A', guardianName: 'Mr One', guardianPhone: '9876543210', admissionNo: 'IMP-1' },
        { name: 'Imported Two', dob: '2012-03-05', className: 'Class 8', section: 'A', guardianName: 'Mr Two', guardianPhone: '9876543211', admissionNo: 'IMP-2' },
        { name: 'Bad Class', dob: '2012-03-06', className: 'Class 99', section: 'Z', guardianName: 'Mr Bad', guardianPhone: '9876543212' },
        { name: 'Dup Admission', dob: '2012-03-07', className: 'Class 8', section: 'A', guardianName: 'Mr Dup', guardianPhone: '9876543213', admissionNo: 'IMP-1' },
        { name: 'No Dob', dob: 'not-a-date', className: 'Class 8', section: 'A', guardianName: 'Mr X', guardianPhone: '9876543214' },
      ];
      const dry = (await api().post('/api/school/imports/students').set(W.h).send({ rows, dryRun: true })).body;
      expect(dry).toMatchObject({ dryRun: true, total: 5, valid: 2, invalid: 3 });
      expect(dry.report.find((r) => r.row === 3).errors[0]).toMatch(/not found/);
      expect(dry.report.find((r) => r.row === 4).errors.join()).toMatch(/Duplicate admission/);
      // nothing written by a dry run
      expect((await api().get('/api/school/students?q=Imported').set(W.h)).body.total).toBe(0);
      // commit without skipInvalid is refused as a whole
      expect((await api().post('/api/school/imports/students').set(W.h).send({ rows, dryRun: false })).body.committed).toBe(false);
      const done = (await api().post('/api/school/imports/students').set(W.h).send({ rows, dryRun: false, skipInvalid: true })).body;
      expect(done).toMatchObject({ committed: true, created: 2, skipped: 3 });
      expect(done.credentials).toHaveLength(2);
      const l = await login(done.credentials[0].loginId, done.credentials[0].temporaryPassword);
      expect(l.user.role).toBe('student');
      // re-importing the same rows now flags them as duplicates
      expect((await api().post('/api/school/imports/students').set(W.h).send({ rows: rows.slice(0, 2), dryRun: true })).body.invalid).toBe(2);
      // roll back: students without history are removed with their logins
      const rb = (await api().post(`/api/school/imports/${done.batchId}/rollback`).set(W.h)).body;
      expect(rb.removed).toBe(2);
      expect((await api().post('/api/auth/login').send({ loginId: done.credentials[0].loginId, password: done.credentials[0].temporaryPassword, portal: 'student' })).status).toBe(401);
      expect((await api().post(`/api/school/imports/${done.batchId}/rollback`).set(W.h)).status).toBe(409);
    });

    it('imports teachers with subject names (subjects are created on the way) and rejects bad rows; Super Admin can dump into any school', async () => {
      const rows = [
        { name: 'Imp Teacher', employeeId: 'T900', email: 'imp@prm.test', subjects: 'Mathematics; Physics' },
        { name: 'Bad Email', employeeId: 'T901', email: 'not-an-email', subjects: 'Art' },
        { name: 'Dup Employee', employeeId: 'T001', subjects: 'Art' },
      ];
      const dry = (await api().post('/api/school/imports/teachers').set(W.h).send({ rows, dryRun: true })).body;
      expect(dry).toMatchObject({ valid: 1, invalid: 2 });
      expect((await api().get('/api/school/subjects').set(W.h)).body.some((x) => x.name === 'Physics')).toBe(false); // a dry run writes nothing
      const h = { ...root.h, 'X-Acting-School': W.id };
      const done = (await api().post('/api/school/imports/teachers').set(h).send({ rows, dryRun: false, skipInvalid: true })).body;
      expect(done.created).toBe(1);
      expect((await api().get('/api/school/subjects').set(W.h)).body.some((x) => x.name === 'Physics')).toBe(true);
      const batches = (await api().get('/api/school/imports').set(W.h)).body;
      expect(batches.find((b) => b.entity === 'teachers').actingAsSuperAdmin).toBe(true);
      // teachers/students can't import
      expect((await api().post('/api/school/imports/students').set(W.teacher1.h).send({ rows: [{ name: 'x' }] })).status).toBe(403);
    });
  });

  describe('dashboards, search, profile and sessions', () => {
    it('admin dashboard aggregates real numbers', async () => {
      const d = (await api().get('/api/school/dashboard').set(W.h)).body;
      expect(d.cards).toMatchObject({ teachers: 3 });
      expect(d.finance).toMatchObject({ pending: 0, overdue: 0 });
      expect(d.library).toMatchObject({ onLoan: 0, overdue: 0 });
      expect(d.subscription).toMatchObject({ status: 'active' });
      expect(d.subscription.studentLimit).toBeUndefined(); // there is no student or teacher cap
      expect(d.recent.length).toBeGreaterThan(0);
      const rep = (await api().get('/api/school/reports/summary').set(W.h)).body;
      expect(Array.isArray(rep.strength)).toBe(true);
    });

    it('teacher dashboard: schedule, counts and scoped search', async () => {
      const yr = W.year._id;
      const d = (await api().get(`/api/teacher/dashboard?yearId=${yr}`).set(W.teacher1.h)).body;
      expect(d.cards.assignedClasses).toBe(1);
      expect(d.cards.assignedStudents).toBeGreaterThanOrEqual(0);
      expect(d.greeting.name).toBe('Mr Sharma');
      expect(d.exams).toHaveProperty('awaitingSubmission');
      const s = (await api().get(`/api/teacher/search?q=Aarav&yearId=${yr}`).set(W.teacher1.h)).body;
      expect(Array.isArray(s.students)).toBe(true);
      const outside = (await api().get(`/api/teacher/search?q=Imp&yearId=${yr}`).set(W.teacher1.h)).body;
      expect(outside.students).toHaveLength(0);
      const adm = (await api().get('/api/school/search?q=Sharma').set(W.h)).body;
      expect(adm.teachers.length).toBe(1);
    });

    it('student profile: only school-permitted fields are editable; identity fields never', async () => {
      const S = W.studentLogins[2].h;
      const p = (await api().get('/api/student/profile').set(S)).body;
      expect(p.academic).toHaveProperty('admissionNo');
      expect(p.editableFields).toEqual([]); // by default a student can only look at their own details
      expect((await api().patch('/api/student/profile').set(S).send({ phone: '9000000001' })).status).toBe(403);
      await api().put('/api/school/settings').set(W.h).send({ studentCanEditProfile: ['phone', 'address'] }); // a school may choose to allow some
      expect((await api().patch('/api/student/profile').set(S).send({ phone: '9000000001' })).body.personal.phone).toBe('9000000001');
      for (const bad of [{ sectionId: '64b000000000000000000000' }, { admissionNo: 'X' }, { rollNo: 1 }, { name: 'New Name' }, { role: 'school_admin' }]) {
        expect((await api().patch('/api/student/profile').set(S).send(bad)).status).toBe(400);
      }
      expect((await api().patch('/api/student/profile').set(S).send({ email: 'a@b.co' })).status).toBe(403); // not in the allow-list
      await api().put('/api/school/settings').set(W.h).send({ studentCanEditProfile: ['phone', 'address', 'email'] });
      expect((await api().patch('/api/student/profile').set(S).send({ email: 'a@b.co' })).status).toBe(200);
      expect((await api().patch('/api/auth/preferences').set(S).send({ role: 'school_admin', language: 'hi' })).body.role).toBe('student');
    });

    it('settings are validated; sessions can be listed and revoked', async () => {
      expect((await api().put('/api/school/settings').set(W.h).send({ timezone: 'Mars/Base' })).status).toBe(400);
      expect((await api().put('/api/school/settings').set(W.h).send({ admissionFormat: 'NOSEQ' })).status).toBe(400);
      expect((await api().put('/api/school/settings').set(W.h).send({ grading: { passPercentage: 40, scale: [{ min: 50, grade: 'A' }] } })).status).toBe(400);
      const ok = await api().put('/api/school/settings').set(W.h).send({ attendance: { lateCountsAsPresent: false }, grading: { passPercentage: 35, scale: [{ min: 0, grade: 'F' }, { min: 35, grade: 'P' }, { min: 75, grade: 'D' }] } });
      expect(ok.body.grading.scale[0].grade).toBe('D');
      expect(ok.body.attendance).toMatchObject({ lateCountsAsPresent: false });
      const S1 = await login(W.t1.credentials.loginId, 'Brand-new1').catch(() => login(W.t1.credentials.loginId, W.t1.credentials.temporaryPassword));
      const S2 = await login(S1.user.loginId, W.t1.credentials.temporaryPassword).catch(() => S1);
      const list = (await api().get('/api/auth/sessions').set(S1.h)).body;
      expect(list.filter((s) => s.current)).toHaveLength(1);
      const other = list.find((s) => !s.current);
      if (other) {
        await api().delete(`/api/auth/sessions/${other.id}`).set(S1.h);
        expect((await api().get('/api/auth/me').set(S2.h)).status).toBe(S2 === S1 ? 200 : 401);
      }
      await api().post('/api/auth/logout').set(S1.h);
      expect((await api().get('/api/auth/me').set(S1.h)).status).toBe(401);
    });

    it('exports are complete for a big school (not capped at one page)', async () => {
      const { Student, StudentEnrolment } = await import('../src/models/index.js');
      const N = 430;
      const { default: mongoose } = await import('mongoose');
      const ids = Array.from({ length: N }, () => new mongoose.Types.ObjectId());
      await Student.insertMany(ids.map((_id, i) => ({ _id, tenantId: W.id, name: `Bulk Pupil ${i}`, admissionNo: `BULK${i}`, dob: '2013-01-01', guardians: [{ name: 'Parent', relationship: 'Father', phone: '9876543210' }], status: 'active' })));
      await StudentEnrolment.insertMany(ids.map((studentId, i) => ({ tenantId: W.id, studentId, yearId: y2._id, classId: W.c8._id, sectionId: s8A2._id, rollNo: 1000 + i, startDate: '2027-04-01', status: 'active' })));
      const csv = (await api().get('/api/school/export/students.csv').set(W.h)).text.trim().split('\n');
      expect(csv.length - 1).toBeGreaterThanOrEqual(N); // header + every student
      expect(csv.filter((l) => l.includes('Bulk Pupil'))).toHaveLength(N);
    });

    it('health endpoints and security headers', async () => {
      expect((await api().get('/health')).body.status).toBe('ok');
      expect((await api().get('/ready')).status).toBe(200);
      const r = await api().get('/health');
      expect(r.headers['x-powered-by']).toBeUndefined();
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-request-id']).toBeTruthy();
      expect((await api().get('/api/nope')).status).toBe(404);
      expect((await api().post('/api/auth/login').set('Content-Type', 'application/json').send('{bad')).status).toBe(400);
    });
  });
});
