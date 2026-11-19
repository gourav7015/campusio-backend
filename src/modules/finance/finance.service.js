import { rollStatus } from '../../services/context.js';
import { classSpan } from '../../services/yearSpan.js';
import PDFDocument from 'pdfkit';
import {
  FeeStructure, StudentCharge, Payment, Student, StudentEnrolment, Section, ClassModel, AcademicYear, School,
} from '../../models/index.js';
import { notFound, conflict, bad, round2, escapeRegex, eachDate, addDays, daysBetween, toCsv } from '../../core/utils.js';
import { nextSeq, settingsOf, loadSchool } from '../../services/context.js';
import { notifyUsers } from '../../services/notify.js';

const money = round2;
export const outstanding = (c) => money(c.amount - (c.concession || 0) - (c.paidAmount || 0));
const mk = (a) => new Map(a.map((x) => [String(x._id), x]));
const sumOf = (rows, f) => money(rows.reduce((n, r) => n + f(r), 0));

// ───────────── fee structures ─────────────
export async function listStructures(ctx, { yearId }) {
  const f = { tenantId: ctx.tenantId, yearId: yearId || ctx.year?._id };
  const list = await FeeStructure.find(f).sort({ createdAt: -1 }).lean();
  const [classes, agg] = await Promise.all([
    ClassModel.find({ tenantId: ctx.tenantId }).lean(),
    StudentCharge.aggregate([{ $match: { tenantId: ctx.tenantId, structureId: { $in: list.map((s) => s._id) } } }, { $group: { _id: { s: '$structureId', st: '$studentId' }, amount: { $sum: '$amount' }, paid: { $sum: '$paidAmount' } } },
      { $group: { _id: '$_id.s', students: { $sum: 1 }, amount: { $sum: '$amount' }, paid: { $sum: '$paid' } } }]),
  ]);
  const C = mk(classes); const A = new Map(agg.map((a) => [String(a._id), a]));
  return list.map((s) => ({ ...s, className: s.classId ? C.get(String(s.classId))?.name : 'All classes', total: structureTotal(s), months: s.monthlyFee ? 12 : undefined, students: A.get(String(s._id))?.students || 0, billed: A.get(String(s._id))?.amount || 0, collected: A.get(String(s._id))?.paid || 0 }));
}

export async function createStructure(ctx, body) {
  const year = body.yearId ? await AcademicYear.findOne({ _id: body.yearId, tenantId: ctx.tenantId }) : ctx.year;
  if (!year) throw notFound('Academic year not found');
  if (body.classId && !(await ClassModel.exists({ _id: body.classId, tenantId: ctx.tenantId }))) throw notFound('Class not found');
  try {
    return await FeeStructure.create({ ...body, classId: body.classId || undefined, tenantId: ctx.tenantId, yearId: year._id, createdBy: ctx.actorId });
  } catch (e) { if (e.code === 11000) throw conflict(`A fee structure named "${body.name}" already exists for this year`); throw e; }
}

export async function updateStructure(ctx, id, body) {
  const s = await FeeStructure.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!s) throw notFound('Fee structure not found');
  Object.assign(s, body);
  await s.save();
  return s;
}
export async function deleteStructure(ctx, id) {
  const s = await FeeStructure.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!s) throw notFound('Fee structure not found');
  if (await StudentCharge.exists({ tenantId: ctx.tenantId, structureId: s._id })) throw conflict('Students have been billed with this structure. Archive it instead of deleting.');
  await s.deleteOne();
}

