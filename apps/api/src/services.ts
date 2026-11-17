import type { Database } from './db/client';
import type { JobQueue } from './jobs/queues';
import type { Clock } from './lib/clock';
import type { EmailSender } from './lib/email';
import type { Logger } from './lib/logger';
import { AlertService } from './modules/alerts/service';
import { EhrSyncService } from './modules/ehr/sync';
import { MessagingService } from './modules/messaging/service';
import { OfferService } from './modules/offers/service';
import { ReminderService } from './modules/reminders/service';
import { WaitlistService } from './modules/waitlist/service';
import type { EhrAdapterFactory } from './providers/ehr';
import type { SmsProviderRegistry } from './providers/sms';

export interface Infrastructure {
  db: Database;
  jobs: JobQueue;
  logger: Logger;
  clock: Clock;
  /** Configured SMS providers (default + optional others clinics can choose). */
  sms: SmsProviderRegistry;
  email: EmailSender;
  adapterFor: EhrAdapterFactory;
  /** Public web URL, for links in emails (password reset, alerts). */
  appBaseUrl: string;
}

/**
 * Builds every domain service from infrastructure. The worker, the API server and the tests all use
 * this, so wiring (including context handlers registered by later phases) lives in one place.
 */
export function createServices(infra: Infrastructure) {
  const alerts = new AlertService({
    db: infra.db,
    jobs: infra.jobs,
    email: infra.email,
    logger: infra.logger,
    appBaseUrl: infra.appBaseUrl,
  });
  const messaging = new MessagingService({
    db: infra.db,
    jobs: infra.jobs,
    clock: infra.clock,
    logger: infra.logger,
    providers: infra.sms,
  });
  const sync = new EhrSyncService({
    db: infra.db,
    jobs: infra.jobs,
    adapterFor: infra.adapterFor,
    logger: infra.logger,
    now: () => infra.clock.now(),
  });
  const reminders = new ReminderService({
    db: infra.db,
    jobs: infra.jobs,
    clock: infra.clock,
    logger: infra.logger,
    messaging,
    alerts,
    adapterFor: infra.adapterFor,
  });
  const offers = new OfferService({
    db: infra.db,
    jobs: infra.jobs,
    clock: infra.clock,
    logger: infra.logger,
    messaging,
    reminders,
    alerts,
    adapterFor: infra.adapterFor,
  });
  const waitlist = new WaitlistService({
    db: infra.db,
    jobs: infra.jobs,
    clock: infra.clock,
    messaging,
  });
  messaging.registerContextHandler('reminder', reminders.handleReply);
  messaging.registerContextHandler('offer', offers.handleReply);
  messaging.registerContextHandler('waitlist_invite', waitlist.handleInviteReply);
  return { ...infra, alerts, messaging, sync, reminders, offers, waitlist };
}

export type Services = ReturnType<typeof createServices>;
