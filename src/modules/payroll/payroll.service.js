import PDFDocument from 'pdfkit';
import { StaffLeave, PayLevel, SalaryRevision, PayrollRun, Payslip, Teacher, LeaveApplication, CalendarEvent, School, StaffMember, Designation, StaffAttendanceSession, StaffAttendanceRecord } from '../../models/index.js';
import { bad, conflict, notFound, forbidden, eachDate, escapeRegex, round2, toCsv, monthOf } from '../../core/utils.js';
import { notifyUsers } from '../../services/notify.js';
import { structureOf, computePayslip, monthBounds, workingDates } from './payroll.calc.js';

// ───────────── pay levels ─────────────
export async function listLevels(ctx) {
  const [levels, counts] = await Promise.all([
    PayLevel.find({ tenantId: ctx.tenantId }).sort({ order: 1, name: 1 }).lean(),
    SalaryRevision.aggregate([{ $match: { tenantId: ctx.tenantId, effectiveFrom: { $lte: ctx.today } } }, { $sort: { effectiveFrom: -1, createdAt: -1 } }, { $group: { _id: '$personId', levelId: { $first: '$levelId' } } }, { $group: { _id: '$levelId', n: { $sum: 1 } } }]),
  ]);
  const n = new Map(counts.map((c) => [String(c._id), c.n]));
  return levels.map((l) => ({ ...l, ...structureOf(l), teachers: n.get(String(l._id)) || 0 }));
}

export async function createLevel(ctx, body) {
  if (await PayLevel.exists({ tenantId: ctx.tenantId, name: new RegExp(`^${escapeRegex(body.name)}$`, 'i') })) throw conflict(`A pay level called "${body.name}" already exists`);
  return PayLevel.create({ ...body, tenantId: ctx.tenantId });
}

export async function updateLevel(ctx, id, patch) {
  const l = await PayLevel.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!l) throw notFound('Pay level not found');
  if (patch.name && patch.name.toLowerCase() !== l.name.toLowerCase() && await PayLevel.exists({ tenantId: ctx.tenantId, name: new RegExp(`^${escapeRegex(patch.name)}$`, 'i'), _id: { $ne: l._id } })) throw conflict(`A pay level called "${patch.name}" already exists`);
  Object.assign(l, patch);
  // editing a level never changes anyone's salary: teachers keep the figures they were given (revise them to apply the new level)
  return l.save();
}

export async function deleteLevel(ctx, id) {
  const l = await PayLevel.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!l) throw notFound('Pay level not found');
  if (await SalaryRevision.exists({ tenantId: ctx.tenantId, levelId: l._id })) throw conflict('Teachers have been paid under this level. Archive it instead of deleting.');
  await l.deleteOne();
}

// ───────────── salaries ─────────────
async function latestRevisions(tenantId, onOrBefore) {
  const rows = await SalaryRevision.find({ tenantId, effectiveFrom: { $lte: onOrBefore } }).sort({ effectiveFrom: -1, createdAt: -1 }).lean();
  const m = new Map();
  for (const r of rows) if (!m.has(String(r.personId))) m.set(String(r.personId), r);
  return m;
}

/** Anyone who can be paid: a teacher or a non-teaching / transport staff member. */
async function loadPerson(ctx, id) {
  const t = await Teacher.findOne({ _id: id, tenantId: ctx.tenantId });
  if (t) return { type: 'teacher', doc: t, name: t.name, code: t.employeeId, designation: t.designation, userId: t.userId, joiningDate: t.joiningDate, active: t.status === 'active' };
  const st = await StaffMember.findOne({ _id: id, tenantId: ctx.tenantId });
  if (st) { const d = await Designation.findById(st.designationId).lean(); return { type: 'staff', doc: st, name: st.name, code: st.staffId, designation: d?.name, group: d?.group, joiningDate: st.joiningDate, active: st.status === 'active' }; }
  throw notFound('Person not found');
}

