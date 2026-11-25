import PDFDocument from 'pdfkit';
import { Examination, ExaminationSubject, ReportCard, Subject, StudentEnrolment, Student, Section, ClassModel, AcademicYear, School } from '../../models/index.js';
import { loadLook } from '../../services/documents/look.js';
import { drawReportCard } from '../../services/documents/reportcard.js';
import { notFound, daysBetween, round1 } from '../../core/utils.js';
import { submittedRecords, summarize, studentCounts, summarizeCounts } from '../../services/attendance.js';

const classIdsOf = (ctx) => [...new Set(ctx.enrolments.map((e) => String(e.classId)))];

export async function schedule(ctx) {
  const exams = (await Examination.find({ tenantId: ctx.tenantId, yearId: ctx.year._id, schedulePublished: true, status: { $ne: 'archived' } }).lean())
    .filter((e) => !e.sectionId || ctx.sectionIds.includes(String(e.sectionId))); // a teacher's class test shows only to that section
  const ess = await ExaminationSubject.find({ tenantId: ctx.tenantId, examId: { $in: exams.map((e) => e._id) }, classId: { $in: classIdsOf(ctx) } }).lean();
  const subjects = new Map((await Subject.find({ tenantId: ctx.tenantId, _id: { $in: ess.map((e) => e.subjectId) } }).select('name').lean()).map((s) => [String(s._id), s.name]));
  const en = new Map(exams.map((e) => [String(e._id), e.name]));
  const examType = new Map(exams.map((e) => [String(e._id), e.type]));
  return ess.filter((e) => e.date).map((e) => {
    const left = daysBetween(ctx.today, e.date);
    return { id: e._id, examId: e.examId, exam: en.get(String(e.examId)), type: examType.get(String(e.examId)), subject: subjects.get(String(e.subjectId)), date: e.date, startTime: e.startTime, endTime: e.endTime, room: e.room, daysLeft: left, state: left < 0 ? 'completed' : left === 0 ? 'today' : 'upcoming' };
  }).sort((a, b) => a.date.localeCompare(b.date) || (a.startTime || '').localeCompare(b.startTime || ''));
}

/** Student results come only from published, immutable report cards — never from draft marks. */
export async function currentCards(ctx) {
  return ReportCard.find({ tenantId: ctx.tenantId, studentId: ctx.student._id, yearId: ctx.year._id, isCurrent: true }).sort({ publishedAt: 1 }).lean();
}

