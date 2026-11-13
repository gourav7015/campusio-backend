import { Router } from 'express';
import { parse } from '../../core/utils.js';
import * as v from './library.validation.js';
import * as svc from './library.service.js';

/** Students and teachers see their own loans and can browse the catalogue; they cannot touch circulation. */
export function selfRoutes(type) {
  const r = Router();
  const me = (req) => (type === 'student' ? req.ctx.student._id : req.ctx.teacher._id);
  r.get('/library/loans', async (req, res) => res.json(await svc.myLoans(req.ctx, type, me(req))));
  r.get('/library/books', async (req, res) => {
    const out = await svc.listBooks(req.tenantId, parse(v.booksQuery, req.query));
    // catalogue view: availability only, no copy-level or borrower details
    res.json({ ...out, items: out.items.map((b) => ({ _id: b._id, title: b.title, author: b.author, category: b.category, language: b.language, shelf: b.shelf, available: b.available, total: b.total })) });
  });
  return r;
}
