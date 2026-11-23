import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, login, makeSuperAdmin, seedWorld } from './helpers.js';
import { Bus, BusDocument, Notification, File } from '../src/models/index.js';
import { busDocumentReminders } from '../src/modules/transport/transport.service.js';
import { runMigrations } from '../src/core/migrations.js';
import { addDays } from '../src/core/utils.js';
import { fileURLToPath } from 'node:url';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
const bin = (res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };

describe('Transport: vehicle documents (registration, insurance, pollution, fitness, permit, road tax) with copies and expiry reminders', () => {
  let root; let W; let tr; let bus; let today;
  const T = (p) => `/api/transport${p}`;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'veh');
    const c = await api().post('/api/school/staff').set(W.h).send({ name: 'Tara Transport', email: 'tara@veh.test', role: 'transport', phone: '9833333333', dob: '1984-04-04' });
    tr = await login(c.body.loginId, c.body.temporaryPassword, 'transport');
    bus = (await api().post(T('/buses')).set(tr.h).send({ busNo: 'V-01', registrationNo: 'GJ03AB1234', capacity: 40 })).body;
    today = (await api().get(T('/dashboard')).set(tr.h)).body && new Date().toLocaleDateString('en-CA');
  });
  afterAll(teardown);
  const put = (type, fields, file) => { let r = api().put(T(`/buses/${bus._id}/documents/${type}`)).set(tr.h); for (const [k, v] of Object.entries(fields)) r = r.field(k, v); if (file) r = r.attach('file', file.buf, { filename: file.name, contentType: file.type }); return r; };

  it('lists every standard document, "missing" until recorded', async () => {
    const d = (await api().get(T(`/buses/${bus._id}/documents`)).set(tr.h)).body;
    expect(d.documents.map((x) => x.type)).toEqual(['registration', 'insurance', 'pollution', 'fitness', 'permit', 'road_tax']);
    expect(d.documents.every((x) => x.state === 'missing')).toBe(true);
  });

  it('records a document with its copy; a date is required where it expires; wrong files and dates are refused', async () => {
    expect((await put('insurance', { number: 'POL-1' })).status).toBe(400); // valid-until is required
    expect((await put('insurance', { expiresOn: '2026-01-01', issuedOn: '2026-06-01' })).status).toBe(400); // ends before it starts
    expect((await put('bogus', { expiresOn: addDays(today, 100) })).status).toBe(400);
    expect((await put('insurance', { expiresOn: addDays(today, 100) }, { buf: Buffer.from('MZ not a pdf'), name: 'a.exe', type: 'application/x-msdownload' })).status).toBe(400);
    expect((await put('insurance', { expiresOn: addDays(today, 100) }, { buf: Buffer.from('plain text'), name: 'a.pdf', type: 'application/pdf' })).status).toBe(400); // content must match
    const ok = await put('insurance', { number: 'POL-1', issuedOn: addDays(today, -265), expiresOn: addDays(today, 100), notes: 'Comprehensive' }, { buf: PDF, name: 'insurance.pdf', type: 'application/pdf' });
    expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ type: 'insurance', number: 'POL-1', state: 'valid', fileId: expect.any(String), label: 'Insurance' });
    // the list says what copy is on file, so the form can show it
    const listed = (await api().get(T(`/buses/${bus._id}/documents`)).set(tr.h)).body.documents.find((x) => x.type === 'insurance');
    expect(listed.file).toMatchObject({ name: 'insurance.pdf', mime: 'application/pdf', size: PDF.length });
    expect((await api().get(T(`/buses/${bus._id}/documents`)).set(tr.h)).body.documents.find((x) => x.type === 'fitness').file).toBeNull();
    // the bus's own expiry date follows, so the dashboard and older screens agree
    expect((await Bus.findById(bus._id)).insuranceExpiry).toBe(addDays(today, 100));
    expect((await put('registration', { number: 'GJ03AB1234' })).body.state).toBe('valid'); // an RC need not expire
  });

  it('a renewal replaces the old record and its file; "other" documents can be added more than once', async () => {
    const before = (await BusDocument.findOne({ type: 'insurance' })).fileId;
    const r = await put('insurance', { number: 'POL-2', expiresOn: addDays(today, 365) }, { buf: PDF, name: 'renewed.pdf', type: 'application/pdf' });
    expect(r.body.number).toBe('POL-2'); expect(await BusDocument.countDocuments({ busId: bus._id, type: 'insurance' })).toBe(1);
    expect(await File.findById(before)).toBeNull(); // the old copy is gone
    const a = await api().post(T(`/buses/${bus._id}/documents`)).set(tr.h).field('title', 'Speed governor certificate').field('expiresOn', addDays(today, 50)); expect(a.status).toBe(201);
    expect((await api().post(T(`/buses/${bus._id}/documents`)).set(tr.h).field('expiresOn', addDays(today, 50))).status).toBe(400); // a name is needed
    await api().post(T(`/buses/${bus._id}/documents`)).set(tr.h).field('title', 'Camera licence');
    expect((await api().get(T(`/buses/${bus._id}/documents`)).set(tr.h)).body.documents.filter((x) => x.type === 'other')).toHaveLength(2);
  });

  it('the copy opens for the transport officer and the School Admin, and for nobody else', async () => {
    const doc = (await api().get(T(`/buses/${bus._id}/documents`)).set(tr.h)).body.documents.find((x) => x.type === 'insurance');
    const link = async (h) => api().post(`/api/shared/files/${doc.fileId}/link`).set(h);
    for (const h of [tr.h, W.h]) { const l = await link(h); expect(l.status).toBe(200); const dl = await api().get(l.body.url).buffer(true).parse(bin); expect(dl.status).toBe(200); expect(dl.body.equals(PDF)).toBe(true); }
    expect((await link(W.teacher1.h)).status).toBeGreaterThanOrEqual(403);
    expect((await link(W.studentLogins[0].h)).status).toBeGreaterThanOrEqual(403);
    // the School Admin looks but does not change
    expect((await api().get(`/api/school/transport/buses/${bus._id}/documents`).set(W.h)).status).toBe(200);
    expect((await api().put(`/api/school/transport/buses/${bus._id}/documents/fitness`).set(W.h).field('expiresOn', addDays(today, 90))).status).toBe(403);
  });

  it('the dashboard lists them with their state; expiry reminders go out once per stage', async () => {
    await put('pollution', { expiresOn: addDays(today, 5) }); await put('fitness', { expiresOn: addDays(today, -3) }); await put('permit', { expiresOn: addDays(today, 20) });
    const certs = (await api().get(T('/dashboard')).set(tr.h)).body.certificates.filter((c) => c.bus === 'V-01');
    const state = (doc) => certs.find((c) => c.doc === doc)?.state;
    expect(state('insurance')).toBe('valid'); expect(state('pollution')).toBe('expiring'); expect(state('fitness')).toBe('expired'); expect(state('registration')).toBe('valid'); expect(state('permit')).toBe('expiring');
    const sent = await busDocumentReminders(); expect(sent).toBeGreaterThanOrEqual(3);
    const n = await Notification.find({ title: /Bus V-01/ }).lean();
    expect(n.some((x) => /Fitness certificate has expired/.test(x.title))).toBe(true); expect(n.some((x) => /Pollution certificate \(PUC\) runs out in 5 days/.test(x.title))).toBe(true);
    expect(await busDocumentReminders()).toBe(0); // each stage is sent once
  });

  it('removing a document removes its copy and clears the bus date; older expiry dates become documents by migration', async () => {
    const d = (await api().get(T(`/buses/${bus._id}/documents`)).set(tr.h)).body.documents.find((x) => x.type === 'pollution');
    expect((await api().delete(T(`/buses/${bus._id}/documents/${d.id}`)).set(tr.h)).status).toBe(200);
    expect((await Bus.findById(bus._id)).pollutionExpiry).toBeUndefined();
    const b2 = await Bus.create({ tenantId: W.id, busNo: 'OLD-1', insuranceExpiry: addDays(today, 40), fitnessExpiry: addDays(today, 60) });
    const dir = fileURLToPath(new URL('../src/migrations/', import.meta.url));
    const { JobLease, Migration } = await import('../src/models/index.js'); await JobLease.deleteMany({}); await Migration.deleteMany({});
    await runMigrations({ dir });
    expect((await BusDocument.find({ busId: b2._id })).map((x) => x.type).sort()).toEqual(['fitness', 'insurance']);
    const a2 = await api().get(T(`/buses/${b2._id}/documents`)).set(tr.h);
    expect(a2.body.documents.find((x) => x.type === 'insurance').expiresOn).toBe(addDays(today, 40));
  });
});
