import {
  preferredWindowSchema,
  toDateKey,
  type WaitlistCreate,
  type WaitlistEntryDto,
  type WaitlistUpdate,
} from '@slotfill/shared';
import { z } from 'zod';
import type { Database, Tx } from '../../db/client';
import { Prisma } from '../../generated/prisma/client';
import type { JobData, JobQueue } from '../../jobs/queues';
import type { Clock } from '../../lib/clock';
import { AppError } from '../../lib/errors';
import { quietHoursEndAt } from '../../lib/quiet-hours';
import type { ContextHandler, MessagingService } from '../messaging/service';
import { templates } from '../messaging/templates';
import { slotFacts } from '../reminders/service';

const DAY = 86_400_000;
const windowsSchema = z.array(preferredWindowSchema);
const toDbDate = (dateKey: string) => new Date(`${dateKey}T00:00:00.000Z`);

const entryInclude = {
  patient: true,
  provider: true,
  visitType: true,
  currentAppointment: true,
} satisfies Prisma.WaitlistEntryInclude;
type EntryRow = Prisma.WaitlistEntryGetPayload<{ include: typeof entryInclude }>;

export function toWaitlistDto(e: EntryRow): WaitlistEntryDto {
  const windows = windowsSchema.safeParse(e.preferredWindows);
  return {
    id: e.id,
    status: e.status,
    source: e.source,
    earliestDate: e.earliestDate.toISOString().slice(0, 10),
    preferredWindows: windows.success && windows.data.length > 0 ? windows.data : null,
    createdAt: e.createdAt.toISOString(),
    patient: {
      id: e.patient.id,
      firstName: e.patient.firstName,
      lastName: e.patient.lastName,
      hasMobile: e.patient.mobileE164 !== null,
    },
    provider: e.provider ? { id: e.provider.id, displayName: e.provider.displayName } : null,
    visitType: { id: e.visitType.id, name: e.visitType.name, durationMin: e.visitType.durationMin },
    currentAppointment: e.currentAppointment
      ? {
          id: e.currentAppointment.id,
          startsAt: e.currentAppointment.startsAt.toISOString(),
          status: e.currentAppointment.status,
        }
      : null,
  };
}

export class WaitlistService {
  constructor(
    private readonly deps: {
      db: Database;
      jobs: JobQueue;
      clock: Clock;
      messaging: MessagingService;
    },
  ) {}

  async list(tx: Tx, status: WaitlistEntryDto['status']): Promise<WaitlistEntryDto[]> {
    const rows = await tx.waitlistEntry.findMany({
      where: { status },
      include: entryInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toWaitlistDto);
  }

  /** Staff adds a patient. All referenced rows must belong to the tenant (RLS makes others invisible). */
  async create(tx: Tx, tenantId: string, input: WaitlistCreate): Promise<WaitlistEntryDto> {
    const patient = await tx.patient.findUnique({ where: { id: input.patientId } });
    if (!patient) throw new AppError(404, 'patient_not_found', 'Patient not found');
    await this.assertRefs(tx, input.providerId ?? null, input.visitTypeId);
    if (input.currentAppointmentId) {
      const appt = await tx.appointment.findUnique({ where: { id: input.currentAppointmentId } });
      if (appt?.patientId !== patient.id) {
        throw new AppError(400, 'invalid_appointment', "That appointment isn't this patient's");
      }
    }
    const duplicate = await tx.waitlistEntry.findFirst({
      where: { patientId: patient.id, visitTypeId: input.visitTypeId, status: 'active' },
    });
    if (duplicate)
      throw new AppError(
        409,
        'already_waitlisted',
        'Patient is already on the waitlist for this visit type',
      );

    const row = await tx.waitlistEntry.create({
      data: {
        tenantId,
        patientId: patient.id,
        providerId: input.providerId ?? null,
        visitTypeId: input.visitTypeId,
        currentAppointmentId: input.currentAppointmentId ?? null,
        earliestDate: toDbDate(input.earliestDate),
        preferredWindows: input.preferredWindows?.length ? input.preferredWindows : Prisma.DbNull,
        source: 'staff',
      },
      include: entryInclude,
    });
    return toWaitlistDto(row);
  }

  async update(tx: Tx, id: string, input: WaitlistUpdate): Promise<WaitlistEntryDto> {
    const existing = await tx.waitlistEntry.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'not_found', 'Not found');
    if (existing.status === 'fulfilled')
      throw new AppError(409, 'fulfilled', 'This entry was already fulfilled');
    await this.assertRefs(
      tx,
      input.providerId === undefined ? existing.providerId : input.providerId,
      input.visitTypeId ?? existing.visitTypeId,
    );
    const row = await tx.waitlistEntry.update({
      where: { id },
      data: {
        ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
        ...(input.visitTypeId ? { visitTypeId: input.visitTypeId } : {}),
        ...(input.earliestDate ? { earliestDate: toDbDate(input.earliestDate) } : {}),
        ...(input.preferredWindows !== undefined
          ? {
              preferredWindows: input.preferredWindows?.length
                ? input.preferredWindows
                : Prisma.DbNull,
            }
          : {}),
        ...(input.status ? { status: input.status } : {}),
      },
      include: entryInclude,
    });
    return toWaitlistDto(row);
  }

