import { dashboardSummarySchema, settingsResponseSchema, visitTypeSchema } from '@slotfill/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockAppointment, createMockEhr, inDays } from './ehr-fixtures';
import {
  admin,
  auditActions,
  buildTestApp,
  createTenant,
  createTestContext,
  createUser,
  queuedJobs,
  resetDb,
  signIn,
} from './helpers';

const ctx = await createTestContext();
const { services } = ctx;
const app = buildTestApp(ctx);
const OWNER_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const STAFF_SECRET = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';
const MINUTE = 60_000;

afterAll(() => ctx.close());
beforeEach(async () => {
  await resetDb();
  ctx.clock.set(new Date());
});

async function clinic(name = 'Maple', smsNumber = '+15550100001') {
  const tenant = await createTenant(name, { smsNumber });
  await admin.tenantSettings.update({
    where: { tenantId: tenant.id },
    data: { quietHoursStart: '00:00', quietHoursEnd: '00:00' },
  });
  const domain = name.toLowerCase();
  await createUser({
    tenantId: tenant.id,
    email: `owner@${domain}.test`,
    role: 'owner',
    mfaSecret: OWNER_SECRET,
  });
  await createUser({
    tenantId: tenant.id,
    email: `staff@${domain}.test`,
    role: 'staff',
    mfaSecret: STAFF_SECRET,
  });
  const owner = request.agent(app);
  await signIn(owner, `owner@${domain}.test`, OWNER_SECRET);
  const staff = request.agent(app);
  await signIn(staff, `staff@${domain}.test`, STAFF_SECRET);
  return { tenant, owner, staff };
}

const range = {
  from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
  to: new Date(Date.now() + 86_400_000).toISOString(),
};

