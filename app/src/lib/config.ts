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
  /** Dev-only test/QA endpoints (dev-login, outbox, reseed) are gated on this.
   *  MUST be false in production — loadConfig fails fast otherwise. */
  devAuthEnabled: boolean;
  /** Dev-only: when true, outbound messages are also persisted to the
   *  hc-local-dev-outbox table for inspection. MUST be false in production. */
  recordOutbox: boolean;
  /** HTTP listen port for the app process (CloudFront -> EC2 origin targets 8080). */
  port: number;
  logLevel: string;
  /** Shared secret CloudFront stamps on origin requests (x-origin-verify). Never log. */
  cfOriginSecret: string;
  otelSdkDisabled: boolean;
  awsRegion: string;
  /**
   * Deploy environment name — `local` | `dev` | `prod` (M1.4 System Status).
   * Prefer an explicit HC_ENV; otherwise derived from TABLE_PREFIX
   * (hc-local- → local, hc-dev- → dev, hc-prod- → prod; default local).
   * Names the alarm prefix + error log group below and is surfaced (as a
   * plain string) in GET /api/system/flags. NOT a secret.
   */
  appEnv: string;
  /**
   * CloudWatch alarm-name prefix for THIS env — `hc-<appEnv>-`, matching the
   * Terraform `var.name_prefix` every alarm is named with. The System Status
   * alarms endpoint filters DescribeAlarms by this prefix (M1.4).
   */
  alarmNamePrefix: string;
  /**
   * The app's error log group for THIS env — `/hc/<appEnv>/app`, matching the
   * observability module's app log group (pino error level ≥ 50 lands here).
   * The System Status errors endpoint runs FilterLogEvents against it (M1.4).
   */
  errorLogGroupName: string;
  /** The worker log group for THIS env — `/hc/<appEnv>/worker`. */
  workerLogGroupName: string;
  /** The host/system log group for THIS env — `/hc/<appEnv>/system` (rsyslog: kernel OOM etc.). */
  systemLogGroupName: string;
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
   * provisionForGroup refuses to OBTAIN a new pool number (no
   * adapter.provisionPhoneNumber → no real Twilio number PURCHASE) and throws
   * RelayProvisioningDisabledError. Read from RELAY_LIVE_PROVISIONING; when
   * unset it DEFAULTS to (messagingDriver === 'console') — true locally/test
   * (console fakes, $0), false when deployed (twilio driver buys real
   * numbers). Flip it to true (RELAY_LIVE_PROVISIONING=true) only after A2P
   * approval to enable buying a pool number.
   */
  relayLiveProvisioning: boolean;
  /**
   * Relay number-RELEASE gate (D7 retirement). When true, the retirement sweep
   * (retireEligible / `npm run pool:retire`) may DELETE idle pool numbers at
   * Twilio after the 180-day grace. Read from RELAY_NUMBER_RELEASE_ENABLED ===
   * 'true'; defaults to FALSE everywhere (deployed AND local) until ops turns it
   * on, so no number is ever released by accident. The sweep no-ops when off.
   */
  relayNumberReleaseEnabled: boolean;
  /**
   * Outbound-SMS kill-switch (A2P safety). When false, every real-Twilio SMS
   * send is REFUSED before the provider call (the send wrapper throws a
   * SendRefusedError; the Twilio driver also refuses as a backstop), so a
   * deployed stack cannot emit unregistered-A2P traffic (Twilio 30034) and
   * damage sender reputation before A2P registration is approved. Read from
   * SMS_SENDING_ENABLED; when unset it DEFAULTS to (messagingDriver ===
   * 'console') — true locally/test (console driver, no real send), false when
   * deployed (twilio driver). Flip it to true (SMS_SENDING_ENABLED=true) only
   * AFTER A2P approval. VOICE (calls/bridging) is unaffected — this gates SMS
   * only.
   */
  smsSendingEnabled: boolean;
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
   * Dev-only override of the Twilio REST base URL (e.g. http://localhost:8889 for
   * the fake-twilio service). Redirects the real TwilioMessagingDriver to a fake
   * host so the production driver path is exercised in tests. REJECTED in
   * production (fail-closed) — deployed stacks always use the real Twilio host.
   */
  twilioApiBaseUrl?: string;
  /**
   * Voice Intelligence service SID (GAxxxx) - the per-env VI service the app
   * creates transcripts under (voice-transcription spec 3.1). Optional, absent
   * by default: absent means the transcription feature is OFF (recordings and
   * voicemails still work; no transcript is ever requested). Allowed in every
   * env - dev and prod each get their OWN VI service, so there is no prod guard.
   */
  twilioViServiceSid?: string;
  /**
   * Delay in seconds before the transcript reconcile job re-checks Twilio for a
   * transcript a lost completion webhook never delivered (spec 3.4). Default
   * 600; the hermetic e2e sets it tiny. Rides SQS DelaySeconds exactly (<= 720).
   * A non-finite or non-positive value (including an explicit '0') falls back
   * to the default with a WARN - never fail-fast (transcription is a bolt-on).
   */
  voiceTranscriptReconcileSeconds: number;
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
   * S3-compatible endpoint override for the media store (MEDIA_S3_ENDPOINT) —
   * the local-dev seam for MinIO (e.g. http://localhost:9000). Unset in AWS,
   * where the SDK resolves the real S3 endpoint + instance-role creds. DEV-ONLY:
   * loadConfig refuses to start if this is set while NODE_ENV=production.
   */
  mediaS3Endpoint?: string;
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
   * Per-user rate limit on the manual 1:1 send route
   * (POST /api/conversations/:id/messages, routes/api.ts) — every request is a
   * real SMS from the business number, so a runaway dashboard loop or stuck
   * retry must be bounded (RATE_LIMIT_MANUAL_SEND_PER_MIN, default 30/min per
   * user). Sliding-window, in-memory (middleware/rateLimit.ts).
   */
  rateLimitManualSendPerMin: number;
  /**
   * Per-user rate limit on the broadcast send route
   * (POST /api/broadcasts/:id/send, routes/broadcasts.ts) — each request
   * triggers a whole audience FAN-OUT, the most expensive single click in the
   * app (RATE_LIMIT_BROADCAST_SEND_PER_MIN, default 5/min per user).
   */
  rateLimitBroadcastSendPerMin: number;
  /**
   * Per-user rate limit on the call-originate route
   * (POST /api/contacts/:id/call, routes/voiceApi.ts) — every request rings
   * TWO real phones (the navigator's cell, then the contact) and spends Twilio
   * voice minutes (RATE_LIMIT_ORIGINATE_PER_MIN, default 10/min per user).
   */
  rateLimitOriginatePerMin: number;
  /**
   * Per-user rate limit on cell verify-start
   * (POST /api/users/me/cell/verify-start, routes/voiceApi.ts) — each request
   * sends a code SMS to ANY number the staffer typed (SMS-bombing an arbitrary
   * phone is the abuse case) and resets the code-guess attempt budget, so it
   * gets the tightest ceiling (RATE_LIMIT_VERIFY_START_MAX, default 3 per
   * window; RATE_LIMIT_VERIFY_START_WINDOW_MS, default 180000 = 3 min).
   */
  rateLimitVerifyStartMax: number;
  rateLimitVerifyStartWindowMs: number;
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
  /**
   * Conversation fact extraction kill-switch (Phase 2). When true, an inbound
   * text schedules a debounced LLM extraction run over the conversation. Read
   * from AI_EXTRACTION_ENABLED; default false in production (dormant until the
   * ai_extraction table + ANTHROPIC_API_KEY are provisioned) and true for local
   * NODE_ENVs so the dev loop + e2e exercise the pipeline. Boolean parse mirrors
   * SMS_SENDING_ENABLED (true|1|yes / false|0|no; warn + default otherwise).
   */
  aiExtractionEnabled: boolean;
  /**
   * Which extraction driver to use: anthropic (real structured-output LLM),
   * console (offline no-op so `npm run dev` stays offline), or fake
   * (deterministic test seam). EXTRACTION_DRIVER env; default anthropic when
   * deployed (NODE_ENV=production), console for local NODE_ENVs. The fake driver
   * is REFUSED in production (fail-closed) - a test-only seam.
   */
  extractionDriver: 'anthropic' | 'console' | 'fake';
  /** Model id the anthropic extraction driver calls (AI_EXTRACTION_MODEL; default 'claude-opus-4-8'). */
  aiExtractionModel: string;
  /**
   * Sliding debounce window (ms) between an inbound text and its extraction run
   * (AI_EXTRACTION_DEBOUNCE_MS, default 30000). NOT fail-fast: a bad/missing
   * value WARNs and falls back to the default (a debounce typo must never take
   * the app down). Must be a positive integer.
   */
  aiExtractionDebounceMs: number;
  /**
   * Anthropic API key (operator secret) the extraction driver authenticates
   * with. Required only when extraction is ENABLED with the anthropic driver in
   * production (loadConfig fails fast on that combination). Never log.
   */
  anthropicApiKey?: string;
  /**
   * Dev-only override of the Anthropic REST base URL (e.g. a local mock host).
   * REJECTED in production (fail-closed) - mirror TWILIO_API_BASE_URL; deployed
   * stacks always use the real Anthropic endpoint.
   */
  anthropicApiBaseUrl?: string;
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
 * Resolve the deploy environment name (`local` | `dev` | `prod`) for the
 * M1.4 System Status surface. Prefer an explicit HC_ENV; otherwise derive it
 * from TABLE_PREFIX (the only env-stamped value already wired everywhere):
 * `hc-dev-` → dev, `hc-prod-` → prod, anything else (incl. the local default
 * `hc-local-`) → local. The alarm prefix (`hc-<env>-`) and error log group
 * (`/hc/<env>/app`) are built from this so they always match the Terraform
 * naming for the SAME env the app runs in.
 */
export function resolveAppEnv(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.HC_ENV?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const prefix = env.TABLE_PREFIX ?? DEFAULT_TABLE_PREFIX;
  if (prefix === 'hc-dev-') return 'dev';
  if (prefix === 'hc-prod-') return 'prod';
  return 'local';
}

/**
 * Resolve a table's physical name from its base name (see lib/tables.ts):
 * `${TABLE_PREFIX}${base}`. Never hardcode physical table names.
 */
export function tableName(base: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${env.TABLE_PREFIX ?? DEFAULT_TABLE_PREFIX}${base}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';

  // Deploy env name + the observability names derived from it (M1.4 System
  // Status). All three are non-secret naming values; see resolveAppEnv.
  const appEnv = resolveAppEnv(env);
  const alarmNamePrefix = `hc-${appEnv}-`;
  const errorLogGroupName = `/hc/${appEnv}/app`;
  const workerLogGroupName = `/hc/${appEnv}/worker`;
  const systemLogGroupName = `/hc/${appEnv}/system`;

  // Dev-only endpoints (dev-login, outbox, reseed in later phases) are gated
  // behind this flag. It must NEVER be set in production; if it is, refuse to
  // start rather than expose a backdoor. Checked first, before other validation,
  // so the dangerous combination fails fast regardless of what else is missing.
  const devAuthEnabled = ['true', '1', 'yes'].includes((env.DEV_AUTH_ENABLED ?? '').toLowerCase());
  if (devAuthEnabled && nodeEnv === 'production') {
    throw new Error(
      'DEV_AUTH_ENABLED is set while NODE_ENV=production — refusing to start. The ' +
        'dev-only auth/test endpoints must never be enabled in production.',
    );
  }

  const recordOutbox = ['true', '1', 'yes'].includes((env.MESSAGING_RECORD_OUTBOX ?? '').toLowerCase());
  if (recordOutbox && nodeEnv === 'production') {
    throw new Error(
      'MESSAGING_RECORD_OUTBOX is set while NODE_ENV=production — refusing to start. The dev ' +
        'message outbox persists message bodies (PII) and must never run in production.',
    );
  }

  // Dev-only Twilio REST redirect (fake-twilio host). MUST NOT be set in
  // production; mirrors the DEV_AUTH_ENABLED / MESSAGING_RECORD_OUTBOX dev-only
  // gates above and is checked here, before the other prod-wiring validation, so
  // the dangerous combination fails fast on the right error.
  const twilioApiBaseUrl = env.TWILIO_API_BASE_URL?.trim();
  if (twilioApiBaseUrl !== undefined && twilioApiBaseUrl.length > 0 && nodeEnv === 'production') {
    throw new Error(
      'TWILIO_API_BASE_URL is set while NODE_ENV=production — refusing to start. It is a dev-only ' +
        'override that redirects Twilio REST calls to a fake host; production must use the real Twilio endpoint.',
    );
  }
  // Non-production: the value is used to redirect Twilio REST/media calls
  // (new URL(...) in adapters/messaging.ts). Validate it parses here so a
  // malformed override fails fast at config load instead of as a raw TypeError
  // at request time.
  if (twilioApiBaseUrl !== undefined && twilioApiBaseUrl.length > 0) {
    try {
      new URL(twilioApiBaseUrl);
    } catch {
      throw new Error(`TWILIO_API_BASE_URL must be a valid URL, got: ${twilioApiBaseUrl}`);
    }
  }

  // Dev-only S3 endpoint override (MinIO/local S3). MUST NOT be set in
  // production — same posture as TWILIO_API_BASE_URL above: prod must use the
  // real AWS S3 endpoint + instance-role credentials.
  const mediaS3Endpoint = env.MEDIA_S3_ENDPOINT?.trim();
  if (mediaS3Endpoint !== undefined && mediaS3Endpoint.length > 0 && nodeEnv === 'production') {
    throw new Error(
      'MEDIA_S3_ENDPOINT is set while NODE_ENV=production — refusing to start. It is a dev-only ' +
        'override for local S3-compatible storage (MinIO); production must use the real AWS S3 endpoint.',
    );
  }

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
  //
  // ALSO default ON when pointed at the LOCAL fake Twilio (twilioApiBaseUrl set):
  // the Twilio client is redirected to a mock host with no real account/numbers/
  // cost, so the fake's local provisioning REST is safe to exercise — this is the
  // hermetic dev/e2e mock stack (MESSAGING_DRIVER=twilio redirected to the fake).
  // This can NEVER engage in production: TWILIO_API_BASE_URL is rejected at boot
  // there (above), so twilioApiBaseUrl is undefined in any valid prod config.
  // Precedence: an EXPLICIT RELAY_LIVE_PROVISIONING (true OR false) always wins —
  // a deployer can still force provisioning off even in mock mode.
  const relayLiveProvisioningDefault =
    twilioApiBaseUrl !== undefined && twilioApiBaseUrl.length > 0 ? true : messagingDriver === 'console';
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

  // Relay number-RELEASE gate (D7 retirement). Simpler posture than the
  // provisioning kill-switch: default FALSE everywhere (no driver-based default)
  // so retirement stays OFF until ops explicitly enables it - only an exact
  // 'true' turns it on. A number release DELETEs it at Twilio, so the default
  // must never be permissive.
  const relayNumberReleaseEnabled = env.RELAY_NUMBER_RELEASE_ENABLED === 'true';

  // Outbound-SMS kill-switch (A2P) — same shape/posture as RELAY_LIVE_PROVISIONING:
  // default OFF on the deployed (twilio) stacks so NO real SMS is sent before A2P
  // approval (an unregistered-number send draws Twilio 30034 and hurts sender
  // reputation). Flip SMS_SENDING_ENABLED=true once A2P is approved. NOT
  // fail-fast: an unparseable value WARNs (a boolean flag, no PII) and uses the
  // default. true: 'true'|'1'|'yes'; false: 'false'|'0'|'no'.
  const smsSendingEnabledDefault = messagingDriver === 'console';
  let smsSendingEnabled = smsSendingEnabledDefault;
  const smsSendingEnabledRaw = env.SMS_SENDING_ENABLED;
  if (smsSendingEnabledRaw !== undefined && smsSendingEnabledRaw.trim().length > 0) {
    const normalized = smsSendingEnabledRaw.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      smsSendingEnabled = true;
    } else if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      smsSendingEnabled = false;
    } else {
      logger.warn(
        { default: smsSendingEnabledDefault },
        "SMS_SENDING_ENABLED is not one of true/1/yes/false/0/no — using the default",
      );
    }
  }

  // Conversation fact extraction (Phase 2). Default OFF when deployed
  // (NODE_ENV=production) so the feature stays dormant until the ai_extraction
  // table + ANTHROPIC_API_KEY are provisioned; ON for local NODE_ENVs so the
  // dev loop and e2e exercise the pipeline. Boolean parse mirrors
  // SMS_SENDING_ENABLED: true|1|yes / false|0|no, warn + default otherwise (a
  // boolean flag, no PII - never crash boot). Placed before the prod job/auth
  // gates so the extraction-specific throws below fire regardless of them.
  const aiExtractionEnabledDefault = nodeEnv !== 'production';
  let aiExtractionEnabled = aiExtractionEnabledDefault;
  const aiExtractionEnabledRaw = env.AI_EXTRACTION_ENABLED;
  if (aiExtractionEnabledRaw !== undefined && aiExtractionEnabledRaw.trim().length > 0) {
    const normalized = aiExtractionEnabledRaw.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      aiExtractionEnabled = true;
    } else if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      aiExtractionEnabled = false;
    } else {
      logger.warn(
        { default: aiExtractionEnabledDefault },
        'AI_EXTRACTION_ENABLED is not one of true/1/yes/false/0/no - using the default',
      );
    }
  }

  // Extraction driver: anthropic (real structured-output LLM) | console
  // (offline no-op) | fake (deterministic test seam). Default anthropic when
  // deployed, console for local NODE_ENVs. The fake driver is a TEST-ONLY seam
  // and is REFUSED in production (fail-closed) so a deployed stack can never
  // silently no-op extraction against the fake EXTRACT: protocol.
  const extractionDriverRaw = env.EXTRACTION_DRIVER ?? (nodeEnv === 'production' ? 'anthropic' : 'console');
  if (
    extractionDriverRaw !== 'anthropic' &&
    extractionDriverRaw !== 'console' &&
    extractionDriverRaw !== 'fake'
  ) {
    throw new Error(
      `EXTRACTION_DRIVER must be 'anthropic', 'console', or 'fake', got: ${extractionDriverRaw}`,
    );
  }
  if (extractionDriverRaw === 'fake' && nodeEnv === 'production') {
    throw new Error(
      'EXTRACTION_DRIVER=fake is a test-only seam and is refused while NODE_ENV=production - ' +
        'refusing to start. Use anthropic (real) or console (offline no-op) in a deployed stack.',
    );
  }
  const extractionDriver: 'anthropic' | 'console' | 'fake' = extractionDriverRaw;

  // Anthropic API key (operator secret). Required only when extraction is
  // ENABLED with the anthropic driver in production - mirror the
  // MESSAGING_DRIVER=twilio required-vars block: fail fast so a deployed stack
  // never runs enabled-but-keyless (every extraction run would 401 at runtime).
  const anthropicApiKey = env.ANTHROPIC_API_KEY;
  if (nodeEnv === 'production' && aiExtractionEnabled && extractionDriver === 'anthropic' && !anthropicApiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is required when NODE_ENV=production, AI_EXTRACTION_ENABLED=true, and ' +
        'EXTRACTION_DRIVER=anthropic - hydrate from Parameter Store (npm run secrets:push) or ' +
        'disable extraction (AI_EXTRACTION_ENABLED=false). Refusing to start without it.',
    );
  }

  // Dev-only override of the Anthropic REST base URL (a local mock host).
  // REJECTED in production (fail-closed) - same posture as TWILIO_API_BASE_URL:
  // deployed stacks must use the real Anthropic endpoint. Non-prod: validate it
  // parses so a malformed override fails fast at config load.
  const anthropicApiBaseUrl = env.ANTHROPIC_API_BASE_URL?.trim();
  if (anthropicApiBaseUrl !== undefined && anthropicApiBaseUrl.length > 0 && nodeEnv === 'production') {
    throw new Error(
      'ANTHROPIC_API_BASE_URL is set while NODE_ENV=production - refusing to start. It is a ' +
        'dev-only override that redirects Anthropic REST calls to a fake host; production must ' +
        'use the real Anthropic endpoint.',
    );
  }
  if (anthropicApiBaseUrl !== undefined && anthropicApiBaseUrl.length > 0) {
    try {
      new URL(anthropicApiBaseUrl);
    } catch {
      throw new Error(`ANTHROPIC_API_BASE_URL must be a valid URL, got: ${anthropicApiBaseUrl}`);
    }
  }

  // Extraction model knob (non-secret). Empty/unset falls back to our current
  // structured-output model.
  const aiExtractionModel = env.AI_EXTRACTION_MODEL?.trim() || 'claude-opus-4-8';

  // Sliding debounce window (ms) between an inbound text and its extraction
  // run. NOT fail-fast: a bad/missing value WARNs and falls back to 30000
  // (mirror A2P_RATE_LIMIT_PER_SEC; a debounce typo must never crash boot).
  // Must be a positive integer.
  const AI_EXTRACTION_DEBOUNCE_DEFAULT = 30_000;
  let aiExtractionDebounceMs = AI_EXTRACTION_DEBOUNCE_DEFAULT;
  if (env.AI_EXTRACTION_DEBOUNCE_MS !== undefined && env.AI_EXTRACTION_DEBOUNCE_MS.length > 0) {
    const parsed = Number(env.AI_EXTRACTION_DEBOUNCE_MS);
    if (Number.isInteger(parsed) && parsed > 0) {
      aiExtractionDebounceMs = parsed;
    } else {
      logger.warn(
        { value: env.AI_EXTRACTION_DEBOUNCE_MS, fallback: AI_EXTRACTION_DEBOUNCE_DEFAULT },
        'AI_EXTRACTION_DEBOUNCE_MS is not a positive integer - using the default',
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

  // Per-user rate limits on the authenticated send/call-cost routes (2026-07-02
  // hardening) — same fail-fast idiom as the public limiter above: safe code
  // defaults so nothing is required to boot; an explicitly-set bad value
  // refuses to start (a typo'd ceiling on a money-spending route must never
  // silently become "unlimited" or NaN).
  const rateLimitManualSendPerMin = Number(env.RATE_LIMIT_MANUAL_SEND_PER_MIN ?? 30);
  if (!Number.isInteger(rateLimitManualSendPerMin) || rateLimitManualSendPerMin <= 0) {
    throw new Error(
      `RATE_LIMIT_MANUAL_SEND_PER_MIN must be a positive integer, got: ${env.RATE_LIMIT_MANUAL_SEND_PER_MIN}`,
    );
  }
  const rateLimitBroadcastSendPerMin = Number(env.RATE_LIMIT_BROADCAST_SEND_PER_MIN ?? 5);
  if (!Number.isInteger(rateLimitBroadcastSendPerMin) || rateLimitBroadcastSendPerMin <= 0) {
    throw new Error(
      `RATE_LIMIT_BROADCAST_SEND_PER_MIN must be a positive integer, got: ${env.RATE_LIMIT_BROADCAST_SEND_PER_MIN}`,
    );
  }
  const rateLimitOriginatePerMin = Number(env.RATE_LIMIT_ORIGINATE_PER_MIN ?? 10);
  if (!Number.isInteger(rateLimitOriginatePerMin) || rateLimitOriginatePerMin <= 0) {
    throw new Error(
      `RATE_LIMIT_ORIGINATE_PER_MIN must be a positive integer, got: ${env.RATE_LIMIT_ORIGINATE_PER_MIN}`,
    );
  }
  const rateLimitVerifyStartMax = Number(env.RATE_LIMIT_VERIFY_START_MAX ?? 3);
  if (!Number.isInteger(rateLimitVerifyStartMax) || rateLimitVerifyStartMax <= 0) {
    throw new Error(
      `RATE_LIMIT_VERIFY_START_MAX must be a positive integer, got: ${env.RATE_LIMIT_VERIFY_START_MAX}`,
    );
  }
  const rateLimitVerifyStartWindowMs = Number(env.RATE_LIMIT_VERIFY_START_WINDOW_MS ?? 180_000);
  if (!Number.isInteger(rateLimitVerifyStartWindowMs) || rateLimitVerifyStartWindowMs <= 0) {
    throw new Error(
      `RATE_LIMIT_VERIFY_START_WINDOW_MS must be a positive integer (ms), got: ${env.RATE_LIMIT_VERIFY_START_WINDOW_MS}`,
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

  // Transcript reconcile delay (voice-transcription spec 3.4). Same NOT-fail-
  // fast idiom as A2P_RATE_LIMIT_PER_SEC above: transcription is a bolt-on
  // feature, so a bad value falls back to the 600s default instead of blocking
  // boot - but it must NEVER ride through raw (a negative value makes every
  // reconcile attempt run immediately, exhausting the retry cap and stamping
  // transcript_status=failed before VI ever completes; an explicit '0' is
  // equally invalid - there is no zero-delay reconcile). An explicitly-set-but-
  // invalid value WARNs so the operator notices the fallback.
  const VOICE_TRANSCRIPT_RECONCILE_DEFAULT = 600;
  let voiceTranscriptReconcileSeconds = VOICE_TRANSCRIPT_RECONCILE_DEFAULT;
  if (
    env.VOICE_TRANSCRIPT_RECONCILE_SECONDS !== undefined &&
    env.VOICE_TRANSCRIPT_RECONCILE_SECONDS.length > 0
  ) {
    const parsed = Number(env.VOICE_TRANSCRIPT_RECONCILE_SECONDS);
    if (Number.isFinite(parsed) && parsed > 0) {
      voiceTranscriptReconcileSeconds = parsed;
    } else {
      logger.warn(
        { value: env.VOICE_TRANSCRIPT_RECONCILE_SECONDS, fallback: VOICE_TRANSCRIPT_RECONCILE_DEFAULT },
        'VOICE_TRANSCRIPT_RECONCILE_SECONDS is not a positive number - using the default',
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
    devAuthEnabled,
    recordOutbox,
    port,
    logLevel: env.LOG_LEVEL ?? 'info',
    cfOriginSecret: cfOriginSecret ?? DEV_ORIGIN_SECRET_DEFAULT,
    otelSdkDisabled: (env.OTEL_SDK_DISABLED ?? '').toLowerCase() === 'true',
    awsRegion: env.AWS_REGION ?? 'us-east-1',
    appEnv,
    alarmNamePrefix,
    errorLogGroupName,
    workerLogGroupName,
    systemLogGroupName,
    dynamodbEndpoint: env.DYNAMODB_ENDPOINT,
    tablePrefix: env.TABLE_PREFIX ?? DEFAULT_TABLE_PREFIX,
    otelExporterOtlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    schedulerTargetArn: env.SCHEDULER_TARGET_ARN,
    schedulerRoleArn: env.SCHEDULER_ROLE_ARN,
    jobsQueueUrl: env.JOBS_QUEUE_URL,
    messagingDriver,
    relayLiveProvisioning,
    relayNumberReleaseEnabled,
    smsSendingEnabled,
    twilioAccountSid: env.TWILIO_ACCOUNT_SID,
    twilioApiKeySid: env.TWILIO_API_KEY_SID,
    twilioApiKeySecret: env.TWILIO_API_KEY_SECRET,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN,
    twilioMessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    twilioApiBaseUrl: twilioApiBaseUrl !== undefined && twilioApiBaseUrl.length > 0 ? twilioApiBaseUrl : undefined,
    twilioViServiceSid: env.TWILIO_VI_SERVICE_SID?.trim() || undefined,
    voiceTranscriptReconcileSeconds,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    sendBreakerMaxPerMinute,
    ourPhoneNumbers,
    mediaBucket: env.MEDIA_BUCKET,
    mediaS3Endpoint: mediaS3Endpoint !== undefined && mediaS3Endpoint.length > 0 ? mediaS3Endpoint : undefined,
    sseMaxConnections,
    publicRateLimitMax,
    publicRateLimitWindowMs,
    rateLimitManualSendPerMin,
    rateLimitBroadcastSendPerMin,
    rateLimitOriginatePerMin,
    rateLimitVerifyStartMax,
    rateLimitVerifyStartWindowMs,
    a2pRateLimitPerSec,
    sessionSecret: env.SESSION_SECRET ?? DEV_SESSION_SECRET_DEFAULT,
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    oauthAllowedDomains,
    dashboardDistDir: env.DASHBOARD_DIST_DIR,
    vapidPublicKey: env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: env.VAPID_PRIVATE_KEY,
    vapidSubject: vapidSubject !== undefined && vapidSubject.length > 0 ? vapidSubject : undefined,
    aiExtractionEnabled,
    extractionDriver,
    aiExtractionModel,
    aiExtractionDebounceMs,
    anthropicApiKey,
    anthropicApiBaseUrl:
      anthropicApiBaseUrl !== undefined && anthropicApiBaseUrl.length > 0 ? anthropicApiBaseUrl : undefined,
  };
}
