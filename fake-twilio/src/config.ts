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
}

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
  return {
    port: Number(env.FAKE_TWILIO_PORT ?? 8889),
    appBaseUrl: appBaseUrl.replace(/\/$/, ''),
    appPublicBaseUrl: appPublicBaseUrl.replace(/\/$/, ''),
    authToken,
  };
}
