import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');
const MONTH = '2026-10';

describe('Staff portal, staff leave, check-in times, bank file and statutory deductions', () => {
  let root; let W; let tr; let kamla; let driver; let kLogin; let t1; let t2; let level;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'stp');
    t1 = W.t1.teacher._id; t2 = W.t2.teacher._id;
    // every day is a working day, so "today" is always open for check-in whenever this runs
    await api().put('/api/school/settings').set(W.h).send({ workingDays: [1, 2, 3, 4, 5, 6, 7] });
    const c = await api().post('/api/school/staff').set(W.h).send({ name: 'Tara Transport', email: 'tara@stp.test', role: 'transport' });
    tr = await login(c.body.loginId, c.body.temporaryPassword, 'transport');
    const des = [...(await api().get('/api/school/designations').set(W.h)).body, ...(await api().get('/api/transport/designations').set(tr.h)).body];
    const id = (n) => des.find((d) => d.name === n)._id;
    kamla = (await api().post('/api/school/support-staff').set(W.h).send({ name: 'Kamla Devi', designationId: id('Sweeper'), joiningDate: '2020-01-01' })).body;
    driver = (await api().post('/api/transport/staff').set(tr.h).send({ name: 'Ramesh Bhai', designationId: id('Driver'), joiningDate: '2020-01-01' })).body;
  });
  afterAll(teardown);
  const A = (p) => `/api/school${p}`;
  const STF = (p) => `/api/staff${p}`;

  it('staff get a login of their own from the desk that looks after them, and use their own portal', async () => {
    expect((await api().post(A(`/support-staff/${driver._id}/login`)).set(W.h).send({})).status).toBe(404); // the driver is the officer's
    const c = await api().post(A(`/support-staff/${kamla._id}/login`)).set(W.h).send({});
    expect(c.status).toBe(201); expect(c.body.loginId).toBe('stp.s0001'); expect(c.body.temporaryPassword).toBeTruthy();
    expect((await api().post(A(`/support-staff/${kamla._id}/login`)).set(W.h).send({})).status).toBe(409); // one login each
    const d = await api().post(`/api/transport/staff/${driver._id}/login`).set(tr.h).send({});
    expect(d.status).toBe(201);
    expect((await api().post('/api/auth/login').send({ loginId: c.body.loginId, password: c.body.temporaryPassword, portal: 'teacher' })).status).toBe(403); // wrong door
    kLogin = await login(c.body.loginId, c.body.temporaryPassword, 'staff');
    expect(kLogin.user).toMatchObject({ role: 'staff', mustChangePassword: true });
    const me = (await api().get(STF('/profile')).set(kLogin.h)).body;
    expect(me).toMatchObject({ name: 'Kamla Devi', staffId: 'S0001', designation: 'Sweeper', group: 'general' });
    // a staff login reaches only the Staff portal
    for (const url of ['/api/school/dashboard', '/api/teacher/dashboard', '/api/student/dashboard', '/api/finance/dashboard', '/api/transport/dashboard', '/api/school/staff-attendance/register?group=general']) expect((await api().get(url).set(kLogin.h)).status).toBe(403);
    expect((await api().get(STF('/profile')).set(W.teacher1.h)).status).toBe(403);
    // the list shows who has a login; a reset gives a new password and ends the old session
    expect((await api().get(A('/support-staff')).set(W.h)).body.items[0]).toMatchObject({ name: 'Kamla Devi', hasLogin: true });
    const reset_ = await api().post(A(`/support-staff/${kamla._id}/reset-password`)).set(W.h).send({});
    expect(reset_.body.temporaryPassword).not.toBe(c.body.temporaryPassword);
    expect((await api().get(STF('/profile')).set(kLogin.h)).status).toBe(401);
    kLogin = await login(c.body.loginId, reset_.body.temporaryPassword, 'staff');
  });

  it('staff apply for leave in their portal; the desk that looks after them decides; balances are counted', async () => {
    const bal = (await api().get(STF('/leave')).set(kLogin.h)).body.balances;
    expect(bal.casual).toEqual({ allowance: 12, used: 0, remaining: 12 });
    const day = addDays(TODAY, 5);
    expect((await api().post(STF('/leave')).set(kLogin.h).send({ leaveType: 'casual', startDate: day, endDate: addDays(day, -1), reason: 'Backwards' })).status).toBe(400);
    expect((await api().post(STF('/leave')).set(kLogin.h).send({ leaveType: 'earned', startDate: day, endDate: day, reason: 'No allowance' })).status).toBe(409); // earned allowance is 0
    const l = await api().post(STF('/leave')).set(kLogin.h).send({ leaveType: 'casual', startDate: day, endDate: addDays(day, 1), reason: 'Family function' });
    expect(l.status).toBe(201); expect(l.body).toMatchObject({ status: 'submitted', days: 2, group: 'general' });
    expect((await api().post(STF('/leave')).set(kLogin.h).send({ leaveType: 'sick', startDate: addDays(day, 1), endDate: addDays(day, 2), reason: 'Overlaps' })).status).toBe(409);
    // each desk sees only its own group
    expect((await api().get(A('/staff-leave?status=submitted')).set(W.h)).body.map((x) => x.staffId.name)).toEqual(['Kamla Devi']);
    expect((await api().get('/api/transport/leave').set(tr.h)).body).toEqual([]);
    expect((await api().post(`/api/transport/leave/${l.body._id}/decide`).set(tr.h).send({ decision: 'approve' })).status).toBe(404);
    expect((await api().post(A(`/staff-leave/${l.body._id}/decide`)).set(W.teacher1.h).send({ decision: 'approve' })).status).toBe(403);
    expect((await api().post(A(`/staff-leave/${l.body._id}/decide`)).set(W.h).send({ decision: 'approve', remark: 'Enjoy' })).body.status).toBe('approved');
    expect((await api().post(A(`/staff-leave/${l.body._id}/decide`)).set(W.h).send({ decision: 'reject' })).status).toBe(409);
    expect((await api().get(STF('/leave')).set(kLogin.h)).body.balances.casual).toEqual({ allowance: 12, used: 2, remaining: 10 });
    expect((await api().get('/api/staff/dashboard').set(kLogin.h)).body).toMatchObject({ name: 'Kamla Devi', pendingLeave: 0 });
    // the approved leave fills the register for those days
    const reg = (await api().get(A(`/staff-attendance/register?group=general&date=${day}`)).set(W.h)).body;
    expect(reg.blocked).toBe('future'); // the register cannot be taken for a future day, but the leave is remembered for when it comes
    // a desk can record leave for someone who has not applied themselves (no login)
    const rec = await api().post('/api/transport/leave').set(tr.h).send({ staffId: driver._id, leaveType: 'sick', startDate: addDays(TODAY, -2), endDate: addDays(TODAY, -2), reason: 'Fever, informed by phone' });
    expect(rec.status).toBe(201); expect(rec.body).toMatchObject({ status: 'approved', group: 'transport', days: 1 });
    expect((await api().post('/api/transport/leave').set(tr.h).send({ staffId: kamla._id, leaveType: 'sick', startDate: addDays(TODAY, -2), endDate: addDays(TODAY, -2), reason: 'Not the officer\'s' })).status).toBe(403);
    const past = (await api().get(`/api/transport/attendance/register?group=transport&date=${addDays(TODAY, -2)}`).set(tr.h)).body;
    expect(past.rows[0]).toMatchObject({ name: 'Ramesh Bhai', status: 'leave', source: 'leave' });
    // cancelling before it starts is allowed
    expect((await api().post(STF(`/leave/${l.body._id}/cancel`)).set(kLogin.h)).body.status).toBe('cancelled');
    expect((await api().get(STF('/leave')).set(kLogin.h)).body.balances.casual.used).toBe(0);
  });

  it('check-in and check-out: late against the school\'s hours, optional location fence, desk-entered times', async () => {
    // hours: shift starts 00:00 with no grace, so any check-in today is late; full day = 6h
    expect((await api().put(A('/settings')).set(W.h).send({ staffAttendance: { shiftStart: '00:00', shiftEnd: '23:59', graceMinutes: 0, fullDayHours: 6, halfDayHours: 3 } })).status).toBe(200);
    expect((await api().put(A('/settings')).set(W.h).send({ staffAttendance: { shiftStart: '25:00' } })).status).toBe(400);
    expect((await api().post(STF('/punch/check-out')).set(kLogin.h).send({})).status).toBe(409); // check in first
    const inn = await api().post(STF('/punch/check-in')).set(kLogin.h).send({});
    expect(inn.status).toBe(201);
    expect(inn.body.punch).toMatchObject({ source: 'self' }); expect(inn.body.punch.checkIn).toMatch(/^\d\d:\d\d$/);
    expect(inn.body.evaluation).toMatchObject({ late: true, suggested: 'late' });
    expect((await api().post(STF('/punch/check-in')).set(kLogin.h).send({})).status).toBe(409);
    const out = await api().post(STF('/punch/check-out')).set(kLogin.h).send({});
    expect(out.body.punch.checkOut).toMatch(/^\d\d:\d\d$/);
    expect(out.body.evaluation).toMatchObject({ hours: 0, suggested: 'half_day' }); // left the same minute: well under a full day
    expect((await api().post(STF('/punch/check-out')).set(kLogin.h).send({})).status).toBe(409);
    // the register shows the times and suggests the status the clock implies
    const reg = (await api().get(A(`/staff-attendance/register?group=general&date=${TODAY}`)).set(W.h)).body;
    expect(reg.rows[0]).toMatchObject({ name: 'Kamla Devi', status: 'half_day', source: 'times', punchSource: 'self' });
    expect(reg.rows[0].checkIn).toMatch(/^\d\d:\d\d$/);
    // the desk can overrule the suggestion and fix the times
    const sub = await api().put(A('/staff-attendance/register')).set(W.h).send({ group: 'general', date: TODAY, submit: true, entries: [{ personId: kamla._id, status: 'present', checkIn: '08:05', checkOut: '15:00' }] });
    expect(sub.body.rows[0]).toMatchObject({ status: 'present', checkIn: '08:05', checkOut: '15:00', hours: 6.9 });
    expect((await api().put(A('/staff-attendance/register')).set(W.h).send({ group: 'general', date: addDays(TODAY, -1), entries: [{ personId: kamla._id, status: 'present', checkIn: '25:00' }] })).status).toBe(400);
    expect((await api().put(A('/staff-attendance/register')).set(W.h).send({ group: 'general', date: addDays(TODAY, -1), entries: [{ personId: kamla._id, status: 'present', checkIn: '09:00', checkOut: '08:00' }] })).status).toBe(400);
    // a teacher checks in from their own portal the same way
    expect((await api().post('/api/teacher/punch/check-in').set(W.teacher1.h).send({})).status).toBe(201);
    expect((await api().get('/api/teacher/punch').set(W.teacher1.h)).body.punch.checkIn).toMatch(/^\d\d:\d\d$/);
    // location fence: only within 200 m of the school
    await api().put(A('/settings')).set(W.h).send({ staffAttendance: { location: { lat: 22.3039, lng: 70.8022, radiusMeters: 200 } } });
    expect((await api().get(STF('/punch')).set(kLogin.h)).body.policy).toMatchObject({ requiresLocation: true, radiusMeters: 200 });
    expect((await api().post(`/api/teacher/punch/check-in`).set(W.teacher2.h).send({})).status).toBe(400); // no location sent
    const far = await api().post('/api/teacher/punch/check-in').set(W.teacher2.h).send({ location: { lat: 22.3500, lng: 70.8022 } });
    expect(far.status).toBe(403); expect(far.body.error).toMatch(/\d+ m from the school/);
    const near = await api().post('/api/teacher/punch/check-in').set(W.teacher2.h).send({ location: { lat: 22.3041, lng: 70.8024 } });
    expect(near.status).toBe(201); expect(near.body.punch.source).toBe('self');
    await api().put(A('/settings')).set(W.h).send({ staffAttendance: { location: null } });
  });

  it('import the export of a biometric machine: earliest time is check-in, latest is check-out', async () => {
    const d1 = addDays(TODAY, -4); const d2 = addDays(TODAY, -3);
    const rows = [{ code: 'S0001', date: d1, time: '07:58' }, { code: 'S0001', date: d1, time: '15:12' }, { code: 'S0001', date: d1, time: '12:30' }, { code: 'S0001', date: d2, time: '08:40' }, { code: 'X999', date: d1, time: '08:00' }, { code: 's0001', date: d2, time: '99:99' }];
    expect((await api().post(A('/staff-attendance/punches/import')).set(W.h).send({ group: 'transport', rows: [] })).status).toBe(400);
    expect((await api().post(A('/staff-attendance/punches/import')).set(W.h).send({ group: 'transport', rows: [{ code: 'S0002', date: d1, time: '08:00' }] })).status).toBe(403); // not the admin's group
    const bad = await api().post(A('/staff-attendance/punches/import')).set(W.h).send({ group: 'general', rows: [{ code: 'S0001', date: d1, time: '8am' }] });
    expect(bad.status).toBe(400);
    // (the 99:99 row passes the shape check only if it looks like HH:MM, so send valid shapes and let unknown codes be reported)
    const ok = await api().post(A('/staff-attendance/punches/import')).set(W.h).send({ group: 'general', rows: rows.filter((r) => r.time !== '99:99') });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ imported: 2, people: 1, unknownCodes: ['X999'] });
    const reg = (await api().get(A(`/staff-attendance/register?group=general&date=${d1}`)).set(W.h)).body;
    expect(reg.rows[0]).toMatchObject({ checkIn: '07:58', checkOut: '15:12', punchSource: 'import', hours: 7.2 });
    expect((await api().get(A(`/staff-attendance/register?group=general&date=${d2}`)).set(W.h)).body.rows[0]).toMatchObject({ checkIn: '08:40', checkOut: null, source: 'times' }); // a single punch is a check-in only; 08:40 is late for an 08:00 shift? (shift here is 00:00)
    const tr1 = await api().post('/api/transport/attendance/punches/import').set(tr.h).send({ group: 'transport', rows: [{ code: 'S0002', date: d1, time: '07:30' }, { code: 'S0002', date: d1, time: '16:00' }] });
    expect(tr1.body).toMatchObject({ imported: 1, people: 1 });
  });

  it('bank details are validated and kept; the bank transfer file lists who can be paid and who is missing details', async () => {
    const bad = await api().patch(A(`/support-staff/${kamla._id}`)).set(W.h).send({ bank: { accountNo: '12ab', ifsc: 'HDFC0001234' } });
    expect(bad.status).toBe(400);
    expect((await api().patch(A(`/support-staff/${kamla._id}`)).set(W.h).send({ bank: { accountNo: '123456789012', ifsc: 'BADCODE' } })).status).toBe(400);
    expect((await api().patch(A(`/support-staff/${kamla._id}`)).set(W.h).send({ statutory: { uan: '12345' } })).status).toBe(400);
    const ok = await api().patch(A(`/support-staff/${kamla._id}`)).set(W.h).send({ bank: { accountName: 'Kamla Devi', accountNo: '123456789012', ifsc: 'hdfc0001234', bankName: 'HDFC Bank' }, statutory: { esiNo: '1234567890' } });
    expect(ok.status).toBe(200);
    expect(ok.body.bank).toMatchObject({ ifsc: 'HDFC0001234', accountNo: '123456789012' }); // upper-cased
    // pay levels and salaries: a teaching level for the teachers, a support level for staff
    level = (await api().post(A('/payroll/levels')).set(W.h).send({ name: 'Support Grade', appliesTo: 'non_teaching', basic: 13000, allowances: [], deductions: [] })).body;
    const prt = (await api().post(A('/payroll/levels')).set(W.h).send({ name: 'Senior', basic: 30000, allowances: [], deductions: [] })).body;
    const gupta = (await api().post(A('/payroll/levels')).set(W.h).send({ name: 'Junior', basic: 20000, allowances: [], deductions: [{ label: 'Provident Fund', kind: 'percent', value: 12 }] })).body;
    await api().post(A('/payroll/salaries/bulk')).set(W.h).send({ levelId: level._id, personIds: [kamla._id, driver._id], effectiveFrom: '2026-04-01' });
    await api().post(A(`/payroll/salaries/${t1}`)).set(W.h).send({ levelId: prt._id, effectiveFrom: '2026-04-01' });
    await api().post(A(`/payroll/salaries/${t2}`)).set(W.h).send({ levelId: gupta._id, effectiveFrom: '2026-04-01' });
    const run = (await api().post(A('/payroll/runs')).set(W.h).send({ month: MONTH })).body;
    W.run = run;
    expect((await api().get(A(`/payroll/runs/${run._id}/bank-file`)).set(W.h)).status).toBe(409); // approve first
    await api().post(A(`/payroll/runs/${run._id}/approve`)).set(W.h);
    const f = (await api().get(A(`/payroll/runs/${run._id}/bank-file`)).set(W.h)).body;
    expect(f).toMatchObject({ month: MONTH, count: 1, total: 13000 });
    expect(f.ready[0]).toMatchObject({ name: 'Kamla Devi', accountNo: '123456789012', ifsc: 'HDFC0001234', amount: 13000, narration: 'Salary 2026-10' });
    expect(f.missing.map((m) => [m.name, m.reason]).sort()).toEqual([['Mr Sharma', 'No bank account on record'], ['Mrs Gupta', 'No bank account on record'], ['Ramesh Bhai', 'No bank account on record']]);
    const csv = await api().get(A(`/payroll/runs/${run._id}/bank-file.csv`)).set(W.h);
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')[0]).toBe('Beneficiary Name,Account Number,IFSC,Amount,Payment Mode,Narration,Reference,Employee Id,Bank');
    expect(csv.text).toContain('Kamla Devi,123456789012,HDFC0001234,13000,NEFT,Salary 2026-10');
    expect((await api().get(A(`/payroll/runs/${run._id}/bank-file.csv`)).set(W.teacher1.h)).status).toBe(403);
    // once paid, the person is no longer in the file
    await api().post(A(`/payroll/runs/${run._id}/pay`)).set(W.h).send({ mode: 'bank_transfer', payslipIds: [f.ready[0].payslipId] });
    expect((await api().get(A(`/payroll/runs/${run._id}/bank-file`)).set(W.h)).body.count).toBe(0);
  });

  it('PF, ESI and Professional Tax follow the school\'s own policy; nothing is deducted twice; reports and files come out per month', async () => {
    // statutory deductions are OFF until a school switches them on: the October run above has none
    const before = (await api().get(A(`/payroll/runs/${W.run._id}`)).set(W.h)).body.payslips;
    expect(before.find((p) => p.personName === 'Kamla Devi')).toMatchObject({ gross: 13000, net: 13000, totalDeductions: 0 });
    expect((await api().put(A('/settings')).set(W.h).send({ statutory: { pf: { enabled: true }, esi: { enabled: true }, pt: { enabled: true, slabs: [{ upTo: 12000, amount: 0 }, { upTo: 1000000000, amount: 200 }] } } })).status).toBe(200);
    expect((await api().put(A('/settings')).set(W.h).send({ statutory: { pf: { employeeRate: 99 } } })).status).toBe(400);
    // a new month, so nothing is locked: 2026-09
    const run = (await api().post(A('/payroll/runs')).set(W.h).send({ month: '2026-09' })).body;
    const { payslips } = (await api().get(A(`/payroll/runs/${run._id}`)).set(W.h)).body;
    const by = (n) => payslips.find((p) => p.personName === n);
    // Mr Sharma, 30000: PF 12% of 15000 (the wage ceiling) = 1800; no ESI (above 21000); PT 200
    expect(by('Mr Sharma')).toMatchObject({ gross: 30000, totalDeductions: 2000, net: 28000 });
    expect(by('Mr Sharma').deductions.map((d) => [d.label, d.amount])).toEqual([['Provident Fund', 1800], ['Professional Tax', 200]]);
    // Kamla, 13000: PF 12% of 13000 = 1560; ESI 0.75% = 97.5 rounded up to 98; PT 200
    expect(by('Kamla Devi').deductions.map((d) => [d.label, d.amount])).toEqual([['Provident Fund', 1560], ['ESI', 98], ['Professional Tax', 200]]);
    expect(by('Kamla Devi').net).toBe(13000 - 1560 - 98 - 200);
    // Mrs Gupta's pay level already has a Provident Fund line (12% of 20000 = 2400): it is used, not added twice; ESI and PT still apply
    expect(by('Mrs Gupta').deductions.map((d) => [d.label, d.amount])).toEqual([['Provident Fund', 2400], ['ESI', 150], ['Professional Tax', 200]]);
    expect(by('Mrs Gupta').net).toBe(20000 - 2400 - 150 - 200);
    expect(by('Mrs Gupta').statutory.pf).toMatchObject({ wages: 15000, employee: 2400, employer: 1800, eps: 1249.5, epf: 550.5 });
    // the monthly statutory report, with the ids still missing for filing
    const rep = (await api().get(A(`/payroll/runs/${run._id}/statutory`)).set(W.h)).body;
    // four people: Mr Sharma, Kamla, the driver (same pay as Kamla) and Mrs Gupta
    expect(rep.totals).toMatchObject({ pfEmployee: 1800 + 1560 + 1560 + 2400, esiEmployee: 98 + 98 + 150, pt: 800 });
    expect(rep.pf).toHaveLength(4); expect(rep.esi.map((x) => x.name).sort()).toEqual(['Kamla Devi', 'Mrs Gupta', 'Ramesh Bhai']);
    expect(rep.missingIds.some((m) => m.name === 'Mr Sharma' && m.what.includes('UAN'))).toBe(true);
    expect(rep.missingIds.some((m) => m.name === 'Kamla Devi' && m.what.includes('ESI'))).toBe(false); // her ESI number was entered above
    await api().patch(A(`/teachers/${t1}`)).set(W.h).send({ statutory: { uan: '100200300400' } });
    const ecr = await api().get(A(`/payroll/runs/${run._id}/statutory/pf-ecr.txt`)).set(W.h);
    expect(ecr.status).toBe(200); expect(ecr.headers['content-type']).toContain('text/plain');
    expect(ecr.text.split('\n')).toHaveLength(1); // only people with a UAN can be in the file
    expect(ecr.text).toBe('100200300400#~#MR SHARMA#~#30000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0');
    expect((await api().get(A(`/payroll/runs/${run._id}/statutory/esi.csv`)).set(W.h)).text.split('\n')[0]).toBe('IP Number,IP Name,No of Days,Total Monthly Wages,Employee Contribution,Employer Contribution');
    expect((await api().get(A(`/payroll/runs/${run._id}/statutory/pt.csv`)).set(W.h)).text).toContain('Professional Tax');
    expect((await api().get(A(`/payroll/runs/${run._id}/statutory`)).set(W.teacher1.h)).status).toBe(403);
    expect((await api().get(`/api/transport/payroll/runs/${run._id}/statutory`).set(tr.h)).status).toBe(404); // the officer does not see pay
  });

  it('staff read their own payslips, and only theirs', async () => {
    const mine = (await api().get(STF('/payslips')).set(kLogin.h)).body;
    expect(mine.map((p) => p.month)).toEqual(['2026-10']); // 2026-09 is still a draft
    expect(mine[0]).toMatchObject({ personName: 'Kamla Devi', status: 'paid', net: 13000 });
    const pdf = await api().get(STF(`/payslips/${mine[0]._id}/pdf`)).set(kLogin.h);
    expect(pdf.status).toBe(200); expect(pdf.headers['content-type']).toContain('application/pdf');
    const all = (await api().get(A(`/payroll/runs/${W.run._id}`)).set(W.h)).body.payslips;
    const others = all.find((p) => p.personName === 'Mr Sharma');
    expect((await api().get(STF(`/payslips/${others._id}/pdf`)).set(kLogin.h)).status).toBe(404);
    expect((await api().get(STF('/salary')).set(kLogin.h)).body.current).toMatchObject({ levelName: 'Support Grade', basic: 13000 });
    expect((await api().get(STF('/my-attendance')).set(kLogin.h)).body).toHaveProperty('summary');
  });
});
