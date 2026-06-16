// app/test/configTwilioApiBaseUrl.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';

const base = { CF_ORIGIN_SECRET: 's' };

describe('TWILIO_API_BASE_URL config', () => {
  it('is read in non-production', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development', TWILIO_API_BASE_URL: 'http://localhost:8889' });
    expect(cfg.twilioApiBaseUrl).toBe('http://localhost:8889');
  });

  it('defaults to undefined when unset', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development' });
    expect(cfg.twilioApiBaseUrl).toBeUndefined();
  });

  it('is REJECTED (throws) when set in production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', TWILIO_API_BASE_URL: 'http://evil', MESSAGING_DRIVER: 'console' }),
    ).toThrow(/TWILIO_API_BASE_URL/);
  });

  it('throws a clear error in non-production when set to a malformed URL', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'development', TWILIO_API_BASE_URL: 'not a url' }),
    ).toThrow(/TWILIO_API_BASE_URL must be a valid URL/);
  });

  it('prod-rejection fires even when the value is a malformed URL (prod check wins)', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', TWILIO_API_BASE_URL: 'not a url', MESSAGING_DRIVER: 'console' }),
    ).toThrow(/refusing to start/);
  });
});
