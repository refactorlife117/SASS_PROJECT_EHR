import type { Database, Tx } from '../../db/client';
import type { AppointmentStatus } from '../../generated/prisma/client';
import type { JobData, JobQueue } from '../../jobs/queues';
import type { Logger } from '../../lib/logger';
import type {
  EhrAdapter,
  EhrAdapterFactory,
  EhrAppointment,
  EhrPatient,
  EhrProvider,
  EhrVisitType,
} from '../../providers/ehr';

/** Full sync covers appointments from yesterday to this many days ahead. */
export const SYNC_WINDOW_DAYS = 60;
const FULL_SYNC_LOOKBACK_MS = 24 * 3_600_000;
/** Incremental sync re-reads this much before the cursor, to tolerate clock skew and late commits. */
const CHANGE_OVERLAP_MS = 60_000;
const SYNC_TX_TIMEOUT_MS = 120_000;
const PATIENT_FETCH_CONCURRENCY = 10;

export type SyncMode = 'incremental' | 'full';

export interface SyncResult {
  skipped: boolean;
  mode?: SyncMode;
  appointmentsSeen?: number;
  created?: number;
  updated?: number;
  ignored?: number;
  events?: number;
}

interface Fetched {
  appointments: EhrAppointment[];
  providers: EhrProvider[];
  visitTypes: EhrVisitType[];
  patients: EhrPatient[];
}

type Change = JobData<'appointment.changed'>['change'];

export class EhrSyncService {
  constructor(
    private readonly deps: {
      db: Database;
      jobs: JobQueue;
      adapterFor: EhrAdapterFactory;
      logger: Logger;
      now?: () => Date;
    },
  ) {}

  async sync(tenantId: string, requestedMode: SyncMode): Promise<SyncResult> {
    const { db, logger } = this.deps;
    const connection = await db.withTenant(tenantId, (tx) =>
      tx.ehrConnection.findUnique({ where: { tenantId } }),
    );
    if (!connection || connection.status === 'disabled') return { skipped: true };

    const startedAt = this.deps.now?.() ?? new Date();
    const mode: SyncMode =
      requestedMode === 'full' || connection.lastSyncedAt === null ? 'full' : 'incremental';
    const adapter = this.deps.adapterFor({ tenantId, ehrType: connection.ehrType });

    try {
      const fetched = await this.fetch(tenantId, adapter, mode, connection.lastSyncedAt, startedAt);
      const result = await db.withTenant(
        tenantId,
        (tx) => this.apply(tx, tenantId, fetched, mode, startedAt),
        { timeoutMs: SYNC_TX_TIMEOUT_MS },
      );
      logger.info({ tenantId, ...result }, 'ehr sync completed');
      return result;
    } catch (err) {
      // Store only the error's class name: messages from an EHR could contain PHI.
      const lastError = err instanceof Error ? err.name : 'UnknownError';
      await db.withTenant(tenantId, (tx) =>
        tx.ehrConnection.update({ where: { tenantId }, data: { lastError } }),
      );
      throw err;
    }
  }

  /** All EHR calls happen here, outside any DB transaction. */
  private async fetch(
    tenantId: string,
    adapter: EhrAdapter,
    mode: SyncMode,
    lastSyncedAt: Date | null,
    startedAt: Date,
  ): Promise<Fetched> {
    const appointments =
      mode === 'full' || lastSyncedAt === null
        ? await adapter.listAppointments({
            from: new Date(startedAt.getTime() - FULL_SYNC_LOOKBACK_MS),
            to: new Date(startedAt.getTime() + SYNC_WINDOW_DAYS * 86_400_000),
          })
        : await adapter.listChangedAppointments(
            new Date(lastSyncedAt.getTime() - CHANGE_OVERLAP_MS),
          );

    const referencedPatients = unique(appointments.map((a) => a.ehrPatientId));
    const local = await this.deps.db.withTenant(tenantId, async (tx) => ({
      providers: new Set(
        (await tx.provider.findMany({ select: { ehrProviderId: true } })).map(
          (p) => p.ehrProviderId,
        ),
      ),
      visitTypes: new Set(
        (await tx.visitType.findMany({ select: { code: true } })).map((v) => v.code),
      ),
      patients: new Set(
        (
          await tx.patient.findMany({
            where: { ehrPatientId: { in: referencedPatients } },
            select: { ehrPatientId: true },
          })
        ).map((p) => p.ehrPatientId),
      ),
    }));

    const full = mode === 'full';
    const needProviders = full || appointments.some((a) => !local.providers.has(a.ehrProviderId));
    const needVisitTypes = full || appointments.some((a) => !local.visitTypes.has(a.visitTypeCode));
    const patientIds = full
      ? referencedPatients
      : referencedPatients.filter((id) => !local.patients.has(id));

    const patients: EhrPatient[] = [];
    for (let i = 0; i < patientIds.length; i += PATIENT_FETCH_CONCURRENCY) {
      const batch = await Promise.all(
        patientIds.slice(i, i + PATIENT_FETCH_CONCURRENCY).map((id) => adapter.getPatient(id)),
      );
      for (const patient of batch) if (patient) patients.push(patient);
    }

    return {
      appointments,
      providers: needProviders ? await adapter.listProviders() : [],
      visitTypes: needVisitTypes ? await adapter.listVisitTypes() : [],
      patients,
    };
  }

