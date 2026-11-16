import { devEhrStateResponseSchema } from '@slotfill/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockAppointment, createMockEhr, inDays } from './ehr-fixtures';
import {
  admin,
  buildTestApp,
  createTenant,
  createTestContext,
  createUser,
  queuedJobs,
  resetDb,
  signIn,
} from './helpers';

const ctx = await createTestContext();
const devApp = buildTestApp(ctx, { devRoutes: true });
const prodLikeApp = buildTestApp(ctx, { devRoutes: false });
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

afterAll(() => ctx.close());
beforeEach(resetDb);

async function setup(app = devApp) {
  const tenant = await createTenant('Maple Family Clinic');
  await createUser({ tenantId: tenant.id, email: 'a@a.test', mfaSecret: SECRET });
  const { provider, patient } = await createMockEhr(tenant.id);
  const appt = await createMockAppointment({
    tenantId: tenant.id,
    patientId: patient.id,
    providerId: provider.id,
    startsAt: inDays(2),
  });
  const agent = request.agent(app);
  await signIn(agent, 'a@a.test', SECRET);
  return { tenant, provider, patient, appt, agent };
}

describe('/dev/ehr routes', () => {
  it('are not mounted unless dev routes are enabled', async () => {
    const { agent, appt } = await setup(prodLikeApp);
    expect((await agent.get('/api/v1/dev/ehr/state')).status).toBe(404);
    expect((await agent.post(`/api/v1/dev/ehr/appointments/${appt.id}/cancel`)).status).toBe(404);
  });

  it('require a signed-in user', async () => {
    expect((await request(devApp).get('/api/v1/dev/ehr/state')).status).toBe(401);
  });

  it('show the mock EHR state for the signed-in user’s tenant', async () => {
    const { agent, appt } = await setup();
    const state = devEhrStateResponseSchema.parse((await agent.get('/api/v1/dev/ehr/state')).body);
    expect(state.timezone).toBe('America/New_York');
    expect(state.appointments.map((a) => a.id)).toEqual([appt.id]);
    expect(state.connection?.lastSyncedAt).toBeNull();
  });

  it('cancel in the mock EHR and notify SlotFill like a webhook (enqueue ehr.sync)', async () => {
    const { agent, appt, tenant } = await setup();
    expect((await agent.post(`/api/v1/dev/ehr/appointments/${appt.id}/cancel`)).status).toBe(204);
    expect((await admin.mockAppointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe(
      'cancelled',
    );
    expect(await queuedJobs('ehr.sync')).toEqual([{ tenantId: tenant.id, mode: 'incremental' }]);
  });

  it('create an appointment at tenant-local time, rejecting overlaps with 409', async () => {
    const { agent, provider, patient } = await setup();
    const body = {
      patientId: patient.id,
      providerId: provider.id,
      visitTypeCode: 'FOLLOWUP',
      date: '2030-01-15',
      time: '09:00',
    };
    expect((await agent.post('/api/v1/dev/ehr/appointments').send(body)).status).toBe(201);
    const created = await admin.mockAppointment.findFirstOrThrow({
      where: { startsAt: { gte: new Date('2030-01-01') } },
    });
    expect(created.startsAt.toISOString()).toBe('2030-01-15T14:00:00.000Z'); // 09:00 EST

    const clash = await agent.post('/api/v1/dev/ehr/appointments').send({ ...body, time: '09:15' });
    expect(clash.status).toBe(409);
  });

  it('move an appointment', async () => {
    const { agent, appt } = await setup();
    const res = await agent
      .post(`/api/v1/dev/ehr/appointments/${appt.id}/move`)
      .send({ date: '2030-07-01', time: '10:30' });
    expect(res.status).toBe(204);
    const moved = await admin.mockAppointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(moved.startsAt.toISOString()).toBe('2030-07-01T14:30:00.000Z'); // 10:30 EDT
  });

  it('cannot touch another tenant’s mock EHR', async () => {
    const { agent } = await setup();
    const other = await createTenant('Cedar Pediatrics');
    const otherEhr = await createMockEhr(other.id);
    const otherAppt = await createMockAppointment({
      tenantId: other.id,
      patientId: otherEhr.patient.id,
      providerId: otherEhr.provider.id,
      startsAt: inDays(2),
    });
    const res = await agent.post(`/api/v1/dev/ehr/appointments/${otherAppt.id}/cancel`);
    expect(res.status).toBe(404); // invisible under RLS, indistinguishable from missing
    expect(
      (await admin.mockAppointment.findUniqueOrThrow({ where: { id: otherAppt.id } })).status,
    ).toBe('booked');
  });
});
