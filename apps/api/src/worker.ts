import { createDatabase } from './db/client';
import { enqueueSyncForAllTenants, registerJobHandlers } from './jobs/handlers';
import { createBoss, createJobQueue, createQueues } from './jobs/queues';
import { loadWorkerEnv } from './lib/env';
import { createLogger } from './lib/logger';
import { EhrSyncService } from './modules/ehr/sync';
import { createEhrAdapterFactory } from './providers/ehr';

const env = loadWorkerEnv();
const logger = createLogger({ level: env.LOG_LEVEL, nodeEnv: env.NODE_ENV });
const db = createDatabase(env.DATABASE_URL);

const boss = createBoss(env.DATABASE_URL, 'worker');
boss.on('error', (err: Error) => {
  logger.error({ err }, 'pg-boss error');
});

await boss.start();
await createQueues(boss);

const jobs = createJobQueue(boss);
const deps = {
  db,
  jobs,
  logger,
  sync: new EhrSyncService({ db, jobs, adapterFor: createEhrAdapterFactory({ db }), logger }),
};
await registerJobHandlers(boss, deps);
// Don't wait for the first cron tick: backfill new connections and catch up right away.
const tenants = await enqueueSyncForAllTenants(deps, 'incremental');
logger.info({ tenants }, 'worker started');

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, 'worker shutting down');
  await boss.stop({ graceful: true });
  await db.disconnect();
  process.exit(0);
}
process.on('SIGINT', (signal) => void shutdown(signal));
process.on('SIGTERM', (signal) => void shutdown(signal));
