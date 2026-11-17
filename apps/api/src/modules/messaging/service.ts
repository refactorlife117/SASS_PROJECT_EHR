import type { Database, Tx } from '../../db/client';
import type { MessageContextType } from '../../generated/prisma/client';
import type { JobQueue } from '../../jobs/queues';
import type { Clock } from '../../lib/clock';
import type { Logger } from '../../lib/logger';
import type { InboundSms, SmsProvider, SmsProviderRegistry } from '../../providers/sms';
import { templates } from './templates';

/** Carrier opt-out keywords. CANCEL is one of them, so appointment cancellation uses "2". */
export const OPT_OUT_KEYWORDS = new Set([
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
  'REVOKE',
  'OPTOUT',
]);
export const OPT_IN_KEYWORDS = new Set(['START', 'UNSTOP']);
export const HELP_KEYWORDS = new Set(['HELP', 'INFO']);

/** Replies are routed to the conversation the clinic most recently started with this number. */
export const CONTEXT_WINDOW_MS = 72 * 3_600_000;
/** At most one "didn't understand" reply per number per day (avoids reply loops). */
const FALLBACK_COOLDOWN_MS = 24 * 3_600_000;

export type RoutedContextType = Exclude<MessageContextType, 'system'>;

export interface InboundContext {
  tenantId: string;
  mobileE164: string;
  /** Trimmed, upper-cased, trailing punctuation removed. */
  normalizedBody: string;
  /** The context id of the outbound message being replied to (reminder/offer/invite id). */
  contextId: string;
  inboundMessageId: string;
  now: Date;
  /** Queue a reply in the same transaction. */
  reply(body: string, context?: { type: MessageContextType; id?: string | null }): Promise<string>;
}

/** Returns true if it understood and acted on the reply. Must only use `tx` and enqueue jobs. */
export type ContextHandler = (tx: Tx, ctx: InboundContext) => Promise<boolean>;

export type InboundOutcome =
  | 'unknown_number'
  | 'duplicate'
  | 'opted_out'
  | 'opted_in'
  | 'help'
  | 'ignored_opted_out'
  | 'routed'
  | 'unrecognized';

export function normalizeReply(body: string): string {
  return body
    .trim()
    .toUpperCase()
    .replace(/[\s.!?]+$/u, '');
}

export class MessagingService {
  private readonly handlers: Partial<Record<RoutedContextType, ContextHandler>> = {};

  constructor(
    private readonly deps: {
      db: Database;
      jobs: JobQueue;
      clock: Clock;
      logger: Logger;
      /** Configured SMS providers; a clinic uses its chosen one, else the default. */
      providers: SmsProviderRegistry;
    },
  ) {}

  /** Phases plug in reply handling per conversation type (reminder, offer, waitlist invite). */
  registerContextHandler(type: RoutedContextType, handler: ContextHandler): void {
    this.handlers[type] = handler;
  }

  /**
   * Queue an outbound SMS inside the caller's tenant transaction; the `sms.send` job delivers it.
   * Callers are responsible for quiet hours (pass `startAfter`); consent is checked at delivery.
   */
  async queueSms(
    tx: Tx,
    input: {
      tenantId: string;
      to: string;
      body: string;
      context: { type: MessageContextType; id?: string | null };
      startAfter?: Date;
    },
  ): Promise<string> {
    const tenant = await tx.tenant.findUnique({
      where: { id: input.tenantId },
      select: { smsProvider: true },
    });
    const message = await tx.message.create({
      data: {
        tenantId: input.tenantId,
        direction: 'outbound',
        mobileE164: input.to,
        body: input.body,
        // The clinic's provider is fixed at queue time; delivery fails loudly if it's unavailable
        // rather than silently using another (possibly non-BAA) provider.
        provider: tenant?.smsProvider ?? this.deps.providers.defaultName,
        contextType: input.context.type,
        contextId: input.context.id ?? null,
        status: 'queued',
        // Same clock as inbound messages, so conversation order and the 72 h window agree.
        createdAt: this.deps.clock.now(),
      },
      select: { id: true },
    });
    await this.deps.jobs.send(
      'sms.send',
      { tenantId: input.tenantId, messageId: message.id },
      input.startAfter ? { startAfter: input.startAfter } : undefined,
      tx,
    );
    return message.id;
  }

  async isOptedOut(tx: Tx, mobileE164: string): Promise<boolean> {
    const consent = await tx.smsConsent.findUnique({
      where: { tenantId_mobileE164: { tenantId: await currentTenant(tx), mobileE164 } },
    });
    return consent?.status === 'opted_out';
  }

  /**
   * `sms.send` job: deliver one queued message. Consent is re-checked here (it can change between
   * queueing and sending). System messages (STOP/HELP confirmations) are always delivered.
   * At-least-once: a crash between the provider call and the status update can resend.
   */
  async deliver(tenantId: string, messageId: string): Promise<'sent' | 'skipped' | 'failed'> {
    let provider: SmsProvider | undefined;
    const prepared = await this.deps.db.withTenant(tenantId, async (tx) => {
      const message = await tx.message.findUnique({ where: { id: messageId } });
      if (message?.status !== 'queued') return null;
      const fail = async (failureReason: string) => {
        await tx.message.update({
          where: { id: messageId },
          data: { status: 'failed', failureReason },
        });
        return null;
      };
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      if (!tenant.smsNumber) return fail('no_sender_number');
      if (message.contextType !== 'system' && (await this.isOptedOut(tx, message.mobileE164))) {
        return fail('opted_out');
      }
      provider = this.deps.providers.get(message.provider);
      if (!provider) return fail('provider_unavailable');
      return { from: tenant.smsNumber, to: message.mobileE164, body: message.body };
    });
    if (!prepared || !provider) {
      const status = await this.deps.db.withTenant(tenantId, (tx) =>
        tx.message.findUnique({ where: { id: messageId }, select: { status: true } }),
      );
      return status?.status === 'failed' ? 'failed' : 'skipped';
    }

    const { providerMessageId } = await provider.send(prepared);
    await this.deps.db.withTenant(tenantId, (tx) =>
      tx.message.update({
        where: { id: messageId },
        data: { status: 'sent', providerMessageId, sentAt: this.deps.clock.now() },
      }),
    );
    return 'sent';
  }

