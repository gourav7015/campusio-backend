import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { AuditLog } from '../src/models/index.js';

describe('Audit log: filter by day, person, role, area and words', () => {
  let root; let W; let today; let yesterday; let weekAgo;
  const L = (q) => api().get(`/api/school/audit?${q}`).set(W.h);
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'aud');
    const now = new Date();
    today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    // entries from other days, written straight into the log
    const mk = (days, over) => AuditLog.create({ tenantId: W.id, actorName: 'Old Actor', actorRole: 'teacher', action: 'marks.saved', summary: 'Saved marks long ago', createdAt: new Date(now.getTime() - days * 864e5), ...over });
    await mk(1, { summary: 'Marks yesterday' }); await mk(7, { summary: 'Marks last week', actorRole: 'finance', action: 'fees.payment' });
    yesterday = new Date(now.getTime() - 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    weekAgo = new Date(now.getTime() - 7 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    await api().post('/api/school/classes').set(W.h).send({ name: 'Class 10' }); // a fresh entry today: class.created
  });
  afterAll(teardown);

  it('one day, a range, and everything', async () => {
    const t = (await L(`from=${today}&to=${today}`)).body; expect(t.length).toBeGreaterThan(0);
    expect(t.every((x) => new Date(x.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === today)).toBe(true);
    expect(t.some((x) => /yesterday|last week/.test(x.summary || ''))).toBe(false);
    const y = (await L(`from=${yesterday}&to=${yesterday}`)).body; expect(y.map((x) => x.summary)).toEqual(['Marks yesterday']);
    const range = (await L(`from=${weekAgo}&to=${today}`)).body; expect(range.length).toBe(t.length + 2);
    expect((await L('')).body.length).toBe(range.length); // no dates: everything, newest first
    expect((await L(`from=${today}`)).body.length).toBe(t.length); // only a start date: from then on
  });

  it('by role, person, area, words and the start of an action', async () => {
    expect((await L('role=finance')).body.map((x) => x.summary)).toEqual(['Marks last week']);
    expect((await L('area=fees')).body).toHaveLength(1);
    expect((await L('area=marks')).body.map((x) => x.summary)).toEqual(['Marks yesterday']);
    expect((await L('q=last week')).body).toHaveLength(1);
    expect((await L('q=Old Actor')).body.length).toBe(2); // by the person's name
    expect((await L('action=class.created')).body.length).toBe(3); // the two classes of the standard school and Class 10
    const mine = (await L(`from=${today}&to=${today}`)).body.find((x) => x.actorRole === 'school_admin');
    expect((await L(`actorId=${mine.actorId}`)).body.every((x) => String(x.actorId) === String(mine.actorId))).toBe(true);
    expect((await L('q=x')).body.length).toBeGreaterThan(0); // a single letter is ignored rather than matching everything oddly
  });

  it('the filters offer only what happened, and stay inside the school', async () => {
    const f = (await api().get(`/api/school/audit/facets?from=${today}&to=${today}`).set(W.h)).body;
    expect(f.total).toBeGreaterThan(0);
    expect(f.areas.map((a) => a.area)).toContain('class'); expect(f.areas.map((a) => a.area)).not.toContain('fees');
    expect(f.people.length).toBeGreaterThan(0);
    const all = (await api().get('/api/school/audit/facets').set(W.h)).body; expect(all.areas.map((a) => a.area)).toContain('fees');
    expect((await api().get('/api/school/audit/facets').set(W.teacher1.h)).status).toBe(403);
  });

  it('the platform log has the same filters', async () => {
    const r = await api().get(`/api/platform/audit?from=${today}&to=${today}&area=class`).set(root.h);
    expect(r.status).toBe(200); expect(r.body.every((x) => x.action.startsWith('class.'))).toBe(true);
    expect((await api().get(`/api/platform/audit?schoolId=${W.id}&area=fees`).set(root.h)).body).toHaveLength(1);
    expect((await api().get('/api/platform/audit/facets').set(root.h)).body.total).toBeGreaterThan(0);
    expect((await api().get('/api/platform/audit/facets').set(W.h)).status).toBe(403);
  });
});
