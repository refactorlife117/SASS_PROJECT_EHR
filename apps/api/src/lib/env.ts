import { z } from 'zod';

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: logLevelSchema.default('info'),
  DATABASE_URL: z.url(),
});

const serverSchema = baseSchema.extend({
  API_PORT: z.coerce.number().int().positive().default(4000),
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ENCRYPTION_KEY: z
    .string()
    .refine((value) => Buffer.from(value, 'base64').length === 32, 'must be 32 bytes, base64'),
});

const workerSchema = baseSchema;

export type ServerEnv = z.infer<typeof serverSchema>;
export type WorkerEnv = z.infer<typeof workerSchema>;
export type NodeEnv = ServerEnv['NODE_ENV'];
export type LogLevel = z.infer<typeof logLevelSchema>;

function parseEnv<T extends z.ZodType>(schema: T): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    // Print only variable names and issues, never values: they may be secrets.
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n  ${issues.join('\n  ')}`);
  }
  return result.data;
}

export const loadServerEnv = (): ServerEnv => parseEnv(serverSchema);
export const loadWorkerEnv = (): WorkerEnv => parseEnv(workerSchema);
