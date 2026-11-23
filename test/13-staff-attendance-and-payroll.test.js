import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { CalendarEvent } from '../src/models/index.js';

const MONTH = '2026-10'; // 31 days, 4 Sundays, 1 holiday (Fri 2 Oct) => 26 working days
const D1 = '2026-10-05'; const D2 = '2026-10-06'; const D3 = '2026-10-07';

describe('Staff attendance registers feed payroll, and payroll covers non-teaching and transport staff', () => {
  let root; let W; let tr; let kamla; let driver; let supportLevel; let prt; let t1; let t2;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'sat');
    t1 = W.t1.teacher._id; t2 = W.t2.teacher._id;
    await CalendarEvent.create({ tenantId: W.id, title: 'Gandhi Jayanti', type: 'holiday', startDate: '2026-10-02', endDate: '2026-10-02', sectionIds: [] });
    const c = await api().post('/api/school/staff').set(W.h).send({ name: 'Tara Transport', email: 'tara@sat.test', role: 'transport', phone: '9833333333', dob: '1984-04-04' });
    tr = await login(c.body.loginId, c.body.temporaryPassword, 'transport');
    const des = [...(await api().get('/api/school/designations').set(W.h)).body, ...(await api().get('/api/transport/designations').set(tr.h)).body];
    const id = (n) => des.find((d) => d.name === n)._id;
    kamla = (await api().post('/api/school/support-staff').set(W.h).send({ name: 'Kamla Devi', designationId: id('Sweeper'), joiningDate: '2020-01-01', email: 'clerk@fixture.test', phone: '9833333333', dob: '1984-04-04' })).body;
    driver = (await api().post('/api/transport/staff').set(tr.h).send({ name: 'Ramesh Bhai', designationId: id('Driver'), joiningDate: '2020-01-01' })).body;
  });
  afterAll(teardown);
  const S = (p) => `/api/school/staff-attendance${p}`;
  const T = (p) => `/api/transport/attendance${p}`;
  const P = (p) => `/api/school/payroll${p}`;

  it('everyone starts as present; teachers and general staff are the admin\'s register, transport staff the officer\'s', async () => {
    const reg = (await api().get(S(`/register?group=teachers&date=${D1}`)).set(W.h)).body;
    expect(reg).toMatchObject({ group: 'teachers', date: D1, canEdit: true, blocked: null, totals: { people: 2, present: 2, absent: 0 } });
    expect(reg.rows.map((r) => [r.name, r.status, r.source])).toEqual([['Mr Sharma', 'present', 'default'], ['Mrs Gupta', 'present', 'default']]);
    expect((await api().get(S(`/register?group=general&date=${D1}`)).set(W.h)).body.rows.map((r) => r.name)).toEqual(['Kamla Devi']); // general staff only
    expect((await api().get(T(`/register?group=transport&date=${D1}`)).set(tr.h)).body.rows.map((r) => r.name)).toEqual(['Ramesh Bhai']);
    // each desk marks only its own people
    expect((await api().get(S(`/register?group=transport&date=${D1}`)).set(W.h)).status).toBe(403);
    expect((await api().get(T(`/register?group=teachers&date=${D1}`)).set(tr.h)).status).toBe(403);
    expect((await api().get(S(`/register?group=teachers&date=${D1}`)).set(W.teacher1.h)).status).toBe(403);
    // the admin can read the transport register but not change it
    expect((await api().get('/api/school/transport/attendance/register?group=transport&date=' + D1).set(W.h)).status).toBe(200);
    expect((await api().put('/api/school/transport/attendance/register').set(W.h).send({ group: 'transport', date: D1, entries: [] })).status).toBe(403);
    // blocked days: Sunday, the holiday, the future
    expect((await api().get(S('/register?group=teachers&date=2026-10-04')).set(W.h)).body.blocked).toBe('not_working_day');
    expect((await api().get(S('/register?group=teachers&date=2026-10-02')).set(W.h)).body.blocked).toBe('holiday:Gandhi Jayanti');
    expect((await api().put(S('/register')).set(W.h).send({ group: 'teachers', date: '2026-10-04', entries: [] })).status).toBe(400);
    expect((await api().put(S('/register')).set(W.h).send({ group: 'teachers', date: '2027-01-12', entries: [] })).status).toBe(400);
  });

  it('a draft can be saved and changed; submitting locks the register; a correction needs a reason and is recorded', async () => {
    const draft = await api().put(S('/register')).set(W.h).send({ group: 'teachers', date: D1, entries: [{ personId: t1, status: 'absent', remark: 'No call' }] });
    expect(draft.status).toBe(200);
    expect(draft.body.session.status).toBe('draft');
    expect(draft.body.rows.find((r) => r.name === 'Mr Sharma')).toMatchObject({ status: 'absent', remark: 'No call' });
    expect((await api().put(S('/register')).set(W.h).send({ group: 'teachers', date: D1, entries: [{ personId: kamla._id, status: 'absent' }] })).status).toBe(404); // not a teacher
    // submit: Mrs Gupta is half day; Mr Sharma stays absent from the draft
    const sub = await api().put(S('/register')).set(W.h).send({ group: 'teachers', date: D1, submit: true, entries: [{ personId: t2, status: 'half_day' }] });
    expect(sub.body.session.status).toBe('submitted');
    expect(sub.body.rows.map((r) => [r.name, r.status])).toEqual([['Mr Sharma', 'absent'], ['Mrs Gupta', 'half_day']]);
    expect(sub.body).toMatchObject({ canEdit: false, canCorrect: true, totals: { absent: 1, halfDay: 1, present: 0 } });
    expect((await api().put(S('/register')).set(W.h).send({ group: 'teachers', date: D1, entries: [] })).status).toBe(409); // locked
    expect((await api().post(S('/correct')).set(W.h).send({ group: 'teachers', date: D1, personId: t2, status: 'present' })).status).toBe(400); // reason required
    const fixed = await api().post(S('/correct')).set(W.h).send({ group: 'teachers', date: D1, personId: t2, status: 'present', reason: 'Came after lunch, was marked by mistake' });
    expect(fixed.body.rows.find((r) => r.name === 'Mrs Gupta')).toMatchObject({ status: 'present', corrected: true });
    expect((await api().post(S('/correct')).set(W.h).send({ group: 'teachers', date: D2, personId: t2, status: 'present', reason: 'No register yet' })).status).toBe(409); // only a submitted register is corrected
    // a second day: Mr Sharma half day, nobody else mentioned
    await api().put(S('/register')).set(W.h).send({ group: 'teachers', date: D2, submit: true, entries: [{ personId: t1, status: 'half_day' }] });
    const month = (await api().get(S('/month?group=teachers&month=' + MONTH)).set(W.h)).body;
    expect(month.registers).toBe(2);
    expect(month.people.find((p) => p.name === 'Mr Sharma')).toMatchObject({ absent: 1, half_day: 1, present: 0, percentage: 25 }); // (0 + 0.5) / 2 days
    expect(month.people.find((p) => p.name === 'Mrs Gupta')).toMatchObject({ present: 2, absent: 0, percentage: 100 });
  });

  it('approved leave fills in the register by itself; a day that was never submitted counts for nothing', async () => {
    const lv = await api().post('/api/teacher/leave').set(W.teacher2.h).send({ leaveType: 'sick', startDate: D3, endDate: D3, reason: 'Fever and rest' });
    await api().post(`/api/school/leave/${lv.body._id}/decide`).set(W.h).send({ decision: 'approve' });
    const reg = (await api().get(S(`/register?group=teachers&date=${D3}`)).set(W.h)).body;
    expect(reg.rows.find((r) => r.name === 'Mrs Gupta')).toMatchObject({ status: 'leave', source: 'leave' });
    expect(reg.rows.find((r) => r.name === 'Mr Sharma')).toMatchObject({ status: 'present', source: 'default' });
    // a drafted but never submitted absence has no effect anywhere
    await api().put(S('/register')).set(W.h).send({ group: 'teachers', date: D3, entries: [{ personId: t1, status: 'absent' }] });
    expect((await api().get(S('/month?group=teachers&month=' + MONTH)).set(W.h)).body.registers).toBe(2);
  });

  it('transport staff and general staff registers are separate and submitted by their own desks', async () => {
    const s = await api().put(T('/register')).set(tr.h).send({ group: 'transport', date: D2, submit: true, entries: [{ personId: driver._id, status: 'absent', remark: 'Fever' }] });
    expect(s.body).toMatchObject({ session: { status: 'submitted' }, totals: { absent: 1, people: 1 } });
    expect((await api().put(T('/register')).set(tr.h).send({ group: 'transport', date: D2, entries: [] })).status).toBe(409);
    await api().put(S('/register')).set(W.h).send({ group: 'general', date: D1, submit: true, entries: [{ personId: kamla._id, status: 'absent' }] });
    expect((await api().get(S(`/register?group=general&date=${D1}`)).set(W.h)).body.rows[0]).toMatchObject({ name: 'Kamla Devi', status: 'absent' });
    expect((await api().get(S(`/register?group=teachers&date=${D1}`)).set({ ...root.h, 'X-Acting-School': W.id })).status).toBe(200); // Super Admin may act for the school
  });

  it('payroll covers staff too: pay levels for non-teaching staff, one salary list, and the right level for the right person', async () => {
    supportLevel = (await api().post(P('/levels')).set(W.h).send({ name: 'Support Grade', appliesTo: 'non_teaching', basic: 13000, allowances: [], deductions: [] })).body;
    prt = (await api().post(P('/levels')).set(W.h).send({ name: 'PRT', basic: 26000, allowances: [], deductions: [] })).body;
    expect(supportLevel.appliesTo).toBe('non_teaching');
    expect((await api().post(P(`/salaries/${kamla._id}`)).set(W.h).send({ levelId: prt._id, effectiveFrom: '2026-04-01' })).status).toBe(400); // a teaching level cannot be given to a sweeper
    expect((await api().post(P(`/salaries/${t1}`)).set(W.h).send({ levelId: supportLevel._id, effectiveFrom: '2026-04-01' })).status).toBe(400);
    const bulk = await api().post(P('/salaries/bulk')).set(W.h).send({ levelId: supportLevel._id, personIds: [kamla._id, driver._id], effectiveFrom: '2026-04-01', reason: 'Initial setup' });
    expect(bulk.body).toMatchObject({ updated: 2, failed: [] });
    expect((await api().post(P(`/salaries/${t1}`)).set(W.h).send({ levelId: prt._id, effectiveFrom: '2026-04-01' })).status).toBe(201);
    const all = (await api().get(P('/salaries')).set(W.h)).body;
    expect(all.items.map((x) => [x.name, x.personType]).sort()).toEqual([['Kamla Devi', 'staff'], ['Mr Sharma', 'teacher'], ['Mrs Gupta', 'teacher'], ['Ramesh Bhai', 'staff'], ['Tara Transport', 'staff']]); // the Transport officer is an employee too
    expect(all).toMatchObject({ withSalary: 3, withoutSalary: 2 }); // Mrs Gupta and the officer have none yet
    expect((await api().get(P('/salaries?type=staff')).set(W.h)).body.items.map((x) => x.name).sort()).toEqual(['Kamla Devi', 'Ramesh Bhai', 'Tara Transport']);
    expect((await api().get(P('/salaries?type=teachers&status=without')).set(W.h)).body.items.map((x) => x.name)).toEqual(['Mrs Gupta']);
    expect((await api().get(P(`/salaries/${kamla._id}`)).set(W.h)).body.person).toMatchObject({ name: 'Kamla Devi', designation: 'Sweeper', personType: 'staff' });
    expect((await api().get(P('/summary')).set(W.h)).body).toMatchObject({ people: 5, teachers: 2, staff: 3, withSalary: 3, withoutSalary: 2 });
    expect((await api().post(P(`/salaries/${kamla._id}`)).set(tr.h).send({ basic: 1, effectiveFrom: '2026-04-01' })).status).toBe(403); // the transport officer does not run payroll
  });

  it('absences from the registers reduce pay automatically: a day absent costs a day, a half day costs half', async () => {
    const run = (await api().post(P('/runs')).set(W.h).send({ month: MONTH })).body;
    expect(run).toMatchObject({ month: MONTH, workingDays: 26, totals: { count: 3 } });
    expect(run.skipped.map((s) => [s.name, s.reason]).sort()).toEqual([['Mrs Gupta', 'No salary set'], ['Tara Transport', expect.stringMatching(/^Joins on /)]]); // the officer started after this month
    const { payslips } = (await api().get(P(`/runs/${run._id}`)).set(W.h)).body;
    const by = (n) => payslips.find((p) => p.personName === n);
    // Mr Sharma: 26000 a month, absent 5 Oct (1 day) + half day 6 Oct = 1.5 days => 26000 x 1.5 / 26 = 1500
    expect(by('Mr Sharma')).toMatchObject({ personType: 'teacher', workingDays: 26, unpaidDays: 1.5, paidDays: 24.5, gross: 26000, lossOfPay: 1500, net: 24500 });
    // Kamla (general staff): absent 5 Oct => 13000 / 26 = 500
    expect(by('Kamla Devi')).toMatchObject({ personType: 'staff', designation: 'Sweeper', unpaidDays: 1, lossOfPay: 500, net: 12500, levelName: 'Support Grade' });
    // the driver was marked absent by the Transport officer on 6 Oct
    expect(by('Ramesh Bhai')).toMatchObject({ personType: 'staff', designation: 'Driver', unpaidDays: 1, lossOfPay: 500, net: 12500 });
    expect(by('Ramesh Bhai').payslipNo).toBe('PAY202610-S0002');
    // the unsubmitted draft for 7 Oct did not cost Mr Sharma anything, and the sick leave day did not cost Mrs Gupta anything (she has no salary yet)
    expect(run.totals.net).toBe(24500 + 12500 + 12500);
    W.run = run;
  });

  it('staff payslips go through the same approval, PDF and payment steps; nobody else can read them', async () => {
    const { payslips } = (await api().get(P(`/runs/${W.run._id}`)).set(W.h)).body;
    const k = payslips.find((p) => p.personName === 'Kamla Devi');
    const pdf = await api().get(P(`/payslips/${k._id}/pdf`)).set(W.h);
    expect(pdf.status).toBe(200); expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((await api().post(P(`/runs/${W.run._id}/approve`)).set(W.h)).body.status).toBe('approved'); // staff have no login: nothing to notify, nothing breaks
    expect((await api().get(`/api/teacher/payslips/${k._id}/pdf`).set(W.teacher1.h)).status).toBe(404); // a teacher cannot read a sweeper's payslip
    const paid = await api().post(P(`/runs/${W.run._id}/pay`)).set(W.h).send({ mode: 'cash', reference: 'Cash payroll' });
    expect(paid.body).toMatchObject({ status: 'paid', totals: { paid: 49500 } });
    const csv = await api().get(P(`/runs/${W.run._id}/export.csv`)).set(W.h);
    expect(csv.text).toContain('Kamla Devi'); expect(csv.text).toContain('Ramesh Bhai');
    // the teacher still sees only their own payslip
    expect((await api().get('/api/teacher/payslips').set(W.teacher1.h)).body.map((p) => p.personName)).toEqual(['Mr Sharma']);
  });

  it('a teacher sees their own attendance; the admin sees the same on the teacher\'s page; the heat map follows the registers', async () => {
    const mine = (await api().get('/api/teacher/my-attendance').set(W.teacher1.h)).body;
    expect(mine.source).toBe('registers');
    expect(mine.days.find((d) => d.date === D1)).toMatchObject({ status: 'absent', rawStatus: 'absent' });
    expect(mine.days.find((d) => d.date === D2)).toMatchObject({ rawStatus: 'half_day' });
    expect(mine.days.find((d) => d.date === '2026-10-08').status).toBeNull(); // no register that day: unknown, not absent
    expect(mine.summary).toMatchObject({ absent: 1, half_day: 1, present: 0 });
    const o = (await api().get(`/api/school/teachers/${t1}/overview`).set(W.h)).body;
    expect(o.attendance).toMatchObject({ source: 'registers', absent: 1, halfDay: 1, derivedFromLeave: false, registers: 2 });
    expect((await api().get('/api/teacher/my-attendance').set(W.studentLogins[0].h)).status).toBe(403);
  });
});
