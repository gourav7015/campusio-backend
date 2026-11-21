import { School, SchoolProfile, DocumentSettings, File } from '../../models/index.js';
import { readFileBytes } from '../files.js';

export const DOC_COLORS = ['#1e3a8a', '#0f766e', '#9f1239', '#7c2d12'];
export const DEFAULT_CAPTIONS = { receipt: 'Received by · Accounts Officer', payslipLeft: 'Prepared by · Accounts Officer', payslipRight: 'Authorised signatory · Principal' };

const read = async (fileId) => {
  if (!fileId) return null;
  const f = await File.findById(fileId).lean();
  if (!f) return null;
  try { return await readFileBytes(f); } catch { return null; }
};

/**
 * Everything a printed document needs about the school: letterhead texts (the document settings, else the school's own details),
 * the document colour, the logo and the stamp or signature images each document is set to use.
 */
export async function loadLook(tenantId) {
  const [school, profile, set] = await Promise.all([School.findById(tenantId).lean(), SchoolProfile.findOne({ tenantId }).lean(), DocumentSettings.findOne({ tenantId }).lean()]);
  const s = set || {};
  const asset = (id) => (id ? (s.assets || []).find((a) => String(a._id) === String(id)) : null);
  const img = async (id) => read(asset(id)?.fileId);
  const contact = [profile?.phone || school?.phone, profile?.email || school?.email].filter(Boolean).join(' · ');
  const [logo, receiptSig, receiptStamp, payLeft, payRight, payStamp] = await Promise.all([
    read(s.logoFileId), img(s.receipt?.signatureId), img(s.receipt?.stampId), img(s.payslip?.leftSignatureId), img(s.payslip?.rightSignatureId), img(s.payslip?.stampId),
  ]);
  return {
    name: s.schoolName || school?.name || 'School', addressLine: s.addressLine || profile?.address || school?.address || '', affiliationNo: s.affiliationNo ?? profile?.affiliationNo ?? '',
    contactLine: s.contactLine || contact, color: DOC_COLORS.includes(s.color) ? s.color : DOC_COLORS[0], logo,
    receipt: { signature: receiptSig, stamp: receiptStamp, caption: s.receipt?.caption ?? DEFAULT_CAPTIONS.receipt, note: s.receipt?.note !== false },
    payslip: { left: payLeft, right: payRight, stamp: payStamp, leftCaption: s.payslip?.leftCaption ?? DEFAULT_CAPTIONS.payslipLeft, rightCaption: s.payslip?.rightCaption ?? DEFAULT_CAPTIONS.payslipRight, note: s.payslip?.note !== false },
  };
}

// ───────────── placeholder art, used only in sample previews so a school sees where its own stamp and signature will sit ─────────────
/** A hand-signed look drawn as a pen stroke. */
export function drawSampleSignature(doc, x, y, w, h, color = '#1e3a8a') {
  doc.save().lineWidth(1.4).lineCap('round').lineJoin('round').strokeColor(color);
  const sx = w / 120; const sy = h / 40;
  doc.moveTo(x + 4 * sx, y + 28 * sy).bezierCurveTo(x + 12 * sx, y + 2 * sy, x + 22 * sx, y + 2 * sy, x + 20 * sx, y + 20 * sy)
    .bezierCurveTo(x + 18 * sx, y + 34 * sy, x + 30 * sx, y + 8 * sy, x + 42 * sx, y + 22 * sy)
    .bezierCurveTo(x + 50 * sx, y + 32 * sy, x + 58 * sx, y + 10 * sy, x + 68 * sx, y + 20 * sy)
    .bezierCurveTo(x + 78 * sx, y + 30 * sy, x + 90 * sx, y + 12 * sy, x + 112 * sx, y + 18 * sy).stroke();
  doc.restore();
}
/** Text laid along the upper half of a circle, one letter at a time. */
function arcText(doc, str, cx, cy, radius, size) {
  doc.font('Helvetica-Bold').fontSize(size);
  const widths = [...str].map((ch) => doc.widthOfString(ch) + size * 0.08);
  const total = widths.reduce((n, w) => n + w, 0) / radius; // radians
  let a = -Math.PI / 2 - total / 2;
  [...str].forEach((ch, i) => {
    const mid = a + widths[i] / radius / 2; a += widths[i] / radius;
    doc.save().translate(cx + radius * Math.cos(mid), cy + radius * Math.sin(mid)).rotate((mid * 180) / Math.PI + 90).text(ch, -widths[i] / 2, -size / 2, { lineBreak: false }).restore();
  });
}
/** A round school seal with its name around the edge. */
export function drawSampleStamp(doc, cx, cy, r, name = 'SCHOOL SEAL', color = '#1e40af') {
  doc.save().opacity(0.85).rotate(-10, { origin: [cx, cy] }).strokeColor(color).fillColor(color);
  doc.lineWidth(r * 0.05).circle(cx, cy, r).stroke().lineWidth(r * 0.025).circle(cx, cy, r * 0.58).stroke();
  const n = 5; const R = r * 0.28; const pts = [];
  for (let i = 0; i < n * 2; i++) { const a = (Math.PI / n) * i - Math.PI / 2; const rr = i % 2 ? R * 0.45 : R; pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); }
  doc.lineWidth(r * 0.03).moveTo(...pts[0]); for (const p of pts.slice(1)) doc.lineTo(...p); doc.closePath().stroke();
  arcText(doc, String(name).toUpperCase().slice(0, 28), cx, cy, r * 0.79, r * 0.15);
  doc.restore();
}
/** A diagonal faint word, so nobody mistakes a sample for a real document. */
export function sampleMark(doc, word = 'SAMPLE') {
  const { width: w, height: h } = doc.page;
  doc.save().opacity(0.07).fillColor('#111827').font('Helvetica-Bold').fontSize(w * 0.2).rotate(-35, { origin: [w / 2, h / 2] });
  doc.text(word, 0, h / 2 - w * 0.1, { width: w, align: 'center', lineBreak: false }); doc.restore();
}
