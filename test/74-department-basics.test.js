import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, makeFinance, login } from './helpers.js';
import { Notification } from '../src/models/index.js';

/** What every department has beside its own work: notices from the school, queries to the school office, and the help desk to AtKaksha. */
describe('Finance, Library and Transport have Notices and Queries to the office like the teachers', () => {
  let root; let W; let fin; let tr;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'db');
    fin = await makeFinance(W, 'fin1');
    const c = await api().post('/api/school/staff').set(W.h).send({ name: 'Tara Transport', email: 'tara@db.test', role: 'transport', phone: '9833333333', dob: '1984-04-04' });
    tr = await login(c.body.loginId, c.body.temporaryPassword, 'transport');
  }, 120000);
  afterAll(teardown);

  it('a notice to Everyone reaches the departments; a notice to one department reaches only it', async () => {
    const all = await api().post('/api/school/announcements').set(W.h).send({ title: 'School closed on Friday', body: 'Holiday', audience: { all: true } });
    expect(all.status).toBe(201);
    const onlyFin = await api().post('/api/school/announcements').set(W.h).send({ title: 'Audit next week', audience: { all: false, roles: ['finance'] } });
    expect(onlyFin.status).toBe(201);
    const titles = async (h, base) => (await api().get(`/api/${base}/announcements`).set(h)).body.map((a) => a.title);
    expect(await titles(fin.h, 'finance')).toEqual(expect.arrayContaining(['School closed on Friday', 'Audit next week']));
    expect(await titles(tr.h, 'transport')).toEqual(['School closed on Friday']);
    expect(await Notification.countDocuments({ tenantId: W.id, userId: fin.user.id || fin.user._id, title: /Audit next week|School closed/ })).toBeGreaterThanOrEqual(2);
    expect((await api().get('/api/library/announcements').set(fin.h)).status).toBe(403); // another department's door
  });

  it('a department writes to the school office, to everyone there or to one person, and reads the answer', async () => {
    const recipients = (await api().get('/api/finance/queries/recipients').set(fin.h)).body;
    expect(recipients.some((r) => r.title === 'School Admin')).toBe(true);
    const q = await api().post('/api/finance/queries').set(fin.h).send({ subject: 'Receipt book is finished', body: 'We need a new receipt book for the fee counter.', sentTo: '' });
    expect(q.status).toBe(201);
    const inbox = (await api().get('/api/school/queries').set(W.h)).body;
    expect(JSON.stringify(inbox)).toContain('Receipt book is finished');
    expect(inbox.tickets.find((t) => t.subject === 'Receipt book is finished').raisedBy.role).toBe('finance');
    expect((await api().post(`/api/school/queries/${q.body._id}/replies`).set(W.h).send({ body: 'Ordered, it comes on Monday.' })).status).toBe(201);
    expect((await api().get(`/api/finance/queries/${q.body._id}`).set(fin.h)).body.messages.at(-1).body).toBe('Ordered, it comes on Monday.');
    // another department cannot read it
    expect((await api().get(`/api/transport/queries/${q.body._id}`).set(tr.h)).status).toBe(404);
    // and the transport officer can write to the admin directly
    const admin = recipients.find((r) => r.title === 'School Admin');
    const t2 = await api().post('/api/transport/queries').set(tr.h).send({ subject: 'Bus fitness papers', body: 'Please look at the fitness papers.', sentTo: admin.userId });
    expect(t2.status).toBe(201); expect(t2.body.sentTo.name).toBe(admin.name);
  });
});
