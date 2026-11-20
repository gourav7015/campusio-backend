import { kit, u, COLOR } from './kit.js';
import { amountInWords, inrNumber } from './words.js';
import { letterhead, signatureBlock, stampAt, niceDate } from './common.js';
import { sampleMark } from './look.js';

/** The fee receipt, A5. A reversal prints the same way, in red, with the amounts negative. */
export function drawReceipt(doc, look, d, { sample = false } = {}) {
  const k = kit(doc, look.color);
  const W = doc.page.width; const H = doc.page.height; const L = u(32); const R = W - u(32); const CW = R - L;
  const reversal = d.kind === 'reversal'; const sign = reversal ? -1 : 1;
  const accent = reversal ? COLOR.red : look.color;
  let y = u(32);

  y = letterhead(k, doc, look, { y, left: L, right: R, logoPx: 56, namePx: 19, title: reversal ? 'PAYMENT REVERSAL' : 'FEE RECEIPT', big: d.receiptNo, small: niceDate(d.paidOn), extraLine: '' }) + u(14);

  // student
  const cells = [
    [['Student', d.student], ['Parent or guardian', d.guardian]],
    [['Admission no. · Class', [d.admissionNo, d.classLabel].filter(Boolean).join(' · ')], ['Academic year', d.yearName]],
  ];
  const cellH = u(36); const boxH = u(20) + cellH * 2 + u(6) - u(6);
  k.box(L, y, CW, boxH); k.vline(L + CW / 2, y, y + boxH);
  cells.forEach((col, ci) => col.forEach(([lab, val], i) => {
    const x0 = L + (ci ? CW / 2 : 0) + u(14); const ty = y + u(10) + i * (cellH + u(6));
    k.text(lab, x0, ty, { s: u(12), c: COLOR.muted }); k.text(k.fit(val || '—', 'Semi', u(13), CW / 2 - u(28)), x0, ty + u(12) * 1.4, { f: 'Semi', s: u(13) });
  }));
  y += boxH + u(14);

  // particulars
  const hasPeriod = d.allocations.some((a) => a.period);
  const n = Math.max(d.allocations.length, 1);
  const headH = u(30); const totalH = u(46);
  const footerTop = H - u(26) - u(12) - u(10);
  const sigH = u(52); const sigBlock = sigH + u(4) + u(36);
  const fixedBelow = u(14) + u(40) + u(14) + (d.showBalance ? u(54) + u(14) : 0) + sigBlock + u(14);
  const lineH = Math.max(u(20), Math.min(u(30), (footerTop - y - fixedBelow - headH - totalH) / n));
  const tableH = headH + lineH * n + totalH;
  k.box(L, y, CW, tableH);
  doc.save().roundedRect(L, y, CW, headH, 4.5).clip().rect(L, y, CW, headH).fill(COLOR.head).restore();
  k.hline(L, R, y + headH);
  const periodW = hasPeriod ? u(96) : 0; const amtW = u(92);
  const hy = y + (headH - u(12)) / 2;
  k.text('PARTICULARS', L + u(14), hy, { f: 'Bold', s: u(12), c: accent, spacing: 0.7 });
  if (hasPeriod) k.text('PERIOD', R - u(14) - amtW - u(10) - periodW, hy, { f: 'Bold', s: u(12), c: accent, spacing: 0.7 });
  k.text('AMOUNT (₹)', R - u(14) - amtW, hy, { f: 'Bold', s: u(12), c: accent, spacing: 0.7, w: amtW, align: 'right' });
  d.allocations.forEach((a, i) => {
    const ry = y + headH + i * lineH; const ty = ry + (lineH - u(13)) / 2;
    k.text(k.fit(a.label, 'Sans', u(13), CW - u(28) - amtW - periodW - u(20)), L + u(14), ty, { s: u(13) });
    if (hasPeriod) k.text(k.fit(a.period || '', 'Sans', u(13), periodW), R - u(14) - amtW - u(10) - periodW, ty, { s: u(13), c: COLOR.soft });
    k.text(`${sign < 0 ? '− ' : ''}${inrNumber(a.amount)}`, R - u(14) - amtW, ty, { s: u(13), w: amtW, align: 'right' });
    k.hline(L, R, ry + lineH, { c: COLOR.row });
  });
  const ty = y + tableH - totalH;
  k.hline(L, R, ty, { c: accent, lw: 1.5 });
  k.text(reversal ? 'Total reversed' : 'Total received', L + u(14), ty + (totalH - u(13)) / 2, { f: 'Bold', s: u(13) });
  k.text(`${reversal ? '− ' : ''}₹ ${inrNumber(d.total)}`, L + u(14), ty + (totalH - u(20)) / 2, { f: 'Serif', s: u(20), c: accent, w: CW - u(28), align: 'right' });
  y += tableH + u(14);

  // words, mode
  k.para(amountInWords(d.total), L, y, CW, { s: u(13) }); y += u(13) * 1.4 + u(3);
  k.text(k.fit(d.payLine, 'Sans', u(12), CW), L, y, { s: u(12), c: COLOR.soft }); y += u(12) * 1.4 + u(3);
  if (d.reversalReason) { y += u(2); k.text(k.fit(`${reversal ? 'Reason' : 'This receipt was reversed'}: ${d.reversalReason}`, 'Sans', u(12), CW), L, y, { s: u(12), c: COLOR.red }); y += u(12) * 1.4 + u(4); }
  y += u(8);

  // balance
  if (d.showBalance) {
    const bh = u(54); k.box(L, y, CW, bh); k.vline(L + CW / 2, y, y + bh);
    k.text(`Outstanding as on ${niceDate(d.balanceOn)}`, L + u(14), y + u(8), { s: u(12), c: COLOR.muted }); k.text(`₹ ${inrNumber(d.outstanding)}`, L + u(14), y + u(8) + u(12) * 1.4, { f: 'Semi', s: u(13) });
    const nx = L + CW / 2 + u(14);
    k.text(d.next ? `Next: ${k.fit(d.next.label, 'Sans', u(12), CW / 2 - u(60))}, due ${niceDate(d.next.dueDate)}` : 'Next due', nx, y + u(8), { s: u(12), c: COLOR.muted });
    k.text(d.next ? `₹ ${inrNumber(d.next.amount)}` : 'Nothing due', nx, y + u(8) + u(12) * 1.4, { f: 'Semi', s: u(13) });
  }

  // signature and stamp
  const sy = footerTop - u(14) - sigBlock;
  signatureBlock(k, doc, { x: L, y: sy, w: u(200), h: sigH, img: look.receipt.signature, caption: look.receipt.caption, sample, color: look.color });
  stampAt(k, doc, { cx: R - u(60), cy: sy + sigBlock / 2, size: u(104), img: look.receipt.stamp, sample, name: look.name });

  // footer
  k.hline(L, R, footerTop);
  const fy = footerTop + u(8);
  k.text(look.receipt.note ? 'This is a computer-generated receipt.' : '', L, fy, { s: u(12), c: COLOR.muted });
  k.text('Generated by Campusio', L, fy, { s: u(12), c: COLOR.muted, w: CW, align: 'right' });
  if (sample) sampleMark(doc);
}
