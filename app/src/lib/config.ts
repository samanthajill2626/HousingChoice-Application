// Typed runtime configuration, read from process.env.
//
// Fail-fast policy: in production NODE_ENV, CF_ORIGIN_SECRET is mandatory and
// startup throws without it; when MESSAGING_DRIVER resolves to `twilio`, all
// TWILIO_* credentials are mandatory too. Locally a dev placeholder / console
// driver is allowed so the dev loop boots with no .env present.

/** Outbound messaging driver: real Twilio REST vs the local console fake. */
export type MessagingDriverName = 'twilio' | 'console';

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
  /**
   * Physical-table-name prefix: hc-local- on dev machines (default),
   * hc-dev- / hc-prod- set by Terraform in M0.4. See tableName().
   */
  tablePrefix: string;
  /** OTLP export endpoint — wired to CloudWatch Application Signals in M0.4/M0.6. */
  otelExporterOtlpEndpoint?: string;
  /** EventBridge Scheduler target/role ARNs — real values land with Terraform in M0.4. */
  schedulerTargetArn?: string;
  schedulerRoleArn?: string;
  /**
   * Which MessagingAdapter driver to use (M1.1). MESSAGING_DRIVER env;
   * defaults to `twilio` when NODE_ENV=production (both deployed stacks) and
   * `console` for local NODE_ENVs (development/test).
   */
  messagingDriver: MessagingDriverName;
  /** Twilio account SID (ACxxx). REST auth pairs it with the API key below. */
  twilioAccountSid?: string;
  /** Twilio API key SID/secret (SKxxx) — the ONLY credentials used for REST. */
  twilioApiKeySid?: string;
  twilioApiKeySecret?: string;
  /**
   * Twilio auth token — RESERVED for webhook HMAC signature validation
   * (M1.1 Builder B). Never used for REST calls. Never log.
   */
  twilioAuthToken?: string;
  /** A2P Messaging Service (MGxxx) all outbound sends go through. */
  twilioMessagingServiceSid?: string;
  /**
   * Public https base URL of the stack (the CloudFront domain,
   * `https://<domain>`) — Twilio webhook signature reconstruction needs the
   * exact public URL (M1.1 Builder B). Empty locally.
   */
  publicBaseUrl?: string;
  /**
   * Per-conversation circuit breaker: max AUTOMATED outbound messages per
   * conversation per minute before the breaker trips (doc §7.1).
   */
  sendBreakerMaxPerMinute: number;
}

/** Dev-only fallback; matches .env.example. Never used when NODE_ENV=production. */
const DEV_ORIGIN_SECRET_DEFAULT = 'dev-placeholder-not-a-secret';

/** Default table prefix for local dev; M0.4 Terraform sets hc-dev-/hc-prod-. */
export const DEFAULT_TABLE_PREFIX = 'hc-local-';

/**
 * Resolve a table's physical name from its base name (see lib/tables.ts):
 * `${TABLE_PREFIX}${base}`. Never hardcode physical table names.
 */
export function tableName(base: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${env.TABLE_PREFIX ?? DEFAULT_TABLE_PREFIX}${base}`;
}

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

  // Default: console for local NODE_ENVs (development/test), twilio when
  // deployed — both AWS stacks run NODE_ENV=production (params module).
  const messagingDriverRaw = env.MESSAGING_DRIVER ?? (nodeEnv === 'production' ? 'twilio' : 'console');
  if (messagingDriverRaw !== 'twilio' && messagingDriverRaw !== 'console') {
    throw new Error(`MESSAGING_DRIVER must be 'twilio' or 'console', got: ${messagingDriverRaw}`);
  }
  const messagingDriver: MessagingDriverName = messagingDriverRaw;
  if (messagingDriver === 'twilio') {
    const missing = [
      'TWILIO_ACCOUNT_SID',
      'TWILIO_API_KEY_SID',
      'TWILIO_API_KEY_SECRET',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_MESSAGING_SERVICE_SID',
    ].filter((key) => !env[key]);
    if (missing.length > 0) {
      throw new Error(
        `MESSAGING_DRIVER=twilio requires ${missing.join(', ')} — hydrate from Parameter Store ` +
          '(npm run secrets:push) or set MESSAGING_DRIVER=console. Refusing to start without them.',
      );
    }
  }

  const sendBreakerMaxPerMinute = Number(env.SEND_BREAKER_MAX_PER_MINUTE ?? 10);
  if (!Number.isInteger(sendBreakerMaxPerMinute) || sendBreakerMaxPerMinute <= 0) {
    throw new Error(
      `SEND_BREAKER_MAX_PER_MINUTE must be a positive integer, got: ${env.SEND_BREAKER_MAX_PER_MINUTE}`,
    );
  }

  return {
    nodeEnv,
    port,
    logLevel: env.LOG_LEVEL ?? 'info',
    cfOriginSecret: cfOriginSecret ?? DEV_ORIGIN_SECRET_DEFAULT,
    otelSdkDisabled: (env.OTEL_SDK_DISABLED ?? '').toLowerCase() === 'true',
    awsRegion: env.AWS_REGION ?? 'us-east-1',
    dynamodbEndpoint: env.DYNAMODB_ENDPOINT,
    tablePrefix: env.TABLE_PREFIX ?? DEFAULT_TABLE_PREFIX,
    otelExporterOtlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    schedulerTargetArn: env.SCHEDULER_TARGET_ARN,
    schedulerRoleArn: env.SCHEDULER_ROLE_ARN,
    messagingDriver,
    twilioAccountSid: env.TWILIO_ACCOUNT_SID,
    twilioApiKeySid: env.TWILIO_API_KEY_SID,
    twilioApiKeySecret: env.TWILIO_API_KEY_SECRET,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN,
    twilioMessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    sendBreakerMaxPerMinute,
  };
}
