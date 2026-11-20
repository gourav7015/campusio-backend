import { kit, u, COLOR } from './kit.js';
import { amountInWords, inrNumber } from './words.js';
import { letterhead, signatureBlock, stampAt, niceDate, monthName } from './common.js';
import { sampleMark } from './look.js';

const rs = (n) => `₹ ${inrNumber(n)}`;

/** The payslip, A4. `look` = the school's letterhead and images; `d` = what the slip says. `sample` adds a faint SAMPLE mark and drawn placeholders for any missing stamp or signature. */
export function drawPayslip(doc, look, d, { sample = false } = {}) {
  const k = kit(doc, look.color);
  const W = doc.page.width; const H = doc.page.height; const L = u(48); const R = W - u(48); const CW = R - L;
  let y = u(44);

  y = letterhead(k, doc, look, { y, left: L, right: R, logoPx: 72, namePx: 25, title: 'PAYSLIP', big: monthName(d.month), small: `No. ${d.payslipNo}`, extraLine: look.affiliationNo ? `Affiliation No. ${look.affiliationNo}` : '' }) + u(18);

  // employee and period
  const rows = (a) => a.map(([l, v]) => [l, v || '—']);
  const left = rows([['Employee name', d.name], ['Employee ID', d.employeeId], ['Designation', [d.designation, d.levelName && `Level ${d.levelName}`].filter(Boolean).join(' · ')], ['Joined on', d.joinedOn ? niceDate(d.joinedOn) : ''], ['PAN', d.pan]]);
  const right = rows([['Pay period', d.period], ['Working days', String(d.workingDays ?? '')], ['Days paid', String(d.paidDays ?? '')], ['Unpaid leave', String(d.unpaidDays ?? 0)], ['Bank account', d.bank]]);
  const rowH = u(25); const boxH = u(24) + rowH * 5 - u(7);
  k.box(L, y, CW, boxH);
  k.vline(L + CW / 2, y, y + boxH);
  [left, right].forEach((col, ci) => {
    const x0 = L + (ci ? CW / 2 : 0) + u(16); const colW = CW / 2 - u(32) - u(120);
    col.forEach(([lab, val], i) => { const ry = y + u(12) + i * rowH; k.text(lab, x0, ry, { s: u(13), c: COLOR.muted }); k.text(k.fit(val, 'Semi', u(13), colW), x0 + u(120), ry, { f: 'Semi', s: u(13) }); });
  });
  y += boxH + u(18);

  // earnings and deductions
  const earn = [...d.earnings.map((e) => [e.label, e.amount]), ...d.adjustments.filter((a) => a.type === 'earning').map((a) => [`${a.label}${a.reason ? ` (${a.reason})` : ''}`, a.amount])];
  const ded = [...d.deductions.map((e) => [e.label, e.amount]), ...(d.lossOfPay ? [[`Loss of pay (${d.unpaidDays} day${d.unpaidDays === 1 ? '' : 's'})`, d.lossOfPay]] : []), ...d.adjustments.filter((a) => a.type === 'deduction').map((a) => [`${a.label}${a.reason ? ` (${a.reason})` : ''}`, a.amount])];
  const n = Math.max(earn.length, ded.length, 4);
  const footerTop = H - u(36) - u(12) - u(10); // the footer rule
  const sigH = u(64); const sigBlock = sigH + u(4) + u(40);
  const fixedBelow = u(18) + u(92) + u(18) + u(58) + u(18) + sigBlock + u(18);
  const headH = u(34); const totalH = u(40);
  const avail = footerTop - y - fixedBelow - headH - totalH;
  const lineH = Math.max(u(20), Math.min(u(34), avail / n));
  const tableH = headH + lineH * n + totalH;
  const tw = (CW - u(20)) / 2;
  const table = (x, title, lines, totalLabel, total) => {
    k.box(x, y, tw, tableH);
    doc.save().roundedRect(x, y, tw, headH, 4.5).clip().rect(x, y, tw, headH).fill(COLOR.head).restore();
    k.hline(x, x + tw, y + headH);
    k.text(title.toUpperCase(), x + u(14), y + (headH - u(12)) / 2, { f: 'Bold', s: u(12), c: look.color, spacing: 0.9 });
    k.text('AMOUNT (₹)', x + u(14), y + (headH - u(12)) / 2, { f: 'Bold', s: u(12), c: look.color, spacing: 0.9, w: tw - u(28), align: 'right' });
    lines.forEach(([lab, amt], i) => {
      const ry = y + headH + i * lineH; const ty = ry + (lineH - u(13)) / 2;
      k.text(k.fit(lab, 'Sans', u(13), tw - u(28) - u(80)), x + u(14), ty, { s: u(13) });
      k.text(inrNumber(amt), x + u(14), ty, { s: u(13), w: tw - u(28), align: 'right' });
      k.hline(x, x + tw, ry + lineH, { c: COLOR.row });
    });
    // empty rows keep both tables the same height
    for (let i = lines.length; i < n; i++) k.hline(x, x + tw, y + headH + (i + 1) * lineH, { c: COLOR.row });
    const ty = y + tableH - totalH;
    k.hline(x, x + tw, ty, { c: look.color, lw: 1.5 });
    k.text(totalLabel, x + u(14), ty + (totalH - u(13)) / 2, { f: 'Bold', s: u(13) });
    k.text(inrNumber(total), x + u(14), ty + (totalH - u(13)) / 2, { f: 'Bold', s: u(13), w: tw - u(28), align: 'right' });
  };
  table(L, 'Earnings', earn, 'Gross earnings', d.gross);
  table(L + tw + u(20), 'Deductions', ded, 'Total deductions', d.totalDeductions);
  y += tableH + u(18);

  // net pay
  const netH = u(92);
  k.box(L, y, CW, netH, { stroke: look.color, fill: '#f8fafc', lw: 1.5, r: 4.5 });
  const amountS = u(34); const amountW = k.width(rs(d.net), 'Serif', amountS);
  k.text(rs(d.net), R - u(18) - amountW, y + (netH - amountS * 1.2) / 2, { f: 'Serif', s: amountS, c: look.color });
  const leftW = CW - u(36) - amountW - u(16);
  k.text('NET PAY', L + u(18), y + u(14), { f: 'Bold', s: u(12), c: COLOR.soft, spacing: 1.1 });
  const wh = k.para(amountInWords(d.net), L + u(18), y + u(14) + u(12) * 1.4 + u(3), leftW, { s: u(13) });
  k.text(k.fit(d.paymentLine, 'Sans', u(12), leftW), L + u(18), y + u(14) + u(12) * 1.4 + u(3) + wh + u(3), { s: u(12), c: COLOR.soft });
  y += netH + u(18);

  // employer contributions and year to date
  const cells = [];
  if (d.employerPf != null) cells.push(['Employer PF contribution', rs(d.employerPf)]);
  else if (d.employerEsi != null) cells.push(['Employer ESI contribution', rs(d.employerEsi)]);
  cells.push([`Gross, ${d.ytdLabel}`, rs(d.ytdGross)], [`Net paid, ${d.ytdLabel}`, rs(d.ytdNet)]);
  const yh = u(58); k.box(L, y, CW, yh);
  cells.forEach(([lab, val], i) => {
    const cw = CW / cells.length; const x0 = L + i * cw + u(14);
    if (i) k.vline(L + i * cw, y, y + yh);
    k.text(lab, x0, y + u(10), { s: u(12), c: COLOR.muted }); k.text(val, x0, y + u(10) + u(12) * 1.4 + u(2), { f: 'Semi', s: u(13) });
  });

  // signatures and stamp, pinned above the footer
  const sy = footerTop - u(18) - sigBlock;
  const sw = u(220);
  signatureBlock(k, doc, { x: L, y: sy, w: sw, h: sigH, img: look.payslip.left, caption: look.payslip.leftCaption, sample, color: look.color });
  signatureBlock(k, doc, { x: R - sw, y: sy, w: sw, h: sigH, img: look.payslip.right, caption: look.payslip.rightCaption, align: 'right', sample, color: look.color });
  stampAt(k, doc, { cx: W / 2, cy: sy + sigBlock / 2 - u(4), size: u(118), img: look.payslip.stamp, sample, name: look.name });

  // footer
  k.hline(L, R, footerTop);
  const fy = footerTop + u(10);
  const gen = `Generated by Campusio · ${niceDate(d.generatedOn)}`;
  k.text(gen, L, fy, { s: u(12), c: COLOR.muted, w: CW, align: 'right' });
  if (look.payslip.note) k.text(k.fit('This is a computer-generated payslip. Report any discrepancy to the school office.', 'Sans', u(12), CW - k.width(gen, 'Sans', u(12)) - u(16)), L, fy, { s: u(12), c: COLOR.muted });
  if (sample) sampleMark(doc);
}
