import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { DocumentSettings, File, School, SchoolProfile } from '../../models/index.js';
import { parse, notFound, bad } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import { upload, saveFile, removeFileBytes } from '../../services/files.js';
import { DOC_COLORS, DEFAULT_CAPTIONS } from '../../services/documents/look.js';
import { sampleReceipt, samplePayslip } from '../../services/documents/samples.js';

const MAX_IMAGE = 1024 * 1024;
const text = (n) => z.string().trim().max(n).optional();
const oid = z.string().regex(/^[a-f0-9]{24}$/i).or(z.literal('')).optional();
const body = z.object({
  schoolName: text(120), addressLine: text(200), affiliationNo: text(40), contactLine: text(120), color: z.enum(DOC_COLORS).optional(),
  receipt: z.object({ signatureId: oid, stampId: oid, caption: text(80), note: z.boolean().optional() }).optional(),
  payslip: z.object({ leftSignatureId: oid, rightSignatureId: oid, stampId: oid, leftCaption: text(80), rightCaption: text(80), note: z.boolean().optional() }).optional(),
});

/** PNG or JPEG, up to 1 MB: the formats the PDF writer can place. Anything else is deleted and refused. */
async function checkImage(file) {
  if (!file) throw bad('Choose an image');
  const ok = ['image/png', 'image/jpeg'].includes(file.mimetype) && file.size <= MAX_IMAGE;
  if (!ok) { await fs.promises.unlink(file.path).catch(() => {}); throw bad(file.size > MAX_IMAGE ? 'The image is larger than 1 MB' : 'Use a PNG or JPG image'); }
}
const dropFile = async (id) => { const f = id && await File.findById(id); if (f) { await removeFileBytes(f); await f.deleteOne(); } };
const settingsOf = async (tenantId) => DocumentSettings.findOneAndUpdate({ tenantId }, { $setOnInsert: { tenantId } }, { upsert: true, new: true });

async function view(tenantId) {
  const [s, school, profile] = await Promise.all([settingsOf(tenantId), School.findById(tenantId).select('name address phone email').lean(), SchoolProfile.findOne({ tenantId }).lean()]);
  const o = s.toObject();
  return {
    colors: DOC_COLORS, defaults: { receiptCaption: DEFAULT_CAPTIONS.receipt, payslipLeft: DEFAULT_CAPTIONS.payslipLeft, payslipRight: DEFAULT_CAPTIONS.payslipRight },
    // what the letterhead says when the fields are left empty
    fallback: { schoolName: school?.name || '', addressLine: profile?.address || school?.address || '', affiliationNo: profile?.affiliationNo || '', contactLine: [profile?.phone || school?.phone, profile?.email || school?.email].filter(Boolean).join(' · ') },
    settings: {
      schoolName: o.schoolName || '', addressLine: o.addressLine || '', affiliationNo: o.affiliationNo || '', contactLine: o.contactLine || '', color: DOC_COLORS.includes(o.color) ? o.color : DOC_COLORS[0], logoFileId: o.logoFileId || null,
      receipt: { signatureId: o.receipt?.signatureId || null, stampId: o.receipt?.stampId || null, caption: o.receipt?.caption ?? DEFAULT_CAPTIONS.receipt, note: o.receipt?.note !== false },
      payslip: { leftSignatureId: o.payslip?.leftSignatureId || null, rightSignatureId: o.payslip?.rightSignatureId || null, stampId: o.payslip?.stampId || null, leftCaption: o.payslip?.leftCaption ?? DEFAULT_CAPTIONS.payslipLeft, rightCaption: o.payslip?.rightCaption ?? DEFAULT_CAPTIONS.payslipRight, note: o.payslip?.note !== false },
    },
    assets: (o.assets || []).map((a) => ({ id: a._id, kind: a.kind, name: a.name, fileId: a.fileId, usedOn: [
      ...(String(o.receipt?.signatureId) === String(a._id) || String(o.receipt?.stampId) === String(a._id) ? ['Fee receipt'] : []),
      ...([o.payslip?.leftSignatureId, o.payslip?.rightSignatureId, o.payslip?.stampId].some((x) => String(x) === String(a._id)) ? ['Payslip'] : []),
    ] })),
  };
}

/** School Admin only. The letterhead, and the stamps and signatures that go on the fee receipt and the payslip. */
export const adminRoutes = Router();
const a = adminRoutes;
a.get('/document-settings', async (req, res) => res.json(await view(req.tenantId)));

