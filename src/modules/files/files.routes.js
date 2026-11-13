import { Router } from 'express';
import * as svc from './files.service.js';

/** Authenticated: ask for a short-lived signed link. Never expose a guessable public path. */
export const linkRoutes = Router();
linkRoutes.post('/files/:id/link', async (req, res) => res.json(await svc.issueLink(req.user, req.tenantId, req.params.id)));

/** Public path, but only a valid signed token (issued after a permission check) opens it. */
export const downloadRoutes = Router();
downloadRoutes.get('/download/:id', async (req, res) => {
  const { file, path } = await svc.openByToken(req.params.id, String(req.query.token || ''));
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.originalName || 'file')}"`);
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(path);
});
