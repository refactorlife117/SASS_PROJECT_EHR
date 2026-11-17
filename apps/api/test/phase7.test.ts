import { createSign, generateKeyPairSync } from 'node:crypto';
import type { SendTextMessageCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { AwsSmsProvider, snsStringToSign } from '../src/providers/sms/aws';
import { createSmsProviderRegistry } from '../src/providers/sms/types';
import {
  admin,
  auditActions,
  buildTestApp,
  cipher,
  createTenant,
  createTestContext,
  createUser,
  resetDb,
  signIn,
  TEST_APP_BASE_URL,
  TEST_SESSION_SECRET,
  totpCode,
} from './helpers';

const ctx = await createTestContext();
const app = buildTestApp(ctx);
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const TOPIC = 'arn:aws:sns:us-east-1:123456789012:slotfill-inbound';
const CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem';

afterAll(() => ctx.close());
beforeEach(async () => {
  await resetDb();
  ctx.email.sent.length = 0;
  ctx.clock.set(new Date());
});

// ---------------------------------------------------------------------------------------------
// AWS End User Messaging SMS + SNS
// ---------------------------------------------------------------------------------------------

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function snsMessage(
  fields: Record<string, string>,
  options: { version?: '1' | '2'; tamper?: boolean } = {},
): Record<string, string> {
  const version = options.version ?? '2';
  const envelope = {
    SignatureVersion: version,
    SigningCertURL: CERT_URL,
    Timestamp: '2026-11-17T10:00:00.000Z',
    TopicArn: TOPIC,
    MessageId: crypto.randomUUID(),
    ...fields,
  };
  const signer = createSign(version === '1' ? 'RSA-SHA1' : 'RSA-SHA256');
  signer.update(
    snsStringToSign({ ...envelope, Signature: '' } as Parameters<typeof snsStringToSign>[0]),
    'utf8',
  );
  const signature = signer.sign(privateKey, 'base64');
  return {
    ...envelope,
    Signature: signature,
    ...(options.tamper ? { Message: `${fields.Message ?? ''}x` } : {}),
  };
}

const inbound = (body: string, from = '+15550000001', to = '+15550100001') =>
  snsMessage({
    Type: 'Notification',
    Message: JSON.stringify({
      originationNumber: from,
      destinationNumber: to,
      messageKeyword: 'KEYWORD',
      messageBody: body,
      inboundMessageId: crypto.randomUUID(),
      previousPublishedMessageId: 'prev',
    }),
  });

function awsProvider(confirmed: string[] = []) {
  const sent: SendTextMessageCommand[] = [];
  const provider = new AwsSmsProvider(
    {
      send: (command) => {
        sent.push(command);
        return Promise.resolve({ MessageId: 'aws-msg-1' });
      },
    },
    {
      allowedTopicArns: [TOPIC],
      configurationSetName: 'slotfill-events',
      fetchCertificate: () => Promise.resolve(publicPem),
      confirmSubscription: (url) => {
        confirmed.push(url);
        return Promise.resolve();
      },
    },
  );
  return { provider, sent };
}
const asReq = (body: unknown) =>
  ({ body: typeof body === 'string' ? body : JSON.stringify(body) }) as never;

describe('aws SMS provider', () => {
  it('sends a transactional SMS from the clinic number and returns the AWS MessageId', async () => {
    const { provider, sent } = awsProvider();
    expect(await provider.send({ from: '+15550100001', to: '+15550000001', body: 'hi' })).toEqual({
      providerMessageId: 'aws-msg-1',
    });
    expect(sent[0]?.input).toEqual({
      DestinationPhoneNumber: '+15550000001',
      OriginationIdentity: '+15550100001',
      MessageBody: 'hi',
      MessageType: 'TRANSACTIONAL',
      ConfigurationSetName: 'slotfill-events',
    });
  });

  it('accepts a correctly signed SNS notification (SignatureVersion 2 and 1) and parses the two-way payload', async () => {
    const { provider } = awsProvider();
    for (const version of ['2', '1'] as const) {
      const msg = snsMessage(
        {
          Type: 'Notification',
          Message: JSON.stringify({
            originationNumber: '+15550000001',
            destinationNumber: '+15550100001',
            messageBody: 'YES',
            inboundMessageId: 'in-1',
          }),
        },
        { version },
      );
      expect(await provider.verifyInbound(asReq(msg))).toBe(true);
      expect(await provider.parseInbound(asReq(msg))).toEqual({
        providerMessageId: 'in-1',
        from: '+15550000001',
        to: '+15550100001',
        body: 'YES',
      });
    }
  });

  it('rejects tampered messages, unknown topics and non-SNS certificate hosts', async () => {
    const { provider } = awsProvider();
    expect(
      await provider.verifyInbound(
        asReq(snsMessage({ Type: 'Notification', Message: '{}' }, { tamper: true })),
      ),
    ).toBe(false);
    expect(
      await provider.verifyInbound(
        asReq({ ...inbound('hi'), TopicArn: 'arn:aws:sns:us-east-1:999:evil' }),
      ),
    ).toBe(false);
    expect(
      await provider.verifyInbound(
        asReq({ ...inbound('hi'), SigningCertURL: 'https://evil.example.com/cert.pem' }),
      ),
    ).toBe(false);
    expect(await provider.verifyInbound(asReq('not json'))).toBe(false);
  });

  it('confirms an SNS subscription (only to an SNS URL) and produces no inbound message', async () => {
    const confirmed: string[] = [];
    const { provider } = awsProvider(confirmed);
    const sub = snsMessage({
      Type: 'SubscriptionConfirmation',
      Message: 'confirm',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
      Token: 't',
    });
    expect(await provider.verifyInbound(asReq(sub))).toBe(true);
    expect(await provider.parseInbound(asReq(sub))).toBeNull();
    expect(confirmed).toEqual([
      'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
    ]);
    const evil = snsMessage({
      Type: 'SubscriptionConfirmation',
      Message: 'confirm',
      SubscribeURL: 'https://evil.example.com/x',
      Token: 't',
    });
    expect(await provider.verifyInbound(asReq(evil))).toBe(false);
  });

  it('end to end: a signed SNS post to /webhooks/sms/aws runs the inbound pipeline (text/plain body)', async () => {
    const tenant = await createTenant('Maple', { smsNumber: '+15550100001' });
    const { provider } = awsProvider();
    const awsApp = createApp({
      services: { ...ctx.services, sms: createSmsProviderRegistry(provider) },
      cipher,
      sessionSecret: TEST_SESSION_SECRET,
      cookieSecure: false,
    });
    const res = await request(awsApp)
      .post('/api/v1/webhooks/sms/aws')
      .set('Content-Type', 'text/plain; charset=UTF-8')
      .set('x-amz-sns-message-type', 'Notification')
      .send(JSON.stringify(inbound('STOP')));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'opted_out' });
    expect(await admin.smsConsent.findFirst({ where: { tenantId: tenant.id } })).toMatchObject({
      status: 'opted_out',
    });

    const forged = await request(awsApp)
      .post('/api/v1/webhooks/sms/aws')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ ...inbound('STOP'), Signature: 'AAAA' }));
    expect(forged.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------------------------

describe('password reset', () => {
  async function user() {
    const tenant = await createTenant('Maple');
    await createUser({ tenantId: tenant.id, email: 'staff@maple.test', mfaSecret: SECRET });
    return tenant;
  }
  const tokenFromEmail = () => {
    const text = ctx.email.sent.at(-1)?.text ?? '';
    return decodeURIComponent(/token=([^\s]+)/.exec(text)?.[1] ?? '');
  };

  it('emails a single-use link, sets the new password, signs out everywhere, keeps MFA', async () => {
    const tenant = await user();
    const existing = request.agent(app);
    await signIn(existing, 'staff@maple.test', SECRET);

    expect(
      (await request(app).post('/api/v1/auth/password/forgot').send({ email: 'STAFF@maple.test' }))
        .status,
    ).toBe(202);
    expect(ctx.email.sent).toHaveLength(1);
    expect(ctx.email.sent[0]).toMatchObject({
      to: 'staff@maple.test',
      subject: 'Reset your SlotFill password',
    });
    expect(ctx.email.sent[0]?.text).toContain(`${TEST_APP_BASE_URL}/reset-password?token=`);
    const token = tokenFromEmail();
    expect(
      (await admin.user.findFirstOrThrow({ where: { email: 'staff@maple.test' } })).resetTokenHash,
    ).not.toContain(token);

    expect(
      (
        await request(app)
          .post('/api/v1/auth/password/reset')
          .send({ token, password: 'a brand new passphrase' })
      ).status,
    ).toBe(204);
    expect((await existing.get('/api/v1/auth/me')).status).toBe(401); // signed out everywhere
    expect(
      (
        await request(app)
          .post('/api/v1/auth/password/reset')
          .send({ token, password: 'another new passphrase' })
      ).status,
    ).toBe(400); // single use

    const fresh = request.agent(app);
    const login = await fresh
      .post('/api/v1/auth/login')
      .send({ email: 'staff@maple.test', password: 'a brand new passphrase' });
    expect(login.body).toEqual({ next: 'mfa_verify' }); // MFA still required
    // The earlier sign-in used this 30 s TOTP step; replay protection would (rightly) reject it again.
    await admin.user.updateMany({
      where: { email: 'staff@maple.test' },
      data: { mfaLastTimeStep: null },
    });
    expect(
      (await fresh.post('/api/v1/auth/mfa/verify').send({ code: await totpCode(SECRET) })).status,
    ).toBe(200);
    expect(await auditActions(tenant.id)).toEqual(
      expect.arrayContaining(['auth.password_reset_requested', 'auth.password_reset']),
    );
  });

  it('answers the same for unknown emails and sends nothing', async () => {
    await user();
    expect(
      (await request(app).post('/api/v1/auth/password/forgot').send({ email: 'nobody@maple.test' }))
        .status,
    ).toBe(202);
    expect(ctx.email.sent).toEqual([]);
  });

  it('rejects expired tokens, garbage tokens and short passwords', async () => {
    await user();
    await request(app).post('/api/v1/auth/password/forgot').send({ email: 'staff@maple.test' });
    const token = tokenFromEmail();
    expect(
      (await request(app).post('/api/v1/auth/password/reset').send({ token, password: 'short' }))
        .status,
    ).toBe(400);
    ctx.clock.advance(31 * 60_000);
    const expired = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token, password: 'a long enough passphrase' });
    expect(expired.status).toBe(400);
    const garbage = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token: 'x'.repeat(40), password: 'a long enough passphrase' });
    expect(garbage.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
// Staff alerts + readiness
// ---------------------------------------------------------------------------------------------

describe('staff alerts', () => {
  it('emails only the clinic’s owners, with no patient data, when queued in a transaction', async () => {
    const tenant = await createTenant('Maple');
    await createUser({ tenantId: tenant.id, email: 'owner@maple.test', role: 'owner' });
    await createUser({ tenantId: tenant.id, email: 'staff@maple.test', role: 'staff' });
    const other = await createTenant('Cedar');
    await createUser({ tenantId: other.id, email: 'owner@cedar.test', role: 'owner' });

    await ctx.db.withTenant(tenant.id, (tx) =>
      ctx.services.alerts.notifyOwners(tx, tenant.id, 'booking_failed'),
    );
    await ctx.runJobs();
    expect(ctx.email.sent.map((m) => m.to)).toEqual(['owner@maple.test']);
    expect(ctx.email.sent[0]?.subject).toBe('SlotFill: a booking needs your attention');
    expect(ctx.email.sent[0]?.text).toContain(`${TEST_APP_BASE_URL}/messages`);
    expect(JSON.stringify(ctx.email.sent)).not.toMatch(/\+1\d{10}/);
  });
});

describe('readiness', () => {
  it('reports ready when the database is reachable', async () => {
    const res = await request(app).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
