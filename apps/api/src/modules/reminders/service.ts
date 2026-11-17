import type { Database, Tx } from '../../db/client';
import type { Appointment, Patient, Provider, Tenant } from '../../generated/prisma/client';
import type { JobData, JobQueue } from '../../jobs/queues';
import type { Clock } from '../../lib/clock';
import type { Logger } from '../../lib/logger';
import { quietHoursEndAt } from '../../lib/quiet-hours';
import type { EhrAdapterFactory } from '../../providers/ehr';
import type { AlertService } from '../alerts/service';
import { recordAudit } from '../audit/audit';
import type { ContextHandler, MessagingService } from '../messaging/service';
import { templates, type SlotFacts } from '../messaging/templates';

const HOUR = 3_600_000;
/** Replies (within a reminder conversation) that confirm. "2" cancels; CANCEL itself is an opt-out keyword. */
const CONFIRM_REPLIES = new Set(['1', 'Y', 'YES', 'CONFIRM']);
const CANCEL_REPLIES = new Set(['2']);

export type ReminderSendOutcome = 'sent' | 'skipped' | 'deferred' | 'ignored';

type ApptWithPeople = Appointment & { patient: Patient; provider: Provider };

export function slotFacts(appt: ApptWithPeople, tenant: Tenant): SlotFacts {
  return {
    firstName: appt.patient.firstName,
    clinic: tenant.name,
    clinicPhone: tenant.contactPhone,
    provider: appt.provider.displayName,
    startsAt: appt.startsAt,
    timezone: tenant.timezone,
  };
}

export class ReminderService {
  constructor(
    private readonly deps: {
      db: Database;
      jobs: JobQueue;
      clock: Clock;
      logger: Logger;
      messaging: MessagingService;
      alerts: AlertService;
      adapterFor: EhrAdapterFactory;
    },
  ) {}

  /** React to an `appointment.changed` event: (re)plan or cancel this appointment's reminders. */
  async onAppointmentChanged(event: JobData<'appointment.changed'>): Promise<void> {
    await this.deps.db.withTenant(event.tenantId, async (tx) => {
      const appt = await tx.appointment.findUnique({ where: { id: event.appointmentId } });
      if (!appt) return;
      await this.plan(tx, appt);
    });
  }

  /**
   * Make the scheduled reminders match the appointment as it is now. Idempotent: replaying an event
   * keeps matching reminders, cancels outdated ones, and never re-creates one already sent.
   */
  async plan(tx: Tx, appt: Appointment): Promise<void> {
    const settings = await tx.tenantSettings.findUnique({ where: { tenantId: appt.tenantId } });
    const now = this.deps.clock.now();
    const wanted =
      appt.status === 'booked'
        ? [...new Set(settings?.reminderHoursBefore ?? [48, 24])]
            .filter((h) => h > 0)
            .map((hoursBefore) => ({
              hoursBefore,
              sendAfter: new Date(appt.startsAt.getTime() - hoursBefore * HOUR),
            }))
            .filter((r) => r.sendAfter > now)
        : [];

    const existing = await tx.reminder.findMany({ where: { appointmentId: appt.id } });
    const isWanted = (r: { hoursBefore: number; appointmentStartsAt: Date }) =>
      r.appointmentStartsAt.getTime() === appt.startsAt.getTime() &&
      wanted.some((w) => w.hoursBefore === r.hoursBefore);

    const outdated = existing
      .filter((r) => r.status === 'scheduled' && !isWanted(r))
      .map((r) => r.id);
    if (outdated.length > 0) {
      await tx.reminder.updateMany({
        where: { id: { in: outdated } },
        data: {
          status: 'cancelled',
          skipReason: appt.status === 'booked' ? 'replaced' : `appointment_${appt.status}`,
        },
      });
    }

    for (const w of wanted) {
      const already = existing.some(
        (r) =>
          r.hoursBefore === w.hoursBefore &&
          r.appointmentStartsAt.getTime() === appt.startsAt.getTime(),
      );
      if (already) continue;
      const reminder = await tx.reminder.create({
        data: {
          tenantId: appt.tenantId,
          appointmentId: appt.id,
          hoursBefore: w.hoursBefore,
          appointmentStartsAt: appt.startsAt,
          sendAfter: w.sendAfter,
        },
        select: { id: true },
      });
      await this.deps.jobs.send(
        'reminder.send',
        { tenantId: appt.tenantId, reminderId: reminder.id },
        { startAfter: w.sendAfter },
        tx,
      );
    }
  }

