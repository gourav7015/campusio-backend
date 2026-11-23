import { Student, StudentEnrolment, Section, ClassModel, Examination, ReportCard, AttendanceRecord, StudentCharge, Payslip, StaffAttendanceRecord, Designation, PayrollRun } from '../../models/index.js';
import { rollStatus } from '../../services/context.js';
import { summarizeCounts, zeroCounts } from '../../services/attendance.js';
import { toCsv, bad } from '../../core/utils.js';
import { listEmployees } from '../employees/employees.service.js';

/**
 * The Export centre: one place to take any list out of the school as a spreadsheet. Each dataset says which filters narrow it, which columns it
 * can have, and how its rows are made. The same code makes the on-screen preview and the downloaded file, so what is previewed is what is exported.
 * `need` is the sub-admin permission a dataset belongs to (a sub-admin may only export what they may open on screen).
 */
const MONTH = /^\d{4}-\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const list = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);
const ok24 = (a) => a.filter((x) => /^[a-f0-9]{24}$/i.test(x));
const num = (v) => (v == null || v === '' ? '' : Math.round(v * 100) / 100);

/** Students of the current year with their class and section, in school order; narrowed by class, section, status and gender. */
async function studentBase(ctx, f) {
  const { tenantId, year } = ctx;
  const classIds = ok24(list(f.classIds)); const sectionIds = ok24(list(f.sectionIds));
  const [classes, sections, enrols] = await Promise.all([
    ClassModel.find({ tenantId }).select('name level').lean(), Section.find({ tenantId, yearId: year?._id }).select('name classId').lean(),
    year ? StudentEnrolment.find({ tenantId, yearId: year._id, status: rollStatus(year), ...(classIds.length ? { classId: { $in: classIds } } : {}), ...(sectionIds.length ? { sectionId: { $in: sectionIds } } : {}) }).lean() : [],
  ]);
  const C = new Map(classes.map((c) => [String(c._id), c])); const S = new Map(sections.map((s) => [String(s._id), s]));
  const byStudent = new Map(enrols.map((e) => [String(e.studentId), e]));
  const filtered = classIds.length || sectionIds.length;
  const status = f.status === 'all' ? undefined : (f.status || 'active');
  const students = await Student.find({ tenantId, ...(status ? { status } : {}), ...(f.gender ? { gender: f.gender } : {}), ...(filtered ? { _id: { $in: enrols.map((e) => e.studentId) } } : {}) }).lean();
  return students.map((s) => {
    const e = byStudent.get(String(s._id)); const cl = e && C.get(String(e.classId)); const se = e && S.get(String(e.sectionId));
    return { s, e, className: cl?.name || '', level: cl?.level ?? 999, section: se?.name || '' };
  }).sort((a, b) => a.level - b.level || a.section.localeCompare(b.section) || (a.e?.rollNo || 9999) - (b.e?.rollNo || 9999) || a.s.name.localeCompare(b.s.name));
}
const idCols = [
  { key: 'admissionNo', label: 'Admission No', get: (r) => r.s.admissionNo }, { key: 'name', label: 'Student', get: (r) => r.s.name },
  { key: 'class', label: 'Class', get: (r) => r.className }, { key: 'section', label: 'Section', get: (r) => r.section }, { key: 'rollNo', label: 'Roll No', get: (r) => r.e?.rollNo },
];
const inRange = (f) => ({ ...(DAY.test(f.from || '') ? { $gte: f.from } : {}), ...(DAY.test(f.to || '') ? { $lte: f.to } : {}) });

