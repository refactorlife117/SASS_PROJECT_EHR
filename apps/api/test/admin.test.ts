import {
  adminClinicDetailSchema,
  adminClinicListResponseSchema,
  adminCreateClinicResponseSchema,
  meResponseSchema,
  settingsResponseSchema,
  teamMemberSchema,
} from '@slotfill/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  admin,
  auditActions,
  buildTestApp,
  createTenant,
  createTestContext,
  createUser,
  errorCode,
  linkTokenFor,
  resetDb,
  signIn,
  totpCode,
} from './helpers';

const ctx = await createTestContext();
const app = buildTestApp(ctx);
const ADMIN_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const OWNER_SECRET = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';
const NEW_PASSWORD = 'a brand new passphrase';

afterAll(() => ctx.close());
beforeEach(async () => {
  await resetDb();
  ctx.email.sent.length = 0;
  ctx.clock.set(new Date());
});

async function platformAdmin() {
  const platform = await createTenant('SlotFill', { isPlatform: true, timezone: 'UTC' });
  const user = await createUser({
    tenantId: platform.id,
    email: 'ops@slotfill.test',
    role: 'platform_admin',
    mfaSecret: ADMIN_SECRET,
  });
  const agent = request.agent(app);
  await signIn(agent, 'ops@slotfill.test', ADMIN_SECRET);
  return { platform, user, agent };
}

async function existingClinic() {
  const tenant = await createTenant('Cedar', { smsNumber: '+15550100002' });
  await createUser({
    tenantId: tenant.id,
    email: 'owner@cedar.test',
    role: 'owner',
    mfaSecret: OWNER_SECRET,
  });
  const agent = request.agent(app);
  await signIn(agent, 'owner@cedar.test', OWNER_SECRET);
  return { tenant, agent };
}

const newClinic = {
  name: 'Birch Family Practice',
  timezone: 'America/Denver',
  contactPhone: '(555) 010-0003',
  smsNumber: '+15550100003',
  ownerEmail: 'Owner@Birch.test',
};

describe('access', () => {
  it('is only for platform admins', async () => {
    const { agent: clinicOwner } = await existingClinic();
    expect((await request(app).get('/api/v1/admin/clinics')).status).toBe(401);
    expect((await clinicOwner.get('/api/v1/admin/clinics')).status).toBe(403);
    expect((await clinicOwner.post('/api/v1/admin/clinics').send(newClinic)).status).toBe(403);
  });

  it('signs platform admins in like everyone else (password + MFA)', async () => {
    const { platform, user, agent } = await platformAdmin();
    const me = meResponseSchema.parse((await agent.get('/api/v1/auth/me')).body);
    expect([me.user.id, me.user.role, me.tenant.id]).toEqual([
      user.id,
      'platform_admin',
      platform.id,
    ]);
  });

  it('keeps platform admins and clinic users apart at the database level', async () => {
    const { platform } = await platformAdmin();
    const { tenant } = await existingClinic();
    await expect(
      createUser({ tenantId: tenant.id, email: 'x@cedar.test', role: 'platform_admin' }),
    ).rejects.toThrow(/platform tenant/);
    await expect(
      createUser({ tenantId: platform.id, email: 'y@slotfill.test', role: 'owner' }),
    ).rejects.toThrow(/platform tenant/);
  });
});

describe('onboarding a clinic', () => {
  it('creates the clinic with default settings and invites its owner, who can then sign in', async () => {
    const { user: ops, agent } = await platformAdmin();
    const res = await agent.post('/api/v1/admin/clinics').send(newClinic);
    expect(res.status).toBe(201);
    const { clinicId } = adminCreateClinicResponseSchema.parse(res.body);

    const clinic = await admin.tenant.findUniqueOrThrow({
      where: { id: clinicId },
      include: { settings: true },
    });
    expect([clinic.name, clinic.timezone, clinic.smsNumber, clinic.isPlatform]).toEqual([
      'Birch Family Practice',
      'America/Denver',
      '+15550100003',
      false,
    ]);
    expect(clinic.settings).not.toBeNull();
    expect(ctx.email.sent.at(-1)?.text).toContain('Birch Family Practice on SlotFill as an owner');

    const audit = await admin.auditLog.findMany({ where: { tenantId: clinicId } });
    expect(audit.map((a) => [a.action, a.actorId])).toEqual([
      ['platform.clinic_created', ops.id],
      ['platform.user_invited', ops.id],
    ]);

    // The owner accepts the invite, enrolls MFA and lands in their new clinic.
    const token = linkTokenFor(ctx.email, 'owner@birch.test');
    await request(app).post('/api/v1/auth/password/reset').send({ token, password: NEW_PASSWORD });
    const owner = request.agent(app);
    await owner
      .post('/api/v1/auth/login')
      .send({ email: 'owner@birch.test', password: NEW_PASSWORD });
    const setup = await owner.post('/api/v1/auth/mfa/setup');
    const secret = (setup.body as { secret: string }).secret;
    const verify = await owner
      .post('/api/v1/auth/mfa/verify')
      .send({ code: await totpCode(secret) });
    expect(meResponseSchema.parse(verify.body).tenant.id).toBe(clinicId);
    const settings = settingsResponseSchema.parse((await owner.get('/api/v1/settings')).body);
    expect([settings.clinic.name, settings.canEdit]).toEqual(['Birch Family Practice', true]);
  });

  it('refuses a texting number another clinic uses', async () => {
    const { agent } = await platformAdmin();
    await existingClinic();
    const res = await agent
      .post('/api/v1/admin/clinics')
      .send({ ...newClinic, smsNumber: '+15550100002' });
    expect([res.status, errorCode(res)]).toEqual([409, 'sms_number_taken']);
  });

  it('refuses an owner email that already has an account and leaves no half-made clinic', async () => {
    const { agent } = await platformAdmin();
    await existingClinic();
    const res = await agent
      .post('/api/v1/admin/clinics')
      .send({ ...newClinic, ownerEmail: 'owner@cedar.test' });
    expect([res.status, errorCode(res)]).toEqual([409, 'email_taken']);
    expect(await admin.tenant.count({ where: { name: newClinic.name } })).toBe(0);
    expect(ctx.email.sent).toHaveLength(0);
  });

  it('validates input (time zone, phone format)', async () => {
    const { agent } = await platformAdmin();
    for (const bad of [{ timezone: 'Mars/Olympus' }, { smsNumber: '555-0100' }, { name: '' }]) {
      const res = await agent.post('/api/v1/admin/clinics').send({ ...newClinic, ...bad });
      expect(res.status).toBe(400);
    }
  });
});

