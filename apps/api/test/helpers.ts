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
import type { Job } from 'pg-boss';
import { PrismaClient, type UserRole } from '../src/generated/prisma/client';
import { jobHandlers } from '../src/jobs/handlers';
import type { Clock } from '../src/lib/clock';
import type { EmailMessage, EmailSender } from '../src/lib/email';
import { createFieldCipher } from '../src/lib/crypto';
import { createLogger } from '../src/lib/logger';
import { hashPassword } from '../src/modules/auth/passwords';
import { createEhrAdapterFactory } from '../src/providers/ehr';
import { DevSmsProvider, type MailSender } from '../src/providers/sms/dev';
import { createSmsProviderRegistry } from '../src/providers/sms/types';
import { createServices, type Services } from '../src/services';

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

/**
 * A clock tests can move. Starts at the real current time and ticks 1 ms per read, so events
 * created one after another keep their order (as with a real clock).
 */
export class FakeClock implements Clock {
  private current = new Date();
  now(): Date {
    this.current = new Date(this.current.getTime() + 1);
    return new Date(this.current);
  }
  set(instant: Date): void {
    this.current = new Date(instant);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Captures what the dev SMS provider would email to Mailpit. */
export class RecordingMailer implements MailSender {
  readonly sent: { from: string; to: string; subject: string; text: string }[] = [];
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown> {
    this.sent.push(mail);
    return Promise.resolve({});
  }
}

/** Captures staff emails (password reset, alerts) instead of sending them. */
export class RecordingEmail implements EmailSender {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

export const TEST_APP_BASE_URL = 'https://app.test';

export interface TestContext {
  services: Services;
  email: RecordingEmail;
  /** App-role database (subject to RLS), exactly as the API uses it. */
  db: Database;
  /** Real pg-boss producer on the test database. */
  jobs: JobQueue;
  clock: FakeClock;
  mailer: RecordingMailer;
  /**
   * Stand-in for the worker: runs queued jobs whose start time is due by the fake clock, until
   * none are left (handlers may enqueue more). Returns how many ran. Handler errors are rethrown.
   */
  runJobs(options?: { only?: QueueName[] }): Promise<number>;
  close(): Promise<void>;
}

/** One per test file: `const ctx = await createTestContext()` plus `afterAll(() => ctx.close())`. */
export async function createTestContext(): Promise<TestContext> {
  const url = requireEnv('DATABASE_URL');
  const db = createDatabase(url);
  const boss = createBoss(url, 'producer');
  await boss.start();
  await createQueues(boss);
  const clock = new FakeClock();
  const mailer = new RecordingMailer();
  const email = new RecordingEmail();
  const services = createServices({
    db,
    jobs: createJobQueue(boss),
    logger: silentLogger,
    clock,
    sms: createSmsProviderRegistry(
      new DevSmsProvider(mailer, {
        emailTo: 'dev-sms@test.local',
        emailFrom: 'slotfill@test.local',
      }),
    ),
    email,
    appBaseUrl: TEST_APP_BASE_URL,
    adapterFor: createEhrAdapterFactory({ db, cipher }),
  });

  const runJobs = async (options: { only?: QueueName[] } = {}): Promise<number> => {
    let ran = 0;
    for (let round = 0; round < 50; round++) {
      const due = await admin.$queryRaw<{ id: string; name: QueueName; data: unknown }[]>`
        SELECT id::text, name, data FROM pgboss.job
        WHERE state = 'created'
          -- Immediate jobs (start_after = DB time at insert) are always due; explicitly deferred
          -- jobs (startAfter) are due once the fake clock reaches them.
          AND (start_after <= created_on + interval '1 second' OR start_after <= ${clock.now()})
        ORDER BY start_after, created_on, id`;
      const batch = due.filter((job) => !options.only || options.only.includes(job.name));
      if (batch.length === 0) return ran;
      for (const job of batch) {
        await admin.$executeRaw`UPDATE pgboss.job SET state = 'completed' WHERE id = ${job.id}::uuid`;
        await jobHandlers[job.name](services, {
          id: job.id,
          name: job.name,
          data: job.data,
        } as Job<unknown>);
        ran++;
      }
    }
    throw new Error('runJobs: jobs kept enqueueing more jobs (50 rounds)');
  };

  return {
    services,
    db,
    jobs: services.jobs,
    clock,
    mailer,
    email,
    runJobs,
    close: async () => {
      await boss.stop({ graceful: false });
      await db.disconnect();
    },
  };
}

export function buildTestApp(
  ctx: TestContext,
  options: { authRateLimit?: number; webhookRateLimit?: number; devRoutes?: boolean } = {},
) {
  return createApp({
    services: ctx.services,
    cipher,
    sessionSecret: TEST_SESSION_SECRET,
    cookieSecure: false,
    authRateLimit: options.authRateLimit ?? 1000,
    webhookRateLimit: options.webhookRateLimit ?? 10_000,
    devRoutes: options.devRoutes ?? false,
  });
}

/**
 * Empty every application table (discovered from the catalog, so new tables are included).
 * DELETE rather than TRUNCATE: TRUNCATE creates new data files per table, which on Docker Desktop
 * for Windows intermittently stalls for seconds (found as flaky 10 s test timeouts). FK triggers are
 * skipped for the reset only (session_replication_role; the test owner role is a superuser).
 */
export async function resetDb(): Promise<void> {
  const tables = await admin.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await admin.$transaction([
    admin.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'"),
    ...tables.map((t) => admin.$executeRawUnsafe(`DELETE FROM "public"."${t.tablename}"`)),
    admin.$executeRawUnsafe('DELETE FROM pgboss.job'),
  ]);
}

/** Jobs currently queued on a pg-boss queue (payloads only), oldest first. */
export async function queuedJobs(name: QueueName): Promise<unknown[]> {
  const rows = await admin.$queryRaw<{ data: unknown }[]>`
    SELECT data FROM pgboss.job WHERE name = ${name} ORDER BY created_on, id`;
  return rows.map((row) => row.data);
}

export async function createTenant(
  name: string,
  options: { smsNumber?: string; contactPhone?: string; timezone?: string } = {},
) {
  return admin.tenant.create({
    data: {
      name,
      timezone: options.timezone ?? 'America/New_York',
      smsNumber: options.smsNumber ?? null,
      contactPhone: options.contactPhone ?? null,
      settings: { create: {} },
    },
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
