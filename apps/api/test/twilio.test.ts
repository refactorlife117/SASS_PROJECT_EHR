import { settingsResponseSchema } from '@slotfill/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadServerEnv } from '../src/lib/env';
import { MessagingService } from '../src/modules/messaging/service';
import { createSmsProviders } from '../src/providers/sms';
import { DevSmsProvider } from '../src/providers/sms/dev';
import { TwilioSmsProvider, twilioSignature } from '../src/providers/sms/twilio';
import { createSmsProviderRegistry } from '../src/providers/sms/types';
import {
  admin,
  buildTestApp,
  cipher,
  createTenant,
  createTestContext,
  createUser,
  RecordingMailer,
  resetDb,
  signIn,
  silentLogger,
  TEST_SESSION_SECRET,
} from './helpers';

const ctx = await createTestContext();
const WEBHOOK_URL = 'https://app.test/api/v1/webhooks/sms/twilio';
const AUTH_TOKEN = 'twilio-auth-token';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

afterAll(() => ctx.close());
beforeEach(resetDb);

/** Twilio provider whose API calls go to a recording fake. */
function twilio() {
  const calls: { url: string; auth: string | null; body: URLSearchParams }[] = [];
  let n = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      auth: new Headers(init?.headers).get('authorization'),
      body: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({ sid: `SM${String(++n).padStart(32, '0')}`, status: 'queued' }),
        { status: 201 },
      ),
    );
  };
  const provider = new TwilioSmsProvider({
    accountSid: 'AC123',
    authToken: AUTH_TOKEN,
    webhookUrl: WEBHOOK_URL,
    fetchImpl,
  });
  return { provider, calls };
}

describe('Twilio provider', () => {
  it('computes X-Twilio-Signature exactly like the official documentation example', () => {
    const params = {
      CallSid: 'CA1234567890ABCDE',
      Caller: '+14158675310',
      Digits: '1234',
      From: '+14158675310',
      To: '+18005551212',
    };
    expect(twilioSignature('12345', 'https://example.com/myapp.php?foo=1&bar=2', params)).toBe(
      'L/OH5YylLD5NRKLltdqwSvS0BnU=',
    );
  });

  it('sends via the Messages API with Basic auth and returns the message SID', async () => {
    const { provider, calls } = twilio();
    const result = await provider.send({ from: '+15550100001', to: '+15550000001', body: 'hi' });
    expect(result.providerMessageId).toMatch(/^SM/);
    expect(calls[0]?.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(calls[0]?.auth).toBe(`Basic ${Buffer.from(`AC123:${AUTH_TOKEN}`).toString('base64')}`);
    expect(Object.fromEntries(calls[0]?.body ?? [])).toEqual({
      To: '+15550000001',
      From: '+15550100001',
      Body: 'hi',
    });
  });

  it('accepts a correctly signed form-encoded inbound webhook, answers TwiML, and rejects forgeries', async () => {
    const tenant = await createTenant('Maple', { smsNumber: '+15550100001' });
    const { provider } = twilio();
    const services = {
      ...ctx.services,
      sms: createSmsProviderRegistry(ctx.services.sms.get('dev') as DevSmsProvider, [provider]),
    };
    const app = createApp({
      services,
      cipher,
      sessionSecret: TEST_SESSION_SECRET,
      cookieSecure: false,
    });
    const params = {
      MessageSid: 'SM-in-1',
      AccountSid: 'AC123',
      From: '+15550000001',
      To: '+15550100001',
      Body: 'STOP',
      NumMedia: '0',
    };

    const ok = await request(app)
      .post('/api/v1/webhooks/sms/twilio')
      .type('form')
      .set('X-Twilio-Signature', twilioSignature(AUTH_TOKEN, WEBHOOK_URL, params))
      .send(params);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/text\/xml/);
    expect(ok.text).toContain('<Response></Response>');
    expect(await admin.smsConsent.findFirst({ where: { tenantId: tenant.id } })).toMatchObject({
      status: 'opted_out',
    });
    expect(await admin.message.findFirst({ where: { direction: 'inbound' } })).toMatchObject({
      provider: 'twilio',
      providerMessageId: 'SM-in-1',
    });

    const forged = await request(app)
      .post('/api/v1/webhooks/sms/twilio')
      .type('form')
      .set('X-Twilio-Signature', twilioSignature('wrong-token', WEBHOOK_URL, params))
      .send({ ...params, MessageSid: 'SM-in-2' });
    expect(forged.status).toBe(403);
  });
});

