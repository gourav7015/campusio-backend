import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, makeFinance, login } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');
const MONTH = '2026-10';

let F;
describe('Staff portal, staff leave, check-in times, bank file and statutory deductions', () => {
  let root; let W; let tr; let kamla; let driver; let kLogin; let t1; let t2; let level;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'stp'); F = await makeFinance(W);
    t1 = W.t1.teacher._id; t2 = W.t2.teacher._id;
    // every day is a working day, so "today" is always open for check-in whenever this runs
    await api().put('/api/school/settings').set(W.h).send({ workingDays: [1, 2, 3, 4, 5, 6, 7] });
    const c = await api().post('/api/school/staff').set(W.h).send({ name: 'Tara Transport', email: 'tara@stp.test', role: 'transport', phone: '9833333333', dob: '1984-04-04' });
    tr = await login(c.body.loginId, c.body.temporaryPassword, 'transport');
    const des = [...(await api().get('/api/school/designations').set(W.h)).body, ...(await api().get('/api/transport/designations').set(tr.h)).body];
    const id = (n) => des.find((d) => d.name === n)._id;
    kamla = (await api().post('/api/school/support-staff').set(W.h).send({ name: 'Kamla Devi', designationId: id('Sweeper'), joiningDate: '2020-01-01', email: 'clerk@fixture.test', phone: '9833333333', dob: '1984-04-04' })).body;
    driver = (await api().post('/api/transport/staff').set(tr.h).send({ name: 'Ramesh Bhai', designationId: id('Driver'), joiningDate: '2020-01-01' })).body;
  });
  afterAll(teardown);
  const A = (p) => `/api/school${p}`;
  const FA = (p) => `/api/finance${p}`; // payroll is run from Finance
  const STF = (p) => `/api/staff${p}`;

  it('the Staff portal is the office desk: only staff given it have a login, and it is not a personal portal', async () => {
    expect((await api().post(A(`/support-staff/${driver._id}/login`)).set(W.h).send({})).status).toBe(404); // the driver is the officer's
    // a sweeper has no office duties, so no sign-in
    const no = await api().post(A(`/support-staff/${kamla._id}/login`)).set(W.h).send({});
    expect(no.status).toBe(400); expect(no.body.error).toMatch(/no office desk duties/);
    expect((await api().patch(A(`/support-staff/${kamla._id}`)).set(W.h).send({ canMarkAttendance: true })).status).toBe(200);
    const c = await api().post(A(`/support-staff/${kamla._id}/login`)).set(W.h).send({});
    expect(c.status).toBe(201); expect(c.body.loginId).toBe('stp.s0001'); expect(c.body.temporaryPassword).toBeTruthy();
    expect((await api().post(A(`/support-staff/${kamla._id}/login`)).set(W.h).send({})).status).toBe(409); // one login each
    expect((await api().post(`/api/transport/staff/${driver._id}/login`).set(tr.h).send({})).status).toBe(403); // transport crew have no sign-in
    expect((await api().post('/api/auth/login').send({ loginId: c.body.loginId, password: c.body.temporaryPassword, portal: 'teacher' })).status).toBe(401); // wrong door
    kLogin = await login(c.body.loginId, c.body.temporaryPassword, 'staff');
    expect(kLogin.user).toMatchObject({ role: 'staff', mustChangePassword: true, canMarkAttendance: true });
    expect((await api().get(STF('/profile')).set(kLogin.h)).body).toMatchObject({ name: 'Kamla Devi', staffId: 'S0001', designation: 'Sweeper' });
    // the desk cannot be switched off while the sign-in exists
    expect((await api().patch(A(`/support-staff/${kamla._id}`)).set(W.h).send({ canMarkAttendance: false })).status).toBe(409);
    // there is nothing personal in it: no check-in, own leave, payslips, salary or own attendance
    for (const url of ['/punch', '/my-attendance', '/payslips', '/salary']) expect((await api().get(STF(url)).set(kLogin.h)).status, url).toBe(404);
    expect((await api().post(STF('/punch/check-in')).set(kLogin.h).send({})).status).toBe(404);
    // and it reaches no other portal
    for (const url of ['/api/school/dashboard', '/api/teacher/dashboard', '/api/student/dashboard', '/api/finance/dashboard', '/api/transport/dashboard', '/api/school/staff-attendance/register?group=general']) expect((await api().get(url).set(kLogin.h)).status, url).toBe(403);
    expect((await api().get(STF('/profile')).set(W.teacher1.h)).status).toBe(403);
    // the list shows who has a login; a reset gives a new password and ends the old session
    expect((await api().get(A('/support-staff')).set(W.h)).body.items[0]).toMatchObject({ name: 'Kamla Devi', hasLogin: true });
    const reset_ = await api().post(A(`/support-staff/${kamla._id}/reset-password`)).set(W.h).send({});
    expect(reset_.body.temporaryPassword).toBeTruthy();
    expect((await api().get(STF('/profile')).set(kLogin.h)).status).toBe(401);
    kLogin = await login(c.body.loginId, reset_.body.temporaryPassword, 'staff');
  });

  it('the desk records leave for non-teaching staff (approved at once); balances are counted; the transport desk keeps its own', async () => {
    const eve = (await api().post(A('/support-staff')).set(W.h).send({ name: 'Eve Peon', designationId: (await api().get(A('/designations')).set(W.h)).body.find((d) => d.name === 'Peon')._id, joiningDate: '2020-01-01', email: 'clerk@fixture.test', phone: '9833333333', dob: '1984-04-04' })).body;
    const day = addDays(TODAY, 5);
    const bad = await api().post(STF('/leave')).set(kLogin.h).send({ staffId: eve._id, leaveType: 'casual', startDate: day, endDate: addDays(day, -1), reason: 'Backwards' });
    expect(bad.status).toBe(400);
    expect((await api().post(STF('/leave')).set(kLogin.h).send({ staffId: eve._id, leaveType: 'earned', startDate: day, endDate: day, reason: 'No allowance' })).status).toBe(409); // earned allowance is 0
    const l = await api().post(STF('/leave')).set(kLogin.h).send({ staffId: eve._id, leaveType: 'casual', startDate: day, endDate: addDays(day, 1), reason: 'Family function' });
    expect(l.status).toBe(201); expect(l.body).toMatchObject({ status: 'approved', days: 2, group: 'general' });
    expect((await api().post(STF('/leave')).set(kLogin.h).send({ staffId: eve._id, leaveType: 'sick', startDate: addDays(day, 1), endDate: addDays(day, 2), reason: 'Overlaps' })).status).toBe(409);
    // the desk cannot record leave for the transport crew; each desk sees its own group
    expect((await api().post(STF('/leave')).set(kLogin.h).send({ staffId: driver._id, leaveType: 'sick', startDate: day, endDate: day, reason: 'Not the desk\'s' })).status).toBe(403);
    expect((await api().get(STF('/leave?status=approved')).set(kLogin.h)).body.map((x) => x.staffId.name)).toEqual(['Eve Peon']);
    expect((await api().get('/api/transport/leave').set(tr.h)).body).toEqual([]);
    expect((await api().get(A('/leave-balances?group=general')).set(W.h)).body.rows.find((x) => x.name === 'Eve Peon').balances.casual).toMatchObject({ allowance: 12, used: 2, remaining: 10 });
    // the transport desk records leave for its crew
    const rec = await api().post('/api/transport/leave').set(tr.h).send({ staffId: driver._id, leaveType: 'sick', startDate: addDays(TODAY, -2), endDate: addDays(TODAY, -2), reason: 'Fever, informed by phone' });
    expect(rec.status).toBe(201); expect(rec.body).toMatchObject({ status: 'approved', group: 'transport', days: 1 });
    expect((await api().post('/api/transport/leave').set(tr.h).send({ staffId: kamla._id, leaveType: 'sick', startDate: addDays(TODAY, -2), endDate: addDays(TODAY, -2), reason: 'Not the officer\'s' })).status).toBe(403);
    const past = (await api().get(`/api/transport/attendance/register?group=transport&date=${addDays(TODAY, -2)}`).set(tr.h)).body;
    expect(past.rows[0]).toMatchObject({ name: 'Ramesh Bhai', status: 'leave', source: 'leave' });
    // the office desk dashboard says where things stand
    const dash = (await api().get(STF('/dashboard')).set(kLogin.h)).body;
    expect(dash).toMatchObject({ name: 'Kamla Devi', openQueries: 0 });
    expect(dash.registers.map((r) => r.group)).toEqual(['teachers', 'general', 'office']);
  });

  it('check-in times: teachers check in from their own portal; the desk enters or corrects the times of everyone else', async () => {
    // hours: shift starts 00:00 with no grace, so any check-in today is late; full day = 6h
    expect((await api().put(A('/settings')).set(W.h).send({ staffAttendance: { shiftStart: '00:00', shiftEnd: '23:59', graceMinutes: 0, fullDayHours: 6, halfDayHours: 3 } })).status).toBe(200);
    expect((await api().put(A('/settings')).set(W.h).send({ staffAttendance: { shiftStart: '25:00' } })).status).toBe(400);
    expect((await api().post('/api/teacher/punch/check-out').set(W.teacher1.h).send({})).status).toBe(409); // check in first
    const inn = await api().post('/api/teacher/punch/check-in').set(W.teacher1.h).send({});
    expect(inn.status).toBe(201);
    expect(inn.body.punch).toMatchObject({ source: 'self' }); expect(inn.body.punch.checkIn).toMatch(/^\d\d:\d\d$/);
    expect(inn.body.evaluation).toMatchObject({ late: true, suggested: 'late' });
    expect((await api().post('/api/teacher/punch/check-in').set(W.teacher1.h).send({})).status).toBe(409);
    const out = await api().post('/api/teacher/punch/check-out').set(W.teacher1.h).send({});
    expect(out.body.punch.checkOut).toMatch(/^\d\d:\d\d$/);
    expect(out.body.evaluation).toMatchObject({ hours: 0, suggested: 'half_day' }); // left the same minute: well under a full day
    expect((await api().post('/api/teacher/punch/check-out').set(W.teacher1.h).send({})).status).toBe(409);
    // the register shows the times and suggests the status the clock implies
    const reg = (await api().get(A(`/staff-attendance/register?group=teachers&date=${TODAY}`)).set(W.h)).body;
    expect(reg.rows.find((r) => r.name === 'Mr Sharma')).toMatchObject({ status: 'half_day', source: 'times', punchSource: 'self' });
    // the desk can overrule the suggestion and fix the times; the office desk does the same from the Staff portal
    const sub = await api().put(A('/staff-attendance/register')).set(W.h).send({ group: 'general', date: TODAY, submit: true, entries: [{ personId: kamla._id, status: 'present', checkIn: '08:05', checkOut: '15:00' }] });
    expect(sub.body.rows.find((r) => r.name === 'Kamla Devi')).toMatchObject({ status: 'present', checkIn: '08:05', checkOut: '15:00', hours: 6.9 });
    expect((await api().put(A('/staff-attendance/register')).set(W.h).send({ group: 'general', date: addDays(TODAY, -1), entries: [{ personId: kamla._id, status: 'present', checkIn: '25:00' }] })).status).toBe(400);
    expect((await api().put(A('/staff-attendance/register')).set(W.h).send({ group: 'general', date: addDays(TODAY, -1), entries: [{ personId: kamla._id, status: 'present', checkIn: '09:00', checkOut: '08:00' }] })).status).toBe(400);
    expect((await api().get(STF(`/attendance-desk/register?group=teachers&date=${TODAY}`)).set(kLogin.h)).status).toBe(200);
    expect((await api().get(STF(`/attendance-desk/register?group=transport&date=${TODAY}`)).set(kLogin.h)).status).toBe(403); // never the transport crew
    // location fence: only within 200 m of the school
    await api().put(A('/settings')).set(W.h).send({ staffAttendance: { location: { lat: 22.3039, lng: 70.8022, radiusMeters: 200 } } });
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
    expect(reg.rows.find((r) => r.name === 'Kamla Devi')).toMatchObject({ checkIn: '07:58', checkOut: '15:12', punchSource: 'import', hours: 7.2 });
    expect((await api().get(A(`/staff-attendance/register?group=general&date=${d2}`)).set(W.h)).body.rows.find((r) => r.name === 'Kamla Devi')).toMatchObject({ checkIn: '08:40', checkOut: null, source: 'times' }); // a single punch is a check-in only; 08:40 is late for an 08:00 shift? (shift here is 00:00)
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
    level = (await api().post(FA('/payroll/levels')).set(F.h).send({ name: 'Support Grade', appliesTo: 'non_teaching', basic: 13000, allowances: [], deductions: [] })).body;
    const prt = (await api().post(FA('/payroll/levels')).set(F.h).send({ name: 'Senior', basic: 30000, allowances: [], deductions: [] })).body;
    const gupta = (await api().post(FA('/payroll/levels')).set(F.h).send({ name: 'Junior', basic: 20000, allowances: [], deductions: [{ label: 'Provident Fund', kind: 'percent', value: 12 }] })).body;
    await api().post(FA('/payroll/salaries/bulk')).set(F.h).send({ levelId: level._id, personIds: [kamla._id, driver._id], effectiveFrom: '2026-04-01' });
    await api().post(FA(`/payroll/salaries/${t1}`)).set(F.h).send({ levelId: prt._id, effectiveFrom: '2026-04-01' });
    await api().post(FA(`/payroll/salaries/${t2}`)).set(F.h).send({ levelId: gupta._id, effectiveFrom: '2026-04-01' });
    const run = (await api().post(FA('/payroll/runs')).set(F.h).send({ month: MONTH })).body;
    W.run = run;
    expect((await api().get(FA(`/payroll/runs/${run._id}/bank-file`)).set(F.h)).status).toBe(409); // approve first
    await api().post(A(`/payroll/runs/${run._id}/approve`)).set(W.h);
    const f = (await api().get(FA(`/payroll/runs/${run._id}/bank-file`)).set(F.h)).body;
    expect(f).toMatchObject({ month: MONTH, count: 1, total: 13000 });
    expect(f.ready[0]).toMatchObject({ name: 'Kamla Devi', accountNo: '123456789012', ifsc: 'HDFC0001234', amount: 13000, narration: 'Salary 2026-10' });
    expect(f.missing.map((m) => [m.name, m.reason]).sort()).toEqual([['Mr Sharma', 'No bank account on record'], ['Mrs Gupta', 'No bank account on record'], ['Ramesh Bhai', 'No bank account on record']]);
    const csv = await api().get(FA(`/payroll/runs/${run._id}/bank-file.csv`)).set(F.h);
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')[0]).toBe('Beneficiary Name,Account Number,IFSC,Amount,Payment Mode,Narration,Reference,Employee Id,Bank');
    expect(csv.text).toContain('Kamla Devi,123456789012,HDFC0001234,13000,NEFT,Salary 2026-10');
    expect((await api().get(FA(`/payroll/runs/${run._id}/bank-file.csv`)).set(W.teacher1.h)).status).toBe(403);
    // once paid, the person is no longer in the file
    await api().post(FA(`/payroll/runs/${run._id}/pay`)).set(F.h).send({ mode: 'bank_transfer', payslipIds: [f.ready[0].payslipId] });
    expect((await api().get(FA(`/payroll/runs/${run._id}/bank-file`)).set(F.h)).body.count).toBe(0);
  });

  it('PF, ESI and Professional Tax follow the school\'s own policy; nothing is deducted twice; reports and files come out per month', async () => {
    // statutory deductions are OFF until a school switches them on: the October run above has none
    const before = (await api().get(FA(`/payroll/runs/${W.run._id}`)).set(F.h)).body.payslips;
    expect(before.find((p) => p.personName === 'Kamla Devi')).toMatchObject({ gross: 13000, net: 13000, totalDeductions: 0 });
    expect((await api().put(A('/settings')).set(W.h).send({ statutory: { pf: { enabled: true }, esi: { enabled: true }, pt: { enabled: true, slabs: [{ upTo: 12000, amount: 0 }, { upTo: 1000000000, amount: 200 }] } } })).status).toBe(200);
    expect((await api().put(A('/settings')).set(W.h).send({ statutory: { pf: { employeeRate: 99 } } })).status).toBe(400);
    // a new month, so nothing is locked: 2026-09
    const run = (await api().post(FA('/payroll/runs')).set(F.h).send({ month: '2026-09' })).body;
    const { payslips } = (await api().get(FA(`/payroll/runs/${run._id}`)).set(F.h)).body;
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
    const rep = (await api().get(FA(`/payroll/runs/${run._id}/statutory`)).set(F.h)).body;
    // four people: Mr Sharma, Kamla, the driver (same pay as Kamla) and Mrs Gupta
    expect(rep.totals).toMatchObject({ pfEmployee: 1800 + 1560 + 1560 + 2400, esiEmployee: 98 + 98 + 150, pt: 800 });
    expect(rep.pf).toHaveLength(4); expect(rep.esi.map((x) => x.name).sort()).toEqual(['Kamla Devi', 'Mrs Gupta', 'Ramesh Bhai']);
    expect(rep.missingIds.some((m) => m.name === 'Mr Sharma' && m.what.includes('UAN'))).toBe(true);
    expect(rep.missingIds.some((m) => m.name === 'Kamla Devi' && m.what.includes('ESI'))).toBe(false); // her ESI number was entered above
    await api().patch(A(`/teachers/${t1}`)).set(W.h).send({ statutory: { uan: '100200300400' } });
    const ecr = await api().get(FA(`/payroll/runs/${run._id}/statutory/pf-ecr.txt`)).set(F.h);
    expect(ecr.status).toBe(200); expect(ecr.headers['content-type']).toContain('text/plain');
    expect(ecr.text.split('\n')).toHaveLength(1); // only people with a UAN can be in the file
    expect(ecr.text).toBe('100200300400#~#MR SHARMA#~#30000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0');
    expect((await api().get(FA(`/payroll/runs/${run._id}/statutory/esi.csv`)).set(F.h)).text.split('\n')[0]).toBe('IP Number,IP Name,No of Days,Total Monthly Wages,Employee Contribution,Employer Contribution');
    expect((await api().get(FA(`/payroll/runs/${run._id}/statutory/pt.csv`)).set(F.h)).text).toContain('Professional Tax');
    expect((await api().get(FA(`/payroll/runs/${run._id}/statutory`)).set(W.teacher1.h)).status).toBe(403);
    expect((await api().get(`/api/transport/payroll/runs/${run._id}/statutory`).set(tr.h)).status).toBe(404); // the officer does not see pay
  });

  it('payslips are given out by the office: nobody on the staff side has a personal payslip page', async () => {
    const all = (await api().get(FA(`/payroll/runs/${W.run._id}`)).set(F.h)).body.payslips;
    expect(all.find((p) => p.personName === 'Kamla Devi')).toMatchObject({ status: 'paid', net: 13000 });
    expect((await api().get(STF('/payslips')).set(kLogin.h)).status).toBe(404);
    // the admin can still print any payslip
    const one = all.find((p) => p.personName === 'Kamla Devi');
    expect((await api().get(FA(`/payroll/payslips/${one._id}/pdf`)).set(F.h)).status).toBe(200);
  });
});
