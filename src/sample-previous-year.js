/**
 * SAMPLE DATA: gives a school an earlier academic year so a student's past results can be checked in the app.
 * For the classes you name (default UKG, Class 1, Class 2) it takes every student now in that class and puts them in the PREVIOUS class
 * of the PREVIOUS year (promoted since), with the six standard examinations of that year (Unit Tests 1-4, Half-Yearly, Final Exam) and a
 * published result for each. Everything is additive and re-runnable: an examination or enrolment that already exists is left alone.
 * The results are invented, so use it only on test data. Marked "Sample data" on the examinations.
 *
 *   node src/sample-previous-year.js dpsr                 (uses MONGO_URI from .env; add classes: node src/sample-previous-year.js dpsr "UKG,Class 1")
 */
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import * as M from './models/index.js';
import { gradeFor } from './services/context.js';
import { STANDARD_EXAMS } from './modules/exams/datesheet.service.js';
import { GRADES } from './core/grades.js';

const clip = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = (n) => Math.round(n * 100) / 100;
const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };
const shiftYear = (d, n) => `${Number(d.slice(0, 4)) + n}${d.slice(4)}`;

/** The class a student was in the year before: the one just below it (a Class 12 stream follows the same stream in Class 11; Class 11 follows Class 10). */
export function previousClassName(name) {
  const g = GRADES.find((x) => x.name === name);
  if (!g) return null;
  if (g.stream && g.level === 12) return GRADES.find((x) => x.level === 11 && x.stream === g.stream)?.name;
  if (g.stream && g.level === 11) return 'Class 10';
  const plain = GRADES.filter((x) => !x.stream);
  const i = plain.findIndex((x) => x.name === name);
  return i > 0 ? plain[i - 1].name : null; // LKG is where everyone starts: nothing before it
}

