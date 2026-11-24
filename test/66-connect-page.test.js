import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { ConnectMessage } from '../src/models/index.js';
import { setMailTransport, flushEmails } from '../src/services/email.js';

describe('The public Connect page: a team managed from the platform, and a message form', () => {
  let root; let W; const mails = [];
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'cn'); setMailTransport(async (m) => { mails.push(m); }); });
  afterAll(async () => { setMailTransport(null); await teardown(); });
  const pub = (p = '') => api().get(`/api/public/connect${p}`);
  const P = (p) => `/api/platform${p}`;

  it('anyone can read the page, with no sign-in; it starts with the founder from the business card', async () => {
    const r = await pub(); expect(r.status).toBe(200);
    expect(r.body.title).toMatch(/Talk to the people/); expect(r.body.team.map((m) => m.name)).toEqual(['Gourav Sharma']);
    expect(r.body.hours).toMatchObject({ days: [1, 2, 3, 4, 5, 6], opens: '10:00', closes: '18:00', timezone: 'Asia/Kolkata' });
    expect(r.body.mailboxes.map((m) => m.address.split('@')[0])).toEqual(['hello', 'support', 'billing', 'privacy', 'security']);
    expect(r.body.team[0]).not.toHaveProperty('visible');
  });

  it('only the platform administrator manages the team: add, edit, hide, order, remove', async () => {
    expect((await api().get(P('/team'))).status).toBe(401);
    expect((await api().get(P('/team')).set(W.h)).status).toBe(403); // a school admin cannot
    const add = (b) => api().post(P('/team')).set(root.h).send(b);
    expect((await add({ name: 'X' })).status).toBe(400); expect((await add({ name: 'Rohit Verma', email: 'not-an-email' })).status).toBe(400);
    const rohit = await add({ name: 'Rohit Verma', role: 'Demos and onboarding', about: 'Shows AtKaksha with your classes.', topics: ['Live demo', 'Importing data'], phone: '+91 98765 43210', whatsapp: '+91 98765 43210', email: 'rohit@atkaksha.com', languages: 'English, Hindi', tone: 2 });
    expect(rohit.status).toBe(201); expect(rohit.body).toMatchObject({ name: 'Rohit Verma', tone: 2, visible: true });
    const meera = (await add({ name: 'Meera Nair', role: 'Pricing', email: 'meera@atkaksha.com' })).body;
    expect((await pub()).body.team.map((m) => m.name)).toEqual(['Gourav Sharma', 'Rohit Verma', 'Meera Nair']);
    // edit one, hide one, change the order
    expect((await api().patch(P(`/team/${rohit.body.id}`)).set(root.h).send({ role: 'Demos', email: 'rohit.v@atkaksha.com' })).body).toMatchObject({ role: 'Demos', email: 'rohit.v@atkaksha.com', tone: 2, topics: ['Live demo', 'Importing data'], visible: true }); // an edit changes only what was sent
    await api().patch(P(`/team/${meera.id}`)).set(root.h).send({ visible: false });
    expect((await pub()).body.team.map((m) => m.name)).toEqual(['Gourav Sharma', 'Rohit Verma']); // hidden people are not on the public page
    expect((await api().get(P('/team')).set(root.h)).body).toHaveLength(3); // but still there for the administrator
    const all = (await api().get(P('/team')).set(root.h)).body;
    await api().post(P('/team/reorder')).set(root.h).send({ ids: [all[2].id, all[1].id, all[0].id] });
    expect((await pub()).body.team.map((m) => m.name)).toEqual(['Rohit Verma', 'Gourav Sharma']);
    expect((await api().delete(P(`/team/${rohit.body.id}`)).set(root.h)).status).toBe(200);
    expect((await api().delete(P(`/team/${rohit.body.id}`)).set(root.h)).status).toBe(404);
    expect((await pub()).body.team.map((m) => m.name)).toEqual(['Gourav Sharma']);
  });

  it('the wording, hours and mailboxes are set from the platform', async () => {
    const cur = (await api().get(P('/connect')).set(root.h)).body;
    expect((await api().put(P('/connect')).set(W.h).send(cur)).status).toBe(403);
    expect((await api().put(P('/connect')).set(root.h).send({ ...cur, opensAt: '18:00', closesAt: '10:00' })).status).toBe(400);
    expect((await api().put(P('/connect')).set(root.h).send({ ...cur, mailboxes: [{ address: 'nope', purpose: 'x' }] })).status).toBe(400);
    const ok = await api().put(P('/connect')).set(root.h).send({ ...cur, title: 'Say hello to AtKaksha', hoursDays: [1, 2, 3, 4, 5], opensAt: '09:30', closesAt: '17:30', mailboxes: [{ address: 'hello@atkaksha.in', purpose: 'Everything' }], helloTo: 'inbox@atkaksha.com' });
    expect(ok.status).toBe(200);
    const v = (await pub()).body;
    expect(v.title).toBe('Say hello to AtKaksha'); expect(v.hours).toMatchObject({ days: [1, 2, 3, 4, 5], opens: '09:30', closes: '17:30' }); expect(v.mailboxes).toEqual([{ address: 'hello@atkaksha.in', purpose: 'Everything' }]);
  });

  it('a message is checked, kept for the administrator, and emailed to the team with a copy to the sender', async () => {
    const send = (b) => api().post('/api/public/connect/message').send({ reason: 'demo', name: 'Anita Sharma', email: 'anita@school.edu.in', school: "St. Mary's Public School", ...b });
    expect((await send({ name: '' })).status).toBe(400); expect((await send({ email: 'nope' })).status).toBe(400);
    expect((await send({ reason: 'help' })).status).toBe(400); // help needs a message
    expect((await send({ reason: 'bogus' })).status).toBe(400);
    expect(await ConnectMessage.countDocuments()).toBe(0);
    const bot = await send({ website: 'http://spam.example' }); expect(bot.status).toBe(201); expect(await ConnectMessage.countDocuments()).toBe(0); // a bot is told yes and nothing is kept
    const ok = await send({ phone: '98765 43210', size: '800 to 2,000', bestTime: 'Weekday mornings, 10 am to 1 pm', message: 'We run classes from nursery to 12.' });
    expect(ok.status).toBe(201); expect(ok.body.ref).toMatch(/^AK-\d{5}$/);
    await flushEmails();
    expect(mails.some((m) => m.to === 'inbox@atkaksha.com' && /Connect AK-/.test(m.subject) && /Anita Sharma/.test(m.text))).toBe(true); // routed to the address set on the platform
    expect(mails.some((m) => m.to === 'anita@school.edu.in' && /We have your message/.test(m.subject))).toBe(true);
    // the administrator reads it, marks it handled, and clears it
    expect((await api().get(P('/connect/messages/summary')).set(root.h)).body.count).toBe(1);
    const list = (await api().get(P('/connect/messages')).set(root.h)).body;
    expect(list[0]).toMatchObject({ ref: ok.body.ref, reason: 'demo', school: "St. Mary's Public School", status: 'new' });
    expect((await api().get(P('/connect/messages')).set(W.h)).status).toBe(403);
    expect((await api().patch(P(`/connect/messages/${list[0]._id}`)).set(root.h).send({ status: 'handled' })).body.status).toBe('handled');
    expect((await api().get(P('/connect/messages/summary')).set(root.h)).body.count).toBe(0);
    expect((await api().delete(P(`/connect/messages/${list[0]._id}`)).set(root.h)).status).toBe(200);
  });
});
