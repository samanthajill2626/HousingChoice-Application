import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';

function cfg(env: Record<string, string> = {}) {
  return loadFakeConfig({
    NODE_ENV: 'test',
    FAKE_TWILIO_PORT: '8889',
    APP_BASE_URL: 'http://localhost:8080',
    APP_PUBLIC_BASE_URL: 'http://localhost:5173',
    TWILIO_AUTH_TOKEN: 'test-token',
    ...env,
  });
}

describe('fake-twilio host', () => {
  it('responds 200 on GET /health', async () => {
    const app = buildFakeTwilioApp({ config: cfg() });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: 'fake-twilio' });
  });

  it('loadFakeConfig throws when NODE_ENV=production', () => {
    expect(() => cfg({ NODE_ENV: 'production' })).toThrow(/production/i);
  });
});
