import { Expense, Budget, User, Vendor, File } from '../../models/index.js';
import { notFound, conflict, bad, round2, escapeRegex, toCsv } from '../../core/utils.js';
import { removeFileBytes } from '../../services/files.js';
import { notifyUsers } from '../../services/notify.js';
import { nextSeq } from '../../services/context.js';
import PDFDocument from 'pdfkit';
import { loadLook } from '../../services/documents/look.js';
import { drawVoucher } from '../../services/documents/voucher.js';

const money = round2;

export async function listExpenses(ctx, q) {
  const f = { tenantId: ctx.tenantId };
  if (q.status && q.status !== 'all') f.status = q.status;
  if (q.department) f.department = q.department;
  if (q.from || q.to) f.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.yearId) f.yearId = q.yearId;
  if (q.nature) f.nature = q.nature === 'revenue' ? { $in: ['revenue', null] } : q.nature;
  if (q.vendorId) f.vendorId = q.vendorId;
  if (q.payment === 'paid') f.paymentStatus = 'paid';
  else if (q.payment === 'unpaid') { f.status = 'approved'; f.paymentStatus = { $ne: 'paid' }; } // still owing, in whole or in part
  const [rows, total, tot, deps] = await Promise.all([
    Expense.find(f).sort({ date: -1, createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Expense.countDocuments(f),
    Expense.aggregate([{ $match: f }, { $group: { _id: '$status', amount: { $sum: '$amount' }, n: { $sum: 1 } } }]),
    Expense.distinct('department', { tenantId: ctx.tenantId }),
  ]);
  const by = Object.fromEntries(tot.map((t) => [t._id, { amount: money(t.amount), count: t.n }]));
  const toPay = await Expense.aggregate([{ $match: { tenantId: ctx.tenantId, status: 'approved', paymentStatus: { $ne: 'paid' } } }, { $group: { _id: null, amount: { $sum: { $subtract: ['$amount', { $ifNull: ['$paidAmount', 0] }] } }, n: { $sum: 1 } } }]);
  return { total, items: rows, totals: { approved: by.approved || { amount: 0, count: 0 }, pending: by.pending || { amount: 0, count: 0 }, rejected: by.rejected || { amount: 0, count: 0 }, toPay: { amount: money(toPay[0]?.amount || 0), count: toPay[0]?.n || 0 } }, departments: deps.sort() };
}

/** An expense can only name a vendor the School Admin has approved. The vendor's name is copied onto the expense so old records stay readable. */
async function withVendor(ctx, body) {
  if (body.vendorId === null) return { ...body, vendorId: undefined };
  if (!body.vendorId) return body;
  const v = await Vendor.findOne({ _id: body.vendorId, tenantId: ctx.tenantId }).lean();
  if (!v) throw notFound('Vendor not found');
  if (v.status !== 'approved') throw bad(`${v.name} is not an approved vendor yet. The School Admin approves new vendors from Approvals.`);
  return { ...body, vendor: v.name };
}

export async function createExpense(ctx, body, user) {
  return Expense.create({ ...(await withVendor(ctx, body)), tenantId: ctx.tenantId, yearId: ctx.year?._id, status: 'pending', submittedBy: user._id, submittedByName: user.name });
}

async function own(ctx, id) {
  const e = await Expense.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!e) throw notFound('Expense not found');
  return e;
}
export async function updateExpense(ctx, id, patch) {
  const e = await own(ctx, id);
  if (e.status === 'approved') throw conflict('An approved expense is locked. Ask the School Admin to reject it first if it is wrong.');
  patch = await withVendor(ctx, patch);
  Object.assign(e, patch, { status: 'pending', decidedBy: undefined, decidedByName: undefined, decidedAt: undefined, decisionNote: undefined }); // an edited expense goes back for approval
  return e.save();
}
export async function deleteExpense(ctx, id) {
  const e = await own(ctx, id);
  if (e.status === 'approved') throw conflict('An approved expense cannot be deleted');
  await dropFiles(e.attachments);
  await e.deleteOne();
}

