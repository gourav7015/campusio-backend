import { Router } from 'express';
import * as svc from './files.service.js';
import { readFileBytes } from '../../services/files.js';

/** Authenticated: ask for a short-lived signed link. Never expose a guessable public path. */
export const linkRoutes = Router();
linkRoutes.post('/files/:id/link', async (req, res) => res.json(await svc.issueLink(req.user, req.tenantId, req.params.id)));

/** Public path, but only a valid signed token (issued after a permission check) opens it. */
export const downloadRoutes = Router();
downloadRoutes.get('/download/:id', async (req, res) => {
  const { file, path } = await svc.openByToken(req.params.id, String(req.query.token || ''));
  // Only PDFs and images may open in the browser; everything else downloads. The sandbox policy stops any active content from running even if a file were hostile.
  const inline = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(file.mime);
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.originalName || 'file')}"`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (file.enc) return res.send(await readFileBytes(file)); // stored encrypted: decrypt for this one answer
  res.sendFile(path);
});
