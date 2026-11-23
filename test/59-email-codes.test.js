import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';
import { User, Teacher, EmailOutbox } from '../src/models/index.js';
import { setMailTransport, flushEmails } from '../src/services/email.js';

describe('Two-factor sign-in by a code sent to the registered email', () => {
  let root; let W; const mails = [];
  const codeOf = () => /\b(\d{6})\b/.exec(mails.at(-1).text)[1];
  const start = (path = 'start', password = 'Admin@12345') => api().post(`/api/auth/2fa/${path}`).set(W.h).send({ password });
  const attempt = () => api().post('/api/auth/login').send({ loginId: 'admin@em.test', password: 'Admin@12345', portal: 'admin' });
  const second = (challenge, code) => api().post('/api/auth/login/2fa').send({ challenge, code });
  const quiet = () => User.updateOne({ loginId: 'admin@em.test' }, { $set: { 'otp.sends': [], 'otp.login.sentAt': new Date(0) } });

  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'em'); });
  afterAll(async () => { setMailTransport(null); await teardown(); });

  it('an account cannot be made without an email, a mobile number and a date of birth', async () => {
    const t = (b) => api().post('/api/school/teachers').set(W.h).send({ name: 'Test T', employeeId: 'T9', subjects: ['Art'], ...b });
    const full = { email: 't9@em.test', phone: '9833300000', dob: '1990-01-01' };
    for (const drop of ['email', 'phone', 'dob']) { const r = await t({ ...full, [drop]: undefined }); expect(r.status).toBe(400); expect(r.body.error).toMatch(drop === 'email' ? /email/ : drop === 'phone' ? /mobile/ : /date of birth/); }
    expect((await t({ ...full, phone: '12345' })).status).toBe(400);
    { const ok = await t(full); expect(ok.body.error).toBeUndefined(); expect(ok.status).toBe(201); }
    // a student: the parent's email and mobile stand in for the student's own
    const stu = (g) => api().post('/api/school/students').set(W.h).send({ name: 'Kid K', dob: '2014-01-01', sectionId: W.sec8B._id, admissionDate: '2026-04-15', guardians: [{ name: 'Parent', relationship: 'Father', phone: '9876500000', isPrimary: true, ...g }] });
    expect((await stu({})).status).toBe(400);
    { const ok = await stu({ email: 'p@em.test' }); expect(ok.body.error ?? ok.body.details).toBeUndefined(); expect(ok.status).toBe(201); }
    // a school administrator, a sub-administrator
    const sub = (b) => api().post('/api/school/sub-admins').set(W.h).send({ name: 'Sub A', permissions: ['fees'], email: 'sub@em.test', phone: '9833311111', dob: '1983-03-03', ...b });
    expect((await sub({ phone: undefined })).status).toBe(400);
    expect((await sub({ dob: undefined })).status).toBe(400);
  });

  it('until email is set up, codes are not offered', async () => {
    expect((await api().get('/api/auth/options')).body.emailCodes).toBe(false);
    expect((await start()).status).toBe(400);
    setMailTransport(async (m) => { mails.push(m); return {}; });
    expect((await api().get('/api/auth/options')).body.emailCodes).toBe(true);
  });

  it('switching it on needs the password and the code sent to the registered email', async () => {
    expect((await start('start', 'wrong-pass-1')).status).toBe(400);
    const s = await start(); expect(s.status).toBe(200); expect(s.body.sentTo).toMatch(/^a•+@em\.test$/);
    await flushEmails(); expect(mails.at(-1).to).toBe('admin@em.test');
    expect((await api().post('/api/auth/2fa/confirm').set(W.h).send({ code: '000000' })).status).toBe(400);
    expect((await api().get('/api/auth/me').set(W.h)).body.user.twoFactor).toBe(false);
    expect((await api().post('/api/auth/2fa/confirm').set(W.h).send({ code: codeOf() })).status).toBe(200);
    const me = (await api().get('/api/auth/me').set(W.h)).body.user;
    expect(me.twoFactor).toBe(true); expect(me.registeredEmail).toMatch(/^a•+@em\.test$/);
    expect(JSON.stringify((await User.findOne({ loginId: 'admin@em.test' })).toObject().otp)).not.toMatch(/\d{6}"/);
  });

  it('after the password, sign-in asks for the code sent to the registered email; it works once', async () => {
    await quiet();
    const first = await attempt(); await flushEmails();
    expect(first.status).toBe(200); expect(first.body.twoFactorRequired).toBe(true); expect(first.body.token).toBeUndefined(); expect(first.body.sentTo).toMatch(/@em\.test$/);
    const ch = first.body.challenge; const code = codeOf();
    expect((await api().get('/api/auth/me').set('Authorization', `Bearer ${ch}`)).status).toBe(401); // a challenge is not a session
    expect((await second(ch, code === '123456' ? '654321' : '123456')).status).toBe(401);
    const ok = await second(ch, code); expect(ok.status).toBe(200); expect(ok.body.token).toBeTruthy();
    expect((await second(ch, code)).status).toBe(401);
    // the wrong portal still looks like a wrong password
    expect((await api().post('/api/auth/login').send({ loginId: 'admin@em.test', password: 'Admin@12345', portal: 'teacher' })).status).toBe(401);
  });

  it('resending is limited to once every 30 seconds and the old code stops working; five wrong tries burn a code; a code expires', async () => {
    await quiet();
    const first = await attempt(); await flushEmails(); const ch = first.body.challenge; const old = codeOf();
    expect((await api().post('/api/auth/login/2fa/resend').send({ challenge: ch })).status).toBe(429);
    await User.updateOne({ loginId: 'admin@em.test' }, { $set: { 'otp.login.sentAt': new Date(Date.now() - 60000) } });
    expect((await api().post('/api/auth/login/2fa/resend').send({ challenge: ch })).status).toBe(200); await flushEmails();
    expect((await second(ch, old)).status).toBe(401);
    const fresh = codeOf();
    for (let i = 0; i < 4; i++) await second(ch, '000000');
    await User.updateOne({ loginId: 'admin@em.test' }, { $set: { failedLogins: 0 } });
    expect((await second(ch, '000001')).status).toBe(401);
    expect((await second(ch, fresh)).status).toBe(401); // burnt
    await User.updateOne({ loginId: 'admin@em.test' }, { $set: { failedLogins: 0, lockedUntil: null } });
    await quiet(); const again = await attempt(); await flushEmails(); const code = codeOf();
    await User.updateOne({ loginId: 'admin@em.test' }, { $set: { 'otp.login.expiresAt': new Date(Date.now() - 1000) } });
    expect((await second(again.body.challenge, code)).status).toBe(401);
  });

  it('at most eight codes an hour', async () => {
    await User.updateOne({ loginId: 'admin@em.test' }, { $set: { 'otp.sends': Array.from({ length: 8 }, () => new Date()) } });
    expect((await attempt()).status).toBe(429);
    await User.updateOne({ loginId: 'admin@em.test' }, { $set: { 'otp.sends': [] } });
  });

  it('a sign-in code is sent before any bulk mail already waiting', async () => {
    const sent = []; setMailTransport(async (m) => { sent.push(m.subject); return {}; });
    await EmailOutbox.insertMany(Array.from({ length: 5 }, (_, i) => ({ to: `bulk${i}@x.test`, subject: `Bulk ${i}`, text: 'x', html: 'x', priority: 0, nextAt: new Date(Date.now() - 60000) })));
    await quiet(); await attempt(); await flushEmails();
    expect(sent.indexOf('Your AtKaksha sign-in code')).toBeGreaterThanOrEqual(0);
    expect(sent.indexOf('Your AtKaksha sign-in code')).toBeLessThan(sent.indexOf('Bulk 0'));
    setMailTransport(async (m) => { mails.push(m); return {}; });
  });

  it('the code goes to the address on the person\'s own record, so a correction by the school is followed', async () => {
    const t = await User.findOne({ role: 'teacher', tenantId: W.id });
    await User.updateOne({ _id: t._id }, { $set: { 'otp.enabled': true } });
    await Teacher.updateOne({ userId: t._id }, { $set: { email: 'corrected@em.test' } });
    await api().post('/api/auth/login').send({ loginId: t.loginId, password: 'wrong' });
    const r = await api().post('/api/auth/login').send({ loginId: t.loginId, password: W.t1.credentials.temporaryPassword, portal: 'teacher' }); await flushEmails();
    expect(r.body.twoFactorRequired).toBe(true); expect(mails.at(-1).to).toBe('corrected@em.test');
    // no address on file at all: a clear answer, not a silent failure
    await Teacher.updateOne({ userId: t._id }, { $unset: { email: 1 } }); await User.updateOne({ _id: t._id }, { $unset: { email: 1 } });
    await User.updateOne({ _id: t._id }, { $set: { 'otp.sends': [] } });
    const none = await api().post('/api/auth/login').send({ loginId: t.loginId, password: W.t1.credentials.temporaryPassword, portal: 'teacher' });
    expect(none.status).toBe(503); expect(none.body.error).toMatch(/no email address/);
    // the School Admin switches it off for them
    expect((await api().post(`/api/school/users/${t._id}/reset-2fa`).set(W.h)).status).toBe(200);
    expect((await User.findById(t._id)).otp?.enabled).toBeFalsy();
  });

  it('switching it off needs the password and a code sent to the registered email', async () => {
    expect((await start('disable-start', 'wrong-pass-1')).status).toBe(400);
    expect((await start('disable-start')).status).toBe(200); await flushEmails();
    expect((await api().post('/api/auth/2fa/confirm').set(W.h).send({ code: '000000' })).status).toBe(400);
    expect((await api().post('/api/auth/2fa/confirm').set(W.h).send({ code: codeOf() })).status).toBe(200);
    expect((await api().get('/api/auth/me').set(W.h)).body.user.twoFactor).toBe(false);
    expect((await attempt()).body.token).toBeTruthy(); // password alone again
  });
});
