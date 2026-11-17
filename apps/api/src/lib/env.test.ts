import { describe, expect, it } from 'vitest';
import { devToolsEnabled, loadServerEnv, loadWorkerEnv } from './env';

const secrets = {
  SESSION_SECRET: 'x'.repeat(40),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};
const dev = { DATABASE_URL: 'postgresql://u:p@localhost:5433/slotfill', ...secrets };
const prod = {
  ...dev,
  NODE_ENV: 'production',
  APP_ENV: 'production',
  APP_BASE_URL: 'https://app.example.com',
  SMS_PROVIDER: 'aws',
  AWS_SNS_INBOUND_TOPIC_ARNS: 'arn:aws:sns:us-east-1:123456789012:slotfill-inbound',
};

describe('environment validation', () => {
  it('accepts a minimal development config with safe defaults', () => {
    const env = loadServerEnv(dev);
    expect(env).toMatchObject({
      APP_ENV: 'development',
      SMS_PROVIDER: 'dev',
      EMAIL_TRANSPORT: 'smtp',
    });
    expect(devToolsEnabled(env)).toBe(true);
  });

  it('accepts a production config and disables dev tools', () => {
    const env = loadServerEnv(prod);
    expect(env.AWS_SNS_INBOUND_TOPIC_ARNS).toEqual([
      'arn:aws:sns:us-east-1:123456789012:slotfill-inbound',
    ]);
    expect(devToolsEnabled(env)).toBe(false);
  });

  it('refuses the dev SMS provider, non-https URLs and non-production NODE_ENV when deployed', () => {
    expect(() => loadServerEnv({ ...prod, SMS_PROVIDER: 'dev' })).toThrow(/SMS_PROVIDER/);
    expect(() => loadServerEnv({ ...prod, APP_BASE_URL: 'http://app.example.com' })).toThrow(
      /APP_BASE_URL/,
    );
    expect(() => loadWorkerEnv({ ...prod, APP_ENV: 'staging', NODE_ENV: 'development' })).toThrow(
      /NODE_ENV/,
    );
  });

  it('requires an SNS topic allow-list for the aws provider', () => {
    expect(() => loadServerEnv({ ...prod, AWS_SNS_INBOUND_TOPIC_ARNS: '' })).toThrow(
      /AWS_SNS_INBOUND_TOPIC_ARNS/,
    );
  });

  it('builds DATABASE_URL from Secrets Manager style parts (URL-encoding the password)', () => {
    const env = loadWorkerEnv({
      ENCRYPTION_KEY: secrets.ENCRYPTION_KEY,
      DB_HOST: 'db.internal',
      DB_USER: 'slotfill_app',
      DB_PASSWORD: 'p@ss/w:rd',
      DB_NAME: 'slotfill',
    });
    expect(env.DATABASE_URL).toBe(
      'postgresql://slotfill_app:p%40ss%2Fw%3Ard@db.internal:5432/slotfill?sslmode=require',
    );
  });

  it('never prints secret values in errors', () => {
    expect(() => loadServerEnv({ ...dev, SESSION_SECRET: 'short-secret-value' })).toThrow(
      /SESSION_SECRET/,
    );
    expect(() => loadServerEnv({ ...dev, SESSION_SECRET: 'short-secret-value' })).not.toThrow(
      /short-secret-value/,
    );
  });
});