  /** The single inbound pipeline, used by provider webhooks and the dev phone simulator alike. */
  async handleInbound(sms: InboundSms, providerName: string): Promise<InboundOutcome> {
    // Pre-tenant lookup: the clinic is identified by the number the patient texted.
    const rows = await this.deps.db.unscoped.$queryRaw<{ tenant_id: string }[]>`
      SELECT tenant_id FROM sms_tenant_by_number(${sms.to})`;
    const tenantId = rows[0]?.tenant_id;
    if (!tenantId) {
      this.deps.logger.warn(
        { provider: providerName },
        'inbound sms to an unknown number; ignored',
      );
      return 'unknown_number';
    }

    const now = this.deps.clock.now();
    return this.deps.db.withTenant(tenantId, async (tx) => {
      // 1. Store + dedupe (unique provider + provider_message_id).
      const inserted = await tx.message.createManyAndReturn({
        data: [
          {
            tenantId,
            direction: 'inbound',
            mobileE164: sms.from,
            body: sms.body,
            provider: providerName,
            providerMessageId: sms.providerMessageId,
            status: 'received',
            createdAt: now,
          },
        ],
        skipDuplicates: true,
        select: { id: true },
      });
      const inbound = inserted[0];
      if (!inbound) return 'duplicate';

      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      const reply = (
        body: string,
        context: { type: MessageContextType; id?: string | null } = { type: 'system' },
      ) => this.queueSms(tx, { tenantId, to: sms.from, body, context });
      const setConsent = (status: 'opted_in' | 'opted_out', keyword: string) =>
        tx.smsConsent.upsert({
          where: { tenantId_mobileE164: { tenantId, mobileE164: sms.from } },
          create: { tenantId, mobileE164: sms.from, status, source: `keyword:${keyword}` },
          update: { status, source: `keyword:${keyword}` },
        });
      const flag = () =>
        tx.message.update({ where: { id: inbound.id }, data: { needsAttention: true } });

      // 2. Compliance keywords first, always.
      const normalized = normalizeReply(sms.body);
      if (OPT_OUT_KEYWORDS.has(normalized)) {
        await setConsent('opted_out', normalized);
        await reply(templates.optedOut(tenant.name));
        return 'opted_out';
      }
      if (OPT_IN_KEYWORDS.has(normalized)) {
        await setConsent('opted_in', normalized);
        await reply(templates.optedIn(tenant.name));
        return 'opted_in';
      }
      if (HELP_KEYWORDS.has(normalized)) {
        await reply(templates.help(tenant.name, tenant.contactPhone));
        return 'help';
      }

      // 3. Opted-out numbers get no automated replies; staff can still see what they wrote.
      if (await this.isOptedOut(tx, sms.from)) {
        await flag();
        return 'ignored_opted_out';
      }

      // 4. Route by the most recent outbound conversation with this number (never by number ->
      //    patient: one number can belong to several patients).
      const lastOutbound = await tx.message.findFirst({
        where: {
          direction: 'outbound',
          mobileE164: sms.from,
          contextType: { in: ['reminder', 'offer', 'waitlist_invite'] },
          contextId: { not: null },
          status: { in: ['sent', 'delivered'] },
          createdAt: { gt: new Date(now.getTime() - CONTEXT_WINDOW_MS) },
        },
        orderBy: { createdAt: 'desc' },
      });
      const handler = lastOutbound?.contextType
        ? this.handlers[lastOutbound.contextType as RoutedContextType]
        : undefined;
      if (lastOutbound?.contextId && handler) {
        const handled = await handler(tx, {
          tenantId,
          mobileE164: sms.from,
          normalizedBody: normalized,
          contextId: lastOutbound.contextId,
          inboundMessageId: inbound.id,
          now,
          reply,
        });
        if (handled) return 'routed';
      }

      // 5. Anything else: flag for staff, and send one short help reply per day.
      await flag();
      const fallbackBody = templates.unrecognized(tenant.name, tenant.contactPhone);
      const recentFallback = await tx.message.findFirst({
        where: {
          direction: 'outbound',
          mobileE164: sms.from,
          body: fallbackBody,
          createdAt: { gt: new Date(now.getTime() - FALLBACK_COOLDOWN_MS) },
        },
        select: { id: true },
      });
      if (!recentFallback) await reply(fallbackBody);
      return 'unrecognized';
    });
  }
}

/** The tenant the current transaction is scoped to (set by withTenant). */
async function currentTenant(tx: Tx): Promise<string> {
  const rows = await tx.$queryRaw<
    { id: string | null }[]
  >`SELECT app_current_tenant_id()::text AS id`;
  const id = rows[0]?.id;
  if (!id) throw new Error('No tenant in scope; use db.withTenant');
  return id;
}
