import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueSyncForAllTenants, jobHandlers, runBatch } from '../src/jobs/handlers';
import { EhrSyncService } from '../src/modules/ehr/sync';
import { createEhrAdapterFactory, EhrSlotUnavailableError } from '../src/providers/ehr';
import { MockEhr } from '../src/providers/ehr/mock';
import { createMockAppointment, createMockEhr, inDays } from './ehr-fixtures';
import {
  admin,
  cipher,
  createTenant,
  createTestContext,
  queuedJobs,
  resetDb,
  silentLogger,
} from './helpers';

const ctx = await createTestContext();
const { db, jobs } = ctx;
const sync = new EhrSyncService({
  db,
  jobs,
  adapterFor: createEhrAdapterFactory({ db, cipher }),
  logger: silentLogger,
});

afterAll(() => ctx.close());
beforeEach(resetDb);

async function tenantWithOneAppointment() {
  const tenant = await createTenant('Maple Family Clinic');
  const { provider, patient } = await createMockEhr(tenant.id);
  const appt = await createMockAppointment({
    tenantId: tenant.id,
    patientId: patient.id,
    providerId: provider.id,
    startsAt: inDays(3),
  });
  return { tenant, provider, patient, appt, mock: new MockEhr(db, tenant.id) };
}

const changedEvents = () =>
  queuedJobs('appointment.changed') as Promise<
    { change: string; status: string; previousStatus: string | null }[]
  >;

describe('full sync (backfill)', () => {
  it('copies providers, visit types, patients and appointments from the EHR', async () => {
    const { tenant, appt, patient } = await tenantWithOneAppointment();

    const result = await sync.sync(tenant.id, 'incremental'); // never synced -> runs full
    expect(result).toMatchObject({ skipped: false, mode: 'full', created: 1 });

    const local = await admin.appointment.findMany({
      where: { tenantId: tenant.id },
      include: { patient: true, provider: true, visitType: true },
    });
    expect(local).toHaveLength(1);
    expect(local[0]).toMatchObject({
      ehrAppointmentId: appt.id,
      status: 'booked',
      source: 'ehr',
      durationMin: 30,
      patient: { ehrPatientId: patient.id, firstName: 'Pat', mobileE164: '+15550000001' },
      provider: { displayName: 'Dr. Test Provider' },
      visitType: { code: 'FOLLOWUP', durationMin: 30, estimatedValueCents: 0 },
    });

    const connection = await admin.ehrConnection.findUniqueOrThrow({
      where: { tenantId: tenant.id },
    });
    expect(connection.lastSyncedAt).not.toBeNull();
    expect(connection.lastFullSyncAt).not.toBeNull();
  });

  it('emits appointment.changed "created" for new appointments, in the same transaction', async () => {
    const { tenant } = await tenantWithOneAppointment();
    await sync.sync(tenant.id, 'full');
    const local = await admin.appointment.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(await queuedJobs('appointment.changed')).toEqual([
      {
        tenantId: tenant.id,
        appointmentId: local.id,
        change: 'created',
        previousStatus: null,
        status: 'booked',
        backfill: true, // first sync of this connection
      },
    ]);
  });

  it('is idempotent: a second sync with no EHR changes writes nothing and emits nothing', async () => {
    const { tenant } = await tenantWithOneAppointment();
    await sync.sync(tenant.id, 'full');
    const second = await sync.sync(tenant.id, 'full');
    expect(second).toMatchObject({ created: 0, updated: 0, events: 0 });
    expect(await changedEvents()).toHaveLength(1);
  });

  it('skips tenants without an EHR connection', async () => {
    const tenant = await createTenant('No EHR');
    expect(await sync.sync(tenant.id, 'full')).toEqual({ skipped: true });
  });
});