export async function resultsList(ctx) {
  const [cards, allExams] = await Promise.all([currentCards(ctx), Examination.find({ tenantId: ctx.tenantId, yearId: ctx.year._id, status: { $ne: 'archived' } }).lean()]);
  const exams = allExams.filter((e) => !e.sectionId || ctx.sectionIds.includes(String(e.sectionId)));
  const upcoming = await schedule(ctx);
  const cardByExam = new Map(cards.map((c) => [String(c.examId), c]));
  const rows = exams.filter((e) => cardByExam.has(String(e._id)) || (e.schedulePublished && upcoming.some((u) => String(u.examId) === String(e._id)))).map((e) => {
    const c = cardByExam.get(String(e._id));
    const dates = upcoming.filter((u) => String(u.examId) === String(e._id)).map((u) => u.date).sort();
    return {
      examId: e._id, name: e.name, type: e.type, date: dates[0] || e.startDate, status: c ? 'published' : 'upcoming', percentage: c?.snapshot.percentage ?? null, grade: c?.snapshot.grade ?? null,
      resultStatus: c?.snapshot.resultStatus ?? null, cardId: c?._id, version: c?.version,
    };
  });
  return rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

export async function resultDetail(ctx, examId) {
  const c = await ReportCard.findOne({ tenantId: ctx.tenantId, studentId: ctx.student._id, examId, isCurrent: true }).lean();
  if (!c) throw notFound('Result not published');
  return { id: c._id, version: c.version, publishedAt: c.publishedAt, correctionReason: c.correctionReason, ...c.snapshot };
}

export async function performance(ctx, { examId } = {}) {
  const cards = await currentCards(ctx);
  const trend = cards.map((c) => ({ exam: c.snapshot.exam.name, examId: c.examId, percentage: c.snapshot.percentage, grade: c.snapshot.grade }));
  const latest = (examId && cards.find((c) => String(c.examId) === String(examId))) || cards[cards.length - 1];
  const previous = latest ? cards[cards.indexOf(latest) - 1] : null;
  const subjectWise = latest ? latest.snapshot.subjects.filter((s) => s.percentage != null).map((s) => ({ subject: s.subject, percentage: s.percentage, grade: s.grade })) : [];
  const gradeCounts = {};
  latest?.snapshot.subjects.forEach((s) => { if (s.grade) gradeCounts[s.grade] = (gradeCounts[s.grade] || 0) + 1; });
  const improvement = latest && previous ? latest.snapshot.subjects.filter((s) => s.percentage != null).map((s) => {
    const prev = previous.snapshot.subjects.find((p) => p.code === s.code);
    return prev?.percentage != null ? { subject: s.subject, latest: s.percentage, previous: prev.percentage, change: round1(s.percentage - prev.percentage) } : null;
  }).filter(Boolean) : [];
  const recs = await submittedRecords(ctx.tenantId, { studentId: ctx.student._id, yearId: ctx.year._id });
  const by = new Map();
  recs.forEach((r) => { const k = r.date.slice(0, 7); if (!by.has(k)) by.set(k, []); by.get(k).push(r); });
  const attendanceTrend = [...by.keys()].sort().map((month) => ({ month, percentage: summarize(by.get(month), ctx.settings).percentage }));
  return {
    trend, latestExam: latest ? { id: latest.examId, name: latest.snapshot.exam.name } : null, subjectWise,
    gradeDistribution: Object.entries(gradeCounts).map(([grade, count]) => ({ grade, count })), attendanceTrend, improvement,
    exams: cards.map((c) => ({ id: c.examId, name: c.snapshot.exam.name })),
  };
}

export async function dashboardResult(ctx) {
  const cards = await currentCards(ctx);
  const latest = cards[cards.length - 1];
  if (!latest) return null;
  return { examId: latest.examId, exam: latest.snapshot.exam.name, percentage: latest.snapshot.percentage, grade: latest.snapshot.grade, resultStatus: latest.snapshot.resultStatus, subjects: latest.snapshot.subjects.map((s) => ({ subject: s.subject, percentage: s.percentage, grade: s.grade })) };
}

/** Everything the printed report card says: the immutable snapshot, plus the class, roll number, rank and guardian as they are now. */
async function reportCardDocument(card) {
  const sn = card.snapshot;
  const [cls, sec, year, enr, student, peers, school] = await Promise.all([
    card.classId ? ClassModel.findById(card.classId).select('name').lean() : null, card.sectionId ? Section.findById(card.sectionId).select('name').lean() : null,
    card.yearId ? AcademicYear.findById(card.yearId).select('name').lean() : null, card.enrolmentId ? StudentEnrolment.findById(card.enrolmentId).select('rollNo').lean() : null,
    Student.findById(card.studentId).select('dob guardians').lean(),
    ReportCard.find({ tenantId: card.tenantId, examId: card.examId, sectionId: card.sectionId, isCurrent: true }).select('snapshot.percentage').lean(),
    School.findById(card.tenantId).select('settings.grading').lean(),
  ]);
  const g = school?.settings?.grading || {};
  const att = sn.attendance || {};
  return {
    examName: sn.exam.name, yearName: year?.name, version: card.version, correctionReason: card.correctionReason,
    name: sn.student.name, admissionNo: sn.student.admissionNo, classLine: [cls?.name, sec?.name].filter(Boolean).join(' · '), rollNo: enr?.rollNo != null ? String(enr.rollNo).padStart(2, '0') : null,
    dob: student?.dob, guardian: student?.guardians?.[0]?.name, attendanceLine: att.percentage != null ? `${att.percentage}% · ${att.present} of ${att.workingDays} days` : null,
    issuedOn: (card.publishedAt || new Date()).toISOString().slice(0, 10), generatedOn: new Date().toISOString().slice(0, 10),
    subjects: sn.subjects || [], totalObtained: sn.totalObtained, totalMax: sn.totalMax, percentage: sn.percentage, grade: sn.grade, resultStatus: sn.resultStatus,
    rank: peers.length ? 1 + peers.filter((p) => (p.snapshot?.percentage ?? 0) > (sn.percentage ?? 0)).length : null, outOf: peers.length,
    teacherRemark: sn.teacherRemark, principalRemark: sn.principalRemark, scale: g.scale, passPercentage: g.passPercentage,
  };
}

/** The report card as a PDF, in the school's own letterhead and colour (see services/documents/reportcard.js). */
export async function renderReportCardPdf(card, res) {
  const [look, data] = await Promise.all([loadLook(card.tenantId), reportCardDocument(card)]);
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Report card ${data.name} ${data.examName}` } });
  doc.pipe(res);
  drawReportCard(doc, look, data);
  doc.end();
}

// ── whole-class view: every test held for the student's class, with all students' results and their rank ──
/** Competition ranking by percentage (ties share a rank). */
function rankOf(cards, studentId) {
  const mine = cards.find((c) => String(c.studentId) === String(studentId));
  if (!mine) return null;
  return 1 + cards.filter((c) => (c.snapshot.percentage ?? 0) > (mine.snapshot.percentage ?? 0)).length;
}
const attempted = (card) => (card.snapshot.subjects || []).some((s) => !s.absent);

async function visibleClassExams(ctx) {
  const classIds = [...new Set(ctx.enrolments.map((e) => String(e.classId)))];
  const exams = (await Examination.find({ tenantId: ctx.tenantId, yearId: ctx.year._id, status: { $ne: 'archived' }, classIds: { $in: classIds } }).lean())
    .filter((e) => !e.sectionId || ctx.sectionIds.includes(String(e.sectionId)));
  const cards = await ReportCard.find({ tenantId: ctx.tenantId, examId: { $in: exams.map((e) => e._id) }, sectionId: { $in: ctx.sectionIds }, isCurrent: true }).lean();
  // an unannounced test stays hidden until its results are published
  return { exams: exams.filter((e) => e.schedulePublished || cards.some((c) => String(c.examId) === String(e._id))), cards };
}

export async function classExams(ctx) {
  const { exams, cards } = await visibleClassExams(ctx);
  const ess = await ExaminationSubject.find({ tenantId: ctx.tenantId, examId: { $in: exams.map((e) => e._id) } }).select('examId date subjectId').lean();
  const subjects = new Map((await Subject.find({ tenantId: ctx.tenantId, _id: { $in: ess.map((x) => x.subjectId) } }).select('name').lean()).map((x) => [String(x._id), x.name]));
  return exams.map((e) => {
    const list = cards.filter((c) => String(c.examId) === String(e._id));
    const mine = list.find((c) => String(c.studentId) === String(ctx.student._id));
    const dates = ess.filter((x) => String(x.examId) === String(e._id) && x.date).map((x) => x.date).sort();
    const published = list.length > 0;
    return {
      examId: e._id, name: e.name, type: e.type, date: dates[0] || e.startDate, subjects: [...new Set(ess.filter((x) => String(x.examId) === String(e._id)).map((x) => subjects.get(String(x.subjectId))))],
      status: published ? 'published' : (dates[0] || e.startDate || '9999') >= ctx.today ? 'upcoming' : 'awaiting_results',
      classSize: published ? list.length : null, attempted: mine ? attempted(mine) : false, hasResult: !!mine,
      myRank: mine ? rankOf(list, ctx.student._id) : null, myPercentage: mine?.snapshot.percentage ?? null, myGrade: mine?.snapshot.grade ?? null,
    };
  }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

export async function classExamDetail(ctx, examId) {
  const { exams, cards } = await visibleClassExams(ctx);
  const exam = exams.find((e) => String(e._id) === String(examId));
  if (!exam) throw notFound('Test not found for your class');
  const list = cards.filter((c) => String(c.examId) === String(examId));
  if (!list.length) return { exam: { id: exam._id, name: exam.name, type: exam.type }, published: false, rows: [], subjects: [] };
  const enr = await StudentEnrolment.find({ tenantId: ctx.tenantId, studentId: { $in: list.map((c) => c.studentId) }, sectionId: { $in: ctx.sectionIds } }).select('studentId rollNo').lean();
  const rolls = new Map(enr.map((e) => [String(e.studentId), e.rollNo]));
  const names = new Map((await Student.find({ tenantId: ctx.tenantId, _id: { $in: list.map((c) => c.studentId) } }).select('name').lean()).map((s) => [String(s._id), s.name]));
  const subjectCols = [...new Map(list.flatMap((c) => c.snapshot.subjects).map((s) => [s.code, { code: s.code, subject: s.subject, max: s.max }])).values()];
  const rows = list.map((c) => ({
    rank: rankOf(list, c.studentId), studentId: c.studentId, name: names.get(String(c.studentId)), rollNo: rolls.get(String(c.studentId)), isMe: String(c.studentId) === String(ctx.student._id),
    attempted: attempted(c), percentage: c.snapshot.percentage, grade: c.snapshot.grade, obtained: c.snapshot.totalObtained, max: c.snapshot.totalMax, result: c.snapshot.resultStatus,
    marks: Object.fromEntries(c.snapshot.subjects.map((s) => [s.code, { obtained: s.obtained, max: s.max, grade: s.grade, absent: s.absent }])),
  })).sort((a, b) => a.rank - b.rank || String(a.name).localeCompare(String(b.name)));
  const me = rows.find((r) => r.isMe) || null;
  return { exam: { id: exam._id, name: exam.name, type: exam.type }, published: true, subjects: subjectCols, rows, me, classSize: rows.length, average: Math.round((rows.reduce((n, r) => n + (r.percentage ?? 0), 0) / rows.length) * 10) / 10 };
}

// ── the student's standing in the whole class: built only from published results and submitted registers, other students stay anonymous ──
const avg = (xs) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const median = (xs) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : round1((a[m - 1] + a[m]) / 2); };
/** Competition rank (ties share) of `value` among `values`, highest first. */
const rankIn = (values, value) => 1 + values.filter((v) => v > value).length;

export async function classAnalysis(ctx) {
  const me = String(ctx.student._id);
  const [section, cls, classSize] = await Promise.all([
    ctx.enrolment ? Section.findById(ctx.enrolment.sectionId).select('name').lean() : null,
    ctx.enrolment ? ClassModel.findById(ctx.enrolment.classId).select('name').lean() : null,
    StudentEnrolment.countDocuments({ tenantId: ctx.tenantId, yearId: ctx.year._id, sectionId: { $in: ctx.sectionIds }, status: 'active' }),
  ]);
  const { exams, cards } = await visibleClassExams(ctx);
  const done = exams.filter((e) => cards.some((c) => String(c.examId) === String(e._id)))
    .map((e) => ({ e, list: cards.filter((c) => String(c.examId) === String(e._id) && attempted(c)) }))
    .sort((a, b) => String(a.e.startDate || a.e.createdAt).localeCompare(String(b.e.startDate || b.e.createdAt)));
  const out = { className: cls?.name, section: section?.name, classSize, tests: [], overall: null, subjects: [], distribution: [], attendance: null, standing: null };
  const pctOf = (c) => c.snapshot.percentage ?? 0;
  out.tests = done.map(({ e, list }) => {
    const mine = list.find((c) => String(c.studentId) === me);
    const ps = list.map(pctOf);
    return { examId: e._id, name: e.name, type: e.type, takers: list.length, myPercentage: mine ? pctOf(mine) : null, myRank: mine ? rankIn(ps, pctOf(mine)) : null, average: avg(ps), highest: ps.length ? Math.max(...ps) : null, lowest: ps.length ? Math.min(...ps) : null, median: median(ps) };
  });

  // overall: each student's average over the tests they sat, ranked against the section
  const byStudent = new Map();
  done.forEach(({ list }) => list.forEach((c) => { const k = String(c.studentId); if (!byStudent.has(k)) byStudent.set(k, []); byStudent.get(k).push(pctOf(c)); }));
  const averages = new Map([...byStudent].map(([k, v]) => [k, avg(v)]));
  if (averages.has(me)) {
    const all = [...averages.values()];
    const mineAvg = averages.get(me);
    const rank = rankIn(all, mineAvg);
    const classAvg = avg(all);
    const behind = all.filter((v) => v < mineAvg).length;
    const top = rank / all.length;
    const gap = round1(mineAvg - classAvg);
    const standing = rank === 1 || top <= 0.1 ? { key: 'top', label: 'At the top of the class' } : top <= 0.25 ? { key: 'leading', label: 'Among the leaders of the class' }
      : gap >= 0 ? { key: 'above', label: 'Above the class average' } : gap >= -5 ? { key: 'near', label: 'Close to the class average' } : { key: 'below', label: 'Below the class average' };
    out.overall = { testsCounted: byStudent.get(me).length, myAverage: mineAvg, classAverage: classAvg, gap, rank, of: all.length, ahead: behind, highest: Math.max(...all), lowest: Math.min(...all) };
    out.standing = standing;
    // the trend of the student's own rank over the last tests, to say whether they are moving up or down
    const ranks = out.tests.filter((t) => t.myRank != null).map((t) => t.myRank / t.takers);
    if (ranks.length >= 2) { const d = ranks[ranks.length - 1] - ranks[ranks.length - 2]; out.overall.movement = Math.abs(d) < 0.03 ? 'steady' : d < 0 ? 'up' : 'down'; }
  }

  // subject by subject, over all published tests
  const sub = new Map();
  done.forEach(({ list }) => list.forEach((c) => c.snapshot.subjects.forEach((s) => {
    if (s.percentage == null || s.absent) return;
    if (!sub.has(s.code)) sub.set(s.code, { subject: s.subject, all: [], mine: [] });
    const x = sub.get(s.code); x.all.push(s.percentage); if (String(c.studentId) === me) x.mine.push(s.percentage);
  })));
  out.subjects = [...sub.values()].filter((x) => x.mine.length).map((x) => ({ subject: x.subject, mine: avg(x.mine), classAverage: avg(x.all), highest: Math.max(...x.all), gap: round1(avg(x.mine) - avg(x.all)) })).sort((a, b) => b.gap - a.gap);

  // where the whole class sits in the latest test: how many classmates in each band, and which band is the student's
  const latest = done[done.length - 1];
  if (latest && latest.list.some((c) => String(c.studentId) === me)) {
    const bands = [['Below 40%', 0, 40], ['40–59%', 40, 60], ['60–74%', 60, 75], ['75–89%', 75, 90], ['90% and above', 90, 1e9]];
    const mp = pctOf(latest.list.find((c) => String(c.studentId) === me));
    out.distribution = bands.map(([label, lo, hi]) => ({ label, count: latest.list.filter((c) => pctOf(c) >= lo && pctOf(c) < hi).length, mine: mp >= lo && mp < hi }));
    out.distributionExam = latest.e.name;
  }

  // attendance against the section
  const counts = await studentCounts(ctx.tenantId, { yearId: ctx.year._id, sectionId: { $in: ctx.sectionIds } });
  const pcts = new Map([...counts].map(([k, c]) => [k, summarizeCounts(c, ctx.settings).percentage]).filter(([, v]) => v != null));
  if (pcts.has(me)) { const all = [...pcts.values()]; out.attendance = { mine: pcts.get(me), classAverage: avg(all), rank: rankIn(all, pcts.get(me)), of: all.length }; }
  out.ready = !!out.overall;
  return out;
}
