import { Router } from 'express';
import { parse } from '../../core/utils.js';
import { z } from 'zod';
import * as v from '../staff-leave/staff-leave.validation.js';
import * as leave from '../staff-leave/staff-leave.service.js';
import * as pay from '../payroll/payroll.service.js';
import { personAttendance } from '../staff-attendance/staff-attendance.service.js';
import { StaffLeave } from '../../models/index.js';
import { selfPunchRoutes } from '../staff-punch/staff-punch.routes.js';

/** The Staff portal: a drivers', conductors', maids' or sweepers' own record. Everything is scoped to the signed-in person. */
const r = Router();
const me = (req) => req.ctx.staff;

r.get('/profile', async (req, res) => {
  const { staff, designation } = req.ctx;
  res.json({ name: staff.name, staffId: staff.staffId, designation: designation?.name, group: req.ctx.group, phone: staff.phone, address: staff.address, joiningDate: staff.joiningDate, licenseNo: staff.licenseNo, licenseExpiry: staff.licenseExpiry,
    bank: staff.bank?.accountNo ? { bankName: staff.bank.bankName, accountNo: `••••${String(staff.bank.accountNo).slice(-4)}`, ifsc: staff.bank.ifsc } : null, statutory: { uan: staff.statutory?.uan, esiNo: staff.statutory?.esiNo } });
});
r.patch('/profile', async (req, res) => {
  const b = parse(z.object({ phone: z.string().trim().max(20).optional(), address: z.string().trim().max(300).optional() }), req.body);
  Object.assign(req.ctx.staff, b);
  await req.ctx.staff.save();
  res.json({ ok: true });
});

r.use(selfPunchRoutes((req) => ({ type: 'staff', id: req.ctx.staff._id, group: req.ctx.group })));
r.get('/my-attendance', async (req, res) => res.json(await personAttendance(req.ctx, 'staff', me(req)._id, { joiningDate: me(req).joiningDate, group: req.ctx.group })));

r.get('/dashboard', async (req, res) => {
  const { ctx } = req; const staff = me(req);
  const [att, balances, pending, last] = await Promise.all([
    personAttendance({ ...ctx, year: ctx.year || { startDate: `${ctx.today.slice(0, 4)}-01-01`, endDate: `${ctx.today.slice(0, 4)}-12-31` } }, 'staff', staff._id, { joiningDate: staff.joiningDate, group: ctx.group }),
    leave.balances(ctx, staff._id), StaffLeave.countDocuments({ tenantId: ctx.tenantId, staffId: staff._id, status: 'submitted' }),
    pay.myPayslips(ctx).then((x) => x[0] || null),
  ]);
  res.json({ today: ctx.today, name: staff.name, designation: ctx.designation?.name, attendance: att.summary, balances, pendingLeave: pending, lastPayslip: last && { id: last._id, month: last.month, net: last.net, status: last.status } });
});

// leave
r.get('/leave', async (req, res) => res.json({ balances: await leave.balances(req.ctx, me(req)._id), applications: await leave.listMine(req.ctx) }));
r.post('/leave', async (req, res) => res.status(201).json(await leave.apply(req.ctx, parse(v.applyBody, req.body))));
r.post('/leave/:id/cancel', async (req, res) => res.json(await leave.cancel(req.ctx, req.params.id)));

// pay
r.get('/salary', async (req, res) => res.json(await pay.mySalary(req.ctx)));
r.get('/payslips', async (req, res) => res.json(await pay.myPayslips(req.ctx)));
r.get('/payslips/:id/pdf', async (req, res) => {
  const p = await pay.ownPayslip(req.ctx, req.params.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="payslip-${p.payslipNo}.pdf"`);
  await pay.renderPayslip(req.tenantId, p, res);
});
export default r;
