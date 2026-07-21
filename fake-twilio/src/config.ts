// Typed config for the fake-twilio standalone service. Dev/test only — the
// service must NEVER run in production (it impersonates Twilio).
export interface FakeTwilioConfig {
  /** Port the fake REST + control API listens on. */
  port: number;
  /** Where to POST webhooks (the app's real address, e.g. http://localhost:8080). */
  appBaseUrl: string;
  /** The value of the app's PUBLIC_BASE_URL — used to compute the signed URL the
   *  app's signature middleware will reconstruct. May differ from appBaseUrl. */
  appPublicBaseUrl: string;
  /** Shared Twilio auth token used to sign webhooks (must match the app's). */
  authToken: string;
  /**
   * Origin-secret the hermetic app expects in the `x-origin-verify` header. The
   * app's locked middleware chain runs the CloudFront origin-secret validator
   * BEFORE the /webhooks routes (app/src/app.ts), so the dispatcher's webhook
   * POSTs are rejected with 403 unless they carry this exact value. Read from
   * CF_ORIGIN_SECRET; defaults to the dev placeholder the app's config and the
   * Vite proxy both use (dev-placeholder-not-a-secret).
   */
  originSecret: string;
  /** Absolute path to the built fake-phones UI (FAKE_TWILIO_UI_DIST). When set, the
   *  host static-serves it with a SPA fallback. Dev/e2e only; unset → no UI served. */
  uiDistDir?: string;
  /**
   * The fake's OWN externally-reachable base URL — the SAME origin the app is
   * pointed at via TWILIO_API_BASE_URL (e.g. http://localhost:8889). The CallEngine
   * mints recording URLs (`${publicBaseUrl}/recordings/${callSid}/${recordingSid}.mp3`)
   * from this, and the recording-serve route lives at the same origin, so the app's
   * Phase-1 SSRF dev-override (which accepts a recording URL only when its origin ===
   * the app's twilioApiBaseUrl origin) resolves the fetch back here. Derived from
   * FAKE_TWILIO_PUBLIC_URL when set, else `http://localhost:${port}` — kept in lock-step
   * with the app's TWILIO_API_BASE_URL so it can't drift.
   */
  publicBaseUrl: string;
  /**
   * The Voice Intelligence service sid (GA...) the app is configured with
   * (TWILIO_VI_SERVICE_SID). The fake's POST /v2/Transcripts route validates the
   * ServiceSid form field against this so a create for the wrong service is rejected.
   * Defaults to the dev/e2e value 'GAfakeservice' (scripts/dev.mjs + e2e wiring set
   * the SAME value on the app), so the two agree without extra plumbing.
   */
  viServiceSid: string;
  /**
   * Inbound-email (email-channel B4): the MinIO bucket the fake writes raw inbound
   * MIME to (INBOUND_MAIL_BUCKET, the SES receipt-rule S3 target) + the shared MinIO
   * endpoint (MEDIA_S3_ENDPOINT). Both come from the SAME childEnv the app/worker
   * see. Unset when the inbound path is not exercised.
   */
  inboundMailBucket?: string;
  mediaS3Endpoint?: string;
}

/** The app's local CF_ORIGIN_SECRET default (app/src/lib/config.ts) + the value
 *  the Vite proxy injects (dashboard/vite.config.ts). Webhook POSTs must match it. */
const DEV_ORIGIN_SECRET_DEFAULT = 'dev-placeholder-not-a-secret';

export function loadFakeConfig(env: NodeJS.ProcessEnv = process.env): FakeTwilioConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production') {
    throw new Error(
      'fake-twilio refuses to start while NODE_ENV=production — it impersonates Twilio and must ' +
        'never run in a deployed environment.',
    );
  }
  const appBaseUrl = env.APP_BASE_URL ?? 'http://localhost:8080';
  const appPublicBaseUrl = env.APP_PUBLIC_BASE_URL ?? appBaseUrl;
  const authToken = env.TWILIO_AUTH_TOKEN ?? '';
  const originSecret = env.CF_ORIGIN_SECRET ?? DEV_ORIGIN_SECRET_DEFAULT;
  const port = Number(env.FAKE_TWILIO_PORT ?? 8889);
  // The fake's own public origin = what the app uses as TWILIO_API_BASE_URL. Default
  // to localhost:<port> (the e2e/dev wiring sets both to :8889); FAKE_TWILIO_PUBLIC_URL
  // overrides when the app reaches the fake at a different host (e.g. 127.0.0.1).
  const publicBaseUrl = (env.FAKE_TWILIO_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
  const viServiceSid = env.TWILIO_VI_SERVICE_SID?.trim() || 'GAfakeservice';
  return {
    port,
    appBaseUrl: appBaseUrl.replace(/\/$/, ''),
    appPublicBaseUrl: appPublicBaseUrl.replace(/\/$/, ''),
    authToken,
    originSecret,
    publicBaseUrl,
    viServiceSid,
    ...(env.FAKE_TWILIO_UI_DIST ? { uiDistDir: env.FAKE_TWILIO_UI_DIST } : {}),
    ...(env.INBOUND_MAIL_BUCKET ? { inboundMailBucket: env.INBOUND_MAIL_BUCKET } : {}),
    ...(env.MEDIA_S3_ENDPOINT ? { mediaS3Endpoint: env.MEDIA_S3_ENDPOINT } : {}),
  };
}
