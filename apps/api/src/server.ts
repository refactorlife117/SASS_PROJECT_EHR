import { createApp } from './app';
import { createDatabase } from './db/client';
import { createBoss, createJobQueue, createQueues } from './jobs/queues';
import { systemClock } from './lib/clock';
import { createFieldCipher } from './lib/crypto';
import { createEmailSender } from './lib/email';
import { devToolsEnabled, loadServerEnv } from './lib/env';
import { createLogger } from './lib/logger';
import { createEhrAdapterFactory, drChronoConfigFromEnv } from './providers/ehr';
import { createSmsProviders } from './providers/sms';
import { createServices } from './services';

const env = loadServerEnv();
const logger = createLogger({ level: env.LOG_LEVEL, nodeEnv: env.NODE_ENV });
const db = createDatabase(env.DATABASE_URL);
const cipher = createFieldCipher(env.ENCRYPTION_KEY);

// The API only produces jobs; the worker runs them (and owns cron/maintenance).
const boss = createBoss(env.DATABASE_URL, 'producer');
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
  adapterFor: createEhrAdapterFactory({ db, cipher, drchrono: drChronoConfigFromEnv(env) }),
});

const app = createApp({
  services,
  cipher,
  sessionSecret: env.SESSION_SECRET,
  cookieSecure: env.NODE_ENV === 'production',
  devRoutes: devToolsEnabled(env),
  drchrono: drChronoConfigFromEnv(env),
  drchronoWebhookSecret: env.DRCHRONO_WEBHOOK_SECRET,
});

const server = app.listen(env.API_PORT, () => {
  logger.info({ port: env.API_PORT }, 'api listening');
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'api shutting down');
  server.close(() => {
    void boss
      .stop({ graceful: true })
      .then(() => db.disconnect())
      .finally(() => process.exit(0));
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
