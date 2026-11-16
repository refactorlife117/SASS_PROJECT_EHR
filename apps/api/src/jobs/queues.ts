import { appointmentStatusSchema } from '@slotfill/shared';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { Tx } from '../db/client';

/** Every queue and its payload schema. Payloads carry IDs only, never PHI. */
export const jobSchemas = {
  /** Sync one tenant's EHR. At most one queued + one running per tenant (stately + singletonKey). */
  'ehr.sync': z.object({ tenantId: z.uuid(), mode: z.enum(['incremental', 'full']) }),
  /** Cron: fan out an incremental `ehr.sync` to every tenant with an active EHR connection. */
  'ehr.sync-all': z.object({}),
  /** Cron (nightly): fan out a full `ehr.sync` (repairs missed events). */
  'ehr.resync-all': z.object({}),
  /** An appointment was created, changed status, or was rescheduled (emitted by EHR sync). */
  'appointment.changed': z.object({
    tenantId: z.uuid(),
    appointmentId: z.uuid(),
    change: z.enum(['created', 'status_changed', 'rescheduled']),
    previousStatus: appointmentStatusSchema.nullable(),
    status: appointmentStatusSchema,
  }),
} as const;

export type QueueName = keyof typeof jobSchemas;
export type JobData<N extends QueueName> = z.infer<(typeof jobSchemas)[N]>;

const queueOptions: Record<QueueName, Parameters<PgBoss['createQueue']>[1]> = {
  'ehr.sync': {
    policy: 'stately',
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 600,
  },
  'ehr.sync-all': { policy: 'short', retryLimit: 1 },
  'ehr.resync-all': { policy: 'short', retryLimit: 1 },
  'appointment.changed': { policy: 'standard', retryLimit: 5, retryDelay: 10, retryBackoff: true },
};

export interface SendOptions {
  singletonKey?: string;
  startAfter?: Date;
}

/** Typed producer. Pass `tx` to enqueue atomically with the caller's tenant transaction. */
export interface JobQueue {
  send<N extends QueueName>(
    name: N,
    data: JobData<N>,
    options?: SendOptions,
    tx?: Tx,
  ): Promise<void>;
}

export function createBoss(connectionString: string, role: 'worker' | 'producer'): PgBoss {
  return new PgBoss({
    connectionString,
    schema: 'pgboss',
    // The schema is pre-created and owned by the app role (docker/postgres/init); see decisions.md.
    createSchema: false,
    // Only the worker runs cron and maintenance.
    ...(role === 'producer' ? { supervise: false, schedule: false } : {}),
  });
}

export async function createQueues(boss: PgBoss): Promise<void> {
  for (const name of Object.keys(queueOptions) as QueueName[]) {
    if (!(await boss.getQueue(name))) await boss.createQueue(name, queueOptions[name]);
  }
}

export function createJobQueue(boss: PgBoss): JobQueue {
  return {
    async send(name, data, options, tx) {
      const payload = jobSchemas[name].parse(data);
      await boss.send(name, payload, {
        ...(options?.singletonKey ? { singletonKey: options.singletonKey } : {}),
        ...(options?.startAfter ? { startAfter: options.startAfter } : {}),
        // Run pg-boss's INSERT through the Prisma transaction so the job commits (or rolls back)
        // together with the data change that caused it.
        ...(tx
          ? {
              db: {
                executeSql: async (text: string, values?: unknown[]) => ({
                  rows: await tx.$queryRawUnsafe<unknown[]>(text, ...(values ?? [])),
                }),
              },
            }
          : {}),
      });
    },
  };
}
