import mongoose from 'mongoose';
import { config, requireMongoUri } from './core/config.js';
import { logger } from './core/logger.js';
import { createApp } from './app.js';

mongoose.set('strictQuery', true);

async function main() {
  await mongoose.connect(requireMongoUri(), { serverSelectionTimeoutMS: 10000, maxPoolSize: 20 });
  // Build indexes (unique constraints enforce tenant-scoped rules) before taking traffic.
  await mongoose.connection.syncIndexes?.().catch((e) => logger.warn('index sync skipped', { error: e.message }));
  const app = createApp();
  const server = app.listen(config.port, () => logger.info('api listening', { port: config.port, env: config.env }));

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
