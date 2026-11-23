import crypto from 'node:crypto';
import { config } from './config.js';

/** AES-256-GCM with the data key, for uploaded files: `[12 bytes iv][16 bytes tag][ciphertext]`. */
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
