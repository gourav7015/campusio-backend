/** Development helper: in-memory MongoDB + API + a populated demo school. Not for production. */
if (process.env.NODE_ENV === 'production') { console.error('This script creates accounts with published demo passwords and must never run in production.'); process.exit(1); }
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS || '6';
process.env.LOGIN_RATE_LIMIT = process.env.LOGIN_RATE_LIMIT || '1000'; // demo/e2e only: many scripted sign-ins
process.env.API_RATE_LIMIT = process.env.API_RATE_LIMIT || '100000';
const mongod = await MongoMemoryServer.create();
process.env.MONGO_URI = mongod.getUri('school_erp_demo');

const { config } = await import('./core/config.js');
const { createApp } = await import('./app.js');
// Browser tests: pretend email works, and write each one to a file so a test can read the code (demo only; this script refuses to run in production)
if (process.env.DEMO_MESSAGES_FILE) {
  const fs = await import('node:fs');
  const { setMailTransport } = await import('./services/email.js');
  setMailTransport(async (m) => { fs.appendFileSync(process.env.DEMO_MESSAGES_FILE, `${JSON.stringify({ channel: 'email', to: m.to, text: m.text })}\n`); return {}; });
}
const { buildDemo, DEMO } = await import('./demo-data.js');
await mongoose.connect(config.mongoUri);
await mongoose.syncIndexes();
const app = createApp();
// Browser tests only (this script never runs in production): put the demo school back to "attendance once a day" with nothing taken today,
// so a test can switch the way attendance is taken from today without leaving the shared demo in the other way. POST /__demo/attendance-reset
const { createServer } = await import('node:http');
const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/__demo/attendance-reset') {
    const M = await import('./models/index.js'); const { forgetMemo } = await import('./core/memo.js'); const { todayStr } = await import('./core/utils.js');
    const gps = await M.School.findOne({ code: 'gps' });
    const today = todayStr(gps.settings?.timezone);
    gps.settings = { ...gps.settings, attendance: { ...(gps.settings?.attendance || {}), periodWise: false, modeSchedule: [] } };
    gps.markModified('settings'); await gps.save(); forgetMemo();
    const tenantId = gps._id;
    const sessions = await M.AttendanceSession.find({ tenantId, $or: [{ date: today }, { source: 'periods' }] }).select('_id').lean();
    await M.AttendanceRecord.deleteMany({ sessionId: { $in: sessions.map((x) => x._id) } });
    await M.AttendanceSession.deleteMany({ _id: { $in: sessions.map((x) => x._id) } });
    await M.PeriodAttendanceSession.deleteMany({ tenantId });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, today })); return;
  }
  app(req, res);
}).listen(config.port);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${config.port}`;
console.log(`API on ${base} — building demo school…`);
const info = await buildDemo(base);
if (process.env.DEMO_PREVIOUS_YEAR) { // opt-in: give the demo school an earlier year, so a student's past results can be looked at
  const { addPreviousYear } = await import('./sample-previous-year.js');
  const { School } = await import('./models/index.js');
  const gps = await School.findOne({ code: 'gps' });
  console.log('Earlier year:', JSON.stringify(await addPreviousYear({ tenantId: gps._id, classNames: ['Class 8'] })));
}
console.log(`\nDemo ready. Open http://localhost:5173 — each role has its own sign-in page (/student/login, /teacher/login, /finance/login, /library/login, /admin/login, /platform/login):\n`);
console.log(`  Super Admin : ${DEMO.superAdmin.loginId} / ${DEMO.superAdmin.password}`);
console.log(`  School Admin: ${DEMO.admin.loginId} / ${DEMO.admin.password}`);
console.log(`  Finance     : ${DEMO.finance.loginId} / ${DEMO.finance.password}`);
console.log(`  Library     : ${DEMO.library.loginId} / ${DEMO.library.password}`);
console.log(`  Transport   : ${DEMO.transport.loginId} / ${DEMO.transport.password}`);
console.log(`  Staff       : ${DEMO.staff.loginId} / ${DEMO.staff.password}`);
console.log(`  Teacher     : sharma@gps.test (Maths, class teacher 8-A) / ${DEMO.teacherPassword}   (also gupta@, verma@, singh@, khan@, rao@gps.test)`);
console.log(`  Student     : ${info.rahul.loginId} / ${DEMO.studentPassword}   (Class 8-A)\n`);
process.on('SIGINT', async () => { server.close(); await mongoose.disconnect(); await mongod.stop(); process.exit(0); });