describe('per-clinic SMS provider', () => {
  it('sends each clinic’s texts through its own provider (Twilio for one, the default for another)', async () => {
    const { provider, calls } = twilio();
    const mailer = new RecordingMailer();
    const registry = createSmsProviderRegistry(
      new DevSmsProvider(mailer, { emailTo: 'x@test', emailFrom: 'y@test' }),
      [provider],
    );
    const messaging = new MessagingService({
      db: ctx.db,
      jobs: ctx.jobs,
      clock: ctx.clock,
      logger: silentLogger,
      providers: registry,
    });
    const onTwilio = await createTenant('Maple', { smsNumber: '+15550100001' });
    await admin.tenant.update({ where: { id: onTwilio.id }, data: { smsProvider: 'twilio' } });
    const onDefault = await createTenant('Cedar', { smsNumber: '+15550100002' });

    const queue = (tenantId: string) =>
      ctx.db.withTenant(tenantId, (tx) =>
        messaging.queueSms(tx, {
          tenantId,
          to: '+15550000001',
          body: 'hello',
          context: { type: 'system' },
        }),
      );
    const a = await queue(onTwilio.id);
    const b = await queue(onDefault.id);
    expect(await messaging.deliver(onTwilio.id, a)).toBe('sent');
    expect(await messaging.deliver(onDefault.id, b)).toBe('sent');

    expect((await admin.message.findUniqueOrThrow({ where: { id: a } })).provider).toBe('twilio');
    expect((await admin.message.findUniqueOrThrow({ where: { id: b } })).provider).toBe('dev');
    expect(calls).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it('fails loudly (never falls back to another provider) when the clinic’s provider is unavailable', async () => {
    const tenant = await createTenant('Maple', { smsNumber: '+15550100001' });
    await admin.tenant.update({ where: { id: tenant.id }, data: { smsProvider: 'twilio' } }); // not configured in ctx
    const id = await ctx.db.withTenant(tenant.id, (tx) =>
      ctx.services.messaging.queueSms(tx, {
        tenantId: tenant.id,
        to: '+15550000001',
        body: 'x',
        context: { type: 'system' },
      }),
    );
    expect(await ctx.services.messaging.deliver(tenant.id, id)).toBe('failed');
    expect(await admin.message.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'failed',
      failureReason: 'provider_unavailable',
    });
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it('owners can choose among configured providers only', async () => {
    const app = buildTestApp(ctx);
    const tenant = await createTenant('Maple', { smsNumber: '+15550100001' });
    await createUser({
      tenantId: tenant.id,
      email: 'owner@maple.test',
      role: 'owner',
      mfaSecret: SECRET,
    });
    const owner = request.agent(app);
    await signIn(owner, 'owner@maple.test', SECRET);

    const settings = settingsResponseSchema.parse((await owner.get('/api/v1/settings')).body);
    expect(settings.clinic).toMatchObject({
      smsProvider: null,
      defaultSmsProvider: 'dev',
      availableSmsProviders: ['dev'],
    });
    expect((await owner.patch('/api/v1/settings').send({ smsProvider: 'twilio' })).status).toBe(
      400,
    );
    expect((await owner.patch('/api/v1/settings').send({ smsProvider: 'dev' })).status).toBe(204);
    expect((await admin.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).smsProvider).toBe(
      'dev',
    );
  });
});

describe('configuration', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5433/slotfill',
    SESSION_SECRET: 'x'.repeat(40),
    ENCRYPTION_KEY: 'ab'.repeat(32),
  };
  const deployed = {
    ...base,
    NODE_ENV: 'production',
    APP_ENV: 'production',
    APP_BASE_URL: 'https://app.example.com',
    SMS_PROVIDER: 'aws',
    AWS_SNS_INBOUND_TOPIC_ARNS: 'arn:aws:sns:us-east-1:1:t',
    TWILIO_ACCOUNT_SID: 'AC1',
    TWILIO_AUTH_TOKEN: 'tok',
  };

  it('refuses Twilio on a deployed server until TWILIO_BAA_SIGNED=true', () => {
    expect(() => loadServerEnv(deployed)).toThrow(/TWILIO_BAA_SIGNED/);
    expect(() => loadServerEnv({ ...deployed, TWILIO_BAA_SIGNED: 'true' })).not.toThrow();
  });

  it('offers Twilio alongside the default provider, and never the dev provider next to a real one', () => {
    const registry = createSmsProviders(loadServerEnv({ ...deployed, TWILIO_BAA_SIGNED: 'true' }));
    expect(registry.defaultName).toBe('aws');
    expect(registry.names().sort()).toEqual(['aws', 'twilio']);
    expect(createSmsProviders(loadServerEnv(base)).names()).toEqual(['dev']);
  });
});
