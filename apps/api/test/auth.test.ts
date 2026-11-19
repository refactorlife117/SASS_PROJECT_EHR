import { meResponseSchema, mfaSetupResponseSchema } from '@slotfill/shared';
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
  resetDb,
  signIn,
  TEST_PASSWORD,
  totpCode,
} from './helpers';

const ctx = await createTestContext();
const app = buildTestApp(ctx);
const MFA_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

afterAll(() => ctx.close());
beforeEach(resetDb);

async function seedUser(options: { mfa: boolean } = { mfa: true }) {
  const tenant = await createTenant('Maple Family Clinic');
  const user = await createUser({
    tenantId: tenant.id,
    email: 'staff@maple.test',
    ...(options.mfa ? { mfaSecret: MFA_SECRET } : {}),
  });
  return { tenant, user };
}

const sessionCookie = (res: request.Response): string | undefined => {
  const raw = res.headers['set-cookie'] as unknown;
  const cookies = Array.isArray(raw) ? (raw as string[]) : [];
  return cookies.find((c) => c.startsWith('sf_session='));
};

describe('login', () => {
  it('rejects a wrong password and an unknown email with the same response', async () => {
    await seedUser();
    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'staff@maple.test', password: 'nope' });
    const unknownEmail = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@maple.test', password: 'nope' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(sessionCookie(wrongPassword)).toBeUndefined();
  });

  it('records a failed login in the audit log', async () => {
    const { tenant } = await seedUser();
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'staff@maple.test', password: 'nope' });
    expect(await auditActions(tenant.id)).toEqual(['auth.login.failed']);
  });

  it('treats the email case-insensitively', async () => {
    await seedUser();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'Staff@Maple.TEST', password: TEST_PASSWORD });
    expect(res.status).toBe(200);
  });

  it('rejects an invalid body with a 400 that does not echo the input', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: '' });
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe('validation_error');
    expect(JSON.stringify(res.body)).not.toContain('not-an-email');
  });

  it('sets an httpOnly, SameSite=Strict session cookie', async () => {
    await seedUser();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'staff@maple.test', password: TEST_PASSWORD });
    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('rate-limits repeated login attempts', async () => {
    const limitedApp = buildTestApp(ctx, { authRateLimit: 2 });
    const attempt = () =>
      request(limitedApp)
        .post('/api/v1/auth/login')
        .send({ email: 'x@maple.test', password: 'nope' });
    await attempt();
    await attempt();
    const third = await attempt();
    expect(third.status).toBe(429);
    expect(errorCode(third)).toBe('rate_limited');
  });
});

describe('MFA', () => {
  it('does not grant access after the password step alone', async () => {
    await seedUser();
    const agent = request.agent(app);
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: 'staff@maple.test', password: TEST_PASSWORD });
    expect(login.body).toEqual({ next: 'mfa_verify' });

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(401);
    expect(errorCode(me)).toBe('mfa_required');
  });

  it('grants access after a valid code and rotates the session token', async () => {
    const { tenant, user } = await seedUser();
    const agent = request.agent(app);
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: 'staff@maple.test', password: TEST_PASSWORD });
    const verify = await agent
      .post('/api/v1/auth/mfa/verify')
      .send({ code: await totpCode(MFA_SECRET) });

    expect(verify.status).toBe(200);
    expect(sessionCookie(verify)).toBeDefined();
    expect(sessionCookie(verify)).not.toEqual(sessionCookie(login));

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    const body = meResponseSchema.parse(me.body);
    expect(body.user.id).toBe(user.id);
    expect(body.tenant.id).toBe(tenant.id);

    // The pending session was replaced, not kept alongside.
    expect(await admin.session.count({ where: { userId: user.id } })).toBe(1);
    expect(await auditActions(tenant.id)).toEqual([
      'auth.login.password_ok',
      'auth.login.succeeded',
    ]);
  });

  it('rejects a wrong code and audits it', async () => {
    const { tenant } = await seedUser();
    const agent = request.agent(app);
    await agent
      .post('/api/v1/auth/login')
      .send({ email: 'staff@maple.test', password: TEST_PASSWORD });
    const verify = await agent.post('/api/v1/auth/mfa/verify').send({ code: '000000' });

    expect(verify.status).toBe(401);
    expect(errorCode(verify)).toBe('invalid_mfa_code');
    expect(await auditActions(tenant.id)).toContain('auth.mfa.failed');
  });

  it('rejects a code that was already used (replay)', async () => {
    await seedUser();
    const code = await totpCode(MFA_SECRET);

    const first = request.agent(app);
    await first
      .post('/api/v1/auth/login')
      .send({ email: 'staff@maple.test', password: TEST_PASSWORD });
    expect((await first.post('/api/v1/auth/mfa/verify').send({ code })).status).toBe(200);

    const second = request.agent(app);
    await second
      .post('/api/v1/auth/login')
      .send({ email: 'staff@maple.test', password: TEST_PASSWORD });
    expect((await second.post('/api/v1/auth/mfa/verify').send({ code })).status).toBe(401);
  });

  it('enrolls a user without MFA on first login', async () => {
    const { tenant, user } = await seedUser({ mfa: false });
    const agent = request.agent(app);
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: 'staff@maple.test', password: TEST_PASSWORD });
    expect(login.body).toEqual({ next: 'mfa_setup' });

    const setup = mfaSetupResponseSchema.parse((await agent.post('/api/v1/auth/mfa/setup')).body);
    expect(setup.otpauthUrl).toContain('otpauth://totp/');

    const verify = await agent
      .post('/api/v1/auth/mfa/verify')
      .send({ code: await totpCode(setup.secret) });
    expect(verify.status).toBe(200);

    const stored = await admin.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.mfaEnabled).toBe(true);
    // Stored encrypted, never as plaintext.
    expect(Buffer.from(stored.mfaSecretEnc ?? []).toString('utf8')).not.toContain(setup.secret);
    expect(await auditActions(tenant.id)).toContain('auth.mfa.enabled');
  });

  it('refuses to re-run setup for a user already enrolled', async () => {
    await seedUser();
    const agent = request.agent(app);
    await agent
      .post('/api/v1/auth/login')
      .send({ email: 'staff@maple.test', password: TEST_PASSWORD });
    const setup = await agent.post('/api/v1/auth/mfa/setup');
    expect(setup.status).toBe(409);
  });
});

describe('sessions', () => {
  it('logs out: deletes the session and audits it', async () => {
    const { tenant, user } = await seedUser();
    const agent = request.agent(app);
    await signIn(agent, 'staff@maple.test', MFA_SECRET);

    expect((await agent.post('/api/v1/auth/logout')).status).toBe(204);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
    expect(await admin.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await auditActions(tenant.id)).toContain('auth.logout');
  });

  it('expires a session after 15 minutes idle', async () => {
    const { user } = await seedUser();
    const agent = request.agent(app);
    await signIn(agent, 'staff@maple.test', MFA_SECRET);

    await admin.session.updateMany({
      where: { userId: user.id },
      data: { lastSeenAt: new Date(Date.now() - 16 * 60_000) },
    });

    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
    expect(await admin.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('ignores a forged session cookie', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', 'sf_session=forged-token');
    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe('unauthenticated');
  });
});
