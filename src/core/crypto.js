import crypto from 'node:crypto';
import { config } from './config.js';

/** AES-256-GCM with the data key. Output `v1:<iv>:<tag>:<ciphertext>` (base64url), so the format can change later. */
export function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.dataKey, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}
export function open(sealed) {
  const [v, iv, tag, ct] = String(sealed || '').split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Not a sealed value');
  const d = crypto.createDecipheriv('aes-256-gcm', config.dataKey, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
/** Same for bytes (uploaded files): `[12 bytes iv][16 bytes tag][ciphertext]`. */
export function sealBytes(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.dataKey, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
export function openBytes(buf) {
  const d = crypto.createDecipheriv('aes-256-gcm', config.dataKey, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
