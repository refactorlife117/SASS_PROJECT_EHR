import {
  apiErrorSchema,
  offerDetailResponseSchema,
  offerListResponseSchema,
  patientSearchResponseSchema,
  waitlistEntrySchema,
  waitlistListResponseSchema,
} from '@slotfill/shared';
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
  resetDb,
  signIn,
} from './helpers';

const ctx = await createTestContext();
const app = buildTestApp(ctx);
const SECRET_A = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const SECRET_B = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';

afterAll(() => ctx.close());
beforeEach(resetDb);

async function clinic(name: string, email: string, secret: string) {
  const tenant = await createTenant(name, {
    smsNumber: name === 'Maple' ? '+15550100001' : '+15550100002',
  });
  await createUser({ tenantId: tenant.id, email, mfaSecret: secret });
  const { provider, patient } = await createMockEhr(tenant.id);
  await createMockAppointment({
    tenantId: tenant.id,
    patientId: patient.id,
    providerId: provider.id,
    startsAt: inDays(12),
  });
  await ctx.services.sync.sync(tenant.id, 'full');
  const agent = request.agent(app);
  await signIn(agent, email, secret);
  const localPatient = await admin.patient.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const visitType = await admin.visitType.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const localProvider = await admin.provider.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const appt = await admin.appointment.findFirstOrThrow({ where: { tenantId: tenant.id } });
  return { tenant, agent, patient: localPatient, visitType, provider: localProvider, appt };
}

describe('waitlist API', () => {
  it('requires sign-in', async () => {
    expect((await request(app).get('/api/v1/waitlist')).status).toBe(401);
  });

  it('adds, lists, edits and removes entries, auditing each', async () => {
    const c = await clinic('Maple', 'a@a.test', SECRET_A);
    const created = await c.agent.post('/api/v1/waitlist').send({
      patientId: c.patient.id,
      visitTypeId: c.visitType.id,
      currentAppointmentId: c.appt.id,
      earliestDate: '2030-01-01',
      preferredWindows: [{ dow: [1, 2], from: '09:00', to: '12:00' }],
    });
    expect(created.status).toBe(201);
    const entry = waitlistEntrySchema.parse(created.body);
    expect(entry).toMatchObject({ source: 'staff', provider: null, earliestDate: '2030-01-01' });
    expect(entry.patient.hasMobile).toBe(true);

    const list = waitlistListResponseSchema.parse((await c.agent.get('/api/v1/waitlist')).body);
    expect(list.entries.map((e) => e.id)).toEqual([entry.id]);

    const patched = waitlistEntrySchema.parse(
      (
        await c.agent
          .patch(`/api/v1/waitlist/${entry.id}`)
          .send({ providerId: c.provider.id, preferredWindows: null })
      ).body,
    );
    expect(patched.provider?.id).toBe(c.provider.id);
    expect(patched.preferredWindows).toBeNull();

    expect((await c.agent.delete(`/api/v1/waitlist/${entry.id}`)).status).toBe(204);
    expect(
      waitlistListResponseSchema.parse((await c.agent.get('/api/v1/waitlist')).body).entries,
    ).toEqual([]);
    const removed = waitlistListResponseSchema.parse(
      (await c.agent.get('/api/v1/waitlist').query({ status: 'removed' })).body,
    );
    expect(removed.entries).toHaveLength(1);
    expect(await auditActions(c.tenant.id)).toEqual(
      expect.arrayContaining([
        'waitlist.add',
        'waitlist.list',
        'waitlist.update',
        'waitlist.remove',
      ]),
    );
  });

  it('rejects duplicates, bad windows and another patient’s appointment', async () => {
    const c = await clinic('Maple', 'a@a.test', SECRET_A);
    const body = {
      patientId: c.patient.id,
      visitTypeId: c.visitType.id,
      earliestDate: '2030-01-01',
    };
    expect((await c.agent.post('/api/v1/waitlist').send(body)).status).toBe(201);
    const dup = await c.agent.post('/api/v1/waitlist').send(body);
    expect(apiErrorSchema.parse(dup.body).error.code).toBe('already_waitlisted');

    const badWindow = await c.agent
      .post('/api/v1/waitlist')
      .send({ ...body, preferredWindows: [{ dow: [1], from: '13:00', to: '09:00' }] });
    expect(badWindow.status).toBe(400);

    const other = await admin.patient.create({
      data: { tenantId: c.tenant.id, ehrPatientId: 'x', firstName: 'O', lastName: 'Ther' },
    });
    const wrongAppt = await c.agent
      .post('/api/v1/waitlist')
      .send({ ...body, patientId: other.id, currentAppointmentId: c.appt.id });
    expect(apiErrorSchema.parse(wrongAppt.body).error.code).toBe('invalid_appointment');
  });

  it('cannot see, add or edit another clinic’s patients and entries', async () => {
    const a = await clinic('Maple', 'a@a.test', SECRET_A);
    const b = await clinic('Cedar', 'b@b.test', SECRET_B);
    const bEntry = await b.agent
      .post('/api/v1/waitlist')
      .send({ patientId: b.patient.id, visitTypeId: b.visitType.id, earliestDate: '2030-01-01' });
    const bId = waitlistEntrySchema.parse(bEntry.body).id;

    expect(
      waitlistListResponseSchema.parse((await a.agent.get('/api/v1/waitlist')).body).entries,
    ).toEqual([]);
    const crossAdd = await a.agent
      .post('/api/v1/waitlist')
      .send({ patientId: b.patient.id, visitTypeId: a.visitType.id, earliestDate: '2030-01-01' });
    expect(crossAdd.status).toBe(404);
    expect(
      (await a.agent.patch(`/api/v1/waitlist/${bId}`).send({ earliestDate: '2031-01-01' })).status,
    ).toBe(404);
    expect((await a.agent.delete(`/api/v1/waitlist/${bId}`)).status).toBe(404);
    const search = patientSearchResponseSchema.parse(
      (await a.agent.get('/api/v1/patients').query({ search: 'Pat' })).body,
    );
    expect(search.patients.map((p) => p.id)).toEqual([a.patient.id]);
  });

  it('patient search returns upcoming appointments and only the last 4 digits of the mobile', async () => {
    const c = await clinic('Maple', 'a@a.test', SECRET_A);
    const res = patientSearchResponseSchema.parse(
      (await c.agent.get('/api/v1/patients').query({ search: 'pat exam' })).body,
    );
    expect(res.patients[0]).toMatchObject({ firstName: 'Pat', mobileLast4: '0001' });
    expect(res.patients[0]?.upcomingAppointments).toHaveLength(1);
    expect(JSON.stringify(res)).not.toContain('+1555');
  });
});

