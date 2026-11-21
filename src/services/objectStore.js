import { AwsClient } from 'aws4fetch';
import { config } from '../core/config.js';

/**
 * A private bucket on Cloudflare R2 (or any S3-compatible store). Nothing in it is public: every read goes through the app, which first checks who is asking.
 * Requests are signed with the bucket's access key (AWS Signature V4); R2 encrypts everything it stores.
 */
let client;
const aws = () => (client ||= new AwsClient({ accessKeyId: config.objectStore.accessKeyId, secretAccessKey: config.objectStore.secretAccessKey, service: 's3', region: 'auto' }));
const url = (key) => `${config.objectStore.endpoint}/${config.objectStore.bucket}/${String(key).split('/').map(encodeURIComponent).join('/')}`;
export const objectStoreEnabled = () => config.objectStore.enabled;
/** For tests: forget the cached signer after the settings change. */
export const resetObjectStore = () => { client = undefined; };

const fail = (what, res) => new Error(`Object store ${what} failed (${res.status})`);

export async function putObject(key, bytes, contentType = 'application/octet-stream') {
  const res = await aws().fetch(url(key), { method: 'PUT', body: bytes, headers: { 'content-type': contentType } });
  if (!res.ok) throw fail('upload', res);
}
/** The object as a fetch Response (stream the body), or null when it is not there. */
export async function getObject(key) {
  const res = await aws().fetch(url(key), { method: 'GET' });
  if (res.status === 404) return null;
  if (!res.ok) throw fail('download', res);
  return res;
}
export async function hasObject(key) {
  const res = await aws().fetch(url(key), { method: 'HEAD' });
  if (res.status === 404) return false;
  if (!res.ok) throw fail('check', res);
  return true;
}
export async function deleteObject(key) {
  const res = await aws().fetch(url(key), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw fail('delete', res);
}
