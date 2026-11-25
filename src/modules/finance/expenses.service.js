import { Expense, Budget, User, Vendor, File } from '../../models/index.js';
import { notFound, conflict, bad, round2 } from '../../core/utils.js';
import { removeFileBytes } from '../../services/files.js';
import { notifyUsers } from '../../services/notify.js';

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
  else if (q.payment === 'unpaid') { f.status = 'approved'; f.paymentStatus = { $ne: 'paid' }; }
  const [rows, total, tot, deps] = await Promise.all([
    Expense.find(f).sort({ date: -1, createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Expense.countDocuments(f),
    Expense.aggregate([{ $match: f }, { $group: { _id: '$status', amount: { $sum: '$amount' }, n: { $sum: 1 } } }]),
    Expense.distinct('department', { tenantId: ctx.tenantId }),
  ]);
  const by = Object.fromEntries(tot.map((t) => [t._id, { amount: money(t.amount), count: t.n }]));
  const toPay = await Expense.aggregate([{ $match: { tenantId: ctx.tenantId, status: 'approved', paymentStatus: { $ne: 'paid' } } }, { $group: { _id: null, amount: { $sum: '$amount' }, n: { $sum: 1 } } }]);
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

/** Money goes out only for an expense the School Admin has approved. Finance records how and when it was paid. */
export async function payExpense(ctx, id, { mode, reference, paidOn, note }, user) {
  const e = await own(ctx, id);
  if (e.status !== 'approved') throw conflict(e.status === 'pending' ? 'This expense is waiting for the School Admin. It can be paid only after approval.' : 'A rejected expense cannot be paid');
  if (e.paymentStatus === 'paid') throw conflict('This expense is already paid');
  if (paidOn && paidOn > ctx.today) throw bad('A payment cannot be dated in the future');
  if (e.vendorId) { const v = await Vendor.findById(e.vendorId).select('status name').lean(); if (v && v.status !== 'approved') throw conflict(`${v.name} is no longer an approved vendor`); }
  Object.assign(e, { paymentStatus: 'paid', paidOn: paidOn || ctx.today, paymentMode: mode, paymentRef: reference || undefined, paymentNote: note || undefined, paidByName: user.name, paidAt: new Date() });
  return e.save();
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