  /** Upserts and event emission in one tenant transaction: events commit only with their data. */
  private async apply(
    tx: Tx,
    tenantId: string,
    fetched: Fetched,
    mode: SyncMode,
    startedAt: Date,
  ): Promise<SyncResult> {
    for (const p of fetched.providers) {
      await tx.provider.upsert({
        where: { tenantId_ehrProviderId: { tenantId, ehrProviderId: p.ehrProviderId } },
        create: { tenantId, ehrProviderId: p.ehrProviderId, displayName: p.displayName },
        update: { displayName: p.displayName },
      });
    }
    for (const v of fetched.visitTypes) {
      await tx.visitType.upsert({
        where: { tenantId_code: { tenantId, code: v.code } },
        create: { tenantId, code: v.code, name: v.name, durationMin: v.durationMin },
        // estimatedValueCents belongs to the clinic, not the EHR: never overwritten here.
        update: { name: v.name, durationMin: v.durationMin },
      });
    }
    for (const p of fetched.patients) {
      const data = { firstName: p.firstName, lastName: p.lastName, mobileE164: p.mobileE164 };
      await tx.patient.upsert({
        where: { tenantId_ehrPatientId: { tenantId, ehrPatientId: p.ehrPatientId } },
        create: { tenantId, ehrPatientId: p.ehrPatientId, ...data },
        update: data,
      });
    }

    const appts = fetched.appointments;
    const [providers, visitTypes, patients, existing] = await Promise.all([
      tx.provider.findMany({ select: { id: true, ehrProviderId: true } }),
      tx.visitType.findMany({ select: { id: true, code: true } }),
      tx.patient.findMany({
        where: { ehrPatientId: { in: unique(appts.map((a) => a.ehrPatientId)) } },
        select: { id: true, ehrPatientId: true },
      }),
      tx.appointment.findMany({
        where: { ehrAppointmentId: { in: appts.map((a) => a.ehrAppointmentId) } },
      }),
    ]);
    const providerIds = new Map(providers.map((p) => [p.ehrProviderId, p.id]));
    const visitTypeIds = new Map(visitTypes.map((v) => [v.code, v.id]));
    const patientIds = new Map(patients.map((p) => [p.ehrPatientId, p.id]));
    const existingByEhrId = new Map(existing.map((a) => [a.ehrAppointmentId, a]));

    let created = 0;
    let updated = 0;
    let ignored = 0;
    let events = 0;

    for (const appt of appts) {
      const providerId = providerIds.get(appt.ehrProviderId);
      const visitTypeId = visitTypeIds.get(appt.visitTypeCode);
      const patientId = patientIds.get(appt.ehrPatientId);
      if (!providerId || !visitTypeId || !patientId) {
        ignored++;
        this.deps.logger.warn(
          { tenantId, ehrAppointmentId: appt.ehrAppointmentId },
          'ehr appointment references unknown provider/visit type/patient; skipped',
        );
        continue;
      }

      const prev = existingByEhrId.get(appt.ehrAppointmentId);
      if (prev && prev.ehrUpdatedAt.getTime() >= appt.updatedAt.getTime()) continue; // unchanged or stale

      const status = mergeStatus(prev?.status ?? null, appt.status);
      const data = {
        patientId,
        providerId,
        visitTypeId,
        startsAt: appt.startsAt,
        durationMin: appt.durationMin,
        status,
        ehrUpdatedAt: appt.updatedAt,
      };

      let appointmentId: string;
      let change: Change | null;
      if (!prev) {
        appointmentId = (
          await tx.appointment.create({
            data: { tenantId, ehrAppointmentId: appt.ehrAppointmentId, ...data },
            select: { id: true },
          })
        ).id;
        created++;
        change = 'created';
      } else {
        await tx.appointment.update({ where: { id: prev.id }, data });
        appointmentId = prev.id;
        updated++;
        change =
          prev.status !== status
            ? 'status_changed'
            : prev.startsAt.getTime() !== appt.startsAt.getTime() || prev.providerId !== providerId
              ? 'rescheduled'
              : null;
      }

      if (change) {
        await this.deps.jobs.send(
          'appointment.changed',
          { tenantId, appointmentId, change, previousStatus: prev?.status ?? null, status },
          undefined,
          tx,
        );
        events++;
      }
    }

    await tx.ehrConnection.update({
      where: { tenantId },
      data: {
        lastSyncedAt: startedAt,
        lastError: null,
        ...(mode === 'full' ? { lastFullSyncAt: startedAt } : {}),
      },
    });

    return {
      skipped: false,
      mode,
      appointmentsSeen: appts.length,
      created,
      updated,
      ignored,
      events,
    };
  }
}

/**
 * SlotFill records confirmations locally (patient replied "1"). Most EHRs keep such appointments as
 * "booked", so an EHR "booked" must not downgrade a local "confirmed".
 */
function mergeStatus(
  local: AppointmentStatus | null,
  fromEhr: AppointmentStatus,
): AppointmentStatus {
  return local === 'confirmed' && fromEhr === 'booked' ? 'confirmed' : fromEhr;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
