// A simple load test: N pretend users sign in as the School Admin and keep reading the busiest pages for D seconds.
//   node src/scripts/loadtest.js --url http://localhost:4010 --login admin@gps.test --password 'Admin@12345' --users 30 --seconds 20
// Use it on a demo or staging copy, never on a live school. It only reads (GET).
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const url = arg('url', 'http://localhost:4010'); const loginId = arg('login', 'admin@gps.test'); const password = arg('password', 'Admin@12345');
const users = Number(arg('users', 20)); const seconds = Number(arg('seconds', 15));
const PATHS = ['/api/auth/me', '/api/school/dashboard', '/api/school/students?limit=25', '/api/school/teachers', '/api/school/classes', '/api/school/attendance-overview', '/api/school/houses', '/api/school/leave', '/health'];

const res = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId, password, portal: 'admin' }) });
if (!res.ok) { console.error(`Sign-in failed (${res.status}): ${await res.text()}`); process.exit(1); }
const { token } = await res.json();
const h = { Authorization: `Bearer ${token}` };

const lat = []; const status = new Map(); let stop = false;
async function user(id) {
  for (let i = id; !stop; i++) {
    const p = PATHS[i % PATHS.length]; const t0 = performance.now();
    try { const r = await fetch(url + p, { headers: h }); await r.arrayBuffer(); lat.push(performance.now() - t0); status.set(r.status, (status.get(r.status) || 0) + 1); }
    catch { status.set('network error', (status.get('network error') || 0) + 1); }
  }
}
console.log(`Load test: ${users} users for ${seconds}s against ${url}`);
const start = Date.now();
setTimeout(() => { stop = true; }, seconds * 1000);
await Promise.all(Array.from({ length: users }, (_, i) => user(i)));
const secs = (Date.now() - start) / 1000;
lat.sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]?.toFixed(0);
console.log(`Requests: ${lat.length} (${(lat.length / secs).toFixed(0)}/s)  median ${pct(0.5)} ms  95th ${pct(0.95)} ms  99th ${pct(0.99)} ms  slowest ${lat[lat.length - 1]?.toFixed(0)} ms`);
console.log(`Answers: ${[...status].map(([k, v]) => `${k}: ${v}`).join(', ')}`);
const bad = [...status].filter(([k]) => k !== 200).reduce((n, [, v]) => n + v, 0);
process.exit(bad ? 1 : 0);