// ───────────── billing students ─────────────
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (period) => `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
const pad2 = (n) => String(n).padStart(2, '0');

/** Fee policy of the school with sensible defaults for schools set up before policies existed. */
export function policyOf(settings) {
  const f = settings?.finance || {};
  return { dueDay: f.dueDay || 10, receiptFormat: f.receiptFormat || 'RCPT{YYYY}{SEQ:5}', advanceDiscount: { enabled: true, minMonths: 12, type: 'months', value: 1, ...(f.advanceDiscount || {}) } };
}

/** Months an academic year is billed for, starting at the month the student joined (never earlier than the year). */
export function billingMonths(year, fromDate, classId) {
  const span = classSpan(year, classId);
  const start = fromDate && fromDate > span.startDate ? fromDate : span.startDate;
  const out = [];
  let y = Number(start.slice(0, 4)); let m = Number(start.slice(5, 7));
  const endKey = span.endDate.slice(0, 7);
  while (`${y}-${pad2(m)}` <= endKey && out.length < 18) { out.push(`${y}-${pad2(m)}`); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
}
const dueOn = (period, day) => `${period}-${pad2(Math.min(day, 28))}`;

/** What a structure costs for a whole year: admission once, tuition for every month, and the extras. */
export function structureTotal(st) {
  if (!st.monthlyFee && !st.admissionFee && st.items?.length) return sumOf(st.items, (i) => i.amount); // legacy structure
  return money((st.admissionFee || 0) + (st.monthlyFee || 0) * 12 + (st.extras || []).reduce((n, e) => n + e.amount * (e.frequency === 'monthly' ? 12 : 1), 0));
}

function splitEven(total, n) {
  const each = money(total / n); const out = Array(n).fill(each);
  out[n - 1] = money(total - each * (n - 1));
  return out;
}

async function billStudent(ctx, structure, studentId, enrolment, spec) {
  const { tenantId, actorId } = ctx;
  if (await StudentCharge.exists({ tenantId, structureId: structure._id, studentId })) return false;
  const year = await AcademicYear.findById(structure.yearId);
  const policy = policyOf((await loadSchool(tenantId))?.settings);
  const dueDay = structure.dueDay || policy.dueDay;
  const months = billingMonths(year, enrolment?.startDate, enrolment?.classId || structure.classId);
  if (!months.length) return false;
  const base = { tenantId, studentId, yearId: structure.yearId, kind: 'fee', structureId: structure._id, createdBy: actorId };
  const docs = [];
  const firstDue = dueOn(months[0], dueDay);
  if (structure.admissionFee > 0) docs.push({ ...base, label: 'Admission fee', category: 'Admission', amount: structure.admissionFee, dueDate: enrolment?.startDate && enrolment.startDate > firstDue ? enrolment.startDate : firstDue });
  // tuition: one charge per month, with any scholarship spread evenly across them
  const total = money(structure.monthlyFee * months.length);
  let conc = 0;
  if (!spec) { // a standing personal discount follows the student into every month billed (a new year, a new structure)
    const pd = (await Student.findOne({ _id: studentId, tenantId }).select('personalDiscount').lean())?.personalDiscount;
    if (pd?.type) spec = pd.type === 'percent' ? { type: 'percent', value: pd.value, reason: pd.reason, kind: 'personal' } : { type: 'amount', value: money(pd.value * months.length), reason: pd.reason, kind: 'personal' };
  }
  if (spec) conc = spec.type === 'percent' ? money((total * Math.min(spec.value, 100)) / 100) : Math.min(money(spec.value), total);
  if (spec) spec.applied = conc; // how much was actually taken off, for callers that give one amount across several structures
  const cparts = splitEven(conc, months.length);
  months.forEach((m, i) => docs.push({ ...base, label: `Tuition fee — ${monthName(m)}`, category: 'Tuition', period: m, amount: structure.monthlyFee, concession: cparts[i], concessionNote: conc ? spec.reason : undefined,
    concessions: cparts[i] ? [{ amount: cparts[i], reason: spec.reason, kind: spec.kind, by: actorId, at: new Date() }] : [], dueDate: dueOn(m, dueDay) }));
  for (const e of structure.extras || []) {
    if (e.frequency === 'monthly') months.forEach((m) => docs.push({ ...base, label: `${e.head} — ${monthName(m)}`, category: e.head, period: m, amount: e.amount, dueDate: dueOn(m, dueDay) }));
    else docs.push({ ...base, label: e.head, category: e.head, amount: e.amount, dueDate: firstDue });
  }
  await StudentCharge.insertMany(docs);
  return true;
}

/** Targets = students with an active enrolment in the structure's year (and class, when the structure is class-specific). */
async function targetStudents(ctx, structure, body) {
  const f = { tenantId: ctx.tenantId, yearId: structure.yearId, status: 'active' };
  if (structure.classId) f.classId = structure.classId;
  if (body.sectionId) f.sectionId = body.sectionId;
  if (body.studentIds?.length) f.studentId = { $in: body.studentIds };
  const enr = await StudentEnrolment.find(f).lean();
  const active = new Set((await Student.find({ tenantId: ctx.tenantId, _id: { $in: enr.map((e) => e.studentId) }, status: 'active' }).select('_id').lean()).map((s) => String(s._id)));
  return enr.filter((e) => active.has(String(e.studentId)));
}

export async function assignStructure(ctx, body) {
  const structure = await FeeStructure.findOne({ _id: body.structureId, tenantId: ctx.tenantId });
  if (!structure) throw notFound('Fee structure not found');
  if (structure.status !== 'active') throw conflict('This fee structure is archived');
  const targets = await targetStudents(ctx, structure, body);
  if (!targets.length) throw bad('No enrolled students match for this structure (check the class and section)');
  let assigned = 0; let skipped = 0;
  for (const e of targets) (await billStudent(ctx, structure, e.studentId, e, body.concession)) ? assigned++ : skipped++;
  return { assigned, skipped };
}

const autoStructures = (tenantId, enrolment) => FeeStructure.find({ tenantId, yearId: enrolment.yearId, status: 'active', autoAssign: true, $or: [{ classId: null }, { classId: { $exists: false } }, { classId: enrolment.classId }] });

/**
 * What a new student will be billed, computed the way billStudent bills: admission fee once, tuition for each month from the joining
 * month to the end of the year, and the extras. Used by the admission form so the numbers shown are the numbers charged.
 */
export async function admissionFeePreview(tenantId, { yearId, classId, startDate }) {
  const year = await AcademicYear.findById(yearId);
  const months = billingMonths(year, startDate, classId);
  const structures = (await autoStructures(tenantId, { yearId, classId })).map((st) => {
    const admissionFee = st.admissionFee || 0; const tuition = money((st.monthlyFee || 0) * months.length);
    const extras = money((st.extras || []).reduce((n, e) => n + e.amount * (e.frequency === 'monthly' ? months.length : 1), 0));
    return { structureId: st._id, name: st.name, admissionFee, monthlyFee: st.monthlyFee || 0, months: months.length, tuition, extras, total: money(admissionFee + tuition + extras) };
  });
  const sum = (k) => money(structures.reduce((n, x) => n + x[k], 0));
  return { structures, months: months.length, totals: { admission: sum('admissionFee'), tuition: sum('tuition'), extras: sum('extras'), total: sum('total') } };
}

/** A personal discount given at admission applies to tuition only (the way scholarships are already recorded). Refuse anything that does not make sense. */
export function assertDiscountFits(discount, preview) {
  if (!preview.structures.length) throw bad('This class has no fee structure yet, so a discount cannot be given. Ask Finance to set one up first.');
  if (!preview.totals.tuition) throw bad('There is no tuition fee for this class to take a discount from.');
  if (discount.type === 'percent' && (discount.value <= 0 || discount.value > 100)) throw bad('A percentage discount must be between 0 and 100');
  if (discount.type === 'amount' && discount.value > preview.totals.tuition) throw bad(`The discount cannot be more than the tuition fee of ${preview.totals.tuition}`);
}

/** Called after admission / promotion so every new enrolment is billed without anyone having to remember. `discount` (admission only) is a personal discount on tuition. */
export async function autoAssignForEnrolment(tenantId, enrolment, actorId, discount = null) {
  const ctx = { tenantId, actorId };
  const structures = await autoStructures(tenantId, enrolment);
  let n = 0; let applied = 0; let remaining = discount?.type === 'amount' ? discount.value : 0;
  for (const st of structures) {
    // a fixed amount is spread over the structures one after another so it is never given twice
    const spec = discount ? (discount.type === 'percent' ? { ...discount, kind: 'personal' } : remaining > 0 ? { type: 'amount', value: remaining, reason: discount.reason, kind: 'personal' } : null) : null;
    if (await billStudent(ctx, st, enrolment.studentId, enrolment, spec)) n++;
    if (spec) { applied = money(applied + (spec.applied || 0)); if (discount.type === 'amount') remaining = money(remaining - (spec.applied || 0)); }
  }
  return discount ? { billed: n, discountApplied: applied } : n;
}

export async function createCharge(ctx, body, extra = {}) {
  if (!(await Student.exists({ _id: body.studentId, tenantId: ctx.tenantId }))) throw notFound('Student not found');
  return StudentCharge.create({ tenantId: ctx.tenantId, studentId: body.studentId, yearId: ctx.year?._id, kind: 'other', label: body.label, amount: body.amount, dueDate: body.dueDate, createdBy: ctx.actorId, ...extra });
}

/** Reduce what a student owes (scholarship, sibling discount…). Needs a reason and is kept on the charge. */
export async function addConcession(ctx, chargeId, { amount, reason }, byName) {
  const c = await StudentCharge.findOne({ _id: chargeId, tenantId: ctx.tenantId });
  if (!c) throw notFound('Charge not found');
  if (amount > outstanding(c)) throw conflict(`Concession cannot exceed the outstanding ${outstanding(c)}`);
  c.concession = money((c.concession || 0) + amount);
  c.concessions.push({ amount, reason, by: ctx.actorId, byName, at: new Date() });
  if (outstanding(c) <= 0) c.status = 'paid';
  return c.save();
}

/**
 * A standing personal discount on tuition. It is applied to every tuition charge that has nothing paid on it yet, and to every month billed from now on.
 * Charges that already have a payment are left alone, so receipts never disagree with what is owed.
 */
export async function setPersonalDiscount(ctx, studentId, { type, value, reason }, byName) {
  const s = await Student.findOne({ _id: studentId, tenantId: ctx.tenantId });
  if (!s) throw notFound('Student not found');
  if (type === 'percent' && value > 100) throw bad('A percentage discount must be between 0 and 100');
  s.personalDiscount = { type, value, reason, setByName: byName, setAt: new Date() };
  await s.save();
  return reapplyPersonalDiscount(ctx, s, byName);
}
export async function clearPersonalDiscount(ctx, studentId, byName) {
  const s = await Student.findOne({ _id: studentId, tenantId: ctx.tenantId });
  if (!s) throw notFound('Student not found');
  s.personalDiscount = undefined; await s.save();
  return reapplyPersonalDiscount(ctx, s, byName);
}
async function reapplyPersonalDiscount(ctx, student, byName) {
  const pd = student.personalDiscount?.type ? student.personalDiscount : null;
  const charges = await StudentCharge.find({ tenantId: ctx.tenantId, studentId: student._id, category: 'Tuition', status: 'open', paidAmount: { $lte: 0 } });
  let changed = 0;
  for (const c of charges) {
    const old = money((c.concessions || []).filter((x) => x.kind === 'personal').reduce((n, x) => n + (x.amount || 0), 0));
    const next = !pd ? 0 : pd.type === 'percent' ? money((c.amount * Math.min(pd.value, 100)) / 100) : Math.min(money(pd.value), c.amount);
    if (old === next) continue;
    c.concessions = (c.concessions || []).filter((x) => x.kind !== 'personal');
    c.concession = money((c.concession || 0) - old + next);
    if (next) c.concessions.push({ amount: next, reason: pd.reason, kind: 'personal', by: ctx.actorId, byName, at: new Date() });
    c.concessionNote = pd?.reason || c.concessionNote;
    await c.save(); changed += 1;
  }
  return { personalDiscount: pd ? { type: pd.type, value: pd.value, reason: pd.reason } : null, chargesUpdated: changed };
}

// ───────────── transport fees (billed monthly to students who ride a bus) ─────────────
/** Bill the monthly transport fare from this month to the end of the academic year. Months already billed are skipped. */
export async function billTransport(ctx, studentId, { fare, busNo, stop }) {
  if (!ctx.year || !(fare > 0)) return 0;
  const policy = policyOf(ctx.settings);
  const months = billingMonths(ctx.year, ctx.today);
  const have = new Set((await StudentCharge.find({ tenantId: ctx.tenantId, studentId, category: 'Transport', yearId: ctx.year._id }).select('period').lean()).map((c) => c.period));
  const docs = months.filter((m) => !have.has(m)).map((m) => ({
    tenantId: ctx.tenantId, studentId, yearId: ctx.year._id, kind: 'fee', category: 'Transport', period: m, label: `Transport fee — ${monthName(m)} (bus ${busNo}${stop ? `, ${stop}` : ''})`,
    amount: fare, dueDate: dueOn(m, policy.dueDay), createdBy: ctx.actorId,
  }));
  if (docs.length) await StudentCharge.insertMany(docs);
  return docs.length;
}

/** When a student stops using the bus, future unpaid transport months disappear; paid and current-month charges stay. */
export async function cancelTransportCharges(ctx, studentId) {
  const thisMonth = ctx.today.slice(0, 7);
  const r = await StudentCharge.deleteMany({ tenantId: ctx.tenantId, studentId, category: 'Transport', status: 'open', paidAmount: 0, concession: 0, period: { $gt: thisMonth } });
  return r.deletedCount;
}

// ───────────── the school's fee policy ─────────────
export async function getPolicy(ctx) {
  const p = policyOf(ctx.settings);
  return { dueDay: p.dueDay, advanceDiscount: p.advanceDiscount };
}
export async function updatePolicy(ctx, body) {
  const school = await School.findById(ctx.tenantId);
  const settings = settingsOf(school);
  school.settings = { ...(school.settings || {}), finance: { ...(settings.finance || {}), dueDay: body.dueDay, advanceDiscount: body.advanceDiscount } };
  school.markModified('settings');
  await school.save();
  return { dueDay: body.dueDay, advanceDiscount: body.advanceDiscount };
}

// ───────────── paying the whole year in advance ─────────────
const describeOffer = (d) => (d.type === 'months' ? `${d.value} month${d.value === 1 ? '' : 's'} of tuition free` : `${d.value}% off tuition`);

/**
 * What it would take to clear every remaining month now, and what the school's policy gives back for it.
 * Eligible only when the policy is on, enough tuition months are still open, and none of them has already had a concession.
 */
export async function advancePlan(ctx, studentId) {
  const policy = policyOf(ctx.settings).advanceDiscount;
  const open = (await StudentCharge.find({ tenantId: ctx.tenantId, studentId, status: 'open', period: { $exists: true, $ne: null } }).lean())
    .sort((a, b) => String(a.period).localeCompare(String(b.period)));
  const tuition = open.filter((c) => c.category === 'Tuition'); const others = open.filter((c) => c.category !== 'Tuition');
  const base = { policy, offer: describeOffer(policy), months: tuition.length, tuition: sumOf(tuition, outstanding), other: sumOf(others, outstanding) };
  let reason = null;
  if (!open.length) reason = 'There are no monthly fees left to pay';
  else if (!policy.enabled) reason = 'This school does not offer an advance-payment discount';
  else if (tuition.length < policy.minMonths) reason = `The discount needs at least ${policy.minMonths} month(s) of tuition to be paid at once; ${tuition.length} are open`;
  else if (tuition.some((c) => c.concession > 0 || c.paidAmount > 0)) reason = 'Some of the open months are already part-paid or have a concession, so the discount cannot be applied';
  const waived = [];
  if (!reason) {
    if (policy.type === 'months') for (const c of tuition.slice(-policy.value)) waived.push({ chargeId: c._id, label: c.label, amount: outstanding(c) });
    else for (const c of tuition) waived.push({ chargeId: c._id, label: c.label, amount: money((outstanding(c) * policy.value) / 100) });
  }
  const discount = sumOf(waived, (w) => w.amount);
  const payable = money(sumOf(open, outstanding) - discount);
  return { ...base, eligible: !reason, reason, discount, waived, payable, chargeIds: open.map((c) => String(c._id)), charges: open.map((c) => ({ id: c._id, label: c.label, category: c.category, outstanding: outstanding(c), dueDate: c.dueDate })) };
}

export async function payAdvance(ctx, studentId, body, byName) {
  const plan = await advancePlan(ctx, studentId);
  if (!plan.eligible) throw conflict(plan.reason);
  const applied = [];
  try {
    for (const w of plan.waived) {
      if (w.amount <= 0) continue;
      await addConcession(ctx, w.chargeId, { amount: w.amount, reason: `Advance payment — ${plan.offer}` }, byName);
      applied.push(w);
    }
    const payChargeIds = plan.chargeIds.filter((id) => !plan.waived.some((w) => String(w.chargeId) === id && w.amount >= (plan.charges.find((c) => String(c.id) === id)?.outstanding || 0)));
    return await collectPayment(ctx, { studentId, amount: plan.payable, mode: body.mode, reference: body.reference, paidOn: body.paidOn, note: body.note || `Advance payment for the year (${plan.offer})`, chargeIds: payChargeIds }, byName);
  } catch (e) {
    // the concessions were only meant to go with this payment: take them back if it did not happen
    for (const w of applied) {
      const c = await StudentCharge.findById(w.chargeId);
      if (c) { c.concession = money(c.concession - w.amount); c.concessions.pop(); c.status = 'open'; await c.save(); }
    }
    throw e;
  }
}

// ───────────── payments ─────────────
async function nextReceiptNo(ctx, paidOn) {
  const school = await loadSchool(ctx.tenantId);
  const fmt = settingsOf(school).finance?.receiptFormat || 'RCPT{YYYY}{SEQ:5}';
  const yyyy = paidOn.slice(0, 4);
  const seq = await nextSeq(ctx.tenantId, `receipt:${fmt}:${yyyy}`);
  return fmt.replace('{YYYY}', yyyy).replace('{YY}', yyyy.slice(2)).replace(/\{SEQ:(\d)\}/, (_, n) => String(seq).padStart(Number(n), '0'));
}

export async function collectPayment(ctx, body, byName) {
  const student = await Student.findOne({ _id: body.studentId, tenantId: ctx.tenantId });
  if (!student) throw notFound('Student not found');
  const paidOn = body.paidOn || ctx.today;
  if (paidOn > ctx.today) throw bad('A payment cannot be dated in the future');
  const f = { tenantId: ctx.tenantId, studentId: student._id, status: 'open' };
  if (body.chargeIds?.length) f._id = { $in: body.chargeIds };
  const open = (await StudentCharge.find(f).lean()).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || String(a._id).localeCompare(String(b._id)));
  const due = sumOf(open, outstanding);
  if (!open.length) throw conflict('This student has nothing outstanding');
  if (body.amount > due + 0.001) throw bad(`Amount exceeds the outstanding balance of ${due}. Advance payments are not supported.`);
  // allocate oldest-first
  let left = money(body.amount); const allocations = [];
  for (const c of open) { if (left <= 0) break; const take = Math.min(left, outstanding(c)); if (take > 0) { allocations.push({ chargeId: c._id, label: c.label, amount: money(take) }); left = money(left - take); } }
  // apply atomically per charge so two simultaneous receipts cannot overpay the same charge
  const applied = [];
  try {
    for (const a of allocations) {
      const r = await StudentCharge.updateOne({ _id: a.chargeId, $expr: { $lte: [{ $add: ['$paidAmount', a.amount] }, { $subtract: ['$amount', '$concession'] }] } }, { $inc: { paidAmount: a.amount } });
      if (!r.modifiedCount) throw conflict('The balance changed while saving. Refresh and try again.');
      applied.push(a);
    }
    const payment = await Payment.create({
      tenantId: ctx.tenantId, studentId: student._id, kind: 'payment', amount: body.amount, mode: body.mode, reference: body.reference, receiptNo: await nextReceiptNo(ctx, paidOn), paidOn,
      allocations, receivedBy: ctx.actorId, receivedByName: byName, note: body.note,
    });
    await StudentCharge.updateMany({ _id: { $in: allocations.map((a) => a.chargeId) }, $expr: { $gte: ['$paidAmount', { $subtract: ['$amount', '$concession'] }] } }, { status: 'paid' });
    await notifyUsers(ctx.tenantId, [student.userId], { category: 'fees', title: 'Payment received', body: `₹${body.amount} received. Receipt ${payment.receiptNo}.`, link: { type: 'fees', id: String(payment._id) }, dedupeKey: `pay:${payment._id}` });
    return payment;
  } catch (e) {
    for (const a of applied) await StudentCharge.updateOne({ _id: a.chargeId }, { $inc: { paidAmount: -a.amount } });
    throw e;
  }
}

/**
 * Collect a payment, optionally with a discount given at the counter. The discount is a concession on the dues being paid (oldest first), kept
 * on each charge with its reason, exactly like a concession added from the student's account. If the payment then fails, the discount is taken back.
 * When the discount clears everything that is due, there is nothing to pay and no receipt is made.
 */
export async function collectWithDiscount(ctx, body, byName) {
  const { discount, ...pay } = body;
  if (!discount) return collectPayment(ctx, pay, byName);
  const f = { tenantId: ctx.tenantId, studentId: pay.studentId, status: 'open' };
  if (pay.chargeIds?.length) f._id = { $in: pay.chargeIds };
  const open = (await StudentCharge.find(f).lean()).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || String(a._id).localeCompare(String(b._id)));
  const total = sumOf(open, outstanding);
  if (!open.length) throw conflict('This student has nothing outstanding');
  const off = discount.type === 'percent' ? money(total * discount.value / 100) : money(discount.value);
  if (off <= 0 || off > total + 0.001) throw bad(`The discount must be more than 0 and at most ${total}, which is what is due`);
  const remaining = money(total - off);
  if (remaining > 0 && (pay.amount == null || pay.amount > remaining + 0.001)) throw bad(`After the discount of ${off}, ${remaining} is due`);
  const applied = [];
  try {
    let left = off;
    for (const c of open) {
      if (left <= 0) break;
      const take = Math.min(left, outstanding(c));
      await addConcession(ctx, c._id, { amount: take, reason: `Discount at the counter — ${discount.reason}` }, byName);
      applied.push({ id: c._id, amount: take }); left = money(left - take);
    }
    if (remaining <= 0) return { discountOnly: true, discount: off, remaining: 0 };
    return await collectPayment(ctx, { ...pay, chargeIds: pay.chargeIds?.length ? pay.chargeIds : undefined, note: pay.note || `Paid after a discount of ${off}` }, byName);
  } catch (e) {
    for (const w of applied) {
      const c = await StudentCharge.findById(w.id);
      if (c) { c.concession = money(c.concession - w.amount); c.concessions.pop(); c.status = 'open'; await c.save(); }
    }
    throw e;
  }
}

/** Never delete or edit a receipt: reverse it. The original is flagged and a reversal entry is added. */
export async function reversePayment(ctx, paymentId, reason, byName) {
  const p = await Payment.findOne({ _id: paymentId, tenantId: ctx.tenantId });
  if (!p) throw notFound('Payment not found');
  if (p.kind !== 'payment') throw conflict('Only a payment can be reversed');
  if (p.status === 'reversed') throw conflict('This payment has already been reversed');
  const claimed = await Payment.updateOne({ _id: p._id, status: 'completed' }, { status: 'reversed', reversedBy: ctx.actorId, reversedAt: new Date(), reversalReason: reason });
  if (!claimed.modifiedCount) throw conflict('This payment has already been reversed');
  for (const a of p.allocations) await StudentCharge.updateOne({ _id: a.chargeId }, { $inc: { paidAmount: -a.amount }, status: 'open' });
  const rev = await Payment.create({
    tenantId: ctx.tenantId, studentId: p.studentId, kind: 'reversal', amount: p.amount, mode: p.mode, reference: p.reference, receiptNo: await nextReceiptNo(ctx, ctx.today), paidOn: ctx.today,
    allocations: p.allocations, receivedBy: ctx.actorId, receivedByName: byName, note: `Reversal of ${p.receiptNo}`, reversalOf: p._id, reversalReason: reason, status: 'completed',
  });
  const stu = await Student.findById(p.studentId).select('userId');
  await notifyUsers(ctx.tenantId, [stu?.userId], { category: 'fees', title: 'Payment reversed', body: `Receipt ${p.receiptNo} was reversed: ${reason}`, link: { type: 'fees', id: String(rev._id) }, dedupeKey: `rev:${rev._id}` });
  return { reversal: rev, original: p };
}

// ───────────── accounts, dues, reports ─────────────
export async function studentAccount(tenantId, studentId, today) {
  const [charges, payments] = await Promise.all([
    StudentCharge.find({ tenantId, studentId }).sort({ dueDate: 1, createdAt: 1 }).lean(),
    Payment.find({ tenantId, studentId }).sort({ createdAt: -1 }).lean(),
  ]);
  const view = charges.map((c) => ({ ...c, net: money(c.amount - (c.concession || 0)), outstanding: outstanding(c), overdue: c.status === 'open' && !!c.dueDate && c.dueDate < today && outstanding(c) > 0 }));
  const open = view.filter((c) => c.status === 'open');
  const pdoc = (await Student.findOne({ _id: studentId, tenantId }).select('personalDiscount').lean())?.personalDiscount;
  return {
    personalDiscount: pdoc?.type ? { type: pdoc.type, value: pdoc.value, reason: pdoc.reason, setByName: pdoc.setByName } : null,
    charges: view, payments,
    totals: {
      assigned: sumOf(charges, (c) => c.amount), concession: sumOf(charges, (c) => c.concession || 0), paid: sumOf(charges, (c) => c.paidAmount || 0),
      pending: sumOf(open, outstanding), overdue: sumOf(view.filter((c) => c.overdue), (c) => c.outstanding), nextDue: open.map((c) => c.dueDate).filter(Boolean).sort()[0] || null,
    },
  };
}

/**
 * Every billed student's money position, computed by the database. Carries ids and class/section names but no personal details,
 * so school-wide totals (dashboard, class report, reminders) do not have to download thousands of student records.
 */
async function duesRows(ctx, q) {
  const enrFilter = { tenantId: ctx.tenantId, yearId: ctx.year?._id, status: rollStatus(ctx.year) };
  if (q.sectionId) enrFilter.sectionId = q.sectionId;
  if (q.classId) enrFilter.classId = q.classId;
  const enrolments = await StudentEnrolment.find(enrFilter).select('studentId classId sectionId rollNo').lean();
  const sf = { tenantId: ctx.tenantId, _id: { $in: enrolments.map((e) => e.studentId) }, status: 'active' };
  if (q.q) { const rx = new RegExp(escapeRegex(q.q), 'i'); sf.$or = [{ name: rx }, { admissionNo: rx }, { 'guardians.name': rx }]; }
  const ids = (await Student.find(sf).select('_id').lean()).map((s) => s._id);
  const [agg, secs, classes] = await Promise.all([
    StudentCharge.aggregate([{ $match: { tenantId: ctx.tenantId, studentId: { $in: ids } } }, { $group: {
      _id: '$studentId', assigned: { $sum: '$amount' }, concession: { $sum: '$concession' }, paid: { $sum: '$paidAmount' },
      overdue: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'open'] }, { $lt: ['$dueDate', ctx.today] }] }, { $subtract: [{ $subtract: ['$amount', '$concession'] }, '$paidAmount'] }, 0] } },
      nextDue: { $min: { $cond: [{ $eq: ['$status', 'open'] }, '$dueDate', null] } },
      oldestOverdue: { $min: { $cond: [{ $and: [{ $eq: ['$status', 'open'] }, { $lt: ['$dueDate', ctx.today] }, { $gt: [{ $subtract: [{ $subtract: ['$amount', '$concession'] }, '$paidAmount'] }, 0] }] }, '$dueDate', null] } },
    } }]),
    Section.find({ tenantId: ctx.tenantId, yearId: ctx.year?._id }).select('name').lean(), ClassModel.find({ tenantId: ctx.tenantId }).select('name').lean(),
  ]);
  const B = new Map(agg.map((a) => [String(a._id), a]));
  const S = mk(secs); const C = mk(classes); const E = new Map(enrolments.map((e) => [String(e.studentId), e]));
  return ids.map((id) => {
    const b = B.get(String(id)); const e = E.get(String(id));
    return { studentId: id, classId: e?.classId, sectionId: e?.sectionId, className: C.get(String(e?.classId))?.name, section: S.get(String(e?.sectionId))?.name, rollNo: e?.rollNo, assigned: money(b?.assigned || 0), concession: money(b?.concession || 0), paid: money(b?.paid || 0),
      pending: b ? money(b.assigned - b.concession - b.paid) : 0, overdue: money(b?.overdue || 0), nextDue: b?.nextDue || null, daysOverdue: b?.oldestOverdue ? daysBetween(b.oldestOverdue, ctx.today) : 0, billed: !!b };
  });
}

const filterDues = (rows, status) => (status === 'overdue' ? rows.filter((r) => r.overdue > 0) : status === 'pending' ? rows.filter((r) => r.pending > 0) : status === 'clear' ? rows.filter((r) => r.billed && r.pending <= 0) : rows);
const sumDues = (rows) => ({ pending: sumOf(rows, (r) => r.pending), overdue: sumOf(rows, (r) => r.overdue), billed: sumOf(rows, (r) => r.assigned), collected: sumOf(rows, (r) => r.paid) });

export async function listDues(ctx, q) {
  const rows = filterDues(await duesRows(ctx, q), q.status).sort((a, b) => b.overdue - a.overdue || b.pending - a.pending || String(a.studentId).localeCompare(String(b.studentId)));
  const page = rows.slice((q.page - 1) * q.limit, q.page * q.limit);
  // names and guardians only for the rows being shown
  const students = mk(await Student.find({ tenantId: ctx.tenantId, _id: { $in: page.map((r) => r.studentId) } }).select('name admissionNo guardians').lean());
  const items = page.map((r) => { const s = students.get(String(r.studentId)); return { ...r, name: s?.name, admissionNo: s?.admissionNo, guardian: s?.guardians?.[0]?.name, guardianPhone: s?.guardians?.[0]?.phone }; });
  items.sort((a, b) => b.overdue - a.overdue || b.pending - a.pending || String(a.name).localeCompare(String(b.name)));
  return { total: rows.length, items, totals: sumDues(rows) };
}

const signed = { $cond: [{ $eq: ['$kind', 'reversal'] }, { $multiply: ['$amount', -1] }, '$amount'] };

export async function listPayments(ctx, q) {
  const f = { tenantId: ctx.tenantId };
  if (q.from || q.to) f.paidOn = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.mode) f.mode = q.mode;
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    const ids = (await Student.find({ tenantId: ctx.tenantId, $or: [{ name: rx }, { admissionNo: rx }] }).select('_id').lean()).map((s) => s._id);
    f.$or = [{ receiptNo: rx }, { reference: rx }, { studentId: { $in: ids } }];
  }
  const rows = await Payment.find(f).sort({ paidOn: -1, createdAt: -1 }).limit(q.limit).lean();
  const stu = mk(await Student.find({ tenantId: ctx.tenantId, _id: { $in: rows.map((r) => r.studentId) } }).select('name admissionNo').lean());
  return rows.map((r) => ({ ...r, student: stu.get(String(r.studentId))?.name, admissionNo: stu.get(String(r.studentId))?.admissionNo }));
}

export async function collectionReport(ctx, { from, to }) {
  const f = { tenantId: ctx.tenantId, paidOn: { $gte: from || addDays(ctx.today, -29), $lte: to || ctx.today } };
  const [byDay, byMode] = await Promise.all([
    Payment.aggregate([{ $match: f }, { $group: { _id: '$paidOn', amount: { $sum: signed }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Payment.aggregate([{ $match: f }, { $group: { _id: '$mode', amount: { $sum: signed }, count: { $sum: 1 } } }, { $sort: { amount: -1 } }]),
  ]);
  return { from: f.paidOn.$gte, to: f.paidOn.$lte, byDay: byDay.map((d) => ({ date: d._id, amount: money(d.amount), count: d.count })), byMode: byMode.map((m) => ({ mode: m._id, amount: money(m.amount), count: m.count })), total: sumOf(byDay, (d) => d.amount) };
}

export async function outstandingByClass(ctx) {
  const dues = { items: await duesRows(ctx, {}) };
  const by = new Map();
  for (const r of dues.items) { const k = r.className || '—'; const x = by.get(k) || { className: k, students: 0, billed: 0, collected: 0, pending: 0, overdue: 0 }; x.students++; x.billed += r.assigned; x.collected += r.paid; x.pending += r.pending; x.overdue += r.overdue; by.set(k, x); }
  return [...by.values()].map((x) => ({ ...x, billed: money(x.billed), collected: money(x.collected), pending: money(x.pending), overdue: money(x.overdue) })).sort((a, b) => a.className.localeCompare(b.className, undefined, { numeric: true }));
}

/**
 * Defaulters class by class: for every class (and the sections inside it) how many billed students are overdue and for how much.
 * Classes with no defaulters are included with 0. The students themselves come from listDues (status=overdue, classId, sectionId), page by page.
 */
export async function defaultersByClass(ctx, { classId, sectionId } = {}) {
  if (sectionId && !classId) { const sec = await Section.findOne({ _id: sectionId, tenantId: ctx.tenantId }).select('classId').lean(); if (!sec) throw notFound('Section not found'); classId = sec.classId; }
  const [rows, classes, sections] = await Promise.all([
    duesRows(ctx, { classId, sectionId }),
    ClassModel.find({ tenantId: ctx.tenantId, status: 'active', ...(classId ? { _id: classId } : {}) }).sort({ level: 1 }).select('name level').lean(),
    Section.find({ tenantId: ctx.tenantId, yearId: ctx.year?._id, status: 'active', ...(classId ? { classId } : {}), ...(sectionId ? { _id: sectionId } : {}) }).sort({ name: 1 }).select('name classId').lean(),
  ]);
  const tally = (list) => {
    const billed = list.filter((r) => r.billed); const bad = list.filter((r) => r.overdue > 0);
    return { studentsBilled: billed.length, defaulters: bad.length, overdueAmount: sumOf(bad, (r) => r.overdue), percentDefaulting: billed.length ? Math.round((bad.length / billed.length) * 1000) / 10 : 0 };
  };
  const items = classes.map((c) => {
    const mine = rows.filter((r) => String(r.classId) === String(c._id));
    return {
      classId: c._id, className: c.name, level: c.level, ...tally(mine),
      sections: sections.filter((x) => String(x.classId) === String(c._id)).map((x) => ({ sectionId: x._id, name: x.name, ...tally(mine.filter((r) => String(r.sectionId) === String(x._id))) })),
    };
  });
  return { items, totals: { classes: items.length, ...tally(rows) } };
}

export async function exportDefaultersByClass(ctx) {
  const d = await defaultersByClass(ctx);
  const flat = d.items.flatMap((c) => [{ className: c.className, section: 'All', ...c }, ...c.sections.map((x) => ({ className: c.className, section: x.name, ...x }))]);
  return toCsv(flat, [{ label: 'Class', get: (r) => r.className }, { label: 'Section', get: (r) => r.section }, { label: 'Students billed', get: (r) => r.studentsBilled }, { label: 'Defaulters', get: (r) => r.defaulters }, { label: '% defaulting', get: (r) => r.percentDefaulting }, { label: 'Overdue amount', get: (r) => r.overdueAmount }]);
}

export async function dashboard(ctx) {
  const month = ctx.today.slice(0, 7);
  const [today, monthAgg, dues, trend, recent, mode] = await Promise.all([
    Payment.aggregate([{ $match: { tenantId: ctx.tenantId, paidOn: ctx.today } }, { $group: { _id: null, amount: { $sum: signed }, count: { $sum: 1 } } }]),
    Payment.aggregate([{ $match: { tenantId: ctx.tenantId, paidOn: { $gte: `${month}-01`, $lte: `${month}-31` } } }, { $group: { _id: null, amount: { $sum: signed } } }]),
    duesRows(ctx, {}),
    collectionReport(ctx, { from: addDays(ctx.today, -13), to: ctx.today }),
    listPayments(ctx, { limit: 8 }), Payment.aggregate([{ $match: { tenantId: ctx.tenantId, paidOn: { $gte: `${month}-01`, $lte: `${month}-31` } } }, { $group: { _id: '$mode', amount: { $sum: signed } } }]),
  ]);
  const dayMap = new Map(trend.byDay.map((d) => [d.date, d.amount]));
  return {
    today: ctx.today, collectedToday: money(today[0]?.amount || 0), receiptsToday: today[0]?.count || 0, collectedMonth: money(monthAgg[0]?.amount || 0),
    ...sumDues(dues),
    defaulters: dues.filter((r) => r.overdue > 0).length, studentsBilled: dues.filter((r) => r.billed).length, studentsUnbilled: dues.filter((r) => !r.billed).length,
    trend: eachDate(addDays(ctx.today, -13), ctx.today).map((date) => ({ date, amount: dayMap.get(date) || 0 })), modes: mode.map((m) => ({ mode: m._id, amount: money(m.amount) })).filter((m) => m.amount),
    recent,
  };
}

export async function sendReminders(ctx, { studentIds, onlyOverdue }) {
  const rows = filterDues(await duesRows(ctx, {}), onlyOverdue ? 'overdue' : 'pending');
  const targets = rows.filter((r) => !studentIds?.length || studentIds.includes(String(r.studentId)));
  const stu = mk(await Student.find({ tenantId: ctx.tenantId, _id: { $in: targets.map((t) => t.studentId) } }).select('userId').lean());
  let sent = 0;
  for (const t of targets) {
    sent += await notifyUsers(ctx.tenantId, [stu.get(String(t.studentId))?.userId], {
      category: 'fees', title: 'Fee reminder', body: t.overdue > 0 ? `₹${t.overdue} is overdue (total pending ₹${t.pending}).` : `₹${t.pending} is pending${t.nextDue ? `, next due ${t.nextDue}` : ''}.`,
      link: { type: 'fees' }, dedupeKey: `feerem:${ctx.today}:${t.studentId}`,
    });
  }
  return { sent, matched: targets.length };
}

export async function exportPayments(ctx, q) {
  const rows = await listPayments(ctx, { ...q, limit: 1000000 }); // an export is the whole ledger for the range, not a page
  return toCsv(rows, [{ label: 'Receipt', get: (r) => r.receiptNo }, { label: 'Date', get: (r) => r.paidOn }, { label: 'Type', get: (r) => r.kind }, { label: 'Admission No', get: (r) => r.admissionNo }, { label: 'Student', get: (r) => r.student }, { label: 'Amount', get: (r) => (r.kind === 'reversal' ? -r.amount : r.amount) }, { label: 'Mode', get: (r) => r.mode }, { label: 'Reference', get: (r) => r.reference }, { label: 'Received by', get: (r) => r.receivedByName }, { label: 'Status', get: (r) => r.status }]);
}
export async function exportDues(ctx, q) {
  const d = await listDues(ctx, { ...q, page: 1, limit: 100000 });
  return toCsv(d.items, [{ label: 'Admission No', get: (r) => r.admissionNo }, { label: 'Student', get: (r) => r.name }, { label: 'Class', get: (r) => r.className }, { label: 'Section', get: (r) => r.section }, { label: 'Guardian', get: (r) => r.guardian }, { label: 'Phone', get: (r) => r.guardianPhone }, { label: 'Billed', get: (r) => r.assigned }, { label: 'Paid', get: (r) => r.paid }, { label: 'Pending', get: (r) => r.pending }, { label: 'Overdue', get: (r) => r.overdue }, { label: 'Days overdue', get: (r) => r.daysOverdue }, { label: 'Next due', get: (r) => r.nextDue }]);
}

// ───────────── receipts ─────────────
export async function renderReceipt(tenantId, payment, res) {
  const [school, student] = await Promise.all([School.findById(tenantId), Student.findById(payment.studentId)]);
  const enr = await StudentEnrolment.findOne({ tenantId, studentId: payment.studentId, status: 'active' }).sort({ createdAt: -1 });
  const [sec, cls] = enr ? await Promise.all([Section.findById(enr.sectionId), ClassModel.findById(enr.classId)]) : [];
  const doc = new PDFDocument({ size: 'A5', margin: 40 });
  doc.pipe(res);
  doc.fontSize(16).text(school?.name || 'School', { align: 'center' });
  doc.fontSize(12).text(payment.kind === 'reversal' ? 'PAYMENT REVERSAL' : 'FEE RECEIPT', { align: 'center' }).moveDown();
  doc.fontSize(10).text(`Receipt no: ${payment.receiptNo}`).text(`Date: ${payment.paidOn}`).text(`Student: ${student?.name} (${student?.admissionNo})`).text(`Class: ${cls?.name || '-'} ${sec?.name || ''}`).moveDown();
  doc.font('Helvetica-Bold').text('Particulars', 40, doc.y, { continued: true }).text('Amount', { align: 'right' }).font('Helvetica');
  for (const a of payment.allocations) doc.text(a.label, 40, doc.y, { continued: true }).text(`${a.amount.toFixed(2)}`, { align: 'right' });
  doc.moveDown().font('Helvetica-Bold').text(`${payment.kind === 'reversal' ? 'Reversed' : 'Total received'}: ${payment.amount.toFixed(2)}`, { align: 'right' }).font('Helvetica');
  doc.text(`Mode: ${payment.mode.replace('_', ' ')}${payment.reference ? ` · Ref ${payment.reference}` : ''}`);
  if (payment.status === 'reversed') doc.fillColor('red').text(`This receipt was reversed: ${payment.reversalReason}`).fillColor('black');
  if (payment.kind === 'reversal') doc.text(`Reason: ${payment.reversalReason}`);
  doc.moveDown().fontSize(9).fillColor('#555').text(`Received by ${payment.receivedByName || '-'}. This is a computer generated receipt.`);
  doc.end();
}

/** Small read for the School Admin dashboard (view-only). */
export async function financeSummary(ctx) {
  const month = ctx.today.slice(0, 7);
  const [open, paidMonth] = await Promise.all([
    StudentCharge.aggregate([{ $match: { tenantId: ctx.tenantId, status: 'open' } }, { $group: { _id: null, pending: { $sum: { $subtract: [{ $subtract: ['$amount', '$concession'] }, '$paidAmount'] } }, overdue: { $sum: { $cond: [{ $lt: ['$dueDate', ctx.today] }, { $subtract: [{ $subtract: ['$amount', '$concession'] }, '$paidAmount'] }, 0] } } } }]),
    Payment.aggregate([{ $match: { tenantId: ctx.tenantId, paidOn: { $gte: `${month}-01`, $lte: `${month}-31` } } }, { $group: { _id: null, n: { $sum: signed } } }]),
  ]);
  return { pending: money(open[0]?.pending || 0), overdue: money(open[0]?.overdue || 0), collectedMonth: money(paidMonth[0]?.n || 0) };
}
