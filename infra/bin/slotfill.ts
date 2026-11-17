import { App } from 'aws-cdk-lib';
import { SlotFillStack, type SlotFillConfig } from '../lib/slotfill-stack';

// Usage: cdk synth|deploy -c stage=staging -c domainName=... -c certificateArn=... -c emailFrom=... \
//        [-c imageTag=...] [-c alarmEmail=...] [-c account=... -c region=...]
const app = new App();
const ctx = (key: string, fallback?: string): string => {
  const value: unknown = app.node.tryGetContext(key);
  if (typeof value === 'string' && value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing context: -c ${key}=...`);
};

const stage = ctx('stage', 'staging');
if (stage !== 'staging' && stage !== 'production')
  throw new Error('stage must be staging or production');

const region = ctx('region', process.env.CDK_DEFAULT_REGION ?? 'us-east-1');
const [az1, az2] = ctx('availabilityZones', `${region}a,${region}b`).split(',');
if (!az1 || !az2) throw new Error('availabilityZones must be two zones, comma-separated');

const account = ctx('account', process.env.CDK_DEFAULT_ACCOUNT ?? '111111111111');
// Pre-answer the availability-zone lookup so synth never needs AWS credentials.
app.node.setContext(`availability-zones:account=${account}:region=${region}`, [az1, az2]);

// Placeholders let `cdk synth` run without an AWS account; deploys must pass real values.
const config: SlotFillConfig = {
  stage,
  domainName: ctx('domainName', `${stage}.slotfill.example`),
  certificateArn: ctx(
    'certificateArn',
    'arn:aws:acm:us-east-1:111111111111:certificate/placeholder',
  ),
  emailFrom: ctx('emailFrom', 'SlotFill <no-reply@slotfill.example>'),
  imageTag: ctx('imageTag', 'latest'),
  availabilityZones: [az1, az2],
  alarmEmail: app.node.tryGetContext('alarmEmail') as string | undefined,
  drchronoSecretArn: app.node.tryGetContext('drchronoSecretArn') as string | undefined,
  twilioSecretArn: app.node.tryGetContext('twilioSecretArn') as string | undefined,
  twilioBaaSigned: app.node.tryGetContext('twilioBaaSigned') === 'true',
};

new SlotFillStack(app, `SlotFill-${stage}`, config, {
  env: { account, region },
  description: `SlotFill (${stage})`,
});
