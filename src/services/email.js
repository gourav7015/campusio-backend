import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { EmailOutbox } from '../models/index.js';

/**
 * Outgoing email. Emails are queued and sent one at a time in the background, so a request never waits for the mail provider and a
 * failure never breaks the action that caused the email. With no RESEND_API_KEY (and no test transport) nothing is sent.
 */
const MAX_TRIES = 4;
let running = null;
const creating = new Set(); // inserts still in flight, so flushEmails can wait for them
let transport = null; // tests (or another provider) can replace this: async (msg) => ({ id })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

class RetryableError extends Error {}

async function resendTransport(msg) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.mail.resendKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ from: config.mail.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text, ...(msg.replyTo ? { reply_to: msg.replyTo } : {}), ...(msg.attachments?.length ? { attachments: msg.attachments.map((a) => ({ filename: a.filename, content: a.content })) } : {}) }),
  });
  if (res.status === 429 || res.status >= 500) throw new RetryableError(`Resend ${res.status}`);
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json().catch(() => ({}));
}

/** For tests and for swapping in another provider. Pass null to go back to Resend. */
export function setMailTransport(fn) { transport = fn; }
export const isEmailEnabled = () => !!transport || (!!config.mail.resendKey && !!config.mail.from);

/** The next email that is due (or whose sender died mid-send), claimed so that no other server takes it. */
function claimNext() {
  const now = new Date();
  return EmailOutbox.findOneAndUpdate(
    { $or: [{ status: 'pending', nextAt: { $lte: now } }, { status: 'processing', leaseUntil: { $lt: now } }] },
    { $set: { status: 'processing', leaseUntil: new Date(now.getTime() + 90 * 1000) }, $inc: { tries: 1 } },
    { sort: { nextAt: 1 }, new: true },
  );
}

async function drain() {
  for (let item = await claimNext(); item; item = await claimNext()) {
    const msg = { to: item.to, subject: item.subject, html: item.html, text: item.text, replyTo: item.replyTo, attachments: item.attachments };
    try {
      await (transport || resendTransport)(msg);
      await EmailOutbox.updateOne({ _id: item._id }, { $set: { status: 'sent', sentAt: new Date(), attachments: [] }, $unset: { leaseUntil: 1 } });
      logger.info('email sent', { to: item.to, subject: item.subject });
    } catch (e) {
      if (e instanceof RetryableError && item.tries < MAX_TRIES) {
        const wait = config.mail.gapMs ? Math.min(30000 * 2 ** (item.tries - 1), 15 * 60 * 1000) : 0; // 30 s, 1 min, 2 min…
        await EmailOutbox.updateOne({ _id: item._id }, { $set: { status: 'pending', nextAt: new Date(Date.now() + wait), lastError: e.message }, $unset: { leaseUntil: 1 } });
      } else {
        await EmailOutbox.updateOne({ _id: item._id }, { $set: { status: 'failed', lastError: e.message }, $unset: { leaseUntil: 1 } });
        logger.error('email failed', { to: item.to, subject: item.subject, error: e.message });
      }
    }
    if (config.mail.gapMs) await sleep(config.mail.gapMs);
  }
}
/** Start sending what is waiting (a no-op if a send loop is already running here). */
export function kick() {
  if (running || !isEmailEnabled()) return;
  running = drain().catch((e) => logger.warn('email loop failed', { error: e.message })).finally(() => { running = null; });
}

/** Queue an email in the database. Returns false (and does nothing) when email is not set up or there is no address. */
/** attachments: [{ filename, contentType, content }] with content as a Buffer (kept in the outbox as base64 until sent). */
export function enqueueEmail({ to, subject, html, text, replyTo, attachments }) {
  if (!isEmailEnabled() || !to || !/^\S+@\S+\.\S+$/.test(to)) return false;
  const p = EmailOutbox.create({ to, subject: String(subject).slice(0, 200), html, text, replyTo: replyTo || config.mail.replyTo || undefined, attachments: (attachments || []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content })) })
    .then(() => kick()).catch((e) => logger.warn('email could not be queued', { error: e.message }));
  creating.add(p); p.finally(() => creating.delete(p));
  return true;
}
/** Wait until everything queued so far has been sent (used by tests and on shutdown). */
export async function flushEmails() {
  while (creating.size || running) { await Promise.all([...creating]); if (running) await running; }
  // anything still due (for example after a retry) gets one more pass
  if (isEmailEnabled() && await EmailOutbox.exists({ status: 'pending', nextAt: { $lte: new Date() } })) { kick(); while (running) await running; }
}
/** Pick up anything left in the outbox by a restart or a retry, every few seconds. */
export function startEmailWorker(everyMs = 15000) { const t = setInterval(kick, everyMs); t.unref(); kick(); return () => clearInterval(t); }

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
export function sendNotificationEmail(to, { subject, heading, lines, button, footer, replyTo, attachments }) {
  const { html, text } = renderEmail({ heading: heading || subject, lines, button, footer });
  return enqueueEmail({ to, subject, html, text, replyTo, attachments });
}
