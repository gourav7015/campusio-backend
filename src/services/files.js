import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import { config } from '../core/config.js';
import { verifyToken } from '../core/tokens.js';
import { sealBytes, openBytes } from '../core/crypto.js';
import { File } from '../models/index.js';
import { bad } from '../core/utils.js';
import { Readable } from 'node:stream';
import { objectStoreEnabled, putObject, getObject, hasObject, deleteObject } from './objectStore.js';

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
  let bytes = await fs.promises.readFile(file.path);
  if (enc) bytes = sealBytes(bytes);
  // the bytes live in the object store (R2) when it is set up, else in the database (GridFS): never on this server's disk, so every server and every deploy sees the same files
  const where = await storeBytes(bytes, { name: file.originalname || file.filename, mime: file.mimetype, tenantId });
  await fs.promises.unlink(file.path).catch(() => {}); // the temporary upload
  return File.create({
    enc, ...where, tenantId,
    originalName: file.originalname, mime: file.mimetype, size: file.size, storageKey: file.filename,
    kind, ownerType, ownerId: ownerId ? String(ownerId) : undefined, docType, visibility, uploadedBy: req.user._id,
  });
}
export const filePath = (f) => path.join(config.uploadDir, path.basename(f.storageKey)); // only for files stored before GridFS (store: 'disk')

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'files' });
/** Writes bytes into GridFS and returns the new id. */
export function putBytes(buf, filename = 'file') {
  return new Promise((resolve, reject) => {
    const up = bucket().openUploadStream(String(filename).slice(0, 200));
    up.on('error', reject); up.on('finish', () => resolve(up.id));
    up.end(buf);
  });
}
/** Where new bytes go: R2 when it is configured, otherwise GridFS. Returns the fields to save on the File record. */
export async function storeBytes(bytes, { name = 'file', mime, tenantId } = {}) {
  if (!objectStoreEnabled()) return { store: 'gridfs', gridId: await putBytes(bytes, name) };
  const objectKey = `t/${tenantId || 'platform'}/${crypto.randomUUID()}`;
  await putObject(objectKey, bytes, mime);
  return { store: 'r2', objectKey };
}
const collect = (stream) => new Promise((resolve, reject) => { const c = []; stream.on('data', (d) => c.push(d)); stream.on('error', reject); stream.on('end', () => resolve(Buffer.concat(c))); });

export async function removeFileBytes(f) {
  try {
    if (f.store === 'r2' && f.objectKey) await deleteObject(f.objectKey);
    else if (f.store === 'gridfs' && f.gridId) await bucket().delete(f.gridId);
    else await fs.promises.unlink(filePath(f));
  } catch { /* already gone */ }
}
/** Is the stored content still there? */
export async function fileAvailable(f) {
  if (f.store === 'r2') return !!f.objectKey && hasObject(f.objectKey);
  if (f.store === 'gridfs') return !!f.gridId && (await mongoose.connection.db.collection('files.files').countDocuments({ _id: f.gridId }, { limit: 1 })) > 0;
  return fs.existsSync(filePath(f));
}
/** The file's bytes as they are stored (encrypted, if they were). */
export async function rawBytes(f) {
  if (f.store === 'r2') { const r = await getObject(f.objectKey); if (!r) throw new Error('File is no longer available'); return Buffer.from(await r.arrayBuffer()); }
  if (f.store === 'gridfs') return collect(bucket().openDownloadStream(f.gridId));
  return fs.promises.readFile(filePath(f));
}
/** The file's bytes, decrypted when it was stored encrypted. */
export async function readFileBytes(f) {
  const raw = await rawBytes(f);
  return f.enc ? openBytes(raw) : raw;
}
/** Sends the file's content as the answer to a request (headers are set by the caller). */
export async function sendStoredFile(res, f) {
  if (f.store === 'r2') {
    const r = await getObject(f.objectKey);
    if (!r) return res.status(404).json({ error: 'File is no longer available', code: 'NOT_FOUND' });
    if (f.enc) return res.send(openBytes(Buffer.from(await r.arrayBuffer())));
    const len = r.headers.get('content-length'); if (len) res.setHeader('Content-Length', len);
    const body = Readable.fromWeb(r.body);
    body.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'File is no longer available', code: 'NOT_FOUND' }); else res.destroy(); });
    return body.pipe(res);
  }
  if (f.enc || f.store !== 'gridfs') {
    if (!f.enc) return res.sendFile(filePath(f)); // an older file on this server's disk
    return res.send(await readFileBytes(f));
  }
  const stream = bucket().openDownloadStream(f.gridId);
  stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'File is no longer available', code: 'NOT_FOUND' }); else res.destroy(); });
  stream.pipe(res);
}

export function signFileToken(fileId, userId) {
  return jwt.sign({ f: String(fileId), u: String(userId), p: 'file' }, config.jwtSecret, { expiresIn: config.fileLinkTtlSeconds });
}
export function verifyFileToken(token) {
  const p = verifyToken(token);
  if (p.p !== 'file') throw new Error('bad token');
  return p;
}
