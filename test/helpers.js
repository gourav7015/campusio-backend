import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { User, School, Subscription, defaultSettings } from '../src/models/index.js';
import { hashPassword } from '../src/services/users.js';

let mongod;
export let app;
export let api;

export async function setup() {
  process.env.NODE_ENV = 'test';
  mongod = await MongoMemoryServer.create();
  // generous timeouts: a busy laptop can stall the throw-away database for a few seconds while indexes are built
  await mongoose.connect(mongod.getUri(), { dbName: 'test', serverSelectionTimeoutMS: 60000, socketTimeoutMS: 120000, heartbeatFrequencyMS: 30000, connectTimeoutMS: 60000 });
  for (let attempt = 1; ; attempt++) {
    try { await mongoose.syncIndexes(); break; } catch (e) { if (attempt >= 3) throw e; await new Promise((r) => setTimeout(r, 1000)); }
  }
  app = createApp();
  api = () => request(app);
}
export async function teardown() {
  await mongoose.disconnect();
  await mongod?.stop();
}
export async function reset() {
  const cols = await mongoose.connection.db.collections();
  await Promise.all(cols.map((c) => c.deleteMany({})));
}

export async function makeSuperAdmin() {
  await User.create({ role: 'super_admin', loginId: 'root@platform.test', name: 'Root', passwordHash: await hashPassword('Root@12345'), mustChangePassword: false });
  return login('root@platform.test', 'Root@12345', 'platform');
}

const PORTALS = ['student', 'teacher', 'finance', 'library', 'admin', 'platform'];
/** Sign in through the portal that matches the account's role (each role has its own login page). */
export async function login(loginId, password, portal) {
  let last;
  for (const p of portal ? [portal] : PORTALS) {
    const res = await api().post('/api/auth/login').send({ loginId, password, portal: p });
    if (res.status === 200) return { token: res.body.token, user: res.body.user, h: { Authorization: `Bearer ${res.body.token}` } };
    last = res;
    if (res.status === 401) break; // wrong credentials: no point trying other portals
  }
  throw new Error(`login failed ${last.status} ${JSON.stringify(last.body)}`);
}

/** Create a school through the Super Admin API and sign in as its School Admin. */
export async function makeSchool(root, code, opts = {}) {
  const res = await api().post('/api/platform/schools').set(root.h).send({
    name: `${code} School`, code, subscription: { status: 'active' },
    admin: { name: `${code} Admin`, email: `admin@${code}.test`, password: 'Admin@12345' },
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  const admin = await login(`admin@${code}.test`, 'Admin@12345', 'admin');
  return { id: res.body.school._id, code, admin, h: admin.h };
}
export { School, Subscription, defaultSettings };

const post = (h, path, body) => api().post(path).set(h).send(body);

/**
 * Standard world built purely through the public API (so every setup step is also exercised):
 * 1 school, current year 2026-27, Class 8 (A cap 3, B), Class 9, 2 teachers, 3 students in 8-A,
 * Mr Sharma teaches Maths 8-A and is class teacher of 8-A, Mrs Gupta teaches English 8-A, 3 periods.
 * Subjects are created through the teachers (there is no subject master list).
 */
export async function seedWorld(root, code = 'dps') {
  const s = await makeSchool(root, code);
  const h = s.h;
  const year = (await post(h, '/api/school/years', { name: '2026-2027', startDate: '2026-04-01', endDate: '2027-03-31' })).body;
  const c8 = (await post(h, '/api/school/classes', { name: 'Class 8' })).body;
  const c9 = (await post(h, '/api/school/classes', { name: 'Class 9' })).body;
  const sec8A = (await post(h, '/api/school/sections', { yearId: year._id, classId: c8._id, name: 'A', capacity: 3, room: '101' })).body;
  const sec8B = (await post(h, '/api/school/sections', { yearId: year._id, classId: c8._id, name: 'B', capacity: 30, room: '102' })).body;
  const t1 = (await post(h, '/api/school/teachers', { name: 'Mr Sharma', employeeId: 'T001', email: `sharma@${code}.test`, subjects: ['Mathematics'] })).body;
  const t2 = (await post(h, '/api/school/teachers', { name: 'Mrs Gupta', employeeId: 'T002', email: `gupta@${code}.test`, subjects: ['English'] })).body;
  const subjects = (await api().get('/api/school/subjects').set(h)).body;
  const maths = subjects.find((x) => x.name === 'Mathematics'); const eng = subjects.find((x) => x.name === 'English');
  const asgM = (await post(h, '/api/school/teaching-assignments', { teacherId: t1.teacher._id, sectionId: sec8A._id, subjectId: maths._id, effectiveFrom: '2026-04-01' })).body;
  const asgE = (await post(h, '/api/school/teaching-assignments', { teacherId: t2.teacher._id, sectionId: sec8A._id, subject: 'English', effectiveFrom: '2026-04-01' })).body;
  await api().put(`/api/school/sections/${sec8A._id}/class-teacher`).set(h).send({ teacherId: t1.teacher._id, effectiveFrom: '2026-04-01' });
  const periods = [];
  const times = [['08:00', '08:40'], ['08:40', '09:20'], ['09:20', '10:00']];
  for (let i = 0; i < times.length; i++) periods.push((await post(h, '/api/school/timetable/periods', { name: `Period ${i + 1}`, order: i + 1, startTime: times[i][0], endTime: times[i][1] })).body);
  const mkStudent = async (name, dob, sectionId = sec8A._id) => (await post(h, '/api/school/students', { name, dob, sectionId, admissionDate: '2026-04-15', guardians: [{ name: `Parent of ${name}`, relationship: 'Father', phone: '9876543210', isPrimary: true }] })).body;
  const st = [await mkStudent('Aarav Singh', '2013-01-10'), await mkStudent('Bhavna Rao', '2013-02-11'), await mkStudent('Chirag Das', '2013-03-12')];
  const tLogin1 = await login(t1.credentials.loginId, t1.credentials.temporaryPassword, 'teacher');
  const tLogin2 = await login(t2.credentials.loginId, t2.credentials.temporaryPassword, 'teacher');
  const sLogin = await Promise.all(st.map((x) => login(x.credentials.loginId, x.credentials.temporaryPassword, 'student')));
  return { ...s, year, c8, c9, sec8A, sec8B, maths, eng, t1, t2, asgM, asgE, periods, students: st, teacher1: tLogin1, teacher2: tLogin2, studentLogins: sLogin, post };
}