export async function addPreviousYear({ tenantId, classNames = ['UKG', 'Class 1', 'Class 2'], log = () => {} }) {
  const school = await M.School.findById(tenantId).lean();
  if (!school) throw new Error('School not found');
  const current = await M.AcademicYear.findOne({ tenantId, isCurrent: true });
  if (!current) throw new Error('The school has no current academic year');
  const start = shiftYear(current.startDate, -1); const end = shiftYear(current.endDate, -1);
  const name = `${start.slice(0, 4)}-${end.slice(0, 4)}`;
  let prev = await M.AcademicYear.findOne({ tenantId, name });
  if (!prev) prev = await M.AcademicYear.create({ tenantId, name, startDate: start, endDate: end, isCurrent: false, status: 'closed' });
  const admin = await M.User.findOne({ tenantId, role: 'school_admin' }).select('_id').lean();
  const grading = school.settings?.grading;
  const out = { year: prev.name, classes: [], students: 0, enrolments: 0, exams: 0, reportCards: 0 };

  const classes = await M.ClassModel.find({ tenantId }).lean();
  const byName = new Map(classes.map((c) => [c.name, c]));
  const prevClasses = [];
  for (const cn of classNames) {
    const now = byName.get(cn); const pn = previousClassName(cn);
    if (!now) { log(`skip ${cn}: the school has no such class`); continue; }
    if (!pn) { log(`skip ${cn}: nothing comes before it`); continue; }
    let pc = byName.get(pn);
    if (!pc) { const g = GRADES.find((x) => x.name === pn); pc = (await M.ClassModel.create({ tenantId, name: pn, level: g.level, stream: g.stream })).toObject(); byName.set(pn, pc); }

    // the subjects of the earlier class (or, when it has none recorded, the same subjects as the class above it)
    let offs = await M.SubjectOffering.find({ tenantId, classId: pc._id }).sort({ createdAt: -1 }).lean();
    if (!offs.length) {
      const src = await M.SubjectOffering.find({ tenantId, classId: now._id }).lean();
      offs = await M.SubjectOffering.insertMany(src.map((o) => ({ tenantId, yearId: prev._id, classId: pc._id, subjectId: o.subjectId, weeklyPeriods: o.weeklyPeriods, assessment: o.assessment })));
      offs = offs.map((o) => o.toObject());
    }
    if (!offs.length) { log(`skip ${cn}: no subjects are set up for it`); continue; }

    // sections of the earlier class carry the same letters as today's
    const nowSections = await M.Section.find({ tenantId, yearId: current._id, classId: now._id }).lean();
    const secOf = new Map();
    for (const s of nowSections) {
      let ps = await M.Section.findOne({ tenantId, yearId: prev._id, classId: pc._id, name: s.name });
      if (!ps) ps = await M.Section.create({ tenantId, yearId: prev._id, classId: pc._id, name: s.name, capacity: s.capacity || 45, room: s.room });
      secOf.set(String(s._id), ps);
    }
    const cur = await M.StudentEnrolment.find({ tenantId, yearId: current._id, classId: now._id, status: 'active' }).lean();
    const have = new Set((await M.StudentEnrolment.find({ tenantId, yearId: prev._id, studentId: { $in: cur.map((e) => e.studentId) } }).select('studentId').lean()).map((e) => String(e.studentId)));
    const roll = new Map(); const rows = [];
    for (const e of cur) {
      if (have.has(String(e.studentId))) continue;
      const ps = secOf.get(String(e.sectionId)); if (!ps) continue;
      roll.set(String(ps._id), (roll.get(String(ps._id)) || 0) + 1);
      rows.push({ tenantId, studentId: e.studentId, yearId: prev._id, classId: pc._id, sectionId: ps._id, rollNo: roll.get(String(ps._id)), startDate: start, endDate: end, status: 'promoted' });
    }
    if (rows.length) await M.StudentEnrolment.insertMany(rows, { ordered: false });
    out.enrolments += rows.length;
    prevClasses.push({ cls: pc, offs, current: now });
    out.classes.push(`${pn} (was ${cn})`);
  }
  if (!prevClasses.length) return out;

  // the six standard examinations of that year, for those classes, with a published result for everyone
  const subjects = new Map((await M.Subject.find({ tenantId }).select('name code').lean()).map((s) => [String(s._id), s]));
  const enr = await M.StudentEnrolment.find({ tenantId, yearId: prev._id, classId: { $in: prevClasses.map((p) => p.cls._id) } }).lean();
  const students = new Map((await M.Student.find({ tenantId, _id: { $in: enr.map((e) => e.studentId) } }).select('name admissionNo').lean()).map((s) => [String(s._id), s]));
  out.students = enr.length;
  let d = new Date(`${start.slice(0, 4)}-06-15T00:00:00Z`);
  for (const [xi, spec] of STANDARD_EXAMS.entries()) {
    const from = new Date(d); from.setUTCDate(from.getUTCDate() + xi * 50);
    const day = (n) => new Date(from.getTime() + n * 86400000).toISOString().slice(0, 10);
    let exam = await M.Examination.findOne({ tenantId, yearId: prev._id, name: spec.name, sectionId: { $exists: false } });
    const fresh = !exam;
    if (!exam) {
      exam = await M.Examination.create({ tenantId, yearId: prev._id, name: spec.name, type: spec.type, classIds: prevClasses.map((p) => p.cls._id), startDate: day(0), endDate: day(5), marksDeadline: day(12), status: 'scheduled', schedulePublished: true, createdByName: 'Sample data' });
      out.exams += 1;
    }
    if (!fresh) continue; // an examination that was already there keeps what it has
    const drift = [0, 0.03, -0.02, 0.04, 0.02, 0.05][xi] ?? 0;
    const es = new Map(); const exSubjects = [];
    for (const { cls, offs } of prevClasses) {
      let k = 0;
      for (const o of offs) {
        const comps = o.assessment?.components?.length ? o.assessment.components : [{ key: 'marks', label: 'Marks', max: 100 }];
        const doc = { tenantId, examId: exam._id, classId: cls._id, subjectId: o.subjectId, date: day(k++), startTime: '09:00', endTime: '11:00', room: 'Exam Hall', components: comps, passMarks: o.assessment?.passMarks ?? 33, marksDeadline: day(12) };
        exSubjects.push(doc); es.set(`${cls._id}:${o.subjectId}`, doc);
      }
    }
    await M.ExaminationSubject.insertMany(exSubjects);
    const cards = [];
    for (const e of enr) {
      const st = students.get(String(e.studentId)); if (!st) continue;
      const pcs = prevClasses.find((p) => String(p.cls._id) === String(e.classId));
      const ability = 0.45 + hash(`${e.studentId}`) * 0.5; // each student has a steady level, with the year's ups and downs on top
      const rowsOut = pcs.offs.map((o) => {
        const doc = es.get(`${pcs.cls._id}:${o.subjectId}`);
        const max = doc.components.reduce((n, c) => n + c.max, 0);
        let total = 0;
        const comps = doc.components.map((c) => { const v = Math.round(c.max * clip(ability + drift + (hash(`${e.studentId}${o.subjectId}${xi}${c.key}`) - 0.5) * 0.3, 0.05, 1)); total += v; return { key: c.key, label: c.label, max: c.max, value: v }; });
        const pct = r2((total / max) * 100);
        return { subject: subjects.get(String(o.subjectId))?.name, code: subjects.get(String(o.subjectId))?.code, components: comps, obtained: total, max, absent: false, exempt: false, remarks: '', teacher: '', percentage: pct, grade: gradeFor(pct, grading), passed: pct >= doc.passMarks };
      });
      const got = rowsOut.reduce((n, r) => n + r.obtained, 0); const mx = rowsOut.reduce((n, r) => n + r.max, 0); const pct = r2((got / mx) * 100);
      cards.push({ tenantId, examId: exam._id, studentId: e.studentId, enrolmentId: e._id, sectionId: e.sectionId, classId: e.classId, yearId: prev._id, version: 1, isCurrent: true, publishedAt: new Date(`${day(14)}T10:00:00Z`), publishedBy: admin?._id,
        snapshot: { exam: { id: exam._id, name: exam.name, type: exam.type }, student: { id: e.studentId, name: st.name, admissionNo: st.admissionNo }, subjects: rowsOut, totalObtained: got, totalMax: mx, percentage: pct, grade: gradeFor(pct, grading), resultStatus: rowsOut.every((r) => r.passed) ? 'pass' : 'fail', attendance: { percentage: null, present: 0, absent: 0, workingDays: 0 }, teacherRemark: '', principalRemark: '' } });
    }
    for (let i = 0; i < cards.length; i += 1000) await M.ReportCard.insertMany(cards.slice(i, i + 1000), { ordered: false });
    out.reportCards += cards.length;
  }
  return out;
}

// ── command line ──
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [code, classList] = process.argv.slice(2);
  if (!code) { console.error('Usage: node src/sample-previous-year.js <school code> ["UKG,Class 1,Class 2"]'); process.exit(1); }
  const { requireMongoUri } = await import('./core/config.js');
  await mongoose.connect(requireMongoUri());
  const school = await M.School.findOne({ code });
  if (!school) { console.error(`No school with code "${code}"`); process.exit(1); }
  const r = await addPreviousYear({ tenantId: school._id, classNames: classList ? classList.split(',').map((s) => s.trim()) : undefined, log: (m) => console.log(m) });
  console.log(JSON.stringify(r, null, 2));
  const sample = await M.StudentEnrolment.findOne({ tenantId: school._id, status: 'promoted' }).sort({ createdAt: -1 }).lean();
  const st = sample && await M.Student.findById(sample.studentId).select('name userId').lean();
  const u = st?.userId && await M.User.findById(st.userId).select('loginId').lean();
  if (u) console.log(`Sign in as the student ${st.name}: ${u.loginId} (the usual student password) and open Results and class ranks, then choose the year ${r.year}.`);
  await mongoose.disconnect();
}
