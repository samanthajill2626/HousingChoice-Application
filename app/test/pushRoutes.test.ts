// M1.4 unit tests: the /api/push/* routes —
//   GET    /api/push/vapid-public-key
//   POST   /api/push/subscriptions     { subscription }
//   DELETE /api/push/subscriptions     { endpoint }
//   POST   /api/push/test
// plus the 503 push_not_configured gate when VAPID is unset. Every route sits
// behind requireAuth (the /api mount) — the suites ride a real sealed session
// cookie + the origin secret.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  TEST_SESSION_COOKIE,
  TEST_SESSION_USER,
} from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;

const VAPID_ENV = {
  VAPID_PUBLIC_KEY: 'BPublicKeyPlaceholderForTestsOnly',
  VAPID_PRIVATE_KEY: 'privateKeyPlaceholderForTestsOnly',
  VAPID_SUBJECT: 'mailto:ops@housingchoice.org',
};

// A real-shaped FCM endpoint (an allowlisted web-push vendor host — C1).
const FCM_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-1';

function validSubscription(endpoint = FCM_ENDPOINT) {
  return { endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } };
}

describe('push routes — VAPID configured', () => {
  it('GET /api/push/vapid-public-key returns the public key', async () => {
    const { app } = makeWebhookHarness({ env: VAPID_ENV });
    const res = await request(app)
      .get('/api/push/vapid-public-key')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ publicKey: VAPID_ENV.VAPID_PUBLIC_KEY });
  });

  it('POST /api/push/subscriptions stores the subscription on the caller and 201s', async () => {
    const { app, fakeUsers } = makeWebhookHarness({ env: VAPID_ENV });
    const res = await request(app)
      .post('/api/push/subscriptions')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ subscription: validSubscription() });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ subscriptionCount: 1 });
    const user = fakeUsers.users.get(TEST_SESSION_USER.userId);
    expect(user?.push_subscriptions?.[0]?.endpoint).toBe(FCM_ENDPOINT);
    // created_at is stamped server-side.
    expect(typeof user?.push_subscriptions?.[0]?.created_at).toBe('string');
  });

  it('POST /api/push/subscriptions dedupes by endpoint (re-subscribe = same count)', async () => {
    const { app, fakeUsers } = makeWebhookHarness({ env: VAPID_ENV });
    for (let i = 0; i < 2; i++) {
      await request(app)
        .post('/api/push/subscriptions')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ subscription: validSubscription() });
    }
    expect(fakeUsers.users.get(TEST_SESSION_USER.userId)?.push_subscriptions).toHaveLength(1);
  });

  it('POST /api/push/subscriptions 400s a malformed subscription', async () => {
    const { app } = makeWebhookHarness({ env: VAPID_ENV });
    for (const bad of [
      {},
      { subscription: {} },
      { subscription: { endpoint: 'https://x', keys: {} } },
      { subscription: { endpoint: 'ftp://not-https', keys: { p256dh: 'a', auth: 'b' } } },
      { subscription: { endpoint: 'https://x', keys: { p256dh: 'a' } } },
    ]) {
      const res = await request(app)
        .post('/api/push/subscriptions')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('POST /api/push/subscriptions 400s a disallowed endpoint host (C1 SSRF guard)', async () => {
    const { app, fakeUsers } = makeWebhookHarness({ env: VAPID_ENV });
    for (const endpoint of [
      'https://169.254.169.254/latest/meta-data/', // cloud metadata
      'https://localhost/x',
      'https://10.0.0.5/x', // RFC-1918
      'https://attacker.example.com/collect', // arbitrary host
      'http://fcm.googleapis.com/fcm/send/abc', // right host, wrong scheme
    ]) {
      const res = await request(app)
        .post('/api/push/subscriptions')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ subscription: validSubscription(endpoint) });
      expect(res.status, endpoint).toBe(400);
      expect(res.body.error, endpoint).toBe('invalid push endpoint host');
    }
    // Nothing was stored on the caller.
    expect(fakeUsers.users.get(TEST_SESSION_USER.userId)?.push_subscriptions ?? []).toEqual([]);
  });

  it('POST /api/push/subscriptions 400s an over-length endpoint or key (L2 caps)', async () => {
    const { app } = makeWebhookHarness({ env: VAPID_ENV });
    const longEndpoint = `https://fcm.googleapis.com/fcm/send/${'a'.repeat(2100)}`;
    const longKey = 'k'.repeat(300);
    for (const sub of [
      { endpoint: longEndpoint, keys: { p256dh: 'a', auth: 'b' } },
      { endpoint: FCM_ENDPOINT, keys: { p256dh: longKey, auth: 'b' } },
      { endpoint: FCM_ENDPOINT, keys: { p256dh: 'a', auth: longKey } },
    ]) {
      const res = await request(app)
        .post('/api/push/subscriptions')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ subscription: sub });
      expect(res.status, JSON.stringify(sub).slice(0, 60)).toBe(400);
      expect(res.body.error).toMatch(/length/);
    }
  });

  it('DELETE /api/push/subscriptions removes one device and 204s', async () => {
    const { app, fakeUsers } = makeWebhookHarness({ env: VAPID_ENV });
    const deviceEndpoint = 'https://fcm.googleapis.com/fcm/send/d';
    await request(app)
      .post('/api/push/subscriptions')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ subscription: validSubscription(deviceEndpoint) });

    const res = await request(app)
      .delete('/api/push/subscriptions')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ endpoint: deviceEndpoint });

    expect(res.status).toBe(204);
    expect(fakeUsers.users.get(TEST_SESSION_USER.userId)?.push_subscriptions).toEqual([]);
  });

  it('DELETE /api/push/subscriptions 400s a missing endpoint', async () => {
    const { app } = makeWebhookHarness({ env: VAPID_ENV });
    const res = await request(app)
      .delete('/api/push/subscriptions')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/push/test reports the per-call tally (no devices = zeroed)', async () => {
    const { app } = makeWebhookHarness({ env: VAPID_ENV });
    const res = await request(app)
      .post('/api/push/test')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: true, attempted: 0, sent: 0 });
  });
});

describe('push routes — VAPID unconfigured', () => {
  it('every push route 503s push_not_configured', async () => {
    // No VAPID_* in env → push off.
    const { app } = makeWebhookHarness();
    const calls = [
      request(app).get('/api/push/vapid-public-key'),
      request(app).post('/api/push/subscriptions').send({ subscription: validSubscription() }),
      request(app).delete('/api/push/subscriptions').send({ endpoint: 'https://x' }),
      request(app).post('/api/push/test').send({}),
    ];
    for (const call of calls) {
      const res = await call.set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'push_not_configured' });
    }
  });
});

describe('push routes — auth', () => {
  it('401s without a session cookie (the /api requireAuth gate)', async () => {
    const { app } = makeWebhookHarness({ env: VAPID_ENV });
    const res = await request(app)
      .get('/api/push/vapid-public-key')
      .set('x-origin-verify', SECRET);
    expect(res.status).toBe(401);
  });
});