describe('the clinic list and detail', () => {
  it('lists clinics only (not the platform tenant) with operational fields and no patient data', async () => {
    const { platform, agent } = await platformAdmin();
    const { tenant } = await existingClinic();
    await admin.ehrConnection.create({
      data: { tenantId: tenant.id, ehrType: 'mock', status: 'active' },
    });
    await createUser({ tenantId: tenant.id, email: 'gone@cedar.test' }).then((u) =>
      admin.user.update({ where: { id: u.id }, data: { disabledAt: new Date() } }),
    );

    const { clinics } = adminClinicListResponseSchema.parse(
      (await agent.get('/api/v1/admin/clinics')).body,
    );
    expect(clinics.map((c) => c.id)).toEqual([tenant.id]);
    expect(clinics.map((c) => c.id)).not.toContain(platform.id);
    expect(clinics[0]).toMatchObject({
      name: 'Cedar',
      smsNumber: '+15550100002',
      activeUsers: 1,
      invitedUsers: 0,
      ehr: { type: 'mock', status: 'active', lastSyncedAt: null },
    });
  });

  it('shows a clinic’s team; the platform tenant and unknown ids are 404', async () => {
    const { platform, agent } = await platformAdmin();
    const { tenant } = await existingClinic();
    const detail = adminClinicDetailSchema.parse(
      (await agent.get(`/api/v1/admin/clinics/${tenant.id}`)).body,
    );
    expect(detail.users.map((u) => [u.email, u.role, u.status])).toEqual([
      ['owner@cedar.test', 'owner', 'active'],
    ]);
    expect((await agent.get(`/api/v1/admin/clinics/${platform.id}`)).status).toBe(404);
    expect(
      (await agent.get('/api/v1/admin/clinics/00000000-0000-4000-8000-00000000abcd')).status,
    ).toBe(404);
  });

  it('updates a clinic’s details and texting number, and checks the SMS provider exists', async () => {
    const { agent } = await platformAdmin();
    const { tenant } = await existingClinic();
    const res = await agent
      .patch(`/api/v1/admin/clinics/${tenant.id}`)
      .send({ name: 'Cedar Kids', smsNumber: '+15550109999', contactPhone: '' });
    const detail = adminClinicDetailSchema.parse(res.body);
    expect([detail.clinic.name, detail.clinic.smsNumber, detail.clinic.contactPhone]).toEqual([
      'Cedar Kids',
      '+15550109999',
      null,
    ]);
    const bad = await agent
      .patch(`/api/v1/admin/clinics/${tenant.id}`)
      .send({ smsProvider: 'twilio' });
    expect([bad.status, errorCode(bad)]).toEqual([400, 'sms_provider_unavailable']);
    expect(await auditActions(tenant.id)).toContain('platform.clinic_updated');
  });

  it('invites another user into a clinic and resends the invite', async () => {
    const { agent } = await platformAdmin();
    const { tenant } = await existingClinic();
    const res = await agent
      .post(`/api/v1/admin/clinics/${tenant.id}/users`)
      .send({ email: 'new-owner@cedar.test', role: 'owner' });
    const invited = teamMemberSchema.parse(res.body);
    expect([invited.role, invited.status]).toEqual(['owner', 'invited']);
    const first = linkTokenFor(ctx.email, 'new-owner@cedar.test');

    const resend = await agent.post(
      `/api/v1/admin/clinics/${tenant.id}/users/${invited.id}/resend-invite`,
    );
    expect(resend.status).toBe(204);
    expect(linkTokenFor(ctx.email, 'new-owner@cedar.test')).not.toBe(first);
    expect(await auditActions(tenant.id)).toEqual(
      expect.arrayContaining(['platform.user_invited', 'platform.invite_resent']),
    );
  });
});