a.put('/document-settings', async (req, res) => {
  const b = parse(body, req.body);
  const s = await settingsOf(req.tenantId);
  const own = (id, kind) => {
    if (!id) return undefined;
    const x = s.assets.id(id);
    if (!x || x.kind !== kind) throw bad(`Choose a ${kind} from the images you uploaded`);
    return x._id;
  };
  for (const k of ['schoolName', 'addressLine', 'affiliationNo', 'contactLine']) if (b[k] !== undefined) s[k] = b[k];
  if (b.color) s.color = b.color;
  if (b.receipt) {
    const r = b.receipt;
    s.receipt = { signatureId: r.signatureId !== undefined ? own(r.signatureId, 'signature') : s.receipt?.signatureId, stampId: r.stampId !== undefined ? own(r.stampId, 'stamp') : s.receipt?.stampId, caption: r.caption ?? s.receipt?.caption, note: r.note ?? s.receipt?.note ?? true };
  }
  if (b.payslip) {
    const p = b.payslip;
    s.payslip = {
      leftSignatureId: p.leftSignatureId !== undefined ? own(p.leftSignatureId, 'signature') : s.payslip?.leftSignatureId, rightSignatureId: p.rightSignatureId !== undefined ? own(p.rightSignatureId, 'signature') : s.payslip?.rightSignatureId,
      stampId: p.stampId !== undefined ? own(p.stampId, 'stamp') : s.payslip?.stampId, leftCaption: p.leftCaption ?? s.payslip?.leftCaption, rightCaption: p.rightCaption ?? s.payslip?.rightCaption, note: p.note ?? s.payslip?.note ?? true,
    };
  }
  await s.save();
  await audit(req, 'documents.settings_updated', 'DocumentSettings', s._id, 'Updated the letterhead and signatures on receipts and payslips');
  res.json(await view(req.tenantId));
});

a.post('/document-settings/logo', upload.single('file'), async (req, res) => {
  await checkImage(req.file);
  const f = await saveFile(req, req.file, { kind: 'document', ownerType: 'doc_asset', ownerId: req.tenantId, visibility: 'owner' });
  const s = await settingsOf(req.tenantId); const old = s.logoFileId; s.logoFileId = f._id; await s.save(); await dropFile(old);
  await audit(req, 'documents.logo_set', 'DocumentSettings', s._id, 'Uploaded the school logo for documents');
  res.status(201).json(await view(req.tenantId));
});
a.delete('/document-settings/logo', async (req, res) => {
  const s = await settingsOf(req.tenantId); const old = s.logoFileId; s.logoFileId = undefined; await s.save(); await dropFile(old);
  await audit(req, 'documents.logo_removed', 'DocumentSettings', s._id, 'Removed the school logo from documents');
  res.json(await view(req.tenantId));
});

a.post('/document-settings/assets', upload.single('file'), async (req, res) => {
  await checkImage(req.file);
  const { kind, name } = parse(z.object({ kind: z.enum(['stamp', 'signature']), name: z.string().trim().min(2).max(60) }), req.body);
  const s = await settingsOf(req.tenantId);
  if (s.assets.length >= 12) { await fs.promises.unlink(req.file.path).catch(() => {}); throw bad('You can keep up to 12 stamps and signatures. Remove one you no longer use.'); }
  const f = await saveFile(req, req.file, { kind: 'document', ownerType: 'doc_asset', ownerId: req.tenantId, visibility: 'owner' });
  s.assets.push({ kind, name, fileId: f._id }); await s.save();
  await audit(req, 'documents.asset_added', 'DocumentSettings', s._id, `Uploaded the ${kind} "${name}"`);
  res.status(201).json(await view(req.tenantId));
});
a.put('/document-settings/assets/:id', upload.single('file'), async (req, res) => {
  const s = await settingsOf(req.tenantId); const x = s.assets.id(req.params.id);
  if (!x) { if (req.file) await fs.promises.unlink(req.file.path).catch(() => {}); throw notFound('Image not found'); }
  const { name } = parse(z.object({ name: z.string().trim().min(2).max(60).optional() }), req.body);
  if (name) x.name = name;
  let old;
  if (req.file) { await checkImage(req.file); const f = await saveFile(req, req.file, { kind: 'document', ownerType: 'doc_asset', ownerId: req.tenantId, visibility: 'owner' }); old = x.fileId; x.fileId = f._id; }
  await s.save(); await dropFile(old);
  await audit(req, 'documents.asset_updated', 'DocumentSettings', s._id, `Updated the ${x.kind} "${x.name}"`);
  res.json(await view(req.tenantId));
});
a.delete('/document-settings/assets/:id', async (req, res) => {
  const s = await settingsOf(req.tenantId); const x = s.assets.id(req.params.id);
  if (!x) throw notFound('Image not found');
  const id = String(x._id); const fileId = x.fileId; const name = x.name;
  x.deleteOne();
  // anything that used it simply has none now
  for (const [grp, keys] of [['receipt', ['signatureId', 'stampId']], ['payslip', ['leftSignatureId', 'rightSignatureId', 'stampId']]]) for (const k of keys) if (String(s[grp]?.[k]) === id) s[grp][k] = undefined;
  await s.save(); await dropFile(fileId);
  await audit(req, 'documents.asset_removed', 'DocumentSettings', s._id, `Removed "${name}"`);
  res.json(await view(req.tenantId));
});

const pdf = (name) => (res) => { res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="${name}.pdf"`); };
a.get('/document-settings/sample/receipt', async (req, res) => { pdf('sample-fee-receipt')(res); await sampleReceipt(req.tenantId, res); });
a.get('/document-settings/sample/payslip', async (req, res) => { pdf('sample-payslip')(res); await samplePayslip(req.tenantId, res); });
