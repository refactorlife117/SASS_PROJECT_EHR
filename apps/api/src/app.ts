import { randomUUID } from 'node:crypto';
import type { HealthResponse } from '@slotfill/shared';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { FieldCipher } from './lib/crypto';
import { createErrorHandler, notFoundHandler } from './lib/errors';
import { adminRoutes } from './modules/admin/routes';
import { AdminService } from './modules/admin/service';
import { appointmentRoutes } from './modules/appointments/routes';
import { loadSession } from './modules/auth/middleware';
import { authRoutes } from './modules/auth/routes';
import { AuthService } from './modules/auth/service';
import { SessionStore } from './modules/auth/sessions';
import { devEhrRoutes } from './modules/dev/ehr-routes';
import { ehrConnectRoutes } from './modules/ehr/connect-routes';
import { ehrWebhookRoutes } from './modules/ehr/webhook-routes';
import { devSmsRoutes } from './modules/dev/sms-routes';
import { messageRoutes } from './modules/messaging/routes';
import { smsWebhookRoutes } from './modules/messaging/webhook-routes';
import { offerRoutes } from './modules/offers/routes';
import { settingsRoutes } from './modules/settings/routes';
import { userRoutes } from './modules/users/routes';
import { UserService } from './modules/users/service';
import { waitlistRoutes } from './modules/waitlist/routes';
import type { DrChronoConfig } from './providers/ehr/drchrono';
import type { Services } from './services';

export interface AppDeps {
  services: Services;
  cipher: FieldCipher;
  sessionSecret: string;
  /** true in production (HTTPS). */
  cookieSecure: boolean;
  authRateLimit?: number;
  /** Max provider webhook calls per IP per minute. */
  webhookRateLimit?: number;
  /** Mount /dev/* (mock EHR, phone simulator). Only ever true when NODE_ENV=development. */
  devRoutes?: boolean;
  /** Real EHR integration (Phase 8); absent = not offered. */
  drchrono?: DrChronoConfig | undefined;
  drchronoWebhookSecret?: string | undefined;
  fetchImpl?: typeof fetch;
}

export function createApp(deps: AppDeps): Express {
  const { services } = deps;
  const { db, logger } = services;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
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

  const sessions = new SessionStore(db, deps.sessionSecret);
  const authService = new AuthService(db, sessions, deps.cipher, {
    email: services.email,
    appBaseUrl: services.appBaseUrl,
    clock: services.clock,
  });
  const mail = { email: services.email, appBaseUrl: services.appBaseUrl, clock: services.clock };
  const userService = new UserService(db, mail);
  const adminService = new AdminService(db, { ...mail, sms: services.sms });

  const v1 = express.Router();
  v1.get('/health', (_req, res) => {
    const body: HealthResponse = { status: 'ok', service: 'api', time: new Date().toISOString() };
    res.json(body);
  });
  /** Readiness (load balancer): the API can reach its database. */
  v1.get('/health/ready', async (_req, res) => {
    try {
      await db.unscoped.$queryRaw`SELECT 1`;
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  // Webhooks: no session; signature-verified by the provider adapter.
  v1.use(
    '/webhooks',
    smsWebhookRoutes({
      messaging: services.messaging,
      sms: services.sms,
      rateLimit: deps.webhookRateLimit ?? 600,
    }),
  );
  v1.use(
    '/webhooks',
    ehrWebhookRoutes({ db, jobs: services.jobs, drchronoSecret: deps.drchronoWebhookSecret }),
  );
  v1.use(loadSession({ db, sessions, cookieSecure: deps.cookieSecure }));
  v1.use(
    '/auth',
    authRoutes(authService, {
      cookieSecure: deps.cookieSecure,
      authRateLimit: deps.authRateLimit ?? 10,
    }),
  );
  v1.use(appointmentRoutes(db));
  v1.use(messageRoutes(db));
  v1.use(waitlistRoutes({ db, waitlist: services.waitlist, clock: services.clock }));
  v1.use(offerRoutes({ db, offers: services.offers }));
  v1.use(settingsRoutes({ db, jobs: services.jobs, sms: services.sms }));
  v1.use(userRoutes(userService));
  v1.use('/admin', adminRoutes(adminService));
  v1.use(
    ehrConnectRoutes({
      db,
      jobs: services.jobs,
      cipher: deps.cipher,
      logger,
      sessionSecret: deps.sessionSecret,
      appBaseUrl: services.appBaseUrl,
      cookieSecure: deps.cookieSecure,
      drchrono: deps.drchrono,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    }),
  );
  if (deps.devRoutes) {
    v1.use('/dev/ehr', devEhrRoutes({ db, jobs: services.jobs, reminders: services.reminders }));
    v1.use('/dev/sms', devSmsRoutes({ db, messaging: services.messaging }));
  }
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}
