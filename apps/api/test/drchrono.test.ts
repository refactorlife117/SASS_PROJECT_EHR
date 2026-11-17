import { createHmac } from 'node:crypto';
import { addDays, toDateKey, zonedTimeToUtc } from '@slotfill/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { EhrSyncService } from '../src/modules/ehr/sync';
import { createEhrAdapterFactory, EhrSlotUnavailableError } from '../src/providers/ehr';
import { parseDrChronoTime, toUsE164, type DrChronoConfig } from '../src/providers/ehr/drchrono';
import { startFakeDrChrono, type FakeAppointment } from './fake-drchrono';
import {
  admin,
  auditActions,
  cipher,
  createTenant,
  createTestContext,
  createUser,
  queuedJobs,
  resetDb,
  signIn,
  silentLogger,
  TEST_SESSION_SECRET,
} from './helpers';

const ctx = await createTestContext();
const fake = await startFakeDrChrono();
const NY = 'America/New_York';
const WEBHOOK_SECRET = 'drchrono-webhook-secret';
const config: DrChronoConfig = {
  baseUrl: fake.baseUrl,
  clientId: 'client-id',
  clientSecret: 'client-secret',
};
const services = { ...ctx.services, appBaseUrl: 'https://app.test' };
const app = createApp({
  services,
  cipher,
  sessionSecret: TEST_SESSION_SECRET,
  cookieSecure: false,
  authRateLimit: 1000,
  drchrono: config,
  drchronoWebhookSecret: WEBHOOK_SECRET,
});
const adapterFor = createEhrAdapterFactory({ db: ctx.db, cipher, drchrono: config });
const sync = new EhrSyncService({ db: ctx.db, jobs: ctx.jobs, adapterFor, logger: silentLogger });
const OWNER_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

afterAll(async () => {
  await fake.close();
  await ctx.close();
});
beforeEach(async () => {
  await resetDb();
  fake.appointments.length = 0;
  fake.requests.length = 0;
});

/** Clinic-local naive DrChrono time, `days` from today. */
const local = (days: number, time: string) =>
  `${addDays(toDateKey(new Date(), NY), days)}T${time}:00`;
const utc = (days: number, time: string) =>
  zonedTimeToUtc(addDays(toDateKey(new Date(), NY), days), time, NY);
const fakeAppt = (over: Partial<FakeAppointment>): FakeAppointment => ({
  id: Math.floor(Math.random() * 1e6),
  doctor: 501,
  patient: 7001,
  office: 77,
  exam_room: 3,
  profile: 9,
  scheduled_time: local(3, '09:00'),
  duration: 30,
  status: '',
  updated_at: new Date().toISOString(),
  ...over,
});

/** An owner signs in and connects DrChrono through the real OAuth routes. */
async function connectedClinic() {
  const tenant = await createTenant('Maple Family Clinic', {
    smsNumber: '+15550100001',
    timezone: NY,
  });
  await createUser({
    tenantId: tenant.id,
    email: 'owner@maple.test',
    role: 'owner',
    mfaSecret: OWNER_SECRET,
  });
  const owner = request.agent(app);
  await signIn(owner, 'owner@maple.test', OWNER_SECRET);
  const authorize = await owner.post('/api/v1/ehr/drchrono/authorize');
  const url = new URL((authorize.body as { authorizeUrl: string }).authorizeUrl);
  const callback = await owner
    .get('/api/v1/ehr/drchrono/callback')
    .query({ code: 'good-code', state: url.searchParams.get('state') });
  return { tenant, owner, authorize, url, callback };
}

