import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { StudentEnrolment, Notification, StudentCharge, AttendanceRecord } from '../src/models/index.js';

describe('Class-wise promotion: each class moves to the next year on its own, with the office approving', () => {
  let root; let W; let y2; let s9A2; let s8A2; let s9A1; let nine; let pv;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'cp');
    y2 = (await W.post(W.h, '/api/school/years', { name: '2027-2028', startDate: '2027-04-01', endDate: '2028-03-31' })).body;
    s9A2 = (await W.post(W.h, '/api/school/sections', { yearId: y2._id, classId: W.c9._id, name: 'A', capacity: 30 })).body;
    s8A2 = (await W.post(W.h, '/api/school/sections', { yearId: y2._id, classId: W.c8._id, name: 'A', capacity: 30 })).body;
    await W.post(W.h, '/api/school/sections', { yearId: y2._id, classId: W.c9._id, name: 'B', capacity: 30 });
    // Class 9 is running in the old year, with a student of its own: it must never be touched by Class 8 moving on
    s9A1 = (await W.post(W.h, '/api/school/sections', { yearId: W.year._id, classId: W.c9._id, name: 'A', capacity: 30 })).body;
    nine = (await W.post(W.h, '/api/school/students', { name: 'Nine Student', dob: '2012-05-05', sectionId: s9A1._id, admissionDate: '2026-04-15', guardians: [{ name: 'Parent Nine', relationship: 'Father', phone: '9876543211', email: 'nine@cp.test' }] })).body;
  });
  afterAll(teardown);
  const T = (p) => `/api/teacher/promotion${p}`;
  const adminApprovals = async () => (await api().get('/api/school/approvals').set(W.h)).body;
  const mine = async () => (await api().get(T('')).set(W.teacher1.h)).body.sections[0];

  it('the class teacher sees their class as active, and cannot move it without telling the office first', async () => {
    const o = (await api().get(T('')).set(W.teacher1.h)).body;
    expect(o.sections.map((s) => s.name)).toEqual(['Class 8 A']);
    expect(o.sections[0]).toMatchObject({ status: 'active', waiting: 3, canAsk: true, canMove: false, request: null });
    expect(o.toYears.map((y) => y.name)).toEqual(['2027-2028']);
    const early = await api().get(T(`/preview?sectionId=${W.sec8A._id}&toYearId=${y2._id}`)).set(W.teacher1.h);
    expect(early.status).toBe(400); expect(early.body.error).toMatch(/Tell the office/);
  });

  it('"Session is ending" sends a request to the office; it can be asked once, and the office is notified', async () => {
    const ask = (b = {}) => api().post(T('/request')).set(W.teacher1.h).send({ sectionId: W.sec8A._id, toYearId: y2._id, ...b });
    expect((await api().post(T('/request')).set(W.teacher2.h).send({ sectionId: W.sec8A._id, toYearId: y2._id })).status).toBe(403); // not their class
    const r = await ask({ note: 'Exams are over' }); expect(r.status).toBe(201); expect(r.body).toMatchObject({ status: 'pending', waiting: 3 });
    expect((await ask()).status).toBe(409); // one open request per class
    expect((await mine())).toMatchObject({ status: 'promotion_in_progress', canAsk: false, canMove: false, request: { status: 'pending' } });
    const a = await adminApprovals(); expect(a.promotions[0].destination).toMatchObject({ className: 'Class 9', ready: false }); // the office sees whether Class 9 of the next year is set up
    expect(a.counts.promotions).toBe(1); expect(a.promotions[0]).toMatchObject({ label: 'Class 8 A', requestedByName: 'Mr Sharma', note: 'Exams are over', toYear: '2027-2028' });
    expect(await Notification.countDocuments({ category: 'approvals', title: /Class 8 A is ready/ })).toBeGreaterThan(0);
    expect((await api().get(T(`/preview?sectionId=${W.sec8A._id}&toYearId=${y2._id}`)).set(W.teacher1.h)).status).toBe(400); // still waiting for the office
  });

  it('the office can reject (with a reason), the teacher is told, and they may ask again', async () => {
    const id = (await adminApprovals()).promotions[0].id;
    expect((await api().post(`/api/school/approvals/promotions/${id}`).set(W.teacher1.h).send({ approve: false })).status).toBe(403);
    expect((await api().post(`/api/school/approvals/promotions/${id}`).set(W.h).send({ approve: false, note: 'Marks are not entered yet' })).status).toBe(200);
    expect((await mine()).request).toMatchObject({ status: 'rejected', decisionNote: 'Marks are not entered yet' });
    expect((await api().post(`/api/school/approvals/promotions/${id}`).set(W.h).send({ approve: true })).status).toBe(409); // already decided
    expect((await api().post(T('/request')).set(W.teacher1.h).send({ sectionId: W.sec8A._id, toYearId: y2._id })).status).toBe(201);
    const withdrawn = (await api().get('/api/school/approvals').set(W.h)).body.promotions[0];
    expect((await api().post(T(`/request/${withdrawn.id}/withdraw`)).set(W.teacher1.h)).status).toBe(200);
    expect((await mine()).canAsk).toBe(true);
    expect((await api().post(T('/request')).set(W.teacher1.h).send({ sectionId: W.sec8A._id, toYearId: y2._id })).status).toBe(201);
  });

  it('once approved the class teacher reviews and moves their class; Class 9 and the school year stay as they were', async () => {
    const id = (await adminApprovals()).promotions[0].id;
    expect((await api().post(`/api/school/approvals/promotions/${id}`).set(W.h).send({ approve: true })).status).toBe(200);
    expect((await api().post(T(`/request/${id}/withdraw`)).set(W.teacher1.h)).status).toBe(404); // approved: no longer theirs to withdraw
    expect((await mine())).toMatchObject({ canMove: true, request: { status: 'approved' } });
    expect((await api().get(T(`/preview?sectionId=${W.sec8A._id}&toYearId=${y2._id}`)).set(W.teacher2.h)).status).toBe(403);
    pv = (await api().get(T(`/preview?sectionId=${W.sec8A._id}&toYearId=${y2._id}`)).set(W.teacher1.h)).body;
    expect(pv.items).toHaveLength(3); expect(pv.items.every((i) => i.toClass === 'Class 9')).toBe(true);
    const body = (items) => ({ sectionId: W.sec8A._id, toYearId: y2._id, confirm: true, items });
    expect((await api().post(T('')).set(W.teacher1.h).send(body([{ enrolmentId: pv.items[0].enrolmentId, action: 'withdraw' }]))).status).toBe(400); // leaving the school is the office's
    const items = [{ enrolmentId: pv.items[0].enrolmentId, action: 'promote', toSectionId: s9A2._id }, { enrolmentId: pv.items[1].enrolmentId, action: 'retain', toSectionId: s8A2._id }];
    const out = await api().post(T('')).set(W.teacher1.h).send(body(items));
    expect(out.status).toBe(200); expect(out.body).toMatchObject({ promoted: 1, retained: 1 });
    expect((await api().post(T('')).set(W.teacher1.h).send(body(items))).status).toBe(400); // repeating it cannot move anyone twice
    expect((await api().get('/api/school/years').set(W.h)).body.find((y) => y.isCurrent).name).toBe('2026-2027'); // the school's year is unchanged
    expect((await api().get('/api/student/profile').set(W.studentLogins[0].h)).body.academic).toMatchObject({ academicYear: '2027-2028', className: 'Class 9' });
    expect((await api().get('/api/student/profile').set(W.studentLogins[2].h)).body.academic.academicYear).toBe('2026-2027');
    // Class 9 is untouched
    expect((await api().get(`/api/school/students/${nine._id ?? nine.student?._id}`).set(W.h)).status).toBe(200);
    expect(await StudentEnrolment.countDocuments({ studentId: nine._id ?? nine.student?._id, yearId: W.year._id, status: 'active' })).toBe(1);
    // the old record ends when the class's session ended, and is kept
    const old = await StudentEnrolment.findOne({ _id: pv.items[0].enrolmentId });
    expect(old.status).toBe('promoted'); expect(old.endDate).toBeTruthy(); expect(old.endDate <= '2026-12-31').toBe(true);
    expect((await mine())).toMatchObject({ waiting: 1, moved: 2, status: 'promotion_in_progress', request: { status: 'approved' } });
  });

  it('every class has its own status, derived from its dates and students', async () => {
    const p = (await api().get(`/api/school/promotions/progress?yearId=${W.year._id}`).set(W.h)).body;
    const by = Object.fromEntries(p.classes.map((c) => [c.className, c]));
    expect(by['Class 8']).toMatchObject({ status: 'promotion_in_progress', waiting: 1, moved: 2 });
    expect(by['Class 9']).toMatchObject({ status: 'active', waiting: 1, moved: 0 });
    const p2 = (await api().get(`/api/school/promotions/progress?yearId=${y2._id}`).set(W.h)).body;
    expect(p2.classes.find((c) => c.className === 'Class 9')).toMatchObject({ waiting: 1 }); // the moved student is already running there
  });

  it('a student moved to the next year keeps the dues of the year they left, and new bills follow their new year', async () => {
    const aaravId = pv.items[0].studentId;
    await StudentCharge.create({ tenantId: (await StudentEnrolment.findOne({ studentId: aaravId })).tenantId, studentId: aaravId, yearId: W.year._id, kind: 'fee', label: 'Tuition — Aug', amount: 1000, dueDate: '2026-08-10' });
    const dues = (await api().get('/api/school/finance/students?status=overdue').set(W.h)).body;
    expect(JSON.stringify(dues)).toContain('Aarav'); // in Class 9 of the new year, still owing last year's tuition
    const fs = await api().post('/api/school/staff').set(W.h).send({ name: 'Fiona Finance', email: 'fiona@cp.test', role: 'finance', phone: '9833333333', dob: '1984-04-04' });
    const fin = await login(fs.body.loginId, fs.body.temporaryPassword, 'finance');
    const c = await api().post('/api/finance/charges').set(fin.h).send({ studentId: aaravId, label: 'Trip', amount: 200, dueDate: '2027-05-01' });
    expect(c.status).toBe(201);
    expect(String((await StudentCharge.findOne({ studentId: aaravId, label: 'Trip' })).yearId)).toBe(String(y2._id)); // billed in the year the student is in now
  });

  it('a new student is admitted into the year of the section chosen, not the school year', async () => {
    const r = await api().post('/api/school/students').set(W.h).send({ name: 'Late Joiner', dob: '2012-06-06', sectionId: s9A2._id, admissionDate: '2027-04-10', guardians: [{ name: 'Parent Late', relationship: 'Father', phone: '9876543299', email: 'late@cp.test' }] });
    expect(r.status).toBe(201);
    const e = await StudentEnrolment.findOne({ studentId: r.body._id ?? r.body.student?._id, status: 'active' });
    expect(String(e.yearId)).toBe(y2._id);
  });

  it('the office can put a wrongly moved student back, until something is recorded for them in the new year', async () => {
    const [moved, kept] = [pv.items[0], pv.items[1]]; // Aarav was promoted, Bhavna kept back
    expect((await api().post('/api/school/promotions/undo').set(W.teacher1.h).send({ enrolmentId: moved.enrolmentId })).status).toBe(403); // not the teacher's
    expect((await api().post('/api/school/promotions/undo').set(W.h).send({ enrolmentId: pv.items[2].enrolmentId })).status).toBe(400); // never moved
    const newEnrol = await StudentEnrolment.findOne({ studentId: moved.studentId, yearId: y2._id, status: 'active' });
    await AttendanceRecord.create({ tenantId: newEnrol.tenantId, sessionId: newEnrol._id, studentId: moved.studentId, yearId: y2._id, sectionId: newEnrol.sectionId, date: '2027-04-12', status: 'present' });
    const blocked = await api().post('/api/school/promotions/undo').set(W.h).send({ enrolmentId: moved.enrolmentId });
    expect(blocked.status).toBe(409); expect(blocked.body.error).toMatch(/already been recorded/);
    await AttendanceRecord.deleteMany({ studentId: moved.studentId, yearId: y2._id });
    const ok = await api().post('/api/school/promotions/undo').set(W.h).send({ enrolmentId: moved.enrolmentId });
    expect(ok.status).toBe(200);
    expect((await api().get('/api/student/profile').set(W.studentLogins[0].h)).body.academic).toMatchObject({ academicYear: '2026-2027', className: 'Class 8' });
    expect(await StudentEnrolment.countDocuments({ studentId: moved.studentId, yearId: y2._id })).toBe(0);
    expect((await StudentEnrolment.findOne({ _id: moved.enrolmentId })).status).toBe('active');
    expect((await api().post('/api/school/promotions/undo').set(W.h).send({ enrolmentId: kept.enrolmentId })).status).toBe(200); // kept back, also put back
    // they are waiting again, and the teacher can move them properly
    expect((await mine())).toMatchObject({ waiting: 3, moved: 0 });
    expect((await api().get('/api/school/years').set(W.h)).body.find((y) => y.isCurrent).name).toBe('2026-2027');
  });

  it('the office promotes the rest: classes already moved are left alone, and the old year cannot close while a class is still running in it', async () => {
    const pv2 = (await api().post('/api/school/promotions/preview').set(W.h).send({ fromYearId: W.year._id, toYearId: y2._id })).body;
    expect(pv2.items).toHaveLength(4); // Class 8's three (put back by the undo above) + Class 9's student; anyone already moved is never offered again
    expect(pv2.classes.find((c) => c.className === 'Class 8')).toMatchObject({ waiting: 3, moved: 0, inScope: true });
    expect(pv2.items.every((i) => i.notices.length > 0)).toBe(true); // their session has not ended: said so, not blocked
    // only Class 9
    const only9 = (await api().post('/api/school/promotions/preview').set(W.h).send({ fromYearId: W.year._id, toYearId: y2._id, classIds: [W.c9._id] })).body;
    expect(only9.items.map((i) => i.fromClass)).toEqual(['Class 9']);
    expect(only9.classes.find((c) => c.className === 'Class 8').inScope).toBe(false);
    const send = (pvx, extra = {}) => api().post('/api/school/promotions/commit').set(W.h).send({ fromYearId: W.year._id, toYearId: y2._id, confirm: true, items: pvx.items.map((i) => ({ enrolmentId: i.enrolmentId, action: i.action, toSectionId: i.toSectionId })), ...extra });
    // Class 9 alone, asking to close the year: refused, Class 8's last student is still there
    const closing = await send(only9, { closeFromYear: true }); expect(closing.status).toBe(409); expect(closing.body.error).toMatch(/cannot be closed/);
    expect((await StudentEnrolment.countDocuments({ yearId: W.year._id, status: 'active' }))).toBe(4); // nothing was written
    const ok9 = await send(only9); expect(ok9.status).toBe(200); expect(ok9.body.completed).toBe(1); // the school has no class above 9 here, so the student finishes
    expect((await send(only9)).status).toBe(409); // the same promotion cannot be repeated
    expect((await api().get('/api/school/years').set(W.h)).body.find((y) => y._id === W.year._id).status).not.toBe('closed');
    // the last one, with the year closing: allowed, and the teacher's open request closes by itself
    const pv3 = (await api().post('/api/school/promotions/preview').set(W.h).send({ fromYearId: W.year._id, toYearId: y2._id })).body;
    expect(pv3.items).toHaveLength(3);
    // the next year has sections but no class teachers or subject teachers yet: the preview says so, and promoting needs a deliberate confirm
    expect(pv3.readiness.find((c) => c.className === 'Class 8')).toMatchObject({ ready: false, noClassTeacher: ['A'], noSubjects: true });
    expect(pv3.availableSections.every((x) => x.classTeacher === null)).toBe(true);
    const blocked = await send(pv3, { closeFromYear: true, makeCurrent: true }); expect(blocked.status).toBe(409); expect(blocked.body.error).toMatch(/not fully set up/);
    expect(await StudentEnrolment.countDocuments({ yearId: W.year._id, status: 'active' })).toBe(3); // nothing moved
    const last = await send(pv3, { closeFromYear: true, makeCurrent: true, acknowledgeGaps: true }); expect(last.status).toBe(200);
    expect((await api().get('/api/school/approvals').set(W.h)).body.counts.promotions).toBe(0);
    const p = (await api().get(`/api/school/promotions/progress?yearId=${W.year._id}`).set(W.h)).body;
    expect(p.year.status).toBe('closed'); expect(p.classes.every((c) => c.status === 'archived')).toBe(true);
    // history is kept: the closed year still lists the students it had
    expect(await StudentEnrolment.countDocuments({ yearId: W.year._id })).toBe(4);
  });
});
