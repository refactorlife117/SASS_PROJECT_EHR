import { z } from 'zod';
import { parseKey } from './crypto';

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

/**
 * In AWS the database credentials come from Secrets Manager as separate fields; accept those and
 * build DATABASE_URL when it isn't given directly.
 */
function withDatabaseUrl(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.DATABASE_URL || !env.DB_HOST || !env.DB_USER || !env.DB_PASSWORD) return env;
  const user = encodeURIComponent(env.DB_USER);
  const password = encodeURIComponent(env.DB_PASSWORD);
  const sslmode = env.DB_SSLMODE ?? 'require';
  return {
    ...env,
    DATABASE_URL: `postgresql://${user}:${password}@${env.DB_HOST}:${env.DB_PORT ?? '5432'}/${env.DB_NAME ?? 'slotfill'}?sslmode=${sslmode}`,
  };
}

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Deployment environment. Staging runs production builds with synthetic data and dev tools. */
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  LOG_LEVEL: logLevelSchema.default('info'),
  DATABASE_URL: z.url(),
  APP_BASE_URL: z.url().default('http://localhost:3000'),

  // SMS (both processes: the worker sends, the API receives webhooks).
  SMS_PROVIDER: z.enum(['dev', 'aws', 'twilio']).default('dev'),
  AWS_REGION: z.string().default('us-east-1'),
  /** Optional AWS End User Messaging configuration set (delivery events). */
  AWS_SMS_CONFIGURATION_SET: z.string().optional(),
  /** Comma-separated SNS topic ARNs allowed to post inbound SMS to the webhook. */
  AWS_SNS_INBOUND_TOPIC_ARNS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  // Email (password reset, staff alerts). SMTP = Mailpit in dev; SES in AWS.
  EMAIL_TRANSPORT: z.enum(['smtp', 'ses']).default('smtp'),
  EMAIL_FROM: z.string().default('SlotFill <no-reply@slotfill.local>'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  DEV_SMS_EMAIL_TO: z.string().default('dev-sms@slotfill.local'),
  DEV_SMS_EMAIL_FROM: z.string().default('slotfill-dev@slotfill.local'),

  /** Field encryption (MFA secrets, EHR OAuth tokens). Both processes: the worker decrypts EHR tokens. */
  ENCRYPTION_KEY: z
    .string()
    .refine((value) => parseKey(value).length === 32, 'must be 32 bytes (64 hex chars or base64)'),

  // Twilio (Phase 9, optional). Configured = offered to clinics; requires a signed Twilio BAA.
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  /** Set to true only once a Twilio BAA is signed. Deployed servers refuse Twilio without it. */
  TWILIO_BAA_SIGNED: z.enum(['true', 'false']).default('false'),

  // DrChrono (Phase 8). Optional: the integration is offered only when the client id/secret are set.
  DRCHRONO_BASE_URL: z.url().default('https://app.drchrono.com'),
  DRCHRONO_CLIENT_ID: z.string().optional(),
  DRCHRONO_CLIENT_SECRET: z.string().optional(),
  /** Secret token configured on the DrChrono webhook (verification + delivery header). */
  DRCHRONO_WEBHOOK_SECRET: z.string().optional(),
});

/** Refuse configurations that would be unsafe outside development. */
function productionGuards(env: z.infer<typeof baseSchema>, ctx: z.RefinementCtx): void {
  const deployed = env.APP_ENV === 'staging' || env.APP_ENV === 'production';
  if (deployed && env.SMS_PROVIDER === 'dev') {
    ctx.addIssue({
      code: 'custom',
      path: ['SMS_PROVIDER'],
      message: 'the dev SMS provider is not allowed when deployed',
    });
  }
  if (deployed && env.NODE_ENV !== 'production') {
    ctx.addIssue({
      code: 'custom',
      path: ['NODE_ENV'],
      message: 'must be production when deployed',
    });
  }
  if (deployed && !env.APP_BASE_URL.startsWith('https://')) {
    ctx.addIssue({
      code: 'custom',
      path: ['APP_BASE_URL'],
      message: 'must be https when deployed',
    });
  }
  const twilioConfigured = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
  if (env.SMS_PROVIDER === 'twilio' && !twilioConfigured) {
    ctx.addIssue({
      code: 'custom',
      path: ['TWILIO_ACCOUNT_SID'],
      message: 'required for the twilio SMS provider',
    });
  }
  if (deployed && twilioConfigured && env.TWILIO_BAA_SIGNED !== 'true') {
    ctx.addIssue({
      code: 'custom',
      path: ['TWILIO_BAA_SIGNED'],
      message:
        'Twilio may only carry PHI under a signed BAA; set TWILIO_BAA_SIGNED=true once it is',
    });
  }
  if (env.SMS_PROVIDER === 'aws' && env.AWS_SNS_INBOUND_TOPIC_ARNS.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['AWS_SNS_INBOUND_TOPIC_ARNS'],
      message: 'required for the aws SMS provider',
    });
  }
}

const serverSchema = baseSchema
  .extend({
    API_PORT: z.coerce.number().int().positive().default(4000),
    SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  })
  .superRefine(productionGuards);

const workerSchema = baseSchema.superRefine(productionGuards);

export type ServerEnv = z.infer<typeof serverSchema>;
export type WorkerEnv = z.infer<typeof workerSchema>;
export type NodeEnv = ServerEnv['NODE_ENV'];
export type LogLevel = z.infer<typeof logLevelSchema>;

function parseEnv<T extends z.ZodType>(schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(withDatabaseUrl(source));
  if (!result.success) {
    // Print only variable names and issues, never values: they may be secrets.
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n  ${issues.join('\n  ')}`);
  }
  return result.data;
}

export const loadServerEnv = (source: NodeJS.ProcessEnv = process.env): ServerEnv =>
  parseEnv(serverSchema, source);
export const loadWorkerEnv = (source: NodeJS.ProcessEnv = process.env): WorkerEnv =>
  parseEnv(workerSchema, source);

/** Dev-only routes/tools (mock EHR, phone simulator): development and staging, never production. */
export const devToolsEnabled = (env: { APP_ENV: string }): boolean =>
  env.APP_ENV === 'development' || env.APP_ENV === 'staging';
