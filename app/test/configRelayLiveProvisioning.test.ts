// app/test/configRelayLiveProvisioning.test.ts
//
// relayLiveProvisioning resolution precedence (fake-twilio Voice change):
//   1. RELAY_LIVE_PROVISIONING explicitly set  -> honor that boolean (true AND false)
//   2. else twilioApiBaseUrl configured (mock) -> default true
//   3. else                                    -> messagingDriver === 'console'
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';

const base = { CF_ORIGIN_SECRET: 's' };

// A fully-valid production env (clears every fail-fast gate). Note: a valid prod
// config can NEVER carry TWILIO_API_BASE_URL — it is rejected at boot — so this
// is the only legitimate prod shape with the twilio driver.
const prodBase = {
  NODE_ENV: 'production',
  CF_ORIGIN_SECRET: 's',
  MESSAGING_DRIVER: 'twilio',
  JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/hc-test-jobs',
  SCHEDULER_TARGET_ARN: 'arn:aws:sqs:us-east-1:000000000000:hc-test-jobs',
  SCHEDULER_ROLE_ARN: 'arn:aws:iam::000000000000:role/hc-test-scheduler',
  SESSION_SECRET: 'prod-session-secret',
  GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'csecret',
  OAUTH_ALLOWED_DOMAINS: 'housingchoice.org',
  TWILIO_ACCOUNT_SID: 'ACxxx',
  TWILIO_API_KEY_SID: 'SKxxx',
  TWILIO_API_KEY_SECRET: 'secret',
  TWILIO_AUTH_TOKEN: 'token',
  TWILIO_MESSAGING_SERVICE_SID: 'MGxxx',
  OUR_PHONE_NUMBERS: '+15555550100',
};

describe('relayLiveProvisioning resolution', () => {
  it('auto-enables in mock mode (twilio driver + TWILIO_API_BASE_URL, RELAY_LIVE_PROVISIONING unset)', () => {
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'development',
      MESSAGING_DRIVER: 'twilio',
      TWILIO_API_BASE_URL: 'http://localhost:8889',
      TWILIO_ACCOUNT_SID: 'ACxxx',
      TWILIO_API_KEY_SID: 'SKxxx',
      TWILIO_API_KEY_SECRET: 'secret',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_MESSAGING_SERVICE_SID: 'MGxxx',
    });
    expect(cfg.relayLiveProvisioning).toBe(true);
  });

  it('explicit false wins even in mock mode', () => {
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'development',
      MESSAGING_DRIVER: 'twilio',
      TWILIO_API_BASE_URL: 'http://localhost:8889',
      RELAY_LIVE_PROVISIONING: 'false',
      TWILIO_ACCOUNT_SID: 'ACxxx',
      TWILIO_API_KEY_SID: 'SKxxx',
      TWILIO_API_KEY_SECRET: 'secret',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_MESSAGING_SERVICE_SID: 'MGxxx',
    });
    expect(cfg.relayLiveProvisioning).toBe(false);
  });

  it('explicit true is honored without mock mode (twilio driver, no TWILIO_API_BASE_URL)', () => {
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'development',
      MESSAGING_DRIVER: 'twilio',
      RELAY_LIVE_PROVISIONING: 'true',
      TWILIO_ACCOUNT_SID: 'ACxxx',
      TWILIO_API_KEY_SID: 'SKxxx',
      TWILIO_API_KEY_SECRET: 'secret',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_MESSAGING_SERVICE_SID: 'MGxxx',
    });
    expect(cfg.relayLiveProvisioning).toBe(true);
  });

  it('preserves the existing default: twilio driver, no mock, unset => false', () => {
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'development',
      MESSAGING_DRIVER: 'twilio',
      TWILIO_ACCOUNT_SID: 'ACxxx',
      TWILIO_API_KEY_SID: 'SKxxx',
      TWILIO_API_KEY_SECRET: 'secret',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_MESSAGING_SERVICE_SID: 'MGxxx',
    });
    expect(cfg.relayLiveProvisioning).toBe(false);
  });

  it('preserves the existing default: console driver, nothing else => true', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development', MESSAGING_DRIVER: 'console' });
    expect(cfg.relayLiveProvisioning).toBe(true);
  });

  it('prod-safety: a valid production config (no TWILIO_API_BASE_URL) keeps relayLiveProvisioning false', () => {
    const cfg = loadConfig(prodBase);
    expect(cfg.relayLiveProvisioning).toBe(false);
  });
});
