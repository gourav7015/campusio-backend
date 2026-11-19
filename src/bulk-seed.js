/**
 * Bulk data dump: three large, realistic schools written straight to MongoDB (bypassing HTTP) for load and UI testing.
 *   npm run dump          (into the database in MONGO_URI; loads ~7,000 students, ~340 teachers, timetables, attendance, exams, fees, library)
 *   CONFIRM_WIPE=<db name> npm run dump -- --wipe   (drops that whole database first — destructive, so the name must be typed)
 * Everything is created the way the app creates it, so every portal works on it.
 */
if (process.env.NODE_ENV === 'production') { console.error('This script creates accounts with published demo passwords and must never run in production.'); process.exit(1); }
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { config, requireMongoUri } from './core/config.js';
import { todayStr, addDays, isoDay } from './core/utils.js';
import { gradeFor } from './services/context.js';
import { computePayslip, workingDates } from './modules/payroll/payroll.calc.js';
import { DEFAULT_DESIGNATIONS } from './modules/support-staff/support-staff.service.js';
import { round2 } from './core/utils.js';
import * as M from './models/index.js';

const { ObjectId } = mongoose.Types;
const oid = () => new ObjectId();
let seed = 20261113;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const shuffle = (a) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
const clip = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = (n) => Math.round(n * 100) / 100;

const SCHOOLS = [
  { code: 'dpsr', name: 'Delhi Public School, Rajkot', city: 'Rajkot', students: 2500, teachers: 125, sections: 5 },
  { code: 'sunr', name: 'Sunrise International School', city: 'Pune', students: 2250, teachers: 112, sections: 5 },
  { code: 'gwvs', name: 'Greenwood Valley School', city: 'Bengaluru', students: 2000, teachers: 104, sections: 4 },
];
const PASSWORDS = { staff: 'Staff@12345', transport: 'Transport@12345', admin: 'Admin@12345', finance: 'Finance@12345', library: 'Library@12345', teacher: 'Teach@12345', student: 'Student@12345', super: 'Super@12345' };

const FIRST = ['Aarav', 'Vihaan', 'Aditya', 'Arjun', 'Sai', 'Ishaan', 'Krish', 'Rohan', 'Kabir', 'Dev', 'Rahul', 'Neil', 'Yash', 'Atharv', 'Vivaan', 'Reyansh', 'Ayaan', 'Shaurya', 'Ansh', 'Dhruv', 'Harsh', 'Karan', 'Manav', 'Nikhil', 'Pranav', 'Rudra', 'Samarth', 'Tanish', 'Utkarsh', 'Veer', 'Ananya', 'Diya', 'Isha', 'Kavya', 'Meera', 'Nisha', 'Pooja', 'Riya', 'Saanvi', 'Tanvi', 'Zoya', 'Avni', 'Myra', 'Aadhya', 'Sara', 'Navya', 'Ira', 'Anvi', 'Kiara', 'Tara', 'Veda', 'Jiya', 'Prisha', 'Ritika', 'Shreya', 'Trisha', 'Aarohi', 'Bhavya', 'Charvi', 'Dia', 'Esha', 'Gauri'];
const LAST = ['Sharma', 'Patel', 'Singh', 'Kumar', 'Mehta', 'Joshi', 'Nair', 'Reddy', 'Iyer', 'Gupta', 'Khan', 'Das', 'Rao', 'Kulkarni', 'Desai', 'Jain', 'Shah', 'Verma', 'Agarwal', 'Bose', 'Chopra', 'Dave', 'Ghosh', 'Kapoor', 'Malhotra', 'Pillai', 'Saxena', 'Trivedi', 'Yadav', 'Zaveri', 'Banerjee', 'Chatterjee', 'Bhatt', 'Thakkar', 'Parmar', 'Solanki', 'Rathod', 'Jadeja', 'Gohil', 'Vyas'];
const GRADES = [
  { name: 'LKG', level: -2, age: 4 }, { name: 'UKG', level: -1, age: 5 },
  ...Array.from({ length: 12 }, (_, i) => ({ name: `Class ${i + 1}`, level: i + 1, age: i + 6 })),
];
// subjects per band; weekly = periods per week
const BANDS = {
  pre: [['English Reading', 5], ['Numbers', 5], ['Hindi Varnamala', 4], ['Drawing & Craft', 3], ['Play & Activity', 3]],
  primary: [['English', 6], ['Hindi', 5], ['Mathematics', 6], ['EVS', 4], ['Computer Science', 3], ['Art & Craft', 3], ['Physical Education', 3]],
  middle: [['English', 6], ['Hindi', 5], ['Mathematics', 6], ['Science', 5], ['Social Science', 5], ['Sanskrit', 4], ['Computer Science', 3]],
  secondary: [['English', 6], ['Hindi', 5], ['Mathematics', 6], ['Science', 6], ['Social Science', 5], ['Information Technology', 3]],
  senior: [['English', 6], ['Physics', 6], ['Chemistry', 6], ['Mathematics', 6], ['Biology', 5], ['Computer Science', 5]],
};
const bandOf = (lv) => (lv < 1 ? 'pre' : lv <= 5 ? 'primary' : lv <= 8 ? 'middle' : lv <= 10 ? 'secondary' : 'senior');
const FIELDS = (subject, level) => (/Computer|Information|Science|Physics|Chemistry|Biology/.test(subject) && level >= 6 ? [{ key: 'written', label: 'Written', max: 70 }, { key: 'practical', label: 'Practical', max: 30 }]
  : level < 1 ? [{ key: 'marks', label: 'Marks', max: 25 }] : level <= 5 ? [{ key: 'written', label: 'Written', max: 40 }, { key: 'oral', label: 'Oral', max: 10 }] : [{ key: 'written', label: 'Written', max: 80 }, { key: 'internal', label: 'Internal', max: 20 }]);
const BOOK_WORDS = { adj: ['Lost', 'Silent', 'Golden', 'Hidden', 'Brave', 'Little', 'Ancient', 'Secret', 'Wandering', 'Shining'], noun: ['Garden', 'River', 'Mountain', 'Library', 'Journey', 'Kingdom', 'Island', 'Festival', 'Forest', 'Village', 'Rocket', 'Lantern'] };
const REAL_BOOKS = [
  ['Wings of Fire', 'A. P. J. Abdul Kalam', 'Biography'], ['Malgudi Days', 'R. K. Narayan', 'Fiction'], ['The Jungle Book', 'Rudyard Kipling', 'Fiction'], ['Panchatantra Tales', 'Vishnu Sharma', 'Fiction'],
  ['Harry Potter and the Philosopher\'s Stone', 'J. K. Rowling', 'Fiction'], ['Charlie and the Chocolate Factory', 'Roald Dahl', 'Fiction'], ['Matilda', 'Roald Dahl', 'Fiction'], ['The Diary of a Young Girl', 'Anne Frank', 'Biography'],
  ['Discovery of India', 'Jawaharlal Nehru', 'History'], ['My Experiments with Truth', 'M. K. Gandhi', 'Biography'], ['Gitanjali', 'Rabindranath Tagore', 'Poetry'], ['Train to Pakistan', 'Khushwant Singh', 'Fiction'],
  ['The Adventures of Tom Sawyer', 'Mark Twain', 'Fiction'], ['Treasure Island', 'R. L. Stevenson', 'Fiction'], ['Alice in Wonderland', 'Lewis Carroll', 'Fiction'], ['Swami and Friends', 'R. K. Narayan', 'Fiction'],
  ['A Brief History of Time', 'Stephen Hawking', 'Science'], ['Cosmos', 'Carl Sagan', 'Science'], ['The Story of the Earth', 'Dorling Kindersley', 'Science'], ['Atlas of the World', 'Oxford', 'Geography'],
  ['Ignited Minds', 'A. P. J. Abdul Kalam', 'Self-help'], ['Gulliver\'s Travels', 'Jonathan Swift', 'Fiction'], ['Tales from Shakespeare', 'Charles Lamb', 'Fiction'], ['Mathematical Puzzles', 'Shakuntala Devi', 'Mathematics'],
  ['The Magic of Thinking Big', 'David Schwartz', 'Self-help'], ['Amar Chitra Katha: Hanuman', 'Anant Pai', 'Comics'], ['Tinkle Digest', 'Anant Pai', 'Comics'], ['Oxford Student Dictionary', 'Oxford', 'Reference'],
  ['Concise Encyclopaedia', 'Britannica', 'Reference'], ['The Story of My Life', 'Helen Keller', 'Biography'], ['Heidi', 'Johanna Spyri', 'Fiction'], ['Black Beauty', 'Anna Sewell', 'Fiction'],
];
const PLACES = ['of the North', 'by the Sea', 'in the Hills', 'at Dawn', 'of Tomorrow', 'Beyond the Clouds', 'in the Valley', 'at Midnight', 'of the East', 'under the Stars', 'near the Lake', 'of Long Ago', 'in the Desert', 'across the Border', 'of the Old Town'];
const CATS = ['Fiction', 'Science', 'History', 'Biography', 'Reference', 'Poetry', 'Mathematics', 'Comics', 'Geography', 'Self-help'];

