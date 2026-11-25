import { kit, u, COLOR } from './kit.js';
import { letterhead, signatureBlock, niceDate } from './common.js';
import { sampleMark } from './look.js';

const GREEN = '#047857';
const PASS_FILL = '#ecfdf5';
const FAIL_FILL = '#fef2f2';

/** "A+ 90–100 · A 80–89 …" from the school's own grading scale. */
export function scaleLine(scale = [], passPercentage) {
  const bands = [...scale].sort((a, b) => b.min - a.min);
  const parts = bands.map((b, i) => `${b.grade} ${b.min}${i === 0 ? '–100' : `–${bands[i - 1].min - 1}`}`);
  return `Grading: ${parts.join('  ·  ')}${passPercentage != null ? `   |   Pass mark ${passPercentage}%` : ''}`;
}

/**
 * The report card, A4. `look` = the school's letterhead and colour; `d` = what the card says (built in results.service from the published, immutable snapshot).
 * `sample` adds a faint SAMPLE mark.
 */
export function drawReportCard(doc, look, d, { sample = false } = {}) {
  const k = kit(doc, look.color);
  const W = doc.page.width; const H = doc.page.height; const L = u(48); const R = W - u(48); const CW = R - L;
  let y = u(44);

  y = letterhead(k, doc, look, {
    y, left: L, right: R, logoPx: 72, namePx: 20, title: 'REPORT CARD', big: d.examName,
    small: [d.yearName && `Academic year ${d.yearName}`, d.version > 1 && `Revised, version ${d.version}`].filter(Boolean).join(' · '),
    extraLine: look.affiliationNo ? `Affiliation No. ${look.affiliationNo}` : undefined,
  });
  y += u(18);

  // the student
  const val = (v) => (v === undefined || v === null || v === '' ? '—' : String(v));
  const left = [['Student name', d.name], ['Admission no.', d.admissionNo], ['Class and section', d.classLine], ['Roll no.', d.rollNo]];
  const right = [['Date of birth', d.dob ? niceDate(d.dob) : null], ['Parent / guardian', d.guardian], ['Attendance', d.attendanceLine], ['Issued on', niceDate(d.issuedOn)]];
  const rowH = u(25); const boxH = u(24) + rowH * 4 - u(7);
  k.box(L, y, CW, boxH);
  k.vline(L + CW / 2, y, y + boxH);
  [left, right].forEach((col, ci) => {
    const x0 = L + (ci ? CW / 2 : 0) + u(16); const colW = CW / 2 - u(32) - u(128);
    col.forEach(([lab, v], i) => { const ry = y + u(12) + i * rowH; k.text(lab, x0, ry, { s: u(13), c: COLOR.muted }); k.text(k.fit(val(v), 'Semi', u(13), colW), x0 + u(128), ry, { f: 'Semi', s: u(13) }); });
  });
  y += boxH + u(20);

  // below the marks table: the total, remarks and the grading scale; the signatures are pinned above the footer
  const footerTop = H - u(36) - u(22);
  const sigH = u(44); const sigBlock = sigH + u(4) + u(38);
  const totalH = u(60); const remarksH = u(96); const scaleH = u(22);
  const fixedBelow = u(14) + totalH + u(14) + remarksH + u(12) + scaleH + u(14) + sigBlock + u(14);
  const headH = u(34);
  const n = Math.max(d.subjects.length, 1);
  const avail = footerTop - y - fixedBelow - headH;
  const lineH = Math.max(u(24), Math.min(u(46), avail / n));
  const tableH = headH + lineH * n;

  // columns of the marks table
  const cols = [{ k: 'subject', w: 0.27 }, { k: 'fields', w: 0.31 }, { k: 'obtained', w: 0.12, align: 'right' }, { k: 'max', w: 0.1, align: 'right' }, { k: 'pct', w: 0.1, align: 'right' }, { k: 'grade', w: 0.1, align: 'center' }];
  let cx = L; const colX = cols.map((c) => { const x = cx; cx += CW * c.w; return { ...c, x, w: CW * c.w }; });
  const pad = u(12);
  k.box(L, y, CW, tableH);
  doc.save().roundedRect(L, y, CW, headH, 4.5).clip().rect(L, y, CW, headH).fill(COLOR.head).restore();
  k.hline(L, R, y + headH);
  const heads = { subject: 'SUBJECT', fields: 'MARKS BY FIELD', obtained: 'OBTAINED', max: 'OUT OF', pct: 'PERCENT', grade: 'GRADE' };
  for (const c of colX) k.text(heads[c.k], c.x + pad, y + (headH - u(12)) / 2, { f: 'Bold', s: u(11.5), c: look.color, spacing: 0.8, w: c.w - pad * 2, align: c.align || 'left' });
  d.subjects.forEach((r, i) => {
    const ry = y + headH + i * lineH;
    const two = lineH >= u(34) && r.remarks;
    const ty = ry + (lineH - u(13.5)) / 2 - (two ? u(6) : 0);
    const failed = !r.passed && !r.exempt;
    const fields = r.absent ? 'Absent' : r.exempt ? 'Exempt' : (r.components || []).map((c) => `${c.label} ${c.value ?? '–'}/${c.max}`).join('  ·  ');
    const cell = {
      subject: [r.subject, 'Semi', COLOR.ink], fields: [fields, 'Sans', r.absent ? COLOR.red : COLOR.soft],
      obtained: [r.absent ? 'Absent' : r.exempt ? 'Exempt' : r.obtained ?? '–', 'Semi', r.absent ? COLOR.red : COLOR.ink], max: [r.exempt ? '–' : r.max, 'Sans', COLOR.soft],
      pct: [r.percentage != null ? `${r.percentage}%` : '–', 'Sans', COLOR.soft], grade: [r.grade || '–', 'Bold', failed ? COLOR.red : look.color],
    };
    for (const c of colX) { const [t, f, col] = cell[c.k]; k.text(k.fit(t, f, u(13.5), c.w - pad * 2), c.x + pad, ty, { f, s: u(c.k === 'fields' ? 12.5 : 13.5), c: col, w: c.w - pad * 2, align: c.align || 'left' }); }
    if (two) k.text(k.fit(`“${r.remarks}”`, 'Sans', u(11.5), colX[0].w + colX[1].w - pad * 2), colX[0].x + pad, ty + u(17), { s: u(11.5), c: COLOR.muted });
    if (i < d.subjects.length - 1) k.hline(L, R, ry + lineH, { c: COLOR.row });
  });
  y += tableH + u(14);

  // total, result and rank
  k.box(L, y, CW, totalH, { stroke: look.color, fill: '#f8fafc', lw: 1.5 });
  const third = CW * 0.34;
  k.text('TOTAL MARKS', L + u(18), y + u(10), { f: 'Bold', s: u(11.5), c: COLOR.soft, spacing: 1 });
  k.text(`${d.totalObtained} / ${d.totalMax}`, L + u(18), y + u(10) + u(11.5) * 1.5, { f: 'Serif', s: u(22), c: look.color });
  k.vline(L + third, y + u(10), y + totalH - u(10));
  k.text('PERCENTAGE AND GRADE', L + third + u(18), y + u(10), { f: 'Bold', s: u(11.5), c: COLOR.soft, spacing: 1 });
  k.text(`${d.percentage ?? '–'}%   ${d.grade ?? ''}`, L + third + u(18), y + u(10) + u(11.5) * 1.5, { f: 'Serif', s: u(22), c: look.color });
  k.vline(L + third * 2 - u(4), y + u(10), y + totalH - u(10));
  const pass = d.resultStatus === 'pass';
  const rx = L + third * 2 + u(14); const rw = R - rx - u(16);
  k.box(rx, y + u(11), u(82), totalH - u(22), { stroke: pass ? GREEN : COLOR.red, fill: pass ? PASS_FILL : FAIL_FILL, lw: 1.2, r: 4.5 });
  k.text(pass ? 'PASS' : 'FAIL', rx, y + (totalH - u(15)) / 2, { f: 'Bold', s: u(15), c: pass ? GREEN : COLOR.red, w: u(82), align: 'center', spacing: 1.2 });
  if (d.rank) {
    k.text('RANK IN CLASS', rx + u(98), y + u(10), { f: 'Bold', s: u(11.5), c: COLOR.soft, spacing: 1 });
    k.text(k.fit(`${d.rank} of ${d.outOf}`, 'Serif', u(20), rw - u(98)), rx + u(98), y + u(10) + u(11.5) * 1.5, { f: 'Serif', s: u(20), c: look.color });
  }
  y += totalH + u(14);

  // remarks
  const gap = u(14); const bw = (CW - gap) / 2;
  [['CLASS TEACHER\'S REMARKS', d.teacherRemark], ['PRINCIPAL\'S REMARKS', d.principalRemark]].forEach(([title, text], i) => {
    const x = L + i * (bw + gap);
    k.box(x, y, bw, remarksH);
    k.text(title, x + u(14), y + u(10), { f: 'Bold', s: u(11), c: COLOR.soft, spacing: 1 });
    if (text) k.para(String(text).slice(0, 240), x + u(14), y + u(10) + u(11) * 1.6 + u(2), bw - u(28), { s: u(12.5), lineGap: 1 });
    else { for (let l = 0; l < 2; l++) k.hline(x + u(14), x + bw - u(14), y + remarksH - u(36) + l * u(18), { c: COLOR.row }); }
  });
  y += remarksH + u(12);
  k.text(k.fit(scaleLine(d.scale, d.passPercentage), 'Sans', u(11.5), CW), L, y, { s: u(11.5), c: COLOR.muted });

  // signatures, pinned above the footer
  const sy = footerTop - u(14) - sigBlock; const sw = u(190);
  signatureBlock(k, doc, { x: L, y: sy, w: sw, h: sigH, caption: 'Class teacher', color: look.color });
  signatureBlock(k, doc, { x: L + (CW - sw) / 2, y: sy, w: sw, h: sigH, caption: 'Parent / guardian', align: 'left', color: look.color });
  signatureBlock(k, doc, { x: R - sw, y: sy, w: sw, h: sigH, caption: 'Principal', align: 'right', color: look.color });

  // footer
  k.hline(L, R, footerTop);
  const fy = footerTop + u(9);
  const gen = `Generated by AtKaksha · ${niceDate(d.generatedOn)}`;
  k.text(gen, L, fy, { s: u(11.5), c: COLOR.muted, w: CW, align: 'right' });
  const note = d.version > 1 && d.correctionReason ? `Revised: ${d.correctionReason}` : 'This is a computer-generated report card, valid with the school\'s signature and stamp.';
  k.text(k.fit(note, 'Sans', u(11.5), CW - k.width(gen, 'Sans', u(11.5)) - u(16)), L, fy, { s: u(11.5), c: COLOR.muted });
  if (sample) sampleMark(doc);
}
