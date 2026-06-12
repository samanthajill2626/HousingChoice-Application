// Typed runtime configuration, read from process.env.
//
// Fail-fast policy: in production NODE_ENV, CF_ORIGIN_SECRET is mandatory and
// startup throws without it. Locally a dev placeholder is allowed so the dev
// loop boots with no .env present.

export interface AppConfig {
  nodeEnv: string;
  /** HTTP listen port for the app process (CloudFront -> EC2 origin targets 8080). */
  port: number;
  logLevel: string;
  /** Shared secret CloudFront stamps on origin requests (x-origin-verify). Never log. */
  cfOriginSecret: string;
  otelSdkDisabled: boolean;
  awsRegion: string;
  /** DynamoDB Local endpoint for local dev (M0.3). Unset in AWS. */
  dynamodbEndpoint?: string;
  /** OTLP export endpoint — wired to CloudWatch Application Signals in M0.4/M0.6. */
  otelExporterOtlpEndpoint?: string;
  /** EventBridge Scheduler target/role ARNs — real values land with Terraform in M0.4. */
  schedulerTargetArn?: string;
  schedulerRoleArn?: string;
}

/** Dev-only fallback; matches .env.example. Never used when NODE_ENV=production. */
const DEV_ORIGIN_SECRET_DEFAULT = 'dev-placeholder-not-a-secret';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';

  const cfOriginSecret = env.CF_ORIGIN_SECRET;
  if (nodeEnv === 'production' && !cfOriginSecret) {
    throw new Error(
      'CF_ORIGIN_SECRET is required when NODE_ENV=production (CloudFront origin-secret validator). ' +
        'Hydrate it from Parameter Store — refusing to start without it.',
    );
  }

  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a valid TCP port, got: ${env.PORT}`);
  }

  return {
    nodeEnv,
    port,
    logLevel: env.LOG_LEVEL ?? 'info',
    cfOriginSecret: cfOriginSecret ?? DEV_ORIGIN_SECRET_DEFAULT,
    otelSdkDisabled: (env.OTEL_SDK_DISABLED ?? '').toLowerCase() === 'true',
    awsRegion: env.AWS_REGION ?? 'us-east-1',
    dynamodbEndpoint: env.DYNAMODB_ENDPOINT,
    otelExporterOtlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    schedulerTargetArn: env.SCHEDULER_TARGET_ARN,
    schedulerRoleArn: env.SCHEDULER_ROLE_ARN,
  };
}