describe('offers API', () => {
  async function withOffer() {
    const c = await clinic('Maple', 'a@a.test', SECRET_A);
    const offer = await admin.slotOffer.create({
      data: {
        tenantId: c.tenant.id,
        providerId: c.provider.id,
        visitTypeId: c.visitType.id,
        startsAt: inDays(3),
        durationMin: 30,
        sourceAppointmentId: c.appt.id,
        expiresAt: inDays(2),
      },
    });
    const entry = await admin.waitlistEntry.create({
      data: {
        tenantId: c.tenant.id,
        patientId: c.patient.id,
        visitTypeId: c.visitType.id,
        earliestDate: new Date('2026-01-01'),
        source: 'staff',
      },
    });
    await admin.offerRecipient.create({
      data: {
        tenantId: c.tenant.id,
        offerId: offer.id,
        waitlistEntryId: entry.id,
        patientId: c.patient.id,
        mobileE164: '+15550000001',
        batchNo: 1,
        sentAt: new Date(),
      },
    });
    return { ...c, offer };
  }

  it('lists offers and shows one with its recipient timeline', async () => {
    const { agent, offer } = await withOffer();
    const list = offerListResponseSchema.parse(
      (await agent.get('/api/v1/offers').query({ status: 'open' })).body,
    );
    expect(list.offers).toHaveLength(1);
    expect(list.offers[0]).toMatchObject({ id: offer.id, recipientCount: 1, filledBy: null });

    const detail = offerDetailResponseSchema.parse(
      (await agent.get(`/api/v1/offers/${offer.id}`)).body,
    );
    expect(detail.recipients[0]).toMatchObject({
      batchNo: 1,
      reply: null,
      patient: { firstName: 'Pat' },
    });
  });

  it('staff can cancel an open offer once', async () => {
    const { agent, offer } = await withOffer();
    expect((await agent.post(`/api/v1/offers/${offer.id}/cancel`)).status).toBe(204);
    expect((await admin.slotOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe(
      'cancelled',
    );
    expect((await agent.post(`/api/v1/offers/${offer.id}/cancel`)).status).toBe(409);
  });

  it('never exposes or cancels another clinic’s offer', async () => {
    const { offer } = await withOffer();
    const b = await clinic('Cedar', 'b@b.test', SECRET_B);
    expect(
      offerListResponseSchema.parse((await b.agent.get('/api/v1/offers')).body).offers,
    ).toEqual([]);
    expect((await b.agent.get(`/api/v1/offers/${offer.id}`)).status).toBe(404);
    expect((await b.agent.post(`/api/v1/offers/${offer.id}/cancel`)).status).toBe(409);
    expect((await admin.slotOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe(
      'open',
    );
  });
});
