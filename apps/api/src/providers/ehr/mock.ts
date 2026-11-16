import type { Database, Tx } from '../../db/client';
import type { MockAppointment } from '../../generated/prisma/client';
import {
  EhrSlotUnavailableError,
  type EhrAdapter,
  type EhrAppointment,
  type EhrPatient,
  type EhrProvider,
  type EhrVisitType,
} from './types';

const toEhrAppointment = (row: MockAppointment): EhrAppointment => ({
  ehrAppointmentId: row.id,
  ehrPatientId: row.patientId,
  ehrProviderId: row.providerId,
  visitTypeCode: row.visitTypeCode,
  startsAt: row.startsAt,
  durationMin: row.durationMin,
  status: row.status,
  updatedAt: row.updatedAt,
});

/**
 * A fake EHR stored in mock_* tables (dev/test only). It implements EhrAdapter like a real EHR
 * would, plus a few dev-only operations used by the /dev/ehr controls.
 */
export class MockEhr implements EhrAdapter {
  constructor(
    private readonly db: Database,
    private readonly tenantId: string,
  ) {}

  private run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.withTenant(this.tenantId, fn);
  }

  async listAppointments(range: { from: Date; to: Date }): Promise<EhrAppointment[]> {
    const rows = await this.run((tx) =>
      tx.mockAppointment.findMany({
        where: { startsAt: { gte: range.from, lt: range.to } },
        orderBy: { startsAt: 'asc' },
      }),
    );
    return rows.map(toEhrAppointment);
  }

  async listChangedAppointments(since: Date): Promise<EhrAppointment[]> {
    const rows = await this.run((tx) =>
      tx.mockAppointment.findMany({
        where: { updatedAt: { gte: since } },
        orderBy: { updatedAt: 'asc' },
      }),
    );
    return rows.map(toEhrAppointment);
  }

  async getPatient(ehrPatientId: string): Promise<EhrPatient | null> {
    const row = await this.run((tx) => tx.mockPatient.findUnique({ where: { id: ehrPatientId } }));
    return row
      ? {
          ehrPatientId: row.id,
          firstName: row.firstName,
          lastName: row.lastName,
          mobileE164: row.mobileE164,
        }
      : null;
  }

  async listProviders(): Promise<EhrProvider[]> {
    const rows = await this.run((tx) =>
      tx.mockProvider.findMany({ orderBy: { displayName: 'asc' } }),
    );
    return rows.map((row) => ({ ehrProviderId: row.id, displayName: row.displayName }));
  }

  async listVisitTypes(): Promise<EhrVisitType[]> {
    const rows = await this.run((tx) => tx.mockVisitType.findMany({ orderBy: { code: 'asc' } }));
    return rows.map((row) => ({ code: row.code, name: row.name, durationMin: row.durationMin }));
  }

  isSlotOpen(input: {
    ehrProviderId: string;
    startsAt: Date;
    durationMin: number;
  }): Promise<boolean> {
    return this.run((tx) =>
      slotIsFree(tx, input.ehrProviderId, input.startsAt, input.durationMin, null),
    );
  }

  bookAppointment(input: {
    ehrPatientId: string;
    ehrProviderId: string;
    startsAt: Date;
    durationMin: number;
    visitType: string;
  }): Promise<{ ehrAppointmentId: string }> {
    return this.run(async (tx) => {
      await lockProvider(tx, input.ehrProviderId);
      if (!(await slotIsFree(tx, input.ehrProviderId, input.startsAt, input.durationMin, null))) {
        throw new EhrSlotUnavailableError();
      }
      const row = await tx.mockAppointment.create({
        data: {
          tenantId: this.tenantId,
          patientId: input.ehrPatientId,
          providerId: input.ehrProviderId,
          visitTypeCode: input.visitType,
          startsAt: input.startsAt,
          durationMin: input.durationMin,
          status: 'booked',
        },
      });
      return { ehrAppointmentId: row.id };
    });
  }

  async cancelAppointment(ehrAppointmentId: string, _reason: string): Promise<void> {
    await this.run((tx) =>
      tx.mockAppointment.update({ where: { id: ehrAppointmentId }, data: { status: 'cancelled' } }),
    );
  }

  // ---- Dev-only operations (used by /dev/ehr, not part of EhrAdapter) ----

  /** Reschedule in place. Throws EhrSlotUnavailableError if the new time overlaps. */
  moveAppointment(ehrAppointmentId: string, startsAt: Date): Promise<void> {
    return this.run(async (tx) => {
      const existing = await tx.mockAppointment.findUniqueOrThrow({
        where: { id: ehrAppointmentId },
      });
      await lockProvider(tx, existing.providerId);
      if (
        !(await slotIsFree(tx, existing.providerId, startsAt, existing.durationMin, existing.id))
      ) {
        throw new EhrSlotUnavailableError();
      }
      await tx.mockAppointment.update({ where: { id: ehrAppointmentId }, data: { startsAt } });
    });
  }

  /** Everything the /dev/ehr page shows, for appointments in [from, to). */
  snapshot(range: { from: Date; to: Date }) {
    return this.run(async (tx) => {
      const [providers, visitTypes, patients, appointments] = await Promise.all([
        tx.mockProvider.findMany({ orderBy: { displayName: 'asc' } }),
        tx.mockVisitType.findMany({ orderBy: { code: 'asc' } }),
        tx.mockPatient.findMany({ orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }] }),
        tx.mockAppointment.findMany({
          where: { startsAt: { gte: range.from, lt: range.to } },
          orderBy: { startsAt: 'asc' },
        }),
      ]);
      return { providers, visitTypes, patients, appointments };
    });
  }
}

/** Serialize bookings per provider so two concurrent bookings can't both see a free slot. */
async function lockProvider(tx: Tx, providerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${providerId}, 0))`;
}

async function slotIsFree(
  tx: Tx,
  providerId: string,
  startsAt: Date,
  durationMin: number,
  excludeId: string | null,
): Promise<boolean> {
  const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
  const rows = await tx.$queryRaw<{ taken: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM mock_appointments
      WHERE provider_id = ${providerId}::uuid
        AND status <> 'cancelled'
        AND starts_at < ${endsAt}
        AND starts_at + make_interval(mins => duration_min) > ${startsAt}
        AND (${excludeId}::uuid IS NULL OR id <> ${excludeId}::uuid)
    ) AS taken`;
  return rows[0]?.taken !== true;
}
