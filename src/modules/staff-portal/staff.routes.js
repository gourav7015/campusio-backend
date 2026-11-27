import { Router } from 'express';
import { z } from 'zod';
import { parse, forbidden } from '../../core/utils.js';
import { StaffLeave, LeaveApplication } from '../../models/index.js';
import { getRegister } from '../staff-attendance/staff-attendance.service.js';
import { listEmployees } from '../employees/employees.service.js';
import { handlerSummary } from '../helpdesk/helpdesk.service.js';
import { listStaff } from '../support-staff/support-staff.service.js';

/**
 * The Staff portal is the office desk: a member of staff the School Admin has given the desk works for the admin from here.
 * They take the attendance of teachers and non-teaching staff, record and look after the leave of non-teaching staff, look people up
 * in the employee list, and answer the queries teachers send to the office. It is not a personal portal: there is no check-in,
 * no own attendance, no payslips. Transport crew are never part of it. Every route here is behind the desk gate (modules/index.js).
 */
const r = Router();

r.get('/profile', async (req, res) => {
  const { staff, designation } = req.ctx;
  res.json({ name: staff.name, staffId: staff.staffId, designation: designation?.name, phone: staff.phone, address: staff.address, joiningDate: staff.joiningDate });
});
r.patch('/profile', async (req, res) => {
  const b = parse(z.object({ phone: z.string().trim().max(20).optional(), address: z.string().trim().max(300).optional() }), req.body);
  Object.assign(req.ctx.staff, b);
  await req.ctx.staff.save();
  res.json({ ok: true });
});

/** Where each register stands today, what waits for a decision, and how many queries are open. */
r.get('/dashboard', async (req, res) => {
  const { ctx } = req;
  const groups = [['teachers', 'Teachers'], ['general', 'Non-teaching staff'], ['office', 'Officers']];
  const regs = await Promise.all(groups.map(async ([g, name]) => {
    const x = await getRegister(ctx, g, ctx.today);
    return { group: g, name, people: x.totals.people, present: x.totals.present + x.totals.late + x.totals.halfDay, absent: x.totals.absent, leave: x.totals.leave, submitted: x.session?.status === 'submitted', blocked: x.blocked || null };
  }));
  const [staffLeave, teacherLeave, queries] = await Promise.all([
    StaffLeave.countDocuments({ tenantId: ctx.tenantId, group: 'general', status: 'submitted' }),
    LeaveApplication.countDocuments({ tenantId: ctx.tenantId, status: 'submitted' }),
    handlerSummary('school', ctx.tenantId, req.user),
  ]);
  res.json({ today: ctx.today, name: ctx.staff.name, designation: ctx.designation?.name, registers: regs, pendingStaffLeave: staffLeave, pendingTeacherLeave: teacherLeave, openQueries: queries.count });
});

/** The non-teaching staff, for choosing whose leave to record. */
r.get('/people', async (req, res) => res.json(await listStaff(req.ctx, 'general', { status: 'active', page: 1, limit: 200 })));

/** The employee list: teachers, non-teaching staff and officers. The transport crew belong to the Transport officer, and what anyone earns is not here. */
const query = z.object({
  category: z.enum(['teaching', 'non_teaching', 'office']).default('teaching'), q: z.string().trim().max(100).optional(), designation: z.string().trim().max(60).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('active'), limit: z.coerce.number().int().min(1).max(1000).default(500),
});
r.get('/employees', async (req, res) => {
  if (req.query.category === 'transport') throw forbidden('The transport crew are looked after by the Transport officer');
  res.json(await listEmployees(req.ctx, parse(query, req.query)));
});

export default r;
