import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld, login } from './helpers.js';

describe('Sub-admins: a School Admin login limited to chosen parts of the portal', () => {
  let root; let W; let sub;
  beforeAll(async () => { await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'sa'); });
  afterAll(teardown);
  const A = (p) => `/api/school${p}`;

  it('only the full admin creates them, with at least one permission', async () => {
    expect((await api().post(A('/sub-admins')).set(W.h).send({ name: 'Desk One', email: 'desk@sa.test', permissions: [] })).status).toBe(400);
    expect((await api().post(A('/sub-admins')).set(W.h).send({ name: 'Desk One', email: 'desk@sa.test', permissions: ['bogus'] })).status).toBe(400);
    expect((await api().post(A('/sub-admins')).set(W.teacher1.h).send({ name: 'X Y', email: 'x@sa.test', permissions: ['students'] })).status).toBe(403);
    const c = await api().post(A('/sub-admins')).set(W.h).send({ name: 'Desk One', email: 'desk@sa.test', permissions: ['staff_attendance'] });
    expect(c.status).toBe(201); expect(c.body.temporaryPassword).toBeTruthy();
    sub = await login(c.body.loginId, c.body.temporaryPassword, 'admin');
    expect(sub.user).toMatchObject({ role: 'school_admin', adminLevel: 'sub', permissions: ['staff_attendance'] });
  });

  it('a sub-admin reaches only what was granted; everything else is refused by the server', async () => {
    expect((await api().get(A('/staff-attendance/register?group=teachers')).set(sub.h)).status).toBe(200);
    expect((await api().get(A('/support-staff')).set(sub.h)).status).toBe(200);
    expect((await api().get(A('/classes')).set(sub.h)).status).toBe(200); // lookups are readable
    expect((await api().post(A('/classes')).set(sub.h).send({ name: 'Class 5' })).status).toBe(403); // but not changeable
    for (const p of ['/students', '/teachers', '/payroll/summary', '/settings', '/staff', '/audit', '/sub-admins', '/announcements']) expect((await api().get(A(p)).set(sub.h)).status, p).toBe(403);
    expect((await api().get(A('/finance/dashboard')).set(sub.h)).status).toBe(403);
    expect((await api().get(A('/dashboard')).set(sub.h)).status).toBe(200);
    // the full admin is unaffected
    expect((await api().get(A('/students')).set(W.h)).status).toBe(200);
  });

  it('permissions can be changed (the sub-admin signs in again), and a disabled sub-admin is locked out', async () => {
    const list = (await api().get(A('/sub-admins')).set(W.h)).body;
    const id = list[0].id;
    expect((await api().patch(A(`/sub-admins/${id}`)).set(W.h).send({ permissions: ['students', 'finance_view'] })).status).toBe(200);
    expect((await api().get(A('/students')).set(sub.h)).status).toBe(401); // old session revoked
    const r = await api().post(A(`/sub-admins/${id}/reset-password`)).set(W.h).send({});
    const again = await login(r.body.loginId, r.body.temporaryPassword, 'admin');
    expect((await api().get(A('/students')).set(again.h)).status).toBe(200);
    expect((await api().get(A('/finance/dashboard')).set(again.h)).status).toBe(200); // the view-only window follows the same rule
    expect((await api().get(A('/staff-attendance/register?group=teachers')).set(again.h)).status).toBe(403);
    await api().patch(A(`/sub-admins/${id}`)).set(W.h).send({ status: 'disabled' });
    expect((await api().post('/api/auth/login').send({ loginId: r.body.loginId, password: 'whatever1', portal: 'admin' })).status).toBe(401);
  });
});