async function allPeople(ctx, type = 'all') {
  const out = [];
  if (type !== 'staff') for (const t of await Teacher.find({ tenantId: ctx.tenantId, status: 'active' }).sort({ name: 1 }).lean()) out.push({ type: 'teacher', id: t._id, name: t.name, code: t.employeeId, designation: t.designation || 'Teacher', userId: t.userId, joiningDate: t.joiningDate });
  if (type !== 'teachers') {
    const D = new Map((await Designation.find({ tenantId: ctx.tenantId }).lean()).map((d) => [String(d._id), d]));
    for (const s of await StaffMember.find({ tenantId: ctx.tenantId, status: 'active' }).sort({ name: 1 }).lean()) out.push({ type: 'staff', id: s._id, name: s.name, code: s.staffId, designation: D.get(String(s.designationId))?.name, group: D.get(String(s.designationId))?.group, joiningDate: s.joiningDate });
  }
  return out;
}

export async function listSalaries(ctx, q) {
  const revs = await latestRevisions(ctx.tenantId, ctx.today);
  const rx = q.q ? new RegExp(escapeRegex(q.q), 'i') : null;
  const rows = (await allPeople(ctx, q.type)).filter((p) => !rx || rx.test(p.name) || rx.test(p.code || '')).map((p) => {
    const r = revs.get(String(p.id));
    return { personType: p.type, personId: p.id, name: p.name, code: p.code, designation: p.designation, group: p.group, joiningDate: p.joiningDate, revision: r ? { ...r, ...structureOf(r) } : null };
  }).filter((x) => (q.levelId ? String(x.revision?.levelId) === q.levelId : true) && (q.status === 'with' ? x.revision : q.status === 'without' ? !x.revision : true));
  return { items: rows, withSalary: rows.filter((x) => x.revision).length, withoutSalary: rows.filter((x) => !x.revision).length };
}

async function buildRevision(ctx, person, body) {
  let base = {};
  let level = null;
  if (body.levelId) {
    level = await PayLevel.findOne({ _id: body.levelId, tenantId: ctx.tenantId });
    if (!level) throw notFound('Pay level not found');
    if (level.status !== 'active') throw bad('That pay level is archived');
    if ((level.appliesTo === 'non_teaching') !== (person.type === 'staff')) throw bad(`${level.name} is a ${level.appliesTo === 'non_teaching' ? 'non-teaching' : 'teaching'} pay level and cannot be given to ${person.name}`);
    base = { basic: level.basic, allowances: level.allowances.map((a) => a.toObject()), deductions: level.deductions.map((d) => d.toObject()) };
  }
  return {
    tenantId: ctx.tenantId, personType: person.type, personId: person.doc._id, effectiveFrom: body.effectiveFrom, levelId: level?._id, levelName: level?.name,
    basic: body.basic ?? base.basic, allowances: body.allowances ?? base.allowances ?? [], deductions: body.deductions ?? base.deductions ?? [],
    reason: body.reason, by: ctx.actorId, byName: ctx.actorName,
  };
}

async function assertNotPaidFor(ctx, personId, effectiveFrom) {
  // changing pay for a month that already has an approved payroll would silently disagree with the payslip
  const month = monthOf(effectiveFrom);
  const slip = await Payslip.findOne({ tenantId: ctx.tenantId, personId, month: { $gte: month } }).populate('runId', 'status').lean();
  if (slip && slip.runId && slip.runId.status !== 'draft') throw conflict(`Payroll for ${slip.month} is already approved. Choose an effective date after it.`);
}

export async function setSalary(ctx, personId, body) {
  const person = await loadPerson(ctx, personId);
  await assertNotPaidFor(ctx, person.doc._id, body.effectiveFrom);
  const doc = await buildRevision(ctx, person, body);
  const dup = await SalaryRevision.findOne({ tenantId: ctx.tenantId, personId: person.doc._id, effectiveFrom: body.effectiveFrom });
  const rev = dup ? Object.assign(dup, doc) : new SalaryRevision(doc);
  await rev.save();
  if (body.levelId && person.type === 'teacher') await Teacher.updateOne({ _id: person.doc._id }, { $set: { designation: person.designation || doc.levelName } });
  return { ...rev.toObject(), ...structureOf(rev) };
}

export async function setSalaryBulk(ctx, body) {
  let done = 0; const failed = [];
  for (const id of body.personIds) {
    try { await setSalary(ctx, id, { levelId: body.levelId, effectiveFrom: body.effectiveFrom, reason: body.reason }); done += 1; } catch (e) { failed.push({ personId: id, error: e.message }); }
  }
  return { updated: done, failed };
}

