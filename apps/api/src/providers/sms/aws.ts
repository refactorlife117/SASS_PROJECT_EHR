// AWS End User Messaging SMS (pinpoint-sms-voice-v2) for sending; two-way SMS arrives as Amazon SNS
// notifications POSTed to /api/v1/webhooks/sms/aws. Both are covered by the AWS BAA.
// Docs: API_SendTextMessage, sms-voice two-way-sms-payload, sns-verify-signature-of-message.
import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import { SendTextMessageCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import type { Request } from 'express';
import { z } from 'zod';
import type { InboundSms, SmsProvider } from './types';

/** The subset of PinpointSMSVoiceV2Client we use (injectable for tests). */
export interface SmsVoiceClient {
  send(command: SendTextMessageCommand): Promise<{ MessageId?: string | undefined }>;
}

export interface AwsSmsOptions {
  configurationSetName?: string | undefined;
  /** Only these SNS topics may deliver inbound SMS. */
  allowedTopicArns: string[];
  /** Fetch the PEM at SigningCertURL (overridable in tests). */
  fetchCertificate?: (url: string) => Promise<string>;
  /** Visit SubscribeURL to confirm an SNS subscription (overridable in tests). */
  confirmSubscription?: (url: string) => Promise<void>;
}

const snsEnvelopeSchema = z.object({
  Type: z.enum(['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation']),
  MessageId: z.string(),
  TopicArn: z.string(),
  Message: z.string(),
  Timestamp: z.string(),
  SignatureVersion: z.enum(['1', '2']),
  Signature: z.string(),
  SigningCertURL: z.string(),
  Subject: z.string().optional(),
  SubscribeURL: z.string().optional(),
  Token: z.string().optional(),
});
type SnsEnvelope = z.infer<typeof snsEnvelopeSchema>;

/** Inbound two-way SMS payload (the JSON inside the SNS `Message`). */
const inboundPayloadSchema = z.object({
  originationNumber: z.string(), // the patient
  destinationNumber: z.string(), // our (clinic) number
  messageBody: z.string(),
  inboundMessageId: z.string(),
});

/** SNS certificates/subscribe URLs must be https on an SNS endpoint host. */
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
export function isSnsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && SNS_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/** The documented string-to-sign: "Key\nValue\n" for each field, in this order. */
export function snsStringToSign(m: SnsEnvelope): string {
  const keys =
    m.Type === 'Notification'
      ? [
          'Message',
          'MessageId',
          ...(m.Subject !== undefined ? ['Subject'] : []),
          'Timestamp',
          'TopicArn',
          'Type',
        ]
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.map((k) => `${k}\n${m[k as keyof SnsEnvelope] ?? ''}\n`).join('');
}

function envelopeOf(req: Request): SnsEnvelope | null {
  const raw: unknown = req.body;
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = snsEnvelopeSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

const defaultFetchCertificate = async (url: string): Promise<string> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`certificate fetch failed: ${String(res.status)}`);
  return res.text();
};

const defaultConfirm = async (url: string): Promise<void> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SNS subscription confirmation failed: ${String(res.status)}`);
};

export class AwsSmsProvider implements SmsProvider {
  readonly name = 'aws';
  private readonly certificates = new Map<string, Promise<KeyObject>>();

  constructor(
    private readonly client: SmsVoiceClient,
    private readonly options: AwsSmsOptions,
  ) {}

  async send(input: {
    from: string;
    to: string;
    body: string;
  }): Promise<{ providerMessageId: string }> {
    const result = await this.client.send(
      new SendTextMessageCommand({
        DestinationPhoneNumber: input.to,
        // The clinic's number (E.164) is a valid origination identity.
        OriginationIdentity: input.from,
        MessageBody: input.body,
        MessageType: 'TRANSACTIONAL',
        ...(this.options.configurationSetName
          ? { ConfigurationSetName: this.options.configurationSetName }
          : {}),
      }),
    );
    if (!result.MessageId) throw new Error('AWS SendTextMessage returned no MessageId');
    return { providerMessageId: result.MessageId };
  }

  /** SNS signature check: allowed topic, SNS-hosted cert, RSA-SHA1 (v1) or RSA-SHA256 (v2). */
  async verifyInbound(req: Request): Promise<boolean> {
    const envelope = envelopeOf(req);
    if (!envelope) return false;
    if (!this.options.allowedTopicArns.includes(envelope.TopicArn)) return false;
    if (!isSnsUrl(envelope.SigningCertURL)) return false;
    if (
      envelope.Type === 'SubscriptionConfirmation' &&
      !(envelope.SubscribeURL && isSnsUrl(envelope.SubscribeURL))
    ) {
      return false;
    }
    try {
      const key = await this.publicKey(envelope.SigningCertURL);
      const verifier = createVerify(envelope.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256');
      verifier.update(snsStringToSign(envelope), 'utf8');
      return verifier.verify(key, envelope.Signature, 'base64');
    } catch {
      return false;
    }
  }

  async parseInbound(req: Request): Promise<InboundSms | null> {
    const envelope = envelopeOf(req);
    if (!envelope) return null;
    if (envelope.Type === 'SubscriptionConfirmation' && envelope.SubscribeURL) {
      await (this.options.confirmSubscription ?? defaultConfirm)(envelope.SubscribeURL);
      return null;
    }
    if (envelope.Type !== 'Notification') return null;
    const payload = inboundPayloadSchema.parse(JSON.parse(envelope.Message));
    return {
      providerMessageId: payload.inboundMessageId,
      from: payload.originationNumber,
      to: payload.destinationNumber,
      body: payload.messageBody,
    };
  }

  private publicKey(url: string): Promise<KeyObject> {
    let key = this.certificates.get(url);
    if (!key) {
      key = (this.options.fetchCertificate ?? defaultFetchCertificate)(url).then((pem) =>
        createPublicKey(pem),
      );
      key.catch(() => this.certificates.delete(url));
      this.certificates.set(url, key);
    }
    return key;
  }
}
