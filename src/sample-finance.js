/**
 * Sample vendors, budgets and spending for one of the bulk-loaded sample schools (dpsr, sunr, gwvs), so the Vendors, Budgets and Expenditure pages have something to show.
 *   npm run sample:finance            (the dpsr school)
 *   npm run sample:finance -- sunr    (another sample school)
 * It only ADDS records, writes them the way the app does (approved vendors, bills in different states, payments with voucher numbers), and does nothing at all
 * if the school already has any vendor, so running it twice is harmless. It never runs in production.
 */
if (process.env.NODE_ENV === 'production') { console.error('This script writes sample records and must never run in production.'); process.exit(1); }
import mongoose from 'mongoose';
import { requireMongoUri } from './core/config.js';
import { todayStr, addDays, round2 } from './core/utils.js';
import { nextSeq } from './services/context.js';
import * as M from './models/index.js';

const code = (process.argv[2] || 'dpsr').toLowerCase();
const key = (name) => String(name).trim().toLowerCase().replace(/\s+/g, ' ');

const VENDORS = [
  { name: 'Sharma Stationers', category: 'Stationery', contactPerson: 'Mahesh Sharma', phone: '9876501234', email: 'accounts@sharmastationers.example', bankName: 'State Bank of India', accountNo: '30123456789', ifsc: 'SBIN0001234', paymentTerms: '30 days from the bill' },
  { name: 'Shree Office Furniture', category: 'Furniture', contactPerson: 'Kiran Patel', phone: '9825012345', bankName: 'HDFC Bank', accountNo: '50100123456789', ifsc: 'HDFC0000321', paymentTerms: '15 days from delivery' },
  { name: 'Rajkot Sports Traders', category: 'Sports', contactPerson: 'Imran Shaikh', phone: '9898011122', bankName: 'Bank of Baroda', accountNo: '29810100012345', ifsc: 'BARB0RAJKOT', paymentTerms: 'On delivery' },
  { name: 'Sai Lab Equipments', category: 'Science lab', contactPerson: 'Dr. Nilesh Trivedi', phone: '9879022233', bankName: 'ICICI Bank', accountNo: '123405001234', ifsc: 'ICIC0001234', paymentTerms: '30 days from the bill' },
  { name: 'Metro Printing Press', category: 'Printing', contactPerson: 'Jignesh Vora', phone: '9925033344', bankName: 'State Bank of India', accountNo: '30987654321', ifsc: 'SBIN0004321', paymentTerms: '45 days from the bill' },
  { name: 'CleanCare Housekeeping Services', category: 'Housekeeping', contactPerson: 'Meena Solanki', phone: '9712044455', bankName: 'Axis Bank', accountNo: '918020012345678', ifsc: 'UTIB0000456', paymentTerms: 'Monthly, by the 10th' },
  { name: 'Gujarat Bus Spares and Service', category: 'Transport', contactPerson: 'Harsh Rathod', phone: '9724055566', bankName: 'Bank of Baroda', accountNo: '29810100099999', ifsc: 'BARB0RAJKOT', paymentTerms: '30 days from the bill' },
];

// [vendor index or null, department, work, title, amount, nature, days ago the bill is dated, due in days after the bill, status, payments: [[amount, days ago, mode, reference]]]
const BILLS = [
  [0, 'Office supplies', '', 'Notebooks and registers', 48500, 'revenue', 150, 30, 'approved', [[48500, 125, 'bank_transfer', 'UTR41022']]],
  [0, 'Examinations', '', 'Answer sheets and question paper stock', 36200, 'revenue', 95, 30, 'approved', [[20000, 70, 'bank_transfer', 'UTR41877'], [16200, 40, 'bank_transfer', 'UTR42310']]],
  [0, 'Office supplies', '', 'Files, folders and stationery', 18400, 'revenue', 28, 30, 'approved', [[8000, 6, 'upi', 'UPI0098123']]],
  [1, 'Administration', 'Staff room furniture', 'Staff room chairs and tables', 164000, 'capital', 60, 15, 'approved', [[100000, 40, 'bank_transfer', 'UTR42011']]],
  [1, 'Administration', '', 'Reception desk repair', 14500, 'revenue', 22, 15, 'approved', []],
  [2, 'Sports', '', 'Cricket and football kits', 86000, 'revenue', 110, 0, 'approved', [[86000, 108, 'cheque', '004512']]],
  [2, 'Sports', 'Football turf', 'Football turf, first instalment', 300000, 'capital', 75, 30, 'approved', [[300000, 50, 'bank_transfer', 'UTR42190']]],
  [2, 'Sports', 'Football turf', 'Football turf, second instalment', 300000, 'capital', 12, 30, 'approved', []],
  [3, 'Science', 'New computer lab', 'Computers and lab furniture', 520000, 'capital', 45, 30, 'approved', [[200000, 20, 'bank_transfer', 'UTR42504']]],
  [3, 'Science', '', 'Chemicals and glassware for the term', 62500, 'revenue', 35, 30, 'approved', [[62500, 14, 'upi', 'UPI0099451']]],
  [4, 'Examinations', '', 'Printing of annual report cards', 41200, 'revenue', 18, 45, 'approved', []],
  [4, 'Events', '', 'Annual day invitations and programme books', 27800, 'revenue', 8, 45, 'approved', []],
  [5, 'Maintenance', '', 'Housekeeping, April to June', 186000, 'revenue', 130, 10, 'approved', [[62000, 120, 'bank_transfer', 'UTR41500'], [62000, 90, 'bank_transfer', 'UTR41980'], [62000, 60, 'bank_transfer', 'UTR42120']]],
  [5, 'Maintenance', '', 'Housekeeping, July to September', 186000, 'revenue', 40, 10, 'approved', [[62000, 28, 'bank_transfer', 'UTR42620'], [62000, 3, 'bank_transfer', 'UTR42995']]],
  [6, 'Transport', '', 'Bus tyres and servicing', 94000, 'revenue', 20, 30, 'approved', [[40000, 5, 'bank_transfer', 'UTR43010']]],
  [6, 'Transport', '', 'Bus insurance renewal', 128000, 'revenue', 3, 30, 'approved', []],
  [null, 'Events', '', 'Annual day stage and sound', 65000, 'revenue', 2, 0, 'pending', []],
  [5, 'Maintenance', '', 'Playground repair', 38000, 'revenue', 1, 0, 'pending', []],
  [null, 'Administration', '', 'Gifts for guests', 22000, 'revenue', 30, 0, 'rejected', []],
];
const BUDGETS = [
  ['revenue', 'Office supplies', '', 120000], ['revenue', 'Examinations', '', 90000], ['revenue', 'Sports', '', 120000], ['revenue', 'Science', '', 100000],
  ['revenue', 'Maintenance', '', 420000], ['revenue', 'Transport', '', 250000], ['revenue', 'Events', '', 100000],
  ['capital', 'Administration', 'Staff room furniture', 200000], ['capital', 'Sports', 'Football turf', 700000], ['capital', 'Science', 'New computer lab', 800000],
];