export async function salaryHistory(ctx, personId) {
  const person = await loadPerson(ctx, personId);
  const rows = await SalaryRevision.find({ tenantId: ctx.tenantId, personId: person.doc._id }).sort({ effectiveFrom: -1, createdAt: -1 }).lean();
  return { person: { name: person.name, code: person.code, designation: person.designation, personType: person.type }, history: rows.map((r) => ({ ...r, ...structureOf(r) })) };
}

// ───────────── payroll runs ─────────────
async function holidaySet(tenantId, month) {
  const { start, end } = monthBounds(month);
  const events = await CalendarEvent.find({ tenantId, type: 'holiday', startDate: { $lte: end }, endDate: { $gte: start }, sectionIds: { $size: 0 } }).lean();
  const out = new Set();
  for (const e of events) for (const d of eachDate(e.startDate < start ? start : e.startDate, e.endDate > end ? end : e.endDate)) out.add(d);
  return out;
}

/**
 * The part of each working day a person is NOT paid for, as a fraction (1 = the whole day).
 * Approved unpaid leave, days before they joined, and days marked absent in a submitted staff register cost a whole day; a half day costs half.
 * Registers that were never submitted cost nothing: unmarked is not absent.
 */
function unpaidFractions(person, unpaidLeaves, marked, month, workSet) {
  const { start, end } = monthBounds(month);
  const out = new Map();
  for (const l of unpaidLeaves) for (const d of eachDate(l.startDate < start ? start : l.startDate, l.endDate > end ? end : l.endDate)) if (workSet.has(d)) out.set(d, 1);
  if (person.joiningDate && person.joiningDate > start) for (const d of workSet) if (d < person.joiningDate) out.set(d, 1);
  for (const [d, status] of marked || []) {
    if (!workSet.has(d) || out.get(d) === 1) continue;
    if (status === 'absent') out.set(d, 1); else if (status === 'half_day') out.set(d, 0.5);
  }
  return [...out.values()].reduce((n, x) => n + x, 0);
}

async function markedDays(tenantId, month) {
  const { start, end } = monthBounds(month);
  const sessions = await StaffAttendanceSession.find({ tenantId, status: 'submitted', date: { $gte: start, $lte: end } }).select('_id').lean();
  const by = new Map();
  if (!sessions.length) return by;
  for (const r of await StaffAttendanceRecord.find({ tenantId, sessionId: { $in: sessions.map((x) => x._id) } }).select('personId date status').lean()) {
    const k = String(r.personId); if (!by.has(k)) by.set(k, new Map()); by.get(k).set(r.date, r.status);
  }
  return by;
}

async function generate(ctx, run) {
  const { month } = run;
  const { end } = monthBounds(month);
  const work = workingDates(ctx.settings, month, await holidaySet(ctx.tenantId, month));
  const workSet = new Set(work);
  const [people, revs, leaves, existing, marked] = await Promise.all([
    allPeople(ctx),
    latestRevisions(ctx.tenantId, end),
    Promise.all([LeaveApplication.find({ tenantId: ctx.tenantId, status: 'approved', leaveType: 'unpaid', startDate: { $lte: end }, endDate: { $gte: `${month}-01` } }).lean(),
      StaffLeave.find({ tenantId: ctx.tenantId, status: 'approved', leaveType: 'unpaid', startDate: { $lte: end }, endDate: { $gte: `${month}-01` } }).lean()]).then(([t, st]) => [...t.map((l) => ({ ...l, personId: l.teacherId })), ...st.map((l) => ({ ...l, personId: l.staffId }))]),
    Payslip.find({ tenantId: ctx.tenantId, runId: run._id }).lean(),
    markedDays(ctx.tenantId, month),
  ]);
  const prior = new Map(existing.map((p) => [String(p.personId), p]));
  const leaveBy = new Map();
  for (const l of leaves) leaveBy.set(String(l.personId), [...(leaveBy.get(String(l.personId)) || []), l]);

  const docs = []; const skipped = [];
  for (const t of people) {
    const rev = revs.get(String(t.id));
    if (t.joiningDate && t.joiningDate > end) { skipped.push({ personId: t.id, personType: t.type, name: t.name, reason: `Joins on ${t.joiningDate}` }); continue; }
    if (!rev) { skipped.push({ personId: t.id, personType: t.type, name: t.name, reason: 'No salary set' }); continue; }
    const old = prior.get(String(t.id));
    const calc = computePayslip({ revision: rev, workingDays: work.length, unpaidDays: unpaidFractions(t, leaveBy.get(String(t.id)) || [], marked.get(String(t.id)), month, workSet), adjustments: old?.adjustments || [], policy: ctx.settings.statutory });
    docs.push({
      tenantId: ctx.tenantId, runId: run._id, month, payslipNo: `PAY${month.replace('-', '')}-${t.code}`, personType: t.type, personId: t.id, userId: t.userId, personName: t.name,
      employeeId: t.code, designation: t.designation, levelName: rev.levelName, ...calc, adjustments: old?.adjustments || [],
      status: 'pending',
    });
  }
  // update in place (upsert) so a payslip keeps its id across recalculations; drop slips for people who no longer qualify
  if (docs.length) await Payslip.bulkWrite(docs.map((d) => ({ updateOne: { filter: { tenantId: ctx.tenantId, runId: run._id, personId: d.personId }, update: { $set: d }, upsert: true } })));
  await Payslip.deleteMany({ tenantId: ctx.tenantId, runId: run._id, status: 'pending', personId: { $nin: docs.map((d) => d.personId) } });
  run.workingDays = work.length;
  run.skipped = skipped;
  await refreshTotals(run);
  return run;
}

