// M1.4 System Status routes (routes/system.ts) via supertest —
//   GET /api/system/flags
//   GET /api/system/alarms
//   GET /api/system/errors?since=1h|24h|7d
// Every route is admin-only (requireRole('admin')): a VA gets 403 on ALL three,
// no session → 401, an admin → 200. The hermetic harness (console driver) makes
// alarms/errors DEGRADE to { available:false, reason } at HTTP 200; flags always
// load. A fake service drives the available:true shape and the `since` plumbing.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { TEST_ADMIN_COOKIE, TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';
import { type SystemStatusService } from '../src/services/systemStatus.js';

const SECRET = ORIGIN_SECRET;
const PATHS = ['/api/system/flags', '/api/system/alarms', '/api/system/errors'] as const;

describe('GET /api/system/* — admin-only gating', () => {
  it('a VA is forbidden (403) on ALL three routes', async () => {
    const { app } = makeWebhookHarness();
    for (const path of PATHS) {
      const res = await request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
      expect(res.status, path).toBe(403);
    }
  });

  it('no session → 401 on ALL three routes', async () => {
    const { app } = makeWebhookHarness();
    for (const path of PATHS) {
      const res = await request(app).get(path).set('x-origin-verify', SECRET);
      expect(res.status, path).toBe(401);
    }
  });

  it('an admin gets 200 on ALL three routes', async () => {
    const { app } = makeWebhookHarness();
    for (const path of PATHS) {
      const res = await request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_ADMIN_COOKIE);
      expect(res.status, path).toBe(200);
    }
  });
});

describe('GET /api/system/flags', () => {
  it('returns the go-live flags from runtime config (booleans/enums/strings — no secret)', async () => {
    // The hermetic harness uses the console driver, so the A2P kill-switches
    // DEFAULT on locally; env resolves to local.
    const { app } = makeWebhookHarness();
    const res = await request(app).get('/api/system/flags').set('x-origin-verify', SECRET).set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      env: 'local',
      smsSendingEnabled: true,
      relayLiveProvisioning: true,
      pushConfigured: false,
      messagingDriver: 'console',
    });
  });
});

describe('GET /api/system/alarms + /errors — degraded shape on the hermetic stack', () => {
  it('alarms degrade to { available:false, reason } at HTTP 200', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app).get('/api/system/alarms').set('x-origin-verify', SECRET).set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, reason: 'unavailable_local' });
  });

  it('errors degrade to { available:false, reason } at HTTP 200', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app).get('/api/system/errors').set('x-origin-verify', SECRET).set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, reason: 'unavailable_local' });
  });
});

describe('GET /api/system/errors — ?since validation', () => {
  it('a bogus since → 400', async () => {
    const { app } = makeWebhookHarness();
    for (const bad of ['bogus', '2h', '30d', '']) {
      const res = await request(app)
        .get(`/api/system/errors?since=${encodeURIComponent(bad)}`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_ADMIN_COOKIE);
      expect(res.status, bad).toBe(400);
    }
  });

  it('the valid windows 1h/24h/7d → 200', async () => {
    const { app } = makeWebhookHarness();
    for (const ok of ['1h', '24h', '7d']) {
      const res = await request(app)
        .get(`/api/system/errors?since=${ok}`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_ADMIN_COOKIE);
      expect(res.status, ok).toBe(200);
    }
  });

  it('no since → 200 (defaults to 24h)', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app).get('/api/system/errors').set('x-origin-verify', SECRET).set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/system/* — available:true shape via an injected fake service', () => {
  const fakeService: SystemStatusService = {
    getFlags: () => ({
      env: 'dev',
      smsSendingEnabled: false,
      relayLiveProvisioning: false,
      pushConfigured: true,
      messagingDriver: 'twilio',
    }),
    getAlarms: async () => ({
      available: true,
      alarms: [{ name: 'hc-dev-5xx', state: 'ALARM', stateUpdatedAt: '2026-06-29T00:00:00.000Z' }],
    }),
    getErrors: vi.fn<SystemStatusService['getErrors']>(async () => ({
      available: true,
      events: [{ timestamp: '2026-06-29T00:00:00.000Z', level: 50, message: 'boom', correlationId: 'c1' }],
    })),
  };

  it('alarms returns { available:true, alarms } from the service', async () => {
    const { app } = makeWebhookHarness({ systemStatusService: fakeService });
    const res = await request(app).get('/api/system/alarms').set('x-origin-verify', SECRET).set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      available: true,
      alarms: [{ name: 'hc-dev-5xx', state: 'ALARM', stateUpdatedAt: '2026-06-29T00:00:00.000Z' }],
    });
  });

  it('errors returns { available:true, events } and passes the ?since window to the service', async () => {
    const getErrors = fakeService.getErrors as ReturnType<typeof vi.fn>;
    getErrors.mockClear();
    const { app } = makeWebhookHarness({ systemStatusService: fakeService });
    const res = await request(app)
      .get('/api/system/errors?since=7d')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      available: true,
      events: [{ timestamp: '2026-06-29T00:00:00.000Z', level: 50, message: 'boom', correlationId: 'c1' }],
    });
    expect(getErrors).toHaveBeenCalledWith('7d', { includeWarnings: false });
  });

  it('passes ?warnings=true through as includeWarnings (default off otherwise)', async () => {
    const getErrors = fakeService.getErrors as ReturnType<typeof vi.fn>;
    const { app } = makeWebhookHarness({ systemStatusService: fakeService });

    getErrors.mockClear();
    await request(app)
      .get('/api/system/errors?since=24h&warnings=true')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);
    expect(getErrors).toHaveBeenCalledWith('24h', { includeWarnings: true });

    getErrors.mockClear();
    await request(app)
      .get('/api/system/errors?since=24h')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);
    expect(getErrors).toHaveBeenCalledWith('24h', { includeWarnings: false });
  });
});
