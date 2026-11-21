import { ErrorLog } from '../models/index.js';
import { logger } from '../core/logger.js';
import { alert } from './alerts.js';

const recent = []; // times of the latest server errors, to notice a burst

/** Keep a server error where the Platform Admin can see it, and say so on the alert channel if they come in a burst. Never throws. */
export async function recordServerError(req, err, status = 500) {
  try {
    await ErrorLog.create({
      source: 'server', requestId: req.id, method: req.method, path: String(req.originalUrl || '').split('?')[0].slice(0, 200), status,
      message: String(err?.message || err).slice(0, 500), stack: String(err?.stack || '').slice(0, 4000), tenantId: req.tenantId || null, userId: req.user?._id || null,
    });
  } catch (e) { logger.warn('error log failed', { error: e.message }); }
  const now = Date.now(); recent.push(now);
  while (recent.length && now - recent[0] > 5 * 60 * 1000) recent.shift();
  if (recent.length >= 5) alert('Several server errors in five minutes', `${recent.length} errors; the latest: ${req.method} ${req.originalUrl} — ${err?.message}`);
}

export async function recordClientError({ message, stack, path, userAgent, userId, tenantId }) {
  return ErrorLog.create({ source: 'client', message: String(message || 'Unknown error').slice(0, 500), stack: String(stack || '').slice(0, 4000), path: String(path || '').slice(0, 200), userAgent: String(userAgent || '').slice(0, 200), userId: userId || null, tenantId: tenantId || null });
}
