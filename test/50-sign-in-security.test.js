import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, login, makeSuperAdmin, seedWorld } from './helpers.js';
import { User, File, Session, PasswordResetCode } from '../src/models/index.js';
import { setMailTransport, flushEmails } from '../src/services/email.js';
import { config } from '../src/core/config.js';
import mongoose from 'mongoose';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const bin = (res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };

describe('Sign-in security: renewing a session, password reset by date of birth and an emailed code, encrypted files', () => {
  let root; let W;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'sec'); });
  afterAll(teardown);

  it('a session is renewed while it is younger than the limit, with the same session', async () => {
    const before = (await api().get('/api/auth/sessions').set(W.h)).body.length;
    const r = await api().post('/api/auth/refresh').set(W.h); expect(r.status).toBe(200);
    expect((await api().get('/api/auth/me').set({ Authorization: `Bearer ${r.body.token}` })).status).toBe(200);
    expect((await api().get('/api/auth/sessions').set(W.h)).body.length).toBe(before); // no new session
    await Session.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) } });
    expect((await api().post('/api/auth/refresh').set(W.h)).status).toBe(401);
    W.h = (await login('admin@sec.test', 'Admin@12345', 'admin')).h;
  });

  it('a forgotten password: date of birth, then a code sent to the registered email, then a new password', async () => {
    expect((await api().get('/api/auth/options')).body.emailCodes).toBe(false);
    const mails = []; setMailTransport(async (m) => { mails.push(m); return {}; });
    expect((await api().get('/api/auth/options')).body.emailCodes).toBe(true);
    const ask = (b) => api().post('/api/auth/forgot').send({ loginId: 'admin@sec.test', ...b });
    const codeOf = () => /\b(\d{6})\b/.exec(mails.at(-1).text)[1];
    // a wrong date of birth and a made-up account get the same answer as a right one, and nothing is sent
    expect((await ask({ dob: '1999-01-01' })).body).toEqual({ ok: true });
    expect((await api().post('/api/auth/forgot').send({ loginId: 'nobody@nowhere.test', dob: '1980-05-05' })).body).toEqual({ ok: true });
    await flushEmails(); expect(mails).toHaveLength(0);
    // the right one sends a code to the registered email
    expect((await ask({ dob: '1980-05-05' })).body).toEqual({ ok: true });
    await flushEmails(); expect(mails).toHaveLength(1); expect(mails[0].to).toBe('admin@sec.test'); expect(mails[0].subject).toMatch(/reset code/);
    const code = codeOf(); const wrong = code === '111111' ? '222222' : '111111';
    const verify = (c) => api().post('/api/auth/forgot/verify').send({ loginId: 'admin@sec.test', code: c });
    expect((await verify(wrong)).status).toBe(400);
    const v = await verify(code); expect(v.status).toBe(200); const resetToken = v.body.resetToken;
    expect((await api().post('/api/auth/reset').send({ resetToken, newPassword: 'short' })).status).toBe(400);
    expect((await api().post('/api/auth/reset').send({ resetToken: 'x'.repeat(43), newPassword: 'Brand-new-Pass1' })).status).toBe(400);
    expect((await api().post('/api/auth/reset').send({ resetToken, newPassword: 'Brand-new-Pass1' })).status).toBe(200);
    expect((await api().post('/api/auth/reset').send({ resetToken, newPassword: 'Another-Pass22' })).status).toBe(400); // once only
    expect((await verify(code)).status).toBe(400); // the code is spent too
    expect((await api().get('/api/auth/me').set(W.h)).status).toBe(401); // the old session ended
    expect((await login('admin@sec.test', 'Brand-new-Pass1', 'admin')).token).toBeTruthy();
    await flushEmails(); expect(mails.map((m) => m.subject)).toContain('Your AtKaksha password was changed');
    // five wrong tries kill the request
    await PasswordResetCode.deleteMany({}); mails.length = 0;
    await ask({ dob: '1980-05-05' }); await flushEmails(); const real = codeOf();
    for (let i = 0; i < 5; i++) await verify(real === '000000' ? '000001' : '000000');
    expect((await verify(real)).status).toBe(400);
    // at most five requests an hour
    for (let i = 0; i < 8; i++) await ask({ dob: '1980-05-05' });
    await flushEmails(); expect(mails.filter((m) => /reset code/.test(m.subject)).length).toBeLessThanOrEqual(5);
    setMailTransport(null);
    expect((await api().get('/api/auth/options')).body.emailCodes).toBe(false);
  });

  it('a teacher, a student and an office employee are recognised by the details on their own records', async () => {
    const mails = []; setMailTransport(async (m) => { mails.push(m); return {}; });
    const t = await User.findOne({ role: 'teacher', tenantId: W.id });
    await api().post('/api/auth/forgot').send({ loginId: t.loginId, dob: '1985-01-01' }); await flushEmails();
    expect(mails.at(-1).to).toBe('sharma@sec.test');
    const stu = W.studentLogins[0].user;
    await api().post('/api/auth/forgot').send({ loginId: stu.loginId, dob: '2013-01-10' }); await flushEmails();
    expect(mails.at(-1).to).toBe('parent.aarav@sec.test'); // the primary guardian's email: the parent signs in with the student's login
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
      const chunks = await mongoose.connection.db.collection('files.chunks').find({ files_id: f.gridId }).toArray();
      expect(Buffer.concat(chunks.map((c) => c.data.buffer)).subarray(0, 4).toString('hex')).not.toBe('89504e47'); // not a PNG as stored
      const link = (await api().post(`/api/shared/files/${f._id}/link`).set(act)).body.url;
      const dl = await api().get(link).buffer(true).parse(bin);
      expect(dl.status).toBe(200); expect(dl.body.equals(PNG)).toBe(true);
    } finally { config.encryptFiles = false; }
  });
});
