import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');

describe('examinations with configurable mark fields → approval → publish → results', () => {
  let root; let W; let exam; let esMaths; let esEng; let ids; let sheetM; let outsider;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'exm');
    const r = await W.post(W.h, '/api/school/students', { name: 'Outsider Kid', dob: '2013-07-07', sectionId: W.sec8B._id, admissionDate: '2026-04-15', guardians: [{ email: 'guardian@fixture.test', name: 'Parent Name', relationship: 'Mother', phone: '9876543210' }] });
    outsider = await login(r.body.credentials.loginId, r.body.credentials.temporaryPassword, 'student');
  });
  afterAll(teardown);
  const sheetQ = (es, sec = W.sec8A._id) => `examSubjectId=${es._id}&sectionId=${sec}`;
  const put = (es, extra) => api().put(`/api/school/exams/${exam._id}/subjects`).set(W.h).send({ classId: W.c8._id, subjectId: es.subjectId, ...extra });

  it('admin builds an exam; subjects start with a single "Marks" field which can be customised', async () => {
    exam = (await api().post('/api/school/exams').set(W.h).send({ name: 'Unit Test 2', type: 'unit_test', classIds: [W.c8._id], startDate: addDays(TODAY, 6), endDate: addDays(TODAY, 8), marksDeadline: addDays(TODAY, 12) })).body;
    expect(exam._id).toBeTruthy();
    expect((await api().post('/api/school/exams').set(W.h).send({ name: 'Unit Test 2', classIds: [W.c8._id] })).status).toBe(409);
    expect((await api().post('/api/school/exams').set(W.h).send({ name: 'Bad Type', type: 'nonsense', classIds: [W.c8._id] })).status).toBe(400);
    expect((await api().post(`/api/school/exams/${exam._id}/subjects/generate`).set(W.h)).body.created).toBe(2);
    const d = (await api().get(`/api/school/exams/${exam._id}`).set(W.h)).body;
    esMaths = d.subjects.find((s) => s.subject === 'Mathematics'); esEng = d.subjects.find((s) => s.subject === 'English');
    expect(esMaths.components).toMatchObject([{ key: 'marks', label: 'Marks', max: 100 }]);
    // the admin asks for the fields this exam should have — nothing is hard-wired to theory/practical
    const bad = (components) => put(esMaths, { components });
    expect((await bad([])).status).toBe(400);
    expect((await bad([{ label: 'Written', max: 0 }])).status).toBe(400);
    expect((await bad([{ label: 'Oral', max: 10 }, { label: 'oral', max: 5 }])).status).toBe(400); // duplicate field
    expect((await bad(Array.from({ length: 9 }, (_, i) => ({ label: `F${i}`, max: 5 })))).status).toBe(400);
    const ok = await put(esMaths, { components: [{ label: 'Written', max: 80 }, { label: 'Practical', max: 20 }], date: addDays(TODAY, 6), startTime: '10:00', endTime: '12:00', room: '204' });
    expect(ok.status).toBe(200);
    expect(ok.body.components.map((c) => c.key)).toEqual(['written', 'practical']);
    expect((await put(esEng, { date: addDays(TODAY, 6), startTime: '11:00', endTime: '13:00', room: '205' })).status).toBe(409); // same class, overlapping time
    expect((await put(esEng, { date: addDays(TODAY, 7), startTime: '10:00', endTime: '12:00', room: '204' })).status).toBe(200);
    expect((await put(esEng, { date: addDays(TODAY, 7), startTime: '12:00', endTime: '11:00' })).status).toBe(400);
    expect((await put(esEng, { passMarks: 500 })).status).toBe(400);
    esMaths = (await api().get(`/api/school/exams/${exam._id}`).set(W.h)).body.subjects.find((s) => s.subject === 'Mathematics');
    expect(esMaths.max).toBe(100);
    expect((await api().get('/api/student/exams/schedule').set(W.studentLogins[0].h)).body).toHaveLength(0); // not published yet
    expect((await api().post(`/api/school/exams/${exam._id}/publish-schedule`).set(W.h)).status).toBe(200);
    const sch = (await api().get('/api/student/exams/schedule').set(W.studentLogins[0].h)).body;
    expect(sch.map((s) => s.subject)).toEqual(['Mathematics', 'English']);
    expect(sch[0]).toMatchObject({ daysLeft: 6, room: '204', startTime: '10:00' });
    const dash = (await api().get('/api/student/dashboard').set(W.studentLogins[0].h)).body;
    expect(dash.upcomingExam).toMatchObject({ subject: 'Mathematics', daysLeft: 6 });
    expect(dash.cards.latestAverage).toBeNull(); // no fabricated results
    expect(dash.cards.attendance).toBeNull();
  });

  it('teacher enters marks field by field; validation is strict and per field', async () => {
    const mine = (await api().get('/api/teacher/exams').set(W.teacher1.h)).body;
    expect(mine.map((m) => m.subject)).toEqual(['Mathematics']);
    expect(mine[0]).toMatchObject({ status: 'not_started', max: 100, createdByMe: false });
    expect(mine[0].components.map((c) => c.label)).toEqual(['Written', 'Practical']);
    expect((await api().get(`/api/teacher/marks/sheet?${sheetQ(esEng)}`).set(W.teacher1.h)).status).toBe(403); // not his subject
    const sheet = (await api().get(`/api/teacher/marks/sheet?${sheetQ(esMaths)}`).set(W.teacher1.h)).body;
    expect(sheet.students).toHaveLength(3);
    const [a, b, c] = sheet.students;
    const save = (marks) => api().put('/api/teacher/marks/sheet').set(W.teacher1.h).send({ examSubjectId: esMaths._id, sectionId: W.sec8A._id, marks });
    expect((await save([{ studentId: a.studentId, values: { written: 81, practical: 10 } }])).status).toBe(400); // over that field's max
    expect((await save([{ studentId: a.studentId, values: { written: -1, practical: 10 } }])).status).toBe(400);
    expect((await save([{ studentId: a.studentId, values: { written: 40, practical: 21 } }])).status).toBe(400);
    expect((await save([{ studentId: a.studentId, values: { theory: 40 } }])).status).toBe(400); // not a field of this exam
    expect((await save([{ studentId: a.studentId, absent: true, exempt: true }])).status).toBe(400);
    expect((await save([{ studentId: '64b000000000000000000000', values: { written: 40, practical: 10 } }])).status).toBe(400);
    expect((await save([{ studentId: a.studentId, values: { written: 60, practical: 15 }, remarks: 'Good' }, { studentId: b.studentId, values: { written: 70, practical: 18 } }])).status).toBe(200);
    const incomplete = await api().post('/api/teacher/marks/sheet/submit').set(W.teacher1.h).send({ examSubjectId: esMaths._id, sectionId: W.sec8A._id });
    expect(incomplete.status).toBe(400); // third student has nothing
    ids = { a: a.studentId, b: b.studentId, c: c.studentId };
    expect((await save([{ studentId: c.studentId, absent: true }])).status).toBe(200);
    const half = await save([{ studentId: b.studentId, values: { written: 70 } }]); // practical now missing
    expect(half.status).toBe(200);
    expect((await api().post('/api/teacher/marks/sheet/submit').set(W.teacher1.h).send({ examSubjectId: esMaths._id, sectionId: W.sec8A._id })).body.details[0]).toMatch(/Practical marks missing/);
    await save([{ studentId: b.studentId, values: { written: 70, practical: 18 } }]);
    const re = (await api().get(`/api/teacher/marks/sheet?${sheetQ(esMaths)}`).set(W.teacher1.h)).body;
    expect(re.status).toBe('draft');
    expect(re.students.find((s) => s.studentId === a.studentId)).toMatchObject({ values: { written: 60, practical: 15 }, total: 75, remarks: 'Good' });
    expect(re.students.find((s) => s.studentId === c.studentId)).toMatchObject({ absent: true, total: null });
  });

  it('bulk import maps columns to the exam\'s own fields', async () => {
    const adm = (await api().get(`/api/teacher/marks/sheet?${sheetQ(esMaths)}`).set(W.teacher1.h)).body.students.map((s) => s.admissionNo);
    const rows = [{ admissionNo: adm[0], values: { written: 65, practical: 16 } }, { admissionNo: 'NOPE', values: { written: 1 } }, { admissionNo: adm[1], values: { written: 99, practical: 1 } }];
    const dry = await api().post('/api/teacher/marks/import').set(W.teacher1.h).send({ examSubjectId: esMaths._id, sectionId: W.sec8A._id, rows });
    expect(dry.body.errors).toHaveLength(2);
    expect(dry.body.applied).toBe(0);
    const applied = await api().post('/api/teacher/marks/import').set(W.teacher1.h).send({ examSubjectId: esMaths._id, sectionId: W.sec8A._id, rows, skipInvalid: true });
    expect(applied.body.applied).toBe(1);
    expect((await api().get(`/api/teacher/marks/sheet?${sheetQ(esMaths)}`).set(W.teacher1.h)).body.students.find((s) => s.studentId === ids.a).total).toBe(81);
    await api().put('/api/teacher/marks/sheet').set(W.teacher1.h).send({ examSubjectId: esMaths._id, sectionId: W.sec8A._id, marks: [{ studentId: ids.a, values: { written: 60, practical: 15 } }] });
  });

  it('submit locks the sheet; marks fields freeze once entry starts; admin returns it with a reason', async () => {
    expect((await put(esMaths, { components: [{ label: 'Total', max: 100 }] })).status).toBe(409); // marks entry has started
    const sub = await api().post('/api/teacher/marks/sheet/submit').set(W.teacher1.h).send({ examSubjectId: esMaths._id, sectionId: W.sec8A._id });
    expect(sub.status).toBe(200);
    expect(sub.body.status).toBe('submitted');
    expect((await api().put('/api/teacher/marks/sheet').set(W.teacher1.h).send({ examSubjectId: esMaths._id, sectionId: W.sec8A._id, marks: [{ studentId: ids.a, values: { written: 70, practical: 15 } }] })).status).toBe(409);
    expect((await api().get('/api/student/results').set(W.studentLogins[0].h)).body.every((r) => r.status === 'upcoming')).toBe(true);
    expect((await api().get(`/api/student/results/${exam._id}`).set(W.studentLogins[0].h)).status).toBe(404);
    const sheets = (await api().get(`/api/school/exams/${exam._id}/sheets`).set(W.h)).body;
    expect(sheets[0]).toMatchObject({ status: 'submitted', teacher: 'Mr Sharma', subject: 'Mathematics' });
    expect((await api().post(`/api/school/sheets/${sheets[0]._id}/return`).set(W.h).send({})).status).toBe(400);
    const ret = await api().post(`/api/school/sheets/${sheets[0]._id}/return`).set(W.h).send({ reason: 'Check practical marks of roll 2' });
    expect(ret.body.status).toBe('returned');
    expect((await api().post(`/api/school/sheets/${sheets[0]._id}/return`).set(W.h).send({ reason: 'again please' })).status).toBe(409);
    sheetM = sheets[0]._id;
    const view = (await api().get(`/api/teacher/marks/sheet?${sheetQ(esMaths)}`).set(W.teacher1.h)).body;
    expect(view).toMatchObject({ status: 'returned', returnReason: 'Check practical marks of roll 2', canEdit: true });
    expect(view.revisions).toHaveLength(1);
    expect((await api().get('/api/teacher/marks/corrections').set(W.teacher1.h)).body[0]).toMatchObject({ subject: 'Mathematics', returnReason: 'Check practical marks of roll 2' });
    await api().put('/api/teacher/marks/sheet').set(W.teacher1.h).send({ examSubjectId: esMaths._id, sectionId: W.sec8A._id, marks: [{ studentId: ids.b, values: { written: 72, practical: 18 } }] });
    const again = await api().post('/api/teacher/marks/sheet/submit').set(W.teacher1.h).send({ examSubjectId: esMaths._id, sectionId: W.sec8A._id });
    expect(again.body.revisions).toHaveLength(2);
    expect(again.body.revisions[0].marks.find((m) => m.studentId === ids.b).values.written).toBe(70); // old submission untouched
  });

  it('publishing needs every subject approved; then students get an immutable report card with their own fields', async () => {
    const approve = (id) => api().post(`/api/school/sheets/${id}/approve`).set(W.h);
    expect((await approve(sheetM)).body.status).toBe('approved');
    const early = await api().post(`/api/school/exams/${exam._id}/publish`).set(W.h).send({ all: true });
    expect(early.body.published).toHaveLength(0);
    expect(early.body.skipped.find((s) => s.section === 'Class 8 A').reason).toMatch(/no marks/);
    const eng = (await api().get(`/api/teacher/marks/sheet?${sheetQ(esEng)}`).set(W.teacher2.h)).body;
    await api().put('/api/teacher/marks/sheet').set(W.teacher2.h).send({ examSubjectId: esEng._id, sectionId: W.sec8A._id, marks: eng.students.map((s, i) => ({ studentId: s.studentId, values: { marks: [80, 55, 20][i] } })) });
    await api().post('/api/teacher/marks/sheet/submit').set(W.teacher2.h).send({ examSubjectId: esEng._id, sectionId: W.sec8A._id });
    const engSheet = (await api().get(`/api/school/exams/${exam._id}/sheets`).set(W.h)).body.find((s) => s.subject === 'English');
    expect((await api().post(`/api/school/sheets/${engSheet._id}/start-review`).set(W.h)).body.status).toBe('under_review');
    expect((await api().post(`/api/school/exams/${exam._id}/publish`).set(W.h).send({ all: true })).body.published).toHaveLength(0);
    await approve(engSheet._id);
    await api().put(`/api/school/exams/${exam._id}/remarks`).set(W.h).send({ studentId: ids.a, teacherRemark: 'Keep it up', principalRemark: 'Well done' });
    const pub = await api().post(`/api/school/exams/${exam._id}/publish`).set(W.h).send({ all: true });
    expect(pub.body.published[0]).toMatchObject({ section: 'Class 8 A', reportCards: 3 });
    expect((await api().post(`/api/school/exams/${exam._id}/publish`).set(W.h).send({})).status).toBe(400);

    const mine = (await api().get(`/api/student/results/${exam._id}`).set(W.studentLogins[0].h)).body;
    expect(mine).toMatchObject({ totalObtained: 155, totalMax: 200, percentage: 77.5, grade: 'B+', resultStatus: 'pass', version: 1, teacherRemark: 'Keep it up', principalRemark: 'Well done' });
    const m = mine.subjects.find((s) => s.subject === 'Mathematics');
    expect(m).toMatchObject({ obtained: 75, max: 100, grade: 'B+', teacher: 'Mr Sharma' });
    expect(m.components).toEqual([{ key: 'written', label: 'Written', max: 80, value: 60 }, { key: 'practical', label: 'Practical', max: 20, value: 15 }]);
    const absent = (await api().get(`/api/student/results/${exam._id}`).set(W.studentLogins[2].h)).body;
    expect(absent.resultStatus).toBe('fail');
    expect(absent.subjects.find((s) => s.subject === 'Mathematics').grade).toBe('AB');
    const dash = (await api().get('/api/student/dashboard').set(W.studentLogins[0].h)).body;
    expect(dash.cards).toMatchObject({ completedExams: 1, latestAverage: 77.5 });
    const pdf = await api().get(`/api/student/results/${exam._id}/pdf`).set(W.studentLogins[0].h).buffer().parse((res, cb) => { const d = []; res.on('data', (x) => d.push(x)); res.on('end', () => cb(null, Buffer.concat(d))); });
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('every student sees ALL tests of their class, everyone\'s results and their own rank', async () => {
    const S = W.studentLogins[0].h;
    const list = (await api().get('/api/student/class-results').set(S)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Unit Test 2', status: 'published', classSize: 3, myRank: 1, myPercentage: 77.5, attempted: true });
    const detail = (await api().get(`/api/student/class-results/${exam._id}`).set(S)).body;
    expect(detail.rows.map((r) => [r.rank, r.name, r.percentage])).toEqual([[1, 'Aarav Singh', 77.5], [2, 'Bhavna Rao', 72.5], [3, 'Chirag Das', 10]]);
    expect(detail.rows[0].isMe).toBe(true);
    expect(detail.rows[1]).toMatchObject({ isMe: false, marks: { MATH: { obtained: 90, max: 100 } } });
    expect(detail.rows[2]).toMatchObject({ attempted: true, marks: { MATH: { absent: true } } }); // sat English, absent in Maths
    expect(detail.subjects.map((s) => s.code).sort()).toEqual(['ENGL', 'MATH']);
    expect(detail).toMatchObject({ classSize: 3, me: { rank: 1 } });
    // another student sees the same list with their own rank
    const b = (await api().get('/api/student/class-results').set(W.studentLogins[1].h)).body;
    expect(b[0]).toMatchObject({ myRank: 2, myPercentage: 72.5 });
    expect((await api().get(`/api/student/class-results/${exam._id}`).set(W.studentLogins[1].h)).body.me.rank).toBe(2);
    // 8-B shares the Class 8 exam, but nobody there has results yet, so there is nothing to see or rank
    const o = (await api().get('/api/student/class-results').set(outsider.h)).body;
    expect(o.map((x) => [x.name, x.status])).toEqual([['Unit Test 2', 'upcoming']]);
    expect((await api().get(`/api/student/class-results/${exam._id}`).set(outsider.h)).body).toMatchObject({ published: false, rows: [] });
  });

  it('published results are locked; changes go through a formal correction that keeps version 1', async () => {
    const locked = await api().put('/api/teacher/marks/sheet').set(W.teacher1.h).send({ examSubjectId: esMaths._id, sectionId: W.sec8A._id, marks: [{ studentId: ids.a, values: { written: 80, practical: 20 } }] });
    expect(locked.status).toBe(409);
    expect(locked.body.error).toMatch(/formal correction/);
    expect((await api().post(`/api/school/sheets/${sheetM}/return`).set(W.h).send({ reason: 'too late' })).status).toBe(409);
    const markRow = (await api().get(`/api/school/sheets/${sheetM}`).set(W.h)).body.rows.find((r) => String(r.studentId) === ids.a);
    expect((await api().post(`/api/school/marks/${markRow._id}/correct`).set(W.teacher1.h).send({ values: { written: 70 }, reason: 'typo' })).status).toBe(403);
    expect((await api().post(`/api/school/marks/${markRow._id}/correct`).set(W.h).send({ values: { written: 70 } })).status).toBe(400);
    expect((await api().post(`/api/school/marks/${markRow._id}/correct`).set(W.h).send({ values: { written: 99 }, reason: 'too high' })).status).toBe(400);
    const fix = await api().post(`/api/school/marks/${markRow._id}/correct`).set(W.h).send({ values: { written: 70 }, reason: 'Re-evaluation of answer sheet' });
    expect(fix.status).toBe(200);
    expect(fix.body.history[0]).toMatchObject({ reason: 'Re-evaluation of answer sheet', before: { values: { written: 60 }, total: 75 }, after: { values: { written: 70, practical: 15 }, total: 85 } });
    expect((await api().get(`/api/student/results/${exam._id}`).set(W.studentLogins[0].h)).body).toMatchObject({ version: 2, totalObtained: 165, correctionReason: 'Re-evaluation of answer sheet' });
    const card = (await api().get(`/api/school/exams/${exam._id}/results`).set(W.h)).body.find((r) => r.admissionNo === W.students[0].student.admissionNo);
    expect((await api().get(`/api/school/report-cards/${card.id}`).set(W.h)).body.versions.map((v) => v.version)).toEqual([2, 1]);
    await api().put(`/api/school/exams/${exam._id}/remarks`).set(W.h).send({ studentId: ids.a, principalRemark: 'Excellent progress' });
    expect((await api().get(`/api/student/results/${exam._id}`).set(W.studentLogins[0].h)).body).toMatchObject({ version: 3, principalRemark: 'Excellent progress' });
    expect((await api().get(`/api/school/export/results.csv?examId=${exam._id}`).set(W.studentLogins[0].h)).status).toBe(403);
  });

  describe('teacher-created tests (unit test, class test, surprise test…)', () => {
    let ct; let ctSurprise;
    const body = (over = {}) => ({ name: 'Class Test 1', type: 'class_test', sectionId: W.sec8A._id, subjectId: W.maths._id, date: TODAY, components: [{ label: 'Score', max: 20 }], ...over });

    it('a teacher adds tests only for subjects they teach in their own sections', async () => {
      expect((await api().post('/api/teacher/exams').set(W.teacher2.h).send(body())).status).toBe(403); // Gupta doesn't teach maths
      expect((await api().post('/api/teacher/exams').set(W.teacher1.h).send(body({ sectionId: W.sec8B._id }))).status).toBe(403); // not his section
      expect((await api().post('/api/teacher/exams').set(W.teacher1.h).send(body({ type: 'half_yearly' }))).status).toBe(400); // admin-only type
      expect((await api().post('/api/teacher/exams').set(W.teacher1.h).send(body({ components: [] }))).status).toBe(400);
      expect((await api().post('/api/teacher/exams').set(W.teacher1.h).send(body({ components: [{ label: 'Score', max: 20 }], passMarks: 25 }))).status).toBe(400);
      ct = (await api().post('/api/teacher/exams').set(W.teacher1.h).send(body())).body;
      expect(ct.exam.type).toBe('class_test');
      expect((await api().post('/api/teacher/exams').set(W.teacher1.h).send(body())).status).toBe(409); // same name for same class+subject
      ctSurprise = (await api().post('/api/teacher/exams').set(W.teacher1.h).send(body({ name: 'Surprise Test', type: 'surprise_test', components: [{ label: 'Quick quiz', max: 10 }] }))).body;
      const rows = (await api().get('/api/teacher/exams').set(W.teacher1.h)).body;
      expect(rows.filter((r) => r.createdByMe).map((r) => r.exam).sort()).toEqual(['Class Test 1', 'Surprise Test']);
      expect(rows.find((r) => r.exam === 'Class Test 1')).toMatchObject({ type: 'class_test', max: 20, passMarks: 7, scoped: true, canDelete: true });
      // Gupta (English) never sees Sharma's maths test; the admin does
      expect((await api().get('/api/teacher/exams').set(W.teacher2.h)).body.some((r) => r.exam === 'Class Test 1')).toBe(false);
      expect((await api().get('/api/school/exams').set(W.h)).body.some((e) => e.name === 'Class Test 1' && e.createdByName === 'Mr Sharma')).toBe(true);
    });

    it('students of that section see an announced class test; a surprise test stays hidden until results are out; other sections never see it', async () => {
      const S = W.studentLogins[0].h;
      const sched = (await api().get('/api/student/exams/schedule').set(S)).body.map((x) => x.exam);
      expect(sched).toContain('Class Test 1');
      expect(sched).not.toContain('Surprise Test');
      expect((await api().get('/api/student/class-results').set(S)).body.map((x) => x.name)).not.toContain('Surprise Test');
      expect((await api().get('/api/student/notifications?category=examination').set(S)).body.items.some((n) => /Class Test 1/.test(n.title))).toBe(true);
      expect((await api().get('/api/student/exams/schedule').set(outsider.h)).body.map((x) => x.exam)).not.toContain('Class Test 1'); // belongs to 8-A only
      expect((await api().get('/api/student/calendar').set(S)).body.some((c) => /Class Test 1/.test(c.title))).toBe(true);
    });

    it('marks follow the same approval flow; the class result page ranks everyone, ties share a rank, absentees are shown as not attempted', async () => {
      const es = (await api().get('/api/teacher/exams').set(W.teacher1.h)).body.find((r) => r.exam === 'Class Test 1');
      const sheet = (await api().get(`/api/teacher/marks/sheet?examSubjectId=${es.examSubjectId}&sectionId=${W.sec8A._id}`).set(W.teacher1.h)).body;
      expect(sheet.examSubject.components).toEqual([{ key: 'score', label: 'Score', max: 20 }]);
      const marks = sheet.students.map((s, i) => (i < 2 ? { studentId: s.studentId, values: { score: 18 } } : { studentId: s.studentId, absent: true }));
      await api().put('/api/teacher/marks/sheet').set(W.teacher1.h).send({ examSubjectId: es.examSubjectId, sectionId: W.sec8A._id, marks });
      expect((await api().post('/api/teacher/marks/sheet/submit').set(W.teacher1.h).send({ examSubjectId: es.examSubjectId, sectionId: W.sec8A._id })).status).toBe(200);
      const sh = (await api().get(`/api/school/exams/${ct.exam._id}/sheets`).set(W.h)).body[0];
      await api().post(`/api/school/sheets/${sh._id}/approve`).set(W.h);
      const pub = (await api().post(`/api/school/exams/${ct.exam._id}/publish`).set(W.h).send({ all: true })).body;
      expect(pub.published).toEqual([{ section: 'Class 8 A', reportCards: 3 }]); // only the section the test belongs to
      const detail = (await api().get(`/api/student/class-results/${ct.exam._id}`).set(W.studentLogins[0].h)).body;
      expect(detail.rows.map((r) => [r.rank, r.attempted])).toEqual([[1, true], [1, true], [3, false]]); // tie shares rank 1; absentee last
      expect(detail.rows[2].marks.MATH).toMatchObject({ absent: true });
      const list = (await api().get('/api/student/class-results').set(W.studentLogins[2].h)).body.find((x) => x.name === 'Class Test 1');
      expect(list).toMatchObject({ attempted: false, hasResult: true, myRank: 3 });
      expect((await api().get('/api/student/class-results').set(outsider.h)).body.map((x) => x.name)).not.toContain('Class Test 1');
      expect((await api().get(`/api/student/class-results/${ct.exam._id}`).set(outsider.h)).status).toBe(404);
    });

    it('a test can be edited or deleted only by its creator and only before marks entry starts', async () => {
      expect((await api().delete(`/api/teacher/exams/${ct.exam._id}`).set(W.teacher1.h)).status).toBe(409); // marks already entered
      expect((await api().patch(`/api/teacher/exams/${ct.exam._id}`).set(W.teacher1.h).send({ components: [{ label: 'Other', max: 30 }] })).status).toBe(409);
      expect((await api().patch(`/api/teacher/exams/${ct.exam._id}`).set(W.teacher2.h).send({ name: 'Hijacked' })).status).toBe(403);
      expect((await api().delete(`/api/teacher/exams/${ctSurprise.exam._id}`).set(W.teacher2.h)).status).toBe(403);
      expect((await api().patch(`/api/teacher/exams/${ctSurprise.exam._id}`).set(W.teacher1.h).send({ name: 'Pop Quiz', components: [{ label: 'Quiz', max: 15 }] })).status).toBe(200);
      expect((await api().delete(`/api/teacher/exams/${ctSurprise.exam._id}`).set(W.teacher1.h)).status).toBe(200);
      expect((await api().get('/api/teacher/exams').set(W.teacher1.h)).body.some((r) => r.exam === 'Pop Quiz')).toBe(false);
    });
  });

  it('class-wise performance matrix: class teacher sees overall results, a subject teacher only their subject; each student drills down', async () => {
    const m = (await api().get(`/api/teacher/performance/class/${W.sec8A._id}`).set(W.teacher1.h)).body;
    expect(m.scope).toBe('overall');
    expect(m.exams.map((e) => e.name).sort()).toEqual(['Class Test 1', 'Unit Test 2']);
    const ut = m.exams.find((e) => e.name === 'Unit Test 2');
    const rowA = m.students.find((s) => s.name === 'Aarav Singh');
    expect(rowA.scores[ut.id]).toMatchObject({ percentage: 82.5, grade: 'A' });
    expect(m.students.find((s) => s.name === 'Chirag Das').scores[ut.id].result).toBe('fail');
    expect(m.students).toHaveLength(3);
    const g = (await api().get(`/api/teacher/performance/class/${W.sec8A._id}`).set(W.teacher2.h)).body; // English teacher
    expect(g.scope).toBe('subject');
    expect(g.exams.map((e) => e.name)).toEqual(['Unit Test 2']); // the maths class test has no English subject
    expect(g.students.find((s) => s.name === 'Aarav Singh').scores[ut.id]).toMatchObject({ percentage: 80, obtained: 80, max: 100 });
    expect((await api().get(`/api/teacher/performance/class/${W.sec8B._id}`).set(W.teacher1.h)).status).toBe(403);
    // click through to one student's full marks, field by field
    const d = (await api().get(`/api/teacher/students/${ids.a}`).set(W.teacher1.h)).body;
    const u = d.marks.find((x) => x.exam === 'Unit Test 2');
    expect(u.subjects.map((s) => s.subject).sort()).toEqual(['English', 'Mathematics']);
    expect(u.subjects.find((s) => s.subject === 'Mathematics').components.map((c) => `${c.label} ${c.value}/${c.max}`)).toEqual(['Written 70/80', 'Practical 15/20']);
    const own = (await api().get(`/api/teacher/students/${ids.a}`).set(W.teacher2.h)).body;
    expect(own.marks.find((x) => x.exam === 'Unit Test 2').subjects.map((s) => s.subject)).toEqual(['English']);
    expect(own.marks.find((x) => x.exam === 'Unit Test 2').percentage).toBeNull();
    expect(d.profile).not.toHaveProperty('address');
    const t = (await api().get('/api/teacher/performance').set(W.teacher1.h)).body;
    expect(t.subjectTrend.map((s) => s.subject)).toEqual(['Mathematics']);
    const s = (await api().get('/api/student/performance').set(W.studentLogins[0].h)).body;
    expect(s.trend.length).toBeGreaterThanOrEqual(1);
  });

  it('School Admin: pick a class, see the exams held and every student\'s performance across them, ranked; teacher-made tests count too', async () => {
    const A = (q) => api().get(`/api/school/analysis/exams?${q}`).set(W.h);
    const cls = (await A(`classId=${W.c8._id}`)).body;
    expect(cls).toMatchObject({ className: 'Class 8', examsHeld: 2, sections: [{ name: 'A' }, { name: 'B' }] });
    expect(cls.exams.map((e) => e.name).sort()).toEqual(['Class Test 1', 'Unit Test 2']); // the teacher's class test is part of the analysis
    const ut = cls.exams.find((e) => e.name === 'Unit Test 2');
    expect(ut).toMatchObject({ students: 3, highest: { name: 'Aarav Singh', percentage: 82.5 } });
    expect(ut.subjects.map((x) => x.subject).sort()).toEqual(['English', 'Mathematics']);
    expect(ut.passPercent).toBeLessThan(100); // Chirag failed
    const a = cls.students.find((x) => x.name === 'Aarav Singh');
    expect(a).toMatchObject({ rank: 1, section: 'A', examsTaken: 2 });
    expect(a.scores[ut.id].percentage).toBe(82.5);
    expect(cls.students.map((x) => x.rank)).toEqual(expect.arrayContaining([1]));
    expect(cls.summary.students).toBe(4); // includes the student in section B, who has no results
    expect(cls.students.find((x) => x.section === 'B')).toMatchObject({ examsTaken: 0, average: null });
    // one section only, and the other section has no results
    expect((await A(`sectionId=${W.sec8A._id}`)).body.students).toHaveLength(3);
    expect((await A(`sectionId=${W.sec8B._id}`)).body).toMatchObject({ examsHeld: 0 });
    expect((await api().get(`/api/school/analysis/exams?classId=${W.c8._id}`).set(W.teacher1.h)).status).toBe(403);
  });

  it('School Admin: the whole-school overview adds up with the class analysis, and is for the admin only', async () => {
    const o = (await api().get('/api/school/analysis/overview').set(W.h)).body;
    const cls = (await api().get(`/api/school/analysis/exams?classId=${W.c8._id}`).set(W.h)).body;
    expect(o.totals).toMatchObject({ examsWithResults: 2, passMark: 33 });
    expect(o.totals.students).toBe(3); // only the students with published results (the one in section B has none)
    expect(o.totals.results).toBe(cls.exams.reduce((n, e) => n + e.students, 0));
    expect(o.classes).toHaveLength(1);
    expect(o.classes[0]).toMatchObject({ className: 'Class 8', students: 3 });
    expect(o.exams.map((e) => e.name).sort()).toEqual(['Class Test 1', 'Unit Test 2']);
    expect(o.subjects.map((x) => x.subject)).toEqual(expect.arrayContaining(['English', 'Mathematics']));
    expect(o.top[0]).toMatchObject({ name: 'Aarav Singh' });
    expect(o.needSupport[0].average).toBeLessThanOrEqual(o.top[0].average);
    expect(o.grades.reduce((n, g) => n + g.count, 0)).toBe(o.totals.results);
    expect(o.totals.passRate).toBeLessThan(100); // Chirag failed
    expect((await api().get('/api/school/analysis/overview').set(W.teacher1.h)).status).toBe(403);
  });

  it('School Admin: one student\'s marks page has basic details and marks, and nothing about fees, library or attendance', async () => {
    const aarav = W.students.find((x) => x.student.name === 'Aarav Singh').student._id;
    const m = (await api().get(`/api/school/analysis/students/${aarav}`).set(W.h)).body;
    expect(m.profile).toMatchObject({ name: 'Aarav Singh', className: 'Class 8', section: 'A' });
    expect(Array.isArray(m.profile.guardians)).toBe(true);
    expect(m.profile).toHaveProperty('bus'); // null when the student has no bus
    expect(m.summary).toMatchObject({ examsTaken: 2, passMark: 33 });
    expect(m.exams.map((e) => e.exam).sort()).toEqual(['Class Test 1', 'Unit Test 2']);
    const ut = m.exams.find((e) => e.exam === 'Unit Test 2');
    expect(ut).toMatchObject({ percentage: 82.5, rank: 1, outOf: 3 });
    expect(ut.subjects.map((x) => x.subject).sort()).toEqual(['English', 'Mathematics']);
    expect(m.subjectAverages.map((x) => x.subject)).toEqual(['English', 'Mathematics']);
    for (const k of ['fees', 'library', 'attendance', 'homework', 'remarks']) expect(m, k).not.toHaveProperty(k); // only marks
    expect((await api().get(`/api/school/analysis/students/${aarav}`).set(W.teacher1.h)).status).toBe(403);
    expect((await api().get(`/api/school/analysis/students/${'0'.repeat(24)}`).set(W.h)).status).toBe(404);
  });
});
