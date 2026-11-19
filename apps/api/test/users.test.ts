import { loginResponseSchema, teamListResponseSchema, teamMemberSchema } from '@slotfill/shared';
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
  TEST_PASSWORD,
} from './helpers';

const ctx = await createTestContext();
const app = buildTestApp(ctx);
const OWNER_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const STAFF_SECRET = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';
const NEW_PASSWORD = 'a brand new passphrase';
const DAY = 86_400_000;

afterAll(() => ctx.close());
beforeEach(async () => {
  await resetDb();
  ctx.email.sent.length = 0;
  ctx.clock.set(new Date());
});

async function clinic() {
  const tenant = await createTenant('Maple');
  const owner = await createUser({
    tenantId: tenant.id,
    email: 'owner@maple.test',
    role: 'owner',
    mfaSecret: OWNER_SECRET,
  });
  const staff = await createUser({
    tenantId: tenant.id,
    email: 'staff@maple.test',
    role: 'staff',
    mfaSecret: STAFF_SECRET,
  });
  const ownerAgent = request.agent(app);
  await signIn(ownerAgent, 'owner@maple.test', OWNER_SECRET);
  const staffAgent = request.agent(app);
  await signIn(staffAgent, 'staff@maple.test', STAFF_SECRET);
  return { tenant, owner, staff, ownerAgent, staffAgent };
}

const login = (email: string, password = TEST_PASSWORD) =>
  request(app).post('/api/v1/auth/login').send({ email, password });

describe('team list', () => {
  it('shows owners the clinic’s users with their status; staff are refused', async () => {
    const { owner, staff, ownerAgent, staffAgent } = await clinic();
    const res = await ownerAgent.get('/api/v1/users');
    expect(res.status).toBe(200);
    const { users } = teamListResponseSchema.parse(res.body);
    expect(users.map((u) => [u.id, u.role, u.status, u.mfaEnabled, u.isYou])).toEqual([
      [owner.id, 'owner', 'active', true, true],
      [staff.id, 'staff', 'active', true, false],
    ]);
    expect((await staffAgent.get('/api/v1/users')).status).toBe(403);
    expect((await request(app).get('/api/v1/users')).status).toBe(401);
  });
});

describe('inviting', () => {
  it('creates an invited user, emails a link, and the link sets their password once', async () => {
    const { tenant, ownerAgent } = await clinic();
    const res = await ownerAgent
      .post('/api/v1/users')
      .send({ email: 'New@Maple.test', role: 'staff' });
    expect(res.status).toBe(201);
    const invited = teamMemberSchema.parse(res.body);
    expect([invited.email, invited.role, invited.status]).toEqual([
      'new@maple.test',
      'staff',
      'invited',
    ]);

    const mail = ctx.email.sent.at(-1);
    expect(mail?.subject).toBe("You're invited to SlotFill");
    expect(mail?.text).toContain('Maple');
    expect(mail?.text).toContain('/reset-password?invite=1&token=');

    // Nobody can sign in before the invite is accepted.
    expect((await login('new@maple.test')).status).toBe(401);

    const token = linkTokenFor(ctx.email, 'new@maple.test');
    const accept = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token, password: NEW_PASSWORD });
    expect(accept.status).toBe(204);
    const reused = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token, password: NEW_PASSWORD });
    expect(reused.status).toBe(400);

    const signInRes = await login('new@maple.test', NEW_PASSWORD);
    expect(loginResponseSchema.parse(signInRes.body).next).toBe('mfa_setup');
    const user = await admin.user.findUniqueOrThrow({ where: { email: 'new@maple.test' } });
    expect([user.tenantId, user.invitedAt]).toEqual([tenant.id, null]);
    expect(await auditActions(tenant.id)).toContain('user.invited');
  });

  it('refuses an email that already has an account, in any clinic, and creates nothing', async () => {
    const { ownerAgent } = await clinic();
    const other = await createTenant('Cedar');
    await createUser({ tenantId: other.id, email: 'taken@cedar.test' });
    const res = await ownerAgent
      .post('/api/v1/users')
      .send({ email: 'taken@cedar.test', role: 'staff' });
    expect([res.status, errorCode(res)]).toEqual([409, 'email_taken']);
    expect(ctx.email.sent).toHaveLength(0);
  });

  it('only offers clinic roles (never platform_admin)', async () => {
    const { ownerAgent } = await clinic();
    const res = await ownerAgent
      .post('/api/v1/users')
      .send({ email: 'x@maple.test', role: 'platform_admin' });
    expect(res.status).toBe(400);
  });

  it('marks an unused invite as expired after 7 days, and a resend issues a new link', async () => {
    const { ownerAgent } = await clinic();
    const invited = teamMemberSchema.parse(
      (await ownerAgent.post('/api/v1/users').send({ email: 'late@maple.test', role: 'staff' }))
        .body,
    );
    const firstToken = linkTokenFor(ctx.email, 'late@maple.test');
    ctx.clock.advance(8 * DAY);

    const listed = teamListResponseSchema.parse((await ownerAgent.get('/api/v1/users')).body);
    expect(listed.users.find((u) => u.id === invited.id)?.status).toBe('invite_expired');

    expect((await ownerAgent.post(`/api/v1/users/${invited.id}/resend-invite`)).status).toBe(204);
    const secondToken = linkTokenFor(ctx.email, 'late@maple.test');
    expect(secondToken).not.toBe(firstToken);
    const stale = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token: firstToken, password: NEW_PASSWORD });
    expect(stale.status).toBe(400);
    const fresh = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token: secondToken, password: NEW_PASSWORD });
    expect(fresh.status).toBe(204);
  });

  it('won’t resend an invite to someone who already set a password', async () => {
    const { staff, ownerAgent } = await clinic();
    const res = await ownerAgent.post(`/api/v1/users/${staff.id}/resend-invite`);
    expect([res.status, errorCode(res)]).toEqual([409, 'not_invited']);
  });
});

