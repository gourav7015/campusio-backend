import { Vendor, Expense, User } from '../../models/index.js';
import { notFound, conflict, bad, escapeRegex, toCsv } from '../../core/utils.js';
import { nextSeq } from '../../services/context.js';
import { notifyUsers } from '../../services/notify.js';

/** Changing any of these on an approved vendor sends it back for approval: a new bank account or tax number must be checked again. */
const SENSITIVE = ['name', 'gstin', 'pan', 'bankName', 'accountName', 'accountNo', 'ifsc', 'upi'];
const key = (name) => String(name).trim().toLowerCase().replace(/\s+/g, ' ');
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export async function listVendors(ctx, q) {
  const f = { tenantId: ctx.tenantId };
  if (q.status && q.status !== 'all') f.status = q.status;
  if (q.category) f.category = q.category;
  if (q.q) { const rx = new RegExp(escapeRegex(q.q), 'i'); f.$or = [{ name: rx }, { code: rx }, { gstin: rx }, { pan: rx }, { contactPerson: rx }, { phone: rx }]; }
  const [items, total, counts, cats] = await Promise.all([
    Vendor.find(f).sort({ name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Vendor.countDocuments(f),
    Vendor.aggregate([{ $match: { tenantId: ctx.tenantId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Vendor.distinct('category', { tenantId: ctx.tenantId }),
  ]);
  const by = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  const spend = items.length ? await Expense.aggregate([{ $match: { tenantId: ctx.tenantId, vendorId: { $in: items.map((v) => v._id) }, status: 'approved' } }, { $group: { _id: '$vendorId', amount: { $sum: '$amount' }, n: { $sum: 1 } } }]) : [];
  const S = new Map(spend.map((s) => [String(s._id), s]));
  return {
    total, items: items.map((v) => ({ ...v, spent: S.get(String(v._id))?.amount || 0, expenses: S.get(String(v._id))?.n || 0 })),
    counts: { pending: by.pending || 0, approved: by.approved || 0, rejected: by.rejected || 0, inactive: by.inactive || 0, all: Object.values(by).reduce((a, b) => a + b, 0) }, categories: cats.filter(Boolean).sort(),
  };
}

async function loadVendor(ctx, id) {
  const v = await Vendor.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!v) throw notFound('Vendor not found');
  return v;
}

async function newCode(ctx) { return `VND-${String(await nextSeq(ctx.tenantId, 'vendor')).padStart(4, '0')}`; }

async function assertUnique(ctx, name, exceptId) {
  const dup = await Vendor.findOne({ tenantId: ctx.tenantId, nameKey: key(name), ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).select('code name').lean();
  if (dup) throw conflict(`${dup.name} is already in the vendor list (${dup.code})`);
}

export async function createVendor(ctx, body, user) {
  await assertUnique(ctx, body.name);
  return Vendor.create({ ...clean(body), tenantId: ctx.tenantId, code: await newCode(ctx), nameKey: key(body.name), status: 'pending', submittedBy: user._id, submittedByName: user.name });
}

export async function updateVendor(ctx, id, patch, user) {
  const v = await loadVendor(ctx, id);
  if (patch.name && key(patch.name) !== v.nameKey) await assertUnique(ctx, patch.name, v._id);
  const changed = SENSITIVE.some((k) => patch[k] !== undefined && String(patch[k] || '') !== String(v[k] || ''));
  Object.assign(v, clean(patch));
  if (patch.name) v.nameKey = key(patch.name);
  if (changed && ['approved', 'rejected'].includes(v.status)) { // a corrected rejected vendor, or a changed approved one, is checked again
    v.status = 'pending'; v.decidedBy = undefined; v.decidedByName = undefined; v.decidedAt = undefined; v.decisionNote = undefined; v.submittedBy = user._id; v.submittedByName = user.name;
  }
  await v.save();
  if (changed) await Expense.updateMany({ tenantId: ctx.tenantId, vendorId: v._id, status: 'pending' }, { vendor: v.name }); // keep the name on waiting expenses in step
  return v;
}

export async function setVendorActive(ctx, id, active) {
  const v = await loadVendor(ctx, id);
  if (active) { if (v.status !== 'inactive') throw conflict('This vendor is not switched off'); v.status = 'approved'; }
  else { if (v.status !== 'approved') throw conflict('Only an approved vendor can be switched off'); v.status = 'inactive'; }
  return v.save();
}

export async function deleteVendor(ctx, id) {
  const v = await loadVendor(ctx, id);
  if (await Expense.exists({ tenantId: ctx.tenantId, vendorId: v._id })) throw conflict('Expenses were recorded for this vendor. Switch the vendor off instead of deleting it.');
  await v.deleteOne();
}

/** The School Admin approves or rejects one vendor (a note is needed to reject). */
export async function decideVendor(ctx, id, { approve, note }, user) {
  const v = await loadVendor(ctx, id);
  if (v.status !== 'pending') throw conflict(`This vendor is already ${v.status}`);
  if (!approve && !note) throw bad('Say why it is being rejected');
  return decide(ctx, v, approve, note, user);
}
async function decide(ctx, v, approve, note, user) {
  v.status = approve ? 'approved' : 'rejected'; v.decidedBy = user._id; v.decidedByName = user.name; v.decidedAt = new Date(); v.decisionNote = note || undefined;
  await v.save();
  return v;
}
/** Approve (or reject) many at once: the chosen ids, or every vendor waiting. Meant for a freshly imported list. */
export async function decideVendors(ctx, { approve, ids, note }, user) {
  if (!approve && !note) throw bad('Say why they are being rejected');
  const f = { tenantId: ctx.tenantId, status: 'pending', ...(ids?.length ? { _id: { $in: ids } } : {}) };
  const list = await Vendor.find(f);
  for (const v of list) await decide(ctx, v, approve, note, user);
  if (list.length) {
    const fin = await User.find({ tenantId: ctx.tenantId, role: 'finance', status: 'active' }).select('_id').lean();
    await notifyUsers(ctx.tenantId, fin.map((u) => u._id), { category: 'system', title: `${list.length} vendor(s) ${approve ? 'approved' : 'rejected'}`, body: approve ? 'They can now be chosen on expenses.' : `Reason: ${note}`, link: { type: 'vendors' }, dedupeKey: `vendors-${Date.now()}` });
  }
  return { decided: list.length };
}

export async function vendorsByStatus(ctx, statuses) { return Vendor.find({ tenantId: ctx.tenantId, status: { $in: statuses } }).sort({ decidedAt: -1, createdAt: -1 }).limit(200).lean(); }
export async function pendingVendors(ctx) { return Vendor.find({ tenantId: ctx.tenantId, status: 'pending' }).sort({ createdAt: 1 }).lean(); }

/** The approved vendors, for the pick-list on an expense. */
export async function approvedVendors(ctx) { return Vendor.find({ tenantId: ctx.tenantId, status: 'approved' }).sort({ name: 1 }).select('code name category').limit(1000).lean(); }

/**
 * Bulk load: many rows at once (from a spreadsheet). Every row is checked on its own; rows that are fine are saved (as waiting for approval),
 * rows with a problem are returned with the row number and the reason, and nothing is half-saved for a row.
 * `check(row)` is the same validation a single vendor goes through.
 */
export async function importVendors(ctx, rows, user, check) {
  const existing = new Set((await Vendor.find({ tenantId: ctx.tenantId }).select('nameKey').lean()).map((v) => v.nameKey));
  const seen = new Set(); const errors = []; let created = 0;
  for (let i = 0; i < rows.length; i++) {
    const line = i + 2; // the sheet's first row is the heading
    const r = check(rows[i]);
    if (!r.ok) { errors.push({ row: line, name: rows[i]?.name || '', error: r.error }); continue; }
    const k = key(r.value.name);
    if (existing.has(k) || seen.has(k)) { errors.push({ row: line, name: r.value.name, error: 'Already in the vendor list' }); continue; }
    seen.add(k);
    try {
      await Vendor.create({ ...clean(r.value), tenantId: ctx.tenantId, code: await newCode(ctx), nameKey: k, status: 'pending', submittedBy: user._id, submittedByName: user.name });
      created++;
    } catch (e) { errors.push({ row: line, name: r.value.name, error: e.code === 11000 ? 'Already in the vendor list' : e.message }); }
  }
  return { received: rows.length, created, skipped: errors.length, errors };
}

export async function exportVendors(ctx) {
  const rows = await Vendor.find({ tenantId: ctx.tenantId }).sort({ name: 1 }).lean();
  const col = (label, k) => ({ label, get: (r) => r[k] });
  return toCsv(rows, [col('Code', 'code'), col('Name', 'name'), col('Category', 'category'), col('Status', 'status'), col('Contact person', 'contactPerson'), col('Phone', 'phone'), col('Email', 'email'), col('Address', 'address'), col('City', 'city'), col('State', 'state'), col('Pincode', 'pincode'),
    col('GSTIN', 'gstin'), col('PAN', 'pan'), col('Bank', 'bankName'), col('Account name', 'accountName'), col('Account number', 'accountNo'), col('IFSC', 'ifsc'), col('UPI', 'upi'), col('Payment terms', 'paymentTerms'), col('Notes', 'notes')]);
}
