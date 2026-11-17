import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { createTransport } from 'nodemailer';

/** Transactional email to staff (password reset, alerts). Never contains PHI. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export interface EmailConfig {
  EMAIL_TRANSPORT: 'smtp' | 'ses';
  EMAIL_FROM: string;
  SMTP_HOST: string;
  SMTP_PORT: number;
  AWS_REGION: string;
}

/** SMTP (Mailpit, http://localhost:8025) in development; Amazon SES (covered by the AWS BAA) in AWS. */
export function createEmailSender(config: EmailConfig): EmailSender {
  const transport =
    config.EMAIL_TRANSPORT === 'ses'
      ? createTransport({
          SES: { sesClient: new SESv2Client({ region: config.AWS_REGION }), SendEmailCommand },
        })
      : createTransport({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          secure: false,
          pool: true,
        });
  return {
    async send(message) {
      await transport.sendMail({ from: config.EMAIL_FROM, ...message });
    },
  };
}
