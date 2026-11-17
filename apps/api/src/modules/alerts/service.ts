import type { Database, Tx } from '../../db/client';
import type { JobData, JobQueue } from '../../jobs/queues';
import type { EmailSender } from '../../lib/email';
import type { Logger } from '../../lib/logger';

export type AlertKind = JobData<'alert.email'>['kind'];

/** Subjects and bodies never contain PHI: they point staff to SlotFill, where the details are. */
const ALERTS: Record<AlertKind, { subject: string; text: (baseUrl: string) => string }> = {
  booking_failed: {
    subject: 'SlotFill: a booking needs your attention',
    text: (url) =>
      `A patient accepted an earlier appointment, but the booking couldn't be completed in your EHR. ` +
      `The patient was told the clinic will call them.\n\nOpen SlotFill → Messages → Needs attention: ${url}/messages`,
  },
  cancel_failed: {
    subject: 'SlotFill: a cancellation needs your attention',
    text: (url) =>
      `A patient asked by text to cancel an appointment, but the cancellation couldn't be completed in your EHR. ` +
      `The patient was told the clinic will contact them.\n\nOpen SlotFill → Messages → Needs attention: ${url}/messages`,
  },
};

export class AlertService {
  constructor(
    private readonly deps: {
      db: Database;
      jobs: JobQueue;
      email: EmailSender;
      logger: Logger;
      appBaseUrl: string;
    },
  ) {}

  /** Queue an email to the clinic's owners, atomically with the caller's transaction. */
  async notifyOwners(tx: Tx, tenantId: string, kind: AlertKind): Promise<void> {
    await this.deps.jobs.send('alert.email', { tenantId, kind }, undefined, tx);
  }

  /** `alert.email` job. */
  async send(data: JobData<'alert.email'>): Promise<number> {
    const owners = await this.deps.db.withTenant(data.tenantId, (tx) =>
      tx.user.findMany({ where: { role: 'owner' }, select: { email: true } }),
    );
    const alert = ALERTS[data.kind];
    for (const owner of owners) {
      await this.deps.email.send({
        to: owner.email,
        subject: alert.subject,
        text: alert.text(this.deps.appBaseUrl),
      });
    }
    this.deps.logger.info(
      { tenantId: data.tenantId, kind: data.kind, recipients: owners.length },
      'alert emailed',
    );
    return owners.length;
  }
}
