import { pino, type Logger } from 'pino';
import type { LogLevel, NodeEnv } from './env';

// Safety net only. The primary rule is: never pass PHI to the logger; log IDs instead.
const PHI_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.mfaSecret',
  '*.firstName',
  '*.lastName',
  '*.mobileE164',
  '*.mobile_e164',
  '*.phone',
  '*.from',
  '*.to',
  '*.body',
  '*.email',
];

export function createLogger(options: { level: LogLevel; nodeEnv: NodeEnv }): Logger {
  return pino({
    level: options.level,
    redact: { paths: PHI_REDACT_PATHS, censor: '[REDACTED]' },
    ...(options.nodeEnv === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}

export type { Logger };
