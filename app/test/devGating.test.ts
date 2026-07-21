import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { maybeLoadDevRouter } from '../src/lib/devRoutes.js';
import { SESSION_COOKIE_NAME } from '../src/lib/sessionCookie.js';
import { createDevRouter } from '../src/routes/dev.js';
import { userIdForEmail, type UserItem, type UsersRepo } from '../src/repos/usersRepo.js';
import { createSendMessageService } from '../src/services/sendMessage.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, makeWebhookHarness, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { resolveMessage } from '../src/messages/index.js';

const SECRET = 'test-origin-secret';

function setCookieValue(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const header = res.headers['set-cookie'] as string[] | undefined;
  const line = header?.find((c) => c.startsWith(`${name}=`));
  return line ? line.split(';')[0]?.slice(name.length + 1) : undefined;
}

describe('dev gating — config', () => {
  it('fails fast when DEV_AUTH_ENABLED is truthy in production', () => {
    for (const v of ['true', '1', 'yes', 'TRUE', 'Yes']) {
      expect(() =>
        loadConfig({ NODE_ENV: 'production', DEV_AUTH_ENABLED: v }),
      ).toThrow(/DEV_AUTH_ENABLED/);
    }
  });

  it('parses truthy DEV_AUTH_ENABLED values outside production', () => {
    for (const v of ['true', '1', 'yes', 'TRUE', 'Yes']) {
      const cfg = loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: v, CF_ORIGIN_SECRET: SECRET });
      expect(cfg.devAuthEnabled).toBe(true);
    }
  });

  it('defaults devAuthEnabled to false when unset or falsey', () => {
    expect(loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }).devAuthEnabled).toBe(false);
    expect(
      loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: 'false', CF_ORIGIN_SECRET: SECRET }).devAuthEnabled,
    ).toBe(false);
  });

  it('parses MESSAGING_RECORD_OUTBOX truthy values outside production', () => {
    for (const v of ['true', '1', 'yes', 'TRUE']) {
      expect(
        loadConfig({ NODE_ENV: 'test', MESSAGING_RECORD_OUTBOX: v, CF_ORIGIN_SECRET: SECRET }).recordOutbox,
      ).toBe(true);
    }
    expect(loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }).recordOutbox).toBe(false);
  });

  it('fails fast when MESSAGING_RECORD_OUTBOX is set in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', MESSAGING_RECORD_OUTBOX: '1' }),
    ).toThrow(/MESSAGING_RECORD_OUTBOX/);
  });
});

describe('dev gating — router', () => {
  const enabled = () => loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: '1', CF_ORIGIN_SECRET: SECRET, DYNAMODB_ENDPOINT: 'http://localhost:8000' });
  const disabled = () => loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET });

  it('maybeLoadDevRouter returns a router only when the flag is set', async () => {
    expect(await maybeLoadDevRouter(enabled())).toBeDefined();
    expect(await maybeLoadDevRouter(disabled())).toBeUndefined();
  });

  it('does not mount the dev router without a local DynamoDB endpoint', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: '1', CF_ORIGIN_SECRET: SECRET });
    expect(await maybeLoadDevRouter(config)).toBeUndefined();
  });

  it('mounts /__dev/ping when the dev router is present (and echoes hermetic config flags)', async () => {
    const config = enabled();
    const app = buildApp({ config, devRouter: await maybeLoadDevRouter(config) });
    const res = await request(app).get('/__dev/ping');
    expect(res.status).toBe(200);
    // The e2e preflight (e2e/support/preflight.ts) asserts on these flags to
    // detect a stale/misconfigured reused stack — keep them on the response.
    expect(res.body).toEqual({
      dev: true,
      recordOutbox: config.recordOutbox,
      messagingDriver: config.messagingDriver,
      smsSendingEnabled: config.smsSendingEnabled,
      emailDriver: config.emailDriver,
      emailSendingEnabled: config.emailSendingEnabled,
      tablePrefix: config.tablePrefix,
      // The preflight's stale-stack freshness guard reads this (launch commit,
      // stamped by scripts/e2e-session.mjs); null when unstamped, as in this test.
      appCommit: process.env['E2E_APP_COMMIT'] ?? null,
    });
  });

  it('does NOT expose /__dev/ping when the dev router is absent', async () => {
    const app = buildApp({ config: disabled() });
    const res = await request(app).get('/__dev/ping');
    expect(res.status).toBe(404);
  });
});

