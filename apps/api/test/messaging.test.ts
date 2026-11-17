import { devSmsConversationsResponseSchema, messageListResponseSchema } from '@slotfill/shared';
import { z } from 'zod';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MessagingService, type ContextHandler } from '../src/modules/messaging/service';
import {
  admin,
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
const { db, services } = ctx;
const app = buildTestApp(ctx);
const devApp = buildTestApp(ctx, { devRoutes: true });

const CLINIC = '+15550100001';
const OTHER_CLINIC = '+15550100002';
const PATIENT = '+15550001234';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

afterAll(() => ctx.close());
beforeEach(async () => {
  await resetDb();
  ctx.mailer.sent.length = 0;
  ctx.clock.set(new Date());
});

const maple = () =>
  createTenant('Maple Family Clinic', { smsNumber: CLINIC, contactPhone: '(555) 010-0001' });

let inboundCounter = 0;
/** A patient text arriving through the real provider webhook. */
const textIn = (body: string, options: { from?: string; to?: string; id?: string } = {}) =>
  request(app)
    .post('/api/v1/webhooks/sms/dev')
    .send({
      from: options.from ?? PATIENT,
      to: options.to ?? CLINIC,
      body,
      providerMessageId: options.id ?? `in-${String(++inboundCounter)}`,
    });

const outcomeOf = (res: request.Response): string =>
  z.object({ outcome: z.string() }).parse(res.body).outcome;

const outbound = (tenantId: string) =>
  admin.message.findMany({
    where: { tenantId, direction: 'outbound' },
    orderBy: { createdAt: 'asc' },
  });
const consent = (tenantId: string, mobileE164 = PATIENT) =>
  admin.smsConsent.findUnique({ where: { tenantId_mobileE164: { tenantId, mobileE164 } } });

async function queue(
  tenantId: string,
  type: 'reminder' | 'offer' | 'system',
  contextId: string | null = null,
) {
  return db.withTenant(tenantId, (tx) =>
    services.messaging.queueSms(tx, {
      tenantId,
      to: PATIENT,
      body: `test ${type}`,
      context: { type, id: contextId },
    }),
  );
}

describe('outbound delivery (sms.send job)', () => {
  it('sends a queued message through the dev provider (email to Mailpit) and marks it sent', async () => {
    const tenant = await maple();
    const id = await queue(tenant.id, 'system');
    expect((await admin.message.findUniqueOrThrow({ where: { id } })).status).toBe('queued');

    await ctx.runJobs();

    const sent = await admin.message.findUniqueOrThrow({ where: { id } });
    expect(sent).toMatchObject({ status: 'sent', provider: 'dev' });
    expect(sent.providerMessageId).toMatch(/^dev-out-/);
    expect(ctx.mailer.sent).toHaveLength(1);
    expect(ctx.mailer.sent[0]).toMatchObject({ subject: `SMS to ${PATIENT}` });
    expect(ctx.mailer.sent[0]?.text).toContain('test system');
  });

  it('never texts an opted-out number for reminders/offers, but still sends system confirmations', async () => {
    const tenant = await maple();
    await admin.smsConsent.create({
      data: { tenantId: tenant.id, mobileE164: PATIENT, status: 'opted_out', source: 'test' },
    });
    const reminder = await queue(tenant.id, 'reminder', crypto.randomUUID());
    const offer = await queue(tenant.id, 'offer', crypto.randomUUID());
    const system = await queue(tenant.id, 'system');

    await ctx.runJobs();

    expect((await admin.message.findUniqueOrThrow({ where: { id: reminder } })).failureReason).toBe(
      'opted_out',
    );
    expect((await admin.message.findUniqueOrThrow({ where: { id: offer } })).status).toBe('failed');
    expect((await admin.message.findUniqueOrThrow({ where: { id: system } })).status).toBe('sent');
    expect(ctx.mailer.sent).toHaveLength(1);
  });

  it('fails cleanly when the clinic has no sending number', async () => {
    const tenant = await createTenant('No number');
    const id = await queue(tenant.id, 'system');
    await ctx.runJobs();
    expect(await admin.message.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'failed',
      failureReason: 'no_sender_number',
    });
  });

  it('does not send the same message twice if the job runs again', async () => {
    const tenant = await maple();
    const id = await queue(tenant.id, 'system');
    await ctx.runJobs();
    await services.messaging.deliver(tenant.id, id);
    expect(ctx.mailer.sent).toHaveLength(1);
  });
});

