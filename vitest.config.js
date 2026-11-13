import fs from 'node:fs';
import { defineConfig } from 'vitest/config';

// Tests run against a throw-away in-memory MongoDB, never against Atlas. Reuse an already-downloaded binary when there is one.
const cached = `${process.env.HOME}/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6`;
const binary = process.env.MONGOMS_SYSTEM_BINARY || (fs.existsSync(cached) ? cached : undefined);

export default defineConfig({
  test: {
    environment: 'node', testTimeout: 60000, hookTimeout: 120000, fileParallelism: false,
    env: {
      NODE_ENV: 'test', JWT_SECRET: 'test-secret', MONGOMS_VERSION: process.env.MONGOMS_VERSION || '8.2.6',
      ...(binary ? { MONGOMS_SYSTEM_BINARY: binary, MONGOMS_DISABLE_POSTINSTALL: '1' } : {}),
    },
  },
});
