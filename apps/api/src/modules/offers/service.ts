import {
  preferredWindowSchema,
  toDateKey,
  toTimeKey,
  weekdayOf,
  type PreferredWindow,
} from '@slotfill/shared';
import { z } from 'zod';
import type { Database, Tx } from '../../db/client';
import type {
  Patient,
  SlotOffer,
  Tenant,
  TenantSettings,
  VisitType,
} from '../../generated/prisma/client';
import type { JobData, JobQueue } from '../../jobs/queues';
import type { Clock } from '../../lib/clock';
import type { Logger } from '../../lib/logger';
import { quietHoursEndAt } from '../../lib/quiet-hours';
import { EhrSlotUnavailableError, type EhrAdapterFactory } from '../../providers/ehr';
import type { AlertService } from '../alerts/service';
import { recordAudit } from '../audit/audit';
import type { ContextHandler, MessagingService } from '../messaging/service';
import { templates, type SlotFacts } from '../messaging/templates';
import type { ReminderService } from '../reminders/service';

const MINUTE = 60_000;
const DAY = 86_400_000;
const YES_REPLIES = new Set(['YES', 'Y']);
const NO_REPLIES = new Set(['NO', 'N']);
/** The EHR is called while the offer row is locked; give it room. */
const ACCEPT_TX_TIMEOUT_MS = 60_000;

export type BatchOutcome = 'sent' | 'deferred' | 'no_candidates' | 'closed' | 'stale';
export type AcceptOutcome = 'won' | 'too_late' | 'slot_gone' | 'failed' | 'ignored';

export interface Candidate {
  waitlistEntryId: string;
  patient: Patient;
  mobileE164: string;
}

/** Thrown inside the accept transaction to roll it back after compensating in the EHR. */
class BookingFailedError extends Error {
  constructor(readonly causeName: string) {
    super('EHR booking failed');
    this.name = 'BookingFailedError';
  }
}

const windowsSchema = z.array(preferredWindowSchema);

/** Does [start, start+duration) fall inside one of the windows (tenant-local)? Null/empty = any. */
export function fitsWindows(
  windows: PreferredWindow[] | null,
  startsAt: Date,
  durationMin: number,
  timezone: string,
): boolean {
  if (!windows || windows.length === 0) return true;
  const dow = weekdayOf(toDateKey(startsAt, timezone));
  const from = toTimeKey(startsAt, timezone);
  const to = toTimeKey(new Date(startsAt.getTime() + durationMin * MINUTE), timezone);
  return windows.some((w) => w.dow.includes(dow) && from >= w.from && to <= w.to && from < to);
}

export class OfferService {
  constructor(
    private readonly deps: {
      db: Database;
      jobs: JobQueue;
      clock: Clock;
      logger: Logger;
      messaging: MessagingService;
      reminders: ReminderService;
      alerts: AlertService;
      adapterFor: EhrAdapterFactory;
    },
  ) {}

  /** A booked/confirmed appointment became cancelled (not during the initial backfill) -> offer it. */
  async onAppointmentChanged(event: JobData<'appointment.changed'>): Promise<void> {
    if (
      event.change === 'status_changed' &&
      event.status === 'cancelled' &&
      (event.previousStatus === 'booked' || event.previousStatus === 'confirmed') &&
      !event.backfill
    ) {
      await this.createForCancellation(event.tenantId, event.appointmentId);
    }
  }

  /** Creates the offer if the slot is inside [now + min notice, now + horizon]. Idempotent. */
  async createForCancellation(tenantId: string, appointmentId: string): Promise<string | null> {
    return this.deps.db.withTenant(tenantId, async (tx) => {
      const appt = await tx.appointment.findUnique({ where: { id: appointmentId } });
      if (appt?.status !== 'cancelled') return null;
      if (await tx.slotOffer.findUnique({ where: { sourceAppointmentId: appointmentId } }))
        return null;
      const settings = await tx.tenantSettings.findUniqueOrThrow({ where: { tenantId } });
      const now = this.deps.clock.now().getTime();
      const start = appt.startsAt.getTime();
      if (
        start < now + settings.minNoticeMin * MINUTE ||
        start > now + settings.backfillHorizonDays * DAY
      ) {
        return null;
      }

      const expiresAt = new Date(start - settings.minNoticeMin * MINUTE);
      const offer = await tx.slotOffer.create({
        data: {
          tenantId,
          providerId: appt.providerId,
          visitTypeId: appt.visitTypeId,
          startsAt: appt.startsAt,
          durationMin: appt.durationMin,
          sourceAppointmentId: appt.id,
          expiresAt,
        },
        select: { id: true },
      });
      await this.deps.jobs.send(
        'offer.next-batch',
        { tenantId, offerId: offer.id, batchNo: 1 },
        undefined,
        tx,
      );
      await this.deps.jobs.send(
        'offer.expire',
        { tenantId, offerId: offer.id },
        { startAfter: expiresAt },
        tx,
      );
      await recordAudit(tx, tenantId, {
        actorType: 'system',
        action: 'offer.created',
        entity: 'slot_offer',
        entityId: offer.id,
      });
      return offer.id;
    });
  }

