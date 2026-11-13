import { HttpError } from '../core/utils.js';

const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);

/** First offending key path in a parsed request value, or null. Query strings such as a[$ne]=1 and JSON bodies such as {"$gt":""} are the NoSQL-injection shapes. */
export function findOperatorKey(value, path = '', depth = 0) {
  if (!value || typeof value !== 'object' || depth > 20) return null;
  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || key.includes('[$') || BLOCKED.has(key)) return `${path}${key}`;
    const inner = findOperatorKey(value[key], `${path}${key}.`, depth + 1);
    if (inner) return inner;
  }
  return null;
}

/** Reject MongoDB operator keys and prototype-pollution keys anywhere in the body, query or route parameters, before any handler runs. */
export function rejectOperatorKeys(req, _res, next) {
  const hit = findOperatorKey(req.body, 'body.') || findOperatorKey(req.query, 'query.') || findOperatorKey(req.params, 'params.');
  if (hit) throw new HttpError(400, 'Request contains a forbidden field name', 'BAD_REQUEST', { field: hit });
  next();
}

/** Private data must never be cached by browsers or proxies. File downloads set their own, short-lived policy. */
export function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
