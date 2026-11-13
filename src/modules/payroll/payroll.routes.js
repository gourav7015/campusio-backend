import { Router } from 'express';
import { parse, notFound } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as v from './payroll.validation.js';
import * as svc from './payroll.service.js';

const csv = (res, name, body) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.send(body); };
const pdf = async (req, res, p) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="payslip-${p.payslipNo}.pdf"`);
  await svc.renderPayslip(req.tenantId, p, res);
};

/** School Admin (and Super Admin acting on a school): pay levels, salaries, payroll runs. */
export const adminRoutes = Router();
const a = adminRoutes;
const withName = (req) => { req.ctx.actorName = req.user.name; return req.ctx; };

a.get('/payroll/summary', async (req, res) => res.json(await svc.summary(req.ctx)));
a.get('/payroll/levels', async (req, res) => res.json(await svc.listLevels(req.ctx)));
a.post('/payroll/levels', async (req, res) => {
  const l = await svc.createLevel(req.ctx, parse(v.levelBody, req.body));
  await audit(req, 'payroll.level_created', 'PayLevel', l._id, `Created pay level ${l.name}`);
  res.status(201).json(l);
});
a.patch('/payroll/levels/:id', async (req, res) => {
  const l = await svc.updateLevel(req.ctx, req.params.id, parse(v.levelPatch, req.body));
  await audit(req, 'payroll.level_updated', 'PayLevel', l._id, `Updated pay level ${l.name}`);
  res.json(l);
});
a.delete('/payroll/levels/:id', async (req, res) => { await svc.deleteLevel(req.ctx, req.params.id); await audit(req, 'payroll.level_deleted', 'PayLevel', req.params.id, 'Deleted pay level'); res.json({ ok: true }); });

a.get('/payroll/salaries', async (req, res) => res.json(await svc.listSalaries(req.ctx, parse(v.listQuery, req.query))));
a.post('/payroll/salaries/bulk', async (req, res) => {
  const out = await svc.setSalaryBulk(withName(req), parse(v.bulkSalaryBody, req.body));
  await audit(req, 'payroll.salary_bulk', 'Person', null, `Applied a pay level to ${out.updated} person(s)`, { failed: out.failed.length });
  res.json(out);
});
a.get('/payroll/salaries/:personId', async (req, res) => res.json(await svc.salaryHistory(req.ctx, req.params.personId)));
a.post('/payroll/salaries/:personId', async (req, res) => {
  const out = await svc.setSalary(withName(req), req.params.personId, parse(v.salaryBody, req.body));
  await audit(req, 'payroll.salary_set', 'Person', req.params.personId, `Set salary effective ${out.effectiveFrom}: basic ${out.basic}, gross ${out.gross}`);
  res.status(201).json(out);
});

a.get('/payroll/runs', async (req, res) => res.json(await svc.listRuns(req.ctx)));
a.post('/payroll/runs', async (req, res) => {
  const run = await svc.createRun(req.ctx, parse(v.runBody, req.body));
  await audit(req, 'payroll.run_created', 'PayrollRun', run._id, `Generated payroll for ${run.month}: ${run.totals.count} payslips, net ${run.totals.net}`);
  res.status(201).json(run);
});
a.get('/payroll/runs/:id', async (req, res) => res.json(await svc.getRun(req.ctx, req.params.id)));
a.post('/payroll/runs/:id/recalculate', async (req, res) => res.json(await svc.recalculate(req.ctx, req.params.id)));
a.delete('/payroll/runs/:id', async (req, res) => { await svc.deleteRun(req.ctx, req.params.id); await audit(req, 'payroll.run_deleted', 'PayrollRun', req.params.id, 'Deleted a draft payroll'); res.json({ ok: true }); });
a.post('/payroll/runs/:id/approve', async (req, res) => {
  const run = await svc.approve(req.ctx, req.params.id);
  await audit(req, 'payroll.run_approved', 'PayrollRun', run._id, `Approved payroll ${run.month}: net ${run.totals.net}`);
  res.json(run);
});
a.post('/payroll/runs/:id/pay', async (req, res) => {
  const run = await svc.markPaid(req.ctx, req.params.id, parse(v.payBody, req.body));
  await audit(req, 'payroll.paid', 'PayrollRun', run._id, `Marked salaries paid for ${run.month} (paid so far ${run.totals.paid} of ${run.totals.net})`);
  res.json(run);
});
a.get('/payroll/runs/:id/bank-file', async (req, res) => res.json(await svc.bankFile(req.ctx, req.params.id)));
a.get('/payroll/runs/:id/bank-file.csv', async (req, res) => { const o = await svc.bankFileCsv(req.ctx, req.params.id); await audit(req, 'payroll.bank_file', 'PayrollRun', req.params.id, `Downloaded the bank transfer file for ${o.month}`); csv(res, `salary-bank-file-${o.month}.csv`, o.csv); });
a.get('/payroll/runs/:id/statutory', async (req, res) => res.json(await svc.statutoryReport(req.ctx, req.params.id)));
a.get('/payroll/runs/:id/statutory/pf-ecr.txt', async (req, res) => { const o = await svc.ecrFile(req.ctx, req.params.id); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="pf-ecr-${o.month}.txt"`); res.send(o.text); });
a.get('/payroll/runs/:id/statutory/esi.csv', async (req, res) => { const o = await svc.esiCsv(req.ctx, req.params.id); csv(res, `esi-${o.month}.csv`, o.csv); });
a.get('/payroll/runs/:id/statutory/pt.csv', async (req, res) => { const o = await svc.ptCsv(req.ctx, req.params.id); csv(res, `professional-tax-${o.month}.csv`, o.csv); });
a.get('/payroll/runs/:id/export.csv', async (req, res) => { const o = await svc.exportRun(req.ctx, req.params.id); csv(res, `payroll-${o.month}.csv`, o.csv); });
a.patch('/payroll/payslips/:id/adjustments', async (req, res) => {
  const p = await svc.adjust(req.ctx, req.params.id, parse(v.adjustBody, req.body));
  await audit(req, 'payroll.adjusted', 'Payslip', p._id, `Adjusted payslip ${p.payslipNo}: net ${p.net}`);
  res.json(p);
});
a.get('/payroll/payslips/:id/pdf', async (req, res) => { const p = await svc.ownPayslip(req.ctx, req.params.id).catch(() => { throw notFound('Payslip not found'); }); await pdf(req, res, p); });

/** Teacher portal: read-only, own data only. */
export const teacherRoutes = Router();
teacherRoutes.get('/salary', async (req, res) => res.json(await svc.mySalary(req.ctx)));
teacherRoutes.get('/payslips', async (req, res) => res.json(await svc.myPayslips(req.ctx)));
teacherRoutes.get('/payslips/:id/pdf', async (req, res) => { await pdf(req, res, await svc.ownPayslip(req.ctx, req.params.id)); });
