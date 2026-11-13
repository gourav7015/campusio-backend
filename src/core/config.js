import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';

if (isProd && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProd,
  port: Number(process.env.PORT || 4000),
  mongoUri: process.env.MONGO_URI || '',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  sessionHours: Number(process.env.SESSION_HOURS || 12),
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || (process.env.NODE_ENV === 'test' ? 4 : 10)),
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