const wipe = process.argv.includes('--wipe');
const today = todayStr('Asia/Kolkata');
const stamp = (docs) => { const now = new Date(); return docs.map((d) => ({ createdAt: now, updatedAt: now, ...d })); };
async function bulk(Model, docs) {
  for (let i = 0; i < docs.length; i += 5000) await Model.collection.insertMany(stamp(docs.slice(i, i + 5000)), { ordered: false });
  return docs.length;
}
const log = (...a) => console.log(...a);

async function buildSchool(cfg, hashes, superAdmin) {
  const t0 = Date.now();
  const tenantId = oid(); const yearId = oid();
  const settings = M.defaultSettings();
  settings.statutory = { pf: { ...settings.statutory.pf, enabled: true }, esi: { ...settings.statutory.esi, enabled: true }, pt: { ...settings.statutory.pt, enabled: true } }; // this school deducts PF, ESI and professional tax
  const stats = {};
  await bulk(M.School, [{ _id: tenantId, name: cfg.name, code: cfg.code, address: `${cfg.city}, India`, phone: '0281 555 0100', board: 'CBSE', status: 'active', settings }]);
  await bulk(M.Subscription, [{ schoolId: tenantId, plan: 'premium', status: 'active', startsOn: '2026-04-01', expiresOn: '2027-03-31' }]);
  await bulk(M.AcademicYear, [
    { tenantId, name: '2024-2025', startDate: '2024-04-01', endDate: '2025-03-31', isCurrent: false, status: 'closed' },
    { tenantId, name: '2025-2026', startDate: '2025-04-01', endDate: '2026-03-31', isCurrent: false, status: 'closed' },
    { _id: yearId, tenantId, name: '2026-2027', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true, status: 'active' },
  ]);

  // ── staff users ──
  const adminId = oid(); const finId = oid(); const libId = oid(); const trId = oid();
  const staff = [[adminId, 'school_admin', `${cfg.code} Principal Office`, `admin@${cfg.code}.school`, hashes.admin], [finId, 'finance', 'Accounts Officer', `finance@${cfg.code}.school`, hashes.finance], [libId, 'library', 'Librarian', `library@${cfg.code}.school`, hashes.library], [trId, 'transport', 'Transport Officer', `transport@${cfg.code}.school`, hashes.transport]];
  const users = staff.map(([_id, role, name, loginId, passwordHash]) => ({ _id, tenantId, role, name, loginId, email: loginId, passwordHash, mustChangePassword: false, status: 'active', failedLogins: 0, language: 'en', notificationPrefs: { homework: true, attendance: true, examination: true, results: true, announcements: true, timetable: true }, createdBy: superAdmin }));

  // ── classes, sections, subjects, offerings ──
  const subjects = new Map(); // name -> {_id, code}
  const codeSet = new Set();
  const subjectOf = (name) => {
    if (!subjects.has(name)) {
      const words = name.split(/[ &]+/).filter(Boolean);
      let base = (words.length > 1 ? words.map((w) => w[0]).join('') : name.replace(/[^A-Za-z]/g, '').slice(0, 4)).toUpperCase().slice(0, 5); let code = base; let n = 2;
      while (codeSet.has(code)) code = `${base}${n++}`;
      codeSet.add(code); subjects.set(name, { _id: oid(), name, code });
    }
    return subjects.get(name);
  };
  const classes = GRADES.map((g) => ({ ...g, _id: oid() }));
  const perClass = Math.floor(cfg.students / classes.length); let extra = cfg.students - perClass * classes.length;
  const sections = []; const offerings = []; const sectionDocs = [];
  for (const c of classes) {
    const total = perClass + (extra-- > 0 ? 1 : 0);
    const nSec = c.level < 1 ? Math.max(3, cfg.sections - 1) : cfg.sections;
    c.subjects = BANDS[bandOf(c.level)];
    for (let i = 0; i < nSec; i++) {
      const count = Math.floor(total / nSec) + (i < total % nSec ? 1 : 0);
      const s = { _id: oid(), classId: c._id, level: c.level, className: c.name, name: 'ABCDEF'[i], studentCount: count, room: `${c.level < 1 ? 'P' : c.level}${'ABCDEF'[i]}-${100 + i}` };
      sections.push(s);
      sectionDocs.push({ _id: s._id, tenantId, yearId, classId: c._id, name: s.name, capacity: 45, room: s.room, status: 'active' });
    }
    c.offerings = c.subjects.map(([name, weekly]) => {
      const subj = subjectOf(name);
      const o = { _id: oid(), tenantId, yearId, classId: c._id, subjectId: subj._id, weeklyPeriods: weekly, assessment: { components: FIELDS(name, c.level), passMarks: Math.ceil(0.33 * FIELDS(name, c.level).reduce((n, f) => n + f.max, 0)) } };
      offerings.push(o); return { ...o, name, weekly };
    });
  }
  await bulk(M.ClassModel, classes.map((c) => ({ _id: c._id, tenantId, name: c.name, level: c.level, status: 'active' })));
  await bulk(M.Section, sectionDocs);
  await bulk(M.Subject, [...subjects.values()].map((s) => ({ _id: s._id, tenantId, name: s.name, code: s.code, type: 'core', status: 'active' })));
  await bulk(M.SubjectOffering, offerings);

  // ── teachers: allocated to subjects in proportion to the (section × subject) work, in contiguous blocks ──
  const pairs = []; // {section, class, offering, subjectName}
  for (const s of sections) { const c = classes.find((x) => x._id === s.classId); for (const o of c.offerings) pairs.push({ section: s, cls: c, off: o, subject: o.name }); }
  const subjectNames = [...subjects.keys()];
  const load = Object.fromEntries(subjectNames.map((n) => [n, pairs.filter((p) => p.subject === n).length]));
  const totalLoad = pairs.length;
  const quota = Object.fromEntries(subjectNames.map((n) => [n, Math.max(2, Math.round((cfg.teachers * load[n]) / totalLoad))]));
  let have = Object.values(quota).reduce((a, b) => a + b, 0);
  for (let i = 0; have < cfg.teachers; i++, have++) quota[subjectNames[i % subjectNames.length]]++; // top up to the target
  const teachers = []; let empNo = 1;
  const DESIG = ['PRT', 'TGT', 'PGT'];
  for (const name of subjectNames) {
    const myPairs = pairs.filter((p) => p.subject === name).sort((a, b) => a.cls.level - b.cls.level || a.section.name.localeCompare(b.section.name));
    const n = quota[name]; const chunk = Math.ceil(myPairs.length / n);
    for (let i = 0; i < n; i++) {
      const assigned = myPairs.slice(i * chunk, (i + 1) * chunk);
      const fn = pick(FIRST); const ln = pick(LAST); const userId = oid(); const emp = `T${String(empNo).padStart(4, '0')}`;
      const t = { _id: oid(), userId, employeeId: emp, name: `${fn} ${ln}`, subjectName: name, pairs: assigned, designation: DESIG[Math.max(0, Math.min(2, Math.floor((assigned[0]?.cls.level ?? 1) / 5)))], joiningDate: `${between(2008, 2025)}-0${between(1, 9)}-15` };
      teachers.push(t); assigned.forEach((p) => { p.teacher = t; }); empNo++;
      users.push({ _id: userId, tenantId, role: 'teacher', name: t.name, loginId: `${cfg.code}.t${String(empNo - 1).padStart(4, '0')}`, passwordHash: hashes.teacher, mustChangePassword: false, status: 'active', failedLogins: 0, language: 'en', notificationPrefs: {}, createdBy: adminId });
    }
  }
  // salary bank accounts and statutory ids; a few people have none yet, so the bank file and PF/ESI reports have something to flag
  const BANKS = [['SBIN', 'State Bank of India'], ['HDFC', 'HDFC Bank'], ['ICIC', 'ICICI Bank'], ['UTIB', 'Axis Bank'], ['PUNB', 'Punjab National Bank']];
  const bankOf = (name) => { if (rnd() < 0.08) return undefined; const [code, bankName] = pick(BANKS); return { accountName: name, accountNo: String(between(100000000000, 999999999999)), ifsc: `${code}0${String(between(0, 999999)).padStart(6, '0')}`, bankName }; };
  const idsOf = (esi) => ({ uan: rnd() < 0.85 ? String(between(100000000000, 999999999999)) : undefined, esiNo: esi && rnd() < 0.7 ? String(between(1000000000, 9999999999)) : undefined, pan: rnd() < 0.6 ? `${pick('ABCDEFGHJK')}${pick('ABCDEFGHJK')}${pick('ABCDEFGHJK')}P${pick('ABCDEFGHJK')}${between(1000, 9999)}${pick('ABCDEFGHJK')}` : undefined });
  await bulk(M.Teacher, teachers.map((t, ix) => ({ house: HOUSE_NAMES[ix % HOUSE_NAMES.length], bank: bankOf(t.name), statutory: idsOf(false), _id: t._id, tenantId, userId: t.userId, employeeId: t.employeeId, name: t.name, email: `${t.employeeId.toLowerCase()}@${cfg.code}.school`, phone: `98${between(10000000, 99999999)}`, designation: t.designation, qualification: pick(['B.Ed', 'M.Sc, B.Ed', 'M.A, B.Ed', 'M.Com, B.Ed', 'B.Sc, B.Ed']), joiningDate: t.joiningDate, subjectIds: [subjects.get(t.subjectName)._id], status: 'active' })));
  const assignments = pairs.map((p) => ({ _id: oid(), tenantId, yearId, teacherId: p.teacher._id, sectionId: p.section._id, classId: p.cls._id, subjectId: subjects.get(p.subject)._id, offeringId: p.off._id, effectiveFrom: '2026-04-01', open: true }));
  pairs.forEach((p, i) => { p.assignmentId = assignments[i]._id; });
  await bulk(M.TeachingAssignment, assignments);

  // class teachers: one per section, a teacher who teaches there, nobody twice
  const pref = ['English', 'English Reading', 'Mathematics', 'Numbers', 'Hindi', 'Hindi Varnamala', 'EVS', 'Science', 'Social Science', 'Physics'];
  const usedCT = new Set(); const classTeacherOf = new Map();
  for (const s of sections) {
    const cands = pairs.filter((p) => p.section === s && !usedCT.has(p.teacher._id)).sort((a, b) => (pref.indexOf(a.subject) + 99) % 99 - (pref.indexOf(b.subject) + 99) % 99);
    const t = (cands[0] || { teacher: teachers.find((x) => !usedCT.has(x._id)) }).teacher;
    usedCT.add(t._id); classTeacherOf.set(s._id, t);
  }
  await bulk(M.ClassTeacherAssignment, sections.map((s) => ({ tenantId, yearId, sectionId: s._id, teacherId: classTeacherOf.get(s._id)._id, effectiveFrom: '2026-04-01', open: true })));

  // ── timetable (greedy, conflict-free for teachers) ──
  const times = [['08:00', '08:40'], ['08:40', '09:20'], ['09:20', '10:00'], ['10:00', '10:20', 'break'], ['10:20', '11:00'], ['11:00', '11:40'], ['11:40', '12:20'], ['12:20', '13:00']];
  const periodDocs = times.map((t, i) => ({ _id: oid(), tenantId, name: t[2] ? 'Break' : `Period ${i < 3 ? i + 1 : i}`, order: i + 1, startTime: t[0], endTime: t[1], type: t[2] ? 'break' : 'lesson' }));
  await bulk(M.TimetablePeriod, periodDocs);
  const lessonPeriods = periodDocs.filter((p) => p.type === 'lesson');
  const busy = new Set(); const entries = []; let unplaced = 0;
  for (const s of sections) {
    const slots = shuffle([].concat(...[1, 2, 3, 4, 5, 6].map((d) => lessonPeriods.map((p) => [d, p]))));
    const taken = new Set(); const dayCount = new Map();
    const mine = shuffle(pairs.filter((p) => p.section === s));
    for (const p of mine) {
      let left = p.off.weekly;
      for (const strict of [true, false]) for (const [d, per] of slots) {
        if (!left) break;
        const k = `${d}|${per._id}`;
        if (taken.has(k) || busy.has(`${p.teacher._id}|${k}`)) continue;
        if (strict && (dayCount.get(`${p.subject}|${d}`) || 0) >= 1) continue;
        taken.add(k); busy.add(`${p.teacher._id}|${k}`); dayCount.set(`${p.subject}|${d}`, (dayCount.get(`${p.subject}|${d}`) || 0) + 1);
        entries.push({ tenantId, yearId, sectionId: s._id, day: d, periodId: per._id, assignmentId: p.assignmentId, room: s.room, unresolved: false }); left--;
      }
      unplaced += left;
    }
  }
  await bulk(M.TimetableEntry, entries);

  // ── students (+ users, enrolments) ──
  // each school names its own houses; the students and teachers are shared out among them
  const HOUSE_SETS = { dpsr: ['Aravali', 'Nilgiri', 'Himalaya', 'Vindhya'], sunr: ['Ganga', 'Yamuna', 'Godavari', 'Kaveri'], gwvs: ['Ashoka', 'Akbar', 'Shivaji', 'Rana Pratap'] };
  const HOUSE_NAMES = HOUSE_SETS[cfg.code] || HOUSE_SETS.dpsr;
  const HOUSE_COLORS = ['#b45309', '#1d4ed8', '#0f766e', '#7c3aed'];
  await bulk(M.House, HOUSE_NAMES.map((name, i) => ({ tenantId, name, color: HOUSE_COLORS[i % 4], status: 'active' })));
  const students = []; const enrolments = []; let adm = 1;
  for (const s of sections) {
    const names = [];
    for (let i = 0; i < s.studentCount; i++) names.push(`${pick(FIRST)} ${pick(LAST)}`);
    names.sort((a, b) => a.localeCompare(b));
    const cls = classes.find((c) => c._id === s.classId);
    names.forEach((name, i) => {
      const userId = oid(); const no = `ADM2026${String(adm).padStart(4, '0')}`; adm++;
      const female = FIRST.indexOf(name.split(' ')[0]) >= 30;
      const st = { _id: oid(), userId, name, admissionNo: no, section: s, cls, rate: clip(0.97 - rnd() * rnd() * 0.3, 0.6, 0.99), ability: clip(0.66 + (rnd() + rnd() + rnd() - 1.5) * 0.28, 0.2, 0.97) };
      students.push(st);
      users.push({ _id: userId, tenantId, role: 'student', name, loginId: `${cfg.code}.${no.toLowerCase()}`, passwordHash: hashes.student, mustChangePassword: false, status: 'active', failedLogins: 0, language: 'en', notificationPrefs: {}, createdBy: adminId });
      st.enrolmentId = oid();
      enrolments.push({ _id: st.enrolmentId, tenantId, studentId: st._id, yearId, classId: s.classId, sectionId: s._id, rollNo: i + 1, startDate: '2026-04-10', status: 'active' });
      st.female = female; st.dob = `${2026 - cls.age}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`;
    });
  }
  await bulk(M.User, users);
  await bulk(M.Student, students.map((st, ix) => ({ _id: st._id, tenantId, userId: st.userId, admissionNo: st.admissionNo, name: st.name, dob: st.dob, gender: st.female ? 'female' : 'male', address: `${between(1, 99)}, ${pick(['Station Road', 'MG Road', 'Park Street', 'Nehru Nagar', 'Gandhi Marg'])}, ${cfg.city}`, phone: `97${between(10000000, 99999999)}`, admissionDate: '2026-04-10', house: HOUSE_NAMES[ix % HOUSE_NAMES.length],
    guardians: [{ name: `${pick(FIRST)} ${st.name.split(' ')[1]}`, relationship: pick(['Father', 'Mother']), phone: `98${between(10000000, 99999999)}`, isPrimary: true }], status: 'active' })));
  await bulk(M.StudentEnrolment, enrolments);
  stats.students = students.length; stats.teachers = teachers.length; stats.sections = sections.length; stats.timetable = entries.length;

  // ── attendance: last 30 working days (today's registers are left pending) ──
  const days = []; for (let b = 1; days.length < 30 && b < 60; b++) { const d = addDays(today, -b); if (isoDay(d) !== 7) days.push(d); }
  const hol = days[7]; days.splice(7, 1); // one holiday
  await bulk(M.CalendarEvent, [{ tenantId, title: 'Founders Day', type: 'holiday', startDate: hol, endDate: hol, sectionIds: [] }, { tenantId, title: 'Diwali Break', type: 'holiday', startDate: addDays(today, 6), endDate: addDays(today, 10), sectionIds: [] }, { tenantId, title: 'Parent–Teacher Meeting', type: 'ptm', startDate: addDays(today, 14), endDate: addDays(today, 14), sectionIds: [] }]);
  const sessions = []; const records = []; const counts = new Map();
  const bySection = new Map(); students.forEach((st) => { if (!bySection.has(st.section._id)) bySection.set(st.section._id, []); bySection.get(st.section._id).push(st); });
  for (const s of sections) {
    const ct = classTeacherOf.get(s._id);
    for (const date of days) {
      const sid = oid();
      sessions.push({ _id: sid, tenantId, yearId, sectionId: s._id, date, status: 'submitted', markedBy: ct.userId, submittedBy: ct.userId, submittedAt: new Date(`${date}T04:30:00Z`) });
      for (const st of bySection.get(s._id)) {
        const r = rnd();
        const status = r < st.rate ? 'present' : r < st.rate + (1 - st.rate) * 0.25 ? 'late' : r < st.rate + (1 - st.rate) * 0.45 ? 'leave' : 'absent';
        records.push({ tenantId, sessionId: sid, studentId: st._id, enrolmentId: st.enrolmentId, sectionId: s._id, yearId, date, status, remarks: '', history: [] });
        const c = counts.get(st._id) || { present: 0, absent: 0, late: 0, leave: 0 }; c[status]++; counts.set(st._id, c);
      }
    }
  }
  await bulk(M.AttendanceSession, sessions); await bulk(M.AttendanceRecord, records);
  stats.attendanceRecords = records.length;

  // ── published exams for everyone (with marks + report cards) and a scheduled Half-Yearly ──
  const grading = settings.grading;
  const PUBLISHED = [
    { name: 'Unit Test 1', type: 'unit_test', offset: -62, drift: 0 }, { name: 'Unit Test 2', type: 'unit_test', offset: -34, drift: 0.04 }, { name: 'Monthly Test — October', type: 'unit_test', offset: -12, drift: -0.02 },
  ];
  const half = { _id: oid(), tenantId, yearId, name: 'Half-Yearly', type: 'half_yearly', classIds: classes.map((c) => c._id), startDate: addDays(today, 25), endDate: addDays(today, 35), marksDeadline: addDays(today, 45), status: 'scheduled', schedulePublished: true, createdByName: 'Principal Office' };
  const examDocs = PUBLISHED.map((x) => ({ _id: oid(), tenantId, yearId, name: x.name, type: x.type, classIds: classes.map((c) => c._id), startDate: addDays(today, x.offset), endDate: addDays(today, x.offset + 5), marksDeadline: addDays(today, x.offset + 10), status: 'scheduled', schedulePublished: true, createdByName: 'Principal Office' }));
  await bulk(M.Examination, [...examDocs, half]);
  const exSubjects = []; const sheets = []; const marks = []; const cards = [];
  for (const [xi, spec] of PUBLISHED.entries()) {
    const exam = examDocs[xi];
    const esOf = new Map(); // offering id -> es
    for (const c of classes) {
      let d = addDays(today, spec.offset); let hd = addDays(today, 25);
      for (const o of c.offerings) {
        while (isoDay(d) === 7) d = addDays(d, 1); while (isoDay(hd) === 7) hd = addDays(hd, 1);
        const comps = o.assessment.components;
        const es = { _id: oid(), tenantId, examId: exam._id, classId: c._id, subjectId: o.subjectId, date: d, startTime: '09:00', endTime: '11:00', room: 'Exam Hall', components: comps, passMarks: o.assessment.passMarks, marksDeadline: exam.marksDeadline };
        exSubjects.push(es); esOf.set(o._id, es); d = addDays(d, 1);
        if (xi === 0) { exSubjects.push({ _id: oid(), tenantId, examId: half._id, classId: c._id, subjectId: o.subjectId, date: hd, startTime: '09:00', endTime: '12:00', room: 'Exam Hall', components: comps, passMarks: o.assessment.passMarks, marksDeadline: half.marksDeadline }); hd = addDays(hd, 1); }
      }
    }
    const studentRows = new Map(); // student -> subject rows
    for (const p of pairs) {
      const es = esOf.get(p.off._id); const sheetId = oid();
    sheets.push({ _id: sheetId, tenantId, examId: exam._id, examSubjectId: es._id, sectionId: p.section._id, teacherId: p.teacher._id, enteredByUserId: p.teacher.userId, status: 'published', submittedAt: new Date(addDays(today, spec.offset + 7)), reviewedBy: adminId, reviewedAt: new Date(addDays(today, spec.offset + 8)), publishedAt: new Date(addDays(today, spec.offset + 9)), revisions: [] });
      const max = es.components.reduce((n, c) => n + c.max, 0);
      for (const st of bySection.get(p.section._id)) {
        const absent = rnd() < 0.015;
        let values = {}; let total = null;
        if (!absent) { total = 0; for (const c of es.components) { const v = Math.round(c.max * clip(st.ability + spec.drift + (rnd() - 0.5) * 0.3, 0.05, 1)); values[c.key] = v; total += v; } }
        marks.push({ tenantId, sheetId, examId: exam._id, examSubjectId: es._id, sectionId: p.section._id, studentId: st._id, enrolmentId: st.enrolmentId, values, total, absent, exempt: false, remarks: '', history: [] });
        const pct = absent ? null : r2((total / max) * 100);
      const row = { subject: p.subject, code: subjects.get(p.subject).code, components: es.components.map((c) => ({ key: c.key, label: c.label, max: c.max, value: absent ? null : values[c.key] })), obtained: total, max, absent, exempt: false, remarks: '', teacher: p.teacher.name, percentage: pct, grade: absent ? 'AB' : gradeFor(pct, grading), passed: !absent && total >= es.passMarks };
        if (!studentRows.has(st)) studentRows.set(st, []);
        studentRows.get(st).push(row);
      }
    }
    for (const [st, rows] of studentRows) {
      const got = rows.reduce((n, r) => n + (r.absent ? 0 : r.obtained), 0); const mx = rows.reduce((n, r) => n + r.max, 0); const pct = r2((got / mx) * 100); const c = counts.get(st._id) || { present: 0, absent: 0, late: 0, leave: 0 };
      const counted = c.present + c.late + c.absent;
      cards.push({ tenantId, examId: exam._id, studentId: st._id, enrolmentId: st.enrolmentId, sectionId: st.section._id, classId: st.cls._id, yearId, version: 1, isCurrent: true, publishedAt: new Date(addDays(today, spec.offset + 9)), publishedBy: adminId,
        snapshot: { exam: { id: exam._id, name: exam.name, type: exam.type }, student: { id: st._id, name: st.name, admissionNo: st.admissionNo }, subjects: rows, totalObtained: got, totalMax: mx, percentage: pct, grade: gradeFor(pct, grading), resultStatus: rows.every((r) => r.passed) ? 'pass' : 'fail',
          attendance: { percentage: counted ? r2(((c.present + c.late) / counted) * 100) : null, present: c.present + c.late, absent: c.absent, workingDays: c.present + c.late + c.absent + c.leave }, teacherRemark: '', principalRemark: '' } });
    }
  }
  await bulk(M.ExaminationSubject, exSubjects); await bulk(M.MarksSheet, sheets); await bulk(M.Marks, marks); await bulk(M.ReportCard, cards);
  stats.marks = marks.length; stats.reportCards = cards.length;

  // ── homework, announcements ──
  const hw = [];
  const TOPICS = ['Chapter questions', 'Worksheet', 'Revision', 'Practice set', 'Project work', 'Reading task', 'Notebook work', 'Diagram practice'];
  const hwDays = []; for (let b = 0; hwDays.length < 12 && b < 20; b++) { const d = addDays(today, -b); if (isoDay(d) !== 7) hwDays.push(d); }
  for (const s of sections) {
    const mine = pairs.filter((q) => q.section === s);
    for (const day of hwDays) for (const p of shuffle(mine).slice(0, between(2, 4))) {
      hw.push({ tenantId, yearId, sectionId: s._id, subjectId: subjects.get(p.subject)._id, teacherId: p.teacher._id, title: `${p.subject}: ${pick(TOPICS)} ${between(1, 14)}`, description: 'Complete in your notebook.', type: pick(['written', 'written', 'worksheet', 'revision', 'project']), assignedDate: day, dueDate: addDays(day, between(1, 4)), status: 'published', publishedAt: new Date(), attachments: [], editHistory: [{ changes: ['Created'] }] });
    }
  }
  await bulk(M.Homework, hw);
  await bulk(M.Announcement, [{ tenantId, title: 'Annual Sports Day', category: 'event', body: 'Annual Sports Day on the school ground. Wear your house T-shirt.', audience: { all: true, roles: [], sectionIds: [] }, status: 'published', createdBy: adminId, createdByName: 'Principal Office', createdByRole: 'school_admin' }, { tenantId, title: 'Half-Yearly examination schedule published', category: 'examination', body: 'Please check the examination schedule in your portal.', audience: { all: true, roles: [], sectionIds: [] }, status: 'published', createdBy: adminId, createdByName: 'Principal Office', createdByRole: 'school_admin' }]);

  // ── fees: how Indian schools bill — an admission fee, then tuition every month (transport is added further down for bus riders) ──
  const MONTHS12 = Array.from({ length: 12 }, (_, k) => { const m = (3 + k) % 12 + 1; const y = 2026 + Math.floor((3 + k) / 12); return `${y}-${String(m).padStart(2, '0')}`; });
  const DAY = 10; const dueOf = (period) => `${period}-${String(DAY).padStart(2, '0')}`;
  const NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthName = (period) => `${NAMES[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
  const dueNow = MONTHS12.filter((m) => dueOf(m) <= today).length; // months whose due date has passed
  const feeOf = (c) => ({ admissionFee: c.level < 1 ? 3000 : c.level <= 5 ? 5000 : 6000, monthlyFee: c.level < 1 ? 1000 : Math.round((1300 + c.level * 110) / 50) * 50, extras: c.level >= 9 ? [{ head: 'Exam fee', amount: 600, frequency: 'yearly' }] : [] });
  const structures = classes.map((c) => ({ _id: oid(), tenantId, yearId, classId: c._id, name: `${c.name} Fee`, ...feeOf(c), dueDay: DAY, autoAssign: true, status: 'active', createdBy: finId }));
  await bulk(M.FeeStructure, structures);
  const charges = []; const payments = []; let rc = 0; const modes = ['cash', 'upi', 'upi', 'cheque', 'bank_transfer', 'card'];
  const beh = new Map(); // student -> how they pay (also used for their transport fare)
  const mkCharge = (st, fs, label, category, amount, dueDate, extra = {}) => ({ _id: oid(), tenantId, studentId: st._id, yearId, kind: 'fee', label, category, structureId: fs?._id, amount, concession: 0, concessions: [], dueDate, paidAmount: 0, status: 'open', createdBy: finId, ...extra });
  const settle = (st, chs, paidOn) => {
    rc++;
    const allocations = chs.map((c) => ({ chargeId: c._id, label: c.label, amount: c.amount - c.concession }));
    chs.forEach((c) => { c.paidAmount = c.amount - c.concession; c.status = 'paid'; });
    payments.push({ tenantId, studentId: st._id, kind: 'payment', amount: allocations.reduce((n, a) => n + a.amount, 0), mode: pick(modes), reference: rnd() < 0.5 ? `REF${between(100000, 999999)}` : undefined, receiptNo: `RCPT2026${String(rc).padStart(5, '0')}`, paidOn: paidOn > today ? today : paidOn, allocations, receivedBy: finId, receivedByName: 'Accounts Officer', status: 'completed' });
  };
  for (const st of students) {
    const fs = structures.find((x) => x.classId === st.cls._id);
    const r = rnd();
    // paid-through = index of the last month paid (-1 none); advance = whole year paid in April with the last month free
    const mode = r < 0.58 ? { through: dueNow - 1 } : r < 0.76 ? { through: dueNow - 2 } : r < 0.88 ? { through: dueNow - 4 } : r < 0.93 ? { through: 11, advance: true } : r < 0.97 ? { through: 2, partial: true } : { through: -1 };
    beh.set(st, mode);
    const scholar = !mode.advance && rnd() < 0.05;
    const admission = mkCharge(st, fs, 'Admission fee', 'Admission', fs.admissionFee, dueOf(MONTHS12[0]));
    const tuition = MONTHS12.map((m) => {
      const c = mkCharge(st, fs, `Tuition fee — ${monthName(m)}`, 'Tuition', fs.monthlyFee, dueOf(m), { period: m });
      if (scholar) { const k = Math.round(fs.monthlyFee * 0.1); c.concession = k; c.concessionNote = 'Merit scholarship'; c.concessions = [{ amount: k, reason: 'Merit scholarship', byName: 'Accounts Officer', at: new Date() }]; }
      return c;
    });
    const extras = fs.extras.map((e) => mkCharge(st, fs, e.head, e.head, e.amount, dueOf(MONTHS12[0])));
    charges.push(admission, ...tuition, ...extras);
    if (mode.through >= 0 || mode.advance) { settle(st, [admission, ...extras], `2026-04-${String(between(4, 12)).padStart(2, '0')}`); }
    else if (rnd() < 0.5) settle(st, [admission], `2026-04-${String(between(8, 20)).padStart(2, '0')}`);
    if (mode.advance) {
      const last = tuition[11]; last.concession = last.amount; last.concessionNote = 'Advance payment — 1 month of tuition free'; last.concessions = [{ amount: last.amount, reason: 'Advance payment — 1 month of tuition free', byName: 'Accounts Officer', at: new Date() }]; last.status = 'paid';
      settle(st, tuition.slice(0, 11), `2026-04-${String(between(6, 14)).padStart(2, '0')}`);
    } else if (mode.through >= 0) {
      const paid = tuition.slice(0, mode.through + 1);
      for (let k = 0; k < paid.length; k += 3) { const chunk = paid.slice(k, k + 3); settle(st, chunk, addDays(chunk[0].dueDate, between(0, 8))); }
      if (mode.partial) { const t = tuition[3]; const half = Math.round((t.amount - t.concession) / 2); rc++; t.paidAmount = half; payments.push({ tenantId, studentId: st._id, kind: 'payment', amount: half, mode: 'cash', receiptNo: `RCPT2026${String(rc).padStart(5, '0')}`, paidOn: addDays(t.dueDate, between(3, 12)), allocations: [{ chargeId: t._id, label: t.label, amount: half }], receivedBy: finId, receivedByName: 'Accounts Officer', status: 'completed' }); }
    }
  }

  // ── library ──
  const books = []; const copies = []; let acc = 1;
  const usedTitles = new Set();
  const uniqueTitle = () => { for (;;) { const t = `The ${pick(BOOK_WORDS.adj)} ${pick(BOOK_WORDS.noun)} ${pick(PLACES)}`; if (!usedTitles.has(t)) { usedTitles.add(t); return t; } } };
  for (let i = 0; i < 1200; i++) {
    const real = i < REAL_BOOKS.length ? REAL_BOOKS[i] : null;
    const b = { _id: oid(), tenantId, title: real ? real[0] : uniqueTitle(), author: real ? real[1] : `${pick(FIRST)} ${pick(LAST)}`, isbn: `978${String(between(1000000000, 9999999999)).slice(0, 10)}`, category: real ? real[2] : pick(CATS), publisher: pick(['Penguin', 'NCERT', 'Oxford', 'Scholastic', 'S. Chand']), language: pick(['English', 'English', 'Hindi']), shelf: `${pick('ABCDEFG')}-${between(1, 12)}`, price: between(90, 650), status: 'active' };
    books.push(b);
    for (let c = 0; c < between(1, 4); c++) copies.push({ _id: oid(), tenantId, bookId: b._id, accessionNo: `LB${String(acc++).padStart(5, '0')}`, status: 'available' });
  }
  const issues = []; const fineCharges = [];
  const freeCopies = shuffle(copies); const people = [...students.slice().sort(() => rnd() - 0.5).slice(0, 900).map((s) => ({ type: 'student', s })), ...teachers.slice(0, 40).map((t) => ({ type: 'teacher', t }))];
  const used = new Set();
  const borrower = (p) => (p.type === 'student' ? { borrowerType: 'student', borrowerId: p.s._id, borrowerUserId: p.s.userId } : { borrowerType: 'teacher', borrowerId: p.t._id, borrowerUserId: p.t.userId });
  const issue = (copy, p, issuedOn, dueDate, extra = {}) => ({ _id: oid(), tenantId, copyId: copy._id, bookId: copy.bookId, ...borrower(p), issuedOn, dueDate, status: 'issued', renewals: 0, fineAmount: 0, fineWaived: false, issuedBy: libId, ...extra });
  people.forEach((p, i) => {
    const copy = freeCopies[i]; used.add(copy._id);
    if (i < 220) { const ago = between(0, 12); issues.push(issue(copy, p, addDays(today, -ago), addDays(today, (p.type === 'student' ? 14 : 30) - ago))); copy.status = 'issued'; }   // on loan, on time
    else if (i < 285) { const ago = between(20, 45); issues.push(issue(copy, p, addDays(today, -ago), addDays(today, -ago + 14))); copy.status = 'issued'; } // overdue
    else { // returned in the past, some late with a fine
      const ago = between(25, 70); const late = rnd() < 0.3 ? between(1, 9) : 0; const ret = addDays(today, -ago + 14 + late);
      const fine = late * 2; const li = issue(copy, p, addDays(today, -ago), addDays(today, -ago + 14), { status: 'returned', returnedOn: ret <= today ? ret : today, returnCondition: 'good', fineDays: late, fineAmount: fine, returnedBy: libId });
      if (fine && p.type === 'student') { const cid = oid(); const paid = rnd() < 0.6; fineCharges.push({ _id: cid, tenantId, studentId: p.s._id, yearId, kind: 'library_fine', label: `Library fine — returned ${late} day(s) late`, category: 'Library', amount: fine, concession: 0, concessions: [], dueDate: li.returnedOn, paidAmount: paid ? fine : 0, status: paid ? 'paid' : 'open', source: { type: 'libraryIssue', id: String(li._id) } }); li.fineChargeId = cid; }
      issues.push(li);
    }
  });
  // earlier returned loans: roughly a third of the borrowers have read more than one book this year
  let spare = people.length;
  for (const p of people.slice(285).filter((x) => x.type === 'student' && rnd() < 0.35)) {
    const copy = freeCopies[spare++]; if (!copy) break;
    const ago = between(40, 120);
    issues.push(issue(copy, p, addDays(today, -ago), addDays(today, -ago + 14), { status: 'returned', returnedOn: addDays(today, -ago + between(5, 14)), returnCondition: 'good', fineDays: 0, fineAmount: 0, returnedBy: libId }));
  }
  await bulk(M.Book, books); await bulk(M.BookCopy, copies); await bulk(M.LibraryIssue, issues); if (fineCharges.length) await bulk(M.StudentCharge, fineCharges);
  await bulk(M.Counter, [{ tenantId, key: 'accession', seq: acc - 1 }]);
  stats.books = books.length; stats.copies = copies.length; stats.loans = issues.length;

  // ── transport: buses with drivers and conductors; about 40% of students ride ──
  const AREAS = ['Kalawad Road', 'University Road', '150 Feet Ring Road', 'Raiya Road', 'Mavdi', 'Gondal Road', 'Bhaktinagar', 'Yagnik Road', 'Race Course', 'Kothariya', 'Amin Marg', 'Nana Mava', 'Madhapar', 'Rajkot Bus Stand', 'Sadhu Vaswani Road', 'Indira Circle', 'Trikon Baug', 'Jamnagar Road', 'Morbi Road', 'Aji Dam'];
  const riders = shuffle(students).slice(0, Math.round(students.length * 0.4));
  const perBus = 38; const busCount = Math.ceil(riders.length / perBus);
  // designations: the defaults plus a few titles this school added itself
  const EXTRA = { dpsr: [{ name: 'Bus Attendant', group: 'transport', busRole: 'conductor' }, { name: 'Hostel Warden', group: 'general' }], sunr: [{ name: 'Electrician', group: 'general' }, { name: 'Canteen Helper', group: 'general' }], gwvs: [{ name: 'Bus Helper', group: 'transport', busRole: 'conductor' }, { name: 'Groundsman', group: 'general' }] };
  const desDocs = [...DEFAULT_DESIGNATIONS, ...(EXTRA[cfg.code] || [])].map((d) => ({ _id: oid(), tenantId, name: d.name, group: d.group, busRole: d.busRole || null, status: 'active' }));
  const D = (n) => desDocs.find((d) => d.name === n);
  const staffDocs = []; let staffNo = 1;
  const mkStaff = (designation, extra = {}) => { const d = D(designation); const st = { _id: oid(), tenantId, staffId: `S${String(staffNo++).padStart(4, '0')}`, name: `${pick(FIRST)} ${pick(LAST)}`, gender: pick(['male', 'female']), phone: `9${between(100000000, 999999999)}`, designationId: d._id, joiningDate: `${between(2012, 2025)}-0${between(1, 9)}-${between(10, 28)}`, address: `${between(1, 99)}, ${pick(['Kalawad Road', 'Mavdi', 'Raiya Road', 'Gondal Road'])}, ${cfg.city}`, idProof: `XXXX-XXXX-${between(1000, 9999)}`, status: 'active', createdBy: adminId, ...extra }; st.bank = bankOf(st.name); st.statutory = idsOf(true); st.userId = oid(); staffDocs.push(st); return st; };
  for (const [name, n] of [['Sweeper', 12], ['Maid', 8], ['Gardener', 5], ['Security Guard', 6], ['Peon', 10], ['Office Clerk', 4], ['Lab Assistant', 4], ['PT Teacher', 3], ['Accountant', 2], ['School Counsellor', 1], ['School Nurse', 1], ['Computer Operator', 2], ['Transport Maintainer', 3], ...(EXTRA[cfg.code] || []).filter((e) => e.group === 'general').map((e) => [e.name, 3])]) for (let k = 0; k < n; k++) mkStaff(name);
  const driverNo = () => `GJ0320${between(10, 24)}${between(100000, 999999)}`;
  const busDocs = []; const rideDocs = [];
  const exp = (days) => addDays(today, days);
  for (let i = 0; i < busCount; i++) {
    const areas = shuffle(AREAS).slice(0, between(4, 6)); let t = 6 * 60 + 30 + between(0, 20);
    const stops = areas.map((name) => { const pickup = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; t += between(8, 14); return { name, pickupTime: pickup, dropTime: `${String(14 + Math.floor(between(0, 80) / 60)).padStart(2, '0')}:${String(between(0, 59)).padStart(2, '0')}` }; });
    const monthlyFare = Math.round(between(700, 1100) / 50) * 50; // default fare; farther stops pay more
    stops.forEach((st, k) => { st.fare = monthlyFare + (stops.length - 1 - k) * 100; });
    // every bus gets a driver (with a licence) and a conductor from the staff list; one running bus is left without a conductor on purpose
    const attendant = D('Bus Attendant') || D('Bus Helper');
    const crewD = mkStaff('Driver', { licenseNo: driverNo(), licenseExpiry: i % 9 === 4 ? exp(between(3, 25)) : i % 13 === 6 ? exp(-between(2, 30)) : exp(between(60, 700)) });
    const crewC = i === busCount - 2 ? null : mkStaff(attendant && i % 3 === 0 ? attendant.name : 'Conductor');
    const bus = { _id: oid(), tenantId, busNo: `${cfg.code.toUpperCase()}-${String(i + 1).padStart(2, '0')}`, registrationNo: `GJ03${pick(['AB', 'BT', 'XY', 'CD'])}${between(1000, 9999)}`, vehicleModel: pick(['Tata Starbus 40-seater', 'Eicher Skyline 42-seater', 'Ashok Leyland Lynx', 'Mahindra Cruzio 36-seater']), capacity: 42, status: i === busCount - 1 && i > 6 ? 'maintenance' : 'active',
      routeName: `Route ${i + 1} — ${areas[0]} to ${cfg.name.split(' ')[0]}`, startTime: stops[0].pickupTime, endTime: '08:05', monthlyFare, stops,
      driverId: crewD._id, conductorId: crewC?._id,
      insuranceExpiry: exp(between(25, 330)), fitnessExpiry: i % 7 === 3 ? exp(between(2, 20)) : i % 11 === 5 ? exp(-between(3, 15)) : exp(between(60, 300)), pollutionExpiry: exp(between(30, 200)) };
    busDocs.push(bus);
  }
  const running = busDocs.filter((b) => b.status === 'active');
  riders.forEach((st, i) => { const b = running[Math.floor(i / perBus) % running.length]; rideDocs.push({ tenantId, studentId: st._id, busId: b._id, stop: pick(b.stops).name, since: '2026-04-05', student: st }); });
  mkStaff('Driver', { licenseNo: driverNo(), licenseExpiry: exp(between(100, 600)) }); mkStaff('Conductor'); // spare crew, not yet on a bus
  // the Staff portal is the office desk: only the office clerks have a sign-in (staff.<code>.s0001 ...); everyone else is on the books and on payroll
  const deskStaff = staffDocs.filter((st) => D('Office Clerk') && String(st.designationId) === String(D('Office Clerk')._id)).slice(0, 2);
  deskStaff.forEach((st) => { st.canMarkAttendance = true; });
  staffDocs.forEach((st) => { if (!st.canMarkAttendance) delete st.userId; });
  await bulk(M.User, deskStaff.map((st) => ({ _id: st.userId, tenantId, role: 'staff', name: st.name, loginId: `${cfg.code}.${st.staffId.toLowerCase()}`, passwordHash: hashes.staff, mustChangePassword: false, status: 'active', failedLogins: 0, language: 'en', notificationPrefs: {}, createdBy: superAdmin })));
  await bulk(M.Designation, desDocs); await bulk(M.StaffMember, staffDocs);
  for (const d of desDocs.filter((x) => x.group === 'teaching')) await M.Teacher.updateMany({ tenantId, designation: d.name }, { designationId: d._id }); // every teacher's rank is one the school has registered await bulk(M.Counter, [{ tenantId, key: 'staff', seq: staffNo - 1 }]);
  await bulk(M.Bus, busDocs); await bulk(M.StudentTransport, rideDocs.map(({ student: _student, ...r }) => r));
  // monthly transport fare for every rider (Finance bills it; each rider pays like they pay tuition)
  const busOfRide = new Map(busDocs.map((b) => [String(b._id), b]));
  for (const ride of rideDocs) {
    const b = busOfRide.get(String(ride.busId)); const st = ride.student; const mode = beh.get(st) || { through: dueNow - 1 };
    const fare = b.stops.find((x) => x.name === ride.stop)?.fare ?? b.monthlyFare;
    const ts = MONTHS12.map((m) => mkCharge(st, null, `Transport fee — ${monthName(m)} (bus ${b.busNo}, ${ride.stop})`, 'Transport', fare, dueOf(m), { period: m }));
    charges.push(...ts);
    const paid = mode.advance ? ts : ts.slice(0, mode.through + 1);
    if (paid.length) settle(st, paid, mode.advance ? '2026-04-10' : addDays(paid[0].dueDate, between(0, 8)));
  }
  await bulk(M.StudentCharge, charges); await bulk(M.Payment, payments);
  await bulk(M.Counter, [{ tenantId, key: 'receipt:RCPT{YYYY}{SEQ:5}:2026', seq: rc }, { tenantId, key: 'admission:ADM{YYYY}{SEQ:4}:2026', seq: adm - 1 }]);
  stats.charges = charges.length; stats.payments = payments.length;
  stats.buses = busDocs.length; stats.riders = rideDocs.length; stats.staff = staffDocs.length;

  // ── payroll: pay levels, every teacher's salary, and the last three months of payroll (paid) ──
  const item = (label, kind, value) => ({ label, kind, value });
  const LEVELS = {
    PRT: { description: 'Primary Teacher', basic: 28000, allowances: [item('HRA', 'percent', 40), item('Transport', 'fixed', 2000)], deductions: [item('Provident Fund', 'percent', 12)] },
    TGT: { description: 'Trained Graduate Teacher', basic: 38000, allowances: [item('HRA', 'percent', 40), item('Transport', 'fixed', 2500), item('Special allowance', 'fixed', 3000)], deductions: [item('Provident Fund', 'percent', 12)] },
    PGT: { description: 'Post Graduate Teacher', basic: 50000, allowances: [item('HRA', 'percent', 40), item('Transport', 'fixed', 3000), item('Special allowance', 'fixed', 5000)], deductions: [item('Provident Fund', 'percent', 12), item('Professional tax', 'fixed', 200)] },
  };
  const levelDocs = Object.entries(LEVELS).map(([name, l], i) => ({ _id: oid(), tenantId, name, order: i + 1, status: 'active', ...l }));
  await bulk(M.PayLevel, levelDocs);
  const revOf = new Map();
  const revisions = teachers.map((t) => {
    const lv = levelDocs.find((l) => l.name === t.designation);
    const rev = { _id: oid(), tenantId, personType: 'teacher', personId: t._id, effectiveFrom: '2026-04-01', levelId: lv._id, levelName: lv.name, basic: lv.basic + Math.max(0, 2026 - Number(t.joiningDate.slice(0, 4))) * 350, allowances: lv.allowances, deductions: lv.deductions, reason: 'Annual salary setup', by: adminId, byName: 'Principal Office' };
    revOf.set(String(t._id), rev); return rev;
  });
  // non-teaching and transport staff: three pay levels, one salary each
  const STAFF_LEVELS = {
    'Skilled Support': { description: 'Drivers and office clerks', basic: 18000, allowances: [item('Conveyance', 'fixed', 1200)], deductions: [item('Provident Fund', 'percent', 12)], desig: ['Driver', 'Office Clerk'] },
    'Semi-skilled Support': { description: 'Conductors, guards, lab and maintenance staff', basic: 14000, allowances: [item('Conveyance', 'fixed', 800)], deductions: [item('Provident Fund', 'percent', 12)], desig: ['Conductor', 'Bus Attendant', 'Bus Helper', 'Security Guard', 'Lab Assistant', 'Transport Maintainer', 'Electrician'] },
    'Support Staff': { description: 'Maids, sweepers, gardeners and helpers', basic: 11000, allowances: [], deductions: [item('Provident Fund', 'percent', 12)], desig: ['Maid', 'Sweeper', 'Gardener', 'Peon', 'Canteen Helper', 'Groundsman', 'Hostel Warden'] },
  };
  const staffLevelDocs = Object.entries(STAFF_LEVELS).map(([name, l], i) => ({ _id: oid(), tenantId, name, order: 10 + i, appliesTo: 'non_teaching', status: 'active', description: l.description, basic: l.basic, allowances: l.allowances, deductions: l.deductions, desig: l.desig }));
  await bulk(M.PayLevel, staffLevelDocs.map(({ desig: _d, ...l }) => l));
  const desName = (st) => desDocs.find((d) => String(d._id) === String(st.designationId));
  const staffRevs = staffDocs.map((st) => {
    const lv = staffLevelDocs.find((l) => l.desig.includes(desName(st)?.name)) || staffLevelDocs[2];
    const rev = { _id: oid(), tenantId, personType: 'staff', personId: st._id, effectiveFrom: '2026-04-01', levelId: lv._id, levelName: lv.name, basic: lv.basic + Math.max(0, 2026 - Number(st.joiningDate.slice(0, 4))) * 150, allowances: lv.allowances, deductions: lv.deductions, reason: 'Annual salary setup', by: adminId, byName: 'Principal Office' };
    revOf.set(String(st._id), rev); return rev;
  });
  await bulk(M.SalaryRevision, [...revisions, ...staffRevs]);
  const months = [3, 2, 1].map((k) => { const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - k); return d.toISOString().slice(0, 7); });
  const unpaidLeaves = []; const unpaidBy = new Map(); const unpaidDates = new Map();
  const lastWork = workingDates(settings, months[2], new Set([hol]));
  for (const t of shuffle(teachers).slice(0, Math.max(4, Math.round(teachers.length * 0.07)))) {
    const at = between(0, lastWork.length - 3); const len = between(1, 2);
    const days = lastWork.slice(at, at + len);
    unpaidBy.set(String(t._id), len); unpaidDates.set(String(t._id), new Set(days));
    unpaidLeaves.push({ tenantId, teacherId: t._id, userId: t.userId, leaveType: 'unpaid', startDate: days[0], endDate: days[len - 1], days: len, reason: 'Personal work', status: 'approved', decisionBy: adminId, decidedAt: new Date() });
  }
  await bulk(M.LeaveApplication, unpaidLeaves);

  // ── daily staff attendance for the last 45 days: teachers and general staff by the admin, transport staff by the officer ──
  const attDays = []; for (let b = 45; b >= 1; b--) { const d = addDays(today, -b); if (isoDay(d) !== 7 && d !== hol) attDays.push(d); }
  const groupOfStaff = (st) => desName(st)?.group === 'transport' ? 'transport' : 'general';
  const REGISTERS = [['teachers', teachers.map((t) => ({ type: 'teacher', id: t._id }))], ['general', staffDocs.filter((x) => groupOfStaff(x) === 'general').map((x) => ({ type: 'staff', id: x._id }))], ['transport', staffDocs.filter((x) => groupOfStaff(x) === 'transport').map((x) => ({ type: 'staff', id: x._id }))]];
  // some staff took leave in these weeks (a quarter of it unpaid); their register shows "leave" on those days
  const staffLeaves = []; const staffLeaveDays = new Map(); const staffUnpaid = new Map();
  for (const st of shuffle(staffDocs).slice(0, Math.max(8, Math.round(staffDocs.length * 0.12)))) {
    const at = between(3, attDays.length - 4); const len = between(1, 2); const days = attDays.slice(at, at + len); const type = rnd() < 0.25 ? 'unpaid' : pick(['sick', 'casual']);
    staffLeaves.push({ tenantId, staffId: st._id, userId: st.userId, group: groupOfStaff(st), leaveType: type, startDate: days[0], endDate: days[days.length - 1], days: days.length, reason: type === 'sick' ? 'Not well' : 'Family work', status: 'approved', decisionBy: adminId, decidedAt: new Date() });
    staffLeaveDays.set(String(st._id), new Set(days)); if (type === 'unpaid') staffUnpaid.set(String(st._id), days);
  }
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const regPunches = [];
  const attOf = new Map(); const regSessions = []; const regRecords = [];
  for (const [group, people] of REGISTERS) {
    for (const date of attDays) {
      const sid = oid();
      regSessions.push({ _id: sid, tenantId, group, date, status: 'submitted', markedBy: group === 'transport' ? trId : adminId, submittedBy: group === 'transport' ? trId : adminId, submittedAt: new Date(`${date}T16:00:00Z`) });
      for (const p of people) {
        const onLeave = unpaidDates.get(String(p.id))?.has(date) || staffLeaveDays.get(String(p.id))?.has(date); const r = rnd();
        const status = onLeave ? 'leave' : r < 0.025 ? 'absent' : r < 0.04 ? 'half_day' : r < 0.07 ? 'late' : 'present';
        // the clock: arrival and departure, as a biometric machine or self check-in would have recorded them
        const times = status === 'absent' || status === 'leave' ? {} : status === 'late' ? { checkIn: hhmm(between(8 * 60 + 15, 9 * 60 + 10)), checkOut: hhmm(between(15 * 60, 15 * 60 + 40)) }
          : status === 'half_day' ? { checkIn: hhmm(between(7 * 60 + 50, 8 * 60 + 5)), checkOut: hhmm(between(11 * 60 + 30, 12 * 60 + 30)) } : { checkIn: hhmm(between(7 * 60 + 40, 8 * 60 + 8)), checkOut: hhmm(between(15 * 60, 15 * 60 + 40)) };
        regRecords.push({ tenantId, sessionId: sid, group, date, personType: p.type, personId: p.id, status, remark: onLeave ? 'Approved leave' : undefined, ...times, history: [] });
        if (times.checkIn) regPunches.push({ tenantId, personType: p.type, personId: p.id, group, date, ...times, source: rnd() < 0.8 ? 'import' : 'self' });
        if (!attOf.has(String(p.id))) attOf.set(String(p.id), new Map());
        attOf.get(String(p.id)).set(date, status);
      }
    }
  }
  await bulk(M.StaffAttendanceSession, regSessions); await bulk(M.StaffAttendanceRecord, regRecords); await bulk(M.StaffPunch, regPunches); await bulk(M.StaffLeave, staffLeaves);
  stats.staffRegisters = regSessions.length;
  // days a person is not paid for in a month, from the registers (a day absent = 1, a half day = 0.5)
  const lopDays = (id, work) => { const m = attOf.get(String(id)); let n = 0; if (m) for (const d of work) { const st = m.get(d); if (st === 'absent') n += 1; else if (st === 'half_day') n += 0.5; } return n; };

  const runs = []; const payslips = [];
  for (const [mi, month] of months.entries()) {
    const run = { _id: oid(), tenantId, month, status: 'paid', generatedBy: adminId, approvedBy: adminId, approvedAt: new Date(), paidAt: new Date(), skipped: [] };
    const work = workingDates(settings, month, new Set([hol]));
    run.workingDays = work.length; const tot = { count: 0, gross: 0, deductions: 0, net: 0, paid: 0 };
    const next = new Date(`${month}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
    const paidOn = `${next.toISOString().slice(0, 7)}-0${between(1, 5)}`;
    const people = [...teachers.map((t) => ({ type: 'teacher', id: t._id, userId: t.userId, name: t.name, code: t.employeeId, designation: t.designation })), ...staffDocs.map((st) => ({ type: 'staff', id: st._id, name: st.name, code: st.staffId, designation: desName(st)?.name }))];
    for (const t of people) {
      // only the most recent month overlaps the 45 days of registers
      const unpaid = mi === 2 ? (unpaidBy.get(String(t.id)) || 0) + lopDays(t.id, work) + (staffUnpaid.get(String(t.id))?.filter((d) => work.includes(d)).length || 0) : 0;
      const calc = computePayslip({ revision: revOf.get(String(t.id)), workingDays: work.length, unpaidDays: unpaid, policy: settings.statutory });
      payslips.push({ tenantId, runId: run._id, month, payslipNo: `PAY${month.replace('-', '')}-${t.code}`, personType: t.type, personId: t.id, userId: t.userId, personName: t.name, employeeId: t.code, designation: t.designation, levelName: revOf.get(String(t.id)).levelName, ...calc, adjustments: [], status: 'paid', paidOn: paidOn <= today ? paidOn : today, mode: 'bank_transfer', reference: `NEFT${between(10000000, 99999999)}`, paidBy: adminId });
      tot.count++; tot.gross += calc.gross; tot.deductions += calc.totalDeductions; tot.net += calc.net; tot.paid += calc.net;
    }
    run.totals = Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, k === 'count' ? v : round2(v)]));
    runs.push(run);
  }
  await bulk(M.PayrollRun, runs); await bulk(M.Payslip, payslips);
  stats.payslips = payslips.length;

  // ── leave + audit trail marker ──
  await bulk(M.AuditLog, [{ tenantId, actorId: superAdmin, actorName: 'Platform Admin', actorRole: 'super_admin', actingAsSuperAdmin: true, action: 'school.created', entityType: 'School', entityId: String(tenantId), summary: `Bulk-loaded ${cfg.name}` }]);
  log(`  ${cfg.name}: ${stats.students} students, ${stats.teachers} teachers, ${stats.sections} sections, ${stats.timetable} timetable periods${unplaced ? ` (${unplaced} periods unplaced)` : ''}, ${stats.attendanceRecords} attendance records, ${stats.marks} marks, ${stats.charges} charges, ${stats.payments} payments, ${stats.payslips} payslips, ${stats.staffRegisters} staff registers, ${stats.buses} buses (${stats.riders} riders), ${stats.staff} non-teaching staff, ${stats.books} books / ${stats.copies} copies, ${stats.loans} loans  [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
  return stats;
}

async function main() {
  await mongoose.connect(requireMongoUri(), { serverSelectionTimeoutMS: 15000 }).catch((e) => { console.error(`Cannot reach MongoDB. Check MONGO_URI in .env and the Atlas network access list.\n(${e.message})`); process.exit(1); });
  if (wipe) {
    // dropping a database is irreversible: make the operator type the database name
    const name = mongoose.connection.name;
    if (process.env.CONFIRM_WIPE !== name) { console.error(`--wipe will DROP the whole "${name}" database on ${mongoose.connection.host}.\nIf that is what you want, run again with CONFIRM_WIPE=${name}`); process.exit(1); }
    await mongoose.connection.dropDatabase(); log('Database dropped.');
  }
  await mongoose.syncIndexes();
  const existing = await M.School.find({ code: { $in: SCHOOLS.map((s) => s.code) } }).select('code');
  if (existing.length) { console.error(`Already loaded: ${existing.map((s) => s.code).join(', ')}. Run with --wipe to start over (drops the whole database).`); process.exit(1); }
  log('Hashing passwords…');
  const hashes = Object.fromEntries(await Promise.all(Object.entries(PASSWORDS).map(async ([k, v]) => [k, await bcrypt.hash(v, config.bcryptRounds)])));
  let root = await M.User.findOne({ role: 'super_admin' });
  if (!root) root = await M.User.create({ role: 'super_admin', loginId: 'superadmin@erp.local', name: 'Platform Admin', passwordHash: hashes.super, mustChangePassword: false });
  log('Loading schools…');
  const t = Date.now();
  for (const cfg of SCHOOLS) await buildSchool(cfg, hashes, root._id);
  log(`Done in ${((Date.now() - t) / 1000).toFixed(0)}s.\n`);
  log('Sign in (each role has its own page, e.g. /admin/login, /teacher/login, /student/login):');
  log(`  Platform Admin : ${root.loginId} / ${PASSWORDS.super}`);
  for (const c of SCHOOLS) log(`  ${c.name}\n    admin@${c.code}.school / ${PASSWORDS.admin} · finance@${c.code}.school / ${PASSWORDS.finance} · library@${c.code}.school / ${PASSWORDS.library} · transport@${c.code}.school / ${PASSWORDS.transport}\n    teachers ${c.code}.t0001 … / ${PASSWORDS.teacher} · students ${c.code}.adm20260001 … / ${PASSWORDS.student}`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
