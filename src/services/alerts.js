import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const last = new Map(); // title → time of the last message, so one problem does not flood the channel

/** A short message to the alert webhook (Slack, Discord or any incoming-webhook address). Quiet when none is set; never throws. */
export async function alert(title, detail = '', { everyMs = 5 * 60 * 1000 } = {}) {
  if (!config.alertWebhook) return false;
  const now = Date.now();
  if (now - (last.get(title) || 0) < everyMs) return false;
  last.set(title, now);
  const text = `AtKaksha (${config.env}) — ${title}${detail ? `\n${String(detail).slice(0, 600)}` : ''}`;
  try {
    // "text" is understood by Slack, "content" by Discord
    const res = await fetch(config.alertWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(8000) });
    if (!res.ok) logger.warn('alert webhook refused', { status: res.status });
    return res.ok;
  } catch (e) { logger.warn('alert webhook failed', { error: e.message }); return false; }
}
