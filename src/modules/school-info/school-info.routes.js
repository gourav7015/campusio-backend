import { Router } from 'express';
import { z } from 'zod';
import { SchoolProfile, License, File, School } from '../../models/index.js';
import { parse, notFound, isDateStr } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import { upload, saveFile } from '../../services/files.js';
import { removeFileBytes } from '../../services/files.js';

const text = (n) => z.string().trim().max(n).optional();
const date = z.string().refine(isDateStr, 'Use YYYY-MM-DD');
const profileBody = z.object({
  tagline: text(160), about: text(4000), address: text(300), phone: text(30), email: z.string().trim().email().or(z.literal('')).optional(), website: text(120), board: text(60), affiliationNo: text(40), established: text(10),
  principalName: text(80), principalMessage: text(2000), sections: z.array(z.object({ title: z.string().trim().min(2).max(80), body: text(2000) })).max(20).optional(),
});
const licenseBody = z.object({
  name: z.string().trim().min(2).max(120), authority: z.enum(['state', 'central', 'local', 'other']).default('state'), issuedBy: text(120), number: text(60),
  issuedOn: date.optional().or(z.literal('')), validUntil: date.optional().or(z.literal('')), notes: text(300),
});

/** What every person at the school may read: the school's own page, its gallery and the licences and approvals it holds. Never the tax and bank details. */
export const readRoutes = Router();
readRoutes.get('/school-info', async (req, res) => {
  const [school, p, licenses] = await Promise.all([School.findById(req.tenantId).select('name code'), SchoolProfile.findOne({ tenantId: req.tenantId }).lean(), License.find({ tenantId: req.tenantId }).sort({ authority: 1, name: 1 }).lean()]);
  const { finance: _hidden, ...profile } = p || {};
  const today = req.ctx?.today || new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);
  res.json({
    name: school?.name, code: school?.code, profile: { sections: [], gallery: [], ...profile },
    licenses: licenses.map((l) => ({ ...l, state: !l.validUntil ? 'no_expiry' : l.validUntil < today ? 'expired' : l.validUntil <= soon ? 'expiring' : 'valid' })),
  });
});

/** School Admin only. */
export const adminRoutes = Router();
const a = adminRoutes;
a.put('/school-info', async (req, res) => {
  const b = parse(profileBody, req.body);
  const p = await SchoolProfile.findOneAndUpdate({ tenantId: req.tenantId }, { $set: b }, { upsert: true, new: true });
  await audit(req, 'school.info_updated', 'SchoolProfile', p._id, 'Updated the school information page');
  res.json({ ok: true });
});
a.post('/school-info/gallery', upload.single('file'), async (req, res) => {
  if (!req.file || !/^image\//.test(req.file.mimetype)) return res.status(400).json({ error: 'Upload an image', code: 'BAD_REQUEST' });
  const caption = parse(z.object({ caption: text(120) }), req.body).caption;
  const f = await saveFile(req, req.file, { kind: 'photo', ownerType: 'school', ownerId: req.tenantId, visibility: 'school' });
  const p = await SchoolProfile.findOneAndUpdate({ tenantId: req.tenantId }, { $push: { gallery: { fileId: f._id, caption } } }, { upsert: true, new: true });
  await audit(req, 'school.gallery_added', 'SchoolProfile', p._id, 'Added a gallery picture');
  res.status(201).json(p.gallery[p.gallery.length - 1]);
});
a.delete('/school-info/gallery/:itemId', async (req, res) => {
  const p = await SchoolProfile.findOne({ tenantId: req.tenantId });
  const item = p?.gallery.id(req.params.itemId);
  if (!item) throw notFound('Picture not found');
  const f = await File.findById(item.fileId);
  item.deleteOne(); await p.save();
  if (f) { await removeFileBytes(f); await f.deleteOne(); }
  await audit(req, 'school.gallery_removed', 'SchoolProfile', p._id, 'Removed a gallery picture');
  res.json({ ok: true });
});

a.get('/licenses', async (req, res) => res.json(await License.find({ tenantId: req.tenantId }).sort({ authority: 1, name: 1 }).lean()));
a.post('/licenses', async (req, res) => { const l = await License.create({ ...parse(licenseBody, req.body), tenantId: req.tenantId }); await audit(req, 'license.added', 'License', l._id, `Added licence ${l.name}`); res.status(201).json(l); });
a.patch('/licenses/:id', async (req, res) => {
  const l = await License.findOneAndUpdate({ _id: req.params.id, tenantId: req.tenantId }, { $set: parse(licenseBody.partial(), req.body) }, { new: true });
  if (!l) throw notFound('Licence not found');
  await audit(req, 'license.updated', 'License', l._id, `Updated licence ${l.name}`); res.json(l);
});
a.delete('/licenses/:id', async (req, res) => {
  const l = await License.findOneAndDelete({ _id: req.params.id, tenantId: req.tenantId });
  if (!l) throw notFound('Licence not found');
  if (l.fileId) { const f = await File.findById(l.fileId); if (f) { await removeFileBytes(f); await f.deleteOne(); } }
  await audit(req, 'license.deleted', 'License', l._id, `Deleted licence ${l.name}`); res.json({ ok: true });
});
a.post('/licenses/:id/file', upload.single('file'), async (req, res) => {
  const l = await License.findOne({ _id: req.params.id, tenantId: req.tenantId });
  if (!l) throw notFound('Licence not found');
  if (!req.file) return res.status(400).json({ error: 'No file uploaded', code: 'BAD_REQUEST' });
  const f = await saveFile(req, req.file, { kind: 'document', ownerType: 'license', ownerId: l._id, docType: 'licence', visibility: 'school' });
  const old = l.fileId; l.fileId = f._id; await l.save();
  if (old) { const of = await File.findById(old); if (of) { await removeFileBytes(of); await of.deleteOne(); } }
  res.json({ id: f._id });
});
