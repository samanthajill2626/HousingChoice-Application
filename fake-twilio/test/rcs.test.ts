// Task 7.2: RCS 501 seams. RCS is NOT wired in this fake — these are thin seams
// that return 501 with a JSON pointer to the integration contract, so a future
// RCS build has an explicit on-ramp instead of a silent 404. NO engine logic.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';

function makeApp() {
  const config = loadFakeConfig({
    NODE_ENV: 'test',
    TWILIO_AUTH_TOKEN: 't',
    APP_BASE_URL: 'http://localhost:8080',
    APP_PUBLIC_BASE_URL: 'http://localhost:5173',
  });
  return buildFakeTwilioApp({ config });
}

describe('RCS 501 seams (Task 7.2)', () => {
  it('the RCS Content API REST path → 501 with an rcs-not-wired body', async () => {
    const app = makeApp();
    const res = await request(app).post('/v1/Content').send({ FriendlyName: 'card' });
    expect(res.status).toBe(501);
    expect(JSON.stringify(res.body)).toMatch(/rcs-not-wired/i);
  });

  it('POST /control/send-rcs → 501 pointing at the integration contract', async () => {
    const app = makeApp();
    const res = await request(app).post('/control/send-rcs').send({ to: '+15550100001', contentSid: 'HXabc' });
    expect(res.status).toBe(501);
    expect(res.body.error).toMatch(/RCS not implemented/i);
    expect(res.body.see).toMatch(/RCS-integration-contract/);
  });
});