describe('connecting DrChrono (OAuth2 authorization code)', () => {
  it('builds the authorize URL, exchanges the code, stores encrypted tokens and office defaults, and queues a backfill', async () => {
    const { tenant, url, callback } = await connectedClinic();
    expect(url.origin + url.pathname).toBe(`${fake.baseUrl}/o/authorize/`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.test/api/v1/ehr/drchrono/callback',
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('https://app.test/settings?ehr=connected');
    const connection = await admin.ehrConnection.findUniqueOrThrow({
      where: { tenantId: tenant.id },
    });
    expect(connection).toMatchObject({ ehrType: 'drchrono', status: 'active', lastSyncedAt: null });
    const stored = Buffer.from(connection.credentialsEnc ?? []).toString('utf8');
    expect(stored).not.toContain('access-'); // encrypted at rest
    expect(JSON.parse(cipher.decrypt(connection.credentialsEnc ?? new Uint8Array()))).toMatchObject(
      {
        officeId: 77,
        examRoom: 3,
        refreshToken: expect.stringMatching(/^refresh-/) as unknown,
      },
    );
    expect(await queuedJobs('ehr.sync')).toEqual([{ tenantId: tenant.id, mode: 'full' }]);
    expect(await auditActions(tenant.id)).toContain('ehr.connected');
  });

  it('rejects a callback without the matching signed state cookie', async () => {
    await createTenant('Maple');
    const res = await request(app)
      .get('/api/v1/ehr/drchrono/callback')
      .query({ code: 'good-code', state: 'forged' });
    expect(res.headers.location).toBe('https://app.test/settings?ehr=error');
    expect(await admin.ehrConnection.count()).toBe(0);
  });

  it('only owners may start the connection', async () => {
    const tenant = await createTenant('Maple');
    await createUser({
      tenantId: tenant.id,
      email: 'staff@maple.test',
      role: 'staff',
      mfaSecret: OWNER_SECRET,
    });
    const staff = request.agent(app);
    await signIn(staff, 'staff@maple.test', OWNER_SECRET);
    expect((await staff.post('/api/v1/ehr/drchrono/authorize')).status).toBe(403);
    const status = (await staff.get('/api/v1/ehr/connection')).body as {
      available: string[];
      canEdit: boolean;
    };
    expect(status).toMatchObject({ available: ['drchrono'], canEdit: false });
  });
});

describe('DrChrono adapter (via sync)', () => {
  it('backfills doctors, profiles, patients and appointments with clinic-local times, statuses, breaks and deletions', async () => {
    const { tenant } = await connectedClinic();
    fake.appointments.push(
      fakeAppt({ id: 1, scheduled_time: local(3, '09:00') }),
      fakeAppt({ id: 2, scheduled_time: local(3, '10:00'), status: 'Cancelled' }),
      fakeAppt({ id: 3, scheduled_time: local(4, '11:00'), status: 'Confirmed', profile: null }),
      fakeAppt({ id: 4, scheduled_time: local(4, '12:00'), patient: null, appt_is_break: true }),
      fakeAppt({ id: 5, scheduled_time: local(5, '13:00'), deleted_flag: true }),
      fakeAppt({ id: 6, scheduled_time: local(5, '14:00'), patient: 7002, doctor: 502 }),
    );

    const result = await sync.sync(tenant.id, 'full');
    expect(result).toMatchObject({ mode: 'full', created: 5 }); // the break is not an appointment

    const providers = await admin.provider.findMany({
      where: { tenantId: tenant.id },
      orderBy: { ehrProviderId: 'asc' },
    });
    expect(providers.map((p) => p.displayName)).toEqual(['Dr. Ada Lovelace', 'Dr. Grace Hopper']);
    const visitTypes = await admin.visitType.findMany({
      where: { tenantId: tenant.id },
      orderBy: { code: 'asc' },
    });
    expect(visitTypes.map((v) => [v.code, v.durationMin])).toEqual([
      ['9', 30],
      ['none', 30],
    ]);
    const pat = await admin.patient.findFirstOrThrow({ where: { ehrPatientId: '7001' } });
    expect(pat.mobileE164).toBe('+15551234567');
    expect(
      (await admin.patient.findFirstOrThrow({ where: { ehrPatientId: '7002' } })).mobileE164,
    ).toBeNull();

    const byId = async (id: number) =>
      admin.appointment.findFirstOrThrow({
        where: { tenantId: tenant.id, ehrAppointmentId: String(id) },
      });
    expect((await byId(1)).startsAt).toEqual(utc(3, '09:00'));
    expect((await byId(2)).status).toBe('cancelled');
    expect((await byId(3)).status).toBe('confirmed');
    expect((await byId(5)).status).toBe('cancelled'); // deleted counts as cancelled
    expect(await admin.appointment.count({ where: { ehrAppointmentId: '4' } })).toBe(0);
    // Pagination was followed (more than one appointments page requested).
    expect(
      fake.requests.filter((r) => r.path.startsWith('/api/appointments')).length,
    ).toBeGreaterThan(1);
  });

  it('refreshes an expired access token transparently and persists the new tokens', async () => {
    const { tenant } = await connectedClinic();
    fake.appointments.push(fakeAppt({ id: 1 }));
    const before = cipher.decrypt(
      (await admin.ehrConnection.findUniqueOrThrow({ where: { tenantId: tenant.id } }))
        .credentialsEnc ?? new Uint8Array(),
    );
    fake.expireAccessToken();

    await sync.sync(tenant.id, 'full');
    const after = cipher.decrypt(
      (await admin.ehrConnection.findUniqueOrThrow({ where: { tenantId: tenant.id } }))
        .credentialsEnc ?? new Uint8Array(),
    );
    expect(after).not.toEqual(before);
    expect(
      fake.requests.some(
        (r) => r.auth === `Bearer ${(JSON.parse(after) as { accessToken: string }).accessToken}`,
      ),
    ).toBe(true);
    expect(await admin.appointment.count({ where: { tenantId: tenant.id } })).toBe(1);
  });

  it('checks slots, books with office/exam room at clinic-local time, and cancels with status "Cancelled"', async () => {
    const { tenant } = await connectedClinic();
    fake.appointments.push(fakeAppt({ id: 1, scheduled_time: local(3, '09:00'), duration: 30 }));
    const ehr = adapterFor({ tenantId: tenant.id, ehrType: 'drchrono' });

    expect(
      await ehr.isSlotOpen({ ehrProviderId: '501', startsAt: utc(3, '09:15'), durationMin: 30 }),
    ).toBe(false);
    expect(
      await ehr.isSlotOpen({ ehrProviderId: '501', startsAt: utc(3, '09:30'), durationMin: 30 }),
    ).toBe(true);
    expect(
      await ehr.isSlotOpen({ ehrProviderId: '502', startsAt: utc(3, '09:00'), durationMin: 30 }),
    ).toBe(true);

    const { ehrAppointmentId } = await ehr.bookAppointment({
      ehrPatientId: '7001',
      ehrProviderId: '501',
      startsAt: utc(3, '09:30'),
      durationMin: 30,
      visitType: '9',
    });
    const post = fake.requests.find((r) => r.method === 'POST' && r.path === '/api/appointments');
    expect(post?.body).toEqual({
      doctor: 501,
      patient: 7001,
      office: 77,
      exam_room: 3,
      scheduled_time: local(3, '09:30'),
      duration: 30,
      profile: 9,
    });

    await ehr.cancelAppointment(ehrAppointmentId, 'test');
    expect(fake.appointments.find((a) => String(a.id) === ehrAppointmentId)?.status).toBe(
      'Cancelled',
    );
  });

  it('maps a 409 from DrChrono to "slot unavailable"', async () => {
    const { tenant } = await connectedClinic();
    const conflictFetch: typeof fetch = (input, init) =>
      (input instanceof Request ? input.url : input.toString()).includes('/api/appointments') &&
      init?.method === 'POST'
        ? Promise.resolve(new Response('{}', { status: 409 }))
        : fetch(input, init);
    const conflicting = createEhrAdapterFactory({
      db: ctx.db,
      cipher,
      drchrono: config,
      fetchImpl: conflictFetch,
    })({
      tenantId: tenant.id,
      ehrType: 'drchrono',
    });
    await expect(
      conflicting.bookAppointment({
        ehrPatientId: '7001',
        ehrProviderId: '501',
        startsAt: utc(3, '15:00'),
        durationMin: 30,
        visitType: '9',
      }),
    ).rejects.toBeInstanceOf(EhrSlotUnavailableError);
  });
});

describe('DrChrono webhooks', () => {
  it('answers the verification GET with HMAC-SHA256(secret, msg)', async () => {
    const res = await request(app).get('/api/v1/webhooks/ehr/drchrono').query({ msg: 'abc123' });
    expect(res.body).toEqual({
      secret_token: createHmac('sha256', WEBHOOK_SECRET).update('abc123').digest('hex'),
    });
  });

  it('rejects deliveries without the secret token header', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/ehr/drchrono')
      .set('X-drchrono-event', 'APPOINTMENT_MODIFY')
      .set('X-drchrono-signature', 'wrong')
      .send({ receiver: 'x', object: { doctor: 501 } });
    expect(res.status).toBe(403);
  });

  it('turns an appointment event into an incremental sync for the clinic that owns the doctor', async () => {
    const { tenant } = await connectedClinic();
    fake.appointments.push(fakeAppt({ id: 1 }));
    await sync.sync(tenant.id, 'full'); // providers known locally
    await admin.$executeRawUnsafe('DELETE FROM pgboss.job');

    const post = (doctor: number) =>
      request(app)
        .post('/api/v1/webhooks/ehr/drchrono')
        .set('X-drchrono-event', 'APPOINTMENT_MODIFY')
        .set('X-drchrono-signature', WEBHOOK_SECRET)
        .set('X-drchrono-delivery', 'd-1')
        .send({ receiver: 'x', object: { id: 1, doctor } });
    expect((await post(501)).body).toEqual({ ok: true, outcome: 'sync_queued' });
    expect(await queuedJobs('ehr.sync')).toEqual([{ tenantId: tenant.id, mode: 'incremental' }]);
    expect((await post(999)).body).toEqual({ ok: true, outcome: 'unknown_doctor' });
  });
});

describe('helpers', () => {
  it('normalizes US phone numbers to E.164', () => {
    expect(toUsE164('(555) 123-4567')).toBe('+15551234567');
    expect(toUsE164('1-555-123-4567')).toBe('+15551234567');
    expect(toUsE164('12345')).toBeNull();
    expect(toUsE164(null)).toBeNull();
  });

  it('parses DrChrono local times in the clinic zone and honors explicit offsets', () => {
    expect(parseDrChronoTime('2030-01-07T09:00:00', NY).toISOString()).toBe(
      '2030-01-07T14:00:00.000Z',
    );
    expect(parseDrChronoTime('2030-07-08T09:00:30', NY).toISOString()).toBe(
      '2030-07-08T13:00:30.000Z',
    );
    expect(parseDrChronoTime('2030-01-07T09:00:00Z', NY).toISOString()).toBe(
      '2030-01-07T09:00:00.000Z',
    );
  });
});