  private async assertRefs(tx: Tx, providerId: string | null, visitTypeId: string): Promise<void> {
    if (providerId && !(await tx.provider.findUnique({ where: { id: providerId } }))) {
      throw new AppError(400, 'invalid_provider', 'Unknown provider');
    }
    if (!(await tx.visitType.findUnique({ where: { id: visitTypeId } }))) {
      throw new AppError(400, 'invalid_visit_type', 'Unknown visit type');
    }
  }

  /**
   * `appointment.changed` (created, booked, far enough out) -> one "Reply EARLY" invite per
   * appointment. Never for the initial backfill: connecting an EHR must not mass-text the calendar.
   */
  async onAppointmentChanged(event: JobData<'appointment.changed'>): Promise<void> {
    if (event.change !== 'created' || event.status !== 'booked' || event.backfill) return;
    await this.deps.db.withTenant(event.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: event.tenantId },
        include: { settings: true },
      });
      const settings = tenant.settings;
      if (!settings?.autoWaitlistInvite) return;
      const appt = await tx.appointment.findUnique({
        where: { id: event.appointmentId },
        include: { patient: true, provider: true, waitlistInvite: true },
      });
      const now = this.deps.clock.now();
      if (appt?.status !== 'booked' || appt.source !== 'ehr' || appt.waitlistInvite) return;
      if (appt.startsAt.getTime() < now.getTime() + settings.autoWaitlistMinDaysOut * DAY) return;
      const mobile = appt.patient.mobileE164;
      if (!mobile || (await this.deps.messaging.isOptedOut(tx, mobile))) return;
      if (
        await tx.waitlistEntry.findFirst({ where: { patientId: appt.patientId, status: 'active' } })
      )
        return;

      const invite = await tx.waitlistInvite.create({
        data: { tenantId: event.tenantId, appointmentId: appt.id },
        select: { id: true },
      });
      const quietEnd = quietHoursEndAt(now, {
        start: settings.quietHoursStart,
        end: settings.quietHoursEnd,
        timezone: tenant.timezone,
      });
      const messageId = await this.deps.messaging.queueSms(tx, {
        tenantId: event.tenantId,
        to: mobile,
        body: templates.waitlistInvite(slotFacts(appt, tenant)),
        context: { type: 'waitlist_invite', id: invite.id },
        ...(quietEnd ? { startAfter: quietEnd } : {}),
      });
      await tx.waitlistInvite.update({ where: { id: invite.id }, data: { messageId } });
    });
  }

  /** "EARLY" in reply to an invite: join the waitlist for the same provider and visit type. */
  readonly handleInviteReply: ContextHandler = async (tx, c) => {
    if (c.normalizedBody !== 'EARLY') return false;
    const invite = await tx.waitlistInvite.findUnique({
      where: { id: c.contextId },
      include: { appointment: { include: { patient: true, provider: true } } },
    });
    if (!invite) return false;
    const appt = invite.appointment;
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: c.tenantId } });
    if (invite.status !== 'accepted') {
      const active = await tx.waitlistEntry.findFirst({
        where: { patientId: appt.patientId, visitTypeId: appt.visitTypeId, status: 'active' },
      });
      if (!active && ['booked', 'confirmed'].includes(appt.status) && appt.startsAt > c.now) {
        await tx.waitlistEntry.create({
          data: {
            tenantId: c.tenantId,
            patientId: appt.patientId,
            providerId: appt.providerId,
            visitTypeId: appt.visitTypeId,
            currentAppointmentId: appt.id,
            earliestDate: toDbDate(toDateKey(c.now, tenant.timezone)),
            source: 'sms_opt_in',
          },
        });
      }
      await tx.waitlistInvite.update({ where: { id: invite.id }, data: { status: 'accepted' } });
    }
    await c.reply(templates.waitlistJoined(slotFacts(appt, tenant)));
    return true;
  };
}
