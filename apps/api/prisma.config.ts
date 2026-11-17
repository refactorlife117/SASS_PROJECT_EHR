import { existsSync } from 'node:fs';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 does not auto-load .env; load the repo-root one when present.
const rootEnv = new URL('../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// Migrations always run as the OWNER role. The app role (DATABASE_URL) is never used here.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  // Only migrate/seed need a database; `prisma generate` (Docker builds, CI) must work without one.
  ...(process.env.MIGRATE_DATABASE_URL ? { datasource: { url: env('MIGRATE_DATABASE_URL') } } : {}),
});
