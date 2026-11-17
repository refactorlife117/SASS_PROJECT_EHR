// Twilio Programmable Messaging (Phase 9, optional). Use ONLY with a signed Twilio BAA: deployed
// servers refuse to start with Twilio configured unless TWILIO_BAA_SIGNED=true (see env.ts).
// Docs: twilio.com/docs/messaging/api/message-resource, /usage/security (request validation).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import type { InboundSms, SmsProvider } from './types';

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  /** The exact public URL Twilio posts to (signatures cover it); behind a load balancer the
   * request's own host/protocol can differ, so it's configured, not derived. */
  webhookUrl: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + each POST param name+value, sorted by name)).
 */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + (params[key] ?? ''), url);
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

const inboundSchema = z.object({
  MessageSid: z.string().min(1),
  From: z.string().min(1), // the patient
  To: z.string().min(1), // our (clinic) number
  Body: z.string().default(''),
});

const formParams = (req: Request): Record<string, string> => {
  const body: unknown = req.body;
  if (!body || typeof body !== 'object') return {};
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    ),
  );
};

export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  /** Twilio expects TwiML; an empty response means "no auto-reply" (we reply via the API). */
  readonly ackResponse = {
    contentType: 'text/xml',
    body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
  };

  constructor(private readonly options: TwilioOptions) {}

  async send(input: {
    from: string;
    to: string;
    body: string;
  }): Promise<{ providerMessageId: string }> {
    const { accountSid, authToken } = this.options;
    const base = this.options.apiBaseUrl ?? 'https://api.twilio.com';
    const res = await (this.options.fetchImpl ?? fetch)(
      `${base}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: input.to, From: input.from, Body: input.body }).toString(),
      },
    );
    if (!res.ok) throw new Error(`Twilio send failed: ${String(res.status)}`); // no body: may echo PHI
    const { sid } = z.object({ sid: z.string() }).parse(await res.json());
    return { providerMessageId: sid };
  }

  verifyInbound(req: Request): boolean {
    const given = req.get('x-twilio-signature') ?? '';
    const expected = twilioSignature(
      this.options.authToken,
      this.options.webhookUrl,
      formParams(req),
    );
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseInbound(req: Request): InboundSms | null {
    const parsed = inboundSchema.safeParse(formParams(req));
    if (!parsed.success) return null;
    return {
      providerMessageId: parsed.data.MessageSid,
      from: parsed.data.From,
      to: parsed.data.To,
      body: parsed.data.Body,
    };
  }
}
