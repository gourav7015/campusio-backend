import crypto from 'node:crypto';
import { ZodError } from 'zod';
import { HttpError } from './utils.js';
import { logger } from './logger.js';
import { config } from './config.js';

export function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
}

export function accessLog(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    logger.info('http', {
      id: req.id, method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode,
      ms: Number((process.hrtime.bigint() - start) / 1000000n), user: req.user?._id && String(req.user._id), tenant: req.tenantId && String(req.tenantId),
    });
  });
  next();
}

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' });
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed', code: 'VALIDATION',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
  if (err?.code === 11000) return res.status(409).json({ error: 'A record with the same unique value already exists', code: 'DUPLICATE', details: { fields: Object.keys(err.keyPattern || err.keyValue || {}).filter((k) => k !== 'tenantId') } });
  if (err?.name === 'CastError') return res.status(400).json({ error: 'Invalid identifier', code: 'BAD_REQUEST' });
  if (err?.name === 'MulterError') return res.status(400).json({ error: err.message, code: 'UPLOAD' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON', code: 'BAD_REQUEST' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large', code: 'TOO_LARGE' });
  logger.error('unhandled', { id: req.id, path: req.originalUrl, error: err?.message, stack: config.isProd ? undefined : err?.stack });
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL', requestId: req.id });
}
