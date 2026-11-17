import type { Job, JobResult, PgBoss } from 'pg-boss';
import type { Services } from '../services';
import { jobSchemas, type QueueName } from './queues';

export const SYNC_CRON = '*/2 * * * *';
/** 07:00 UTC is ~2-3 AM in US time zones. */
export const RESYNC_CRON = '0 7 * * *';

/** Handlers get the full service container. */
export type JobDeps = Services;

/** Fan out one `ehr.sync` per tenant with an active EHR connection (pre-tenant lookup). */
export async function enqueueSyncForAllTenants(
  deps: JobDeps,
  mode: 'incremental' | 'full',
): Promise<number> {
  const rows = await deps.db.unscoped.$queryRaw<{ tenant_id: string }[]>`
    SELECT tenant_id FROM ehr_list_active_connections()`;
  for (const { tenant_id: tenantId } of rows) {
    await deps.jobs.send('ehr.sync', { tenantId, mode }, { singletonKey: tenantId });
  }
  return rows.length;
}

export const jobHandlers: {
  [N in QueueName]: (deps: JobDeps, job: Job<unknown>) => Promise<void>;
} = {
  'ehr.sync': async (deps, job) => {
    const { tenantId, mode } = jobSchemas['ehr.sync'].parse(job.data);
    await deps.sync.sync(tenantId, mode);
  },
  'ehr.sync-all': async (deps) => {
    await enqueueSyncForAllTenants(deps, 'incremental');
  },
  'ehr.resync-all': async (deps) => {
    await enqueueSyncForAllTenants(deps, 'full');
  },
  'appointment.changed': async (deps, job) => {
    const data = jobSchemas['appointment.changed'].parse(job.data);
    // Each reacts in its own tenant transaction; all are idempotent, so a retry is safe.
    await deps.reminders.onAppointmentChanged(data);
    await deps.offers.onAppointmentChanged(data);
    await deps.waitlist.onAppointmentChanged(data);
  },
  'sms.send': async (deps, job) => {
    const { tenantId, messageId } = jobSchemas['sms.send'].parse(job.data);
    await deps.messaging.deliver(tenantId, messageId);
  },
  'reminder.send': async (deps, job) => {
    const { tenantId, reminderId } = jobSchemas['reminder.send'].parse(job.data);
    await deps.reminders.send(tenantId, reminderId);
  },
  'appointment.cancel-by-patient': async (deps, job) => {
    await deps.reminders.cancelByPatient(
      jobSchemas['appointment.cancel-by-patient'].parse(job.data),
    );
  },
  'offer.next-batch': async (deps, job) => {
    await deps.offers.sendNextBatch(jobSchemas['offer.next-batch'].parse(job.data));
  },
  'offer.expire': async (deps, job) => {
    const { tenantId, offerId } = jobSchemas['offer.expire'].parse(job.data);
    await deps.offers.expire(tenantId, offerId);
  },
  'offer.accept': async (deps, job) => {
    const { tenantId, recipientId } = jobSchemas['offer.accept'].parse(job.data);
    await deps.offers.accept(tenantId, recipientId);
  },
  'reminder.replan-tenant': async (deps, job) => {
    const { tenantId } = jobSchemas['reminder.replan-tenant'].parse(job.data);
    await deps.reminders.replanTenant(tenantId);
  },
  'alert.email': async (deps, job) => {
    await deps.alerts.send(jobSchemas['alert.email'].parse(job.data));
  },
};

/**
 * Per-queue throughput. Event queues fetch in batches (and keep fetching while batches come back
 * full); `ehr.sync` runs several tenants at once (its stately policy still allows only one sync
 * per tenant at a time).
 */
const WORK_OPTIONS: Record<
  QueueName,
  { batchSize: number; localConcurrency: number; pollingIntervalSeconds?: number }
> = {
  'ehr.sync': { batchSize: 1, localConcurrency: 4 },
  'ehr.sync-all': { batchSize: 1, localConcurrency: 1 },
  'ehr.resync-all': { batchSize: 1, localConcurrency: 1 },
  'appointment.changed': { batchSize: 50, localConcurrency: 2 },
  // Texts are latency-sensitive (first YES wins): no head-of-line batching.
  'sms.send': { batchSize: 1, localConcurrency: 5, pollingIntervalSeconds: 0.5 },
  'reminder.send': { batchSize: 20, localConcurrency: 2 },
  'appointment.cancel-by-patient': {
    batchSize: 1,
    localConcurrency: 2,
    pollingIntervalSeconds: 0.5,
  },
  'offer.next-batch': { batchSize: 10, localConcurrency: 2, pollingIntervalSeconds: 1 },
  'offer.expire': { batchSize: 20, localConcurrency: 1 },
  // A patient is waiting for the answer to their YES.
  'offer.accept': { batchSize: 1, localConcurrency: 5, pollingIntervalSeconds: 0.5 },
  'reminder.replan-tenant': { batchSize: 1, localConcurrency: 1 },
  'alert.email': { batchSize: 5, localConcurrency: 1 },
};

/** Runs a fetched batch, settling each job on its own so one failure doesn't fail its neighbors. */
export async function runBatch(
  name: QueueName,
  deps: JobDeps,
  jobs: Job<unknown>[],
): Promise<JobResult[]> {
  const results: JobResult[] = [];
  for (const job of jobs) {
    try {
      await jobHandlers[name](deps, job);
      results.push({ id: job.id, status: 'completed' });
    } catch (err) {
      deps.logger.error({ err, queue: name, jobId: job.id }, 'job failed');
      // Stored on the job row: the error class only, never a message that could carry PHI.
      results.push({
        id: job.id,
        status: 'failed',
        output: { error: err instanceof Error ? err.name : 'UnknownError' },
      });
    }
  }
  return results;
}

export async function registerJobHandlers(boss: PgBoss, deps: JobDeps): Promise<void> {
  for (const name of Object.keys(jobHandlers) as QueueName[]) {
    await boss.work(
      name,
      { ...WORK_OPTIONS[name], burstWhenBatchFull: true, perJobResults: true },
      (jobs: Job<unknown>[]) => runBatch(name, deps, jobs),
    );
  }
  await boss.schedule('ehr.sync-all', SYNC_CRON, {});
  await boss.schedule('ehr.resync-all', RESYNC_CRON, {});
}
