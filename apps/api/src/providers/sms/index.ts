import { PinpointSMSVoiceV2Client } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { createTransport } from 'nodemailer';
import { AwsSmsProvider } from './aws';
import { DevSmsProvider } from './dev';
import { TwilioSmsProvider } from './twilio';
import { createSmsProviderRegistry, type SmsProvider, type SmsProviderRegistry } from './types';

export interface SmsConfig {
  SMS_PROVIDER: 'dev' | 'aws' | 'twilio';
  APP_BASE_URL: string;
  SMTP_HOST: string;
  SMTP_PORT: number;
  DEV_SMS_EMAIL_TO: string;
  DEV_SMS_EMAIL_FROM: string;
  AWS_REGION: string;
  AWS_SMS_CONFIGURATION_SET?: string | undefined;
  AWS_SNS_INBOUND_TOPIC_ARNS: string[];
  TWILIO_ACCOUNT_SID?: string | undefined;
  TWILIO_AUTH_TOKEN?: string | undefined;
}

type ProviderName = SmsConfig['SMS_PROVIDER'];

/** Factories for providers that are configured on this deployment. */
function factories(config: SmsConfig): Partial<Record<ProviderName, () => SmsProvider>> {
  const twilio =
    config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN
      ? { accountSid: config.TWILIO_ACCOUNT_SID, authToken: config.TWILIO_AUTH_TOKEN }
      : null;
  return {
    dev: () =>
      new DevSmsProvider(
        createTransport({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          secure: false,
          pool: true,
        }),
        { emailTo: config.DEV_SMS_EMAIL_TO, emailFrom: config.DEV_SMS_EMAIL_FROM },
      ),
    ...(config.AWS_SNS_INBOUND_TOPIC_ARNS.length > 0
      ? {
          aws: () =>
            new AwsSmsProvider(new PinpointSMSVoiceV2Client({ region: config.AWS_REGION }), {
              configurationSetName: config.AWS_SMS_CONFIGURATION_SET,
              allowedTopicArns: config.AWS_SNS_INBOUND_TOPIC_ARNS,
            }),
        }
      : {}),
    ...(twilio
      ? {
          twilio: () =>
            new TwilioSmsProvider({
              ...twilio,
              webhookUrl: `${config.APP_BASE_URL}/api/v1/webhooks/sms/twilio`,
            }),
        }
      : {}),
  };
}

/**
 * The deployment's default provider (SMS_PROVIDER) plus any other configured ones, which clinics can
 * opt into (Settings). The dev provider is never offered alongside a real one.
 */
export function createSmsProviders(config: SmsConfig): SmsProviderRegistry {
  const available = factories(config);
  const make = available[config.SMS_PROVIDER];
  if (!make) throw new Error(`SMS provider "${config.SMS_PROVIDER}" is not configured`);
  const others = (Object.keys(available) as ProviderName[])
    .filter(
      (name) => name !== config.SMS_PROVIDER && !(name === 'dev' && config.SMS_PROVIDER !== 'dev'),
    )
    .map((name) => (available[name] as () => SmsProvider)());
  return createSmsProviderRegistry(make(), others);
}

export * from './types';
