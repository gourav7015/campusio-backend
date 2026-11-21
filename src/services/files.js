import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import { config } from '../core/config.js';
import { verifyToken } from '../core/tokens.js';
import { sealBytes, openBytes } from '../core/crypto.js';
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

const startsWith = (b, sig, at = 0) => sig.every((x, i) => b[at + i] === x);
const SIGNATURES = {
  'application/pdf': (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46]),
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]),
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/webp': (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8),
  'application/msword': (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0]), 'application/vnd.ms-powerpoint': (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0]), 'application/vnd.ms-excel': (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0]),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
  'text/plain': (b) => !b.includes(0),
};

/** The browser says what a file is; the first bytes say what it really is. A file whose content does not match its declared type is deleted and refused. */
export async function assertContentMatches(file) {
  const fd = await fs.promises.open(file.path, 'r');
  try {
    const { buffer, bytesRead } = await fd.read(Buffer.alloc(4096), 0, 4096, 0);
    if (!SIGNATURES[file.mimetype]?.(buffer.subarray(0, bytesRead))) throw bad('The file content does not match its type');
  } catch (e) { await fs.promises.unlink(file.path).catch(() => {}); throw e; } finally { await fd.close(); }
}

/** Persist metadata for a multer file. Bytes stay on disk/object storage, never in Mongo documents. */
export async function saveFile(req, file, { kind, ownerType, ownerId, docType, visibility = 'owner', tenantId = req.tenantId }) {
  await assertContentMatches(file);
  // with ENCRYPT_FILES=true the bytes on disk are encrypted (the type was checked above, while they were still readable)
  const enc = config.encryptFiles;
  if (enc) await fs.promises.writeFile(file.path, sealBytes(await fs.promises.readFile(file.path)));
  return File.create({
    enc, tenantId, originalName: file.originalname, mime: file.mimetype, size: file.size, storageKey: file.filename,
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
  const p = verifyToken(token);
  if (p.p !== 'file') throw new Error('bad token');
  return p;
}

/** The file's bytes, decrypted when it was stored encrypted. */
export async function readFileBytes(f) {
  const raw = await fs.promises.readFile(filePath(f));
  return f.enc ? openBytes(raw) : raw;
}
