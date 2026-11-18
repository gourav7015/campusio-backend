import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

/**
 * Outgoing email. Emails are queued and sent one at a time in the background, so a request never waits for the mail provider and a
 * failure never breaks the action that caused the email. With no RESEND_API_KEY (and no test transport) nothing is sent.
 */
const MAX_TRIES = 3;
const queue = [];
let running = null;
let transport = null; // tests (or another provider) can replace this: async (msg) => ({ id })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

class RetryableError extends Error {}

async function resendTransport(msg) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.mail.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.mail.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text, ...(msg.replyTo ? { reply_to: msg.replyTo } : {}) }),
  });
  if (res.status === 429 || res.status >= 500) throw new RetryableError(`Resend ${res.status}`);
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json().catch(() => ({}));
}

/** For tests and for swapping in another provider. Pass null to go back to Resend. */
export function setMailTransport(fn) { transport = fn; }
export const isEmailEnabled = () => !!transport || (!!config.mail.resendKey && !!config.mail.from);

async function drain() {
  while (queue.length) {
    const item = queue.shift();
    try {
      await (transport || resendTransport)(item.msg);
      logger.info('email sent', { to: item.msg.to, subject: item.msg.subject });
    } catch (e) {
      item.tries += 1;
      if (e instanceof RetryableError && item.tries < MAX_TRIES) { queue.push(item); await sleep(Math.max(config.mail.gapMs, 1) * 2 * item.tries); } else logger.error('email failed', { to: item.msg.to, subject: item.msg.subject, error: e.message });
    }
    if (config.mail.gapMs) await sleep(config.mail.gapMs);
  }
}
function kick() {
  if (running) return;
  running = drain().finally(() => { running = null; if (queue.length) kick(); });
}

/** Queue an email. Returns false (and does nothing) when email is not set up or there is no address. */
export function enqueueEmail({ to, subject, html, text, replyTo }) {
  if (!isEmailEnabled() || !to || !/^\S+@\S+\.\S+$/.test(to)) return false;
  queue.push({ tries: 0, msg: { to, subject: String(subject).slice(0, 200), html, text, replyTo: replyTo || config.mail.replyTo || undefined } });
  kick();
  return true;
}
/** Wait until everything queued so far has been sent (used by tests and on shutdown). */
export async function flushEmails() { while (running) await running; }

/** A plain, readable email body in both HTML and text. */
export function renderEmail({ heading, lines = [], button, footer }) {
  const url = button?.url;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;padding:28px">
<tr><td><h1 style="margin:0 0 14px;font-size:20px;line-height:1.3">${escapeHtml(heading)}</h1>
${lines.map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;white-space:pre-wrap">${escapeHtml(l)}</p>`).join('')}
${url ? `<p style="margin:20px 0 4px"><a href="${escapeHtml(url)}" style="background:#2563eb;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:15px;display:inline-block">${escapeHtml(button.label || 'Open')}</a></p>` : ''}
${footer ? `<p style="margin:22px 0 0;font-size:12px;color:#6b7280">${escapeHtml(footer)}</p>` : ''}
</td></tr></table></td></tr></table></body></html>`;
  const text = [heading, '', ...lines, ...(url ? ['', `${button.label || 'Open'}: ${url}`] : []), ...(footer ? ['', footer] : [])].join('\n');
  return { html, text };
}

/** Convenience: build and queue a notification-style email in one call. */
export function sendNotificationEmail(to, { subject, heading, lines, button, footer, replyTo }) {
  const { html, text } = renderEmail({ heading: heading || subject, lines, button, footer });
  return enqueueEmail({ to, subject, html, text, replyTo });
}
