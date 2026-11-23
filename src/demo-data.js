/**
 * Builds a realistic demo school purely through the public HTTP API (so it exercises the real rules).
 * Used by `npm run demo` and by the browser tests. Never used in production.
 */
import { User } from './models/index.js';
import { hashPassword } from './services/users.js';
import { todayStr, addDays, isoDay } from './core/utils.js';

let seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

export const DEMO = {
  superAdmin: { loginId: 'superadmin@erp.local', password: 'Super@12345' },
  admin: { loginId: 'admin@gps.test', password: 'Admin@12345' },
  finance: { loginId: 'finance@gps.test', password: 'Finance@12345' },
  library: { loginId: 'library@gps.test', password: 'Library@12345' },
  transport: { loginId: 'transport@gps.test', password: 'Transport@12345' },
  staff: { loginId: 'gps.s0001', password: 'Staff@12345' },
  teacherPassword: 'Teach@12345', studentPassword: 'Student@12345',
};

export async function buildDemo(base) {
  const call = async (method, path, token, body, extra = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const login = async (loginId, password, portal) => (await call('POST', '/api/auth/login', null, { loginId, password, portal })).token;

  await User.create({ role: 'super_admin', loginId: DEMO.superAdmin.loginId, name: 'Platform Admin', passwordHash: await hashPassword(DEMO.superAdmin.password), mustChangePassword: false });
  const root = await login(DEMO.superAdmin.loginId, DEMO.superAdmin.password, 'platform');

  const created = await call('POST', '/api/platform/schools', root, {
    name: 'Greenfield Public School', code: 'gps', board: 'CBSE', address: '12 Park Road, Pune', phone: '020 5550 1234',
    subscription: { plan: 'standard', status: 'active' }, admin: { name: 'Anita Deshmukh', email: DEMO.admin.loginId, phone: '9811000001', dob: '1978-03-15' },
  });
  const keep = async (userId, pw) => User.updateOne({ _id: userId }, { passwordHash: await hashPassword(pw), mustChangePassword: false });
  await keep(created.admin.id, DEMO.admin.password);
  const A = await login(DEMO.admin.loginId, DEMO.admin.password, 'admin');
  const admin = (m, p, b) => call(m, `/api/school${p}`, A, b);

  const today = todayStr('Asia/Kolkata');
  const year = await admin('POST', '/years', { name: '2026-2027', startDate: '2026-04-01', endDate: '2027-03-31' });
  const classes = {};
  for (const n of [6, 7, 8]) classes[n] = await admin('POST', '/classes', { name: `Class ${n}` });
  const sec = {};
  for (const [n, names] of [[8, ['A', 'B']], [7, ['A']], [6, ['A']]]) for (const s of names) sec[`${n}${s}`] = await admin('POST', '/sections', { yearId: year._id, classId: classes[n]._id, name: s, capacity: 40, room: `${n}${s === 'A' ? '01' : '02'}` });

  // teachers: subjects are created through them (there is no separate subject list)
  const teacherDefs = [['Rajesh Sharma', 'T001', 'sharma@gps.test', 'MATH', 'Mathematics'], ['Meera Gupta', 'T002', 'gupta@gps.test', 'ENG', 'English'], ['Anil Verma', 'T003', 'verma@gps.test', 'SCI', 'Science'], ['Sunita Singh', 'T004', 'singh@gps.test', 'HIN', 'Hindi'], ['Imran Khan', 'T005', 'khan@gps.test', 'SST', 'Social Studies'], ['Priya Rao', 'T006', 'rao@gps.test', 'CS', 'Computer Science']];
  const T = {};
  for (const [name, employeeId, email, code, subject] of teacherDefs) {
    const RANK = { MATH: 'PGT', ENG: 'TGT', SCI: 'PGT', HIN: 'TGT', SST: 'TGT', CS: 'Head of Department' }; // only the ranks the school has registered
    const t = await admin('POST', '/teachers', { name, employeeId, email, designation: RANK[code] || 'TGT', subjects: [subject], phone: `98765432${employeeId.slice(-2)}`, dob: `198${employeeId.slice(-1)}-05-12` });
    await keep(t.teacher.userId, DEMO.teacherPassword);
    T[code] = { ...t.teacher, subject, token: await login(email, DEMO.teacherPassword, 'teacher') };
  }
  const asg = {};
  for (const secKey of ['8A', '8B', '7A', '6A']) for (const [, , , code, subject] of teacherDefs) asg[`${secKey}${code}`] = await admin('POST', '/teaching-assignments', { teacherId: T[code]._id, sectionId: sec[secKey]._id, subject, weeklyPeriods: code === 'MATH' ? 6 : 4, effectiveFrom: '2026-04-01' });
  // the school names its own houses; students and teachers are placed in them below
  for (const [name, color, motto] of [['Aravali', '#dc2626', 'Strong as the hills'], ['Nilgiri', '#2563eb', 'Rise above'], ['Himalaya', '#16a34a', 'Reach the summit'], ['Vindhya', '#eab308', 'Courage always']]) await admin('POST', '/houses', { name, color, motto });
  const subj = Object.fromEntries((await admin('GET', '/subjects')).map((s) => [s.name, s]));
  await admin('PUT', `/sections/${sec['8A']._id}/class-teacher`, { teacherId: T.MATH._id, effectiveFrom: '2026-04-01' });
  await admin('PUT', `/sections/${sec['8B']._id}/class-teacher`, { teacherId: T.ENG._id, effectiveFrom: '2026-04-01' });
  await admin('PUT', `/sections/${sec['7A']._id}/class-teacher`, { teacherId: T.SCI._id, effectiveFrom: '2026-04-01' });
  await admin('PUT', `/sections/${sec['6A']._id}/class-teacher`, { teacherId: T.HIN._id, effectiveFrom: '2026-04-01' });

  // periods + timetable (rotating subjects so no teacher/room clashes)
  const times = [['08:00', '08:40'], ['08:40', '09:20'], ['09:20', '10:00'], ['10:20', '11:00'], ['11:00', '11:40'], ['11:40', '12:20']];
  const periods = [];
  for (let i = 0; i < times.length; i++) {
    if (i === 3) await admin('POST', '/timetable/periods', { name: 'Break', order: 4, startTime: '10:00', endTime: '10:20', type: 'break' });
    periods.push(await admin('POST', '/timetable/periods', { name: `Period ${i + 1}`, order: i < 3 ? i + 1 : i + 2, startTime: times[i][0], endTime: times[i][1] }));
  }
  const codes = teacherDefs.map((d) => d[3]);
  const secKeys = ['8A', '8B', '7A', '6A'];
  for (let day = 1; day <= 6; day++) for (let p = 0; p < 6; p++) for (let si = 0; si < secKeys.length; si++) {
    const code = codes[(p + si + day) % 6];
    await admin('POST', '/timetable/entries', { sectionId: sec[secKeys[si]]._id, day, periodId: periods[p]._id, assignmentId: asg[`${secKeys[si]}${code}`]._id });
  }

  // staff for the fee desk and the library (created by the School Admin)
  const fin = await admin('POST', '/staff', { name: 'Farah Accounts', email: DEMO.finance.loginId, role: 'finance', phone: '9811000002', dob: '1985-02-02' });
  const lib = await admin('POST', '/staff', { name: 'Lakshmi Librarian', email: DEMO.library.loginId, role: 'library', phone: '9811000003', dob: '1986-03-03' });
  const trn = await admin('POST', '/staff', { name: 'Tarun Transport', email: DEMO.transport.loginId, role: 'transport', phone: '9811000004', dob: '1984-04-04' });
  await keep(fin.id, DEMO.finance.password); await keep(lib.id, DEMO.library.password); await keep(trn.id, DEMO.transport.password);
  const F = await login(DEMO.finance.loginId, DEMO.finance.password, 'finance');
  const LB = await login(DEMO.library.loginId, DEMO.library.password, 'library');
  const finance = (m, p, b) => call(m, `/api/finance${p}`, F, b);
  const library = (m, p, b) => call(m, `/api/library${p}`, LB, b);
  const TR = await login(DEMO.transport.loginId, DEMO.transport.password, 'transport');
  const transport = (m, p, b) => call(m, `/api/transport${p}`, TR, b);
  // fee structures exist BEFORE admissions so that new students are billed automatically
  const due = (offset) => addDays(today, offset);
  for (const n of [6, 7, 8]) {
    await finance('POST', '/structures', { classId: classes[n]._id, name: `Class ${n} Fee`, autoAssign: true, admissionFee: 4000 + n * 100, monthlyFee: 1100 + n * 50, dueDay: 10 });
  }

  // students (auto-billed on admission)
  const first = ['Aarav', 'Vihaan', 'Aditya', 'Arjun', 'Sai', 'Ishaan', 'Krish', 'Rohan', 'Kabir', 'Dev', 'Rahul', 'Neil', 'Yash', 'Atharv', 'Ananya', 'Diya', 'Isha', 'Kavya', 'Meera', 'Nisha', 'Pooja', 'Riya', 'Saanvi', 'Tanvi', 'Zoya', 'Avni', 'Myra', 'Aadhya', 'Sara', 'Navya', 'Ira', 'Anvi', 'Kiara', 'Tara', 'Veda', 'Jiya', 'Mihir', 'Om', 'Parth', 'Reyansh'];
  const last = ['Sharma', 'Patel', 'Singh', 'Kumar', 'Mehta', 'Joshi', 'Nair', 'Reddy', 'Iyer', 'Gupta', 'Khan', 'Das', 'Rao', 'Kulkarni', 'Desai', 'Jain'];
  const students = []; let n = 0;
  for (const [key, count, cls] of [['8A', 14, 8], ['8B', 10, 8], ['7A', 6, 7], ['6A', 4, 6]]) for (let i = 0; i < count; i++) {
    const name = `${first[n % first.length]} ${last[(n * 7 + i) % last.length]}`;
    const dob = `${2026 - cls - 5}-${String((n % 12) + 1).padStart(2, '0')}-${String((n % 27) + 1).padStart(2, '0')}`;
    const out = await admin('POST', '/students', { name, dob, gender: n % 2 ? 'female' : 'male', sectionId: sec[key]._id, admissionDate: '2026-04-10', phone: `90000000${String(n).padStart(2, '0')}`,
      guardians: [{ name: `${last[(n * 7 + i) % last.length]} (Parent)`, relationship: n % 2 ? 'Father' : 'Mother', phone: `98200000${String(n).padStart(2, '0')}`, email: `parent${n}@gps.test`, isPrimary: true }], confirmDuplicate: true });
    await keep(out.student.userId, DEMO.studentPassword);
    students.push({ key, ...out.student, loginId: out.credentials.loginId });
    n++;
  }
  await admin('POST', '/houses/distribute'); // every student and teacher into one of the school's houses, evenly
  const rahul = students.find((s) => s.key === '8A');

  // fees: most students paid the admission fee and the first two months in cash/UPI, a few are overdue, one has a concession
  const modes = ['cash', 'upi', 'cheque', 'bank_transfer'];
  for (const [i, s] of students.entries()) {
    if (i % 5 === 4) continue; // every fifth student has paid nothing: overdue
    const acct = await finance('GET', `/students/${s._id}/account`);
    const first = acct.charges.slice(0, 3); // April tuition, the admission fee, May tuition
    await finance('POST', '/payments', { studentId: s._id, amount: first.reduce((n, c) => n + c.outstanding, 0), mode: modes[i % 4], reference: i % 4 === 1 ? `UPI${100000 + i}` : undefined, paidOn: due(-35 + (i % 20)) });
  }
  const conc = await finance('GET', `/students/${students[1]._id}/account`);
  const stillOpen = conc.charges.find((c) => c.status === 'open'); // the next unpaid month
  await finance('POST', `/charges/${stillOpen._id}/concession`, { amount: Math.min(500, stillOpen.outstanding), reason: 'Sibling discount' });

  // library: catalogue + a few loans (one overdue)
  const books = [['Wings of Fire', 'A. P. J. Abdul Kalam', 'Biography', 250, 3], ['Malgudi Days', 'R. K. Narayan', 'Fiction', 180, 2], ['The Story of My Experiments with Truth', 'M. K. Gandhi', 'Biography', 220, 2], ['A Brief History of Time', 'Stephen Hawking', 'Science', 399, 2], ['Panchatantra', 'Vishnu Sharma', 'Fiction', 150, 4], ['Oxford Dictionary', 'Oxford Press', 'Reference', 520, 1], ['Discovery of India', 'Jawaharlal Nehru', 'History', 310, 2], ['Gitanjali', 'Rabindranath Tagore', 'Poetry', 140, 2]];
  const accessions = [];
  for (const [title, author, category, price, copies] of books) accessions.push((await library('POST', '/books', { title, author, category, price, copies, shelf: `${category[0]}-${(accessions.length % 4) + 1}` })).accessionNos);
  await library('POST', '/issue', { accessionNo: accessions[0][0], borrowerType: 'student', borrowerId: rahul._id });
  await library('POST', '/issue', { accessionNo: accessions[4][0], borrowerType: 'student', borrowerId: students[1]._id });
  await library('POST', '/issue', { accessionNo: accessions[3][0], borrowerType: 'teacher', borrowerId: T.SCI._id });
  const late = await library('POST', '/issue', { accessionNo: accessions[1][0], borrowerType: 'student', borrowerId: students[2]._id });
  const { LibraryIssue } = await import('./models/index.js');
  await LibraryIssue.updateOne({ _id: late.issue._id }, { dueDate: addDays(today, -6), issuedOn: addDays(today, -20) });

  // attendance for the last ~25 days for 8A, 8B (class teachers only)
  const holidayDay = addDays(today, -9);
  const holiday = isoDay(holidayDay) === 7 ? addDays(holidayDay, -1) : holidayDay;
  await admin('POST', '/events', { title: 'Founders Day', type: 'holiday', startDate: holiday });
  for (let back = 1; back <= 25; back++) {
    const d = addDays(today, -back);
    if (isoDay(d) === 7 || d === holiday) continue;
    for (const [key, token] of [['8A', T.MATH.token], ['8B', T.ENG.token]]) {
      const reg = await call('GET', `/api/teacher/attendance/register?sectionId=${sec[key]._id}&date=${d}`, token);
      if (reg.blocked) continue;
      const entries = reg.students.map((s) => { const r = rnd(); return { studentId: s.studentId, status: r < 0.06 ? 'absent' : r < 0.1 ? 'late' : r < 0.12 ? 'leave' : 'present' }; });
      await call('POST', '/api/teacher/attendance/register/submit', token, { sectionId: sec[key]._id, date: d, entries });
    }
  }

  // homework + materials
  const hwDefs = [['Exercise 4 – Algebra', 'MATH', 2], ['Chapter 6 questions', 'SCI', 3], ['Essay: My Favourite Season', 'ENG', 4], ['Hindi vyakaran worksheet', 'HIN', -2], ['Map work', 'SST', 5]];
  for (const [title, code, dueOffset] of hwDefs) await call('POST', '/api/teacher/homework', T[code].token, { title, description: 'Complete in your notebook and keep it ready for review.', instructions: 'Show all working.', sectionId: sec['8A']._id, subjectId: subj[T[code].subject]._id, dueDate: addDays(today, dueOffset), assignedDate: addDays(today, -5), type: 'written', status: 'published' }).catch(() => null);
  await call('POST', '/api/teacher/homework', T.MATH.token, { title: 'Chapter 5 revision (draft)', sectionId: sec['8A']._id, subjectId: subj.Mathematics._id, dueDate: addDays(today, 9), status: 'draft' });
  for (const [title, code, chapter, type, url] of [['Algebra revision video', 'MATH', 'Chapter 4 – Algebra', 'video', 'https://example.com/algebra'], ['Photosynthesis explained', 'SCI', 'Chapter 6 – Plants', 'video', 'https://example.com/photosynthesis'], ['Grammar cheat-sheet', 'ENG', 'Grammar', 'document', 'https://example.com/grammar']]) {
    await call('POST', '/api/teacher/materials', T[code].token, { title, chapter, sectionId: sec['8A']._id, subjectId: subj[T[code].subject]._id, materialType: type, externalUrl: url, status: 'published' });
  }

  // Unit Test 1: custom mark fields per subject, entered by teachers, approved and published
  const ut1 = await admin('POST', '/exams', { name: 'Unit Test 1', type: 'unit_test', classIds: [classes[8]._id], startDate: addDays(today, -20), endDate: addDays(today, -15), marksDeadline: addDays(today, -10) });
  await admin('POST', `/exams/${ut1._id}/subjects/generate`);
  const fieldsFor = { Mathematics: [{ label: 'Written', max: 80 }, { label: 'Practical', max: 20 }], Science: [{ label: 'Written', max: 70 }, { label: 'Lab', max: 20 }, { label: 'Assignment', max: 10 }], English: [{ label: 'Written', max: 80 }, { label: 'Oral', max: 20 }], 'Computer Science': [{ label: 'Theory', max: 50 }, { label: 'Practical', max: 50 }] };
  const ut1Detail = await admin('GET', `/exams/${ut1._id}`);
  let cursor = addDays(today, -20);
  for (const es of ut1Detail.subjects) {
    while (isoDay(cursor) === 7) cursor = addDays(cursor, 1);
    await admin('PUT', `/exams/${ut1._id}/subjects`, { classId: es.classId, subjectId: es.subjectId, date: cursor, startTime: '10:00', endTime: '12:00', room: '8-Hall', ...(fieldsFor[es.subject] ? { components: fieldsFor[es.subject] } : {}) });
    cursor = addDays(cursor, 1);
  }
  await admin('POST', `/exams/${ut1._id}/publish-schedule`);
  const tokenOfSubject = (name) => Object.values(T).find((t) => t.subject === name).token;
  for (const es of ut1Detail.subjects) for (const key of ['8A', '8B']) {
    const token = tokenOfSubject(es.subject);
    const sheet = await call('GET', `/api/teacher/marks/sheet?examSubjectId=${es._id}&sectionId=${sec[key]._id}`, token);
    const marks = sheet.students.map((s) => {
      if (rnd() < 0.03) return { studentId: s.studentId, absent: true };
      const q = 0.45 + rnd() * 0.5;
      return { studentId: s.studentId, values: Object.fromEntries(sheet.examSubject.components.map((c) => [c.key, Math.round(c.max * Math.min(1, q + (rnd() - 0.5) * 0.15))])) };
    });
    await call('PUT', '/api/teacher/marks/sheet', token, { examSubjectId: es._id, sectionId: sec[key]._id, marks });
    await call('POST', '/api/teacher/marks/sheet/submit', token, { examSubjectId: es._id, sectionId: sec[key]._id });
  }
  for (const s of await admin('GET', `/exams/${ut1._id}/sheets`)) await admin('POST', `/sheets/${s._id}/approve`);
  await admin('POST', `/exams/${ut1._id}/publish`, { all: true });

  // a class test created by the class teacher (scored out of 20), published so the class sees ranks
  const ct = await call('POST', '/api/teacher/exams', T.MATH.token, { name: 'Class Test 1', type: 'class_test', sectionId: sec['8A']._id, subjectId: subj.Mathematics._id, date: addDays(today, -8), components: [{ label: 'Score', max: 20 }], marksDeadline: addDays(today, -5) });
  const ctEs = ct.examSubject._id;
  const ctSheet = await call('GET', `/api/teacher/marks/sheet?examSubjectId=${ctEs}&sectionId=${sec['8A']._id}`, T.MATH.token);
  await call('PUT', '/api/teacher/marks/sheet', T.MATH.token, { examSubjectId: ctEs, sectionId: sec['8A']._id, marks: ctSheet.students.map((s, i) => (i === 3 ? { studentId: s.studentId, absent: true } : { studentId: s.studentId, values: { score: 8 + Math.round(rnd() * 12) } })) });
  await call('POST', '/api/teacher/marks/sheet/submit', T.MATH.token, { examSubjectId: ctEs, sectionId: sec['8A']._id });
  for (const s of await admin('GET', `/exams/${ct.exam._id}/sheets`)) await admin('POST', `/sheets/${s._id}/approve`);
  await admin('POST', `/exams/${ct.exam._id}/publish`, { all: true });

  // Unit Test 2: scheduled for the coming days
  const ut2 = await admin('POST', '/exams', { name: 'Unit Test 2', type: 'unit_test', classIds: [classes[8]._id], startDate: addDays(today, 6), endDate: addDays(today, 11), marksDeadline: addDays(today, 16) });
  await admin('POST', `/exams/${ut2._id}/subjects/generate`);
  cursor = addDays(today, 6);
  for (const es of (await admin('GET', `/exams/${ut2._id}`)).subjects) {
    while (isoDay(cursor) === 7) cursor = addDays(cursor, 1);
    await admin('PUT', `/exams/${ut2._id}/subjects`, { classId: es.classId, subjectId: es.subjectId, date: cursor, startTime: '10:00', endTime: '12:00', room: '204', ...(fieldsFor[es.subject] ? { components: fieldsFor[es.subject] } : {}) });
    cursor = addDays(cursor, 1);
  }
  await admin('POST', `/exams/${ut2._id}/publish-schedule`);

  // communication + leave
  await admin('POST', '/announcements', { title: 'Annual Sports Day', category: 'event', body: 'Annual Sports Day will be held on the school ground. Wear your house T-shirt.', audience: { all: true } });
  await admin('POST', '/announcements', { title: 'Class 8-A: Science project submission', category: 'homework', body: 'Please submit your project models by Friday.', audience: { all: false, roles: [], sectionIds: [sec['8A']._id] } });
  await admin('POST', '/events', { title: 'Parent–Teacher Meeting', type: 'ptm', startDate: addDays(today, 12) });
  await admin('POST', '/events', { title: 'Diwali Break', type: 'holiday', startDate: addDays(today, 20), endDate: addDays(today, 24) });
  let leaveStart = addDays(today, 8); while (isoDay(leaveStart) === 7) leaveStart = addDays(leaveStart, 1);
  await call('POST', '/api/teacher/leave', T.SCI.token, { leaveType: 'casual', startDate: leaveStart, endDate: leaveStart, reason: 'Family function' });
  await call('POST', '/api/teacher/messages', T.MATH.token, { subject: 'Projector in Room 801', body: 'The projector in room 801 is not working. Please arrange a repair.' });

  // non-teaching staff and one bus with its crew and two riders (the Transport officer does the transport part)
  const des = Object.fromEntries([...(await admin('GET', '/designations')), ...(await transport('GET', '/designations'))].map((d) => [d.name, d._id])); // general titles come from the admin, transport titles from the officer
  const generalStaff = [];
  // the office clerk works for the office desk (Staff portal): the only staff member with a sign-in. Everyone else is on the books and on payroll, and is looked after by the desk.
  generalStaff.push(await admin('POST', '/support-staff', { name: 'Neha Shah', designationId: des['Office Clerk'], phone: '9000011000', email: 'neha.shah@gps.test', dob: '1990-07-07', joiningDate: '2021-04-01', canMarkAttendance: true }));
  const kLogin = await admin('POST', `/support-staff/${generalStaff[0]._id}/login`);
  await keep((await User.findOne({ loginId: kLogin.loginId }))._id, DEMO.staff.password);
  for (const [name, d, phone] of [['Kamla Devi', 'Sweeper', '9000011001'], ['Ramu Kaka', 'Gardener', '9000011002'], ['Savita Ben', 'Maid', '9000011003'], ['Bhola Singh', 'Security Guard', '9000011004'], ['Vikram Chauhan', 'PT Teacher', '9000011005'], ['Kiran Joshi', 'Lab Assistant', '9000011006'], ['Mukesh Parmar', 'Accountant', '9000011007'], ['Dr. Anjali Mehta', 'School Counsellor', '9000011008']]) generalStaff.push(await admin('POST', '/support-staff', { name, designationId: des[d], phone, joiningDate: '2022-06-01' }));
  const kamla = generalStaff.find((s) => s.name === 'Kamla Devi');
  // a bank account and an ESI number on record for the first sweeper
  await admin('PATCH', `/support-staff/${kamla._id}`, { bank: { accountName: 'Kamla Devi', accountNo: '123456789012', ifsc: 'SBIN0001234', bankName: 'State Bank of India' }, statutory: { esiNo: '1234567890' } });
  // a teacher asks the office about her attendance
  await call('POST', '/api/teacher/queries', T.SCI.token, { subject: 'My attendance on Monday', body: 'I was at school the whole day but I am marked half day. Please check.', category: 'general' });
  const drv = await transport('POST', '/staff', { name: 'Harish Driver', designationId: des.Driver, phone: '9000022001', licenseNo: 'GJ0320180007', licenseExpiry: addDays(today, 400), joiningDate: '2019-04-01' });
  const cnd = await transport('POST', '/staff', { name: 'Mahesh Conductor', designationId: des.Conductor, phone: '9000022002', joiningDate: '2021-06-15' });
  const bus = await transport('POST', '/buses', { busNo: 'GPS-01', registrationNo: 'GJ03AB4321', vehicleModel: 'Tata Starbus 40-seater', capacity: 40, routeName: 'Route 1 — University Road', startTime: '06:50', endTime: '08:05',
    stops: [{ name: 'University Road', pickupTime: '07:05', dropTime: '14:30' }, { name: 'Kalawad Circle', pickupTime: '07:20', dropTime: '14:15' }], driverId: drv._id, conductorId: cnd._id, insuranceExpiry: addDays(today, 200), fitnessExpiry: addDays(today, 150), pollutionExpiry: addDays(today, 90) });
  const riders = students.filter((s) => s.key === '8B').slice(0, 2);
  await transport('POST', '/assign', { busId: bus._id, studentIds: riders.map((s) => s._id), stop: 'Kalawad Circle' });

  // daily staff registers for the last few working days: the admin marks teachers and general staff, the officer marks the transport crew
  const regDays = []; for (let b = 1; regDays.length < 6 && b < 14; b++) { const d = addDays(today, -b); if (isoDay(d) !== 7) regDays.push(d); }
  for (const [k, date] of regDays.entries()) {
    await admin('PUT', '/staff-attendance/register', { group: 'teachers', date, submit: true, entries: k === 1 ? [{ personId: T.SCI._id, status: 'absent', remark: 'Fever' }] : k === 3 ? [{ personId: T.ENG._id, status: 'half_day' }] : [] });
    await admin('PUT', '/staff-attendance/register', { group: 'general', date, submit: true, entries: k === 2 ? [{ personId: kamla._id, status: 'absent' }] : [] });
    await transport('PUT', '/attendance/register', { group: 'transport', date, submit: true, entries: k === 4 ? [{ personId: cnd._id, status: 'late', remark: 'Bus breakdown' }] : [] });
  }

  // payroll: pay levels, everyone's salary, and last month's payroll approved and paid
  const prt = await admin('POST', '/payroll/levels', { name: 'PRT', description: 'Primary Teacher', basic: 28000, allowances: [{ label: 'HRA', kind: 'percent', value: 40 }, { label: 'Transport', kind: 'fixed', value: 2000 }], deductions: [{ label: 'Provident Fund', kind: 'percent', value: 12 }] });
  await admin('POST', '/payroll/levels', { name: 'TGT', description: 'Trained Graduate Teacher', basic: 38000, allowances: [{ label: 'HRA', kind: 'percent', value: 40 }, { label: 'Transport', kind: 'fixed', value: 2500 }], deductions: [{ label: 'Provident Fund', kind: 'percent', value: 12 }] });
  await admin('POST', '/payroll/salaries/bulk', { levelId: prt._id, personIds: Object.values(T).map((t) => t._id), effectiveFrom: '2026-04-01', reason: 'Initial salary setup' });
  const supportLevel = await admin('POST', '/payroll/levels', { name: 'Support Grade', appliesTo: 'non_teaching', description: 'Non-teaching and transport staff', basic: 13000, allowances: [{ label: 'Conveyance', kind: 'fixed', value: 1000 }], deductions: [{ label: 'Provident Fund', kind: 'percent', value: 12 }] });
  await admin('POST', '/payroll/salaries/bulk', { levelId: supportLevel._id, personIds: [...generalStaff.map((m) => m._id), drv._id, cnd._id], effectiveFrom: '2026-04-01', reason: 'Initial salary setup' });
  const prev = new Date(`${today.slice(0, 7)}-01T00:00:00Z`); prev.setUTCMonth(prev.getUTCMonth() - 1);
  const lastRun = await admin('POST', '/payroll/runs', { month: prev.toISOString().slice(0, 7) });
  await admin('POST', `/payroll/runs/${lastRun._id}/approve`);
  await admin('POST', `/payroll/runs/${lastRun._id}/pay`, { mode: 'bank_transfer', reference: 'NEFT-DEMO-001' });

  return { rahul, students, teachers: teacherDefs, sections: sec };
}
