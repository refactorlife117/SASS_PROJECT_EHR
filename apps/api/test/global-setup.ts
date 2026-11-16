import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Apply all migrations to the test database (as the owner role) once per test run. */
export default function setup(): void {
  const migrateUrl = process.env.TEST_MIGRATE_DATABASE_URL;
  if (!migrateUrl) throw new Error('TEST_MIGRATE_DATABASE_URL must be set for tests');

  const require = createRequire(import.meta.url);
  const prismaCli = path.join(
    path.dirname(require.resolve('prisma/package.json')),
    'build',
    'index.js',
  );
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, MIGRATE_DATABASE_URL: migrateUrl },
    stdio: 'pipe',
  });
}
