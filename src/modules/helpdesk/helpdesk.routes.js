import { Router } from 'express';
import fs from 'node:fs';
import mongoose from 'mongoose';
import { File } from '../../models/index.js';
import { upload, saveFile } from '../../services/files.js';
import { parse, forbidden } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import * as v from './helpdesk.validation.js';
import * as svc from './helpdesk.service.js';

/** A ticket or reply may carry up to three files (a screenshot, a PDF). They are read from a form; plain JSON still works with no files. */
export const MAX_FILES = 3;
const attach = upload.array('files', MAX_FILES);

/** Save the files that came with the request as attachments of ticket `ownerId`. If anything fails afterwards they are removed again, so nothing is left behind. */
async function withFiles(req, ownerId, run, tenantId = req.tenantId) {
  const saved = [];
  try {
    for (const f of req.files || []) saved.push(await saveFile(req, f, { kind: 'ticket', ownerType: 'ticket', ownerId, tenantId }));
    return await run(saved);
  } catch (e) {
    await Promise.all((req.files || []).map((f) => fs.promises.unlink(f.path).catch(() => {})));
    if (saved.length) await File.deleteMany({ _id: { $in: saved.map((f) => f._id) } });
    throw e;
  }
}

/**
 * The person who has the problem. Everyone except the platform administrators writes to AtKaksha support (scope 'platform'): mounted as
 * /tickets for teachers, students, staff and the finance, library and transport desks, and as /helpdesk for the School Admin and sub-admins.
 * Every query is limited to tickets this person raised.
 */
export function requesterRoutes(scope) {
  const r = Router();
  // a platform administrator acting inside a school still sees the menu item, so its count is simply zero rather than an error
  r.get('/summary', async (req, res) => res.json(req.user.role === 'super_admin' ? { count: 0 } : await svc.mySummary(req.ctx, req.user._id, scope)));
  r.use((req, _res, next) => { if (req.user.role === 'super_admin') throw forbidden('Platform administrators answer tickets, they do not raise them'); next(); });
  r.get('/', async (req, res) => res.json(await svc.listMine(req.ctx, req.user._id, scope, parse(v.listQuery, req.query))));
  r.post('/', attach, async (req, res) => {
    const _id = new mongoose.Types.ObjectId();
    const t = await withFiles(req, _id, (files) => svc.createTicket(req.ctx, req.user, scope, parse(v.createBody, req.body), { _id, files }));
    await audit(req, 'ticket.created', 'Ticket', t._id, `Help desk ticket ${t.reference}: ${t.subject}`);
    res.status(201).json(t);
  });
  r.get('/:id', async (req, res) => res.json(await svc.getMine(req.ctx, req.user._id, scope, req.params.id)));
  r.post('/:id/replies', attach, async (req, res) => res.status(201).json(await withFiles(req, req.params.id, (files) => svc.replyMine(req.ctx, req.user, scope, req.params.id, parse(v.replyBody.omit({ internal: true }), req.body), { files }))));
  r.post('/:id/files/:fileId/link', async (req, res) => res.json(await svc.linkMine(req.ctx, req.user, scope, req.params.id, req.params.fileId)));
  r.post('/:id/close', async (req, res) => res.json(await svc.closeMine(req.ctx, req.user._id, scope, req.params.id)));
  return r;
}

/**
 * The side that answers: the platform administrators, under /api/platform/helpdesk, who see every school's tickets. Internal notes are visible only here.
 * (The 'school' scope, where a school's own admin answers, is still supported by the service but is not mounted anywhere.)
 */
export function handlerRoutes(scope) {
  const r = Router();
  const tenant = (req) => (scope === 'school' ? req.tenantId : undefined);
  r.get('/summary', async (req, res) => res.json(await svc.handlerSummary(scope, tenant(req))));
  r.get('/', async (req, res) => res.json(await svc.inbox(scope, tenant(req), parse(v.listQuery, req.query), req.user._id)));
  r.get('/:id', async (req, res) => res.json(await svc.getForHandler(scope, tenant(req), req.params.id)));
  r.post('/:id/files/:fileId/link', async (req, res) => res.json(await svc.linkForHandler(scope, tenant(req), req.user, req.params.id, req.params.fileId)));
  r.post('/:id/replies', attach, async (req, res) => {
    let body;
    // a platform administrator has no school of their own: the file belongs to the school the ticket came from
    const owner = req.files?.length ? await svc.tenantOf(scope, tenant(req), req.params.id).catch(async (e) => { await Promise.all(req.files.map((f) => fs.promises.unlink(f.path).catch(() => {}))); throw e; }) : req.tenantId;
    const t = await withFiles(req, req.params.id, (files) => { body = parse(v.replyBody, req.body); return svc.replyAsHandler(scope, tenant(req), req.user, req.params.id, body, { files }); }, owner);
    if (scope === 'platform') req.tenantId = t.school?._id;
    await audit(req, body.internal ? 'ticket.note' : 'ticket.replied', 'Ticket', t._id, `${body.internal ? 'Note on' : 'Reply to'} ticket ${t.reference}`);
    res.status(201).json(t);
  });
  r.patch('/:id', async (req, res) => {
    const patch = parse(v.patchBody, req.body);
    const t = await svc.updateAsHandler(scope, tenant(req), req.user, req.params.id, patch);
    if (scope === 'platform') req.tenantId = t.school?._id;
    await audit(req, 'ticket.updated', 'Ticket', t._id, `Ticket ${t.reference} is now ${t.status}`, patch);
    res.json(t);
  });
  return r;
}

/** Wrap a router so it answers under a path prefix inside a shared stack of routers. */
export const at = (path, router) => { const r = Router(); r.use(path, router); return r; };
