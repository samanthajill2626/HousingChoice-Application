// Typed runtime configuration, read from process.env.
//
// Fail-fast policy: in production NODE_ENV, CF_ORIGIN_SECRET, the job-
// delivery wiring (JOBS_QUEUE_URL + SCHEDULER_TARGET_ARN/SCHEDULER_ROLE_ARN)
// and the M1.3 auth wiring (SESSION_SECRET + GOOGLE_CLIENT_ID/SECRET +
// OAUTH_ALLOWED_DOMAINS) are mandatory and startup throws without them; when
// MESSAGING_DRIVER resolves to `twilio`, all TWILIO_* credentials are
// mandatory too. Locally a dev placeholder / console driver / in-memory job
// path / unconfigured OAuth is allowed so the dev loop boots with no .env
// present.

import { logger } from './logger.js';

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
  /**
   * EventBridge Scheduler target/role ARNs (Terraform jobs module, M1.2):
   * target = the SQS jobs queue ARN, role = what Scheduler assumes to
   * SendMessage. Both unset locally (in-memory scheduler adapter).
   */
  schedulerTargetArn?: string;
  schedulerRoleArn?: string;
  /**
   * SQS jobs queue URL the WORKER long-polls for job envelopes
   * (JOBS_QUEUE_URL — Terraform jobs module, M1.2). Unset locally: the worker
   * starts no poll loop.
   */
  jobsQueueUrl?: string;
  /**
   * Which MessagingAdapter driver to use (M1.1). MESSAGING_DRIVER env;
   * defaults to `twilio` when NODE_ENV=production (both deployed stacks) and
   * `console` for local NODE_ENVs (development/test).
   */
  messagingDriver: MessagingDriverName;
  /**
   * Relay number-provisioning kill-switch (M1.7 safety). When false,
   * provisionForPlacement refuses to OBTAIN a new pool number (no
   * adapter.provisionPhoneNumber → no real Twilio number PURCHASE) and throws
   * RelayProvisioningDisabledError. Read from RELAY_LIVE_PROVISIONING; when
   * unset it DEFAULTS to (messagingDriver === 'console') — true locally/test
   * (console fakes, $0), false when deployed (twilio driver buys real
   * numbers). Flip it to true (RELAY_LIVE_PROVISIONING=true) only after A2P
   * approval to enable buying a pool number.
   */
  relayLiveProvisioning: boolean;
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
  /**
   * OUR business phone numbers (E.164, from comma-separated
   * OUR_PHONE_NUMBERS). The webhook echo/author check (doc §7.1 defense 1):
   * an inbound webhook whose From matches one of these is our own outbound
   * projected back — acknowledged and dropped, never processed.
   */
  ourPhoneNumbers: string[];
  /**
   * S3 bucket inbound MMS media is mirrored into (MEDIA_BUCKET) —
   * Terraform-managed in AWS (the s3_media module's bucket). Unset locally:
   * media mirroring is skipped with a log instead.
   */
  mediaBucket?: string;
  /**
   * Max concurrent GET /api/events SSE streams (SSE_MAX_CONNECTIONS,
   * default 50) — each stream holds a socket/timer/listeners until close;
   * beyond the cap new streams get 503.
   */
  sseMaxConnections: number;
  /**
   * Public-surface rate limit (M1.5): max requests per window per client IP on
   * the unauthenticated /public routes (housing-fair intake + flyer). Safe
   * defaults (PUBLIC_RATE_LIMIT_MAX=5, PUBLIC_RATE_LIMIT_WINDOW_MS=60000) so
   * nothing is required to boot. Single-instance, in-memory (see
   * middleware/rateLimit.ts).
   */
  publicRateLimitMax: number;
  publicRateLimitWindowMs: number;
  /**
   * A2P outbound throttle (M1.7): tokens/sec the shared TokenBucket admits
   * before the worker dispatches each relay-fan-out / broadcast job
   * (A2P_RATE_LIMIT_PER_SEC, default 1.0). DELIBERATELY conservative — below
   * the registered A2P tier (sourced here / Parameter Store later). A missing
   * or invalid value WARNs and falls back to the default; it never crashes
   * boot (texting is core — a bad throttle value must not take the app down).
   */
  a2pRateLimitPerSec: number;
  /**
   * Secret the session-cookie AES-256-GCM key is derived from (M1.3 auth).
   * Terraform-managed random SecureString /hc/<env>/app/SESSION_SECRET —
   * exactly the CF_ORIGIN_SECRET pattern. Never log.
   */
  sessionSecret: string;
  /**
   * Google OAuth client credentials (M1.3) — operator secrets
   * (.env.<env> → secrets:push). Unset locally: /auth/login responds 503.
   */
  googleClientId?: string;
  googleClientSecret?: string;
  /**
   * Workspace domains allowed to sign in (OAUTH_ALLOWED_DOMAINS,
   * comma-separated, lowercased). EMPTY = nobody can log in (safe default;
   * production fails fast on empty). The callback checks the email domain
   * (authoritative) AND the `hd` claim when present (corroboration) — see
   * routes/auth.ts.
   */
  oauthAllowedDomains: string[];
  /**
   * Directory of built dashboard assets the app serves statically with SPA
   * index.html fallback (DASHBOARD_DIST_DIR, M1.3). Set by the Docker image
   * (/srv/app/public); unset locally — the Vite dev server serves the UI.
   */
  dashboardDistDir?: string;
  /**
   * Web Push VAPID keys (M1.4). OPERATOR-managed (.env.<env> →
   * secrets:push), NOT Terraform-managed — VAPID_PRIVATE_KEY is a secret, the
   * public key is sent to browsers (not secret) but stored the same way for
   * simplicity. Generated by `npm run vapid:keys`. ALL THREE unset =
   * push is unconfigured: push endpoints answer 503 push_not_configured and
   * pushService is a no-op (the app still boots — push is a feature, not core;
   * texting/calls are core). NOT fail-fast even in production.
   */
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  /** VAPID `sub` claim — a `mailto:` or `https:` URI identifying the sender. */
  vapidSubject?: string;
}

