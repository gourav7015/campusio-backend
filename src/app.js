import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import mongoose from 'mongoose';
import { config } from './core/config.js';
import { requestId, accessLog, errorHandler, notFoundHandler } from './core/http.js';
import { authenticate } from './middleware/auth.js';
import { rejectOperatorKeys, noStore } from './middleware/sanitize.js';
import rateLimit from 'express-rate-limit';
import { mountModules } from './modules/index.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.isProd ? 1 : false);
  app.use(requestId);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cors({ origin: config.corsOrigin, credentials: false, exposedHeaders: ['x-request-id', 'content-disposition'] }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', noStore, rejectOperatorKeys);
  app.use(accessLog);

  // liveness: process is up; readiness: database reachable
  app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
  app.get('/ready', (_req, res) => {
    const ok = mongoose.connection.readyState === 1;
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready' });
  });

  // Broad per-IP ceiling for the whole API (login has its own, stricter limiter).
  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: config.apiRateLimit, standardHeaders: true, legacyHeaders: false, skip: () => config.env === 'test', message: { error: 'Too many requests, slow down', code: 'RATE_LIMIT' } }));
  mountModules(app, authenticate);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