/** The School Admin approves or rejects. A decision needs a note when rejecting. */
export async function decideExpense(ctx, id, { approve, note }, user) {
  const e = await own(ctx, id);
  if (e.status !== 'pending') throw conflict(`This expense is already ${e.status}`);
  if (!approve && !note) throw bad('Say why it is being rejected');
  e.status = approve ? 'approved' : 'rejected'; e.decidedBy = user._id; e.decidedByName = user.name; e.decidedAt = new Date(); e.decisionNote = note;
  await e.save();
  const fin = await User.find({ tenantId: ctx.tenantId, role: 'finance', status: 'active' }).select('_id').lean();
  await notifyUsers(ctx.tenantId, fin.map((u) => u._id), { category: 'system', title: `Expense ${e.status}`, body: `${e.title} (₹${e.amount}) was ${e.status}${note ? `: ${note}` : ''}.${e.status === 'approved' ? ' You can now record the payment.' : ''}`, link: { type: 'expense', id: String(e._id) }, dedupeKey: `exp:${e._id}:${e.status}` });
  return e;
}

async function dropFiles(list) {
  for (const a of list || []) { const f = await File.findById(a.fileId); if (f) { await removeFileBytes(f); await f.deleteOne(); } }
}
const MAX_ATTACHMENTS = 8;
/** A bill, quote or approval letter that travels with the expense to the approver. */
export async function addAttachment(ctx, id, file) {
  const e = await own(ctx, id);
  if (e.attachments.length >= MAX_ATTACHMENTS) { await removeFileBytes(file); await file.deleteOne(); throw conflict(`An expense can carry up to ${MAX_ATTACHMENTS} files`); }
  e.attachments.push({ fileId: file._id, name: file.originalName, mime: file.mime, size: file.size });
  return e.save();
}
export async function removeAttachment(ctx, id, fileId) {
  const e = await own(ctx, id);
  if (e.status === 'approved') throw conflict('An approved expense is locked, so its files stay with it');
  const a = e.attachments.find((x) => String(x.fileId) === String(fileId));
  if (!a) throw notFound('File not found on this expense');
  await dropFiles([a]);
  e.attachments = e.attachments.filter((x) => String(x.fileId) !== String(fileId));
  return e.save();
}

/** What has been paid on a bill. Bills paid before part payments existed carry their single payment in the older fields, so they read the same way. */
export const paymentsOf = (e) => (e.payments?.length ? e.payments : e.paymentStatus === 'paid' ? [{ amount: e.amount, paidOn: e.paidOn, mode: e.paymentMode, reference: e.paymentRef, note: e.paymentNote, byName: e.paidByName }] : []);
export const paidOf = (e) => round2(paymentsOf(e).reduce((n, p) => n + p.amount, 0));

async function nextVoucherNo(ctx, paidOn) {
  const yyyy = paidOn.slice(0, 4);
  return `PV${yyyy}${String(await nextSeq(ctx.tenantId, `voucher:${yyyy}`)).padStart(5, '0')}`;
}

/**
 * Money goes out only for an expense the School Admin has approved. Finance records how much was paid (the whole bill, or a part of it), how and when;
 * each payment gets its own payment voucher number and is never edited afterwards. Paying more than is owed is refused.
 */
export async function payExpense(ctx, id, { amount, mode, reference, paidOn, note }, user) {
  const e = await own(ctx, id);
  if (e.status !== 'approved') throw conflict(e.status === 'pending' ? 'This expense is waiting for the School Admin. It can be paid only after approval.' : 'A rejected expense cannot be paid');
  if (e.paymentStatus === 'paid') throw conflict('This expense is already paid');
  if (paidOn && paidOn > ctx.today) throw bad('A payment cannot be dated in the future');
  if (e.vendorId) { const v = await Vendor.findById(e.vendorId).select('status name').lean(); if (v && v.status !== 'approved') throw conflict(`${v.name} is no longer an approved vendor`); }
  const before = paidOf(e); const owed = money(e.amount - before);
  const pay = amount == null ? owed : money(amount);
  if (!(pay > 0)) throw bad('Enter an amount to pay');
  if (pay > owed + 0.001) throw bad(`Only ${owed} is still owed on this bill`);
  const date = paidOn || ctx.today;
  const entry = { amount: pay, paidOn: date, mode, reference: reference || undefined, note: note || undefined, byName: user.name, voucherNo: await nextVoucherNo(ctx, date), at: new Date() };
  const done = money(before + pay) >= money(e.amount);
  // one writer wins if two payments arrive together: the update only applies while the paid total is still what we read
  const fresh = await Expense.findOneAndUpdate(
    { _id: e._id, tenantId: ctx.tenantId, paymentStatus: { $ne: 'paid' }, $or: [{ paidAmount: before }, ...(before === 0 ? [{ paidAmount: { $exists: false } }] : [])] },
    { $push: { payments: entry }, $set: { paidAmount: money(before + pay), paymentStatus: done ? 'paid' : 'part', paidOn: date, paymentMode: mode, paymentRef: entry.reference, paymentNote: entry.note, paidByName: user.name, paidAt: entry.at } },
    { new: true },
  );
  if (!fresh) throw conflict('Another payment was recorded at the same moment. Reload and check what is still owed.');
  return fresh;
}

