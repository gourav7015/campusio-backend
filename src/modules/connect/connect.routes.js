import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../../core/config.js';
import { parse } from '../../core/utils.js';
import * as svc from './connect.service.js';

const text = (n) => z.string().trim().max(n);
const optional = (n) => text(n).optional().or(z.literal('')).transform((v) => v || undefined);

/** Public, no sign-in: the Connect page's team and hours, and its message form. */
export const publicRoutes = Router();
publicRoutes.get('/', async (_req, res) => { res.set('Cache-Control', 'public, max-age=60'); res.json(await svc.publicView()); });
const messageLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 6, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many messages from this connection. Please try again in an hour, or write to us by email.', code: 'RATE_LIMIT' }, skip: () => config.env === 'test' });
const messageBody = z.object({
  reason: z.enum(['demo', 'price', 'help', 'other']), name: text(100).min(2, 'Enter your name'), email: z.string().trim().email('Enter an email address we can reply to').max(200), school: text(150).min(2, "Enter your school's name"),
  phone: optional(20), size: optional(40), bestTime: optional(80), message: optional(2000), website: text(200).optional(), // "website" is a trap for bots: people never fill it
}).superRefine((b, c) => { if (['help', 'other'].includes(b.reason) && !b.message) c.addIssue({ code: 'custom', path: ['message'], message: 'Tell us a little about what you need' }); });
publicRoutes.post('/message', messageLimiter, async (req, res) => {
  const { website, ...b } = parse(messageBody, req.body);
  if (website) return res.status(201).json({ ref: 'AK-00000' }); // a bot: look pleased, keep nothing
  res.status(201).json(await svc.submitMessage(b, req.ip));
});

const kept = (n) => text(n).optional(); // blank is kept as blank, so a field can be cleared
export const memberBody = z.object({
  name: text(80).min(2, 'Enter a name'), role: kept(80), about: kept(300), topics: z.array(text(40).min(1)).max(6).default([]),
  phone: kept(25), whatsapp: kept(25), email: z.string().trim().email('Enter a valid email address').max(200).optional().or(z.literal('')), languages: kept(80),
  tone: z.number().int().min(1).max(4).default(1), visible: z.boolean().default(true),
});
export const settingsBody = z.object({
  title: text(120).min(3), intro: text(300).optional(), hoursNote: optional(200),
  hoursDays: z.array(z.number().int().min(1).max(7)).max(7), opensAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), closesAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  mailboxes: z.array(z.object({ address: z.string().trim().email().max(200), purpose: text(100) })).max(10),
  helloTo: z.string().trim().email().max(200).optional().or(z.literal('')), supportTo: z.string().trim().email().max(200).optional().or(z.literal('')),
}).refine((s) => s.closesAt > s.opensAt, { message: 'Closing time must be after opening time', path: ['closesAt'] });
