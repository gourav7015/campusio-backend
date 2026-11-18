import { Expense, Budget, User } from '../../models/index.js';
import { notFound, conflict, bad, round2 } from '../../core/utils.js';
import { notifyUsers } from '../../services/notify.js';

const money = round2;

export async function listExpenses(ctx, q) {
  const f = { tenantId: ctx.tenantId };
  if (q.status && q.status !== 'all') f.status = q.status;
  if (q.department) f.department = q.department;
  if (q.from || q.to) f.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.yearId) f.yearId = q.yearId;
  const [rows, total, tot, deps] = await Promise.all([
    Expense.find(f).sort({ date: -1, createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Expense.countDocuments(f),
    Expense.aggregate([{ $match: f }, { $group: { _id: '$status', amount: { $sum: '$amount' }, n: { $sum: 1 } } }]),
    Expense.distinct('department', { tenantId: ctx.tenantId }),
  ]);
  const by = Object.fromEntries(tot.map((t) => [t._id, { amount: money(t.amount), count: t.n }]));
  return { total, items: rows, totals: { approved: by.approved || { amount: 0, count: 0 }, pending: by.pending || { amount: 0, count: 0 }, rejected: by.rejected || { amount: 0, count: 0 } }, departments: deps.sort() };
}

export async function createExpense(ctx, body, user) {
  return Expense.create({ ...body, tenantId: ctx.tenantId, yearId: ctx.year?._id, status: 'pending', submittedBy: user._id, submittedByName: user.name });
}

async function own(ctx, id) {
  const e = await Expense.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!e) throw notFound('Expense not found');
  return e;
}
export async function updateExpense(ctx, id, patch) {
  const e = await own(ctx, id);
  if (e.status === 'approved') throw conflict('An approved expense is locked. Ask the School Admin to reject it first if it is wrong.');
  Object.assign(e, patch, { status: 'pending', decidedBy: undefined, decidedByName: undefined, decidedAt: undefined, decisionNote: undefined }); // an edited expense goes back for approval
  return e.save();
}
export async function deleteExpense(ctx, id) {
  const e = await own(ctx, id);
  if (e.status === 'approved') throw conflict('An approved expense cannot be deleted');
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
  await notifyUsers(ctx.tenantId, fin.map((u) => u._id), { category: 'system', title: `Expense ${e.status}`, body: `${e.title} (₹${e.amount}) was ${e.status}${note ? `: ${note}` : ''}.`, link: { type: 'expense', id: String(e._id) }, dedupeKey: `exp:${e._id}:${e.status}` });
  return e;
}

export async function pendingApprovals(ctx) {
  return (await Expense.find({ tenantId: ctx.tenantId, status: 'pending' }).sort({ date: 1 }).lean());
}

// ───────────── budgets ─────────────
export async function listBudgets(ctx, yearId) {
  const y = yearId || ctx.year?._id;
  const [budgets, spent] = await Promise.all([
    Budget.find({ tenantId: ctx.tenantId, yearId: y }).sort({ department: 1, work: 1 }).lean(),
    Expense.aggregate([{ $match: { tenantId: ctx.tenantId, yearId: y } }, { $group: { _id: { d: '$department', w: { $ifNull: ['$work', ''] }, s: '$status' }, amount: { $sum: '$amount' } } }]),
  ]);
  const sum = (dep, work, status) => spent.filter((x) => x._id.d === dep && x._id.s === status && (work === '' || x._id.w === work)).reduce((n, x) => n + x.amount, 0);
  const items = budgets.map((b) => {
    const used = money(sum(b.department, b.work || '', 'approved')); const pending = money(sum(b.department, b.work || '', 'pending'));
    return { ...b, used, pending, remaining: money(b.allocated - used), percentUsed: b.allocated ? Math.round((used / b.allocated) * 1000) / 10 : null, over: used > b.allocated };
  });
  // spending in departments that have no budget at all is shown too, so nothing is silent
  const budgeted = new Set(budgets.map((b) => b.department));
  const unbudgeted = [...new Set(spent.filter((x) => !budgeted.has(x._id.d)).map((x) => x._id.d))].map((d) => ({ department: d, used: money(sum(d, '', 'approved')), pending: money(sum(d, '', 'pending')) }));
  const total = (k) => money(items.reduce((n, b) => n + b[k], 0));
  return { yearId: y, items, unbudgeted, totals: { allocated: total('allocated'), used: total('used'), pending: total('pending'), remaining: total('remaining') } };
}
export async function saveBudget(ctx, body) {
  const yearId = body.yearId || ctx.year?._id;
  if (!yearId) throw bad('Create an academic year first');
  const key = { tenantId: ctx.tenantId, yearId, department: body.department, work: body.work || '' };
  return Budget.findOneAndUpdate(key, { $set: { allocated: body.allocated, notes: body.notes } }, { upsert: true, new: true });
}
export async function deleteBudget(ctx, id) {
  const b = await Budget.findOneAndDelete({ _id: id, tenantId: ctx.tenantId });
  if (!b) throw notFound('Budget not found');
}
