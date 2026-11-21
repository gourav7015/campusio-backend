import mongoose from 'mongoose';
import { config, requireMongoUri } from './core/config.js';
import { logger } from './core/logger.js';
import { createApp } from './app.js';
import { runAllReminders } from './modules/class-life/class-life.service.js';
import { autoCloseResolved } from './modules/helpdesk/helpdesk.service.js';
import { tidyOrders } from './modules/payments/payments.service.js';
import { schedule } from './services/jobs.js';
import { startEmailWorker, flushEmails } from './services/email.js';
import { runMigrations } from './core/migrations.js';
import { alert } from './services/alerts.js';
import { runRetention } from './services/retention.js';
import { busDocumentReminders } from './modules/transport/transport.service.js';

mongoose.set('strictQuery', true);

async function main() {
  await mongoose.connect(requireMongoUri(), { serverSelectionTimeoutMS: 10000, maxPoolSize: 20 });
  // Build indexes (unique constraints enforce tenant-scoped rules) before taking traffic.
  await mongoose.connection.syncIndexes?.().catch((e) => logger.warn('index sync skipped', { error: e.message }));
  if (config.migrateOnStart) await runMigrations();
  const app = createApp();
  const server = app.listen(config.port, () => logger.info('api listening', { port: config.port, env: config.env, version: config.version }));
  server.requestTimeout = 120000; server.headersTimeout = 65000; server.keepAliveTimeout = 61000; // slower than a load balancer's idle limit, so connections are not cut mid-request

  // Scheduled work takes a lease first, so with several servers each job still runs once.
  // families that have not acknowledged a teacher's remark are reminded once a day (checked every few hours)
  const stops = [
    schedule('remark-reminders', 3 * 60 * 60 * 1000, () => runAllReminders().then((n) => n && { sent: n })),
    // resolved help desk tickets that nobody reopened are closed after a week
    schedule('ticket-tidy', 3 * 60 * 60 * 1000, () => autoCloseResolved().then((n) => n && { closed: n })),
    // online payment orders nobody paid are closed (checked every few minutes)
    schedule('payment-order-tidy', 5 * 60 * 1000, () => tidyOrders().then((n) => n && { tidied: n })),
    // vehicle documents about to expire: the transport officer is told at 30 days, 7 days and on expiry
    schedule('bus-document-reminders', 6 * 60 * 60 * 1000, () => busDocumentReminders().then((n) => n && { sent: n })),
    // old notifications, mail records and ended sessions are cleared out once a day (docs/DATA_RETENTION.md)
    schedule('retention', 24 * 60 * 60 * 1000, () => runRetention()),
  ];
  stops.push(startEmailWorker());
  alert('Server started', `version ${config.version}`, { everyMs: 60 * 1000 });
  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    stops.forEach((stop) => stop());
    server.close(async () => {
      await flushEmails().catch(() => {});
      await mongoose.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => { logger.error('unhandledRejection', { error: String(e) }); alert('Unhandled promise rejection', String(e)); });
}

main().catch((e) => { logger.error('startup failed', { error: e.message }); process.exit(1); });
