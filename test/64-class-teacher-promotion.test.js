import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { StudentEnrolment, StudentCharge, AttendanceRecord } from '../src/models/index.js';

describe('Class-wise promotion by the office: a class moves as a whole, and one class never touches another', () => {
  let root; let W; let y2; let s8A2; let s8B2; let s9A2; let s9A1; let nine; let items;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'cp');
    y2 = (await W.post(W.h, '/api/school/years', { name: '2027-2028', startDate: '2027-04-01', endDate: '2028-03-31' })).body;
    s8A2 = (await W.post(W.h, '/api/school/sections', { yearId: y2._id, classId: W.c8._id, name: 'A', capacity: 30 })).body;
    s8B2 = (await W.post(W.h, '/api/school/sections', { yearId: y2._id, classId: W.c8._id, name: 'B', capacity: 30 })).body;
    s9A2 = (await W.post(W.h, '/api/school/sections', { yearId: y2._id, classId: W.c9._id, name: 'A', capacity: 30 })).body;
    await W.post(W.h, '/api/school/sections', { yearId: y2._id, classId: W.c9._id, name: 'B', capacity: 30 });
    // Class 8 has two sections with students; Class 9 runs on in the old year with a student of its own
    await W.post(W.h, '/api/school/students', { name: 'Eight B Student', dob: '2013-07-07', sectionId: W.sec8B._id, admissionDate: '2026-04-15', guardians: [{ name: 'Parent Eight', relationship: 'Father', phone: '9876543212', email: 'eight@cp.test' }] });
    s9A1 = (await W.post(W.h, '/api/school/sections', { yearId: W.year._id, classId: W.c9._id, name: 'A', capacity: 30 })).body;
    nine = (await W.post(W.h, '/api/school/students', { name: 'Nine Student', dob: '2012-05-05', sectionId: s9A1._id, admissionDate: '2026-04-15', guardians: [{ name: 'Parent Nine', relationship: 'Father', phone: '9876543211', email: 'nine@cp.test' }] })).body;
  });
  afterAll(teardown);
  const preview = (b) => api().post('/api/school/promotions/preview').set(W.h).send({ fromYearId: W.year._id, toYearId: y2._id, ...b });
  const commit = (its, b = {}) => api().post('/api/school/promotions/commit').set(W.h).send({ fromYearId: W.year._id, toYearId: y2._id, confirm: true, items: its.map((i) => ({ enrolmentId: i.enrolmentId, action: i.action, toSectionId: i.toSectionId })), ...b });

  it('class teachers have no say in promotion: it is a whole-class decision made by the office', async () => {
    expect((await api().get('/api/teacher/promotion').set(W.teacher1.h)).status).toBe(404);
    expect((await api().post('/api/teacher/promotion').set(W.teacher1.h).send({})).status).toBe(404);
    expect((await api().post('/api/school/promotions/preview').set(W.teacher1.h).send({ fromYearId: W.year._id, toYearId: y2._id })).status).toBe(403);
    expect((await api().get('/api/school/approvals/summary').set(W.h)).body.count).toBe(0);
  });

  it('a preview of a class lists every section of it, and only that class', async () => {
    const pv = (await preview({ classIds: [W.c8._id] })).body;
    expect(pv.items).toHaveLength(4); // 3 in 8A, 1 in 8B
    expect([...new Set(pv.items.map((i) => i.fromSection))].sort()).toEqual(['A', 'B']);
    expect(pv.classes.find((c) => c.className === 'Class 8').inScope).toBe(true); expect(pv.classes.find((c) => c.className === 'Class 9').inScope).toBe(false);
    expect((await preview({ classIds: [W.c8._id], sectionIds: [W.sec8B._id] })).body.items).toHaveLength(4); // a section cannot be chosen on its own
    items = pv.items;
    expect(pv.availableSections.every((s) => s.yearName === '2027-2028')).toBe(true);
  });

  it('a class cannot be moved in part, and the next year must be set up on purpose', async () => {
    const part = await commit(items.slice(0, 3), { acknowledgeGaps: true });
    expect(part.status).toBe(409); expect(part.body.error).toMatch(/moves as a whole class.*1 of its 4/);
    expect(await StudentEnrolment.countDocuments({ yearId: W.year._id, status: 'active' })).toBe(5); // nothing moved
    const gaps = await commit(items); expect(gaps.status).toBe(409); expect(gaps.body.error).toMatch(/not fully set up/);
  });

  it('the whole class moves together; Class 9 and the school year stay as they were', async () => {
    const out = await commit(items, { acknowledgeGaps: true });
    expect(out.status).toBe(200); expect(out.body.promoted).toBe(4);
    expect((await commit(items, { acknowledgeGaps: true })).status).toBe(409); // repeating it cannot move anyone twice
    expect((await api().get('/api/school/years').set(W.h)).body.find((y) => y.isCurrent).name).toBe('2026-2027');
    expect((await api().get('/api/student/profile').set(W.studentLogins[0].h)).body.academic).toMatchObject({ academicYear: '2027-2028', className: 'Class 9' });
    expect(await StudentEnrolment.countDocuments({ studentId: nine._id ?? nine.student?._id, yearId: W.year._id, status: 'active' })).toBe(1);
    const old = await StudentEnrolment.findOne({ _id: items[0].enrolmentId }); expect(old.status).toBe('promoted'); expect(old.endDate).toBeTruthy();
    const p = (await api().get(`/api/school/promotions/progress?yearId=${W.year._id}`).set(W.h)).body;
    const by = Object.fromEntries(p.classes.map((c) => [c.className, c]));
    expect(by['Class 8']).toMatchObject({ status: 'completed', waiting: 0, moved: 4 }); expect(by['Class 9']).toMatchObject({ status: 'active', waiting: 1 });
  });

  it('both years are listed side by side, each section tagged with its year', async () => {
    const open = (await api().get('/api/school/sections?open=1').set(W.h)).body;
    const names = new Set(open.map((s) => s.yearName)); expect(names).toEqual(new Set(['2026-2027', '2027-2028']));
    expect(open.filter((s) => s.yearName === '2027-2028').some((s) => s.studentCount > 0)).toBe(true); // the students who moved are in the new Class 9
  });

  it('a moved student keeps the old year dues, and new bills and admissions follow the year of their class', async () => {
    const aaravId = items[0].studentId;
    await StudentCharge.create({ tenantId: (await StudentEnrolment.findOne({ studentId: aaravId })).tenantId, studentId: aaravId, yearId: W.year._id, kind: 'fee', label: 'Tuition — Aug', amount: 1000, dueDate: '2026-08-10' });
    expect(JSON.stringify((await api().get('/api/school/finance/students?status=overdue').set(W.h)).body)).toContain('Aarav');
    const fs = await api().post('/api/school/staff').set(W.h).send({ name: 'Fiona Finance', email: 'fiona@cp.test', role: 'finance', phone: '9833333333', dob: '1984-04-04' });
    const fin = await login(fs.body.loginId, fs.body.temporaryPassword, 'finance');
    expect((await api().post('/api/finance/charges').set(fin.h).send({ studentId: aaravId, label: 'Trip', amount: 200, dueDate: '2027-05-01' })).status).toBe(201);
    expect(String((await StudentCharge.findOne({ studentId: aaravId, label: 'Trip' })).yearId)).toBe(String(y2._id));
    const r = await api().post('/api/school/students').set(W.h).send({ name: 'Late Joiner', dob: '2012-06-06', sectionId: s9A2._id, admissionDate: '2027-04-10', guardians: [{ name: 'Parent Late', relationship: 'Father', phone: '9876543299', email: 'late@cp.test' }] });
    expect(r.status).toBe(201);
    expect(String((await StudentEnrolment.findOne({ studentId: r.body._id ?? r.body.student?._id, status: 'active' })).yearId)).toBe(String(y2._id));
  });

  it('the office can put one wrongly moved student back, until something is recorded for them in the new year; then move them again', async () => {
    const [moved, other] = [items[0], items[1]];
    expect((await api().post('/api/school/promotions/undo').set(W.teacher1.h).send({ enrolmentId: moved.enrolmentId })).status).toBe(403);
    expect((await api().post('/api/school/promotions/undo').set(W.h).send({ enrolmentId: nine.enrolmentId || '000000000000000000000000' })).status).toBe(404);
    const newEnrol = await StudentEnrolment.findOne({ studentId: moved.studentId, yearId: y2._id, status: 'active' });
    await AttendanceRecord.create({ tenantId: newEnrol.tenantId, sessionId: newEnrol._id, studentId: moved.studentId, yearId: y2._id, sectionId: newEnrol.sectionId, date: '2027-04-12', status: 'present' });
    const blocked = await api().post('/api/school/promotions/undo').set(W.h).send({ enrolmentId: moved.enrolmentId });
    expect(blocked.status).toBe(409); expect(blocked.body.error).toMatch(/already been recorded/);
    await AttendanceRecord.deleteMany({ studentId: moved.studentId, yearId: y2._id });
    // the charges made in the new year for this student are unpaid, so they go with the record
    await StudentCharge.deleteMany({ studentId: moved.studentId, yearId: y2._id });
    expect((await api().post('/api/school/promotions/undo').set(W.h).send({ enrolmentId: moved.enrolmentId })).status).toBe(200);
    expect((await api().get('/api/student/profile').set(W.studentLogins[0].h)).body.academic).toMatchObject({ academicYear: '2026-2027', className: 'Class 8' });
    const p = (await api().get(`/api/school/promotions/progress?yearId=${W.year._id}`).set(W.h)).body;
    expect(p.classes.find((c) => c.className === 'Class 8')).toMatchObject({ status: 'promotion_in_progress', waiting: 1, moved: 3 });
    // the one student left behind moves, as the rest of the class: whatever is still in the class is the whole of it
    const again = (await preview({ classIds: [W.c8._id] })).body; expect(again.items).toHaveLength(1);
    expect((await commit(again.items, { acknowledgeGaps: true })).status).toBe(200);
    expect(other.enrolmentId).toBeTruthy();
  });

  it('the old year closes only once every class has left it', async () => {
    const pv9 = (await preview({ classIds: [W.c9._id] })).body;
    expect(pv9.items).toHaveLength(1);
    expect(pv9.items.every((i) => i.notices.length > 0)).toBe(true); // its session has not ended: said, not blocked
    expect((await api().post(`/api/school/years/${W.year._id}/close`).set(W.h).send({})).status).toBe(409); // Class 9 is still in it
    const closing = await commit(pv9.items, { closeFromYear: true, makeCurrent: true, acknowledgeGaps: true });
    expect(closing.status).toBe(200);
    const p = (await api().get(`/api/school/promotions/progress?yearId=${W.year._id}`).set(W.h)).body;
    expect(p.year.status).toBe('closed'); expect(p.classes.every((c) => c.status === 'archived')).toBe(true);
    expect(await StudentEnrolment.countDocuments({ yearId: W.year._id })).toBeGreaterThanOrEqual(5); // history is kept
  });
});
