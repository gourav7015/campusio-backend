import { mailLoginDetails } from '../../services/credentials-mail.js';
import { Router } from 'express';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as v from './support-staff.validation.js';
import * as svc from './support-staff.service.js';

/** Non-teaching staff. scope 'general' = School Admin (maids, sweepers, gardeners, guards, clerks…); scope 'transport' = Transport officer (drivers, conductors, maintainers). */
const groupOf = (scope) => (scope === 'transport' ? 'transport' : scope === 'teaching' ? 'teaching' : 'general');
export function staffRoutes(scope) {
  const r = Router();
  r.get('/', async (req, res) => res.json(await svc.listStaff(req.ctx, scope, parse(v.listQuery, req.query))));
  r.post('/', async (req, res) => {
    const s = await svc.createStaff(req.ctx, scope, parse(v.staffBody, req.body));
    await audit(req, 'staff_member.created', 'StaffMember', s._id, `Added ${s.designation} ${s.name} (${s.staffId})`);
    res.status(201).json(s);
  });
  r.get('/:id', async (req, res) => res.json(await svc.getStaff(req.ctx, scope, req.params.id)));
  r.patch('/:id', async (req, res) => {
    const s = await svc.updateStaff(req.ctx, scope, req.params.id, parse(v.staffPatch, req.body));
    await audit(req, 'staff_member.updated', 'StaffMember', s._id, `Updated ${s.name}`);
    res.json(s);
  });
  r.post('/:id/login', async (req, res) => {
    const out = await svc.createLogin(req.ctx, scope, req.params.id);
    const mail = await mailLoginDetails({ tenantId: req.tenantId, loginId: out.loginId, temporaryPassword: out.temporaryPassword });
    await audit(req, 'staff_member.login_created', 'StaffMember', req.params.id, `Created a Staff portal login (${out.loginId})${mail.emailedTo ? `; emailed to ${mail.emailedTo}` : ''}`);
    res.status(201).json({ ...out, ...mail });
  });
  r.post('/:id/remove-login', async (req, res) => {
    const out = await svc.removeLogin(req.ctx, scope, req.params.id);
    await audit(req, 'staff_member.login_removed', 'StaffMember', req.params.id, 'Removed the office desk sign-in');
    res.json(out);
  });
  r.post('/:id/reset-password', async (req, res) => {
    const out = await svc.resetLogin(req.ctx, scope, req.params.id, req.body);
    const mail = await mailLoginDetails({ tenantId: req.tenantId, loginId: out.loginId, temporaryPassword: out.temporaryPassword, why: 'reset' });
    await audit(req, 'staff_member.password_reset', 'StaffMember', req.params.id, `Reset a staff login password${mail.emailedTo ? `; emailed to ${mail.emailedTo}` : ''}`);
    res.json({ ...out, ...mail });
  });
  for (const [path, status] of [['deactivate', 'inactive'], ['reactivate', 'active']]) {
    r.post(`/:id/${path}`, async (req, res) => {
      const s = await svc.setStaffStatus(req.ctx, scope, req.params.id, status);
      await audit(req, `staff_member.${path}d`, 'StaffMember', s._id, `${s.name} ${status}`);
      res.json(s);
    });
  }
  return r;
}

export function designationRoutes(scope) {
  const r = Router();
  r.get('/', async (req, res) => res.json(await svc.listDesignations(req.ctx, scope)));
  r.post('/', async (req, res) => {
    const d = await svc.createDesignation(req.ctx, scope, parse(v.designationBody, { ...req.body, group: groupOf(scope), ...(scope === 'transport' ? {} : { busRole: null }) })); // each desk's titles belong to its own group
    await audit(req, 'designation.created', 'Designation', d._id, `Added designation ${d.name}`);
    res.status(201).json(d);
  });
  r.patch('/:id', async (req, res) => res.json(await svc.updateDesignation(req.ctx, scope, req.params.id, parse(v.designationPatch, req.body))));
  r.delete('/:id', async (req, res) => { await svc.deleteDesignation(req.ctx, scope, req.params.id); await audit(req, 'designation.deleted', 'Designation', req.params.id, 'Deleted a designation'); res.json({ ok: true }); });
  return r;
}

/** Mounted inside the School Admin portal. */
export const adminRoutes = Router();
adminRoutes.use('/support-staff', staffRoutes('general'));
adminRoutes.use('/designations', designationRoutes('general'));
adminRoutes.use('/teacher-designations', designationRoutes('teaching')); // the ranks of teachers: PGT, TGT, Head of Department…
