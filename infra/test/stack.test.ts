import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { SlotFillStack } from '../lib/slotfill-stack';

function template(stage: 'staging' | 'production') {
  const app = new App();
  const stack = new SlotFillStack(
    app,
    `Test-${stage}`,
    {
      stage,
      domainName: 'app.example.com',
      certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/x',
      emailFrom: 'SlotFill <no-reply@example.com>',
      imageTag: 'abc123',
      availabilityZones: ['us-east-1a', 'us-east-1b'],
      alarmEmail: 'ops@example.com',
    },
    { env: { account: '111111111111', region: 'us-east-1' } },
  );
  return Template.fromStack(stack);
}

describe('SlotFill stack', () => {
  const prod = template('production');

  it('runs Postgres 16 encrypted with KMS, private, SSL-only, Multi-AZ and protected in production', () => {
    prod.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: Match.stringLikeRegexp('^16'),
      StorageEncrypted: true,
      KmsKeyId: Match.anyValue(),
      PubliclyAccessible: false,
      MultiAZ: true,
      DeletionProtection: true,
      BackupRetentionPeriod: 30,
    });
    prod.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Parameters: { 'rds.force_ssl': '1' },
    });
  });

  it('serves HTTPS only (HTTP redirects) and routes /api/* to the API', () => {
    prod.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
    });
    prod.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: 'redirect' })],
    });
    prod.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: [
        Match.objectLike({ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }),
      ],
    });
  });

  it('runs api, worker and web on Fargate in private subnets with no public IPs', () => {
    const services = prod.findResources('AWS::ECS::Service');
    expect(Object.keys(services)).toHaveLength(3);
    for (const svc of Object.values(services)) {
      expect(svc.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp).toBe(
        'DISABLED',
      );
    }
  });

  it('injects secrets from Secrets Manager (never as plain env) and configures the aws SMS provider', () => {
    const tasks = prod.findResources('AWS::ECS::TaskDefinition');
    const api = Object.values(tasks).find((t) =>
      JSON.stringify(t.Properties.ContainerDefinitions).includes('"Name":"Api"'),
    );
    const container = api?.Properties.ContainerDefinitions[0];
    const secretNames = container.Secrets.map((s: { Name: string }) => s.Name).sort();
    expect(secretNames).toEqual(['DB_PASSWORD', 'ENCRYPTION_KEY', 'SESSION_SECRET']);
    const env = Object.fromEntries(
      container.Environment.map((e: { Name: string; Value: unknown }) => [e.Name, e.Value]),
    );
    expect(env).toMatchObject({
      NODE_ENV: 'production',
      APP_ENV: 'production',
      SMS_PROVIDER: 'aws',
      EMAIL_TRANSPORT: 'ses',
      DB_USER: 'slotfill_app',
    });
    expect(JSON.stringify(container.Environment)).not.toMatch(/PASSWORD|SECRET_KEY/);
  });

  it('protects the load balancer with WAF (rate limits incl. auth, AWS managed rules)', () => {
    prod.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      Rules: Match.arrayWith([
        Match.objectLike({ Name: 'AuthRateLimit' }),
        Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet' }),
      ]),
    });
    prod.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  });

  it('subscribes the HTTPS webhook to a KMS-encrypted inbound SMS topic', () => {
    prod.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'https',
      Endpoint: 'https://app.example.com/api/v1/webhooks/sms/aws',
    });
    prod.hasResourceProperties('AWS::SNS::Topic', { KmsMasterKeyId: Match.anyValue() });
  });

  it('has alarms wired to an email-subscribed topic, and a rotating KMS key', () => {
    expect(Object.keys(prod.findResources('AWS::CloudWatch::Alarm')).length).toBeGreaterThanOrEqual(
      8,
    );
    prod.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.com',
    });
    prod.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });

  it('injects DrChrono credentials only when a secret ARN is given', () => {
    const app = new App();
    const stack = new SlotFillStack(
      app,
      'WithDrChrono',
      {
        stage: 'staging',
        domainName: 'app.example.com',
        certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/x',
        emailFrom: 'x <x@example.com>',
        imageTag: 't',
        availabilityZones: ['us-east-1a', 'us-east-1b'],
        drchronoSecretArn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:drchrono-AbCdEf',
      },
      { env: { account: '111111111111', region: 'us-east-1' } },
    );
    expect(JSON.stringify(Template.fromStack(stack).toJSON())).toContain('DRCHRONO_CLIENT_SECRET');
    expect(JSON.stringify(prod.toJSON())).not.toContain('DRCHRONO_CLIENT_SECRET');
  });

  it('refuses Twilio credentials unless the Twilio BAA is marked signed', () => {
    const base = {
      stage: 'staging' as const,
      domainName: 'app.example.com',
      certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/x',
      emailFrom: 'x <x@example.com>',
      imageTag: 't',
      availabilityZones: ['us-east-1a', 'us-east-1b'] as [string, string],
      twilioSecretArn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:twilio-AbCdEf',
    };
    const env = { env: { account: '111111111111', region: 'us-east-1' } };
    expect(() => new SlotFillStack(new App(), 'NoBaa', base, env)).toThrow(/BAA/);
    const ok = new SlotFillStack(new App(), 'WithBaa', { ...base, twilioBaaSigned: true }, env);
    expect(JSON.stringify(Template.fromStack(ok).toJSON())).toContain('TWILIO_AUTH_TOKEN');
  });

  it('staging is smaller and not deletion-protected', () => {
    const staging = template('staging');
    staging.hasResourceProperties('AWS::RDS::DBInstance', {
      MultiAZ: false,
      DeletionProtection: false,
      BackupRetentionPeriod: 7,
    });
  });
});
