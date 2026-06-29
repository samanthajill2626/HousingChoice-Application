import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { maybeLoadDevRouter } from '../src/lib/devRoutes.js';
import { SESSION_COOKIE_NAME } from '../src/lib/sessionCookie.js';
import { createDevRouter } from '../src/routes/dev.js';
import { userIdForEmail, type UserItem, type UsersRepo } from '../src/repos/usersRepo.js';

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
      tablePrefix: config.tablePrefix,
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
