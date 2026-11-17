// DEV ONLY. "Sends" an SMS by emailing it to Mailpit (http://localhost:8025) and storing it like any
// other message; the /dev/phone simulator shows the same conversation. Synthetic data only.
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import type { InboundSms, SmsProvider } from './types';

export interface MailSender {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

const devInboundSchema = z.object({
  from: z.string().regex(/^\+[1-9]\d{6,14}$/),
  to: z.string().regex(/^\+[1-9]\d{6,14}$/),
  body: z.string().min(1).max(1600),
  providerMessageId: z.string().min(1).max(200).optional(),
});

export class DevSmsProvider implements SmsProvider {
  readonly name = 'dev';

  constructor(
    private readonly mailer: MailSender,
    private readonly options: { emailTo: string; emailFrom: string },
  ) {}

  async send(input: {
    from: string;
    to: string;
    body: string;
  }): Promise<{ providerMessageId: string }> {
    await this.mailer.sendMail({
      from: this.options.emailFrom,
      to: this.options.emailTo,
      // Dev/synthetic numbers only; production providers never email message content.
      subject: `SMS to ${input.to}`,
      text: `From: ${input.from}\nTo: ${input.to}\n\n${input.body}`,
    });
    return { providerMessageId: `dev-out-${randomUUID()}` };
  }

  verifyInbound(): boolean {
    return true; // the dev provider has no signature
  }

  parseInbound(req: Request): InboundSms {
    const parsed = devInboundSchema.parse(req.body);
    return { ...parsed, providerMessageId: parsed.providerMessageId ?? `dev-in-${randomUUID()}` };
  }
}
