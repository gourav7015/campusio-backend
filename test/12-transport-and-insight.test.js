import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login, makeSchool, makeFinance } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');

describe('Transport and the School Admin class/student views', () => {
  let root; let W; let bus; let lib; let sidA; let sidB;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'trn');
    sidA = W.students[0].student._id; sidB = W.students[1].student._id;

    const l = await api().post('/api/school/staff').set(W.h).send({ name: 'Lib', email: 'l@trn.test', role: 'library', phone: '9833333333', dob: '1984-04-04' });
    lib = await login(l.body.loginId, l.body.temporaryPassword, 'library');
  });
  afterAll(teardown);
  const A = (p) => `/api/school${p}`;
  const T = (p) => `/api/transport${p}`;
  let tr; let driver; let conductor; let sweeper; let other;

  it('the Transport officer is created by the School Admin and signs in through its own door', async () => {
    const c = await api().post(A('/staff')).set(W.h).send({ name: 'Tara Transport', email: 'tara@trn.test', role: 'transport', phone: '9833333333', dob: '1984-04-04' });
    expect(c.status).toBe(201);
    expect((await api().post('/api/auth/login').send({ loginId: c.body.loginId, password: c.body.temporaryPassword, portal: 'finance' })).status).toBe(401); // wrong door
    tr = await login(c.body.loginId, c.body.temporaryPassword, 'transport');
    expect(tr.user.role).toBe('transport');
    expect((await api().get(T('/dashboard')).set(W.teacher1.h)).status).toBe(403);
    expect((await api().get(T('/dashboard')).set({ ...root.h, 'X-Acting-School': W.id })).status).toBe(403); // Super Admin works through the admin portal
  });

  it('every school keeps its own designations; the Transport officer sees and adds only transport ones', async () => {
    const mine = (await api().get(T('/designations')).set(tr.h)).body;
    expect(mine.map((d) => d.name).sort()).toEqual(['Conductor', 'Driver', 'Transport Maintainer']);
    expect(mine.find((d) => d.name === 'Driver')).toMatchObject({ group: 'transport', busRole: 'driver' });
    // the School Admin's list is the other half: general titles only, never the transport ones
    const all = (await api().get(A('/designations')).set(W.h)).body.map((d) => d.name);
    expect(all).toEqual(expect.arrayContaining(['Sweeper', 'Gardener', 'Maid', 'Security Guard']));
    expect(all).not.toContain('Driver'); expect(all).not.toContain('Bus Attendant');
    // a new title from the officer is a transport title (and can fill a bus seat), whatever they send
    const ba = await api().post(T('/designations')).set(tr.h).send({ name: 'Bus Attendant', group: 'general', busRole: 'conductor' });
    expect(ba.status).toBe(201); expect(ba.body).toMatchObject({ group: 'transport', busRole: 'conductor' });
    expect((await api().post(T('/designations')).set(tr.h).send({ name: 'bus attendant' })).status).toBe(409);
    // the admin's new titles are always general ones, even if they ask for a transport title
    const hw = await api().post(A('/designations')).set(W.h).send({ name: 'Hostel Warden', group: 'transport', busRole: 'driver' });
    expect(hw.status).toBe(201); expect(hw.body).toMatchObject({ group: 'general', busRole: null });
    expect((await api().post(T('/designations')).set(W.teacher1.h).send({ name: 'Spy' })).status).toBe(403);
    // another school has its own list and never sees these
    other = await makeSchool(root, 'oth2');
    const theirs = (await api().get(A('/designations')).set(other.h)).body.map((d) => d.name);
    expect(theirs).not.toContain('Bus Attendant'); expect(theirs).not.toContain('Hostel Warden');
    expect((await api().post(A('/designations')).set(other.h).send({ name: 'Bus Attendant', group: 'general' })).status).toBe(201); // same name is fine in a different school
  });

  it('non-teaching staff: the School Admin adds general staff, the Transport officer adds drivers, conductors and maintainers', async () => {
    const des = [...(await api().get(A('/designations')).set(W.h)).body, ...(await api().get(T('/designations')).set(tr.h)).body]; const id = (n) => des.find((d) => d.name === n)._id;
    driver = (await api().post(T('/staff')).set(tr.h).send({ name: 'Ramesh Bhai', designationId: id('Driver'), phone: '9876500001', licenseNo: 'GJ0320100001', licenseExpiry: addDays(TODAY, 12), joiningDate: '2020-06-01' })).body;
    conductor = (await api().post(T('/staff')).set(tr.h).send({ name: 'Suresh Bhai', designationId: id('Conductor'), phone: '9876500002' })).body;
    expect(driver).toMatchObject({ staffId: 'S0001', designation: 'Driver', busRole: 'driver' }); expect(conductor.staffId).toBe('S0002');
    expect((await api().post(T('/staff')).set(tr.h).send({ name: 'Gopal', designationId: id('Sweeper') })).status).toBe(403); // not transport staff
    sweeper = (await api().post(A('/support-staff')).set(W.h).send({ name: 'Kamla Devi', designationId: id('Sweeper'), phone: '9876500003', email: 'clerk@fixture.test', dob: '1984-04-04' })).body;
    expect(sweeper).toMatchObject({ designation: 'Sweeper', group: 'general', staffId: 'S0003' });
    expect((await api().post(A('/support-staff')).set(W.h).send({ name: 'X', designationId: id('Driver') })).status).toBe(400); // name too short
    const asOfficer = (await api().get(T('/staff')).set(tr.h)).body; const asAdmin = (await api().get(A('/support-staff')).set(W.h)).body;
    expect(asOfficer.items.map((s) => s.name).sort()).toEqual(['Ramesh Bhai', 'Suresh Bhai']);
    expect(asAdmin.items.map((s) => s.name)).toEqual(['Kamla Devi']); // drivers and conductors are the Transport officer's, not the admin's
    expect((await api().get(T(`/staff/${sweeper._id}`)).set(tr.h)).status).toBe(404); // the officer cannot even open a sweeper's record
    expect((await api().get(A(`/support-staff/${driver._id}`)).set(W.h)).status).toBe(404); // the admin cannot open or edit a driver's record
    expect((await api().patch(A(`/support-staff/${driver._id}`)).set(W.h).send({ phone: '1111111111' })).status).toBe(404);
    expect((await api().post(A('/support-staff')).set(W.h).send({ name: 'Raju Driver', designationId: id('Driver') })).status).toBe(403); // transport staff are added by the officer
    expect((await api().get(A('/support-staff')).set(other.h)).body.items).toHaveLength(0); // other school
    // the admin has only a read-only window onto the transport desk
    expect((await api().get(A('/transport/staff')).set(W.h)).status).toBe(200);
    expect((await api().post(A('/transport/staff')).set(W.h).send({ name: 'Nope Nope', designationId: id('Driver') })).status).toBe(403);
  });

  it('buses are the Transport officer\'s work: crew from staff records, route, stops; the admin can only look', async () => {
    const body = { busNo: 'GJ-03-1234', registrationNo: 'GJ03AB1234', capacity: 2, routeName: 'Route 1 — Kalawad Road', startTime: '06:45', endTime: '08:00', stops: [{ name: 'Gondal Chowk', pickupTime: '07:10', dropTime: '14:40' }, { name: 'Raiya Circle', pickupTime: '07:25', fare: 1000 }], monthlyFare: 800,
      driverId: driver._id, conductorId: conductor._id, fitnessExpiry: addDays(TODAY, 10), insuranceExpiry: addDays(TODAY, 200) };
    expect((await api().post(T('/buses')).set(W.teacher1.h).send(body)).status).toBe(403);
    expect((await api().post(A('/transport/buses')).set(W.h).send(body)).status).toBe(403); // the admin does not edit buses
    expect((await api().post(T('/buses')).set(tr.h).send({ ...body, busNo: '' })).status).toBe(400);
    expect((await api().post(T('/buses')).set(tr.h).send({ ...body, startTime: '25:99' })).status).toBe(400);
    expect((await api().post(T('/buses')).set(tr.h).send({ ...body, driverId: conductor._id })).status).toBe(400); // a conductor cannot drive
    expect((await api().post(T('/buses')).set(tr.h).send({ ...body, driverId: sweeper._id })).status).toBe(400); // a sweeper is not a driver
    expect((await api().post(A('/transport/buses')).set(W.h).send(body)).status).toBe(403);
    bus = (await api().post(T('/buses')).set(tr.h).send(body)).body;
    expect(bus).toMatchObject({ busNo: 'GJ-03-1234', driverId: driver._id, conductorId: conductor._id });
    expect((await api().post(T('/buses')).set(tr.h).send(body)).status).toBe(409);
    expect((await api().post(T('/buses')).set(tr.h).send({ ...body, busNo: 'GJ-03-9999' })).status).toBe(409); // the same driver cannot drive two buses
    const list = (await api().get(T('/buses')).set(tr.h)).body;
    expect(list[0]).toMatchObject({ students: 0, driver: { name: 'Ramesh Bhai', phone: '9876500001', licenseNo: 'GJ0320100001' }, conductor: { name: 'Suresh Bhai' } });
    expect(list[0].alerts.map((a) => a.field).sort()).toEqual(['driver licence', 'fitness']); // both expire within 30 days
    expect((await api().get(A('/transport/buses')).set(W.h)).body[0].driver.name).toBe('Ramesh Bhai'); // admin can see
    // staff on a bus cannot be deactivated or re-titled until the bus is reassigned
    expect((await api().post(T(`/staff/${driver._id}/deactivate`)).set(tr.h)).status).toBe(409);
    expect((await api().patch(T(`/staff/${driver._id}`)).set(tr.h).send({ designationId: conductor.designationId })).status).toBe(409);
    expect((await api().patch(T(`/designations/${(await api().get(T('/designations')).set(tr.h)).body.find((d) => d.name === 'Driver')._id}`)).set(tr.h).send({ status: 'archived' })).status).toBe(409);
    expect((await api().get(T('/buses')).set(W.studentLogins[0].h)).status).toBe(403);
  });

  it('the Transport officer seats students within capacity; the dashboard shows what needs attention', async () => {
    const any = (await api().get(T(`/students?sectionId=${W.sec8A._id}`)).set(tr.h)).body;
    expect(any.map((s) => s.name)).toEqual(['Aarav Singh', 'Bhavna Rao', 'Chirag Das']);
    expect(Object.keys(any[0]).sort()).toEqual(['admissionNo', 'bus', 'className', 'name', 'rollNo', 'section', 'studentId']); // no marks, fees or personal details
    expect((await api().get(T('/students?q=Aar')).set(tr.h)).body.map((s) => s.name)).toEqual(['Aarav Singh']);
    expect((await api().post(T('/assign')).set(tr.h).send({ busId: bus._id, studentIds: [sidA], stop: 'Nowhere' })).status).toBe(400);
    expect((await api().post(T('/assign')).set(tr.h).send({ busId: bus._id, studentIds: [sidA], stop: 'Gondal Chowk' })).body).toMatchObject({ assigned: 1, seatsLeft: 1 });
    expect((await api().post(T('/assign')).set(tr.h).send({ busId: bus._id, studentIds: [sidB, W.students[2].student._id], stop: 'Raiya Circle' })).status).toBe(409); // only 1 seat left
    expect((await api().post(T('/assign')).set(tr.h).send({ busId: bus._id, studentIds: [sidB], stop: 'Raiya Circle' })).status).toBe(200);
    expect((await api().post(A('/transport/assign')).set(W.h).send({ busId: bus._id, studentIds: [W.students[2].student._id] })).status).toBe(403); // not the admin's work
    const detail = (await api().get(T(`/buses/${bus._id}`)).set(tr.h)).body;
    expect(detail.students.map((s) => [s.name, s.stop, s.className, s.section])).toEqual([['Aarav Singh', 'Gondal Chowk', 'Class 8', 'A'], ['Bhavna Rao', 'Raiya Circle', 'Class 8', 'A']]);
    expect((await api().patch(T(`/buses/${bus._id}`)).set(tr.h).send({ capacity: 1 })).status).toBe(409);
    expect((await api().delete(T(`/buses/${bus._id}`)).set(tr.h)).status).toBe(409);
    // a second bus without a crew, and a spare conductor, show up on the dashboard
    const spare = (await api().post(T('/staff')).set(tr.h).send({ name: 'Mohan Lal', designationId: conductor.designationId })).body;
    await api().post(T('/buses')).set(tr.h).send({ busNo: 'GJ-03-2222', capacity: 40 });
    const dash = (await api().get(T('/dashboard')).set(tr.h)).body;
    expect(dash.buses).toMatchObject({ total: 2, running: 2 });
    expect(dash).toMatchObject({ riders: 2, seatsFree: 40, staff: { total: 3 } });
    expect(dash.needsCrew).toEqual([{ id: expect.any(String), busNo: 'GJ-03-2222', missing: ['driver', 'conductor'] }]);
    expect(dash.idleCrew.map((s) => s.name)).toEqual(['Mohan Lal']);
    expect(spare.staffId).toBe('S0004');
    expect(dash.staff.byDesignation).toEqual(expect.arrayContaining([{ name: 'Driver', count: 1 }, { name: 'Conductor', count: 2 }]));
  });

  it('riding the bus is billed monthly by Finance, from this month: the stop\'s fare, or the bus\'s default fare', async () => {
    const fees = async (login) => (await api().get('/api/student/fees').set(login.h)).body;
    // Aarav boards at Gondal Chowk (no stop fare: the bus default of 800); Bhavna at Raiya Circle (stop fare 1000). Today is in November, so November to March = 5 months.
    const a = (await fees(W.studentLogins[0])).charges.filter((c) => c.category === 'Transport');
    expect(a.map((c) => [c.period, c.amount])).toEqual([['2026-11', 800], ['2026-12', 800], ['2027-01', 800], ['2027-02', 800], ['2027-03', 800]]);
    expect(a[0].label).toBe('Transport fee — November 2026 (bus GJ-03-1234, Gondal Chowk)');
    expect(a[0].dueDate).toBe('2026-11-10');
    const b = (await fees(W.studentLogins[1])).charges.filter((c) => c.category === 'Transport');
    expect(b.map((c) => c.amount)).toEqual([1000, 1000, 1000, 1000, 1000]);
    expect((await fees(W.studentLogins[2])).charges.filter((c) => c.category === 'Transport')).toHaveLength(0); // not a rider
    expect((await fees(W.studentLogins[0])).categories).toEqual(expect.arrayContaining([{ name: 'Transport', total: 4000, paid: 0, months: 5 }]));
    // stopping the bus removes the future unpaid months; the current month stays billed
    expect((await api().delete(T(`/students/${sidB}`)).set(tr.h)).status).toBe(200);
    expect((await fees(W.studentLogins[1])).charges.filter((c) => c.category === 'Transport').map((c) => c.period)).toEqual(['2026-11']);
    // and riding again bills the missing months without duplicating November
    const back = await api().post(T('/assign')).set(tr.h).send({ busId: bus._id, studentIds: [sidB], stop: 'Raiya Circle' });
    expect(back.body).toMatchObject({ assigned: 1, monthlyFare: 1000, monthsBilled: 4 });
    expect((await fees(W.studentLogins[1])).charges.filter((c) => c.category === 'Transport')).toHaveLength(5);
    // the officer sets fares but does not touch the fee ledger
    expect((await api().get('/api/transport/policy').set(tr.h)).status).toBe(404);
  });

  it('a student sees only their own bus with the driver and conductor; the admin sees it on the student', async () => {
    const mine = (await api().get('/api/student/transport').set(W.studentLogins[0].h)).body.bus;
    expect(mine).toMatchObject({ busNo: 'GJ-03-1234', stop: 'Gondal Chowk', pickupTime: '07:10', driver: { name: 'Ramesh Bhai', phone: '9876500001' }, conductor: { name: 'Suresh Bhai' } });
    expect((await api().get('/api/student/transport').set(W.studentLogins[2].h)).body.bus).toBeNull(); // not a bus rider
    expect((await api().post('/api/student/transport').set(W.studentLogins[0].h).send({})).status).toBe(404);
    expect((await api().get(A(`/students/${sidA}/overview`)).set(W.h)).body.bus).toMatchObject({ busNo: 'GJ-03-1234' });
  });

  it('class view: overview, students with attendance/score/bus/books, homework by day', async () => {
    const sec = W.sec8A._id;
    const ov = (await api().get(A(`/sections/${sec}/insight`)).set(W.h)).body;
    expect(ov).toMatchObject({ className: 'Class 8', section: 'A', students: 3, classTeacher: 'Mr Sharma', onBus: 2 });
    expect(ov.subjectTeachers.map((s) => [s.subject, s.teacher])).toEqual([['English', 'Mrs Gupta'], ['Mathematics', 'Mr Sharma']]);
    const st = (await api().get(A(`/sections/${sec}/students`)).set(W.h)).body;
    expect(st).toHaveLength(3);
    expect(st.find((s) => s.name === 'Aarav Singh')).toMatchObject({ bus: 'GJ-03-1234', booksOut: 0 });
    expect((await api().get(A(`/sections/${sec}/insight`)).set(W.teacher1.h)).status).toBe(403);
    // homework of a day, by subject; subjects that set nothing are listed too
    const hw = await api().post('/api/teacher/homework').set(W.teacher1.h).send({ title: 'Algebra worksheet', sectionId: sec, subjectId: W.maths._id, dueDate: addDays(TODAY, 2), assignedDate: TODAY, status: 'published' });
    expect(hw.status).toBe(201);
    const day = (await api().get(A(`/sections/${sec}/homework?date=${TODAY}`)).set(W.h)).body;
    expect(day.items.map((i) => [i.subject, i.title, i.kind])).toEqual([['Mathematics', 'Algebra worksheet', 'assigned']]);
    expect(day.subjectsWithout).toEqual(['English']);
    // the strip is one fixed Monday–Sunday week: picking another day in it, or asking for another week, never moves it
    expect(day.days).toHaveLength(7); expect(new Date(`${day.weekStart}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(day.days.find((d) => d.date === TODAY)).toEqual({ date: TODAY, count: 1 });
    const other = (await api().get(A(`/sections/${sec}/homework?date=${day.weekStart}`)).set(W.h)).body;
    expect(other.days.map((d) => d.date)).toEqual(day.days.map((d) => d.date));
    const prev = (await api().get(A(`/sections/${sec}/homework?date=${addDays(day.weekStart, -7)}&weekStart=${addDays(day.weekStart, -7)}`)).set(W.h)).body;
    expect(prev.days[0].date).toBe(addDays(day.weekStart, -7)); expect(prev.days.every((d) => d.count === 0)).toBe(true);
  });

  it('class-wise library borrowers: who has borrowed, who never has', async () => {
    const book = (await api().post('/api/library/books').set(lib.h).send({ title: 'Wings of Fire', author: 'A. P. J. Abdul Kalam', category: 'Biography', copies: 2 })).body;
    const acc = book.accessionNos[0];
    const issued = await api().post('/api/library/issue').set(lib.h).send({ borrowerType: 'student', borrowerId: sidA, accessionNo: acc });
    expect(issued.status).toBe(201);
    const q = (extra = '') => api().get(`/api/library/class-borrowers?sectionId=${W.sec8A._id}${extra}`).set(lib.h);
    const all = (await q()).body;
    expect(all.summary).toEqual({ students: 3, borrowedAny: 1, neverBorrowed: 2, holdingNow: 1, overdue: 0 });
    expect(all.students.find((s) => s.name === 'Aarav Singh')).toMatchObject({ borrowed: 1, holding: [{ title: 'Wings of Fire' }] });
    expect((await q('&filter=never')).body.students.map((s) => s.name).sort()).toEqual(['Bhavna Rao', 'Chirag Das']);
    expect((await q('&filter=borrowed')).body.students.map((s) => s.name)).toEqual(['Aarav Singh']);
    // the School Admin sees the same, read-only, and by whole class
    expect((await api().get(`/api/school/library/class-borrowers?classId=${W.c8._id}`).set(W.h)).body.summary.borrowedAny).toBe(1);
    expect((await api().get('/api/school/library/class-borrowers').set(W.h)).status).toBe(400);
    expect((await api().get(`/api/library/class-borrowers?sectionId=${W.sec8A._id}`).set(W.teacher1.h)).status).toBe(403);
    expect((await api().get('/api/library/lookups').set(lib.h)).body.classes.map((c) => c.name)).toContain('Class 8');
  });

  it('a teacher\'s whole picture: classes taught, class teacher of, results, attendance from leave, salary, homework', async () => {
    const t1 = W.t1.teacher._id;
    const leaveDay = (() => { let d = addDays(TODAY, -3); while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()) || new Date(`${d}T00:00:00Z`).getUTCDay() === 0) d = addDays(d, -1); return d; })();
    const lv = await api().post('/api/teacher/leave').set(W.teacher1.h).send({ leaveType: 'sick', startDate: leaveDay, endDate: leaveDay, reason: 'Fever and rest' });
    await api().post(`/api/school/leave/${lv.body._id}/decide`).set(W.h).send({ decision: 'approve' });
    const fin = await makeFinance(W, 'insfin');
    await api().post(`/api/finance/payroll/salaries/${t1}`).set(fin.h).send({ basic: 30000, allowances: [{ label: 'HRA', kind: 'percent', value: 40 }], effectiveFrom: '2026-04-01' });
    const o = (await api().get(A(`/teachers/${t1}/overview`)).set(W.h)).body;
    expect(o.profile).toMatchObject({ name: 'Mr Sharma', employeeId: 'T001', subjects: ['Mathematics'] });
    expect(o.classes).toMatchObject([{ className: 'Class 8', section: 'A', subject: 'Mathematics', students: 3 }]);
    expect(o.classTeacherOf).toMatchObject([{ className: 'Class 8', section: 'A', students: 3, attendanceToday: 'not_marked' }]);
    expect(o.attendance).toMatchObject({ onLeave: 1, derivedFromLeave: true, leaveByType: { sick: 1 } });
    expect(o.attendance.percentage).toBeLessThan(100);
    expect(o.attendance.days.find((d) => d.date === leaveDay)).toMatchObject({ status: 'leave', leaveType: 'sick' });
    expect(o.leave.balances.sick).toMatchObject({ used: 1 });
    expect(o.pay.current).toMatchObject({ basic: 30000, gross: 42000, net: 42000 });
    expect(o.timetable.periodsPerWeek).toBe(0); expect(o.substitutions.covered).toBe(0);
    expect(Object.keys(o)).toEqual(expect.arrayContaining(['classes', 'classTeacherOf', 'attendance', 'leave', 'pay', 'library', 'homework']));
    // a teacher who teaches only English, and is not a class teacher
    const g = (await api().get(A(`/teachers/${W.t2.teacher._id}/overview`)).set(W.h)).body;
    expect(g.classes.map((c) => c.subject)).toEqual(['English']); expect(g.classTeacherOf).toEqual([]);
    expect((await api().get(A(`/teachers/${t1}/overview`)).set(W.teacher1.h)).status).toBe(403);
    expect((await api().get(A(`/teachers/${t1}/overview`)).set(other.h)).status).toBe(404); // another school's admin
  });

  it('exam analysis by class and a student\'s whole picture in one call', async () => {
    const empty = (await api().get(A(`/analysis/exams?classId=${W.c8._id}`)).set(W.h)).body;
    expect(empty).toMatchObject({ className: 'Class 8', examsHeld: 0, sections: [{ name: 'A' }, { name: 'B' }] });
    expect((await api().get(A('/analysis/exams')).set(W.h)).status).toBe(400);
    const one = (await api().get(A(`/students/${sidA}/overview`)).set(W.h)).body;
    expect(one.profile).toMatchObject({ name: 'Aarav Singh', className: 'Class 8', section: 'A' });
    expect(one.library).toMatchObject([{ title: 'Wings of Fire', status: 'issued', overdue: false }]); // issued in the previous test
    expect(Object.keys(one)).toEqual(expect.arrayContaining(['attendance', 'exams', 'homework', 'fees', 'library', 'bus', 'remarks']));
    expect(one.attendance.days.length).toBeGreaterThan(0);
    expect((await api().get(A(`/students/${sidA}/overview`)).set(W.studentLogins[0].h)).status).toBe(403);
  });
});