describe('dev gating — SPA fallback reservation', () => {
  it('reserves /__dev under a configured dist dir: non-dev SPA routes get index.html, /__dev/ping gets 404', async () => {
    // Create a temporary dist directory with an index.html so the SPA fallback activates.
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-test-dist-'));
    try {
      fs.writeFileSync(path.join(distDir, 'index.html'), '<html><body>SPA</body></html>');

      const config = loadConfig({
        NODE_ENV: 'test',
        CF_ORIGIN_SECRET: SECRET,
        DASHBOARD_DIST_DIR: distDir,
        // No DEV_AUTH_ENABLED — no devRouter
      });
      const app = buildApp({ config });

      // Control: a non-reserved GET should be served by the SPA fallback (200, index.html).
      const spaRes = await request(app)
        .get('/some-spa-route')
        .set('x-origin-verify', SECRET);
      expect(spaRes.status).toBe(200);
      expect(spaRes.text).toContain('SPA');

      // Assertion: /__dev/ping must NOT fall through to the SPA fallback — it is reserved.
      const devRes = await request(app)
        .get('/__dev/ping')
        .set('x-origin-verify', SECRET);
      expect(devRes.status).toBe(404);
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });
});

describe('dev gating — /auth/dev-login', () => {
  const VA = 'va@example.com';
  const vaUser: UserItem = {
    userId: userIdForEmail(VA),
    email: VA,
    role: 'va',
    created_at: '2026-06-01T00:00:00.000Z',
    session_epoch: 1,
  };
  // In-memory fake mirroring the real repo's lifecycle: dev-login uses
  // findByEmail (and invite() to auto-provision a missing user); the
  // sessionMiddleware (on /auth/me) uses findById for the epoch check. The
  // store starts pre-seeded with the VA so the "user already exists" path is
  // exercised without an invite, and unknown emails fall through to invite().
  const makeUsersRepo = () => {
    const store = new Map<string, UserItem>([[vaUser.userId, vaUser]]);
    return {
      findByEmail: async (email: string) => {
        const norm = email.trim().toLowerCase();
        return [...store.values()].find((u) => u.email === norm);
      },
      findById: async (userId: string) => store.get(userId),
      invite: async ({ email, role }: { email: string; role: UserItem['role'] }) => {
        const norm = email.trim().toLowerCase();
        const userId = userIdForEmail(norm);
        const existing = store.get(userId);
        if (existing) return { created: false, user: existing };
        const user: UserItem = {
          userId,
          email: norm,
          role,
          status: 'invited',
          session_epoch: 1,
          created_at: '2026-06-16T00:00:00.000Z',
        };
        store.set(userId, user);
        return { created: true, user };
      },
    } as unknown as UsersRepo;
  };

  const buildDevApp = () => {
    const usersRepo = makeUsersRepo();
    const config = loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: '1', CF_ORIGIN_SECRET: SECRET });
    return buildApp({ config, devRouter: createDevRouter({ config, usersRepo }), auth: { usersRepo } });
  };

  it('mints a session cookie for a seeded user and round-trips via /auth/me', async () => {
    const app = buildDevApp();
    const res = await request(app).post('/auth/dev-login').send({ email: VA });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: VA, role: 'va' });

    const token = setCookieValue(res, SESSION_COOKIE_NAME);
    expect(token).toBeTruthy();

    const rawCookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith(`${SESSION_COOKIE_NAME}=`),
    )!;
    expect(rawCookie).toContain('HttpOnly');
    expect(rawCookie).toContain('SameSite=Lax');

    const me = await request(app)
      .get('/auth/me')
      .set('x-origin-verify', SECRET)
      .set('cookie', `${SESSION_COOKIE_NAME}=${token}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: VA, role: 'va' });
  });

  it('auto-provisions an unknown email (so dev-login works on an unseeded DB) and round-trips', async () => {
    const app = buildDevApp();
    const email = 'nobody@example.com';
    const res = await request(app).post('/auth/dev-login').send({ email });
    expect(res.status).toBe(200);
    // Unknown emails default to the admin role (full dashboard visibility when
    // you deliberately type a custom dev identity).
    expect(res.body).toMatchObject({ email, role: 'admin' });

    const token = setCookieValue(res, SESSION_COOKIE_NAME);
    expect(token).toBeTruthy();

    const me = await request(app)
      .get('/auth/me')
      .set('x-origin-verify', SECRET)
      .set('cookie', `${SESSION_COOKIE_NAME}=${token}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email, role: 'admin' });
  });

  it('auto-provisions the founder persona with the admin role', async () => {
    const app = buildDevApp();
    const res = await request(app).post('/auth/dev-login').send({ email: 'founder@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: 'founder@example.com', role: 'admin' });
  });

  it('does not expose /auth/dev-login when the dev router is absent', async () => {
    const config = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET });
    const app = buildApp({ config }); // no devRouter
    const res = await request(app)
      .post('/auth/dev-login')
      .set('x-origin-verify', SECRET)
      .send({ email: VA });
    expect(res.status).toBe(404);
  });
});

