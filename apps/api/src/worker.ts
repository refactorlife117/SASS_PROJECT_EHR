import { createDatabase } from './db/client';
import { enqueueSyncForAllTenants, registerJobHandlers } from './jobs/handlers';
import { createBoss, createJobQueue, createQueues } from './jobs/queues';
import { systemClock } from './lib/clock';
import { createFieldCipher } from './lib/crypto';
import { createEmailSender } from './lib/email';
import { loadWorkerEnv } from './lib/env';
import { createLogger } from './lib/logger';
import { createEhrAdapterFactory, drChronoConfigFromEnv } from './providers/ehr';
import { createSmsProviders } from './providers/sms';
import { createServices } from './services';

const env = loadWorkerEnv();
const logger = createLogger({ level: env.LOG_LEVEL, nodeEnv: env.NODE_ENV });
const db = createDatabase(env.DATABASE_URL);

const boss = createBoss(env.DATABASE_URL, 'worker');
boss.on('error', (err: Error) => {
  logger.error({ err }, 'pg-boss error');
});

await boss.start();
await createQueues(boss);

const services = createServices({
  db,
  jobs: createJobQueue(boss),
  logger,
  clock: systemClock,
  sms: createSmsProviders(env),
  email: createEmailSender(env),
  appBaseUrl: env.APP_BASE_URL,
  adapterFor: createEhrAdapterFactory({
    db,
    cipher: createFieldCipher(env.ENCRYPTION_KEY),
    drchrono: drChronoConfigFromEnv(env),
  }),
});
await registerJobHandlers(boss, services);
// Don't wait for the first cron tick: backfill new connections and catch up right away.
const tenants = await enqueueSyncForAllTenants(services, 'incremental');
logger.info({ tenants }, 'worker started');

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, 'worker shutting down');
  await boss.stop({ graceful: true });
  await db.disconnect();
  process.exit(0);
}
process.on('SIGINT', (signal) => void shutdown(signal));
process.on('SIGTERM', (signal) => void shutdown(signal));