/**
 * True when all three VAPID values are present — the single predicate the
 * push adapter, service, and routes gate on. Unconfigured = push is a no-op /
 * 503, never a boot failure (push is a feature; texting/calls are core).
 */
export function isPushConfigured(config: AppConfig): boolean {
  return (
    config.vapidPublicKey !== undefined &&
    config.vapidPrivateKey !== undefined &&
    config.vapidSubject !== undefined
  );
}

/** Dev-only fallback; matches .env.example. Never used when NODE_ENV=production. */
const DEV_ORIGIN_SECRET_DEFAULT = 'dev-placeholder-not-a-secret';

/**
 * Dev-only session-secret fallback; matches .env.example and the test
 * session-cookie factory (app/test/helpers/authSession.ts). Never used when
 * NODE_ENV=production (fail-fast below).
 */
export const DEV_SESSION_SECRET_DEFAULT = 'dev-placeholder-session-secret';

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

  // Relay number-provisioning kill-switch (M1.7 safety). DEFAULT: on when the
  // console driver is selected (local/test — fake $0 numbers), OFF when the
  // twilio driver is selected (deployed — a fresh provision is a real number
  // PURCHASE). So a DEPLOYED stack cannot accidentally buy a number before A2P
  // approval; flip RELAY_LIVE_PROVISIONING=true once approved. NOT fail-fast:
  // an unparseable value WARNs (the value is a boolean flag, no PII) and falls
  // back to the default. true: 'true'|'1'|'yes'; false: 'false'|'0'|'no'.
  const relayLiveProvisioningDefault = messagingDriver === 'console';
  let relayLiveProvisioning = relayLiveProvisioningDefault;
  const relayLiveProvisioningRaw = env.RELAY_LIVE_PROVISIONING;
  if (relayLiveProvisioningRaw !== undefined && relayLiveProvisioningRaw.trim().length > 0) {
    const normalized = relayLiveProvisioningRaw.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      relayLiveProvisioning = true;
    } else if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      relayLiveProvisioning = false;
    } else {
      logger.warn(
        { default: relayLiveProvisioningDefault },
        "RELAY_LIVE_PROVISIONING is not one of true/1/yes/false/0/no — using the default",
      );
    }
  }

  const sendBreakerMaxPerMinute = Number(env.SEND_BREAKER_MAX_PER_MINUTE ?? 10);
  if (!Number.isInteger(sendBreakerMaxPerMinute) || sendBreakerMaxPerMinute <= 0) {
    throw new Error(
      `SEND_BREAKER_MAX_PER_MINUTE must be a positive integer, got: ${env.SEND_BREAKER_MAX_PER_MINUTE}`,
    );
  }

  const sseMaxConnections = Number(env.SSE_MAX_CONNECTIONS ?? 50);
  if (!Number.isInteger(sseMaxConnections) || sseMaxConnections <= 0) {
    throw new Error(
      `SSE_MAX_CONNECTIONS must be a positive integer, got: ${env.SSE_MAX_CONNECTIONS}`,
    );
  }

  // Public-surface rate limit (M1.5) — safe defaults so nothing is required.
  const publicRateLimitMax = Number(env.PUBLIC_RATE_LIMIT_MAX ?? 5);
  if (!Number.isInteger(publicRateLimitMax) || publicRateLimitMax <= 0) {
    throw new Error(
      `PUBLIC_RATE_LIMIT_MAX must be a positive integer, got: ${env.PUBLIC_RATE_LIMIT_MAX}`,
    );
  }
  const publicRateLimitWindowMs = Number(env.PUBLIC_RATE_LIMIT_WINDOW_MS ?? 60_000);
  if (!Number.isInteger(publicRateLimitWindowMs) || publicRateLimitWindowMs <= 0) {
    throw new Error(
      `PUBLIC_RATE_LIMIT_WINDOW_MS must be a positive integer (ms), got: ${env.PUBLIC_RATE_LIMIT_WINDOW_MS}`,
    );
  }

  // A2P outbound throttle (M1.7). NOT fail-fast: a bad/missing value falls
  // back to the conservative 1.0 msg/sec default (texting is core — a throttle
  // typo must never take the app down). An explicitly-set-but-invalid value
  // WARNs so the operator notices the fallback.
  const A2P_RATE_LIMIT_DEFAULT = 1.0;
  let a2pRateLimitPerSec = A2P_RATE_LIMIT_DEFAULT;
  if (env.A2P_RATE_LIMIT_PER_SEC !== undefined && env.A2P_RATE_LIMIT_PER_SEC.length > 0) {
    const parsed = Number(env.A2P_RATE_LIMIT_PER_SEC);
    if (Number.isFinite(parsed) && parsed > 0) {
      a2pRateLimitPerSec = parsed;
    } else {
      logger.warn(
        { value: env.A2P_RATE_LIMIT_PER_SEC, fallback: A2P_RATE_LIMIT_DEFAULT },
        'A2P_RATE_LIMIT_PER_SEC is not a positive number — using the default',
      );
    }
  }

  // Job-delivery wiring (M1.2) is mandatory in production — same fail-fast
  // pattern as CF_ORIGIN_SECRET/OUR_PHONE_NUMBERS above. Without it the app
  // would accept enqueues into the in-memory adapter (silently undelivered)
  // and the worker would start no poll loop. Local NODE_ENVs keep the
  // WARN + in-memory path (expected: nothing delivers jobs on a laptop).
  if (nodeEnv === 'production') {
    const missingJobDelivery = [
      'JOBS_QUEUE_URL',
      'SCHEDULER_TARGET_ARN',
      'SCHEDULER_ROLE_ARN',
    ].filter((key) => !env[key]);
    if (missingJobDelivery.length > 0) {
      throw new Error(
        `NODE_ENV=production requires ${missingJobDelivery.join(', ')} (job delivery wiring, ` +
          'Terraform jobs module → Parameter Store). Refusing to start without them.',
      );
    }
  }

  // M1.3 auth wiring is mandatory in production — same fail-fast pattern as
  // the job-delivery block above. SESSION_SECRET is Terraform-managed (params
  // module, exactly the CF_ORIGIN_SECRET pattern); GOOGLE_* and
  // OAUTH_ALLOWED_DOMAINS are operator secrets (npm run secrets:push). Local
  // NODE_ENVs boot with the placeholder session secret and OAuth
  // unconfigured (/auth/login responds 503 oauth_not_configured).
  if (nodeEnv === 'production') {
    const missingAuth = [
      'SESSION_SECRET',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'OAUTH_ALLOWED_DOMAINS',
    ].filter((key) => !env[key]);
    if (missingAuth.length > 0) {
      throw new Error(
        `NODE_ENV=production requires ${missingAuth.join(', ')} (M1.3 auth: SESSION_SECRET comes ` +
          'from the Terraform params module; the others are operator secrets — npm run ' +
          'secrets:push). Refusing to start without them.',
      );
    }
    // The PLACEHOLDER value is as bad as absence: it is committed to the repo
    // (.env.example), so anyone could mint valid session cookies with it.
    if (env.SESSION_SECRET === DEV_SESSION_SECRET_DEFAULT) {
      throw new Error(
        'SESSION_SECRET is the committed dev placeholder — production refuses it. The real value ' +
          'is the Terraform-generated SecureString /hc/<env>/app/SESSION_SECRET (params module); ' +
          'the deploy hydrates it. Refusing to start.',
      );
    }
  }

  // Comma-separated Workspace domains, lowercased; empty/unset = NOBODY can
  // log in (safe default — production fails fast above instead). Malformed
  // entries fail fast (same posture as OUR_PHONE_NUMBERS below: a silently
  // dropped domain locks the team out; a typo'd one could let outsiders in).
  const oauthAllowedDomains = (env.OAUTH_ALLOWED_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
  for (const domain of oauthAllowedDomains) {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
      throw new Error(
        `OAUTH_ALLOWED_DOMAINS entries must be bare lowercase domains (example.org), got: ${domain}`,
      );
    }
  }

  // Comma-separated E.164 list; whitespace tolerated; empty/unset = none
  // (the echo defense then relies on SID dedupe alone — layer 2).
  const ourPhoneNumbers = (env.OUR_PHONE_NUMBERS ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  for (const n of ourPhoneNumbers) {
    if (!/^\+[1-9]\d{1,14}$/.test(n)) {
      // Fail fast on a malformed list: a silently-dropped business number
      // disables the echo/author defense for that number.
      throw new Error(`OUR_PHONE_NUMBERS entries must be E.164 (+1...), got: ${n}`);
    }
  }
  // Echo defense #1 (doc §7.1) must be un-misconfigurable: a production stack
  // talking to real Twilio with an empty OUR_PHONE_NUMBERS would silently run
  // on SID-dedupe alone — fail fast instead (same pattern as TWILIO_* above).
  if (messagingDriver === 'twilio' && nodeEnv === 'production' && ourPhoneNumbers.length === 0) {
    throw new Error(
      'OUR_PHONE_NUMBERS is required when MESSAGING_DRIVER=twilio and NODE_ENV=production — it must ' +
        'list every owned number (echo/author defense 1). Hydrate from Parameter Store (npm run ' +
        'secrets:push). Refusing to start without it.',
    );
  }

  // Web Push VAPID (M1.4) — operator-managed, optional everywhere (push is a
  // feature, not core; unconfigured = 503/no-op, never a boot failure). The
  // ONLY validation: when a subject IS set it must be a mailto:/https: URI
  // (web-push refuses anything else at send time — fail loud at config load
  // instead of per-send). The keys are opaque base64url; web-push validates
  // their length when it configures, so no shape check here.
  const vapidSubject = env.VAPID_SUBJECT;
  if (vapidSubject !== undefined && vapidSubject.length > 0) {
    if (!/^(mailto:|https:\/\/)/.test(vapidSubject)) {
      throw new Error(
        `VAPID_SUBJECT must be a mailto: or https:// URI (web-push requires it), got: ${vapidSubject}`,
      );
    }
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
    jobsQueueUrl: env.JOBS_QUEUE_URL,
    messagingDriver,
    relayLiveProvisioning,
    twilioAccountSid: env.TWILIO_ACCOUNT_SID,
    twilioApiKeySid: env.TWILIO_API_KEY_SID,
    twilioApiKeySecret: env.TWILIO_API_KEY_SECRET,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN,
    twilioMessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    sendBreakerMaxPerMinute,
    ourPhoneNumbers,
    mediaBucket: env.MEDIA_BUCKET,
    sseMaxConnections,
    publicRateLimitMax,
    publicRateLimitWindowMs,
    a2pRateLimitPerSec,
    sessionSecret: env.SESSION_SECRET ?? DEV_SESSION_SECRET_DEFAULT,
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    oauthAllowedDomains,
    dashboardDistDir: env.DASHBOARD_DIST_DIR,
    vapidPublicKey: env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: env.VAPID_PRIVATE_KEY,
    vapidSubject: vapidSubject !== undefined && vapidSubject.length > 0 ? vapidSubject : undefined,
  };
}
