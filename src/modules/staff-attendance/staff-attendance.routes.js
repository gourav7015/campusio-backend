import { Router } from 'express';
import { parse, forbidden } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as v from './staff-attendance.validation.js';
import * as svc from './staff-attendance.service.js';

/** Staff attendance registers. `allowed` is the set of groups this desk may mark. */
export function attendanceRoutes(allowed) {
  const r = Router();
  const check = (group) => { if (!allowed.includes(group)) throw forbidden(`This desk does not take attendance for ${group}`); return group; };
  r.get('/register', async (req, res) => { const q = parse(v.registerQuery, req.query); res.json(await svc.getRegister(req.ctx, check(q.group), q.date)); });
  r.put('/register', async (req, res) => {
    const b = parse(v.registerBody, req.body); check(b.group);
    const out = await svc.saveRegister(req.ctx, b);
    if (b.submit) await audit(req, 'staff_attendance.submitted', 'StaffAttendance', null, `Submitted the ${b.group} register for ${b.date}: ${out.totals.absent} absent, ${out.totals.halfDay} half day, ${out.totals.leave} on leave`);
    res.json(out);
  });
  r.post('/correct', async (req, res) => {
    const b = parse(v.correctBody, req.body); check(b.group);
    const out = await svc.correct(req.ctx, b);
    await audit(req, 'staff_attendance.corrected', 'StaffAttendance', b.personId, `Corrected ${b.group} register of ${b.date} to ${b.status}: ${b.reason}`);
    res.json(out);
  });
  r.post('/punches/import', async (req, res) => {
    const b = parse(v.importBody, req.body); check(b.group);
    const out = await svc.importTimes(req.ctx, b.group, b.rows);
    await audit(req, 'staff_attendance.times_imported', 'StaffAttendance', null, `Imported check-in/out times for ${b.group}: ${out.imported} day(s) for ${out.people} people`);
    res.json(out);
  });
  r.get('/month', async (req, res) => { const q = parse(v.monthQuery, req.query); res.json(await svc.monthSummary(req.ctx, check(q.group), q.month)); });
  return r;
}

/** The registers the School Admin and the Staff attendance desk may take: teachers, non-teaching staff and office officers. Transport crew are marked by the Transport officer. */
export const DESK_GROUPS = ['teachers', 'general', 'office'];

/** Mounted inside the School Admin portal. */
export const adminRoutes = Router();
adminRoutes.use('/staff-attendance', attendanceRoutes(DESK_GROUPS));