  /** Re-plan reminders for all upcoming appointments of a tenant (settings changes, backfills). */
  async replanTenant(tenantId: string): Promise<number> {
    return this.deps.db.withTenant(
      tenantId,
      async (tx) => {
        const upcoming = await tx.appointment.findMany({
          where: {
            startsAt: { gt: this.deps.clock.now() },
            status: { in: ['booked', 'confirmed'] },
          },
        });
        for (const appt of upcoming) await this.plan(tx, appt);
        return upcoming.length;
      },
      { timeoutMs: 120_000 },
    );
  }

  /** `reminder.send` job. Every condition is re-checked at send time. */
  async send(
    tenantId: string,
    reminderId: string,
    options: { ignoreQuietHours?: boolean } = {},
  ): Promise<ReminderSendOutcome> {
    return this.deps.db.withTenant(tenantId, async (tx) => {
      const reminder = await tx.reminder.findUnique({
        where: { id: reminderId },
        include: { appointment: { include: { patient: true, provider: true } } },
      });
      if (reminder?.status !== 'scheduled') return 'ignored';
      const appt = reminder.appointment;
      const now = this.deps.clock.now();
      const skip = async (skipReason: string): Promise<ReminderSendOutcome> => {
        await tx.reminder.update({
          where: { id: reminderId },
          data: { status: 'skipped', skipReason },
        });
        return 'skipped';
      };

      if (appt.startsAt.getTime() !== reminder.appointmentStartsAt.getTime())
        return skip('rescheduled');
      if (appt.status !== 'booked')
        return skip(appt.status === 'confirmed' ? 'already_confirmed' : 'not_booked');
      if (appt.startsAt <= now) return skip('appointment_passed');
      const mobile = appt.patient.mobileE164;
      if (!mobile) return skip('no_mobile');
      if (await this.deps.messaging.isOptedOut(tx, mobile)) return skip('opted_out');

      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        include: { settings: true },
      });
      if (!options.ignoreQuietHours && tenant.settings) {
        const quietEnd = quietHoursEndAt(now, {
          start: tenant.settings.quietHoursStart,
          end: tenant.settings.quietHoursEnd,
          timezone: tenant.timezone,
        });
        if (quietEnd) {
          if (quietEnd >= appt.startsAt) return skip('quiet_hours');
          await tx.reminder.update({ where: { id: reminderId }, data: { sendAfter: quietEnd } });
          await this.deps.jobs.send(
            'reminder.send',
            { tenantId, reminderId },
            { startAfter: quietEnd },
            tx,
          );
          return 'deferred';
        }
      }

      const messageId = await this.deps.messaging.queueSms(tx, {
        tenantId,
        to: mobile,
        body: templates.reminder(slotFacts(appt, tenant)),
        context: { type: 'reminder', id: reminder.id },
      });
      await tx.reminder.update({
        where: { id: reminderId },
        data: { status: 'sent', messageId, sentAt: now },
      });
      return 'sent';
    });
  }

  /** Dev helper: send this appointment's reminder now (ignores schedule and quiet hours). */
  async sendNow(tenantId: string, appointmentId: string): Promise<ReminderSendOutcome> {
    const reminderId = await this.deps.db.withTenant(tenantId, async (tx) => {
      const appt = await tx.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
      const hoursBefore = Math.max(
        1,
        Math.round((appt.startsAt.getTime() - this.deps.clock.now().getTime()) / HOUR),
      );
      const key = { appointmentId, hoursBefore, appointmentStartsAt: appt.startsAt };
      const existing = await tx.reminder.findUnique({
        where: { appointmentId_hoursBefore_appointmentStartsAt: key },
      });
      if (existing) {
        await tx.reminder.update({
          where: { id: existing.id },
          data: { status: 'scheduled', skipReason: null },
        });
        return existing.id;
      }
      return (
        await tx.reminder.create({
          data: { tenantId, ...key, sendAfter: this.deps.clock.now() },
          select: { id: true },
        })
      ).id;
    });
    return this.send(tenantId, reminderId, { ignoreQuietHours: true });
  }

  /** Handles "1" (confirm) and "2" (cancel) replies to a reminder text. */
  readonly handleReply: ContextHandler = async (tx, c) => {
    const action = CONFIRM_REPLIES.has(c.normalizedBody)
      ? 'confirm'
      : CANCEL_REPLIES.has(c.normalizedBody)
        ? 'cancel'
        : null;
    if (!action) return false;
    const reminder = await tx.reminder.findUnique({
      where: { id: c.contextId },
      include: { appointment: { include: { patient: true, provider: true } } },
    });
    if (!reminder) return false;
    const appt = reminder.appointment;
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: c.tenantId } });
    const facts = slotFacts(appt, tenant);
    const audit = {
      actorType: 'patient' as const,
      actorId: appt.patientId,
      entity: 'appointment',
      entityId: appt.id,
    };

    if (!['booked', 'confirmed'].includes(appt.status) || appt.startsAt <= c.now) {
      await c.reply(templates.reminderTooLate(facts));
      return true;
    }

    if (action === 'confirm') {
      // Local only: the mock EHR (and many real ones) have no "confirmed" write API.
      if (appt.status === 'booked') {
        await tx.appointment.update({ where: { id: appt.id }, data: { status: 'confirmed' } });
      }
      await tx.reminder.updateMany({
        where: { appointmentId: appt.id, status: 'scheduled' },
        data: { status: 'cancelled', skipReason: 'confirmed' },
      });
      await recordAudit(tx, c.tenantId, { ...audit, action: 'appointment.confirmed_by_sms' });
      await c.reply(templates.reminderConfirmed(facts));
      return true;
    }

    // Cancel: EHR calls never run inside the inbound transaction; a job does it.
    await this.deps.jobs.send(
      'appointment.cancel-by-patient',
      { tenantId: c.tenantId, appointmentId: appt.id, inboundMessageId: c.inboundMessageId },
      undefined,
      tx,
    );
    await recordAudit(tx, c.tenantId, { ...audit, action: 'appointment.cancel_requested_by_sms' });
    return true;
  };

  /**
   * `appointment.cancel-by-patient` job: cancel in the EHR, then sync, so the regular
   * `appointment.changed` (status_changed -> cancelled) event fires and the slot gets offered.
   * On EHR failure: tell the patient the clinic will follow up and flag their message for staff.
   */
  async cancelByPatient(
    data: JobData<'appointment.cancel-by-patient'>,
  ): Promise<'cancelled' | 'already' | 'failed'> {
    const { tenantId, appointmentId, inboundMessageId } = data;
    const info = await this.deps.db.withTenant(tenantId, async (tx) => ({
      appt: await tx.appointment.findUnique({
        where: { id: appointmentId },
        include: { patient: true, provider: true },
      }),
      tenant: await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
      connection: await tx.ehrConnection.findUnique({ where: { tenantId } }),
    }));
    if (!info.appt || info.appt.status === 'cancelled') return 'already';
    const { appt, tenant } = info;
    const facts = slotFacts(appt, tenant);
    const to = appt.patient.mobileE164;

    let ok = false;
    try {
      if (!info.connection) throw new Error('No EHR connection');
      await this.deps
        .adapterFor({ tenantId, ehrType: info.connection.ehrType })
        .cancelAppointment(appt.ehrAppointmentId, 'Cancelled by patient via SMS');
      ok = true;
    } catch (err) {
      this.deps.logger.error({ err, tenantId, appointmentId }, 'ehr cancel by patient failed');
    }

    await this.deps.db.withTenant(tenantId, async (tx) => {
      if (ok) {
        await tx.reminder.updateMany({
          where: { appointmentId, status: 'scheduled' },
          data: { status: 'cancelled', skipReason: 'appointment_cancelled' },
        });
        await this.deps.jobs.send(
          'ehr.sync',
          { tenantId, mode: 'incremental' },
          { singletonKey: tenantId },
          tx,
        );
        await recordAudit(tx, tenantId, {
          actorType: 'system',
          action: 'appointment.cancelled_in_ehr',
          entity: 'appointment',
          entityId: appointmentId,
        });
      } else {
        await tx.message.updateMany({
          where: { id: inboundMessageId },
          data: { needsAttention: true },
        });
        await this.deps.alerts.notifyOwners(tx, tenantId, 'cancel_failed');
      }
      if (to) {
        await this.deps.messaging.queueSms(tx, {
          tenantId,
          to,
          body: ok ? templates.reminderCancelled(facts) : templates.reminderCancelFailed(facts),
          context: { type: 'system' },
        });
      }
    });
    return ok ? 'cancelled' : 'failed';
  }
}
