/**
 * Brings a school that was set up before houses, registered designations and the office desk into line with them, using the school's own
 * admin login (nothing is written behind the application's back):
 *   - the school's houses are made, and every student and teacher without one of them is placed in one, evenly;
 *   - every teacher gets a rank from the registered list (PRT, TGT, PGT, Head of Department…);
 *   - the usual non-teaching jobs (PT Teacher, Accountant, Counsellor, Nurse, Computer Operator…) are registered and a few people hold them;
 *   - only the office clerks keep a Staff portal sign-in (the office desk); everyone else is on the books without one.
 * Safe to run again: what is already there is left as it is.
 * Usage: node src/sample-structure.js http://localhost:4000 admin@dpsr.school Admin@12345 [house names, comma separated]
 */
const [base = 'http://localhost:4000', loginId, password, housesArg] = process.argv.slice(2);
if (!loginId || !password) { console.error('Usage: node src/sample-structure.js <api url> <admin login id> <password> [houses]'); process.exit(1); }
const HOUSES = (housesArg ? housesArg.split(',').map((x) => x.trim()) : ['Aravali', 'Nilgiri', 'Himalaya', 'Vindhya']);
const COLORS = ['#b45309', '#1d4ed8', '#0f766e', '#7c3aed', '#be123c', '#0369a1'];

let token;
async function call(method, path, body) {
  const r = await fetch(`${base}/api/school${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${j.error || ''}`);
  return j;
}
const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId, password, portal: 'admin' }) }).then((r) => r.json());
token = login.token;
if (!token) { console.error('Could not sign in:', login.error); process.exit(1); }
const out = [];

// ── houses ──
const have = (await call('GET', '/houses')).houses.map((h) => h.name.toLowerCase());
for (const [i, name] of HOUSES.entries()) if (!have.includes(name.toLowerCase())) await call('POST', '/houses', { name, color: COLORS[i % COLORS.length], motto: ['Strong as the hills', 'Rise above', 'Reach the summit', 'Courage always', 'Together we grow', 'Always forward'][i % 6] });
const placed = await call('POST', '/houses/distribute');
out.push(`Houses: ${HOUSES.join(', ')}. Placed ${placed.students} student(s) and ${placed.teachers} teacher(s).`);

// ── teachers' ranks ──
const ranks = new Map((await call('GET', '/teacher-designations')).map((d) => [d.name.toLowerCase(), d]));
const teachers = (await call('GET', '/teachers?limit=200&status=active')).items;
let ranked = 0;
const bySubject = new Map();
for (const t of teachers) { const s = t.subjectIds?.[0]?.name || '—'; if (!bySubject.has(s)) bySubject.set(s, t); }
const special = new Map();
if (teachers[0]) special.set(String(teachers[0]._id), 'Vice Principal');
for (const t of bySubject.values()) if (!special.has(String(t._id))) special.set(String(t._id), 'Head of Department');
for (const t of teachers.filter((x) => !special.has(String(x._id))).filter((_, i) => i % 29 === 7)) special.set(String(t._id), 'Coordinator');
for (const t of teachers) {
  const want = special.get(String(t._id)) || (ranks.has(String(t.designation || '').toLowerCase()) ? ranks.get(String(t.designation).toLowerCase()).name : 'TGT');
  if (t.designationId && t.designation === want) continue;
  await call('PATCH', `/teachers/${t._id}`, { designation: want }); ranked += 1;
}
out.push(`Teachers: ${ranked} given a registered rank.`);

// ── non-teaching jobs and people ──
const jobs = new Map((await call('GET', '/designations')).map((d) => [d.name.toLowerCase(), d]));
for (const name of ['PT Teacher', 'Accountant', 'School Counsellor', 'School Nurse', 'Computer Operator']) if (!jobs.has(name.toLowerCase())) jobs.set(name.toLowerCase(), await call('POST', '/designations', { name }));
const staff = (await call('GET', '/support-staff?limit=200&status=all')).items;
const count = (n) => staff.filter((s) => s.designation === n).length;
const people = [['PT Teacher', 3, ['Vikram Chauhan', 'Rohit Solanki', 'Anita Rathod']], ['Accountant', 2, ['Mukesh Parmar', 'Hetal Doshi']], ['School Counsellor', 1, ['Dr. Anjali Mehta']], ['School Nurse', 1, ['Sister Mary Thomas']], ['Computer Operator', 2, ['Jayesh Vora', 'Pinal Trivedi']]];
let added = 0;
for (const [job, n, names] of people) for (let i = count(job); i < n; i += 1) { await call('POST', '/support-staff', { name: names[i], designationId: jobs.get(job.toLowerCase())._id, phone: `90000${String(30000 + added).slice(-5)}`, joiningDate: '2021-06-01' }); added += 1; }
out.push(`Non-teaching staff: ${added} added (PT teachers, accountants, counsellor, nurse, computer operators).`);

// ── the office desk: only the office clerks have a sign-in ──
const all = (await call('GET', '/support-staff?limit=200&status=active')).items;
const clerks = all.filter((s) => s.designation === 'Office Clerk');
const desk = new Set(clerks.slice(0, 2).map((s) => String(s._id)));
let removed = 0; let given = 0;
for (const s of all) {
  if (desk.has(String(s._id))) { if (!s.canMarkAttendance) { await call('PATCH', `/support-staff/${s._id}`, { canMarkAttendance: true }); given += 1; } continue; }
  if (s.hasLogin) { await call('POST', `/support-staff/${s._id}/remove-login`); removed += 1; }
}
out.push(`Office desk: ${desk.size} clerk(s) keep the Staff portal sign-in (${given} newly given the desk); ${removed} other sign-in(s) removed.`);
console.log(out.join('\n'));
