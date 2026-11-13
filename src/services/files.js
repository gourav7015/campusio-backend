import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import { config } from '../core/config.js';
import { File } from '../models/index.js';
import { bad } from '../core/utils.js';

fs.mkdirSync(config.uploadDir, { recursive: true });

const ALLOWED = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain',
]);

export const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.uploadDir),
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => (ALLOWED.has(file.mimetype) ? cb(null, true) : cb(bad(`File type ${file.mimetype} is not allowed`))),
});

/** Persist metadata for a multer file. Bytes stay on disk/object storage, never in Mongo documents. */
export async function saveFile(req, file, { kind, ownerType, ownerId, docType, visibility = 'owner' }) {
  return File.create({
    tenantId: req.tenantId, originalName: file.originalname, mime: file.mimetype, size: file.size, storageKey: file.filename,
    kind, ownerType, ownerId: ownerId ? String(ownerId) : undefined, docType, visibility, uploadedBy: req.user._id,
  });
}
export const filePath = (f) => path.join(config.uploadDir, path.basename(f.storageKey));
export async function removeFileBytes(f) {
  try { await fs.promises.unlink(filePath(f)); } catch { /* already gone */ }
}

export function signFileToken(fileId, userId) {
  return jwt.sign({ f: String(fileId), u: String(userId), p: 'file' }, config.jwtSecret, { expiresIn: config.fileLinkTtlSeconds });
}
export function verifyFileToken(token) {
  const p = jwt.verify(token, config.jwtSecret);
  if (p.p !== 'file') throw new Error('bad token');
  return p;
}
