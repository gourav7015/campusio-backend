import { Router } from 'express';
import * as svc from './files.service.js';
import { sendStoredFile } from '../../services/files.js';

/** Authenticated: ask for a short-lived signed link. Never expose a guessable public path. */
export const linkRoutes = Router();
linkRoutes.post('/files/:id/link', async (req, res) => res.json(await svc.issueLink(req.user, req.tenantId, req.params.id)));

/** Public path, but only a valid signed token (issued after a permission check) opens it. */
export const downloadRoutes = Router();
downloadRoutes.get('/download/:id', async (req, res) => {
  const { file } = await svc.openByToken(req.params.id, String(req.query.token || ''));
  // Only PDFs and images may open in the browser; everything else downloads. The sandbox policy stops any active content from running even if a file were hostile.
  const inline = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mime);
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.originalName || 'file')}"`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // The site and the API sit on different addresses (atkaksha.com and the API host), so the browser treats the API as another site and would refuse to show a picture it serves under the
  // default "same-site" rule. This answer is only ever reached with a short-lived signed link issued after the permission check, so it may be shown on the site that asked for it.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  await sendStoredFile(res, file);
});
