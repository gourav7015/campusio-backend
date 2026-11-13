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
const { buildDemo, DEMO } = await import('./demo-data.js');
await mongoose.connect(config.mongoUri);
await mongoose.syncIndexes();
const server = createApp().listen(config.port);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${config.port}`;
console.log(`API on ${base} — building demo school…`);
const info = await buildDemo(base);
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
