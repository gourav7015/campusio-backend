import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { parse } from '../core/utils.js';
import { recordClientError } from '../services/errorLog.js';
import { config } from '../core/config.js';
import { verifyToken } from '../core/tokens.js';

const body = z.object({ message: z.string().max(500), stack: z.string().max(4000).optional(), path: z.string().max(200).optional() });

/** The web app reports a crash it could not recover from. Open to anyone (a crash can happen before sign-in), so it is small, rate limited, and kept only 30 days. */
export const clientErrorRoutes = Router();
clientErrorRoutes.post('/', rateLimit({ windowMs: 60 * 1000, limit: 10, skip: () => config.env === 'test', standardHeaders: true, legacyHeaders: false, message: { error: 'Too many reports', code: 'RATE_LIMIT' } }), async (req, res) => {
  const b = parse(body, req.body);
  let userId; try { const h = req.headers.authorization || ''; if (h.startsWith('Bearer ')) userId = verifyToken(h.slice(7)).sub; } catch { /* not signed in */ }
  await recordClientError({ ...b, userAgent: req.headers['user-agent'], userId });
  res.status(202).json({ ok: true });
});
