import { randomUUID } from 'node:crypto';
import type { HealthResponse } from '@slotfill/shared';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Database } from './db/client';
import type { JobQueue } from './jobs/queues';
import type { FieldCipher } from './lib/crypto';
import { createErrorHandler, notFoundHandler } from './lib/errors';
import type { Logger } from './lib/logger';
import { appointmentRoutes } from './modules/appointments/routes';
import { loadSession } from './modules/auth/middleware';
import { authRoutes } from './modules/auth/routes';
import { AuthService } from './modules/auth/service';
import { SessionStore } from './modules/auth/sessions';
import { devEhrRoutes } from './modules/dev/ehr-routes';

export interface AppDeps {
  logger: Logger;
  db: Database;
  jobs: JobQueue;
  cipher: FieldCipher;
  sessionSecret: string;
  /** true in production (HTTPS). */
  cookieSecure: boolean;
  authRateLimit?: number;
  /** Mount /dev/* (mock EHR controls). Only ever true when NODE_ENV=development. */
  devRoutes?: boolean;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (_req, res) => {
        const id = randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      // Query strings can carry PHI (e.g. ?mobile=), so only the path is logged.
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          path: req.url.split('?')[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  const sessions = new SessionStore(deps.db, deps.sessionSecret);
  const authService = new AuthService(deps.db, sessions, deps.cipher);

  const v1 = express.Router();
  v1.get('/health', (_req, res) => {
    const body: HealthResponse = { status: 'ok', service: 'api', time: new Date().toISOString() };
    res.json(body);
  });
  v1.use(loadSession({ db: deps.db, sessions, cookieSecure: deps.cookieSecure }));
  v1.use(
    '/auth',
    authRoutes(authService, {
      cookieSecure: deps.cookieSecure,
      authRateLimit: deps.authRateLimit ?? 10,
    }),
  );
  v1.use(appointmentRoutes(deps.db));
  if (deps.devRoutes) v1.use('/dev/ehr', devEhrRoutes({ db: deps.db, jobs: deps.jobs }));
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(createErrorHandler(deps.logger));

  return app;
}