/** Expenses in the given states (waiting, approved, rejected), newest decision first: the approvals page's history. */
export async function expensesByStatus(ctx, statuses) {
  return Expense.find({ tenantId: ctx.tenantId, status: { $in: statuses } }).sort({ decidedAt: -1, date: -1 }).limit(200).lean();
}

export async function pendingApprovals(ctx) {
  return (await Expense.find({ tenantId: ctx.tenantId, status: 'pending' }).sort({ date: 1 }).lean());
}

// ───────────── budgets: revenue (running costs) and capital (assets) ─────────────
const KINDS = ['revenue', 'capital'];
export async function listBudgets(ctx, yearId) {
  const y = yearId || ctx.year?._id;
  const [budgets, spent] = await Promise.all([
    Budget.find({ tenantId: ctx.tenantId, yearId: y }).sort({ department: 1, work: 1 }).lean(),
    Expense.aggregate([{ $match: { tenantId: ctx.tenantId, yearId: y } }, { $group: { _id: { k: { $ifNull: ['$nature', 'revenue'] }, d: '$department', w: { $ifNull: ['$work', ''] }, s: '$status' }, amount: { $sum: '$amount' } } }]),
  ]);
  const sum = (kind, dep, work, status) => spent.filter((x) => x._id.k === kind && x._id.d === dep && x._id.s === status && (work === '' || x._id.w === work)).reduce((n, x) => n + x.amount, 0);
  const items = budgets.map((b) => {
    const kind = b.kind || 'revenue';
    const used = money(sum(kind, b.department, b.work || '', 'approved')); const pending = money(sum(kind, b.department, b.work || '', 'pending'));
    return { ...b, kind, used, pending, remaining: money(b.allocated - used), percentUsed: b.allocated ? Math.round((used / b.allocated) * 1000) / 10 : null, over: used > b.allocated };
  });
  // spending in departments that have no budget of that kind is shown too, so nothing is silent
  const budgeted = new Set(budgets.map((b) => `${b.kind || 'revenue'}|${b.department}`));
  const seen = new Map();
  for (const x of spent) { const k = `${x._id.k}|${x._id.d}`; if (!budgeted.has(k)) seen.set(k, { kind: x._id.k, department: x._id.d }); }
  const unbudgeted = [...seen.values()].map((u) => ({ ...u, used: money(sum(u.kind, u.department, '', 'approved')), pending: money(sum(u.kind, u.department, '', 'pending')) }));
  const total = (rows, k) => money(rows.reduce((n, b) => n + b[k], 0));
  const totalsOf = (rows) => ({ allocated: total(rows, 'allocated'), used: total(rows, 'used'), pending: total(rows, 'pending'), remaining: total(rows, 'remaining') });
  return { yearId: y, items, unbudgeted, totals: totalsOf(items), byKind: Object.fromEntries(KINDS.map((k) => [k, totalsOf(items.filter((b) => b.kind === k))])) };
}
export async function saveBudget(ctx, body) {
  const yearId = body.yearId || ctx.year?._id;
  if (!yearId) throw bad('Create an academic year first');
  const key = { tenantId: ctx.tenantId, yearId, kind: body.kind || 'revenue', department: body.department, work: body.work || '' };
  return Budget.findOneAndUpdate(key, { $set: { allocated: body.allocated, notes: body.notes } }, { upsert: true, new: true });
}
export async function deleteBudget(ctx, id) {
  const b = await Budget.findOneAndDelete({ _id: id, tenantId: ctx.tenantId });
  if (!b) throw notFound('Budget not found');
}

// ───────────── receipts of spending: every payment made, and its voucher ─────────────
const MODE_LABEL = { cash: 'cash', upi: 'UPI', cheque: 'cheque', bank_transfer: 'bank transfer', card: 'card', other: 'other' };