describe('incremental sync', () => {
  it('picks up a cancellation and emits status_changed with the previous status', async () => {
    const { tenant, appt, mock } = await tenantWithOneAppointment();
    await sync.sync(tenant.id, 'full');

    await mock.cancelAppointment(appt.id, 'patient called');
    const result = await sync.sync(tenant.id, 'incremental');

    expect(result).toMatchObject({ mode: 'incremental', updated: 1, events: 1 });
    const local = await admin.appointment.findFirstOrThrow({
      where: { ehrAppointmentId: appt.id },
    });
    expect(local.status).toBe('cancelled');
    expect((await changedEvents()).at(-1)).toMatchObject({
      change: 'status_changed',
      previousStatus: 'booked',
      status: 'cancelled',
    });
  });

  it('picks up a reschedule and emits rescheduled', async () => {
    const { tenant, appt, mock } = await tenantWithOneAppointment();
    await sync.sync(tenant.id, 'full');

    const newTime = inDays(5);
    await mock.moveAppointment(appt.id, newTime);
    await sync.sync(tenant.id, 'incremental');

    const local = await admin.appointment.findFirstOrThrow({
      where: { ehrAppointmentId: appt.id },
    });
    expect(local.startsAt.toISOString()).toBe(newTime.toISOString());
    expect((await changedEvents()).at(-1)).toMatchObject({
      change: 'rescheduled',
      status: 'booked',
    });
  });

  it('fetches a patient it has never seen when a new appointment references them', async () => {
    const { tenant, provider } = await tenantWithOneAppointment();
    await sync.sync(tenant.id, 'full');

    const newPatient = await admin.mockPatient.create({
      data: { tenantId: tenant.id, firstName: 'New', lastName: 'Patient', mobileE164: null },
    });
    await createMockAppointment({
      tenantId: tenant.id,
      patientId: newPatient.id,
      providerId: provider.id,
      startsAt: inDays(4),
    });
    const result = await sync.sync(tenant.id, 'incremental');

    expect(result).toMatchObject({ created: 1 });
    const patient = await admin.patient.findFirstOrThrow({
      where: { ehrPatientId: newPatient.id },
    });
    expect(patient).toMatchObject({ firstName: 'New', mobileE164: null });
  });

  it('does not downgrade a locally confirmed appointment when the EHR still says booked', async () => {
    const { tenant, appt, mock } = await tenantWithOneAppointment();
    await sync.sync(tenant.id, 'full');
    await admin.appointment.updateMany({
      where: { ehrAppointmentId: appt.id },
      data: { status: 'confirmed' },
    });

    await mock.moveAppointment(appt.id, inDays(6)); // touches the EHR row; status still booked there
    await sync.sync(tenant.id, 'incremental');

    const local = await admin.appointment.findFirstOrThrow({
      where: { ehrAppointmentId: appt.id },
    });
    expect(local.status).toBe('confirmed');
  });

  it('ignores stale EHR data older than what was already applied', async () => {
    const { tenant, appt } = await tenantWithOneAppointment();
    await sync.sync(tenant.id, 'full');
    // Pretend we already applied a newer version than the EHR has.
    await admin.appointment.updateMany({
      where: { ehrAppointmentId: appt.id },
      data: { ehrUpdatedAt: new Date(Date.now() + 3_600_000), status: 'no_show' },
    });

    await sync.sync(tenant.id, 'full');
    const local = await admin.appointment.findFirstOrThrow({
      where: { ehrAppointmentId: appt.id },
    });
    expect(local.status).toBe('no_show');
  });
});

describe('tenant isolation', () => {
  it('syncing one tenant never reads or writes another tenant’s data', async () => {
    const a = await tenantWithOneAppointment();
    const b = await createTenant('Cedar Pediatrics');
    const bEhr = await createMockEhr(b.id);
    await createMockAppointment({
      tenantId: b.id,
      patientId: bEhr.patient.id,
      providerId: bEhr.provider.id,
      startsAt: inDays(2),
    });

    await sync.sync(a.tenant.id, 'full');

    expect(await admin.appointment.count({ where: { tenantId: a.tenant.id } })).toBe(1);
    expect(await admin.appointment.count({ where: { tenantId: b.id } })).toBe(0);
    expect(await admin.patient.count({ where: { tenantId: b.id } })).toBe(0);
  });

  it('the mock EHR adapter for one tenant cannot see another tenant’s mock data', async () => {
    const a = await tenantWithOneAppointment();
    const b = await createTenant('Cedar Pediatrics');
    await createMockEhr(b.id);
    const providers = await new MockEhr(db, b.id).listProviders();
    expect(providers.map((p) => p.ehrProviderId)).not.toContain(a.provider.id);
    expect(await new MockEhr(db, b.id).getPatient(a.patient.id)).toBeNull();
  });
});

