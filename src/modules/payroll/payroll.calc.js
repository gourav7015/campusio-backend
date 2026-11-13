import { round2, eachDate, isoDay } from '../../core/utils.js';

/** Money amount of one allowance/deduction line: fixed rupees, or a percentage of basic. */
export const lineAmount = (item, basic) => round2(item.kind === 'percent' ? (basic * item.value) / 100 : item.value);

/** Monthly structure of a salary revision (or pay level). */
export function structureOf({ basic, allowances = [], deductions = [] }) {
  const earnings = [{ label: 'Basic', amount: round2(basic) }, ...allowances.map((a) => ({ label: a.label, amount: lineAmount(a, basic) }))];
  const ded = deductions.map((d) => ({ label: d.label, amount: lineAmount(d, basic) }));
  const gross = round2(earnings.reduce((n, e) => n + e.amount, 0));
  const fixedDeductions = round2(ded.reduce((n, e) => n + e.amount, 0));
  return { earnings, deductions: ded, gross, fixedDeductions, net: round2(gross - fixedDeductions) };
}

export const monthBounds = (month) => {
  const [y, m] = month.split('-').map(Number);
  return { start: `${month}-01`, end: `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}` };
};

/** Working dates of a month: the school's working weekdays minus school-wide holidays. */
export function workingDates(settings, month, holidayDates = new Set()) {
  const { start, end } = monthBounds(month);
  return eachDate(start, end).filter((d) => settings.workingDays.includes(isoDay(d)) && !holidayDates.has(d));
}

const ceilRupee = (n) => Math.ceil(n - 1e-9);

/**
 * Statutory contributions (India) from the school's policy. Employee shares become deduction lines on the payslip, unless the pay level
 * already has a line for that deduction (then that line is used and nothing is added twice). Employer shares are only reported.
 *   PF  : employee % of the earned basic, capped at the wage ceiling; employer share split into EPS (8.33%) and EPF (the rest)
 *   ESI : only while the fixed monthly gross is within the ceiling; both shares on earned gross, rounded up to the next rupee
 *   PT  : a flat amount from the slab the earned gross falls in
 */
export function statutoryOf(policy, { revision, st, ratio }) {
  if (!policy) return { lines: [], report: null };
  const has = (re) => (revision.deductions || []).find((d) => re.test(d.label));
  const earnedBasic = revision.basic * ratio; const earnedGross = st.gross * ratio;
  const lines = []; const report = {};
  if (policy.pf?.enabled) {
    const wages = Math.min(earnedBasic, policy.pf.wageCeiling);
    const own = has(/provident|\bpf\b|\bepf\b/i);
    const employee = own ? lineAmount(own, revision.basic) : round2((wages * policy.pf.employeeRate) / 100);
    if (!own && employee > 0) lines.push({ label: 'Provident Fund', amount: employee });
    const eps = round2((wages * 8.33) / 100);
    report.pf = { wages: round2(wages), employee, employer: round2((wages * policy.pf.employerRate) / 100), eps, epf: round2((wages * policy.pf.employerRate) / 100 - eps) };
  }
  if (policy.esi?.enabled && st.gross <= policy.esi.grossCeiling) {
    const own = has(/\besi\b|state insurance/i);
    const employee = own ? lineAmount(own, revision.basic) : ceilRupee((earnedGross * policy.esi.employeeRate) / 100);
    if (!own && employee > 0) lines.push({ label: 'ESI', amount: employee });
    report.esi = { gross: round2(earnedGross), employee, employer: ceilRupee((earnedGross * policy.esi.employerRate) / 100) };
  }
  if (policy.pt?.enabled) {
    const own = has(/professional tax|\bpt\b/i);
    const slab = [...policy.pt.slabs].sort((a, b) => a.upTo - b.upTo).find((x) => earnedGross <= x.upTo);
    const amount = own ? lineAmount(own, revision.basic) : slab?.amount || 0;
    if (!own && amount > 0) lines.push({ label: 'Professional Tax', amount });
    report.pt = { gross: round2(earnedGross), amount };
  }
  return { lines, report: Object.keys(report).length ? report : null };
}

/**
 * Pay for one person for one month.
 * Loss of pay = gross x unpaid working days / working days of the month. Fixed deductions are not prorated.
 * Statutory deductions (when the school's policy switches them on) come next, then manual adjustments (bonus, advance recovery, ...).
 * Net pay can never be negative.
 */
export function computePayslip({ revision, workingDays, unpaidDays, adjustments = [], policy }) {
  const st = structureOf(revision);
  const unpaid = Math.min(unpaidDays, workingDays);
  const lossOfPay = workingDays > 0 ? round2((st.gross * unpaid) / workingDays) : 0;
  const ratio = workingDays > 0 ? (workingDays - unpaid) / workingDays : 1;
  const { lines, report } = statutoryOf(policy, { revision, st, ratio });
  const bonus = round2(adjustments.filter((a) => a.type === 'earning').reduce((n, a) => n + a.amount, 0));
  const recover = round2(adjustments.filter((a) => a.type === 'deduction').reduce((n, a) => n + a.amount, 0));
  const gross = round2(st.gross + bonus);
  const statutoryTotal = round2(lines.reduce((n, l) => n + l.amount, 0));
  const totalDeductions = round2(st.fixedDeductions + statutoryTotal + lossOfPay + recover);
  const net = round2(gross - totalDeductions);
  return { earnings: st.earnings, deductions: [...st.deductions, ...lines], statutory: report, lossOfPay, workingDays, unpaidDays: unpaid, paidDays: workingDays - unpaid, gross, totalDeductions, net };
}