const DATASETS = {
  students: {
    group: 'Students', label: 'Student profiles', filters: ['classes', 'sections', 'studentStatus', 'gender'], need: 'students',
    about: 'Who the students are: class, contact, guardians and admission details.',
    columns: [
      ...idCols, { key: 'dob', label: 'Date of birth', get: (r) => r.s.dob }, { key: 'gender', label: 'Gender', get: (r) => r.s.gender }, { key: 'house', label: 'House', get: (r) => r.s.house },
      { key: 'bloodGroup', label: 'Blood group', get: (r) => r.s.bloodGroup }, { key: 'phone', label: 'Phone', get: (r) => r.s.phone }, { key: 'email', label: 'Email', get: (r) => r.s.email }, { key: 'address', label: 'Address', get: (r) => r.s.address },
      { key: 'admissionDate', label: 'Admission date', get: (r) => r.s.admissionDate },
      { key: 'guardian', label: 'Guardian', get: (r) => r.s.guardians?.[0]?.name }, { key: 'guardianRelation', label: 'Guardian relation', get: (r) => r.s.guardians?.[0]?.relationship },
      { key: 'guardianPhone', label: 'Guardian phone', get: (r) => r.s.guardians?.[0]?.phone }, { key: 'guardianEmail', label: 'Guardian email', get: (r) => r.s.guardians?.[0]?.email },
      { key: 'emergency', label: 'Emergency contact', get: (r) => [r.s.emergencyContact?.name, r.s.emergencyContact?.phone].filter(Boolean).join(' ') },
      { key: 'status', label: 'Status', get: (r) => r.s.status },
    ],
    defaults: ['admissionNo', 'name', 'class', 'section', 'rollNo', 'dob', 'gender', 'guardian', 'guardianPhone', 'status'],
    rows: (ctx, f) => studentBase(ctx, f),
  },

  student_attendance: {
    group: 'Students', label: 'Student attendance', filters: ['classes', 'sections', 'studentStatus', 'dates', 'layout:attendance'], need: 'attendance',
    about: 'Days present, absent, late and on leave for each student over a period, or every day listed one by one.',
    columns: [
      ...idCols,
      { key: 'date', label: 'Date', get: (r) => r.date, only: 'daily' }, { key: 'dayStatus', label: 'Status', get: (r) => r.status, only: 'daily' }, { key: 'remarks', label: 'Remarks', get: (r) => r.remarks, only: 'daily' },
      { key: 'days', label: 'Days recorded', get: (r) => r.sum?.workingDays, only: 'summary' }, { key: 'present', label: 'Present', get: (r) => r.sum?.present, only: 'summary' }, { key: 'absent', label: 'Absent', get: (r) => r.sum?.absent, only: 'summary' },
      { key: 'late', label: 'Late', get: (r) => r.sum?.late, only: 'summary' }, { key: 'half', label: 'Half days', get: (r) => r.sum?.half_day, only: 'summary' }, { key: 'leave', label: 'On leave', get: (r) => r.sum?.leave, only: 'summary' },
      { key: 'excused', label: 'Excused', get: (r) => r.sum?.excused, only: 'summary' }, { key: 'percentage', label: 'Attendance %', get: (r) => r.sum?.percentage, only: 'summary' },
    ],
    defaults: ['admissionNo', 'name', 'class', 'section', 'days', 'present', 'absent', 'late', 'leave', 'percentage'],
    async rows(ctx, f) {
      const base = await studentBase(ctx, f);
      const byId = new Map(base.map((b) => [String(b.s._id), b]));
      const match = { tenantId: ctx.tenantId, studentId: { $in: base.map((b) => b.s._id) }, ...(ctx.year ? { yearId: ctx.year._id } : {}), ...(Object.keys(inRange(f)).length ? { date: inRange(f) } : {}) };
      if (f.layout === 'daily') {
        const recs = await AttendanceRecord.find(match).select('studentId date status remarks').sort({ date: 1 }).lean();
        const order = new Map(base.map((b, i) => [String(b.s._id), i]));
        return recs.sort((a, b) => order.get(String(a.studentId)) - order.get(String(b.studentId)) || a.date.localeCompare(b.date)).map((x) => ({ ...byId.get(String(x.studentId)), date: x.date, status: x.status, remarks: x.remarks }));
      }
      const agg = await AttendanceRecord.aggregate([{ $match: match }, { $group: { _id: { s: '$studentId', st: '$status' }, n: { $sum: 1 } } }]);
      const counts = new Map();
      for (const a of agg) { const k = String(a._id.s); if (!counts.has(k)) counts.set(k, zeroCounts()); if (a._id.st in counts.get(k)) counts.get(k)[a._id.st] = a.n; }
      return base.map((b) => ({ ...b, sum: summarizeCounts(counts.get(String(b.s._id)) || zeroCounts(), ctx.settings) }));
    },
  },

  student_marks: {
    group: 'Students', label: 'Student results', filters: ['classes', 'sections', 'exam', 'layout:marks'], need: 'exams',
    about: 'Published results: the total and grade for each student, or every subject on its own row.',
    columns: [
      { key: 'admissionNo', label: 'Admission No', get: (r) => r.snap.student?.admissionNo }, { key: 'name', label: 'Student', get: (r) => r.snap.student?.name },
      { key: 'class', label: 'Class', get: (r) => r.className }, { key: 'section', label: 'Section', get: (r) => r.section }, { key: 'exam', label: 'Exam', get: (r) => r.snap.exam?.name },
      { key: 'subject', label: 'Subject', get: (r) => r.sub?.subject, only: 'subjects' }, { key: 'obtained', label: 'Marks obtained', get: (r) => (r.sub ? (r.sub.absent ? 'Absent' : r.sub.obtained) : r.snap.totalObtained) },
      { key: 'max', label: 'Out of', get: (r) => (r.sub ? r.sub.max : r.snap.totalMax) }, { key: 'percentage', label: 'Percentage', get: (r) => num(r.sub ? r.sub.percentage : r.snap.percentage) },
      { key: 'grade', label: 'Grade', get: (r) => (r.sub ? r.sub.grade : r.snap.grade) }, { key: 'result', label: 'Result', get: (r) => r.snap.resultStatus, only: 'summary' },
    ],
    defaults: ['admissionNo', 'name', 'class', 'section', 'exam', 'obtained', 'max', 'percentage', 'grade', 'result'],
    async rows(ctx, f) {
      const classIds = ok24(list(f.classIds)); const sectionIds = ok24(list(f.sectionIds));
      const [cards, classes, sections] = await Promise.all([
        ReportCard.find({ tenantId: ctx.tenantId, isCurrent: true, ...(ctx.year ? { yearId: ctx.year._id } : {}), ...(/^[a-f0-9]{24}$/i.test(f.examId || '') ? { examId: f.examId } : {}), ...(classIds.length ? { classId: { $in: classIds } } : {}), ...(sectionIds.length ? { sectionId: { $in: sectionIds } } : {}) }).lean(),
        ClassModel.find({ tenantId: ctx.tenantId }).select('name level').lean(), Section.find({ tenantId: ctx.tenantId }).select('name').lean(),
      ]);
      const C = new Map(classes.map((c) => [String(c._id), c])); const S = new Map(sections.map((s) => [String(s._id), s.name]));
      const rows = cards.map((c) => ({ snap: c.snapshot || {}, className: C.get(String(c.classId))?.name || '', level: C.get(String(c.classId))?.level ?? 999, section: S.get(String(c.sectionId)) || '' }))
        .sort((a, b) => a.level - b.level || a.section.localeCompare(b.section) || String(a.snap.exam?.name).localeCompare(String(b.snap.exam?.name)) || String(a.snap.student?.name).localeCompare(String(b.snap.student?.name)));
      return f.layout === 'subjects' ? rows.flatMap((r) => (r.snap.subjects || []).map((sub) => ({ ...r, sub }))) : rows;
    },
  },

  student_fees: {
    group: 'Students', label: 'Student fees', filters: ['classes', 'sections', 'studentStatus', 'feeState'], need: 'finance_view',
    about: 'What each student was billed, has paid and still owes this year.',
    columns: [
      ...idCols, { key: 'billed', label: 'Billed', get: (r) => num(r.billed) }, { key: 'concession', label: 'Concession', get: (r) => num(r.concession) }, { key: 'paid', label: 'Paid', get: (r) => num(r.paid) },
      { key: 'due', label: 'Outstanding', get: (r) => num(r.due) }, { key: 'overdue', label: 'Overdue', get: (r) => num(r.overdue) },
    ],
    defaults: ['admissionNo', 'name', 'class', 'section', 'billed', 'concession', 'paid', 'due', 'overdue'],
    async rows(ctx, f) {
      const base = await studentBase(ctx, f);
      const agg = await StudentCharge.aggregate([{ $match: { tenantId: ctx.tenantId, studentId: { $in: base.map((b) => b.s._id) }, ...(ctx.year ? { yearId: ctx.year._id } : {}) } }, { $group: { _id: '$studentId', amount: { $sum: '$amount' }, concession: { $sum: '$concession' }, paid: { $sum: '$paidAmount' },
        overdue: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'open'] }, { $lt: ['$dueDate', ctx.today] }] }, { $subtract: [{ $subtract: ['$amount', '$concession'] }, '$paidAmount'] }, 0] } } } }]);
      const m = new Map(agg.map((a) => [String(a._id), a]));
      const rows = base.map((b) => { const a = m.get(String(b.s._id)) || {}; const billed = (a.amount || 0) - (a.concession || 0); return { ...b, billed: a.amount || 0, concession: a.concession || 0, paid: a.paid || 0, due: Math.max(0, billed - (a.paid || 0)), overdue: a.overdue || 0 }; });
      return f.feeState === 'due' ? rows.filter((r) => r.due > 0) : f.feeState === 'overdue' ? rows.filter((r) => r.overdue > 0) : f.feeState === 'clear' ? rows.filter((r) => r.due <= 0 && r.billed > 0) : rows;
    },
  },

  employees: {
    group: 'Teachers and staff', label: 'Employee profiles', filters: ['category', 'designation', 'employeeStatus'], need: 'teachers',
    about: 'Teachers, non-teaching staff, desk holders and the transport crew: who they are and how to reach them.',
    columns: [
      { key: 'code', label: 'Employee Id', get: (r) => r.code }, { key: 'name', label: 'Name', get: (r) => r.name }, { key: 'group', label: 'Group', get: (r) => ({ teaching: 'Teaching', non_teaching: 'Non-teaching', office: r.desk ? `${r.desk} desk holder` : 'Desk holder', transport: 'Transport crew' }[r.category]) },
      { key: 'designation', label: 'Designation', get: (r) => r.designation }, { key: 'phone', label: 'Phone', get: (r) => r.phone }, { key: 'email', label: 'Email', get: (r) => r.email },
      { key: 'joined', label: 'Joined', get: (r) => r.joiningDate }, { key: 'status', label: 'Status', get: (r) => (r.status === 'active' ? 'Working' : 'Left') }, { key: 'login', label: 'Has login', get: (r) => (r.hasLogin ? 'Yes' : 'No') },
      { key: 'subjects', label: 'Subjects', get: (r) => (r.subjects || []).join('; ') }, { key: 'classes', label: 'Classes taught', get: (r) => (r.classes || []).join('; ') }, { key: 'classTeacher', label: 'Class teacher of', get: (r) => r.classTeacherOf },
      { key: 'bus', label: 'On bus', get: (r) => r.bus }, { key: 'licence', label: 'Licence expires', get: (r) => r.licenseExpiry },
    ],
    defaults: ['code', 'name', 'group', 'designation', 'phone', 'email', 'joined', 'status'],
    rows: async (ctx, f) => (await listEmployees(ctx, { category: f.category || undefined, designation: f.designation || undefined, status: f.employeeStatus || 'active', limit: 1000 })).items,
  },

  employee_attendance: {
    group: 'Teachers and staff', label: 'Employee attendance', filters: ['category', 'designation', 'employeeStatus', 'dates', 'layout:attendance'], need: 'staff_attendance',
    about: 'Days present, absent, late and on leave for teachers and staff over a period, or day by day.',
    columns: [
      { key: 'code', label: 'Employee Id', get: (r) => r.p.code }, { key: 'name', label: 'Name', get: (r) => r.p.name }, { key: 'designation', label: 'Designation', get: (r) => r.p.designation },
      { key: 'date', label: 'Date', get: (r) => r.date, only: 'daily' }, { key: 'dayStatus', label: 'Status', get: (r) => r.status, only: 'daily' }, { key: 'checkIn', label: 'In', get: (r) => r.checkIn, only: 'daily' }, { key: 'checkOut', label: 'Out', get: (r) => r.checkOut, only: 'daily' }, { key: 'remarks', label: 'Remark', get: (r) => r.remark, only: 'daily' },
      { key: 'days', label: 'Days recorded', get: (r) => r.sum?.workingDays, only: 'summary' }, { key: 'present', label: 'Present', get: (r) => r.sum?.present, only: 'summary' }, { key: 'absent', label: 'Absent', get: (r) => r.sum?.absent, only: 'summary' },
      { key: 'late', label: 'Late', get: (r) => r.sum?.late, only: 'summary' }, { key: 'half', label: 'Half days', get: (r) => r.sum?.half_day, only: 'summary' }, { key: 'leave', label: 'On leave', get: (r) => r.sum?.leave, only: 'summary' }, { key: 'percentage', label: 'Attendance %', get: (r) => r.sum?.percentage, only: 'summary' },
    ],
    defaults: ['code', 'name', 'designation', 'days', 'present', 'absent', 'late', 'leave', 'percentage'],
    async rows(ctx, f) {
      const people = (await listEmployees(ctx, { category: f.category || undefined, designation: f.designation || undefined, status: f.employeeStatus || 'active', limit: 1000 })).items.filter((p) => p.category !== 'transport' || f.category === 'transport');
      const byId = new Map(people.map((p) => [String(p.id), p]));
      const match = { tenantId: ctx.tenantId, personId: { $in: people.map((p) => p.id) }, ...(Object.keys(inRange(f)).length ? { date: inRange(f) } : {}) };
      if (f.layout === 'daily') {
        const recs = await StaffAttendanceRecord.find(match).sort({ date: 1 }).lean();
        const order = new Map(people.map((p, i) => [String(p.id), i]));
        return recs.sort((a, b) => order.get(String(a.personId)) - order.get(String(b.personId)) || a.date.localeCompare(b.date)).map((x) => ({ p: byId.get(String(x.personId)), date: x.date, status: x.status, checkIn: x.checkIn, checkOut: x.checkOut, remark: x.remark }));
      }
      const agg = await StaffAttendanceRecord.aggregate([{ $match: match }, { $group: { _id: { p: '$personId', st: '$status' }, n: { $sum: 1 } } }]);
      const counts = new Map();
      for (const a of agg) { const k = String(a._id.p); if (!counts.has(k)) counts.set(k, zeroCounts()); if (a._id.st in counts.get(k)) counts.get(k)[a._id.st] = a.n; }
      return people.map((p) => ({ p, sum: summarizeCounts(counts.get(String(p.id)) || zeroCounts(), ctx.settings) }));
    },
  },

  payroll: {
    group: 'Teachers and staff', label: 'Payroll and salaries', filters: ['category', 'designation', 'months', 'payStatus'], need: 'payroll',
    about: 'Payslips for the months you choose: pay, deductions, net salary and whether it was paid.',
    columns: [
      { key: 'month', label: 'Month', get: (r) => r.month }, { key: 'payslipNo', label: 'Payslip No', get: (r) => r.payslipNo }, { key: 'code', label: 'Employee Id', get: (r) => r.employeeId }, { key: 'name', label: 'Name', get: (r) => r.personName },
      { key: 'type', label: 'Teaching / staff', get: (r) => (r.personType === 'teacher' ? 'Teaching' : 'Staff') }, { key: 'designation', label: 'Designation', get: (r) => r.designation },
      { key: 'workingDays', label: 'Working days', get: (r) => r.workingDays }, { key: 'paidDays', label: 'Paid days', get: (r) => r.paidDays }, { key: 'unpaidDays', label: 'Unpaid days', get: (r) => r.unpaidDays },
      { key: 'gross', label: 'Gross', get: (r) => num(r.gross) }, { key: 'deductions', label: 'Deductions', get: (r) => num(r.totalDeductions) }, { key: 'lop', label: 'Loss of pay', get: (r) => num(r.lossOfPay) }, { key: 'net', label: 'Net pay', get: (r) => num(r.net) },
      { key: 'status', label: 'Payment', get: (r) => r.status }, { key: 'paidAmount', label: 'Paid so far', get: (r) => num(r.paidAmount) }, { key: 'paidOn', label: 'Paid on', get: (r) => r.paidOn }, { key: 'mode', label: 'Mode', get: (r) => r.mode }, { key: 'reference', label: 'Reference', get: (r) => r.reference },
    ],
    defaults: ['month', 'code', 'name', 'designation', 'gross', 'deductions', 'net', 'status', 'paidOn'],
    async rows(ctx, f) {
      const from = MONTH.test(f.fromMonth || '') ? f.fromMonth : undefined; const to = MONTH.test(f.toMonth || '') ? f.toMonth : undefined;
      const type = f.category === 'teaching' ? 'teacher' : f.category ? 'staff' : undefined;
      const rows = await Payslip.find({ tenantId: ctx.tenantId, ...(from || to ? { month: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {}), ...(type ? { personType: type } : {}), ...(f.designation ? { designation: f.designation } : {}), ...(['pending', 'partial', 'paid'].includes(f.payStatus) ? { status: f.payStatus } : {}) }).lean();
      return rows.sort((a, b) => a.month.localeCompare(b.month) || String(a.personName).localeCompare(String(b.personName)));
    },
  },
};

