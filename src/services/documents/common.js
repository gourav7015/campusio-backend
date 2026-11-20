import { COLOR, u } from './kit.js';
import { drawSampleSignature, drawSampleStamp } from './look.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const niceDate = (s) => { if (!s) return '—'; const [y, m, d] = String(s).slice(0, 10).split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };
export const monthName = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** School name, address and contact on the left; the document's own title block on the right. Returns the y just below the rule. */
export function letterhead(k, doc, look, { y, left, right, logoPx, namePx, title, big, small, subPx = 12, extraLine }) {
  const L = left; const R = right; const size = u(logoPx);
  if (look.logo && k.image(look.logo, L, y, size, size, { align: 'left', valign: 'center' })) { /* drawn */ } else {
    doc.save().lineWidth(1.9).strokeColor(look.color).circle(L + size / 2, y + size / 2, size / 2 - 1).stroke().restore();
    k.text((look.name || 'S').trim().charAt(0).toUpperCase(), L, y + size * 0.2, { f: 'Serif', s: size * 0.5, c: look.color, w: size, align: 'center' });
  }
  const tx = L + size + u(logoPx > 60 ? 16 : 12);
  const rightW = Math.max(k.width(title, 'Bold', u(12), 1.3), k.width(big, 'Serif', u(namePx > 20 ? 24 : 17)), k.width(small, 'Sans', u(12))) + u(8);
  const maxW = R - tx - rightW - u(14);
  const nameS = u(namePx);
  let ty = y + u(2);
  k.text(k.fit(look.name, 'Serif', nameS, maxW), tx, ty, { f: 'Serif', s: nameS, c: look.color });
  ty += nameS * 1.25 + u(3);
  const lines = [look.addressLine, [extraLine, look.contactLine].filter(Boolean).join(' · ')].filter(Boolean);
  for (const ln of lines) { k.text(k.fit(ln, 'Sans', u(subPx), maxW), tx, ty, { s: u(subPx), c: COLOR.soft }); ty += u(subPx) * 1.4 + u(1); }
  // title block
  let ry = y;
  k.text(title, R - rightW, ry, { f: 'Bold', s: u(12), c: COLOR.soft, w: rightW, align: 'right', spacing: 1.3 }); ry += u(12) * 1.4 + u(2);
  const bigS = u(namePx > 20 ? 24 : 17);
  k.text(big, R - rightW, ry, { f: 'Serif', s: bigS, c: COLOR.ink, w: rightW, align: 'right' }); ry += bigS * 1.3 + u(2);
  k.text(small, R - rightW, ry, { s: u(12), c: COLOR.soft, w: rightW, align: 'right' });
  const bottom = y + Math.max(size, ty - y - u(2), ry - y + u(14)) + u(logoPx > 60 ? 16 : 12);
  doc.save().lineWidth(1.5).strokeColor(look.color).moveTo(L, bottom).lineTo(R, bottom).stroke().restore();
  return bottom;
}

/** A signature image (or, in a sample, a drawn one) sitting on a line, with "Role · Title" under it. `align` places the block left or right. */
export function signatureBlock(k, doc, { x, y, w, h, img, caption, align = 'left', sample, color }) {
  const imgY = y; const lineY = y + h + u(4);
  const drawn = img ? k.image(img, align === 'right' ? x : x + u(6), imgY, w - u(6), h, { align, valign: 'bottom' }) : false;
  if (!drawn && sample) drawSampleSignature(doc, align === 'right' ? x + w - u(130) : x + u(8), imgY + h * 0.2, u(120), h * 0.7, color || '#1e3a8a');
  k.hline(x, x + w, lineY, { c: COLOR.ink });
  const [role, ...rest] = String(caption || '').split(' · ');
  let ty = lineY + u(5);
  if (role) { k.text(role, x, ty, { f: 'Semi', s: u(13), w, align }); ty += u(13) * 1.4; }
  if (rest.length) k.text(rest.join(' · '), x, ty, { s: u(12), c: COLOR.soft, w, align });
}

export function stampAt(k, doc, { cx, cy, size, img, sample, name }) {
  const drawn = img ? k.image(img, cx - size / 2, cy - size / 2, size, size, { opacity: 0.92, rotate: -8 }) : false;
  if (!drawn && sample) drawSampleStamp(doc, cx, cy, size / 2 - 2, name);
}