describe('dashboard metrics', () => {
  it('computes slots recovered, revenue, fill rate, median time to fill and confirmation rate exactly', async () => {
    const { tenant, staff } = await clinic();
    const t = tenant.id;
    const provider = await admin.provider.create({
      data: { tenantId: t, ehrProviderId: 'p', displayName: 'Dr. P' },
    });
    const cheap = await admin.visitType.create({
      data: { tenantId: t, code: 'A', name: 'A', durationMin: 30, estimatedValueCents: 15_000 },
    });
    const dear = await admin.visitType.create({
      data: { tenantId: t, code: 'B', name: 'B', durationMin: 30, estimatedValueCents: 20_000 },
    });
    const patient = await admin.patient.create({
      data: {
        tenantId: t,
        ehrPatientId: 'x',
        firstName: 'X',
        lastName: 'Y',
        mobileE164: '+15550000001',
      },
    });
    let n = 0;
    const appt = (status: 'booked' | 'cancelled' | 'confirmed' = 'cancelled') =>
      admin.appointment.create({
        data: {
          tenantId: t,
          ehrAppointmentId: `e${String(++n)}`,
          patientId: patient.id,
          providerId: provider.id,
          visitTypeId: cheap.id,
          startsAt: inDays(3),
          durationMin: 30,
          status,
          ehrUpdatedAt: new Date(),
        },
      });
    const created = new Date(Date.now() - 2 * 3_600_000);
    const offer = async (
      status: 'open' | 'filled' | 'expired' | 'cancelled',
      fillMinutes?: number,
      filledVisitTypeId?: string,
    ) =>
      admin.slotOffer.create({
        data: {
          tenantId: t,
          providerId: provider.id,
          visitTypeId: cheap.id,
          startsAt: inDays(3),
          durationMin: 30,
          sourceAppointmentId: (await appt()).id,
          status,
          expiresAt: inDays(2),
          createdAt: created,
          ...(fillMinutes !== undefined
            ? {
                filledAt: new Date(created.getTime() + fillMinutes * MINUTE),
                filledVisitTypeId: filledVisitTypeId ?? null,
              }
            : {}),
        },
      });
    await offer('filled', 10, cheap.id);
    await offer('filled', 30, dear.id);
    await offer('expired');
    await offer('cancelled');
    await offer('open');

    // 4 reminded appointments, 2 confirmed by SMS.
    for (let i = 0; i < 4; i++) {
      const a = await appt(i < 2 ? 'confirmed' : 'booked');
      await admin.reminder.create({
        data: {
          tenantId: t,
          appointmentId: a.id,
          hoursBefore: 24,
          appointmentStartsAt: a.startsAt,
          sendAfter: new Date(),
          status: 'sent',
          sentAt: new Date(),
        },
      });
      if (i < 2) {
        await admin.auditLog.create({
          data: {
            tenantId: t,
            actorType: 'patient',
            action: 'appointment.confirmed_by_sms',
            entity: 'appointment',
            entityId: a.id,
          },
        });
      }
    }
    await admin.message.create({
      data: {
        tenantId: t,
        direction: 'inbound',
        mobileE164: '+15550000001',
        body: '?',
        provider: 'dev',
        status: 'received',
        needsAttention: true,
      },
    });
    await admin.waitlistEntry.create({
      data: {
        tenantId: t,
        patientId: patient.id,
        visitTypeId: cheap.id,
        earliestDate: new Date(),
        source: 'staff',
      },
    });

    const res = await staff.get('/api/v1/dashboard/summary').query(range);
    expect(res.status).toBe(200);
    const s = dashboardSummarySchema.parse(res.body);
    expect(s.offers).toEqual({ created: 5, filled: 2, expired: 1, cancelled: 1, open: 1 });
    expect(s.slotsRecovered).toBe(2);
    expect(s.revenueRecoveredCents).toBe(35_000);
    expect(s.fillRate).toBeCloseTo(2 / 3);
    expect(s.medianTimeToFillSeconds).toBe(20 * 60);
    expect(s.reminders).toEqual({
      remindedAppointments: 4,
      confirmedBySms: 2,
      confirmationRate: 0.5,
    });
    expect(s.now).toEqual({ openOffers: 1, needsAttention: 1, activeWaitlist: 1 });
  });

  it('after a real cancel -> offer -> YES flow, shows the recovered slot and its revenue', async () => {
    const { tenant, staff } = await clinic();
    const { provider, patient } = await createMockEhr(tenant.id);
    const slot = await createMockAppointment({
      tenantId: tenant.id,
      patientId: patient.id,
      providerId: provider.id,
      startsAt: inDays(2),
    });
    const waiter = await admin.mockPatient.create({
      data: { tenantId: tenant.id, firstName: 'Wes', lastName: 'Wait', mobileE164: '+15550000777' },
    });
    await services.sync.sync(tenant.id, 'full');
    await ctx.runJobs();
    const visitType = await admin.visitType.update({
      where: { tenantId_code: { tenantId: tenant.id, code: 'FOLLOWUP' } },
      data: { estimatedValueCents: 18_500 },
    });
    // Wes has no appointment, so the sync never fetched him; add his synced-patient row directly.
    const wes = await admin.patient.create({
      data: {
        tenantId: tenant.id,
        ehrPatientId: waiter.id,
        firstName: 'Wes',
        lastName: 'Wait',
        mobileE164: '+15550000777',
      },
    });
    await admin.waitlistEntry.create({
      data: {
        tenantId: tenant.id,
        patientId: wes.id,
        visitTypeId: visitType.id,
        earliestDate: new Date('2020-01-01'),
        source: 'staff',
      },
    });

    await admin.mockAppointment.update({ where: { id: slot.id }, data: { status: 'cancelled' } });
    await services.sync.sync(tenant.id, 'incremental');
    await ctx.runJobs();
    await services.messaging.handleInbound(
      { providerMessageId: 'yes-1', from: '+15550000777', to: '+15550100001', body: 'YES' },
      'dev',
    );
    await ctx.runJobs();

    const s = dashboardSummarySchema.parse(
      (await staff.get('/api/v1/dashboard/summary').query(range)).body,
    );
    expect(s.slotsRecovered).toBe(1);
    expect(s.revenueRecoveredCents).toBe(18_500);
    expect(s.fillRate).toBe(1);
    expect(s.medianTimeToFillSeconds).not.toBeNull();
  });

  it('only counts the signed-in clinic’s data', async () => {
    const a = await clinic('Maple', '+15550100001');
    const b = await clinic('Cedar', '+15550100002');
    const provider = await admin.provider.create({
      data: { tenantId: a.tenant.id, ehrProviderId: 'p', displayName: 'Dr. P' },
    });
    const vt = await admin.visitType.create({
      data: {
        tenantId: a.tenant.id,
        code: 'A',
        name: 'A',
        durationMin: 30,
        estimatedValueCents: 9_999,
      },
    });
    const patient = await admin.patient.create({
      data: { tenantId: a.tenant.id, ehrPatientId: 'x', firstName: 'X', lastName: 'Y' },
    });
    const src = await admin.appointment.create({
      data: {
        tenantId: a.tenant.id,
        ehrAppointmentId: 'e',
        patientId: patient.id,
        providerId: provider.id,
        visitTypeId: vt.id,
        startsAt: inDays(3),
        durationMin: 30,
        status: 'cancelled',
        ehrUpdatedAt: new Date(),
      },
    });
    await admin.slotOffer.create({
      data: {
        tenantId: a.tenant.id,
        providerId: provider.id,
        visitTypeId: vt.id,
        startsAt: inDays(3),
        durationMin: 30,
        sourceAppointmentId: src.id,
        status: 'filled',
        filledAt: new Date(),
        filledVisitTypeId: vt.id,
        expiresAt: inDays(2),
      },
    });
    const sb = dashboardSummarySchema.parse(
      (await b.staff.get('/api/v1/dashboard/summary').query(range)).body,
    );
    expect(sb.slotsRecovered).toBe(0);
    expect(sb.revenueRecoveredCents).toBe(0);
    const sa = dashboardSummarySchema.parse(
      (await a.staff.get('/api/v1/dashboard/summary').query(range)).body,
    );
    expect(sa.revenueRecoveredCents).toBe(9_999);
  });
});

