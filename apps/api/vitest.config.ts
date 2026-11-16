import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const rootEnv = new URL('../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for tests (see .env.example)`);
  return value;
};

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/global-setup.ts'],
    // Integration tests share one real database and truncate it between tests.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      // Tests always run against slotfill_test, never the dev database.
      DATABASE_URL: required('TEST_DATABASE_URL'),
      TEST_MIGRATE_DATABASE_URL: required('TEST_MIGRATE_DATABASE_URL'),
    },
  },
});