async function main() {
  await mongoose.connect(requireMongoUri(), { serverSelectionTimeoutMS: 15000 }).catch((e) => { console.error(`Cannot reach MongoDB. Check MONGO_URI in .env.\n(${e.message})`); process.exit(1); });
  const school = await M.School.findOne({ code }).lean();
  if (!school) { console.error(`There is no school with the code "${code}" in the database "${mongoose.connection.name}".`); process.exit(1); }
  const tenantId = school._id;
  console.log(`Database ${mongoose.connection.name} on ${mongoose.connection.host}: ${school.name}`);
  if (await M.Vendor.exists({ tenantId })) { console.log('This school already has vendors, so nothing was added.'); await mongoose.disconnect(); return; }
  const today = todayStr('Asia/Kolkata');
  const [admin, fin, year] = await Promise.all([
    M.User.findOne({ tenantId, role: 'school_admin' }).select('name').lean(), M.User.findOne({ tenantId, role: 'finance' }).select('name').lean(),
    M.AcademicYear.findOne({ tenantId, isCurrent: true }).lean(),
  ]);
  if (!year) { console.error('The school has no current academic year.'); process.exit(1); }
  const adminName = admin?.name || 'School Admin'; const finName = fin?.name || 'Finance';

  const vendors = [];
  for (const [i, v] of VENDORS.entries()) {
    vendors.push(await M.Vendor.create({ tenantId, code: `VND-${String(i + 1).padStart(4, '0')}`, nameKey: key(v.name), city: 'Rajkot', state: 'Gujarat', accountName: v.name, ...v,
      status: 'approved', submittedByName: finName, decidedByName: adminName, decidedAt: new Date() }));
  }
  // a budget line the school already has is left exactly as it is
  let budgets = 0;
  for (const [kind, department, work, allocated] of BUDGETS) { const r = await M.Budget.updateOne({ tenantId, yearId: year._id, kind, department, work }, { $setOnInsert: { allocated } }, { upsert: true }); budgets += r.upsertedCount; }

  let paid = 0;
  for (const [vi, department, work, title, amount, nature, ago, terms, status, pays] of BILLS) {
    const date = addDays(today, -ago); const v = vi == null ? null : vendors[vi];
    const doc = { tenantId, yearId: year._id, date, department, work: work || undefined, title, amount, nature, status, vendor: v?.name, vendorId: v?._id, billNo: v ? `B-${String(1000 + paid + Math.floor(amount % 900))}` : undefined,
      dueDate: v ? addDays(date, terms) : undefined, submittedByName: finName };
    if (status !== 'pending') Object.assign(doc, { decidedByName: adminName, decidedAt: new Date(), ...(status === 'rejected' ? { decisionNote: 'Not needed this year' } : {}) });
    if (pays.length) {
      doc.payments = [];
      for (const [pay, payAgo, mode, reference] of pays) {
        const paidOn = addDays(today, -payAgo); const yyyy = paidOn.slice(0, 4);
        doc.payments.push({ amount: pay, paidOn, mode, reference, byName: finName, voucherNo: `PV${yyyy}${String(await nextSeq(tenantId, `voucher:${yyyy}`)).padStart(5, '0')}` });
      }
      doc.paidAmount = round2(pays.reduce((n, p) => n + p[0], 0));
      doc.paymentStatus = doc.paidAmount >= amount ? 'paid' : 'part';
      const last = doc.payments.at(-1);
      Object.assign(doc, { paidOn: last.paidOn, paymentMode: last.mode, paymentRef: last.reference, paidByName: finName, paidAt: new Date() });
    }
    await M.Expense.create(doc); paid += 1;
  }
  console.log(`Added ${vendors.length} vendors, ${budgets} budget lines and ${BILLS.length} expenses to ${school.name}.`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