/** What the page needs to draw the filters: the datasets and their columns, plus the choices (classes, sections, exams, designations, months). */
export async function catalog(ctx, user) {
  const { tenantId, year } = ctx;
  const [classes, sections, exams, designations, runs] = await Promise.all([
    ClassModel.find({ tenantId }).select('name level').sort({ level: 1 }).lean(), Section.find({ tenantId, yearId: year?._id, status: 'active' }).select('name classId').lean(),
    Examination.find({ tenantId, yearId: year?._id }).select('name').sort({ startDate: 1 }).lean(), Designation.find({ tenantId }).select('name group').sort({ name: 1 }).lean(), PayrollRun.find({ tenantId }).select('month').lean(),
  ]);
  const sub = user.role === 'school_admin' && user.adminLevel === 'sub';
  return {
    year: year?.name,
    datasets: Object.entries(DATASETS).filter(([, d]) => !sub || (user.permissions || []).includes(d.need)).map(([key, d]) => ({ key, group: d.group, label: d.label, about: d.about, filters: d.filters, defaults: d.defaults, columns: d.columns.map((c) => ({ key: c.key, label: c.label, only: c.only })) })),
    options: {
      classes: classes.map((c) => ({ id: c._id, name: c.name })), sections: sections.map((s) => ({ id: s._id, name: s.name, classId: s.classId })), exams: exams.map((e) => ({ id: e._id, name: e.name })),
      designations: [...new Set(designations.map((d) => d.name))], months: [...new Set(runs.map((r) => r.month))].sort().reverse(),
    },
  };
}

/** The file (or the first rows of it) for a dataset, the filters chosen and the columns ticked. */
export async function build(ctx, user, q, { preview = false } = {}) {
  const d = DATASETS[q.dataset];
  if (!d) throw bad('Choose what to export');
  if (user.role === 'school_admin' && user.adminLevel === 'sub' && !(user.permissions || []).includes(d.need)) throw bad('Your sub-admin account does not include this export');
  const layout = q.layout === 'daily' || q.layout === 'subjects' ? q.layout : 'summary';
  const wanted = new Set(list(q.columns));
  const columns = d.columns.filter((c) => (!c.only || c.only === layout) && (wanted.size ? wanted.has(c.key) : d.defaults.includes(c.key) || (layout !== 'summary' && c.only === layout)));
  if (!columns.length) throw bad('Tick at least one column');
  const rows = await d.rows(ctx, q);
  if (preview) return { total: rows.length, columns: columns.map((c) => c.label), rows: rows.slice(0, 8).map((r) => columns.map((c) => c.get(r) ?? '')) };
  return { name: `${q.dataset.replace(/_/g, '-')}-${ctx.today}.csv`, total: rows.length, csv: `\ufeff${toCsv(rows, columns)}` };
}
