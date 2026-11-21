import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import mongoose from 'mongoose';
import { config } from './core/config.js';
import { requestId, accessLog, errorHandler, notFoundHandler, requestTimeout, apiVersionAlias } from './core/http.js';
import { authenticate } from './middleware/auth.js';
import { rejectOperatorKeys, noStore } from './middleware/sanitize.js';
import rateLimit from 'express-rate-limit';
import { idempotency } from './middleware/idempotency.js';
import { clientErrorRoutes } from './modules/client-errors.js';
import { mountModules } from './modules/index.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.isProd ? 1 : false);
  app.use(requestId);
  app.use(apiVersionAlias);
  app.use(requestTimeout(config.requestTimeoutMs));
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cors({ origin: config.corsOrigin, credentials: false, exposedHeaders: ['x-request-id', 'content-disposition'], maxAge: 86400 })); // maxAge: the browser remembers the permission check for a day, so it is not repeated before every call
  // the payment gateway's webhook is signed over the exact bytes it sent, so keep them for that one address
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { if (req.originalUrl.startsWith('/api/payments/webhook') || req.originalUrl.startsWith('/api/v1/payments/webhook')) req.rawBody = buf; } }));
  app.use('/api', noStore, rejectOperatorKeys, idempotency);
  app.use(accessLog);

  // liveness: process is up; readiness: database reachable
  app.get('/health', (_req, res) => {
    const m = process.memoryUsage();
    res.json({ status: 'ok', version: config.version, warnings: [...(config.isProd && config.dataKeyIsDerived ? ['DATA_KEY is not set: two-factor secrets are protected with a key derived from JWT_SECRET'] : [])], uptime: Math.round(process.uptime()), memoryMb: { rss: Math.round(m.rss / 1048576), heapUsed: Math.round(m.heapUsed / 1048576) } });
  });
  app.get('/ready', (_req, res) => {
    const ok = mongoose.connection.readyState === 1;
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready' });
  });

  // Broad per-IP ceiling for the whole API (login has its own, stricter limiter).
  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: config.apiRateLimit, standardHeaders: true, legacyHeaders: false, skip: () => config.env === 'test', message: { error: 'Too many requests, slow down', code: 'RATE_LIMIT' } }));
  app.use('/api/client-errors', clientErrorRoutes);
  mountModules(app, authenticate);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
