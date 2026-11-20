import PDFDocument from 'pdfkit';
import { loadLook } from './look.js';
import { drawReceipt } from './receipt.js';
import { drawPayslip } from './payslip.js';

const today = () => new Date().toLocaleDateString('en-CA');

/** A made-up fee receipt, so a school can see its own letterhead, stamp and signature on the real layout before anything is issued. */
export async function sampleReceipt(tenantId, res, lookOverride) {
  const look = lookOverride || await loadLook(tenantId);
  const doc = new PDFDocument({ size: 'A5', margin: 0, info: { Title: 'Sample fee receipt' } });
  doc.pipe(res);
  drawReceipt(doc, look, {
    kind: 'payment', receiptNo: 'RCPT202600412', paidOn: today(), student: 'Aarav Sharma', guardian: 'Rakesh Sharma', admissionNo: 'ADM20260001', classLabel: '8-A', yearName: '2026 – 27',
    allocations: [{ label: 'Tuition fee', period: 'Term 2', amount: 9500 }, { label: 'Transport fee', period: 'Oct – Nov', amount: 2400 }, { label: 'Activity fee', period: 'Term 2', amount: 600 }], total: 12500,
    payLine: 'Paid by UPI · Ref 4182 9930 1177 · Received by Ravi Iyer', showBalance: true, balanceOn: today(), outstanding: 0, next: { label: 'Term 3', dueDate: '2027-01-10', amount: 9500 },
  }, { sample: true });
  doc.end();
}

export async function samplePayslip(tenantId, res, lookOverride) {
  const look = lookOverride || await loadLook(tenantId);
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'Sample payslip' } });
  doc.pipe(res);
  const month = today().slice(0, 7);
  drawPayslip(doc, look, {
    month, payslipNo: `PAY${month.replace('-', '')}-T014`, name: 'Meera Nair', employeeId: 'T-014', designation: 'Senior Teacher, Mathematics', joinedOn: '2018-06-14', pan: 'ABCDE••••F', bank: 'HDFC ···· 4821',
    period: `1 – ${new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+month.slice(5) - 1]} ${month.slice(0, 4)}`, workingDays: 26, paidDays: 26, unpaidDays: 0,
    earnings: [{ label: 'Basic pay', amount: 32000 }, { label: 'House rent allowance', amount: 12800 }, { label: 'Transport allowance', amount: 3200 }, { label: 'Special allowance', amount: 4000 }],
    deductions: [{ label: 'Provident fund (12% of basic)', amount: 3840 }, { label: 'Professional tax', amount: 200 }, { label: 'Salary advance recovery', amount: 2000 }], adjustments: [], lossOfPay: 0,
    gross: 52000, totalDeductions: 6040, net: 45960, paymentLine: 'Paid by bank transfer · Ref UTR 3029 8841 7712', employerPf: 3840,
    ytdLabel: 'financial year to date', ytdGross: 364000, ytdNet: 321720, generatedOn: today(),
  }, { sample: true });
  doc.end();
}
