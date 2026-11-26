import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import { ClassModel, Section } from '../../models/index.js';
import * as v from './library.validation.js';
import * as svc from './library.service.js';

const r = Router();
const csv = (res, name, body) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.send(body); };

r.get('/dashboard', async (req, res) => res.json(await svc.dashboard(req.ctx)));
// class and section names for the "By class" filters (no academic data)
r.get('/lookups', async (req, res) => {
  const [classes, sections] = await Promise.all([
    ClassModel.find({ tenantId: req.tenantId, status: 'active' }).sort({ level: 1 }).select('name').lean(),
    Section.find({ tenantId: req.tenantId, yearId: req.ctx.year?._id, status: 'active' }).select('name classId').lean(),
  ]);
  res.json({ classes, sections });
});
r.get('/class-overview', async (req, res) => res.json(await svc.classOverview(req.ctx)));
r.get('/class-borrowers', async (req, res) => res.json(await svc.classBorrowers(req.ctx, parse(z.object({
  classId: z.string().regex(/^[a-f0-9]{24}$/i).optional(), sectionId: z.string().regex(/^[a-f0-9]{24}$/i).optional(), filter: z.enum(['all', 'borrowed', 'never', 'holding']).default('all'),
}).refine((q) => q.classId || q.sectionId, { message: 'Choose a class' }), req.query))));

r.get('/books', async (req, res) => res.json(await svc.listBooks(req.tenantId, parse(v.booksQuery, req.query))));
r.post('/books', async (req, res) => {
  const out = await svc.createBook(req.ctx, parse(v.bookBody, req.body));
  await audit(req, 'library.book_added', 'Book', out.book._id, `Added "${out.book.title}" (${out.accessionNos.length} copies)`);
  res.status(201).json(out);
});
r.get('/books/:id', async (req, res) => res.json(await svc.getBook(req.ctx, req.params.id)));
r.patch('/books/:id', async (req, res) => res.json(await svc.updateBook(req.ctx, req.params.id, parse(v.bookPatch, req.body))));
r.delete('/books/:id', async (req, res) => {
  const out = await svc.deleteBook(req.ctx, req.params.id);
  await audit(req, 'library.book_deleted', 'Book', req.params.id, `${out.mode === 'deleted' ? 'Deleted' : 'Deleted (lending history kept for the records)'} "${out.title}" (${out.copies} copies)`, { mode: out.mode });
  res.json(out);
});
r.post('/books/:id/copies', async (req, res) => {
  const nos = await svc.addCopies(req.ctx, req.params.id, parse(v.addCopiesBody, req.body).count);
  await audit(req, 'library.copies_added', 'Book', req.params.id, `Added ${nos.length} copies`);
  res.status(201).json({ accessionNos: nos });
});
r.delete('/copies/:id', async (req, res) => {
  const out = await svc.deleteCopy(req.ctx, req.params.id);
  await audit(req, 'library.copy_deleted', 'BookCopy', req.params.id, out.mode === 'deleted' ? `Deleted copy ${out.accessionNo}` : `Deleted copy ${out.accessionNo} (its lending history is kept)`, { mode: out.mode });
  res.json(out);
});
r.patch('/copies/:id', async (req, res) => {
  const c = await svc.setCopyStatus(req.ctx, req.params.id, parse(v.copyStatusBody, req.body));
  await audit(req, 'library.copy_status', 'BookCopy', c._id, `${c.accessionNo} marked ${c.status}`);
  res.json(c);
});

r.get('/copies/suggest', async (req, res) => res.json(await svc.suggestCopies(req.ctx, parse(v.suggestQuery, req.query))));
r.get('/borrowers', async (req, res) => res.json(await svc.searchBorrowers(req.ctx, parse(v.borrowerQuery, req.query))));
r.post('/issue', async (req, res) => {
  const out = await svc.issueBook(req.ctx, parse(v.issueBody, req.body));
  await audit(req, 'library.issued', 'LibraryIssue', out.issue._id, `Issued "${out.book.title}" to ${out.borrower.name}`);
  res.status(201).json(out);
});
r.post('/return', async (req, res) => {
  const body = parse(v.returnBody, req.body);
  const out = await svc.returnBook(req.ctx, body);
  await audit(req, out.issue.status === 'lost' ? 'library.lost' : 'library.returned', 'LibraryIssue', out.issue._id, `Returned "${out.book?.title}"${out.fine.amount ? ` — fine ${out.fine.amount}${out.fine.waived ? ' (waived)' : ''}` : ''}`, out.fine);
  res.json(out);
});
r.post('/loans/:id/renew', async (req, res) => {
  const i = await svc.renewIssue(req.ctx, req.params.id);
  await audit(req, 'library.renewed', 'LibraryIssue', i._id, `Renewed until ${i.dueDate}`);
  res.json(i);
});
r.get('/loans', async (req, res) => res.json(await svc.listLoans(req.ctx, parse(v.loansQuery, req.query))));
r.post('/reminders', async (req, res) => {
  const out = await svc.remindOverdue(req.ctx);
  await audit(req, 'library.reminders', 'LibraryIssue', null, `Sent ${out.sent} overdue reminder(s)`);
  res.json(out);
});

r.get('/settings', async (req, res) => res.json(await svc.getSettings(req.tenantId)));
r.put('/settings', async (req, res) => {
  const s = await svc.updateSettings(req.ctx, parse(v.settingsBody, req.body));
  await audit(req, 'library.settings', 'School', req.tenantId, 'Updated library rules');
  res.json(s);
});
r.get('/export/inventory.csv', async (req, res) => csv(res, 'inventory.csv', await svc.exportInventory(req.ctx)));
r.get('/export/loans.csv', async (req, res) => csv(res, 'loans.csv', await svc.exportLoans(req.ctx, req.query.status)));

export default r;
