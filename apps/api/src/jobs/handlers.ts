import type { Job, JobResult, PgBoss } from 'pg-boss';
import type { Database } from '../db/client';
import type { Logger } from '../lib/logger';
import type { EhrSyncService } from '../modules/ehr/sync';
import { jobSchemas, type JobQueue, type QueueName } from './queues';

export const SYNC_CRON = '*/2 * * * *';
/** 07:00 UTC is ~2-3 AM in US time zones. */
export const RESYNC_CRON = '0 7 * * *';

export interface JobDeps {
  db: Database;
  jobs: JobQueue;
  sync: EhrSyncService;
  logger: Logger;
}

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
  'appointment.changed': (deps, job) => {
    const data = jobSchemas['appointment.changed'].parse(job.data);
    // Phase 4 (reminders) and Phase 5 (offer engine) react here. IDs only in logs.
    deps.logger.debug(
      { tenantId: data.tenantId, appointmentId: data.appointmentId, change: data.change },
      'appointment changed',
    );
    return Promise.resolve();
  },
};

/**
 * Per-queue throughput. Event queues fetch in batches (and keep fetching while batches come back
 * full); `ehr.sync` runs several tenants at once (its stately policy still allows only one sync
 * per tenant at a time).
 */
const WORK_OPTIONS: Record<QueueName, { batchSize: number; localConcurrency: number }> = {
  'ehr.sync': { batchSize: 1, localConcurrency: 4 },
  'ehr.sync-all': { batchSize: 1, localConcurrency: 1 },
  'ehr.resync-all': { batchSize: 1, localConcurrency: 1 },
  'appointment.changed': { batchSize: 50, localConcurrency: 2 },
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
