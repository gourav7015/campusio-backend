import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { amountInWords, inrNumber } from '../src/services/documents/words.js';

const A = (p) => `/api/school${p}`;
// a real 1×1 PNG, so the PDF writer can place it
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const bin = (res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };

describe('Amounts in words and Indian digit grouping', () => {
  it('reads rupees the Indian way', () => {
    expect(amountInWords(12000)).toBe('Twelve thousand rupees only');
    expect(amountInWords(364000)).toBe('Three lakh sixty-four thousand rupees only');
    expect(amountInWords(1250.5)).toBe('One thousand two hundred fifty rupees and fifty paise only');
    expect(amountInWords(1)).toBe('One rupee only');
    expect(inrNumber(364000)).toBe('3,64,000.00');
  });
});

describe('Receipt and payslip documents: letterhead, stamp and signature set once, used on every PDF', () => {
  let root; let W;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'docs'); });
  afterAll(teardown);
  const pdf = (url, h) => api().get(url).set(h).buffer(true).parse(bin);

  it('starts with sensible defaults taken from the school itself', async () => {
    const r = (await api().get(A('/document-settings')).set(W.h)).body;
    expect(r.settings.color).toBe('#1e3a8a'); expect(r.assets).toEqual([]); expect(r.colors).toHaveLength(4);
    expect(r.settings.receipt.caption).toBe('Received by · Accounts Officer');
    expect(r.fallback.schoolName).toBeTruthy();
  });

  it('only the School Admin may change them', async () => {
    expect((await api().get(A('/document-settings')).set(W.teacher1.h)).status).toBe(403);
    expect((await api().put(A('/document-settings')).set(W.teacher1.h).send({ color: '#0f766e' })).status).toBe(403);
  });

  it('accepts a small PNG or JPG only, and the colour from the fixed four', async () => {
    const up = (buf, name, type, extra = {}) => api().post(A('/document-settings/assets')).set(W.h).field('kind', 'signature').field('name', extra.name ?? 'Principal signature').attach('file', buf, { filename: name, contentType: type });
    expect((await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'a.svg', 'image/svg+xml')).status).toBe(400);
    expect((await up(Buffer.from('RIFF....WEBPVP8 '), 'a.webp', 'image/webp')).status).toBe(400);
    expect((await up(Buffer.from('not a png at all'), 'a.png', 'image/png')).status).toBe(400); // content must match the type
    expect((await up(Buffer.concat([PNG, Buffer.alloc(1100 * 1024)]), 'big.png', 'image/png')).status).toBe(400); // over 1 MB
    expect((await api().put(A('/document-settings')).set(W.h).send({ color: '#123456' })).status).toBe(400);
    expect((await api().get(A('/document-settings')).set(W.h)).body.assets).toEqual([]);
  });

  it('uploads a signature and a stamp, assigns them per document, and the PDFs carry them', async () => {
    const add = async (kind, name) => (await api().post(A('/document-settings/assets')).set(W.h).field('kind', kind).field('name', name).attach('file', PNG, { filename: `${kind}.png`, contentType: 'image/png' }));
    const sig = await add('signature', 'Principal signature'); expect(sig.status).toBe(201);
    const stamp = await add('stamp', 'School seal'); expect(stamp.status).toBe(201);
    const assets = stamp.body.assets; const sigId = assets.find((x) => x.kind === 'signature').id; const stampId = assets.find((x) => x.kind === 'stamp').id;
    // the wrong kind in a slot is refused
    expect((await api().put(A('/document-settings')).set(W.h).send({ receipt: { signatureId: stampId } })).status).toBe(400);
    expect((await api().put(A('/document-settings')).set(W.h).send({ receipt: { stampId: sigId } })).status).toBe(400);
    const saved = await api().put(A('/document-settings')).set(W.h).send({
      color: '#0f766e', schoolName: 'Docs Public School', addressLine: '1 Main Road', contactLine: '+91 99999 00000',
      receipt: { signatureId: sigId, stampId, caption: 'Received by · Cashier' }, payslip: { leftSignatureId: sigId, rightSignatureId: sigId, stampId, rightCaption: 'Authorised signatory · Principal', note: false },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toMatchObject({ color: '#0f766e', schoolName: 'Docs Public School', receipt: { signatureId: sigId, stampId, caption: 'Received by · Cashier' } });
    expect(saved.body.assets.find((x) => x.id === sigId).usedOn).toEqual(['Fee receipt', 'Payslip']);

    // the sample previews use the school's own settings
    const sr = await pdf(A('/document-settings/sample/receipt'), W.h); const sp = await pdf(A('/document-settings/sample/payslip'), W.h);
    for (const r of [sr, sp]) { expect(r.status).toBe(200); expect(r.headers['content-type']).toBe('application/pdf'); expect(r.body.subarray(0, 4).toString()).toBe('%PDF'); expect(r.body.includes('/Subtype /Image')).toBe(true); }
    expect(sr.body.length).toBeGreaterThan(5000); expect(sp.body.length).toBeGreaterThan(5000);
    expect((await api().get(A('/document-settings/sample/receipt')).set(W.teacher1.h)).status).toBe(403);
  });

  it('Hindi text prints with the Devanagari font instead of empty boxes', async () => {
    await api().put(A('/document-settings')).set(W.h).send({ schoolName: 'दिल्ली पब्लिक स्कूल', addressLine: 'श्रीमती रोड, राजकोट' });
    const r = await pdf(A('/document-settings/sample/receipt'), W.h);
    expect(r.status).toBe(200); expect(r.body.includes('NotoSansDevanagari')).toBe(true);
    await api().put(A('/document-settings')).set(W.h).send({ schoolName: 'Docs Public School', addressLine: '1 Main Road' });
  });

  it('removing an image takes it off every document and deletes it', async () => {
    const cur = (await api().get(A('/document-settings')).set(W.h)).body;
    const sigId = cur.assets.find((x) => x.kind === 'signature').id;
    const del = await api().delete(A(`/document-settings/assets/${sigId}`)).set(W.h);
    expect(del.status).toBe(200);
    expect(del.body.assets.map((x) => x.kind)).toEqual(['stamp']);
    expect(del.body.settings.receipt.signatureId).toBeNull(); expect(del.body.settings.payslip.leftSignatureId).toBeNull();
    expect(del.body.settings.receipt.stampId).toBeTruthy(); // the stamp stays
    expect((await api().delete(A(`/document-settings/assets/${sigId}`)).set(W.h)).status).toBe(404);
  });

  it('a logo can be set and removed', async () => {
    const set = await api().post(A('/document-settings/logo')).set(W.h).attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(set.status).toBe(201); expect(set.body.settings.logoFileId).toBeTruthy();
    // its bytes are for the School Admin alone
    const link = await api().post(`/api/shared/files/${set.body.settings.logoFileId}/link`).set(W.h);
    expect(link.status).toBe(200);
    expect((await api().post(`/api/shared/files/${set.body.settings.logoFileId}/link`).set(W.teacher1.h)).status).toBeGreaterThanOrEqual(403);
    expect((await api().delete(A('/document-settings/logo')).set(W.h)).body.settings.logoFileId).toBeNull();
  });
});