describe('changing users', () => {
  it('changes another user’s role, effective on their very next request', async () => {
    const { staff, ownerAgent, staffAgent } = await clinic();
    expect((await staffAgent.get('/api/v1/users')).status).toBe(403);
    const res = await ownerAgent.patch(`/api/v1/users/${staff.id}`).send({ role: 'owner' });
    expect(teamMemberSchema.parse(res.body).role).toBe('owner');
    expect((await staffAgent.get('/api/v1/users')).status).toBe(200);
  });

  it('never lets owners change their own role or deactivate or reset themselves', async () => {
    const { owner, ownerAgent } = await clinic();
    const patch = await ownerAgent.patch(`/api/v1/users/${owner.id}`).send({ role: 'staff' });
    expect([patch.status, errorCode(patch)]).toEqual([409, 'cannot_change_self']);
    for (const path of ['deactivate', 'reset-mfa']) {
      expect((await ownerAgent.post(`/api/v1/users/${owner.id}/${path}`)).status).toBe(409);
    }
  });

  it('deactivation signs the user out, blocks sign-in and reset links; reactivation restores access', async () => {
    const { tenant, staff, ownerAgent, staffAgent } = await clinic();
    const res = await ownerAgent.post(`/api/v1/users/${staff.id}/deactivate`);
    expect(teamMemberSchema.parse(res.body).status).toBe('disabled');

    expect((await staffAgent.get('/api/v1/auth/me')).status).toBe(401);
    expect((await login('staff@maple.test')).status).toBe(401);
    await request(app).post('/api/v1/auth/password/forgot').send({ email: 'staff@maple.test' });
    expect(ctx.email.sent).toHaveLength(0);

    await ownerAgent.post(`/api/v1/users/${staff.id}/reactivate`);
    expect((await login('staff@maple.test')).status).toBe(200);
    expect(await auditActions(tenant.id)).toEqual(
      expect.arrayContaining(['user.deactivated', 'user.reactivated']),
    );
  });

  it('a deactivated owner can no longer manage the team, even with a session opened before', async () => {
    const { tenant, ownerAgent } = await clinic();
    const second = await createUser({
      tenantId: tenant.id,
      email: 'second@maple.test',
      role: 'owner',
      mfaSecret: STAFF_SECRET,
    });
    const secondAgent = request.agent(app);
    await signIn(secondAgent, 'second@maple.test', STAFF_SECRET);
    const owner = await admin.user.findUniqueOrThrow({ where: { email: 'owner@maple.test' } });

    await secondAgent.post(`/api/v1/users/${owner.id}/deactivate`);
    const res = await ownerAgent.post(`/api/v1/users/${second.id}/deactivate`);
    expect(res.status).toBe(401);
    expect(
      (await admin.user.findUniqueOrThrow({ where: { id: second.id } })).disabledAt,
    ).toBeNull();
  });

  it('resetting two-factor signs the user out and makes them enroll again', async () => {
    const { staff, ownerAgent, staffAgent } = await clinic();
    const res = await ownerAgent.post(`/api/v1/users/${staff.id}/reset-mfa`);
    expect(teamMemberSchema.parse(res.body).mfaEnabled).toBe(false);
    expect((await staffAgent.get('/api/v1/auth/me')).status).toBe(401);
    expect(loginResponseSchema.parse((await login('staff@maple.test')).body).next).toBe(
      'mfa_setup',
    );
  });
});
