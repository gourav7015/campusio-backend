import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';

const KNOWN_WEAK = new Set(['change-me-to-a-long-random-string', 'dev-only-secret-change-me', 'secret', 'changeme', 'test-only-secret']);
const supplied = process.env.JWT_SECRET;
if (isProd) {
  if (!supplied || supplied.length < 32 || KNOWN_WEAK.has(supplied)) throw new Error('JWT_SECRET must be a random string of at least 32 characters in production (for example: openssl rand -hex 48)');
  if (!process.env.CORS_ORIGIN || /localhost|127\.0\.0\.1|\*/.test(process.env.CORS_ORIGIN)) throw new Error('CORS_ORIGIN must list the real frontend origin(s) in production, not localhost or *');
}
// Outside production a missing secret is replaced by a random one for this process only (sessions end when it restarts), never by a published default.
const jwtSecret = supplied || (process.env.NODE_ENV === 'test' ? 'test-only-secret' : crypto.randomBytes(48).toString('hex'));

let version = '0.0.0';
try { version = JSON.parse(fs.readFileSync(path.resolve(here, '../../package.json'), 'utf8')).version; } catch { /* keep the default */ }
// A 32-byte key (64 hex characters) that encrypts what must not sit in the database in clear (two-factor secrets) and, when asked, uploaded files.
// Production needs one; elsewhere a missing key is derived from the JWT secret so development just works.
const suppliedKey = process.env.DATA_KEY || '';
if (suppliedKey && !/^[0-9a-fA-F]{64}$/.test(suppliedKey)) throw new Error('DATA_KEY must be 64 hex characters (for example: openssl rand -hex 32)');
// Without DATA_KEY the key is derived from JWT_SECRET: it works, but rotating JWT_SECRET would then make two-factor secrets unreadable. Production should set DATA_KEY (and keep a copy somewhere safe).
const dataKey = suppliedKey ? Buffer.from(suppliedKey, 'hex') : crypto.createHash('sha256').update(`data-key:${jwtSecret}`).digest();

export const config = {
  version,
  dataKey,
  dataKeyIsDerived: !suppliedKey,
  /** Encrypt newly uploaded files on disk (needs the same DATA_KEY forever). Off unless ENCRYPT_FILES=true. */
  encryptFiles: process.env.ENCRYPT_FILES === 'true',
  /** The key that was in use before a rotation: tokens signed with it keep working until they expire, so nobody is signed out. */
  jwtSecretPrevious: process.env.JWT_SECRET_PREVIOUS || '',
  /** A request that has not answered after this long is ended with a clear message (exports and PDFs get longer). */
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 60000),
  /** Where to post a short message when the server starts, fails repeatedly or is slow: a Slack, Discord or any "incoming webhook" address. */
  alertWebhook: process.env.ALERT_WEBHOOK_URL || '',
  /** Run pending database migrations when the server starts. */
  migrateOnStart: process.env.MIGRATE_ON_START !== 'false',
  env: process.env.NODE_ENV || 'development',
  isProd,
  port: Number(process.env.PORT || 4000),
  mongoUri: process.env.MONGO_URI || '',
  jwtSecret,
  jwtSecretIsEphemeral: !supplied && process.env.NODE_ENV !== 'test',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  sessionHours: Number(process.env.SESSION_HOURS || 12),
  /** A signed-in session can be renewed while it is younger than this, then the person signs in again. */
  sessionMaxDays: Number(process.env.SESSION_MAX_DAYS || 7),
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || (process.env.NODE_ENV === 'test' ? 4 : isProd ? 12 : 10)),
  uploadDir: process.env.UPLOAD_DIR || path.resolve(here, '../uploads'),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 10),
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(','),
  fileLinkTtlSeconds: Number(process.env.FILE_LINK_TTL || 300),
  loginRateLimit: Number(process.env.LOGIN_RATE_LIMIT || 20),
  apiRateLimit: Number(process.env.API_RATE_LIMIT || 600),
  /** Outgoing email. With no RESEND_API_KEY nothing is ever sent (the in-app notification still happens). */
  mail: {
    resendKey: process.env.RESEND_API_KEY || '',
    from: process.env.MAIL_FROM || '', // e.g. AtKaksha <noreply@mail.example.com>; the domain must be verified at Resend
    replyTo: process.env.MAIL_REPLY_TO || '', // where replies to notification emails go (the support inbox)
    supportTo: process.env.MAIL_SUPPORT_TO || process.env.MAIL_REPLY_TO || '', // who hears about new platform help desk tickets
    appUrl: (process.env.APP_URL || (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',')[0]).replace(/\/$/, ''),
    // which in-app notification categories are also emailed. A person can still switch email off (notificationPrefs.email = false) or one category off.
    categories: new Set((process.env.MAIL_CATEGORIES || 'system,approvals,leave,fees,announcements,results,examination,helpdesk').split(',').map((s) => s.trim()).filter(Boolean)),
    // Resend's free plan allows about 2 requests a second, so the queue sends one email at a time with a short gap.
    gapMs: Number(process.env.MAIL_GAP_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 600)),
  },
  /**
   * Online fee payments. provider 'mock' is a built-in test gateway that behaves like Razorpay (orders, signed results, webhooks) but moves no money;
   * 'razorpay' talks to the real thing; 'off' switches online payment off. The test gateway can never run in production by accident.
   */
  payments: {
    provider: (process.env.PAYMENT_PROVIDER || (process.env.NODE_ENV === 'production' ? 'off' : 'mock')).toLowerCase(),
    razorpay: { keyId: process.env.RAZORPAY_KEY_ID || '', keySecret: process.env.RAZORPAY_KEY_SECRET || '', webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '' },
    mockSecret: process.env.MOCK_PAYMENT_SECRET || 'mock-gateway-secret-not-for-production',
    orderMinutes: Number(process.env.PAYMENT_ORDER_MINUTES || 30), // an order nobody paid is closed after this long
    maxAmount: Number(process.env.PAYMENT_MAX_AMOUNT || 500000),
  },
};
if (!['mock', 'razorpay', 'off'].includes(config.payments.provider)) throw new Error('PAYMENT_PROVIDER must be mock, razorpay or off');
if (isProd && config.payments.provider === 'mock' && process.env.ALLOW_MOCK_PAYMENTS !== 'true') throw new Error('PAYMENT_PROVIDER=mock moves no real money and is not allowed in production (set razorpay or off)');
if (config.payments.provider === 'razorpay') {
  const z = config.payments.razorpay;
  if (!z.keyId || !z.keySecret || !z.webhookSecret) throw new Error('PAYMENT_PROVIDER=razorpay needs RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET');
}
if (isProd && config.mail.resendKey && !config.mail.from) throw new Error('MAIL_FROM must be set (a sender on your verified Resend domain) when RESEND_API_KEY is set');

/** The database is MongoDB Atlas (or any MongoDB) given by MONGO_URI. There is deliberately no silent fallback to a local database. */
export function requireMongoUri() {
  if (!config.mongoUri) throw new Error('MONGO_URI is not set. Copy .env.example to .env and paste your MongoDB Atlas connection string.');
  return config.mongoUri;
}
