import crypto from 'node:crypto';
import QRCode from 'qrcode-svg';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

export function base32(buf) {
  let bits = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = ''; for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
export function fromBase32(s) {
  let bits = ''; for (const ch of String(s).toUpperCase().replace(/=+$/, '')) { const i = ALPHABET.indexOf(ch); if (i < 0) throw new Error('Bad base32'); bits += i.toString(2).padStart(5, '0'); }
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
export const newSecret = () => base32(crypto.randomBytes(20));

/** RFC 4226 one-time code for a counter. */
export function hotp(secretB32, counter, digits = 6) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', fromBase32(secretB32)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}
export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);
export const totp = (secretB32, ms = Date.now()) => hotp(secretB32, stepAt(ms));

/** Returns the time step the code belongs to (one step either side is accepted for clock drift), or null. `lastStep` stops a code being used twice. */
export function verifyTotp(secretB32, code, { lastStep = 0, ms = Date.now() } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = stepAt(ms);
  for (const s of [now, now - 1, now + 1]) {
    if (s <= lastStep) continue;
    const want = hotp(secretB32, s);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(c))) return s;
  }
  return null;
}

export const otpauthUri = (secret, account) => `otpauth://totp/${encodeURIComponent(`Campusio:${account}`)}?secret=${secret}&issuer=Campusio&algorithm=SHA1&digits=6&period=${STEP}`;
export const qrSvg = (text) => new QRCode({ content: text, padding: 2, width: 200, height: 200, join: true, container: 'svg-viewbox' }).svg();

/** Ten one-time recovery codes, shown once; only their hashes are kept. */
export function newRecoveryCodes() {
  return Array.from({ length: 10 }, () => { const r = base32(crypto.randomBytes(7)).slice(0, 10).toLowerCase(); return `${r.slice(0, 5)}-${r.slice(5)}`; });
}
