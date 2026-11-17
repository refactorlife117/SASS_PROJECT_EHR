/* eslint-disable no-console -- CLI script output */
// One-time (idempotent) database setup for managed Postgres (e.g. RDS), run as the OWNER role before
// `prisma migrate deploy`. Mirrors docker/postgres/init/01-roles.sql for local dev:
//   - the runtime role `slotfill_app` (login, not superuser, NO BYPASSRLS) with APP_DB_PASSWORD
//   - its connect/usage grants and default privileges
//   - the `pgboss` schema owned by the app role (pg-boss runs with createSchema: false)
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

const ownerUrl = process.env.MIGRATE_DATABASE_URL;
const appPassword = process.env.APP_DB_PASSWORD;
if (!ownerUrl) throw new Error('MIGRATE_DATABASE_URL is required');
if (!appPassword || appPassword.length < 12)
  throw new Error('APP_DB_PASSWORD (12+ chars) is required');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: ownerUrl }) });
const run = (sql: string) => prisma.$executeRawUnsafe(sql);

try {
  await run(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'slotfill_app') THEN
      CREATE ROLE slotfill_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  // Password via format(%L) so it is quoted safely (ALTER ROLE can't take bind parameters).
  const [statement] = await prisma.$queryRaw<{ sql: string }[]>`
    SELECT format('ALTER ROLE slotfill_app WITH LOGIN PASSWORD %L', ${appPassword}::text) AS sql`;
  if (!statement) throw new Error('could not build ALTER ROLE statement');
  await run(statement.sql);

  const [{ db } = { db: '' }] = await prisma.$queryRaw<
    { db: string }[]
  >`SELECT current_database() AS db`;
  await run(`GRANT CONNECT ON DATABASE "${db.replaceAll('"', '""')}" TO slotfill_app`);
  await run('GRANT USAGE ON SCHEMA public TO slotfill_app');
  await run(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO slotfill_app',
  );
  await run(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO slotfill_app',
  );
  // To create a schema owned by another role, the owner must be able to act as it.
  await run('GRANT slotfill_app TO CURRENT_USER');
  await run('CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION slotfill_app');
  console.log('Database bootstrap complete (role slotfill_app, schema pgboss).');
} finally {
  await prisma.$disconnect();
}
