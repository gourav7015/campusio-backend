import mongoose from 'mongoose';
import { config, requireMongoUri } from './core/config.js';
import { logger } from './core/logger.js';
import { createApp } from './app.js';
import { runAllReminders } from './modules/class-life/class-life.service.js';
import { autoCloseResolved } from './modules/helpdesk/helpdesk.service.js';
import { tidyOrders } from './modules/payments/payments.service.js';

mongoose.set('strictQuery', true);

async function main() {
  await mongoose.connect(requireMongoUri(), { serverSelectionTimeoutMS: 10000, maxPoolSize: 20 });
  // Build indexes (unique constraints enforce tenant-scoped rules) before taking traffic.
  await mongoose.connection.syncIndexes?.().catch((e) => logger.warn('index sync skipped', { error: e.message }));
  const app = createApp();
  const server = app.listen(config.port, () => logger.info('api listening', { port: config.port, env: config.env }));

  // families that have not acknowledged a teacher's remark are reminded once a day (checked every few hours)
  const reminders = setInterval(() => runAllReminders().then((n) => n && logger.info('remark reminders sent', { n })).catch((e) => logger.warn('reminders failed', { error: e.message })), 3 * 60 * 60 * 1000);
  reminders.unref();
  // resolved help desk tickets that nobody reopened are closed after a week
  const tidy = setInterval(() => autoCloseResolved().then((n) => n && logger.info('resolved tickets closed', { n })).catch((e) => logger.warn('ticket tidy failed', { error: e.message })), 3 * 60 * 60 * 1000);
  tidy.unref();
  // online payment orders nobody paid are closed (checked every few minutes)
  const orders = setInterval(() => tidyOrders().then((n) => n && logger.info('payment orders tidied', { n })).catch((e) => logger.warn('order tidy failed', { error: e.message })), 5 * 60 * 1000);
  orders.unref();
  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => logger.error('unhandledRejection', { error: String(e) }));
}

main().catch((e) => { logger.error('startup failed', { error: e.message }); process.exit(1); });
