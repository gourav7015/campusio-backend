import { createRequire } from 'node:module';
import path from 'node:path';
import * as fontkit from 'fontkit';

const require = createRequire(import.meta.url);
const dir = (pkg) => path.join(path.dirname(require.resolve(`@fontsource/${pkg}/package.json`)), 'files');
const sans = dir('noto-sans'); const serif = dir('noto-serif'); const deva = dir('noto-sans-devanagari');
// Hindi (Devanagari) text uses its own font; the file for each weight of the latin text
const DEVA = { Sans: 400, Semi: 600, Bold: 700, Serif: 700 };
const devaFile = (w) => `${deva}/noto-sans-devanagari-devanagari-${w}-normal.woff`;
const isDeva = (ch) => /[\u0900-\u097F\u200C\u200D]/.test(ch);
const FILES = {
  Sans: [`${sans}/noto-sans-latin-400-normal.woff`, `${sans}/noto-sans-latin-ext-400-normal.woff`],
  Semi: [`${sans}/noto-sans-latin-600-normal.woff`, `${sans}/noto-sans-latin-ext-600-normal.woff`],
  Bold: [`${sans}/noto-sans-latin-700-normal.woff`, `${sans}/noto-sans-latin-ext-700-normal.woff`],
  Serif: [`${serif}/noto-serif-latin-700-normal.woff`, `${serif}/noto-serif-latin-ext-700-normal.woff`],
};
const latinFont = fontkit.openSync(FILES.Sans[0]);
const extFonts = Object.fromEntries(Object.entries(FILES).map(([n, [, e]]) => [n, fontkit.openSync(e)]));
const hasLatin = new Map();
const inLatin = (ch) => { if (!hasLatin.has(ch)) hasLatin.set(ch, latinFont.hasGlyphForCodePoint(ch.codePointAt(0))); return hasLatin.get(ch); };

/** pt per CSS pixel: the designs are drawn in px (A4 = 794 wide), the PDF is in points. */
export const u = (px) => px * 0.75;
export const COLOR = { ink: '#111827', muted: '#4b5563', soft: '#374151', line: '#d1d5db', row: '#e5e7eb', head: '#f1f5f9', red: '#b91c1c' };

/** Drawing helpers over a pdfkit document. Text is drawn in runs so that "₹" (only in the latin-ext Noto files) prints with the same look as the rest. */
export function kit(doc, accent) {
  // pdfkit keeps one font per internal name, and the latin and latin-ext Noto files share it: so the few glyphs only the ext file has ("₹") are drawn as outlines
  for (const [name, [a]] of Object.entries(FILES)) { doc.registerFont(name, a); doc.registerFont(`${name}~dev`, devaFile(DEVA[name])); }
  // a "run" is a stretch of text in one font: latin, Devanagari (Hindi), or the few glyphs ("₹") drawn from the latin-ext outlines
  const runs = (t) => { const out = []; for (const ch of String(t)) { const kind = isDeva(ch) ? 'dev' : inLatin(ch) ? 'latin' : 'ext'; const last = out[out.length - 1]; if (last && last.kind === kind) last.s += ch; else out.push({ s: ch, kind, ext: kind === 'ext' }); } return out; };
  const setFont = (f, s, kind) => doc.font(kind === 'dev' ? `${f}~dev` : f).fontSize(s);
  const extAdvance = (str, f, s, spacing) => { const x = extFonts[f]; return [...str].reduce((n, ch) => n + (x.glyphForCodePoint(ch.codePointAt(0)).advanceWidth * s) / x.unitsPerEm + spacing, 0); };
  const width = (t, f = 'Sans', s = 9.75, spacing = 0) => runs(t).reduce((n, r) => n + (r.ext ? extAdvance(r.s, f, s, spacing) : setFont(f, s, r.kind).widthOfString(r.s, { characterSpacing: spacing })), 0);
  /** One line of text. `w` + `align` place it inside a box; returns the width drawn. */
  const text = (t, x, y, { f = 'Sans', s = 9.75, c = COLOR.ink, w, align = 'left', spacing = 0 } = {}) => {
    const total = width(t, f, s, spacing);
    let xx = x; if (w && align === 'right') xx = x + w - total; else if (w && align === 'center') xx = x + (w - total) / 2;
    doc.fillColor(c);
    for (const r of runs(t)) {
      if (r.ext) {
        const x = extFonts[f]; const k = s / x.unitsPerEm;
        for (const ch of r.s) {
          const g = x.glyphForCodePoint(ch.codePointAt(0));
          doc.save().translate(xx, y + (x.ascent * k)).scale(k, -k).path(g.path.toSVG()).fill(c).restore();
          xx += g.advanceWidth * k + spacing;
        }
      } else { setFont(f, s, r.kind).text(r.s, xx, y, { lineBreak: false, characterSpacing: spacing }); xx += doc.widthOfString(r.s, { characterSpacing: spacing }); }
    }
    return total;
  };
  /** Cut a long text with "…" so it stays inside `max` points. */
  const fit = (t, f, s, max) => { let v = String(t ?? ''); if (width(v, f, s) <= max) return v; while (v.length > 1 && width(`${v}…`, f, s) > max) v = v.slice(0, -1); return `${v.trimEnd()}…`; };
  /** Wrapped paragraph (plain text, no "₹"); returns its height. */
  const para = (t, x, y, w, { f = 'Sans', s = 9.75, c = COLOR.ink, align = 'left', lineGap = 0 } = {}) => { doc.font(f).fontSize(s).fillColor(c); const h = doc.heightOfString(String(t), { width: w, lineGap }); doc.text(String(t), x, y, { width: w, align, lineGap }); return h; };
  const box = (x, y, w, h, { stroke = COLOR.line, fill, r = 4.5, lw = 0.75 } = {}) => { doc.save().lineWidth(lw).roundedRect(x, y, w, h, r); if (fill && stroke) doc.fillAndStroke(fill, stroke); else if (fill) doc.fill(fill); else doc.stroke(stroke); doc.restore(); };
  const hline = (x1, x2, y, { c = COLOR.line, lw = 0.75 } = {}) => doc.save().lineWidth(lw).strokeColor(c).moveTo(x1, y).lineTo(x2, y).stroke().restore();
  const vline = (x, y1, y2, { c = COLOR.line, lw = 0.75 } = {}) => doc.save().lineWidth(lw).strokeColor(c).moveTo(x, y1).lineTo(x, y2).stroke().restore();
  const image = (buf, x, y, w, h, { align = 'center', valign = 'center', opacity = 1, rotate = 0 } = {}) => {
    if (!buf) return false;
    try {
      doc.save(); if (opacity < 1) doc.opacity(opacity); if (rotate) doc.rotate(rotate, { origin: [x + w / 2, y + h / 2] });
      doc.image(buf, x, y, { fit: [w, h], align, valign }); doc.restore(); return true;
    } catch { doc.restore(); return false; }
  };
  return { text, width, fit, para, box, hline, vline, image, accent };
}
