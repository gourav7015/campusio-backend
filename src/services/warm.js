import mongoose from 'mongoose';
import { School } from '../models/index.js';

/**
 * One real round trip to the database (a ping and a tiny indexed read), so the connection pool is open and the database's
 * cache is warm when a person's first request arrives. Used by /health/warm (called from outside every few minutes) and by a timer in the server.
 */
export const warmStats = { runs: 0 };
export async function warmDatabase() {
  const t = Date.now();
  await mongoose.connection.db.admin().ping();
  await School.findOne().select('_id').lean();
  warmStats.runs += 1;
  return Date.now() - t;
}

/**
 * The public address can be opened by anyone, so however often it is hit, the database is asked at most once every few seconds:
 * answers in between repeat the last result, and requests arriving together share one round trip.
 */
let last = null; let inflight = null;
export function warmShared(maxAgeMs = 10_000) {
  if (last && Date.now() - last.at < maxAgeMs) return Promise.resolve(last.ms);
  inflight ||= warmDatabase().then((ms) => { last = { at: Date.now(), ms }; return ms; }).finally(() => { inflight = null; });
  return inflight;
}
