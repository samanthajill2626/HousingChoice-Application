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
      aiExtractionEnabled: true,
      aiExtractionDriver: 'console',
      aiExtractionModel: 'claude-opus-4-8',
      aiExtractionPromptFingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
      // The harness DOES configure a business number (BUSINESS_PHONE_NUMBER =
      // OUR_NUMBER), so the flags payload carries it. Our own published number
      // is not a contact's phone; see services/systemStatus.ts.
      businessPhoneNumber: '+15550009999',
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
      aiExtractionEnabled: true,
      aiExtractionDriver: 'console',
      aiExtractionModel: 'claude-opus-4-8',
      aiExtractionPromptFingerprint: '0123456789ab',
    }),
    getAlarms: async () => ({
      available: true,
      alarms: [{ name: 'hc-dev-5xx', state: 'ALARM', stateUpdatedAt: '2026-06-29T00:00:00.000Z' }],
    }),
    getErrors: vi.fn<SystemStatusService['getErrors']>(async () => ({
      available: true,
      events: [
        {
          timestamp: '2026-06-29T00:00:00.000Z',
          level: 50,
          message: 'boom',
          messageTruncated: false,
          correlationId: 'c1',
          errMessageTruncated: false,
          source: 'app',
          ref: 'PTR-R1',
        },
      ],
    })),
    getErrorDetail: async () => ({ available: false as const, reason: 'unavailable_local' as const }),
    getTrace: async () => ({ available: false as const, reason: 'unavailable_local' as const }),
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
      events: [
        {
          timestamp: '2026-06-29T00:00:00.000Z',
          level: 50,
          message: 'boom',
          messageTruncated: false,
          correlationId: 'c1',
          errMessageTruncated: false,
          source: 'app',
          ref: 'PTR-R1',
        },
      ],
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

describe('GET /api/system/errors/detail', () => {
  it('400s when ref is missing', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/system/errors/detail')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(400);
  });

  it('is admin-only', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/system/errors/detail?ref=AAAA')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(403);
  });

  it('degrades at 200 when a ref is present', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get(`/api/system/errors/detail?ref=${encodeURIComponent('A+B/C=')}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
  });

  it('hands the DECODED pointer to the service (+ and / survive the query)', async () => {
    const getErrorDetail = vi.fn<SystemStatusService['getErrorDetail']>(async () => ({
      available: false,
      reason: 'invalid_ref',
    }));
    const service: SystemStatusService = {
      getFlags: () => ({
        env: 'dev',
        smsSendingEnabled: false,
        relayLiveProvisioning: false,
        pushConfigured: true,
        messagingDriver: 'twilio',
        aiExtractionEnabled: true,
        aiExtractionDriver: 'console',
        aiExtractionModel: 'claude-opus-4-8',
        aiExtractionPromptFingerprint: '0123456789ab',
      }),
      getAlarms: async () => ({ available: false, reason: 'unavailable_local' }),
      getErrors: async () => ({ available: false, reason: 'unavailable_local' }),
      getErrorDetail,
      getTrace: async () => ({ available: false, reason: 'unavailable_local' }),
    };
    const { app } = makeWebhookHarness({ systemStatusService: service });
    const ref = 'CnAKMwo=+B/C';
    await request(app)
      .get(`/api/system/errors/detail?ref=${encodeURIComponent(ref)}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);
    expect(getErrorDetail).toHaveBeenCalledWith(ref);
  });
});

describe('GET /api/system/trace', () => {
  const auth = (r: request.Test) => r.set('x-origin-verify', SECRET).set('cookie', TEST_ADMIN_COOKIE);
  const AT = '2026-08-24T10:00:00.000Z';
  const UUID = '11111111-2222-4333-8444-555555555555';

  it('400s with no id, with several ids, and with a bad at', async () => {
    const { app } = makeWebhookHarness();
    expect((await auth(request(app).get(`/api/system/trace?at=${AT}`))).status).toBe(400);
    expect((await auth(request(app).get(`/api/system/trace?correlationId=${UUID}&requestId=${UUID}&at=${AT}`))).status).toBe(400);
    expect((await auth(request(app).get(`/api/system/trace?correlationId=${UUID}&at=nonsense`))).status).toBe(400);
  });

  it('400s on a NON-ISO date Date.parse would otherwise accept, so the 400 message stays true', async () => {
    const { app } = makeWebhookHarness();
    const res = await auth(request(app).get(`/api/system/trace?correlationId=${UUID}&at=1 Jan 2020`));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('ISO 8601');
  });

  it('400s when at is missing entirely - the anchor is REQUIRED, never defaulted', async () => {
    const { app } = makeWebhookHarness();
    expect((await auth(request(app).get(`/api/system/trace?correlationId=${UUID}`))).status).toBe(400);
  });

  it('returns 200 for a well-formed request', async () => {
    const { app } = makeWebhookHarness();
    const res = await auth(request(app).get(`/api/system/trace?correlationId=${UUID}&at=${AT}`));
    expect(res.status).toBe(200);
    // The hermetic harness is a local env, so it degrades at 200 (never a 500).
    expect(res.body.available).toBe(false);
  });

  it('is admin-only', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get(`/api/system/trace?correlationId=${UUID}&at=${AT}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(403);
  });

  it('hands the chosen kind, the id and the PARSED anchor to the service', async () => {
    const getTrace = vi.fn<SystemStatusService['getTrace']>(async () => ({
      available: false,
      reason: 'unavailable_local',
    }));
    const service: SystemStatusService = {
      getFlags: () => ({
        env: 'dev',
        smsSendingEnabled: false,
        relayLiveProvisioning: false,
        pushConfigured: true,
        messagingDriver: 'twilio',
        aiExtractionEnabled: true,
        aiExtractionDriver: 'console',
        aiExtractionModel: 'claude-opus-4-8',
        aiExtractionPromptFingerprint: '0123456789ab',
      }),
      getAlarms: async () => ({ available: false, reason: 'unavailable_local' }),
      getErrors: async () => ({ available: false, reason: 'unavailable_local' }),
      getErrorDetail: async () => ({ available: false, reason: 'unavailable_local' }),
      getTrace,
    };
    const { app } = makeWebhookHarness({ systemStatusService: service });
    await auth(request(app).get(`/api/system/trace?pollRunId=${UUID}&at=${AT}`));
    expect(getTrace).toHaveBeenCalledWith('pollRunId', UUID, Date.parse(AT));
  });
});