async function refreshTotals(run) {
  const [t] = await Payslip.aggregate([{ $match: { runId: run._id } }, { $group: { _id: null, count: { $sum: 1 }, gross: { $sum: '$gross' }, deductions: { $sum: '$totalDeductions' }, net: { $sum: '$net' }, paid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$net', 0] } } } }]);
  run.totals = { count: t?.count || 0, gross: round2(t?.gross || 0), deductions: round2(t?.deductions || 0), net: round2(t?.net || 0), paid: round2(t?.paid || 0) };
  await run.save();
  return run;
}

export async function createRun(ctx, { month }) {
  if (month > ctx.today.slice(0, 7)) throw bad('Payroll can only be run for the current or an earlier month');
  if (await PayrollRun.exists({ tenantId: ctx.tenantId, month })) throw conflict(`Payroll for ${month} already exists`);
  const run = await PayrollRun.create({ tenantId: ctx.tenantId, month, generatedBy: ctx.actorId });
  await generate(ctx, run);
  if (!run.totals.count) { await run.deleteOne(); throw bad('Nobody has a salary set for that month. Set salaries first.', { skipped: run.skipped }); }
  return run;
}

const ownRun = async (ctx, id) => {
  const run = await PayrollRun.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!run) throw notFound('Payroll run not found');
  return run;
};
const draftOnly = (run) => { if (run.status !== 'draft') throw conflict(`This payroll is ${run.status} and can no longer be changed`); };

export async function recalculate(ctx, id) {
  const run = await ownRun(ctx, id); draftOnly(run);
  await generate(ctx, run);
  return run;
}

export async function deleteRun(ctx, id) {
  const run = await ownRun(ctx, id); draftOnly(run);
  await Payslip.deleteMany({ tenantId: ctx.tenantId, runId: run._id });
  await run.deleteOne();
}

export async function listRuns(ctx) {
  return PayrollRun.find({ tenantId: ctx.tenantId }).sort({ month: -1 }).lean();
}

export async function getRun(ctx, id) {
  const run = await ownRun(ctx, id);
  const payslips = await Payslip.find({ tenantId: ctx.tenantId, runId: run._id }).sort({ personName: 1 }).lean();
  return { run: run.toObject(), payslips };
}

export async function adjust(ctx, payslipId, { adjustments }) {
  const p = await Payslip.findOne({ _id: payslipId, tenantId: ctx.tenantId });
  if (!p) throw notFound('Payslip not found');
  const run = await ownRun(ctx, p.runId); draftOnly(run);
  const { end } = monthBounds(p.month);
  const rev = (await latestRevisions(ctx.tenantId, end)).get(String(p.personId));
  if (!rev) throw conflict('This teacher no longer has a salary on record');
  const calc = computePayslip({ revision: rev, workingDays: p.workingDays, unpaidDays: p.unpaidDays, adjustments, policy: ctx.settings.statutory });
  if (calc.net < 0) throw bad('These adjustments would make the net pay negative');
  Object.assign(p, calc, { adjustments });
  await p.save();
  await refreshTotals(run);
  return p;
}

export async function approve(ctx, id) {
  const run = await ownRun(ctx, id); draftOnly(run);
  if (!run.totals?.count) throw bad('Nothing to approve');
  run.status = 'approved'; run.approvedBy = ctx.actorId; run.approvedAt = new Date();
  await run.save();
  const slips = await Payslip.find({ tenantId: ctx.tenantId, runId: run._id }).select('userId month').lean();
  await notifyUsers(ctx.tenantId, slips.map((s) => s.userId), { category: 'payroll', title: `Payslip for ${run.month} is ready`, body: 'Your payslip has been approved. Payment will follow.', link: { type: 'payslip' }, dedupeKey: `payroll:${run._id}:approved` });
  return run;
}

export async function markPaid(ctx, id, body) {
  const run = await ownRun(ctx, id);
  if (run.status === 'draft') throw conflict('Approve the payroll before paying it');
  const paidOn = body.paidOn || ctx.today;
  const f = { tenantId: ctx.tenantId, runId: run._id, status: 'pending' };
  if (body.payslipIds?.length) f._id = { $in: body.payslipIds };
  const slips = await Payslip.find(f);
  if (!slips.length) throw conflict('Nothing left to pay');
  for (const p of slips) {
    // conditional update so two admins paying at once cannot pay a slip twice
    const r = await Payslip.updateOne({ _id: p._id, status: 'pending' }, { $set: { status: 'paid', paidOn, mode: body.mode, reference: body.reference, paidBy: ctx.actorId } });
    if (!r.modifiedCount) continue;
    await notifyUsers(ctx.tenantId, [p.userId], { category: 'payroll', title: 'Salary paid', body: `₹${p.net.toLocaleString('en-IN')} for ${run.month} was paid by ${body.mode.replace('_', ' ')}.`, link: { type: 'payslip', id: String(p._id) }, dedupeKey: `payslip:${p._id}:paid` });
  }
  const left = await Payslip.countDocuments({ tenantId: ctx.tenantId, runId: run._id, status: 'pending' });
  run.status = left ? 'approved' : 'paid';
  if (!left) run.paidAt = new Date();
  await refreshTotals(run);
  return run;
}

export async function summary(ctx) {
  const month = ctx.today.slice(0, 7);
  const [revs, people, run, ytd] = await Promise.all([
    latestRevisions(ctx.tenantId, ctx.today), allPeople(ctx), PayrollRun.findOne({ tenantId: ctx.tenantId, month }).lean(),
    Payslip.aggregate([{ $match: { tenantId: ctx.tenantId, status: 'paid', month: { $gte: ctx.year ? ctx.year.startDate.slice(0, 7) : '0000-00', $lte: ctx.year ? ctx.year.endDate.slice(0, 7) : '9999-99' } } }, { $group: { _id: null, n: { $sum: '$net' } } }]),
  ]);
  const current = people.map((t) => revs.get(String(t.id))).filter(Boolean).map((r) => structureOf(r));
  return {
    month, people: people.length, teachers: people.filter((p) => p.type === 'teacher').length, staff: people.filter((p) => p.type === 'staff').length, withSalary: current.length, withoutSalary: people.length - current.length,
    monthlyGross: round2(current.reduce((n, s) => n + s.gross, 0)), monthlyNet: round2(current.reduce((n, s) => n + s.net, 0)),
    thisMonth: run ? { _id: run._id, status: run.status, totals: run.totals } : null, paidThisYear: round2(ytd[0]?.n || 0),
  };
}

export async function exportRun(ctx, id) {
  const { run, payslips } = await getRun(ctx, id);
  const cols = [
    { label: 'Payslip', get: (p) => p.payslipNo }, { label: 'Employee id', get: (p) => p.employeeId }, { label: 'Name', get: (p) => p.personName }, { label: 'Level', get: (p) => p.levelName },
    { label: 'Working days', get: (p) => p.workingDays }, { label: 'Unpaid days', get: (p) => p.unpaidDays }, { label: 'Gross', get: (p) => p.gross }, { label: 'Loss of pay', get: (p) => p.lossOfPay },
    { label: 'Deductions (total)', get: (p) => p.totalDeductions }, { label: 'Net pay', get: (p) => p.net }, { label: 'Status', get: (p) => p.status }, { label: 'Paid on', get: (p) => p.paidOn }, { label: 'Mode', get: (p) => p.mode }, { label: 'Reference', get: (p) => p.reference },
  ];
  return { month: run.month, csv: toCsv(payslips, cols) };
}

// ───────────── self-service: a teacher or a staff member sees only their own pay ─────────────
const selfOf = (ctx) => ctx.teacher || ctx.staff;
const selfInfo = (ctx) => (ctx.teacher
  ? { name: ctx.teacher.name, employeeId: ctx.teacher.employeeId, designation: ctx.teacher.designation, joiningDate: ctx.teacher.joiningDate }
  : { name: ctx.staff.name, employeeId: ctx.staff.staffId, designation: ctx.designation?.name, joiningDate: ctx.staff.joiningDate });
const yearSpan = (ctx) => (ctx.year ? [ctx.year.startDate.slice(0, 7), ctx.year.endDate.slice(0, 7)] : [`${ctx.today.slice(0, 4)}-01`, `${ctx.today.slice(0, 4)}-12`]);

export async function mySalary(ctx) {
  const me = selfOf(ctx); const [from, to] = yearSpan(ctx);
  const [revs, history, ytd] = await Promise.all([
    latestRevisions(ctx.tenantId, ctx.today), SalaryRevision.find({ tenantId: ctx.tenantId, personId: me._id }).sort({ effectiveFrom: -1, createdAt: -1 }).lean(),
    Payslip.aggregate([{ $match: { tenantId: ctx.tenantId, personId: me._id, status: 'paid', month: { $gte: from, $lte: to } } }, { $group: { _id: null, n: { $sum: '$net' }, c: { $sum: 1 } } }]),
  ]);
  const rev = revs.get(String(me._id));
  return {
    teacher: selfInfo(ctx), person: selfInfo(ctx),
    current: rev ? { ...rev, ...structureOf(rev) } : null,
    history: history.map((r) => ({ effectiveFrom: r.effectiveFrom, levelName: r.levelName, ...structureOf(r) })),
    paidThisYear: round2(ytd[0]?.n || 0), monthsPaidThisYear: ytd[0]?.c || 0,
  };
}

/** Only your own payslips, and only after the payroll was approved. */
export async function myPayslips(ctx) {
  const runs = await PayrollRun.find({ tenantId: ctx.tenantId, status: { $in: ['approved', 'paid'] } }).select('_id').lean();
  return Payslip.find({ tenantId: ctx.tenantId, personId: selfOf(ctx)._id, runId: { $in: runs.map((r) => r._id) } }).sort({ month: -1 }).lean();
}

export async function ownPayslip(ctx, id) {
  const p = await Payslip.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!p) throw notFound('Payslip not found');
  if (ctx.role === 'teacher' || ctx.role === 'staff') {
    if (String(p.personId) !== String(selfOf(ctx)._id)) throw notFound('Payslip not found'); // never reveal that it exists
    const run = await PayrollRun.findById(p.runId).select('status').lean();
    if (!run || run.status === 'draft') throw forbidden('This payslip has not been approved yet');
  }
  return p;
}

const inr = (n) => `Rs ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export async function renderPayslip(tenantId, p, res) {
  const school = await School.findById(tenantId);
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  doc.pipe(res);
  const monthLabel = new Date(`${p.month}-01T00:00:00Z`).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  doc.fontSize(16).text(school?.name || 'School', { align: 'center' }).fontSize(12).text(`PAYSLIP — ${monthLabel}`, { align: 'center' }).moveDown();
  doc.fontSize(10).text(`Payslip no: ${p.payslipNo}`).text(`Name: ${p.personName} (${p.employeeId})`).text(`Designation: ${p.designation || '-'}${p.levelName ? ` · Level ${p.levelName}` : ''}`);
  doc.text(`Working days: ${p.workingDays} · Unpaid days: ${p.unpaidDays} · Paid days: ${p.paidDays}`).moveDown();
  const row = (a, b, bold) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(a, 48, doc.y, { continued: true }).text(b, { align: 'right' }); };
  row('Earnings', 'Amount', true);
  for (const e of p.earnings) row(e.label, inr(e.amount));
  for (const a of p.adjustments.filter((x) => x.type === 'earning')) row(`${a.label}${a.reason ? ` (${a.reason})` : ''}`, inr(a.amount));
  row('Gross earnings', inr(p.gross), true);
  doc.moveDown(0.5); row('Deductions', 'Amount', true);
  for (const d of p.deductions) row(d.label, inr(d.amount));
  if (p.lossOfPay) row(`Loss of pay (${p.unpaidDays} day${p.unpaidDays === 1 ? '' : 's'})`, inr(p.lossOfPay));
  for (const a of p.adjustments.filter((x) => x.type === 'deduction')) row(`${a.label}${a.reason ? ` (${a.reason})` : ''}`, inr(a.amount));
  row('Total deductions', inr(p.totalDeductions), true);
  doc.moveDown().fontSize(12); row('NET PAY', inr(p.net), true);
  doc.fontSize(10).font('Helvetica').moveDown();
  doc.text(p.status === 'paid' ? `Paid on ${p.paidOn} by ${String(p.mode || '').replace('_', ' ')}${p.reference ? ` · Ref ${p.reference}` : ''}` : 'Payment pending');
  doc.moveDown().fontSize(9).fillColor('#555').text('This is a computer generated payslip.');
  doc.end();
}

/** A teacher's pay as the School Admin sees it on the teacher's page: current structure, history, payslips. */
export async function teacherPay(ctx, teacherId) {
  const [revs, history, runs] = await Promise.all([
    latestRevisions(ctx.tenantId, ctx.today), SalaryRevision.find({ tenantId: ctx.tenantId, personId: teacherId }).sort({ effectiveFrom: -1, createdAt: -1 }).lean(),
    PayrollRun.find({ tenantId: ctx.tenantId, status: { $in: ['approved', 'paid'] } }).select('_id').lean(),
  ]);
  const slips = await Payslip.find({ tenantId: ctx.tenantId, personId: teacherId, runId: { $in: runs.map((r) => r._id) } }).sort({ month: -1 }).lean();
  const rev = revs.get(String(teacherId));
  return {
    current: rev ? { ...rev, ...structureOf(rev) } : null,
    history: history.map((r) => ({ effectiveFrom: r.effectiveFrom, levelName: r.levelName, reason: r.reason, byName: r.byName, ...structureOf(r) })),
    payslips: slips, paidThisYear: round2(slips.filter((p) => p.status === 'paid' && ctx.year && p.month >= ctx.year.startDate.slice(0, 7) && p.month <= ctx.year.endDate.slice(0, 7)).reduce((n, p) => n + p.net, 0)),
  };
}

// ───────────── bank transfer file ─────────────
async function peopleDetails(ctx, ids) {
  const [teachers, staff] = await Promise.all([Teacher.find({ tenantId: ctx.tenantId, _id: { $in: ids } }).select('bank statutory').lean(), StaffMember.find({ tenantId: ctx.tenantId, _id: { $in: ids } }).select('bank statutory').lean()]);
  return new Map([...teachers, ...staff].map((p) => [String(p._id), p]));
}

/**
 * The batch to upload to the bank's bulk-payment portal: one line per unpaid payslip that has bank details, and a list of who is missing them.
 * The school's bank does the actual payment; mark the run paid here once it has gone through.
 */
export async function bankFile(ctx, runId) {
  const run = await ownRun(ctx, runId);
  if (run.status === 'draft') throw conflict('Approve the payroll before preparing the bank file');
  const slips = await Payslip.find({ tenantId: ctx.tenantId, runId: run._id, status: 'pending' }).sort({ personName: 1 }).lean();
  const D = await peopleDetails(ctx, slips.map((p) => p.personId));
  const ready = []; const missing = [];
  for (const p of slips) {
    const b = D.get(String(p.personId))?.bank || {};
    if (!b.accountNo) { missing.push({ payslipId: p._id, name: p.personName, employeeId: p.employeeId, net: p.net, reason: 'No bank account on record' }); continue; }
    if (!b.ifsc) { missing.push({ payslipId: p._id, name: p.personName, employeeId: p.employeeId, net: p.net, reason: 'IFSC code missing' }); continue; }
    ready.push({ payslipId: p._id, payslipNo: p.payslipNo, name: b.accountName || p.personName, employeeId: p.employeeId, accountNo: b.accountNo, ifsc: b.ifsc, bankName: b.bankName || '', amount: p.net, narration: `Salary ${p.month}` });
  }
  return { month: run.month, status: run.status, ready, missing, total: round2(ready.reduce((n, r) => n + r.amount, 0)), count: ready.length };
}

export async function bankFileCsv(ctx, runId) {
  const f = await bankFile(ctx, runId);
  const cols = [
    { label: 'Beneficiary Name', get: (r) => r.name }, { label: 'Account Number', get: (r) => r.accountNo }, { label: 'IFSC', get: (r) => r.ifsc }, { label: 'Amount', get: (r) => r.amount },
    { label: 'Payment Mode', get: () => 'NEFT' }, { label: 'Narration', get: (r) => r.narration }, { label: 'Reference', get: (r) => r.payslipNo }, { label: 'Employee Id', get: (r) => r.employeeId }, { label: 'Bank', get: (r) => r.bankName },
  ];
  return { month: f.month, csv: toCsv(f.ready, cols) };
}

// ───────────── statutory reports (PF, ESI, Professional Tax) ─────────────
export async function statutoryReport(ctx, runId) {
  const { run, payslips } = await getRun(ctx, runId);
  const D = await peopleDetails(ctx, payslips.map((p) => p.personId));
  const withId = (p) => ({ ...(D.get(String(p.personId))?.statutory || {}) });
  const pf = []; const esi = []; const pt = []; const missing = [];
  for (const p of payslips) {
    const s = p.statutory; if (!s) continue; const ids = withId(p);
    if (s.pf && s.pf.employee > 0) { pf.push({ payslipNo: p.payslipNo, name: p.personName, employeeId: p.employeeId, uan: ids.uan || '', gross: p.gross, wages: s.pf.wages, employee: s.pf.employee, eps: s.pf.eps, epf: s.pf.epf, employer: s.pf.employer, ncpDays: Math.round(p.unpaidDays) }); if (!ids.uan) missing.push({ name: p.personName, what: 'UAN (for PF)' }); }
    if (s.esi && s.esi.employee > 0) { esi.push({ payslipNo: p.payslipNo, name: p.personName, employeeId: p.employeeId, esiNo: ids.esiNo || '', days: p.paidDays, gross: s.esi.gross, employee: s.esi.employee, employer: s.esi.employer }); if (!ids.esiNo) missing.push({ name: p.personName, what: 'ESI number' }); }
    if (s.pt && s.pt.amount > 0) pt.push({ payslipNo: p.payslipNo, name: p.personName, employeeId: p.employeeId, gross: s.pt.gross, amount: s.pt.amount });
  }
  const sum = (rows, k) => round2(rows.reduce((n, r) => n + r[k], 0));
  return {
    month: run.month, status: run.status, policy: ctx.settings.statutory, pf, esi, pt, missingIds: missing,
    totals: { pfEmployee: sum(pf, 'employee'), pfEmployer: sum(pf, 'employer'), pfWages: sum(pf, 'wages'), esiEmployee: sum(esi, 'employee'), esiEmployer: sum(esi, 'employer'), pt: sum(pt, 'amount') },
  };
}

/** PF "ECR text file" layout (one member per line, fields separated by #~#). Check it with the EPFO portal's validator before filing. */
export async function ecrFile(ctx, runId) {
  const r = await statutoryReport(ctx, runId);
  const lines = r.pf.filter((x) => x.uan).map((x) => [x.uan, x.name.toUpperCase(), Math.round(x.gross), Math.round(x.wages), Math.round(x.wages), Math.round(x.wages), Math.round(x.employee), Math.round(x.eps), Math.round(x.employer) - Math.round(x.eps), x.ncpDays, 0].join('#~#')); // the EPF/EPS difference is what is left of the employer's share, so the shares add up to the rupee
  return { month: r.month, text: lines.join('\n'), skipped: r.pf.filter((x) => !x.uan).map((x) => x.name) };
}

export async function esiCsv(ctx, runId) {
  const r = await statutoryReport(ctx, runId);
  return { month: r.month, csv: toCsv(r.esi, [{ label: 'IP Number', get: (x) => x.esiNo }, { label: 'IP Name', get: (x) => x.name }, { label: 'No of Days', get: (x) => x.days }, { label: 'Total Monthly Wages', get: (x) => x.gross }, { label: 'Employee Contribution', get: (x) => x.employee }, { label: 'Employer Contribution', get: (x) => x.employer }]) };
}
export async function ptCsv(ctx, runId) {
  const r = await statutoryReport(ctx, runId);
  return { month: r.month, csv: toCsv(r.pt, [{ label: 'Employee Id', get: (x) => x.employeeId }, { label: 'Name', get: (x) => x.name }, { label: 'Gross', get: (x) => x.gross }, { label: 'Professional Tax', get: (x) => x.amount }]) };
}