describe('inbound compliance keywords (always first)', () => {
  it.each(['STOP', ' stop ', 'Stop.', 'UNSUBSCRIBE', 'END', 'QUIT', 'STOPALL', 'CANCEL'])(
    '%j opts the number out and sends one confirmation',
    async (keyword) => {
      const tenant = await maple();
      const res = await textIn(keyword);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ outcome: 'opted_out' });
      expect(await consent(tenant.id)).toMatchObject({ status: 'opted_out' });
      const replies = await outbound(tenant.id);
      expect(replies).toHaveLength(1);
      expect(replies[0]?.body).toContain('unsubscribed');
      await ctx.runJobs();
      expect(ctx.mailer.sent).toHaveLength(1); // delivered despite the opt-out
    },
  );

  it('START (and UNSTOP) opt back in', async () => {
    const tenant = await maple();
    await textIn('STOP');
    expect((await textIn('start')).body).toMatchObject({ outcome: 'opted_in' });
    expect(await consent(tenant.id)).toMatchObject({ status: 'opted_in', source: 'keyword:START' });
    await textIn('STOP');
    await textIn('UNSTOP');
    expect(await consent(tenant.id)).toMatchObject({ status: 'opted_in' });
  });

  it('HELP replies with the clinic name and phone', async () => {
    const tenant = await maple();
    expect((await textIn('help')).body).toMatchObject({ outcome: 'help' });
    const [reply] = await outbound(tenant.id);
    expect(reply?.body).toContain('Maple Family Clinic');
    expect(reply?.body).toContain('(555) 010-0001');
    expect(reply?.body).toContain('STOP');
  });

  it('HELP is answered even for an opted-out number', async () => {
    const tenant = await maple();
    await textIn('STOP');
    await textIn('HELP');
    expect((await outbound(tenant.id)).map((m) => m.contextType)).toEqual(['system', 'system']);
  });
});

describe('inbound handling', () => {
  it('stores each inbound message once (dedupe by provider message id)', async () => {
    const tenant = await maple();
    expect(outcomeOf(await textIn('hello', { id: 'same' }))).toBe('unrecognized');
    expect(outcomeOf(await textIn('hello', { id: 'same' }))).toBe('duplicate');
    expect(
      await admin.message.count({ where: { tenantId: tenant.id, direction: 'inbound' } }),
    ).toBe(1);
  });

  it('ignores texts to a number no clinic owns', async () => {
    await maple();
    expect(outcomeOf(await textIn('STOP', { to: '+15559999999' }))).toBe('unknown_number');
    expect(await admin.message.count()).toBe(0);
  });

  it('flags unrecognized replies for staff and sends at most one help reply per day', async () => {
    const tenant = await maple();
    await textIn('what time is my appt?');
    await textIn('hello??');
    const inbound = await admin.message.findMany({
      where: { tenantId: tenant.id, direction: 'inbound' },
    });
    expect(inbound.every((m) => m.needsAttention)).toBe(true);
    expect(await outbound(tenant.id)).toHaveLength(1);

    ctx.clock.advance(25 * 3_600_000);
    await textIn('anyone there');
    expect(await outbound(tenant.id)).toHaveLength(2);
  });

  it('does not auto-reply to an opted-out number, but flags the message for staff', async () => {
    const tenant = await maple();
    await textIn('STOP');
    expect(outcomeOf(await textIn('please call me'))).toBe('ignored_opted_out');
    expect(await outbound(tenant.id)).toHaveLength(1); // only the STOP confirmation
    expect(
      await admin.message.count({ where: { tenantId: tenant.id, needsAttention: true } }),
    ).toBe(1);
  });

  it('keeps tenants apart: the same mobile texting two clinics affects only the clinic it texted', async () => {
    const a = await maple();
    const b = await createTenant('Cedar Pediatrics', { smsNumber: OTHER_CLINIC });
    await textIn('STOP', { to: CLINIC });
    expect(await consent(a.id)).toMatchObject({ status: 'opted_out' });
    expect(await consent(b.id)).toBeNull();
    expect(await admin.message.count({ where: { tenantId: b.id } })).toBe(0);
  });

  it('rejects an unknown provider and a malformed payload', async () => {
    await maple();
    expect((await request(app).post('/api/v1/webhooks/sms/twilio').send({})).status).toBe(404);
    expect(
      (
        await request(app)
          .post('/api/v1/webhooks/sms/dev')
          .send({ from: 'x', to: CLINIC, body: '' })
      ).status,
    ).toBe(400);
  });
});

