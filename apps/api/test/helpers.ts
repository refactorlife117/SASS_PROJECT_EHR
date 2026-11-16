// Test-only helpers. The `admin` client connects as the OWNER role (bypasses RLS) and is used
// solely for fixtures, cleanup and assertions. Application code under test uses the app role.
import { PrismaPg } from '@prisma/adapter-pg';
import { generate } from 'otplib';
import type { Agent } from 'supertest';
import { createApp } from '../src/app';
import { createDatabase, type Database } from '../src/db/client';
import {
  createBoss,
  createJobQueue,
  createQueues,
  type JobQueue,
  type QueueName,
} from '../src/jobs/queues';
import { PrismaClient, type UserRole } from '../src/generated/prisma/client';
import { createFieldCipher } from '../src/lib/crypto';
import { createLogger } from '../src/lib/logger';
import { hashPassword } from '../src/modules/auth/passwords';

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
export const TEST_SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
export const TEST_PASSWORD = 'correct horse battery staple';

export const cipher = createFieldCipher(TEST_ENCRYPTION_KEY);
export const silentLogger = createLogger({ level: 'silent', nodeEnv: 'test' });

export const admin = new PrismaClient({
  adapter: new PrismaPg({ connectionString: requireEnv('TEST_MIGRATE_DATABASE_URL') }),
});

export interface TestContext {
  /** App-role database (subject to RLS), exactly as the API uses it. */
  db: Database;
  /** Real pg-boss producer on the test database. */
  jobs: JobQueue;
  close(): Promise<void>;
}

/** One per test file: `const ctx = await createTestContext()` plus `afterAll(() => ctx.close())`. */
export async function createTestContext(): Promise<TestContext> {
  const url = requireEnv('DATABASE_URL');
  const db = createDatabase(url);
  const boss = createBoss(url, 'producer');
  await boss.start();
  await createQueues(boss);
  return {
    db,
    jobs: createJobQueue(boss),
    close: async () => {
      await boss.stop({ graceful: false });
      await db.disconnect();
    },
  };
}

export function buildTestApp(
  ctx: TestContext,
  options: { authRateLimit?: number; devRoutes?: boolean } = {},
) {
  return createApp({
    logger: silentLogger,
    db: ctx.db,
    jobs: ctx.jobs,
    cipher,
    sessionSecret: TEST_SESSION_SECRET,
    cookieSecure: false,
    authRateLimit: options.authRateLimit ?? 1000,
    devRoutes: options.devRoutes ?? false,
  });
}

/** Empty every application table. Discovers tables from the catalog so new ones are included. */
export async function resetDb(): Promise<void> {
  const tables = await admin.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await admin.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  await admin.$executeRawUnsafe('DELETE FROM pgboss.job');
}

/** Jobs currently queued on a pg-boss queue (payloads only), oldest first. */
export async function queuedJobs(name: QueueName): Promise<unknown[]> {
  const rows = await admin.$queryRaw<{ data: unknown }[]>`
    SELECT data FROM pgboss.job WHERE name = ${name} ORDER BY created_on, id`;
  return rows.map((row) => row.data);
}

export async function createTenant(name: string) {
  return admin.tenant.create({
    data: { name, timezone: 'America/New_York', settings: { create: {} } },
  });
}

export async function createUser(input: {
  tenantId: string;
  email: string;
  role?: UserRole;
  /** When set, the user is already enrolled in MFA with this TOTP secret. */
  mfaSecret?: string;
}) {
  return admin.user.create({
    data: {
      tenantId: input.tenantId,
      email: input.email,
      role: input.role ?? 'staff',
      passwordHash: await hashPassword(TEST_PASSWORD),
      mfaEnabled: input.mfaSecret !== undefined,
      mfaSecretEnc: input.mfaSecret !== undefined ? cipher.encrypt(input.mfaSecret) : null,
    },
  });
}

/** Current TOTP code for a secret. */
export const totpCode = (secret: string): Promise<string> => generate({ secret });

/** Password + MFA login on a cookie-keeping supertest agent. */
export async function signIn(agent: Agent, email: string, mfaSecret: string): Promise<void> {
  const login = await agent.post('/api/v1/auth/login').send({ email, password: TEST_PASSWORD });
  if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
  const verify = await agent
    .post('/api/v1/auth/mfa/verify')
    .send({ code: await totpCode(mfaSecret) });
  if (verify.status !== 200) throw new Error(`mfa verify failed: ${verify.status}`);
}

export async function auditActions(tenantId: string): Promise<string[]> {
  const rows = await admin.auditLog.findMany({ where: { tenantId }, orderBy: { id: 'asc' } });
  return rows.map((row) => row.action);
}
