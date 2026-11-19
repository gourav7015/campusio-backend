/**
 * Adds the Class 11 and 12 streams (Medical, Non-Medical, Commerce, Arts) with one section each to a school that was set up before streams existed.
 * Nothing that is already there is changed. Usage: node src/sample-streams.js http://localhost:4000 admin@dpsr.school Admin@12345
 */
const [base = 'http://localhost:4000', loginId, password] = process.argv.slice(2);
if (!loginId || !password) { console.error('Usage: node src/sample-streams.js <api url> <admin login id> <password>'); process.exit(1); }

let token;
async function call(method, path, body) {
  const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${j.error || ''}`);
  return j;
}

const login = await call('POST', '/api/auth/login', { loginId, password, portal: 'admin' });
token = login.accessToken || login.token;
const years = await call('GET', '/api/school/years');
const year = years.find((y) => y.isCurrent) || years[0];
let classes = await call('GET', '/api/school/classes');
const sections = await call('GET', `/api/school/sections?yearId=${year._id}`);
let added = 0;
for (const level of [11, 12]) for (const [st, room] of [['Medical', 'M'], ['Non-Medical', 'N'], ['Commerce', 'C'], ['Arts', 'A']]) {
  const name = `Class ${level} ${st}`;
  let cls = classes.find((c) => c.name === name);
  if (!cls) { cls = await call('POST', '/api/school/classes', { name }); added += 1; }
  const has = sections.some((s) => String(s.classId?._id || s.classId) === String(cls._id));
  if (!has) await call('POST', '/api/school/sections', { yearId: year._id, classId: cls._id, name: 'A', capacity: 45, room: `${level}${room}-201` });
}
console.log(`Streams ready: ${added} class(es) added in ${year.name}.`);