describe('context routing (replies go to the most recent conversation, never by number alone)', () => {
  // A separate service instance so test handlers don't leak into the shared one.
  const messaging = new MessagingService({
    db,
    jobs: ctx.jobs,
    clock: ctx.clock,
    logger: silentLogger,
    providers: ctx.services.sms,
  });
  const calls: { type: string; contextId: string; body: string }[] = [];
  const handler =
    (type: string): ContextHandler =>
    (_tx, c) => {
      calls.push({ type, contextId: c.contextId, body: c.normalizedBody });
      return Promise.resolve(c.normalizedBody === '1' || c.normalizedBody === 'YES');
    };
  messaging.registerContextHandler('reminder', handler('reminder'));
  messaging.registerContextHandler('offer', handler('offer'));

  const inbound = (body: string) =>
    messaging.handleInbound(
      { providerMessageId: crypto.randomUUID(), from: PATIENT, to: CLINIC, body },
      'dev',
    );

  beforeEach(() => {
    calls.length = 0;
  });

  it('routes a reply to the handler of the latest sent conversation, with its context id', async () => {
    const tenant = await maple();
    const reminderId = crypto.randomUUID();
    const offerId = crypto.randomUUID();
    await queue(tenant.id, 'reminder', reminderId);
    await ctx.runJobs();
    ctx.clock.advance(60_000);
    await queue(tenant.id, 'offer', offerId);
    await ctx.runJobs();

    expect(await inbound('yes')).toBe('routed');
    expect(calls).toEqual([{ type: 'offer', contextId: offerId, body: 'YES' }]);
  });

  it('falls back to "unrecognized" when the handler does not understand the reply', async () => {
    const tenant = await maple();
    await queue(tenant.id, 'reminder', crypto.randomUUID());
    await ctx.runJobs();
    expect(await inbound('maybe')).toBe('unrecognized');
    expect(calls).toHaveLength(1);
  });

  it('ignores conversations older than 72 hours', async () => {
    const tenant = await maple();
    await queue(tenant.id, 'reminder', crypto.randomUUID());
    await ctx.runJobs();
    ctx.clock.advance(73 * 3_600_000);
    expect(await inbound('1')).toBe('unrecognized');
    expect(calls).toEqual([]);
  });

  it('only counts messages that were actually sent (not queued or failed)', async () => {
    const tenant = await maple();
    await queue(tenant.id, 'reminder', crypto.randomUUID()); // never delivered
    expect(await inbound('1')).toBe('unrecognized');
  });

  it('compliance keywords win over an open conversation', async () => {
    const tenant = await maple();
    await queue(tenant.id, 'reminder', crypto.randomUUID());
    await ctx.runJobs();
    expect(await inbound('STOP')).toBe('opted_out');
    expect(calls).toEqual([]);
  });
});