/** Every payment the school has made on approved bills, newest first, narrowed by date, vendor, department, type, how it was paid, or a search over voucher, reference, bill and vendor. */
export async function listExpensePayments(ctx, q) {
  const f = { tenantId: ctx.tenantId, status: 'approved', paymentStatus: { $in: ['part', 'paid'] } };
  if (q.vendorId) f.vendorId = q.vendorId;
  if (q.department) f.department = q.department;
  if (q.nature) f.nature = q.nature === 'revenue' ? { $in: ['revenue', null] } : q.nature;
  const expenses = await Expense.find(f).lean();
  const rx = q.q ? new RegExp(escapeRegex(q.q), 'i') : null;
  const rows = [];
  for (const e of expenses) {
    paymentsOf(e).forEach((p, i) => {
      const row = { expenseId: e._id, paymentId: p._id ? String(p._id) : 'older', index: i, voucherNo: p.voucherNo, paidOn: p.paidOn, amount: p.amount, mode: p.mode, reference: p.reference, note: p.note, byName: p.byName,
        title: e.title, billNo: e.billNo, vendor: e.vendor, vendorId: e.vendorId, department: e.department, work: e.work, nature: e.nature || 'revenue', billAmount: e.amount };
      if (q.mode && p.mode !== q.mode) return;
      if (q.from && (p.paidOn || '') < q.from) return;
      if (q.to && (p.paidOn || '') > q.to) return;
      if (rx && !(rx.test(row.voucherNo || '') || rx.test(row.reference || '') || rx.test(row.title || '') || rx.test(row.billNo || '') || rx.test(row.vendor || ''))) return;
      rows.push(row);
    });
  }
  rows.sort((a, b) => String(b.paidOn).localeCompare(String(a.paidOn)) || String(b.voucherNo).localeCompare(String(a.voucherNo)));
  const sum = (list) => money(list.reduce((n, r) => n + r.amount, 0));
  const departments = [...new Set((await Expense.distinct('department', { tenantId: ctx.tenantId, paymentStatus: { $in: ['part', 'paid'] } })))].sort();
  return { total: rows.length, items: rows.slice((q.page - 1) * q.limit, q.page * q.limit), totals: { amount: sum(rows), count: rows.length, revenue: sum(rows.filter((r) => r.nature !== 'capital')), capital: sum(rows.filter((r) => r.nature === 'capital')) }, departments };
}

export async function exportExpensePayments(ctx, q) {
  const d = await listExpensePayments(ctx, { ...q, page: 1, limit: 1000000 });
  return toCsv(d.items, [{ label: 'Voucher', get: (r) => r.voucherNo }, { label: 'Date paid', get: (r) => r.paidOn }, { label: 'Paid to', get: (r) => r.vendor }, { label: 'For', get: (r) => r.title }, { label: 'Bill no', get: (r) => r.billNo },
    { label: 'Department', get: (r) => r.department }, { label: 'Type', get: (r) => r.nature }, { label: 'Mode', get: (r) => r.mode }, { label: 'Reference', get: (r) => r.reference }, { label: 'Amount', get: (r) => r.amount }, { label: 'Recorded by', get: (r) => r.byName }]);
}

/** The payment voucher PDF for one payment on a bill. Payments recorded before part payments existed are asked for as "older". */
export async function renderVoucher(ctx, expenseId, paymentId, res) {
  const e = await own(ctx, expenseId);
  const list = paymentsOf(e.toObject());
  const idx = paymentId === 'older' ? 0 : list.findIndex((p) => String(p._id) === paymentId);
  const p = list[idx];
  if (!p || (paymentId === 'older' && e.payments?.length)) throw notFound('Payment not found');
  const [look, vendor] = await Promise.all([loadLook(ctx.tenantId), e.vendorId ? Vendor.findById(e.vendorId).select('code category name').lean() : null]);
  const soFar = money(list.slice(0, idx + 1).reduce((n, x) => n + x.amount, 0));
  const doc = new PDFDocument({ size: 'A5', margin: 0, info: { Title: `Payment voucher ${p.voucherNo || ''}`.trim() } });
  doc.pipe(res);
  drawVoucher(doc, look, {
    voucherNo: p.voucherNo, paidOn: p.paidOn, vendor: vendor?.name || e.vendor, vendorCode: vendor?.code, vendorCategory: vendor?.category, department: e.department, work: e.work, billNo: e.billNo, billDate: e.date,
    title: e.title, amount: p.amount, billAmount: e.amount, paidSoFar: soFar, balance: money(e.amount - soFar), note: p.note, byName: p.byName,
    payLine: `Paid by ${MODE_LABEL[p.mode] || p.mode}${p.reference ? ` · Ref ${p.reference}` : ''}`,
  });
  doc.end();
}
