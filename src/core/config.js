import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
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

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProd,
  port: Number(process.env.PORT || 4000),
  mongoUri: process.env.MONGO_URI || '',
  jwtSecret,
  jwtSecretIsEphemeral: !supplied && process.env.NODE_ENV !== 'test',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  sessionHours: Number(process.env.SESSION_HOURS || 12),
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || (process.env.NODE_ENV === 'test' ? 4 : isProd ? 12 : 10)),
  uploadDir: process.env.UPLOAD_DIR || path.resolve(here, '../uploads'),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 10),
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(','),
  fileLinkTtlSeconds: Number(process.env.FILE_LINK_TTL || 300),
  loginRateLimit: Number(process.env.LOGIN_RATE_LIMIT || 20),
  apiRateLimit: Number(process.env.API_RATE_LIMIT || 600),
};

/** The database is MongoDB Atlas (or any MongoDB) given by MONGO_URI. There is deliberately no silent fallback to a local database. */
export function requireMongoUri() {
  if (!config.mongoUri) throw new Error('MONGO_URI is not set. Copy .env.example to .env and paste your MongoDB Atlas connection string.');
  return config.mongoUri;
}