describe('dev tick — POST /__dev/tour-reminders/tick', () => {
  // The deterministic e2e seam for the worker's 60s tour-reminder poll: one
  // POST = one runDueTourReminders(now) pass over the SAME world fakes the
  // /api/tours route armed.
  const FIXED_NOW = '2026-07-13T10:00:00.000Z';
  const SCHEDULED_AT = '2026-07-15T10:00:00.000Z';
  const TENANT_PHONE = '+15550300001';
  // Rung bodies sourced from the message catalog (single source of truth).
  const CONFIRMATION_BODY = resolveMessage('tour.confirmation');
  const DAY_BEFORE_BODY = resolveMessage('tour.day_before');

  /** Harness app + dev router sharing ONE world: /api/tours arms reminder rows
   *  against the world fakes and the tick drains them through the SAME repos —
   *  the 1:1 send lands on world.sent via the world adapter (the spy surface). */
  function buildTickHarness(): { app: Express; world: FakeWorld } {
    const world = createFakeWorld();
    const capture = createLogCapture();
    const logger = createLogger({ destination: capture.stream });
    const config = loadConfig({
      NODE_ENV: 'test',
      DEV_AUTH_ENABLED: '1',
      CF_ORIGIN_SECRET: SECRET,
      MESSAGING_DRIVER: 'console',
    });
    const sendMessageService = createSendMessageService({
      config,
      logger,
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
      events: world.events,
    });
    const devRouter = createDevRouter({
      config,
      logger,
      // Same shape worker.ts builds — but wired to the world fakes.
      tourReminderDeps: {
        tourRemindersRepo: world.tourRemindersRepo,
        toursRepo: world.toursRepo,
        contactsRepo: world.contactsRepo,
        conversationsRepo: world.conversationsRepo,
        messagesRepo: world.messagesRepo,
        sendMessageService,
        adapter: world.adapter,
        logger,
      },
    });
    const { app } = makeWebhookHarness({ world, toursNow: () => FIXED_NOW, devRouter });
    return { app, world };
  }

  /** Seed tenant + 1:1 conversation, then arm a tour VIA THE ROUTE with the
   *  injected clock (confirmation dueAt = FIXED_NOW, day_before = T-24h). */
  async function armTourViaRoute(app: Express, world: FakeWorld): Promise<string> {
    world.contacts.push({
      contactId: 'contact-tick-tenant',
      type: 'tenant',
      phone: TENANT_PHONE,
      created_at: FIXED_NOW,
    });
    world.conversations.set('conv-tick-1', {
      conversationId: 'conv-tick-1',
      participant_phone: TENANT_PHONE,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: FIXED_NOW,
      created_at: FIXED_NOW,
    });
    const created = await request(app)
      .post('/api/tours')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        tenantId: 'contact-tick-tenant',
        unitId: 'unit-tick-1',
        scheduledAt: SCHEDULED_AT,
        tourType: 'self_guided',
      });
    expect(created.status).toBe(201);
    return created.body.tour.tourId as string;
  }

  it('fires the due rows at the supplied now — and only those, exactly once', async () => {
    const { app, world } = buildTickHarness();
    await armTourViaRoute(app, world);

    // At FIXED_NOW only the confirmation rung (dueAt = FIXED_NOW) is due.
    const res = await request(app).post('/__dev/tour-reminders/tick').send({ now: FIXED_NOW });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, now: FIXED_NOW });
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]).toMatchObject({ to: TENANT_PHONE, body: CONFIRMATION_BODY });

    // A later tick fires the NEXT rung once; the claimed row never re-sends.
    const res2 = await request(app)
      .post('/__dev/tour-reminders/tick')
      .send({ now: '2026-07-14T10:01:00.000Z' });
    expect(res2.status).toBe(200);
    expect(world.sent).toHaveLength(2);
    expect(world.sent[1]).toMatchObject({ to: TENANT_PHONE, body: DAY_BEFORE_BODY });
  });

  it('normalizes a milliseconds-less now to full toISOString() form', async () => {
    const { app, world } = buildTickHarness();
    await armTourViaRoute(app, world);

    // The ladder compares ISO strings lexicographically — a '…00Z' input must
    // collapse to '…00.000Z' so rows whose dueAt carries milliseconds fire.
    const res = await request(app)
      .post('/__dev/tour-reminders/tick')
      .send({ now: '2026-07-14T10:01:00Z' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, now: '2026-07-14T10:01:00.000Z' });

    // Both due rows (confirmation @ FIXED_NOW, day_before @ T-24h with .000
    // milliseconds) fired against the normalized now.
    expect(world.sent.map((s) => s.body).sort()).toEqual(
      [CONFIRMATION_BODY, DAY_BEFORE_BODY].sort(),
    );
  });

  it('defaults now to the wall clock when the body carries none', async () => {
    const { app, world } = buildTickHarness();
    await armTourViaRoute(app, world);

    const res = await request(app).post('/__dev/tour-reminders/tick').send();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // The echoed now is a full canonical ISO instant.
    expect(typeof res.body.now).toBe('string');
    expect(new Date(res.body.now as string).toISOString()).toBe(res.body.now);
    // Nothing is due at the real wall clock (the ladder is armed in the future
    // relative to this suite's fixed dates) — deterministic either way: the
    // endpoint ran a poll pass without error.
  });

  it('rejects a malformed now with 400 (and runs no poll)', async () => {
    const { app, world } = buildTickHarness();
    await armTourViaRoute(app, world);

    for (const bad of ['not-a-date', '', 123, { nested: true }]) {
      const res = await request(app).post('/__dev/tour-reminders/tick').send({ now: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body).toEqual({ error: 'now must be a valid ISO 8601 datetime' });
    }
    expect(world.sent).toHaveLength(0);
  });

  it('is absent when the dev router is not mounted', async () => {
    const config = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET });
    const app = buildApp({ config }); // no devRouter
    const res = await request(app)
      .post('/__dev/tour-reminders/tick')
      .set('x-origin-verify', SECRET)
      .send({ now: FIXED_NOW });
    expect(res.status).toBe(404);
  });
});

