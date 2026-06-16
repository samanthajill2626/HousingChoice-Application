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
  return {
    port: Number(env.FAKE_TWILIO_PORT ?? 8889),
    appBaseUrl: appBaseUrl.replace(/\/$/, ''),
    appPublicBaseUrl: appPublicBaseUrl.replace(/\/$/, ''),
    authToken,
    originSecret,
    ...(env.FAKE_TWILIO_UI_DIST ? { uiDistDir: env.FAKE_TWILIO_UI_DIST } : {}),
  };
}
