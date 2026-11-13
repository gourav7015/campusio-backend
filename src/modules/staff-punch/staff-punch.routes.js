import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/utils.js';
import * as svc from './staff-punch.service.js';

const coords = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional();
const body = z.object({ location: coords });

/** Self check-in / check-out for the signed-in person. `who(req)` says who that is: { type, id, group }. */
export function selfPunchRoutes(who) {
  const r = Router();
  r.get('/punch', async (req, res) => res.json(await svc.today(req.ctx, who(req))));
  r.post('/punch/check-in', async (req, res) => res.status(201).json(await svc.checkIn(req.ctx, who(req), parse(body, req.body).location)));
  r.post('/punch/check-out', async (req, res) => res.json(await svc.checkOut(req.ctx, who(req), parse(body, req.body).location)));
  return r;
}