describe('mock EHR adapter booking', () => {
  it('reports a taken slot as not open and refuses to double-book it', async () => {
    const { tenant, provider, patient, mock } = await tenantWithOneAppointment();
    const taken = { ehrProviderId: provider.id, startsAt: inDays(3), durationMin: 30 };
    const overlapping = { ...taken, startsAt: new Date(taken.startsAt.getTime() + 15 * 60_000) };
    const free = { ...taken, startsAt: new Date(taken.startsAt.getTime() + 30 * 60_000) };

    expect(await mock.isSlotOpen(taken)).toBe(false);
    expect(await mock.isSlotOpen(overlapping)).toBe(false);
    expect(await mock.isSlotOpen(free)).toBe(true);
    await expect(
      mock.bookAppointment({ ...overlapping, ehrPatientId: patient.id, visitType: 'FOLLOWUP' }),
    ).rejects.toBeInstanceOf(EhrSlotUnavailableError);
    expect(await admin.mockAppointment.count({ where: { tenantId: tenant.id } })).toBe(1);
  });

  it('frees the slot once the appointment is cancelled', async () => {
    const { provider, appt, mock } = await tenantWithOneAppointment();
    await mock.cancelAppointment(appt.id, 'test');
    expect(
      await mock.isSlotOpen({
        ehrProviderId: provider.id,
        startsAt: appt.startsAt,
        durationMin: 30,
      }),
    ).toBe(true);
  });

  it('lets exactly one of two concurrent bookings for the same slot win', async () => {
    const { provider, patient, mock } = await tenantWithOneAppointment();
    const slot = {
      ehrPatientId: patient.id,
      ehrProviderId: provider.id,
      startsAt: inDays(8),
      durationMin: 30,
      visitType: 'FOLLOWUP',
    };
    const results = await Promise.allSettled([
      mock.bookAppointment(slot),
      mock.bookAppointment(slot),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('transactional job enqueue', () => {
  it('a job sent inside a tenant transaction is queued only if the transaction commits', async () => {
    const tenant = await createTenant('Maple Family Clinic');
    const payload = { tenantId: tenant.id, mode: 'full' as const };

    await expect(
      db.withTenant(tenant.id, async (tx) => {
        await jobs.send('ehr.sync', payload, undefined, tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await queuedJobs('ehr.sync')).toEqual([]);

    await db.withTenant(tenant.id, (tx) => jobs.send('ehr.sync', payload, undefined, tx));
    expect(await queuedJobs('ehr.sync')).toEqual([payload]);
  });
});

describe('worker jobs', () => {
  it('ehr.sync-all enqueues one incremental sync per tenant with an active connection', async () => {
    const a = await tenantWithOneAppointment();
    const b = await createTenant('Cedar Pediatrics');
    await createMockEhr(b.id);
    const disabled = await createTenant('Disabled clinic');
    await createMockEhr(disabled.id);
    await admin.ehrConnection.update({
      where: { tenantId: disabled.id },
      data: { status: 'disabled' },
    });
    await createTenant('No EHR');

    const deps = ctx.services;
    expect(await enqueueSyncForAllTenants(deps, 'incremental')).toBe(2);
    const queued = (await queuedJobs('ehr.sync')) as { tenantId: string; mode: string }[];
    expect(queued.map((j) => j.tenantId).sort()).toEqual([a.tenant.id, b.id].sort());
    expect(queued.every((j) => j.mode === 'incremental')).toBe(true);
  });

  it('does not queue a second sync for a tenant that already has one waiting', async () => {
    const { tenant } = await tenantWithOneAppointment();
    const deps = ctx.services;
    await enqueueSyncForAllTenants(deps, 'incremental');
    await enqueueSyncForAllTenants(deps, 'incremental');
    expect(await queuedJobs('ehr.sync')).toEqual([{ tenantId: tenant.id, mode: 'incremental' }]);
  });

  it('settles each job in a batch on its own: one bad payload does not fail the others', async () => {
    const { tenant } = await tenantWithOneAppointment();
    const deps = ctx.services;
    const results = await runBatch('ehr.sync', deps, [
      { id: 'good', data: { tenantId: tenant.id, mode: 'full' } },
      { id: 'bad', data: { tenantId: 'not-a-uuid', mode: 'full' } },
    ] as never);
    expect(results).toEqual([
      { id: 'good', status: 'completed' },
      { id: 'bad', status: 'failed', output: { error: 'ZodError' } },
    ]);
    expect(await admin.appointment.count({ where: { tenantId: tenant.id } })).toBe(1);
  });

  it('the ehr.sync handler validates its payload and runs the sync', async () => {
    const { tenant } = await tenantWithOneAppointment();
    const deps = ctx.services;
    await jobHandlers['ehr.sync'](deps, {
      id: 'j1',
      data: { tenantId: tenant.id, mode: 'full' },
    } as never);
    expect(await admin.appointment.count({ where: { tenantId: tenant.id } })).toBe(1);
    await expect(
      jobHandlers['ehr.sync'](deps, { id: 'j2', data: { tenantId: 'not-a-uuid' } } as never),
    ).rejects.toThrow();
  });
});
