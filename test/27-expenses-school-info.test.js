import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';
import { todayStr, addDays } from '../src/core/utils.js';

const TODAY = todayStr('Asia/Kolkata');

describe('Finance: expenses, budgets, approvals; the school page, licences and the finance-only tax details', () => {
  let root; let W; let fin; let lib;
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'exp');
    const f = await api().post('/api/school/staff').set(W.h).send({ name: 'Fiona Finance', email: 'fiona@exp.test', role: 'finance' });
    fin = await login(f.body.loginId, f.body.temporaryPassword, 'finance');
    const l = await api().post('/api/school/staff').set(W.h).send({ name: 'Liam Library', email: 'liam@exp.test', role: 'library' });
    lib = await login(l.body.loginId, l.body.temporaryPassword, 'library');
  });
  afterAll(teardown);
  const F = (p) => `/api/finance${p}`;
  const exp = (over = {}) => ({ date: TODAY, department: 'Science', work: 'Lab equipment', title: 'Microscopes', vendor: 'Edu Supplies', amount: 12000, ...over });

  it('Finance records an expense; it waits for the School Admin, who approves or rejects (with a reason)', async () => {
    expect((await api().post(F('/expenses')).set(W.teacher1.h).send(exp())).status).toBe(403);
    expect((await api().post(F('/expenses')).set(fin.h).send(exp({ amount: -1 }))).status).toBe(400);
    const e = await api().post(F('/expenses')).set(fin.h).send(exp());
    expect(e.status).toBe(201); expect(e.body).toMatchObject({ status: 'pending', amount: 12000 });
    const inbox = (await api().get('/api/school/approvals').set(W.h)).body;
    expect(inbox.expenses.map((x) => x.title)).toEqual(['Microscopes']);
    expect((await api().post(`/api/school/approvals/expenses/${e.body._id}`).set(W.h).send({ approve: false })).status).toBe(400); // a rejection needs a reason
    expect((await api().post(`/api/school/approvals/expenses/${e.body._id}`).set(fin.h).send({ approve: true })).status).toBe(403); // Finance cannot approve its own
    const ok = await api().post(`/api/school/approvals/expenses/${e.body._id}`).set(W.h).send({ approve: true });
    expect(ok.body).toMatchObject({ status: 'approved', decidedByName: expect.any(String) });
    expect((await api().post(`/api/school/approvals/expenses/${e.body._id}`).set(W.h).send({ approve: true })).status).toBe(409); // decided once
    expect((await api().delete(F(`/expenses/${e.body._id}`)).set(fin.h)).status).toBe(409); // an approved expense is locked
    expect((await api().patch(F(`/expenses/${e.body._id}`)).set(fin.h).send({ amount: 1 })).status).toBe(409);
    // a rejected one can be corrected and goes back for approval
    const bad = (await api().post(F('/expenses')).set(fin.h).send(exp({ title: 'Projector', amount: 50000, department: 'IT' }))).body;
    await api().post(`/api/school/approvals/expenses/${bad._id}`).set(W.h).send({ approve: false, note: 'Too costly' });
    const fixed = await api().patch(F(`/expenses/${bad._id}`)).set(fin.h).send({ amount: 30000 });
    expect(fixed.body).toMatchObject({ status: 'pending', amount: 30000 });
    // the notification reached Finance
    expect(((await api().get('/api/finance/expenses?status=approved').set(fin.h)).body.totals.approved).amount).toBe(12000);
  });

  it('a budget shows allocated, used (approved only), pending and remaining, by department and by work', async () => {
    expect((await api().put(F('/budgets')).set(fin.h).send({ department: 'Science', work: 'Lab equipment', allocated: 20000 })).status).toBe(200);
    expect((await api().put(F('/budgets')).set(fin.h).send({ department: 'Science', allocated: 100000 })).status).toBe(200); // the whole department
    await api().put(F('/budgets')).set(fin.h).send({ department: 'Science', work: 'Lab equipment', allocated: 25000 }); // updates, never duplicates
    const b = (await api().get(F('/budgets')).set(fin.h)).body;
    expect(b.items).toHaveLength(2);
    const lab = b.items.find((x) => x.work === 'Lab equipment');
    expect(lab).toMatchObject({ allocated: 25000, used: 12000, remaining: 13000, over: false });
    expect(b.items.find((x) => !x.work)).toMatchObject({ allocated: 100000, used: 12000, remaining: 88000 });
    expect(b.unbudgeted.map((x) => x.department)).toEqual(['IT']); // spending with no budget is not hidden
    expect(b.unbudgeted[0]).toMatchObject({ used: 0, pending: 30000 });
    // the School Admin sees the same in a read-only window and cannot change it
    expect((await api().get('/api/school/finance/budgets').set(W.h)).body.totals.allocated).toBe(125000);
    expect((await api().put('/api/school/finance/budgets').set(W.h).send({ department: 'X Y', allocated: 1 })).status).toBe(403);
  });

  it('GSTIN, PAN and bank details are seen and changed by Finance alone, and validated', async () => {
    expect((await api().put(F('/school-finance-profile')).set(fin.h).send({ gstin: 'bad' })).status).toBe(400);
    expect((await api().put(F('/school-finance-profile')).set(fin.h).send({ pan: '123' })).status).toBe(400);
    const ok = await api().put(F('/school-finance-profile')).set(fin.h).send({ gstin: '24abcde1234f1z5', pan: 'abcde1234f', accountNo: '123456789012', ifsc: 'sbin0001234', bankName: 'SBI' });
    expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ gstin: '24ABCDE1234F1Z5', pan: 'ABCDE1234F', ifsc: 'SBIN0001234' });
    expect((await api().get(F('/school-finance-profile')).set(fin.h)).body.bankName).toBe('SBI');
    expect((await api().get('/api/school/finance/school-finance-profile').set(W.h)).status).toBe(403); // not the School Admin either
    expect((await api().get('/api/library/school-info').set(lib.h)).status).toBe(200);
    for (const h of [W.h, W.teacher1.h, W.studentLogins[0].h, lib.h]) {
      const info = (await api().get(h === W.h ? '/api/school/school-info' : h === lib.h ? '/api/library/school-info' : `/api/${h === W.teacher1.h ? 'teacher' : 'student'}/school-info`).set(h)).body;
      expect(JSON.stringify(info)).not.toMatch(/ABCDE1234F|SBIN0001234|gstin/i);
    }
  });

  it('the school page, gallery text and licences are edited by the Admin and read by everyone at the school', async () => {
    expect((await api().put('/api/school/school-info').set(W.teacher1.h).send({ about: 'x' })).status).toBe(403);
    expect((await api().put('/api/school/school-info').set(W.h).send({ tagline: 'Learn well', about: 'A fine school', principalName: 'Dr Rao', sections: [{ title: 'Facilities', body: 'Labs and a library' }] })).status).toBe(200);
    await api().post('/api/school/licenses').set(W.h).send({ name: 'State recognition', authority: 'state', number: 'GJ/123', validUntil: addDays(TODAY, 400) });
    await api().post('/api/school/licenses').set(W.h).send({ name: 'Fire safety NOC', authority: 'local', validUntil: addDays(TODAY, 10) });
    await api().post('/api/school/licenses').set(W.h).send({ name: 'CBSE affiliation', authority: 'central', validUntil: addDays(TODAY, -5) });
    expect((await api().post('/api/school/licenses').set(W.h).send({ name: 'x', validUntil: 'soon' })).status).toBe(400);
    const read = (await api().get('/api/student/school-info').set(W.studentLogins[0].h)).body;
    expect(read.profile).toMatchObject({ tagline: 'Learn well', principalName: 'Dr Rao' });
    expect(read.profile.sections[0].title).toBe('Facilities');
    expect(Object.fromEntries(read.licenses.map((l) => [l.name, l.state]))).toEqual({ 'State recognition': 'valid', 'Fire safety NOC': 'expiring', 'CBSE affiliation': 'expired' });
    expect((await api().get('/api/teacher/school-info').set(W.teacher1.h)).status).toBe(200);
    const id = read.licenses[0]._id;
    expect((await api().delete(`/api/school/licenses/${id}`).set(W.h)).status).toBe(200);
  });
});
