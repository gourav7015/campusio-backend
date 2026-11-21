import { config } from './config.js';

/**
 * A tiny in-memory cache for things that are read on every request and almost never change (the school record, its subscription, the current
 * academic year). Entries live for config.memoSeconds and are cleared as soon as anything that could change them is saved on this server;
 * another server (if there are several) sees a change within that many seconds. A person's session and account are NOT cached here:
 * disabling someone must cut them off on their very next request.
 */
const store = new Map();
const ttl = () => config.memoSeconds * 1000;

export async function memo(key, load) {
  const ms = ttl();
  if (!ms) return load();
  const hit = store.get(key);
  if (hit && hit.exp > Date.now()) return hit.p;
  const p = (async () => load())(); // a real promise (a database query can only be awaited once)
  store.set(key, { p, exp: Date.now() + ms });
  try { const v = await p; if (v == null) store.delete(key); return v; } catch (e) { store.delete(key); throw e; }
}

export const forgetMemo = () => store.clear();

/** Register on a schema (before the model is built) so any write to it clears the cache. */
export function forgetOnWrite(schema) {
  schema.post(['save', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'replaceOne', 'deleteOne', 'deleteMany', 'insertMany', 'bulkWrite'], () => forgetMemo());
  schema.post('deleteOne', { document: true, query: false }, () => forgetMemo());
  return schema;
}
