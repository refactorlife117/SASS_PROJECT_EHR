import {
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
  aws_rds as rds,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
  aws_sns_subscriptions as subscriptions,
  aws_wafv2 as wafv2,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export interface SlotFillConfig {
  stage: 'staging' | 'production';
  /** Public hostname, e.g. app.slotfill.example (DNS -> the load balancer). */
  domainName: string;
  /** ACM certificate ARN for domainName (same region). */
  certificateArn: string;
  /** Verified SES sender, e.g. "SlotFill <no-reply@slotfill.example>". */
  emailFrom: string;
  /** ECR image tag to run (CI pushes api/web images with this tag). */
  imageTag: string;
  /** Two availability zones (explicit, so synth needs no AWS lookups), e.g. us-east-1a,us-east-1b. */
  availabilityZones: [string, string];
  /**
   * Optional Secrets Manager secret (JSON: clientId, clientSecret, webhookSecret) enabling the
   * DrChrono integration (Phase 8). Created by you after registering the DrChrono API app.
   */
  drchronoSecretArn?: string | undefined;
  /**
   * Optional Twilio secret (JSON: accountSid, authToken), Phase 9. Requires twilioBaaSigned = true:
   * Twilio may carry PHI only under a signed BAA.
   */
  twilioSecretArn?: string | undefined;
  twilioBaaSigned?: boolean | undefined;
  /** Optional email address for CloudWatch alarm notifications. */
  alarmEmail?: string | undefined;
}

/**
 * SlotFill on AWS (HIPAA-eligible services only; sign the AWS BAA before real PHI):
 * VPC (DB in isolated subnets) · RDS Postgres 16 (KMS-encrypted, SSL forced, private) · ECS Fargate
 * api/worker/web + one-off "release" task (DB bootstrap + migrations) · ALB with TLS + WAF ·
 * Secrets Manager · KMS · SNS topic for inbound two-way SMS · CloudWatch logs and alarms.
 */
export class SlotFillStack extends Stack {
  constructor(scope: Construct, id: string, config: SlotFillConfig, props?: StackProps) {
    super(scope, id, props);
    const prod = config.stage === 'production';
    if (config.twilioSecretArn && !config.twilioBaaSigned) {
      throw new Error('twilioSecretArn requires twilioBaaSigned=true (sign the Twilio BAA first)');
    }
    const retain = prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const appBaseUrl = `https://${config.domainName}`;

    // ---- Encryption key (RDS, secrets, ECR, SNS) ----
    const key = new kms.Key(this, 'DataKey', {
      alias: `alias/slotfill-${config.stage}`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // End User Messaging SMS publishes inbound texts to our KMS-encrypted SNS topic.
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('sms-voice.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );

    // ---- Network ----
    const vpc = new ec2.Vpc(this, 'Vpc', {
      availabilityZones: config.availabilityZones,
      natGateways: prod ? 2 : 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { name: 'db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    // ---- Database ----
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'Postgres',
      allowAllOutbound: false,
    });
    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: prod
        ? ec2.InstanceType.of(ec2.InstanceClass.M7G, ec2.InstanceSize.LARGE)
        : ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      databaseName: 'slotfill',
      credentials: rds.Credentials.fromGeneratedSecret('slotfill_owner', { encryptionKey: key }),
      storageEncrypted: true,
      storageEncryptionKey: key,
      publiclyAccessible: false,
      multiAz: prod,
      allocatedStorage: 50,
      maxAllocatedStorage: 500,
      backupRetention: Duration.days(prod ? 30 : 7),
      deletionProtection: prod,
      removalPolicy: prod ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
      cloudwatchLogsExports: ['postgresql'],
      parameters: { 'rds.force_ssl': '1' },
    });
    const ownerSecret = database.secret;
    if (!ownerSecret) throw new Error('RDS owner secret missing');

    // ---- Secrets (all generated; nothing to paste by hand) ----
    const appDbPassword = new secretsmanager.Secret(this, 'AppDbPassword', {
      description: 'Password of the slotfill_app runtime DB role (RLS applies)',
      encryptionKey: key,
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
      removalPolicy: retain,
    });
    const hexOnly = {
      passwordLength: 64,
      excludePunctuation: true,
      excludeUppercase: true,
      excludeCharacters: 'ghijklmnopqrstuvwxyz',
    };
    const sessionSecret = new secretsmanager.Secret(this, 'SessionSecret', {
      encryptionKey: key,
      generateSecretString: hexOnly,
      removalPolicy: retain,
    });
    // 64 hex chars = 32 bytes; the app accepts hex or base64 for ENCRYPTION_KEY.
    const encryptionKey = new secretsmanager.Secret(this, 'FieldEncryptionKey', {
      description: 'AES-256-GCM key for MFA secrets / EHR credentials (64 hex chars)',
      encryptionKey: key,
      generateSecretString: hexOnly,
      removalPolicy: RemovalPolicy.RETAIN, // losing it makes encrypted fields unreadable
    });

    // ---- Inbound SMS: End User Messaging two-way SMS -> SNS -> HTTPS webhook ----
    const inboundSms = new sns.Topic(this, 'InboundSms', {
      masterKey: key,
      displayName: 'SlotFill inbound SMS',
    });
    inboundSms.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('sms-voice.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [inboundSms.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
    inboundSms.addSubscription(
      new subscriptions.UrlSubscription(`${appBaseUrl}/api/v1/webhooks/sms/aws`),
    );

    // ---- Images ----
    const repo = (name: string) =>
      new ecr.Repository(this, `${name}Repo`, {
        repositoryName: `slotfill-${config.stage}-${name.toLowerCase()}`,
        imageScanOnPush: true,
        encryption: ecr.RepositoryEncryption.KMS,
        encryptionKey: key,
        removalPolicy: retain,
        lifecycleRules: [{ maxImageCount: 30 }],
      });
    const apiRepo = repo('Api');
    const webRepo = repo('Web');

    // ---- ECS ----
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
    const logGroup = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, {
        retention: prod ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
        removalPolicy: retain,
      });

    const commonEnv = {
      NODE_ENV: 'production',
      APP_ENV: config.stage,
      APP_BASE_URL: appBaseUrl,
      LOG_LEVEL: 'info',
      AWS_REGION: this.region,
      SMS_PROVIDER: 'aws',
      AWS_SNS_INBOUND_TOPIC_ARNS: inboundSms.topicArn,
      EMAIL_TRANSPORT: 'ses',
      EMAIL_FROM: config.emailFrom,
      DB_HOST: database.dbInstanceEndpointAddress,
      DB_PORT: database.dbInstanceEndpointPort,
      DB_NAME: 'slotfill',
      DB_USER: 'slotfill_app',
      DB_SSLMODE: 'require',
      ...(config.twilioSecretArn ? { TWILIO_BAA_SIGNED: 'true' } : {}),
    };
    const appSecrets = {
      DB_PASSWORD: ecs.Secret.fromSecretsManager(appDbPassword),
      SESSION_SECRET: ecs.Secret.fromSecretsManager(sessionSecret),
      ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(encryptionKey),
      ...(config.drchronoSecretArn
        ? (() => {
            const drchrono = secretsmanager.Secret.fromSecretCompleteArn(
              this,
              'DrChronoSecret',
              config.drchronoSecretArn,
            );
            return {
              DRCHRONO_CLIENT_ID: ecs.Secret.fromSecretsManager(drchrono, 'clientId'),
              DRCHRONO_CLIENT_SECRET: ecs.Secret.fromSecretsManager(drchrono, 'clientSecret'),
              DRCHRONO_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(drchrono, 'webhookSecret'),
            };
          })()
        : {}),
      ...(config.twilioSecretArn
        ? (() => {
            const twilio = secretsmanager.Secret.fromSecretCompleteArn(
              this,
              'TwilioSecret',
              config.twilioSecretArn,
            );
            return {
              TWILIO_ACCOUNT_SID: ecs.Secret.fromSecretsManager(twilio, 'accountSid'),
              TWILIO_AUTH_TOKEN: ecs.Secret.fromSecretsManager(twilio, 'authToken'),
            };
          })()
        : {}),
    };

    /** Task role for api/worker: send SMS and SES email; nothing else. */
    const appTaskRole = new iam.Role(this, 'AppTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    appTaskRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['sms-voice:SendTextMessage'], resources: ['*'] }),
    );
    appTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [`arn:${this.partition}:ses:${this.region}:${this.account}:identity/*`],
      }),
    );

    const apiImage = ecs.ContainerImage.fromEcrRepository(apiRepo, config.imageTag);
    const apiTask = (
      name: string,
      command: string[] | undefined,
      cpu: number,
      memory: number,
      port?: number,
    ) => {
      const task = new ecs.FargateTaskDefinition(this, `${name}Task`, {
        cpu,
        memoryLimitMiB: memory,
        taskRole: appTaskRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });
      task.addContainer(name, {
        image: apiImage,
        ...(command ? { command } : {}),
        environment: { ...commonEnv, ...(port ? { API_PORT: String(port) } : {}) },
        secrets: appSecrets,
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: name.toLowerCase(),
          logGroup: logGroup(name),
        }),
        readonlyRootFilesystem: false,
        ...(port ? { portMappings: [{ containerPort: port }] } : {}),
      });
      return task;
    };
    const apiTaskDef = apiTask('Api', undefined, 512, 1024, 4000);
    const workerTaskDef = apiTask(
      'Worker',
      ['pnpm', '--filter', '@slotfill/api', 'start:worker'],
      512,
      1024,
    );

    // Release task: bootstrap the DB roles/schema and apply migrations, as the OWNER (run before deploys).
    const releaseTaskDef = new ecs.FargateTaskDefinition(this, 'ReleaseTask', {
      cpu: 256,
      memoryLimitMiB: 512,
    });
    releaseTaskDef.addContainer('Release', {
      image: apiImage,
      command: [
        'sh',
        '-c',
        'export MIGRATE_DATABASE_URL="postgresql://$OWNER_USER:$(node -e \'process.stdout.write(encodeURIComponent(process.env.OWNER_PASSWORD))\')@$DB_HOST:$DB_PORT/$DB_NAME?sslmode=require" && pnpm --filter @slotfill/api db:release',
      ],
      // APP_ENV also guards the seed script: it refuses to run when APP_ENV=production.
      environment: {
        APP_ENV: config.stage,
        DB_HOST: commonEnv.DB_HOST,
        DB_PORT: commonEnv.DB_PORT,
        DB_NAME: 'slotfill',
      },
      secrets: {
        OWNER_USER: ecs.Secret.fromSecretsManager(ownerSecret, 'username'),
        OWNER_PASSWORD: ecs.Secret.fromSecretsManager(ownerSecret, 'password'),
        APP_DB_PASSWORD: ecs.Secret.fromSecretsManager(appDbPassword),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'release', logGroup: logGroup('Release') }),
    });

    const webTaskDef = new ecs.FargateTaskDefinition(this, 'WebTask', {
      cpu: 256,
      memoryLimitMiB: 512,
    });
    webTaskDef.addContainer('Web', {
      image: ecs.ContainerImage.fromEcrRepository(webRepo, config.imageTag),
      environment: { NODE_ENV: 'production' },
      portMappings: [{ containerPort: 3000 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'web', logGroup: logGroup('Web') }),
    });

    const appSubnets = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };
    const service = (
      name: string,
      taskDefinition: ecs.FargateTaskDefinition,
      desiredCount: number,
    ) =>
      new ecs.FargateService(this, `${name}Service`, {
        cluster,
        taskDefinition,
        desiredCount,
        vpcSubnets: appSubnets,
        assignPublicIp: false,
        circuitBreaker: { rollback: true },
        minHealthyPercent: 100,
      });
    const apiService = service('Api', apiTaskDef, prod ? 2 : 1);
    const workerService = service('Worker', workerTaskDef, prod ? 2 : 1);
    const webService = service('Web', webTaskDef, prod ? 2 : 1);
    for (const s of [apiService, workerService]) {
      dbSecurityGroup.addIngressRule(
        s.connections.securityGroups[0] ?? dbSecurityGroup,
        ec2.Port.tcp(5432),
        'app',
      );
    }
    const releaseSg = new ec2.SecurityGroup(this, 'ReleaseSg', {
      vpc,
      description: 'One-off release task',
    });
    dbSecurityGroup.addIngressRule(releaseSg, ec2.Port.tcp(5432), 'release task');

    // ---- Load balancer: /api/* -> api, everything else -> web ----
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      dropInvalidHeaderFields: true,
    });
    alb.addRedirect({ sourcePort: 80, targetPort: 443 });
    const https = alb.addListener('Https', {
      port: 443,
      certificates: [elbv2.ListenerCertificate.fromArn(config.certificateArn)],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      open: true,
    });
    const webTargets = https.addTargets('Web', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [webService],
      healthCheck: { path: '/login', healthyHttpCodes: '200' },
    });
    const apiTargets = https.addTargets('Api', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/api/*'])],
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [apiService],
      healthCheck: { path: '/api/v1/health/ready', healthyHttpCodes: '200' },
      deregistrationDelay: Duration.seconds(30),
    });

    // ---- WAF: managed rules + per-IP rate limits (also covers auth/webhook limits across tasks) ----
    const rateRule = (
      name: string,
      priority: number,
      limit: number,
      path?: string,
    ): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      action: { block: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: name,
        sampledRequestsEnabled: true,
      },
      statement: {
        rateBasedStatement: {
          limit,
          aggregateKeyType: 'IP',
          ...(path
            ? {
                scopeDownStatement: {
                  byteMatchStatement: {
                    fieldToMatch: { uriPath: {} },
                    positionalConstraint: 'STARTS_WITH',
                    searchString: path,
                    textTransformations: [{ priority: 0, type: 'NONE' }],
                  },
                },
              }
            : {}),
        },
      },
    });
    const managed = (name: string, priority: number): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: name,
        sampledRequestsEnabled: true,
      },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
    });
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'slotfill',
        sampledRequestsEnabled: true,
      },
      rules: [
        rateRule('AuthRateLimit', 0, 100, '/api/v1/auth'),
        rateRule('GlobalRateLimit', 1, 2000),
        managed('AWSManagedRulesCommonRuleSet', 2),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 3),
      ],
    });
    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    // ---- Alarms ----
    const alarms = new sns.Topic(this, 'Alarms', {
      masterKey: key,
      displayName: 'SlotFill alarms',
    });
    if (config.alarmEmail)
      alarms.addSubscription(new subscriptions.EmailSubscription(config.alarmEmail));
    const alarm = (
      name: string,
      metric: cloudwatch.IMetric,
      threshold: number,
      comparison = cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    ) =>
      new cloudwatch.Alarm(this, name, {
        metric,
        threshold,
        evaluationPeriods: 3,
        comparisonOperator: comparison,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cwActions.SnsAction(alarms));
    alarm(
      'Alb5xx',
      alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: Duration.minutes(5) }),
      10,
    );
    alarm(
      'Api5xx',
      apiTargets.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
        period: Duration.minutes(5),
      }),
      10,
    );
    alarm('ApiUnhealthy', apiTargets.metrics.unhealthyHostCount(), 1);
    alarm('WebUnhealthy', webTargets.metrics.unhealthyHostCount(), 1);
    alarm('ApiCpu', apiService.metricCpuUtilization(), 80);
    alarm('WorkerCpu', workerService.metricCpuUtilization(), 80);
    alarm(
      'WorkerNotRunning',
      new cloudwatch.Metric({
        namespace: 'ECS/ContainerInsights',
        metricName: 'RunningTaskCount',
        dimensionsMap: { ClusterName: cluster.clusterName, ServiceName: workerService.serviceName },
        period: Duration.minutes(1),
      }),
      1,
      cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    );
    alarm('DbCpu', database.metricCPUUtilization(), 80);
    alarm(
      'DbFreeStorage',
      database.metricFreeStorageSpace(),
      5 * 1024 ** 3,
      cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    );

    // ---- Outputs ----
    new CfnOutput(this, 'LoadBalancerDns', {
      value: alb.loadBalancerDnsName,
      description: `Point ${config.domainName} here (CNAME/alias)`,
    });
    new CfnOutput(this, 'ApiRepositoryUri', { value: apiRepo.repositoryUri });
    new CfnOutput(this, 'WebRepositoryUri', { value: webRepo.repositoryUri });
    new CfnOutput(this, 'InboundSmsTopicArn', {
      value: inboundSms.topicArn,
      description: 'Set as the two-way SMS destination of each clinic number',
    });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'ReleaseTaskDefinition', { value: releaseTaskDef.taskDefinitionArn });
    new CfnOutput(this, 'ReleaseSecurityGroup', { value: releaseSg.securityGroupId });
    // One-off API-environment tasks, e.g. `admin:create-platform-admin` (see docs/deploy.md).
    new CfnOutput(this, 'ApiTaskDefinition', { value: apiTaskDef.taskDefinitionArn });
    new CfnOutput(this, 'ApiSecurityGroup', {
      value: apiService.connections.securityGroups[0]?.securityGroupId ?? '',
    });
    new CfnOutput(this, 'AppSubnets', { value: vpc.selectSubnets(appSubnets).subnetIds.join(',') });
  }
}
