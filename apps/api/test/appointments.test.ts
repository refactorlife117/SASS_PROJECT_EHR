import {
  apiErrorSchema,
  appointmentListResponseSchema,
  providerListResponseSchema,
} from '@slotfill/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { EhrSyncService } from '../src/modules/ehr/sync';
import { createEhrAdapterFactory } from '../src/providers/ehr';
import { createMockAppointment, createMockEhr, inDays } from './ehr-fixtures';
import {
  admin,
  cipher,
  auditActions,
  buildTestApp,
  createTenant,
  createTestContext,
  createUser,
  resetDb,
  signIn,
  silentLogger,
} from './helpers';

const ctx = await createTestContext();
const app = buildTestApp(ctx);
const sync = new EhrSyncService({
  db: ctx.db,
  jobs: ctx.jobs,
  adapterFor: createEhrAdapterFactory({ db: ctx.db, cipher }),
  logger: silentLogger,
});
const SECRET_A = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const SECRET_B = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';

afterAll(() => ctx.close());
beforeEach(resetDb);

/** A tenant with a synced schedule: booked in 2 days, cancelled in 3 days, booked in 20 days. */
async function syncedTenant(name: string, email: string, secret: string) {
  const tenant = await createTenant(name);
  await createUser({ tenantId: tenant.id, email, mfaSecret: secret });
  const { provider, patient } = await createMockEhr(tenant.id);
  const base = { tenantId: tenant.id, patientId: patient.id, providerId: provider.id };
  await createMockAppointment({ ...base, startsAt: inDays(2) });
  await createMockAppointment({ ...base, startsAt: inDays(3), status: 'cancelled' });
  await createMockAppointment({ ...base, startsAt: inDays(20) });
  await sync.sync(tenant.id, 'full');
  const agent = request.agent(app);
  await signIn(agent, email, secret);
  return { tenant, agent };
}

const range = (fromDays: number, toDays: number) => ({
  from: inDays(fromDays, 0).toISOString(),
  to: inDays(toDays, 0).toISOString(),
});

describe('GET /api/v1/appointments', () => {
  it('requires a fully signed-in user', async () => {
    const res = await request(app).get('/api/v1/appointments').query(range(0, 7));
    expect(res.status).toBe(401);
  });

  it('lists appointments in the range with patient, provider and visit type, ordered by time', async () => {
    const { agent } = await syncedTenant('Maple', 'a@a.test', SECRET_A);
    const res = await agent.get('/api/v1/appointments').query(range(0, 7));
    expect(res.status).toBe(200);
    const body = appointmentListResponseSchema.parse(res.body);
    expect(body.appointments.map((a) => a.status)).toEqual(['booked', 'cancelled']);
    expect(body.appointments[0]).toMatchObject({
      patient: { firstName: 'Pat', lastName: 'Example' },
      provider: { displayName: 'Dr. Test Provider' },
      visitType: { name: 'Follow-up' },
      durationMin: 30,
    });
    // Minimum necessary: no phone numbers in the list.
    expect(JSON.stringify(res.body)).not.toContain('+1555');
  });

  it('filters by status and provider', async () => {
    const { agent, tenant } = await syncedTenant('Maple', 'a@a.test', SECRET_A);
    const cancelled = appointmentListResponseSchema.parse(
      (await agent.get('/api/v1/appointments').query({ ...range(0, 30), status: 'cancelled' }))
        .body,
    );
    expect(cancelled.appointments).toHaveLength(1);

    const provider = await admin.provider.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const byProvider = appointmentListResponseSchema.parse(
      (await agent.get('/api/v1/appointments').query({ ...range(0, 30), providerId: provider.id }))
        .body,
    );
    expect(byProvider.appointments).toHaveLength(3);
  });

  it('records a PHI list view in the audit log', async () => {
    const { agent, tenant } = await syncedTenant('Maple', 'a@a.test', SECRET_A);
    await agent.get('/api/v1/appointments').query(range(0, 7));
    expect(await auditActions(tenant.id)).toContain('appointment.list');
  });

  it('rejects an inverted or too-long range', async () => {
    const { agent } = await syncedTenant('Maple', 'a@a.test', SECRET_A);
    const inverted = await agent.get('/api/v1/appointments').query(range(7, 0));
    const tooLong = await agent.get('/api/v1/appointments').query(range(0, 90));
    expect(inverted.status).toBe(400);
    expect(tooLong.status).toBe(400);
    expect(apiErrorSchema.parse(tooLong.body).error.code).toBe('validation_error');
  });

  it('never returns another tenant’s appointments, even when filtering by their provider id', async () => {
    const a = await syncedTenant('Maple', 'a@a.test', SECRET_A);
    const b = await syncedTenant('Cedar', 'b@b.test', SECRET_B);
    const bProvider = await admin.provider.findFirstOrThrow({ where: { tenantId: b.tenant.id } });

    const all = appointmentListResponseSchema.parse(
      (await a.agent.get('/api/v1/appointments').query(range(0, 30))).body,
    );
    const aIds = new Set(
      (await admin.appointment.findMany({ where: { tenantId: a.tenant.id } })).map((x) => x.id),
    );
    expect(all.appointments).toHaveLength(3);
    expect(all.appointments.every((x) => aIds.has(x.id))).toBe(true);

    const probe = appointmentListResponseSchema.parse(
      (
        await a.agent
          .get('/api/v1/appointments')
          .query({ ...range(0, 30), providerId: bProvider.id })
      ).body,
    );
    expect(probe.appointments).toEqual([]);
  });
});

describe('GET /api/v1/providers', () => {
  it('lists only the current tenant’s providers', async () => {
    const a = await syncedTenant('Maple', 'a@a.test', SECRET_A);
    await syncedTenant('Cedar', 'b@b.test', SECRET_B);
    const body = providerListResponseSchema.parse((await a.agent.get('/api/v1/providers')).body);
    expect(body.providers).toHaveLength(1);
  });
});


 