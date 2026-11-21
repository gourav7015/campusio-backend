import crypto from 'node:crypto';
import { JobLease } from '../models/index.js';
import { logger } from '../core/logger.js';

const holder = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

/** Takes the named lease for `ttlMs`; true when this server now holds it. Another server holding it (not yet expired) means "skip this round". */
export async function takeLease(name, ttlMs) {
  const now = new Date();
  try {
    const got = await JobLease.findOneAndUpdate({ name, until: { $lt: now } }, { $set: { holder, until: new Date(now.getTime() + ttlMs) } }, { upsert: true, new: true });
    return got?.holder === holder;
  } catch (e) { if (e?.code === 11000) return false; throw e; } // the lease exists and has not expired
}

/** Runs `fn` on a schedule, but only on the server that holds the lease at that moment. */
export function schedule(name, everyMs, fn, { leaseMs = everyMs } = {}) {
  const tick = async () => {
    try {
      if (!(await takeLease(name, leaseMs))) return;
      const out = await fn();
      if (out) logger.info(`job ${name}`, { result: out });
    } catch (e) { logger.warn(`job ${name} failed`, { error: e.message }); }
  };
  const t = setInterval(tick, everyMs); t.unref();
  return () => clearInterval(t);
}
