import crypto from 'node:crypto';
import { IdempotencyRecord } from '../models/index.js';
import { HttpError } from '../core/utils.js';

const DAY = 24 * 3600 * 1000;
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

/**
 * A POST that carries an `Idempotency-Key` header is done once. Sent again with the same key (a double tap, a phone that retried after a
 * dropped connection) it gets the first answer back instead of doing the work twice. A key is tied to the signed-in token, the address and the
 * request body, so it cannot be used to replay someone else's request or a different one. Only successful answers are kept: a failed try can be retried.
 */
export async function idempotency(req, res, next) {
  const key = req.headers['idempotency-key'];
  if (req.method !== 'POST' || !key) return next();
  if (!/^[A-Za-z0-9_\-:.]{8,80}$/.test(String(key))) throw new HttpError(400, 'Idempotency-Key must be 8–80 letters, digits or - _ : .', 'BAD_REQUEST');
  if (/multipart/i.test(req.headers['content-type'] || '')) return next(); // file uploads are not replayed
  const who = sha(req.headers.authorization || req.ip || '');
  const path = req.originalUrl.split('?')[0].replace(/^\/api\/v1\//, '/api/');
  const scope = sha(`${who}|${path}|${key}`);
  const bodyHash = sha(JSON.stringify(req.body ?? {}));
  let rec;
  try { rec = await IdempotencyRecord.create({ scope, bodyHash, expiresAt: new Date(Date.now() + DAY) }); } catch (e) {
    if (e?.code !== 11000) throw e;
    const old = await IdempotencyRecord.findOne({ scope }).lean();
    if (!old) return next(); // expired a moment ago: treat as new
    if (old.bodyHash !== bodyHash) throw new HttpError(422, 'This Idempotency-Key was already used for a different request', 'IDEMPOTENCY_MISMATCH');
    if (old.state !== 'done') throw new HttpError(409, 'The same request is still being processed', 'IN_PROGRESS');
    res.setHeader('idempotent-replay', 'true');
    return res.status(old.status).json(old.response);
  }
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 400) IdempotencyRecord.updateOne({ _id: rec._id }, { $set: { state: 'done', status: res.statusCode, response: body } }).catch(() => {});
    else IdempotencyRecord.deleteOne({ _id: rec._id }).catch(() => {}); // a failure can be tried again
    return json(body);
  };
  res.on('close', () => { if (!res.writableEnded) IdempotencyRecord.deleteOne({ _id: rec._id, state: 'processing' }).catch(() => {}); });
  next();
}