describe('settings', () => {
  it('staff can read but not change settings; owners can, and it is audited', async () => {
    const { tenant, owner, staff } = await clinic();
    const read = settingsResponseSchema.parse((await staff.get('/api/v1/settings')).body);
    expect(read.canEdit).toBe(false);
    expect(read.settings).toMatchObject({
      reminderHoursBefore: [48, 24],
      offerBatchSize: 3,
      quietHoursStart: '00:00',
    });
    expect((await staff.patch('/api/v1/settings').send({ offerBatchSize: 5 })).status).toBe(403);

    expect(
      (
        await owner
          .patch('/api/v1/settings')
          .send({ offerBatchSize: 5, contactPhone: '(555) 010-0001' })
      ).status,
    ).toBe(204);
    const after = settingsResponseSchema.parse((await owner.get('/api/v1/settings')).body);
    expect(after).toMatchObject({
      canEdit: true,
      settings: { offerBatchSize: 5 },
      clinic: { contactPhone: '(555) 010-0001' },
    });
    expect(await auditActions(tenant.id)).toContain('settings.update');
  });

  it('validates input', async () => {
    const { owner } = await clinic();
    for (const bad of [
      { offerBatchSize: 0 },
      { quietHoursStart: '25:00' },
      { reminderHoursBefore: [24, 24] },
      { reminderHoursBefore: [0] },
      { backfillHorizonDays: 365 },
    ]) {
      expect((await owner.patch('/api/v1/settings').send(bad)).status).toBe(400);
    }
  });

  it('changing reminder offsets re-plans upcoming reminders', async () => {
    const { tenant, owner } = await clinic();
    const { provider, patient } = await createMockEhr(tenant.id);
    await createMockAppointment({
      tenantId: tenant.id,
      patientId: patient.id,
      providerId: provider.id,
      startsAt: inDays(5),
    });
    await services.sync.sync(tenant.id, 'full');
    await ctx.runJobs();
    const appt = await admin.appointment.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const offsets = async () =>
      (await admin.reminder.findMany({ where: { appointmentId: appt.id, status: 'scheduled' } }))
        .map((r) => r.hoursBefore)
        .sort((x, y) => x - y);
    expect(await offsets()).toEqual([24, 48]);

    expect(
      (await owner.patch('/api/v1/settings').send({ reminderHoursBefore: [72, 2] })).status,
    ).toBe(204);
    expect(await queuedJobs('reminder.replan-tenant')).toEqual([{ tenantId: tenant.id }]);
    await ctx.runJobs();
    expect(await offsets()).toEqual([2, 72]);
  });

  it('owners set visit-type values; staff cannot; other clinics’ visit types are invisible', async () => {
    const a = await clinic('Maple', '+15550100001');
    const b = await clinic('Cedar', '+15550100002');
    const vt = await admin.visitType.create({
      data: { tenantId: a.tenant.id, code: 'A', name: 'A', durationMin: 30 },
    });

    expect(
      (await a.staff.patch(`/api/v1/visit-types/${vt.id}`).send({ estimatedValueCents: 100 }))
        .status,
    ).toBe(403);
    const updated = visitTypeSchema.parse(
      (await a.owner.patch(`/api/v1/visit-types/${vt.id}`).send({ estimatedValueCents: 25_000 }))
        .body,
    );
    expect(updated.estimatedValueCents).toBe(25_000);
    expect(
      (await a.owner.patch(`/api/v1/visit-types/${vt.id}`).send({ estimatedValueCents: -1 }))
        .status,
    ).toBe(400);
    expect(
      (await b.owner.patch(`/api/v1/visit-types/${vt.id}`).send({ estimatedValueCents: 1 })).status,
    ).toBe(404);
    expect(
      (await admin.visitType.findUniqueOrThrow({ where: { id: vt.id } })).estimatedValueCents,
    ).toBe(25_000);
  });
});