  /**
   * Waitlist entries eligible for this offer, longest-waiting first (plan §7.5 step 2):
   * provider match (or any), visit fits the slot, earliest date reached, their current appointment
   * (if any) is later, slot inside preferred windows, has a mobile, not opted out, no other offer
   * awaiting their reply, not already offered this slot, and not the patient who just cancelled it.
   * One number gets at most one offer at a time (a shared family phone can't answer for two).
   */
  async findCandidates(
    tx: Tx,
    offer: SlotOffer & { sourceAppointment: { patientId: string } },
    tenant: Tenant,
    limit: number,
  ): Promise<Candidate[]> {
    const entries = await tx.waitlistEntry.findMany({
      where: { status: 'active', OR: [{ providerId: null }, { providerId: offer.providerId }] },
      include: { patient: true, visitType: true, currentAppointment: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const slotDay = toDateKey(offer.startsAt, tenant.timezone);
    const mobiles = [
      ...new Set(entries.map((e) => e.patient.mobileE164).filter((m): m is string => m !== null)),
    ];
    const [optedOut, pending, alreadyOffered] = await Promise.all([
      tx.smsConsent.findMany({
        where: { status: 'opted_out', mobileE164: { in: mobiles } },
        select: { mobileE164: true },
      }),
      tx.offerRecipient.findMany({
        where: { reply: null, outcome: null, offer: { status: 'open' } },
        select: { patientId: true, mobileE164: true },
      }),
      tx.offerRecipient.findMany({
        where: { offerId: offer.id },
        select: { waitlistEntryId: true },
      }),
    ]);
    const blockedMobiles = new Set([
      ...optedOut.map((c) => c.mobileE164),
      ...pending.map((p) => p.mobileE164),
    ]);
    const blockedPatients = new Set([
      offer.sourceAppointment.patientId,
      ...pending.map((p) => p.patientId),
    ]);
    const offeredEntries = new Set(alreadyOffered.map((r) => r.waitlistEntryId));

    const picked: Candidate[] = [];
    for (const e of entries) {
      if (picked.length >= limit) break;
      const mobile = e.patient.mobileE164;
      if (!mobile || blockedMobiles.has(mobile) || blockedPatients.has(e.patientId)) continue;
      if (offeredEntries.has(e.id)) continue;
      if (e.visitType.durationMin > offer.durationMin) continue;
      if (e.earliestDate.toISOString().slice(0, 10) > slotDay) continue;
      const current = e.currentAppointment;
      if (
        current &&
        ['booked', 'confirmed'].includes(current.status) &&
        current.startsAt <= offer.startsAt
      )
        continue;
      const windows = windowsSchema.safeParse(e.preferredWindows);
      if (
        !fitsWindows(
          windows.success ? windows.data : null,
          offer.startsAt,
          e.visitType.durationMin,
          tenant.timezone,
        )
      ) {
        continue;
      }
      picked.push({ waitlistEntryId: e.id, patient: e.patient, mobileE164: mobile });
      blockedMobiles.add(mobile);
    }
    return picked;
  }

  /** `offer.next-batch` job: text the next batch, then check again after the batch timeout. */
  async sendNextBatch(data: JobData<'offer.next-batch'>): Promise<BatchOutcome> {
    const { tenantId, offerId, batchNo } = data;
    return this.deps.db.withTenant(tenantId, async (tx) => {
      await lockOffer(tx, offerId);
      const offer = await tx.slotOffer.findUnique({
        where: { id: offerId },
        include: { provider: true, sourceAppointment: { select: { patientId: true } } },
      });
      if (offer?.status !== 'open') return 'closed';
      if (offer.nextBatchNo !== batchNo) return 'stale'; // a duplicate trigger; this batch already went out
      const now = this.deps.clock.now();
      if (now >= offer.expiresAt) {
        await tx.slotOffer.update({ where: { id: offerId }, data: { status: 'expired' } });
        return 'closed';
      }
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        include: { settings: true },
      });
      const settings = tenant.settings as TenantSettings;
      const schedule = (at: Date) =>
        this.deps.jobs.send(
          'offer.next-batch',
          { tenantId, offerId, batchNo: offer.nextBatchNo },
          { startAfter: at },
          tx,
        );

      const quietEnd = quietHoursEndAt(now, {
        start: settings.quietHoursStart,
        end: settings.quietHoursEnd,
        timezone: tenant.timezone,
      });
      if (quietEnd) {
        if (quietEnd < offer.expiresAt) await schedule(quietEnd);
        return 'deferred';
      }

      const candidates = await this.findCandidates(tx, offer, tenant, settings.offerBatchSize);
      const nextCheck = new Date(now.getTime() + settings.offerBatchTimeoutMin * MINUTE);
      if (candidates.length === 0) {
        // Leave it open until expiry, but look again later: people may join the waitlist meanwhile.
        if (nextCheck < offer.expiresAt) await schedule(nextCheck);
        return 'no_candidates';
      }

      for (const c of candidates) {
        const recipient = await tx.offerRecipient.create({
          data: {
            tenantId,
            offerId,
            waitlistEntryId: c.waitlistEntryId,
            patientId: c.patient.id,
            mobileE164: c.mobileE164,
            batchNo: offer.nextBatchNo,
          },
          select: { id: true },
        });
        const messageId = await this.deps.messaging.queueSms(tx, {
          tenantId,
          to: c.mobileE164,
          body: templates.offer(this.facts(offer, tenant, c.patient.firstName)),
          context: { type: 'offer', id: recipient.id },
        });
        await tx.offerRecipient.update({
          where: { id: recipient.id },
          data: { messageId, sentAt: now },
        });
      }
      const next = offer.nextBatchNo + 1;
      await tx.slotOffer.update({ where: { id: offerId }, data: { nextBatchNo: next } });
      if (nextCheck < offer.expiresAt) {
        await this.deps.jobs.send(
          'offer.next-batch',
          { tenantId, offerId, batchNo: next },
          { startAfter: nextCheck },
          tx,
        );
      }
      return 'sent';
    });
  }

  /** `offer.expire` job. */
  async expire(tenantId: string, offerId: string): Promise<void> {
    await this.deps.db.withTenant(tenantId, async (tx) => {
      await lockOffer(tx, offerId);
      await tx.slotOffer.updateMany({
        where: { id: offerId, status: 'open' },
        data: { status: 'expired' },
      });
    });
  }

  /** Staff cancels an open offer (e.g. the clinic used the slot another way). */
  async cancelByStaff(tenantId: string, offerId: string, userId: string): Promise<boolean> {
    return this.deps.db.withTenant(tenantId, async (tx) => {
      await lockOffer(tx, offerId);
      const updated = await tx.slotOffer.updateMany({
        where: { id: offerId, status: 'open' },
        data: { status: 'cancelled', cancelReason: 'staff' },
      });
      if (updated.count > 0) {
        await recordAudit(tx, tenantId, {
          actorType: 'user',
          actorId: userId,
          action: 'offer.cancelled',
          entity: 'slot_offer',
          entityId: offerId,
        });
      }
      return updated.count > 0;
    });
  }

  /** YES / NO replies to an offer text. YES only records intent; the `offer.accept` job books. */
  readonly handleReply: ContextHandler = async (tx, c) => {
    const yes = YES_REPLIES.has(c.normalizedBody);
    if (!yes && !NO_REPLIES.has(c.normalizedBody)) return false;
    const recipient = await tx.offerRecipient.findUnique({
      where: { id: c.contextId },
      include: { patient: true, offer: { include: { provider: true } } },
    });
    if (!recipient) return false;
    if (recipient.reply) return true; // already answered; ignore repeats

    if (!yes) {
      await tx.offerRecipient.update({
        where: { id: recipient.id },
        data: { reply: 'declined', repliedAt: c.now },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: c.tenantId } });
      await c.reply(
        templates.offerDeclined(this.facts(recipient.offer, tenant, recipient.patient.firstName)),
      );
      return true;
    }
    await tx.offerRecipient.update({
      where: { id: recipient.id },
      data: { reply: 'accepted', repliedAt: c.now, replyMessageId: c.inboundMessageId },
    });
    await this.deps.jobs.send(
      'offer.accept',
      { tenantId: c.tenantId, recipientId: recipient.id },
      undefined,
      tx,
    );
    return true;
  };