describe('staff messages API', () => {
  async function signedIn() {
    const tenant = await maple();
    await createUser({ tenantId: tenant.id, email: 'a@a.test', mfaSecret: SECRET });
    // Two patients share the number (a parent and a child).
    for (const firstName of ['Ana', 'Leo']) {
      await admin.patient.create({
        data: {
          tenantId: tenant.id,
          ehrPatientId: firstName,
          firstName,
          lastName: 'Rivera',
          mobileE164: PATIENT,
        },
      });
    }
    const agent = request.agent(app);
    await signIn(agent, 'a@a.test', SECRET);
    return { tenant, agent };
  }

  it('requires sign-in', async () => {
    expect((await request(app).get('/api/v1/messages')).status).toBe(401);
  });

  it('lists messages newest first with every patient behind the number, and audits the view', async () => {
    const { tenant, agent } = await signedIn();
    await textIn('hi there');
    const body = messageListResponseSchema.parse((await agent.get('/api/v1/messages')).body);
    expect(body.messages.map((m) => m.direction)).toEqual(['outbound', 'inbound']);
    expect(body.messages[1]?.patients.map((p) => p.firstName)).toEqual(['Ana', 'Leo']);
    expect(await auditActions(tenant.id)).toContain('message.list');
  });

  it('filters by mobile and lists / resolves items needing attention', async () => {
    const { agent } = await signedIn();
    await textIn('unclear reply');
    const filtered = messageListResponseSchema.parse(
      (await agent.get('/api/v1/messages').query({ mobile: '+15550000000' })).body,
    );
    expect(filtered.messages).toEqual([]);

    const flagged = messageListResponseSchema.parse(
      (await agent.get('/api/v1/messages/needs-attention')).body,
    );
    expect(flagged.messages).toHaveLength(1);
    const id = flagged.messages[0]?.id ?? '';
    expect((await agent.post(`/api/v1/messages/${id}/resolve`)).status).toBe(204);
    expect(
      messageListResponseSchema.parse((await agent.get('/api/v1/messages/needs-attention')).body)
        .messages,
    ).toEqual([]);
  });

  it('never shows or resolves another clinic’s messages', async () => {
    const { agent } = await signedIn();
    const other = await createTenant('Cedar Pediatrics', { smsNumber: OTHER_CLINIC });
    await textIn('secret', { to: OTHER_CLINIC });
    const otherMsg = await admin.message.findFirstOrThrow({
      where: { tenantId: other.id, direction: 'inbound' },
    });

    const listed = messageListResponseSchema.parse((await agent.get('/api/v1/messages')).body);
    expect(listed.messages).toEqual([]);
    expect((await agent.post(`/api/v1/messages/${otherMsg.id}/resolve`)).status).toBe(404);
    expect(
      (await admin.message.findUniqueOrThrow({ where: { id: otherMsg.id } })).needsAttention,
    ).toBe(true);
  });
});

describe('dev phone simulator routes', () => {
  async function signedInDev() {
    const tenant = await maple();
    await createUser({ tenantId: tenant.id, email: 'a@a.test', mfaSecret: SECRET });
    const agent = request.agent(devApp);
    await signIn(agent, 'a@a.test', SECRET);
    return { tenant, agent };
  }

  it('are not mounted without dev routes', async () => {
    const tenant = await maple();
    await createUser({ tenantId: tenant.id, email: 'a@a.test', mfaSecret: SECRET });
    const agent = request.agent(app);
    await signIn(agent, 'a@a.test', SECRET);
    expect((await agent.get('/api/v1/dev/sms/conversations')).status).toBe(404);
  });

  it('a simulated reply goes through the real inbound pipeline to the signed-in clinic’s number', async () => {
    const { tenant, agent } = await signedInDev();
    const res = await agent.post('/api/v1/dev/sms/inbound').send({ from: PATIENT, body: 'STOP' });
    expect(res.body).toEqual({ outcome: 'opted_out' });
    expect(await consent(tenant.id)).toMatchObject({ status: 'opted_out' });
  });

  it('shows conversations per phone, and can send a test text', async () => {
    const { agent } = await signedInDev();
    expect((await agent.post('/api/v1/dev/sms/send-test').send({ to: PATIENT })).status).toBe(202);
    await ctx.runJobs();
    await agent.post('/api/v1/dev/sms/inbound').send({ from: PATIENT, body: 'HELP' });

    const res = devSmsConversationsResponseSchema.parse(
      (await agent.get('/api/v1/dev/sms/conversations')).body,
    );
    expect(res.clinicNumber).toBe(CLINIC);
    const phone = res.phones.find((p) => p.mobileE164 === PATIENT);
    expect(phone?.messages.map((m) => m.direction)).toEqual(['outbound', 'inbound', 'outbound']);
    expect(ctx.mailer.sent).toHaveLength(1);
  });
});