describe('dev tick — POST /__dev/placement-nudges/tick', () => {
  // The deterministic e2e seam for the worker's 60s placement-nudge poll: one
  // POST = one runDuePlacementNudges(now) pass over the SAME world fakes the
  // statusTransition choke point armed (mirrors the tour-reminder tick exactly).
  const FIXED_NOW = '2026-07-13T10:00:00.000Z';
  const TENANT_PHONE = '+15550400001';
  // Canned rung body (catalog `nudge.receipt_check`).
  const RECEIPT_BODY = resolveMessage('nudge.receipt_check');

  /** Harness app + dev router sharing ONE world: the tick drains the world's
   *  placementNudges rows through the SAME repos and the 1:1 send lands on
   *  world.sent via the world adapter (the spy surface). */
  function buildTickHarness(): { app: Express; world: FakeWorld } {
    const world = createFakeWorld();
    const capture = createLogCapture();
    const logger = createLogger({ destination: capture.stream });
    const config = loadConfig({
      NODE_ENV: 'test',
      DEV_AUTH_ENABLED: '1',
      CF_ORIGIN_SECRET: SECRET,
      MESSAGING_DRIVER: 'console',
    });
    const sendMessageService = createSendMessageService({
      config,
      logger,
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
      events: world.events,
    });
    const devRouter = createDevRouter({
      config,
      logger,
      // Same shape worker.ts builds — but wired to the world fakes (no adapter:
      // RunDuePlacementNudgesDeps routes 1:1 through sendMessageService only).
      placementNudgeDeps: {
        placementNudgesRepo: world.placementNudgesRepo,
        placementsRepo: world.placementsRepo,
        contactsRepo: world.contactsRepo,
        unitsRepo: world.unitsRepo,
        conversationsRepo: world.conversationsRepo,
        sendMessageService,
        logger,
      },
    });
    const { app } = makeWebhookHarness({ world, devRouter });
    return { app, world };
  }

  /** Seed a tenant + 1:1 conversation + an awaiting_receipt placement, then arm a
   *  due receipt_check nudge row directly in the world's repo (the choke point's
   *  arm path, minus the transition — this suite tests the tick, not the arming).
   *  `dueAt` defaults to FIXED_NOW; the wall-clock test overrides it with a
   *  future-relative instant (a fixed "future" date is a time bomb — the suite
   *  outlived 2026-07-13 once and the row started firing for real). */
  async function armReceiptNudge(world: FakeWorld, dueAt: string = FIXED_NOW): Promise<void> {
    world.contacts.push({
      contactId: 'contact-nudge-tenant',
      type: 'tenant',
      phone: TENANT_PHONE,
      created_at: FIXED_NOW,
    });
    world.conversations.set('conv-nudge-1', {
      conversationId: 'conv-nudge-1',
      participant_phone: TENANT_PHONE,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: FIXED_NOW,
      created_at: FIXED_NOW,
    });
    world.placements.set('placement-nudge-1', {
      placementId: 'placement-nudge-1',
      tenantId: 'contact-nudge-tenant',
      unitId: 'unit-nudge-1',
      stage: 'awaiting_receipt',
      created_at: FIXED_NOW,
      updated_at: FIXED_NOW,
    });
    await world.placementNudgesRepo.create({
      placementId: 'placement-nudge-1',
      kind: 'receipt_check',
      dueAt,
    });
  }

  it('fires the due rows at the supplied now — and only those, exactly once', async () => {
    const { app, world } = buildTickHarness();
    await armReceiptNudge(world);

    const res = await request(app).post('/__dev/placement-nudges/tick').send({ now: FIXED_NOW });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, now: FIXED_NOW });
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]).toMatchObject({ to: TENANT_PHONE, body: RECEIPT_BODY });

    // A second tick claims nothing new — the row was stamped sentAt on the first.
    const res2 = await request(app).post('/__dev/placement-nudges/tick').send({ now: FIXED_NOW });
    expect(res2.status).toBe(200);
    expect(world.sent).toHaveLength(1);
  });

  it('normalizes a milliseconds-less now to full toISOString() form', async () => {
    const { app, world } = buildTickHarness();
    await armReceiptNudge(world);

    // The row's dueAt carries '.000Z' — a '…00Z' input must collapse to the same
    // canonical form so the lexicographic dueAt <= now comparison fires it.
    const res = await request(app)
      .post('/__dev/placement-nudges/tick')
      .send({ now: '2026-07-13T10:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, now: FIXED_NOW });
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]).toMatchObject({ to: TENANT_PHONE, body: RECEIPT_BODY });
  });

  it('defaults now to the wall clock when the body carries none', async () => {
    const { app, world } = buildTickHarness();
    // Arm the row a day AHEAD of the real wall clock (never a fixed date —
    // FIXED_NOW expired on 2026-07-13 and this test started firing the row):
    // a wall-clock tick must find nothing due, on any run date.
    await armReceiptNudge(world, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());

    const res = await request(app).post('/__dev/placement-nudges/tick').send();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // The echoed now is a full canonical ISO instant.
    expect(typeof res.body.now).toBe('string');
    expect(new Date(res.body.now as string).toISOString()).toBe(res.body.now);
    // The armed row is due tomorrow, so the wall-clock poll sends nothing.
    expect(world.sent).toHaveLength(0);
  });

  it('rejects a malformed now with 400 (and runs no poll)', async () => {
    const { app, world } = buildTickHarness();
    await armReceiptNudge(world);

    for (const bad of ['not-a-date', '', 123, { nested: true }]) {
      const res = await request(app).post('/__dev/placement-nudges/tick').send({ now: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body).toEqual({ error: 'now must be a valid ISO 8601 datetime' });
    }
    expect(world.sent).toHaveLength(0);
  });

  it('is absent when the dev router is not mounted', async () => {
    const config = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET });
    const app = buildApp({ config }); // no devRouter
    const res = await request(app)
      .post('/__dev/placement-nudges/tick')
      .set('x-origin-verify', SECRET)
      .send({ now: FIXED_NOW });
    expect(res.status).toBe(404);
  });
});