  /**
   * `offer.accept` job: race-safe booking (plan §7.6). The offer row is locked FOR UPDATE for the
   * whole decision, so of two concurrent YES replies exactly one books; the other waits, then sees
   * "filled". EHR failures after the slot check roll everything back (with EHR compensation).
   */
  async accept(tenantId: string, recipientId: string): Promise<AcceptOutcome> {
    const outcome = await this.deps.db
      .withTenant(tenantId, (tx) => this.acceptInTx(tx, tenantId, recipientId), {
        timeoutMs: ACCEPT_TX_TIMEOUT_MS,
      })
      .catch((err: unknown) => {
        if (err instanceof BookingFailedError) return 'failed' as const;
        throw err;
      });
    if (outcome === 'failed') await this.recordBookingFailure(tenantId, recipientId);
    return outcome;
  }

  private async acceptInTx(tx: Tx, tenantId: string, recipientId: string): Promise<AcceptOutcome> {
    const rec = await tx.offerRecipient.findUnique({
      where: { id: recipientId },
      include: {
        patient: true,
        waitlistEntry: { include: { visitType: true, currentAppointment: true } },
      },
    });
    if (!rec || rec.outcome !== null || rec.reply !== 'accepted') return 'ignored';

    // Steps 2-3: lock the offer; anything but "open" means someone else got it first.
    await lockOffer(tx, rec.offerId);
    const offer = await tx.slotOffer.findUniqueOrThrow({
      where: { id: rec.offerId },
      include: { provider: true },
    });
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const facts = this.facts(offer, tenant, rec.patient.firstName);
    const tell = (body: string) =>
      this.deps.messaging.queueSms(tx, {
        tenantId,
        to: rec.mobileE164,
        body,
        context: { type: 'system' },
      });
    const now = this.deps.clock.now();

    if (offer.status !== 'open' || now >= offer.expiresAt) {
      await tx.offerRecipient.update({ where: { id: rec.id }, data: { outcome: 'too_late' } });
      await tell(templates.offerTaken(facts));
      return 'too_late';
    }

    const connection = await tx.ehrConnection.findUniqueOrThrow({ where: { tenantId } });
    const ehr = this.deps.adapterFor({ tenantId, ehrType: connection.ehrType });
    const visitType: VisitType = rec.waitlistEntry.visitType;
    const slotGone = async () => {
      await tx.slotOffer.update({
        where: { id: offer.id },
        data: { status: 'cancelled', cancelReason: 'slot_taken_in_ehr' },
      });
      await tx.offerRecipient.update({ where: { id: rec.id }, data: { outcome: 'too_late' } });
      await tell(templates.offerGone(facts));
      return 'slot_gone' as const;
    };

    // Step 4: the EHR is the source of truth; the slot may have been rebooked by front-desk staff.
    const slot = {
      ehrProviderId: offer.provider.ehrProviderId,
      startsAt: offer.startsAt,
      durationMin: visitType.durationMin,
    };
    if (!(await ehr.isSlotOpen(slot))) return slotGone();

    // Step 5: book.
    let booked: { ehrAppointmentId: string };
    try {
      booked = await ehr.bookAppointment({
        ...slot,
        ehrPatientId: rec.patient.ehrPatientId,
        visitType: visitType.code,
      });
    } catch (err) {
      if (err instanceof EhrSlotUnavailableError) return slotGone();
      this.deps.logger.error({ err, tenantId, offerId: offer.id }, 'offer booking failed in EHR');
      throw new BookingFailedError(err instanceof Error ? err.name : 'UnknownError');
    }

    // Step 6: move = cancel their later appointment. On failure, undo the new booking.
    const current = rec.waitlistEntry.currentAppointment;
    const old =
      current &&
      ['booked', 'confirmed'].includes(current.status) &&
      current.startsAt > offer.startsAt
        ? current
        : null;
    if (old) {
      try {
        await ehr.cancelAppointment(old.ehrAppointmentId, 'Moved earlier via SlotFill');
      } catch (err) {
        this.deps.logger.error(
          { err, tenantId, offerId: offer.id },
          'cancel of previous appointment failed; compensating',
        );
        await ehr
          .cancelAppointment(booked.ehrAppointmentId, 'SlotFill booking rolled back')
          .catch((compErr: unknown) => {
            this.deps.logger.error(
              { err: compErr, tenantId, offerId: offer.id },
              'EHR compensation failed',
            );
          });
        throw new BookingFailedError(err instanceof Error ? err.name : 'UnknownError');
      }
    }

    // Step 7: record everything. The new appointment is stored now (source "slotfill"); a later
    // sync matches it by EHR id. ehrUpdatedAt = epoch lets that sync refresh it without an event.
    const appointment = await tx.appointment.create({
      data: {
        tenantId,
        ehrAppointmentId: booked.ehrAppointmentId,
        patientId: rec.patientId,
        providerId: offer.providerId,
        visitTypeId: visitType.id,
        startsAt: offer.startsAt,
        durationMin: visitType.durationMin,
        status: 'booked',
        source: 'slotfill',
        ehrUpdatedAt: new Date(0),
      },
    });
    await tx.slotOffer.update({
      where: { id: offer.id },
      data: {
        status: 'filled',
        filledByPatientId: rec.patientId,
        filledAppointmentId: appointment.id,
        filledVisitTypeId: visitType.id,
        filledAt: now,
      },
    });
    await tx.offerRecipient.update({ where: { id: rec.id }, data: { outcome: 'won' } });
    await tx.waitlistEntry.update({
      where: { id: rec.waitlistEntryId },
      data: { status: 'fulfilled' },
    });
    await this.deps.reminders.plan(tx, appointment);
    // Picks up the old appointment's cancellation -> appointment.changed -> the freed slot is offered on.
    await this.deps.jobs.send(
      'ehr.sync',
      { tenantId, mode: 'incremental' },
      { singletonKey: tenantId },
      tx,
    );
    await recordAudit(tx, tenantId, {
      actorType: 'patient',
      actorId: rec.patientId,
      action: 'offer.accepted',
      entity: 'slot_offer',
      entityId: offer.id,
    });

    // Step 8 (in the same commit): confirmation to the winner, "filled" to everyone still waiting.
    await tell(templates.offerBooked(facts, old?.startsAt ?? null));
    const others = await tx.offerRecipient.findMany({
      where: { offerId: offer.id, id: { not: rec.id }, outcome: null },
      include: { patient: true },
    });
    for (const other of others) {
      if (other.reply === 'declined') continue;
      if (other.reply === 'accepted') {
        await tx.offerRecipient.update({ where: { id: other.id }, data: { outcome: 'too_late' } });
      }
      await this.deps.messaging.queueSms(tx, {
        tenantId,
        to: other.mobileE164,
        body: templates.offerTaken(this.facts(offer, tenant, other.patient.firstName)),
        context: { type: 'system' },
      });
    }
    return 'won';
  }

