import type { Request } from 'express';

export interface InboundSms {
  providerMessageId: string;
  /** Patient number, E.164. */
  from: string;
  /** Clinic (tenant) number, E.164. */
  to: string;
  body: string;
}

/** The only SMS abstraction. Selected by SMS_PROVIDER. */
export interface SmsProvider {
  /** Stored on each message row (`messages.provider`), and the `:provider` in the webhook URL. */
  readonly name: string;
  send(input: { from: string; to: string; body: string }): Promise<{ providerMessageId: string }>;
  /** Signature / authenticity check for the inbound webhook. */
  verifyInbound(req: Request): boolean | Promise<boolean>;
  /** Null when the webhook is not an inbound message (e.g. a subscription confirmation). */
  parseInbound(req: Request): InboundSms | null | Promise<InboundSms | null>;
  /** What to answer the provider's webhook with (e.g. TwiML for Twilio); JSON {ok} otherwise. */
  readonly ackResponse?: { contentType: string; body: string };
}

/** All SMS providers configured on this deployment, by name. */
export interface SmsProviderRegistry {
  readonly defaultName: string;
  get(name: string): SmsProvider | undefined;
  names(): string[];
}

export function createSmsProviderRegistry(
  defaultProvider: SmsProvider,
  others: SmsProvider[] = [],
): SmsProviderRegistry {
  const byName = new Map([defaultProvider, ...others].map((p) => [p.name, p]));
  return {
    defaultName: defaultProvider.name,
    get: (name) => byName.get(name),
    names: () => [...byName.keys()],
  };
}
