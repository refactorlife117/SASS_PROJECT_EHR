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
    /** True for events from a connection's first (initial) backfill. */
    backfill: z.boolean().optional(),
    status: appointmentStatusSchema,
  }),
  /** Deliver one queued outbound SMS (messages row) through the SMS provider. */
  'sms.send': z.object({ tenantId: z.uuid(), messageId: z.uuid() }),
  /** Send one reminder (deferred to its due time with startAfter). */
  'reminder.send': z.object({ tenantId: z.uuid(), reminderId: z.uuid() }),
  /** Patient replied "2" to a reminder: cancel in the EHR, then sync. */
  'appointment.cancel-by-patient': z.object({
    tenantId: z.uuid(),
    appointmentId: z.uuid(),
    inboundMessageId: z.uuid(),
  }),
  /** Text the next batch of waitlisted patients about an open slot. `batchNo` dedupes triggers. */
  'offer.next-batch': z.object({
    tenantId: z.uuid(),
    offerId: z.uuid(),
    batchNo: z.number().int().min(1),
  }),
  /** Close an offer that nobody took before its expiry. */
  'offer.expire': z.object({ tenantId: z.uuid(), offerId: z.uuid() }),
  /** A recipient replied YES: race-safe booking. */
  'offer.accept': z.object({ tenantId: z.uuid(), recipientId: z.uuid() }),
  /** Reminder offsets changed: re-plan reminders for every upcoming appointment. */
  'reminder.replan-tenant': z.object({ tenantId: z.uuid() }),
  /** Email the clinic's owners about something that needs a human (no PHI in the email). */
  'alert.email': z.object({
    tenantId: z.uuid(),
    kind: z.enum(['booking_failed', 'cancel_failed']),
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
    expireInSeconds: 300,
  },
  'ehr.sync-all': { policy: 'short', retryLimit: 1 },
  'ehr.resync-all': { policy: 'short', retryLimit: 1 },
  'appointment.changed': { policy: 'standard', retryLimit: 5, retryDelay: 10, retryBackoff: true },
  'sms.send': { policy: 'standard', retryLimit: 5, retryDelay: 15, retryBackoff: true },
  'reminder.send': { policy: 'standard', retryLimit: 3, retryDelay: 30, retryBackoff: true },
  // No automatic retry: on EHR failure the job tells the patient and alerts staff instead.
  'appointment.cancel-by-patient': { policy: 'standard', retryLimit: 0 },
  'offer.next-batch': { policy: 'standard', retryLimit: 3, retryDelay: 10, retryBackoff: true },
  'offer.expire': { policy: 'standard', retryLimit: 3, retryDelay: 10 },
  // Booking failures are handled inside (rollback + staff alert); a retry could double-text.
  'offer.accept': { policy: 'standard', retryLimit: 0 },
  'reminder.replan-tenant': { policy: 'standard', retryLimit: 3, retryDelay: 30 },
  'alert.email': { policy: 'standard', retryLimit: 5, retryDelay: 60, retryBackoff: true },
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

/**
 * Workers heartbeat while a job runs; a job whose worker died (crash, deploy, dev reload) is failed
 * and retried after this, instead of sitting "active" until it expires. That matters most for
 * `ehr.sync`, whose stately policy blocks the tenant's next sync while one is active.
 */
const HEARTBEAT_SECONDS = 30;

export async function createQueues(boss: PgBoss): Promise<void> {
  for (const name of Object.keys(queueOptions) as QueueName[]) {
    const options = { ...queueOptions[name], heartbeatSeconds: HEARTBEAT_SECONDS };
    if (!(await boss.getQueue(name))) {
      await boss.createQueue(name, options);
    } else {
      // Existing queues keep their policy (immutable) but pick up changed settings.
      const { policy: _policy, ...updatable } = options;
      await boss.updateQueue(name, updatable);
    }
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