  /** After a rolled-back booking: tell the patient the clinic will call, flag their reply for staff. */
  private async recordBookingFailure(tenantId: string, recipientId: string): Promise<void> {
    await this.deps.db.withTenant(tenantId, async (tx) => {
      const rec = await tx.offerRecipient.findUniqueOrThrow({
        where: { id: recipientId },
        include: { patient: true, offer: { include: { provider: true } } },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      if (rec.replyMessageId) {
        await tx.message.updateMany({
          where: { id: rec.replyMessageId },
          data: { needsAttention: true },
        });
      }
      await this.deps.messaging.queueSms(tx, {
        tenantId,
        to: rec.mobileE164,
        body: templates.offerBookingFailed(this.facts(rec.offer, tenant, rec.patient.firstName)),
        context: { type: 'system' },
      });
      await recordAudit(tx, tenantId, {
        actorType: 'system',
        action: 'offer.booking_failed',
        entity: 'slot_offer',
        entityId: rec.offerId,
      });
      await this.deps.alerts.notifyOwners(tx, tenantId, 'booking_failed');
    });
  }

  private facts(
    offer: SlotOffer & { provider: { displayName: string } },
    tenant: Tenant,
    firstName: string,
  ): SlotFacts {
    return {
      firstName,
      clinic: tenant.name,
      clinicPhone: tenant.contactPhone,
      provider: offer.provider.displayName,
      startsAt: offer.startsAt,
      timezone: tenant.timezone,
    };
  }
}

/** Prisma has no row-lock API; this is the one raw query for it (plan §7.6). */
async function lockOffer(tx: Tx, offerId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM slot_offers WHERE id = ${offerId}::uuid FOR UPDATE`;
}
