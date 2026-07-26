// app/test/configTwilioEventsWebhookSecret.test.ts
//
// relay-number-buying (security): the Event Streams promotion webhook is the SOLE
// warming->active gate and its shared-secret auth SKIPS when the secret is unset
// (so the hermetic fake sink can POST without it). A REAL deployed twilio stack
// that forgets TWILIO_EVENTS_WEBHOOK_SECRET would therefore fail OPEN - a forged
// registration event could promote an unregistered number (a real 30034). So boot
// MUST throw when messagingDriver==='twilio' AND we are NOT in mock mode
// (TWILIO_API_BASE_URL unset), while the mock/hermetic stack and the console driver
// stay exempt.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';

// A real (non-mock) twilio config: all TWILIO_* set, NO TWILIO_API_BASE_URL. This
// is the deployed shape the secret must guard.
const REAL_TWILIO = {
  NODE_ENV: 'test',
  MESSAGING_DRIVER: 'twilio',
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_API_KEY_SID: 'SKtest',
  TWILIO_API_KEY_SECRET: 'secret',
  TWILIO_AUTH_TOKEN: 'token',
  TWILIO_MESSAGING_SERVICE_SID: 'MGtest',
};

describe('TWILIO_EVENTS_WEBHOOK_SECRET boot gate', () => {
  it('throws when messagingDriver=twilio (real, no mock) and the secret is absent', () => {
    expect(() => loadConfig(REAL_TWILIO)).toThrow(/TWILIO_EVENTS_WEBHOOK_SECRET/);
  });

  it('boots when the secret is present', () => {
    const cfg = loadConfig({ ...REAL_TWILIO, TWILIO_EVENTS_WEBHOOK_SECRET: 'evsecret' });
    expect(cfg.twilioEventsWebhookSecret).toBe('evsecret');
  });

  it('does NOT require the secret for the console driver', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', MESSAGING_DRIVER: 'console' }),
    ).not.toThrow();
  });

  it('exempts the hermetic mock stack (twilio driver + TWILIO_API_BASE_URL, no secret)', () => {
    expect(() =>
      loadConfig({
        ...REAL_TWILIO,
        NODE_ENV: 'development',
        TWILIO_API_BASE_URL: 'http://localhost:8889',
      }),
    ).not.toThrow();
  });

  it('still reports the missing TWILIO_* values first (that gate runs before the secret gate)', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', MESSAGING_DRIVER: 'twilio' })).toThrow(
      /TWILIO_ACCOUNT_SID/,
    );
  });
});
