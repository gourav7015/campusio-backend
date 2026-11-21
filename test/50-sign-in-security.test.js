import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { setup, teardown, reset, api, login, makeSuperAdmin, seedWorld } from './helpers.js';
import { User, File, Session } from '../src/models/index.js';
import { totp, stepAt, hotp } from '../src/services/totp.js';
import { open } from '../src/core/crypto.js';
import { setMailTransport, flushEmails } from '../src/services/email.js';
import { config } from '../src/core/config.js';
import { filePath } from '../src/services/files.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const bin = (res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };

describe('Sign-in security: authenticator codes, recovery codes, renewing a session, reset by email, encrypted files', () => {
  let root; let W;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'sec'); });
  afterAll(teardown);
  const admin = () => User.findOne({ role: 'school_admin', tenantId: W.id });

  it('the one-time code matches the published test values (RFC 6238, SHA-1)', () => {
    // RFC 6238 appendix B: secret "12345678901234567890" = base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ; at 59 s the 8-digit code is 94287082
    expect(hotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1, 8)).toBe('94287082');
    expect(hotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 37037036, 8)).toBe('07081804');
  });

  it('turning two-factor sign-in on needs the password and a code from the app, and gives recovery codes once', async () => {
    expect((await api().post('/api/auth/2fa/setup').set(W.h).send({ password: 'wrong-password1' })).status).toBe(400);
    const setup = (await api().post('/api/auth/2fa/setup').set(W.h).send({ password: 'Admin@12345' })).body;
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/); expect(setup.qrSvg).toMatch(/<svg/); expect(setup.otpauth).toContain('issuer=Campusio');
    // the secret is not stored readable
    const raw = (await admin()).toObject().totp;
    expect(JSON.stringify(raw)).not.toContain(setup.secret); expect(open(raw.pendingSealed)).toBe(setup.secret);
    expect((await api().post('/api/auth/2fa/enable').set(W.h).send({ code: '000000' })).status).toBe(400);
    const on = await api().post('/api/auth/2fa/enable').set(W.h).send({ code: totp(setup.secret) });
    expect(on.status).toBe(200); expect(on.body.recoveryCodes).toHaveLength(10);
    W.secret = setup.secret; W.recovery = on.body.recoveryCodes;
    expect((await api().get('/api/auth/me').set(W.h)).body.user.twoFactor).toBe(true);
    expect(JSON.stringify((await admin()).toObject().totp.recovery)).not.toContain(on.body.recoveryCodes[0]); // only hashes
  });

  it('after the password, sign-in asks for the code; a wrong code, an old code and a replayed code are refused', async () => {
    const first = await api().post('/api/auth/login').send({ loginId: 'admin@sec.test', password: 'Admin@12345', portal: 'admin' });
    expect(first.status).toBe(200); expect(first.body.twoFactorRequired).toBe(true); expect(first.body.token).toBeUndefined();
    const ch = first.body.challenge;
    // the challenge is not a session
    expect((await api().get('/api/auth/me').set('Authorization', `Bearer ${ch}`)).status).toBe(401);
    expect((await api().post('/api/auth/login/2fa').send({ challenge: ch, code: '123456' })).status).toBe(401);
    // a code from a step already used (the one that switched it on) cannot be used again
    expect((await api().post('/api/auth/login/2fa').send({ challenge: ch, code: totp(W.secret, Date.now() - 30000) })).status).toBe(401);
    const good = await api().post('/api/auth/login/2fa').send({ challenge: ch, code: hotp(W.secret, stepAt() + 1) });
    expect(good.status).toBe(200); expect(good.body.token).toBeTruthy(); expect(good.body.user.role).toBe('school_admin');
    const again = await api().post('/api/auth/login').send({ loginId: 'admin@sec.test', password: 'Admin@12345', portal: 'admin' });
    expect((await api().post('/api/auth/login/2fa').send({ challenge: again.body.challenge, code: hotp(W.secret, stepAt() + 1) })).status).toBe(401); // replay
    // the wrong portal still looks like a wrong password
    expect((await api().post('/api/auth/login').send({ loginId: 'admin@sec.test', password: 'Admin@12345', portal: 'teacher' })).status).toBe(401);
  });

  it('a recovery code works once', async () => {
    const code = W.recovery[0];
    const c1 = (await api().post('/api/auth/login').send({ loginId: 'admin@sec.test', password: 'Admin@12345', portal: 'admin' })).body.challenge;
    expect((await api().post('/api/auth/login/2fa').send({ challenge: c1, code })).status).toBe(200);
    const c2 = (await api().post('/api/auth/login').send({ loginId: 'admin@sec.test', password: 'Admin@12345', portal: 'admin' })).body.challenge;
    expect((await api().post('/api/auth/login/2fa').send({ challenge: c2, code })).status).toBe(401);
  });

  it('wrong codes count towards the lock-out', async () => {
    const c = (await api().post('/api/auth/login').send({ loginId: 'admin@sec.test', password: 'Admin@12345', portal: 'admin' })).body.challenge;
    for (let i = 0; i < 8; i++) await api().post('/api/auth/login/2fa').send({ challenge: c, code: '111111' });
    expect((await api().post('/api/auth/login/2fa').send({ challenge: c, code: '111111' })).status).toBe(429);
    await User.updateOne({ loginId: 'admin@sec.test' }, { $unset: { lockedUntil: 1 }, $set: { failedLogins: 0 } });
  });

  it('turning it off needs the password and a code; an administrator can reset it for someone who lost their phone', async () => {
    const sess = async () => { const c = (await api().post('/api/auth/login').send({ loginId: 'admin@sec.test', password: 'Admin@12345', portal: 'admin' })).body.challenge; const r = await api().post('/api/auth/login/2fa').send({ challenge: c, code: W.recovery[1] }); W.recovery.splice(1, 1); return { h: { Authorization: `Bearer ${r.body.token}` } }; };
    const me = await sess();
    expect((await api().post('/api/auth/2fa/disable').set(me.h).send({ password: 'Admin@12345', code: '000000' })).status).toBe(400);
    // the Platform Admin resets it (lost phone); the account is signed out everywhere
    const adm = await admin();
    expect((await api().post(`/api/platform/users/${adm._id}/reset-2fa`).set(root.h)).status).toBe(200);
    expect((await api().get('/api/auth/me').set(me.h)).status).toBe(401);
    const plain = await api().post('/api/auth/login').send({ loginId: 'admin@sec.test', password: 'Admin@12345', portal: 'admin' });
    expect(plain.body.token).toBeTruthy(); expect(plain.body.twoFactorRequired).toBeUndefined();
    W.h = { Authorization: `Bearer ${plain.body.token}` };
    // a school administrator can reset a teacher's, but never their own
    const t = await User.findOne({ role: 'teacher', tenantId: W.id });
    expect((await api().post(`/api/school/users/${t._id}/reset-2fa`).set(W.h)).status).toBe(200);
    expect((await api().post(`/api/school/users/${adm._id}/reset-2fa`).set(W.h)).status).toBe(403);
    expect((await api().post(`/api/school/users/${root.user.id}/reset-2fa`).set(W.h)).status).toBe(404);
  });

  it('a session is renewed while it is younger than the limit, with the same session', async () => {
    const before = (await api().get('/api/auth/sessions').set(W.h)).body.length;
    const r = await api().post('/api/auth/refresh').set(W.h); expect(r.status).toBe(200);
    expect((await api().get('/api/auth/me').set({ Authorization: `Bearer ${r.body.token}` })).status).toBe(200);
    expect((await api().get('/api/auth/sessions').set(W.h)).body.length).toBe(before); // no new session
    await Session.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) } });
    expect((await api().post('/api/auth/refresh').set(W.h)).status).toBe(401);
    W.h = (await login('admin@sec.test', 'Admin@12345', 'admin')).h;
  });

  it('a forgotten password can be reset by an emailed link, once, and every device is signed out', async () => {
    expect((await api().get('/api/auth/options')).body.emailReset).toBe(false);
    const mails = []; setMailTransport(async (m) => { mails.push(m); return {}; });
    expect((await api().get('/api/auth/options')).body.emailReset).toBe(true);
    await User.updateOne({ loginId: 'admin@sec.test' }, { $set: { email: 'admin@sec.test' } });
    // the same answer for a real and a made-up account
    expect((await api().post('/api/auth/forgot').send({ loginId: 'admin@sec.test' })).body).toEqual({ ok: true });
    expect((await api().post('/api/auth/forgot').send({ loginId: 'nobody@nowhere.test' })).body).toEqual({ ok: true });
    await flushEmails();
    expect(mails).toHaveLength(1); expect(mails[0].to).toBe('admin@sec.test');
    const token = /reset-password\?token=([\w-]+)/.exec(mails[0].text)[1];
    expect((await api().post('/api/auth/reset').send({ token, newPassword: 'short' })).status).toBe(400);
    expect((await api().post('/api/auth/reset').send({ token: 'x'.repeat(43), newPassword: 'Brand-new-Pass1' })).status).toBe(400);
    const ok = await api().post('/api/auth/reset').send({ token, newPassword: 'Brand-new-Pass1' });
    expect(ok.status).toBe(200);
    expect((await api().post('/api/auth/reset').send({ token, newPassword: 'Another-Pass22' })).status).toBe(400); // once only
    expect((await api().get('/api/auth/me').set(W.h)).status).toBe(401); // old session ended
    expect((await login('admin@sec.test', 'Brand-new-Pass1', 'admin')).token).toBeTruthy();
    await flushEmails(); expect(mails.map((m) => m.subject)).toContain('Your Campusio password was changed');
    // not more than three a hour
    for (let i = 0; i < 4; i++) await api().post('/api/auth/forgot').send({ loginId: 'admin@sec.test' });
    await flushEmails(); expect(mails.filter((m) => /Reset your/.test(m.subject)).length).toBeLessThanOrEqual(3);
    setMailTransport(null);
    expect((await api().get('/api/auth/options')).body.emailReset).toBe(false);
  });

  it('a reset also needs the authenticator code for an account that has one', async () => {
    const mails = []; setMailTransport(async (m) => { mails.push(m); return {}; });
    const h = (await login('admin@sec.test', 'Brand-new-Pass1', 'admin')).h;
    const s = (await api().post('/api/auth/2fa/setup').set(h).send({ password: 'Brand-new-Pass1' })).body;
    await api().post('/api/auth/2fa/enable').set(h).send({ code: totp(s.secret) });
    await User.deleteMany({ role: 'student', loginId: 'x' }); await PasswordResetClear();
    await api().post('/api/auth/forgot').send({ loginId: 'admin@sec.test' }); await flushEmails();
    const token = /reset-password\?token=([\w-]+)/.exec(mails.at(-1).text)[1];
    expect((await api().post('/api/auth/reset').send({ token, newPassword: 'Yet-another-Pass3' })).status).toBe(401);
    expect((await api().post('/api/auth/reset').send({ token, newPassword: 'Yet-another-Pass3', code: hotp(s.secret, stepAt() + 1) })).status).toBe(200);
    setMailTransport(null);
  });

  it('with ENCRYPT_FILES on, a stored file is unreadable on disk but opens normally', async () => {
    const act = { ...root.h, 'x-acting-school': W.id };
    config.encryptFiles = true;
    try {
      const set = await api().post('/api/school/document-settings/logo').set(act).attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' });
      expect(set.status).toBe(201);
      const f = await File.findById(set.body.settings.logoFileId);
      expect(f.enc).toBe(true);
      expect(fs.readFileSync(filePath(f)).subarray(0, 4).toString('hex')).not.toBe('89504e47'); // not a PNG on disk
      const link = (await api().post(`/api/shared/files/${f._id}/link`).set(act)).body.url;
      const dl = await api().get(link).buffer(true).parse(bin);
      expect(dl.status).toBe(200); expect(dl.body.equals(PNG)).toBe(true);
    } finally { config.encryptFiles = false; }
  });
});
async function PasswordResetClear() { const { PasswordReset } = await import('../src/models/index.js'); await PasswordReset.deleteMany({}); }
