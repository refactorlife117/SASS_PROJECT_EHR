import { createApp } from './app';
import { createDatabase } from './db/client';
import { createBoss, createJobQueue, createQueues } from './jobs/queues';
import { createFieldCipher } from './lib/crypto';
import { loadServerEnv } from './lib/env';
import { createLogger } from './lib/logger';

const env = loadServerEnv();
const logger = createLogger({ level: env.LOG_LEVEL, nodeEnv: env.NODE_ENV });
const db = createDatabase(env.DATABASE_URL);

// The API only produces jobs; the worker runs them (and owns cron/maintenance).
const boss = createBoss(env.DATABASE_URL, 'producer');
boss.on('error', (err: Error) => {
  logger.error({ err }, 'pg-boss error');
});
await boss.start();
await createQueues(boss);

const app = createApp({
  logger,
  db,
  jobs: createJobQueue(boss),
  cipher: createFieldCipher(env.ENCRYPTION_KEY),
  sessionSecret: env.SESSION_SECRET,
  cookieSecure: env.NODE_ENV === 'production',
  devRoutes: env.NODE_ENV === 'development',
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
