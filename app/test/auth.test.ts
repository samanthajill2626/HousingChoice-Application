// M1.3 unit tests: the auth surface —
//   evaluateIdentity        the domain allowlist gate (pure)
//   GET  /auth/login        302 to the provider + sealed state cookie
//   GET  /auth/callback     exchange, allowlist 403s, INVITE-gated access
//                           (not-invited 403, first-login activation),
//                           session cookie, activation race behavior
//   POST /auth/logout       session cleared
//   GET  /auth/me           shapes (200 / 401)
//   /api requireAuth        401 without/with-tampered session, SSE included
//   /api CSRF origin check  cross-origin mutating requests 403
//   Task 2: profile scope + name claim capture + resolveInvitedUser wiring
//   requireRole             401/403/next
//   session epoch           server-side revocation: logout kills COPIED
//                           cookies, role bumps revoke, cache read economy
//   rolling refresh         day-old sessions re-issue with the current role
//   config fail-fast        production requires the M1.3 auth wiring and
//                           refuses the placeholder SESSION_SECRET
//
// The AuthProvider is a FAKE injected through buildApp deps — openid-client
// is never touched (no network); the cookies and their crypto are real.
import type { Express } from 'express';
import request, { type Response } from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AuthIdentity, AuthProvider } from '../src/adapters/auth.js';
import { buildApp } from '../src/app.js';
import { DEV_SESSION_SECRET_DEFAULT, loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import {
  OAUTH_STATE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  parseCookies,
  seal,
} from '../src/lib/sessionCookie.js';
import {
  createSessionEpochCache,
  requireRole,
  sessionMiddleware,
  type SessionEpochCache,
} from '../src/middleware/auth.js';
import { evaluateIdentity } from '../src/routes/auth.js';
import type { UserItem } from '../src/repos/usersRepo.js';
import { userIdForEmail } from '../src/repos/usersRepo.js';
import { AccessDeniedError, resolveInvitedUser } from '../src/services/resolveInvitedUser.js';
import {
  invitedUserItem,
  makeFakeUsersRepo,
  sessionCookieFor,
  testUserItem,
  TEST_SESSION_COOKIE,
  TEST_SESSION_USER,
} from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import { makeWebhookHarness, ORIGIN_SECRET, PUBLIC_BASE_URL } from './helpers/twilioWebhookHarness.js';

const SECRET = 'test-origin-secret';
const ALLOWED = 'housingchoice.org,abt-industries.com';

const VA_IDENTITY: AuthIdentity = {
  sub: 'google-sub-1',
  email: 'va@housingchoice.org',
  emailVerified: true,
  hostedDomain: 'housingchoice.org',
};

// --- fakes -------------------------------------------------------------------
// The in-memory UsersRepo (with create/findById call tracking) lives in
// helpers/authSession.ts — shared with the webhook harness since the
// session-epoch check made every authed request read the users table.

function makeFakeProvider(identity: AuthIdentity) {
  const completeCalls: { url: string; state: string; codeVerifier: string }[] = [];
  const provider: AuthProvider = {
    async startLogin(redirectUri) {
      return {
        url: `https://accounts.google.example/auth?redirect_uri=${encodeURIComponent(redirectUri)}`,
        state: 'state-1',
        codeVerifier: 'verifier-1',
      };
    },
    async completeLogin(callbackUrl, expected) {
      completeCalls.push({ url: callbackUrl.href, ...expected });
      if (expected.state !== 'state-1' || expected.codeVerifier !== 'verifier-1') {
        throw new Error('state/PKCE mismatch');
      }
      return identity;
    },
  };
  return { provider, completeCalls };
}

interface AuthAppOptions {
  identity?: AuthIdentity;
  allowedDomains?: string;
  seedUsers?: UserItem[];
  /** e.g. createSessionEpochCache(0) to force a users-table read per request. */
  sessionEpochCache?: SessionEpochCache;
  env?: Record<string, string>;
}

function makeAuthApp(opts: AuthAppOptions = {}) {
  const capture = createLogCapture();
  const config = loadConfig({
    NODE_ENV: 'test',
    CF_ORIGIN_SECRET: SECRET,
    OAUTH_ALLOWED_DOMAINS: opts.allowedDomains ?? ALLOWED,
    ...opts.env,
  } as NodeJS.ProcessEnv);
  const fakeUsers = makeFakeUsersRepo(opts.seedUsers);
  const audits: { entityKey: string; eventType: string; payload?: Record<string, unknown> }[] = [];
  const { provider, completeCalls } = makeFakeProvider(opts.identity ?? VA_IDENTITY);
  const app = buildApp({
    config,
    logger: createLogger({ level: 'info', destination: capture.stream }),
    auth: {
      authProvider: provider,
      usersRepo: fakeUsers.repo,
      ...(opts.sessionEpochCache !== undefined && { sessionEpochCache: opts.sessionEpochCache }),
      auditRepo: {
        async append(entityKey, eventType, payload) {
          audits.push({ entityKey, eventType, ...(payload !== undefined && { payload }) });
        },
      },
    },
  });
  return { app, config, fakeUsers, audits, completeCalls, capture };
}

/** A sealed hc_oauth state cookie matching the fake provider's values. */
function stateCookie(overrides: Record<string, unknown> = {}, ttlMs = 600_000): string {
  const token = seal(
    { state: 'state-1', codeVerifier: 'verifier-1', ...overrides },
    { secret: DEV_SESSION_SECRET_DEFAULT, purpose: 'oauth', ttlMs },
  );
  return `${OAUTH_STATE_COOKIE_NAME}=${token}`;
}

/** Extract a named cookie's value from a response's Set-Cookie headers. */
function setCookieValue(res: Response, name: string): string | undefined {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const line = header?.find((c) => c.startsWith(`${name}=`));
  if (!line) return undefined;
  return parseCookies(line.split(';')[0])[name];
}

function callback(app: Express, cookie: string = stateCookie()) {
  return request(app)
    .get('/auth/callback?code=fake-code&state=state-1')
    .set('x-origin-verify', SECRET)
    .set('cookie', cookie)
    .set('accept', 'application/json');
}

// --- evaluateIdentity (the allowlist gate, pure) -------------------------------

describe('evaluateIdentity — the domain allowlist', () => {
  const domains = ['housingchoice.org', 'abt-industries.com'];

  it('allows an allowlisted email with a matching hd', () => {
    expect(evaluateIdentity(VA_IDENTITY, domains)).toEqual({ allowed: true });
  });

  it('allows when hd is ABSENT but the email domain passes (email is authoritative, hd is corroboration)', () => {
    const noHd: AuthIdentity = { sub: 's', email: 'va@housingchoice.org', emailVerified: true };
    expect(evaluateIdentity(noHd, domains)).toEqual({ allowed: true });
  });

  it('refuses a wrong email domain — even when hd is allowlisted', () => {
    expect(
      evaluateIdentity(
        { ...VA_IDENTITY, email: 'someone@gmail.com' },
        domains,
      ),
    ).toEqual({ allowed: false, reason: 'domain_not_allowed' });
  });

  it('refuses an allowlisted email when hd is present but NOT allowlisted (corroboration check)', () => {
    expect(
      evaluateIdentity({ ...VA_IDENTITY, hostedDomain: 'evil.example' }, domains),
    ).toEqual({ allowed: false, reason: 'domain_not_allowed' });
  });

  it('refuses unverified emails outright', () => {
    expect(evaluateIdentity({ ...VA_IDENTITY, emailVerified: false }, domains)).toEqual({
      allowed: false,
      reason: 'email_unverified',
    });
  });

  it('refuses EVERYONE on an empty allowlist (default = nobody)', () => {
    expect(evaluateIdentity(VA_IDENTITY, [])).toEqual({
      allowed: false,
      reason: 'domain_not_allowed',
    });
  });

  it('refuses an email with no @ at all', () => {
    expect(evaluateIdentity({ ...VA_IDENTITY, email: 'not-an-email' }, domains)).toEqual({
      allowed: false,
      reason: 'domain_not_allowed',
    });
  });
});

// --- GET /auth/login ------------------------------------------------------------

describe('GET /auth/login', () => {
  it('302s to the provider URL and sets the sealed state cookie (HttpOnly, Lax, Path=/auth)', async () => {
    const { app } = makeAuthApp();
    const res = await request(app).get('/auth/login').set('x-origin-verify', SECRET);

    expect(res.status).toBe(302);
    expect(res.headers['location']).toContain('https://accounts.google.example/auth');
    // The locally-derived redirect URI (no PUBLIC_BASE_URL in test env).
    expect(res.headers['location']).toContain(
      encodeURIComponent('http://localhost:8080/auth/callback'),
    );

    const cookieLine = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`),
    )!;
    expect(cookieLine).toBeDefined();
    expect(cookieLine).toContain('HttpOnly');
    expect(cookieLine).toContain('SameSite=Lax');
    expect(cookieLine).toContain('Path=/auth');
    // test NODE_ENV: not Secure (plain http://localhost) — production is.
    expect(cookieLine).not.toContain('Secure');
  });

  it('503s when OAuth is unconfigured (no client credentials, no injected provider)', async () => {
    const config = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET } as NodeJS.ProcessEnv);
    const app = buildApp({
      config,
      logger: createLogger({ destination: createLogCapture().stream }),
    });
    const res = await request(app).get('/auth/login').set('x-origin-verify', SECRET);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('oauth_not_configured');
  });

  it('403s WITHOUT the origin-secret header (a direct-to-EIP probe never reaches OAuth)', async () => {
    const { app, completeCalls } = makeAuthApp();
    const res = await request(app).get('/auth/login');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
    expect(res.headers['set-cookie']).toBeUndefined(); // no state cookie minted
    expect(completeCalls).toEqual([]);
  });
});

// --- GET /auth/callback -----------------------------------------------------------

describe('GET /auth/callback — happy path + invite activation', () => {
  it('activates an INVITED user on first login, audits user_activated, sets the session cookie, redirects /', async () => {
    const expectedUserId = userIdForEmail('va@housingchoice.org');
    // Invite-first: the user must already exist (status 'invited', no google_sub).
    const { app, fakeUsers, audits, completeCalls } = makeAuthApp({
      seedUsers: [
        invitedUserItem({ userId: expectedUserId, email: 'va@housingchoice.org', role: 'va' }),
      ],
    });
    const res = await callback(app);

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/');

    // The provider got the exact state/verifier from the sealed cookie and
    // the full callback URL for the code exchange.
    expect(completeCalls).toEqual([
      {
        url: 'http://localhost:8080/auth/callback?code=fake-code&state=state-1',
        state: 'state-1',
        codeVerifier: 'verifier-1',
      },
    ]);

    // No CREATE on the login path — only an activation of the existing invite.
    expect(fakeUsers.creates).toEqual([]);
    expect(fakeUsers.activations).toEqual([expectedUserId]);
    const user = fakeUsers.users.get(expectedUserId)!;
    expect(user).toMatchObject({
      email: 'va@housingchoice.org',
      google_sub: 'google-sub-1', // written on first login
      role: 'va', // login NEVER changes the invited role
      status: 'active', // invited → active
    });
    expect(typeof user.last_login_at).toBe('string');

    expect(audits).toEqual([
      {
        entityKey: `users#${expectedUserId}`,
        eventType: 'user_activated',
        payload: { email: 'va@housingchoice.org', role: 'va', google_sub: 'google-sub-1' },
      },
    ]);

    // The session cookie round-trips through /auth/me.
    const sessionToken = setCookieValue(res, SESSION_COOKIE_NAME)!;
    expect(sessionToken).toBeDefined();
    const me = await request(app)
      .get('/auth/me')
      .set('x-origin-verify', SECRET)
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      userId: expectedUserId,
      email: 'va@housingchoice.org',
      role: 'va',
    });

    // Session-cookie attributes.
    const line = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith(`${SESSION_COOKIE_NAME}=`),
    )!;
    expect(line).toContain('HttpOnly');
    expect(line).toContain('SameSite=Lax');
    expect(line).toContain('Path=/');
  });

  it('second login of an ACTIVE user — no re-activation, last_login touched, role preserved', async () => {
    const userId = userIdForEmail('va@housingchoice.org');
    // Pre-promoted, already-active admin: login must keep the role, not reset it.
    const { app, fakeUsers, audits } = makeAuthApp({
      seedUsers: [
        {
          userId,
          email: 'va@housingchoice.org',
          google_sub: 'google-sub-1',
          role: 'admin',
          status: 'active',
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
    });

    const res = await callback(app);
    expect(res.status).toBe(302);
    expect(fakeUsers.creates).toEqual([]); // found, not created
    expect(fakeUsers.activations).toEqual([]); // already active — no re-activation
    expect(audits).toEqual([]); // no user_activated for an active user
    expect(typeof fakeUsers.users.get(userId)!.last_login_at).toBe('string');

    const me = await request(app)
      .get('/auth/me')
      .set('x-origin-verify', SECRET)
      .set('cookie', `${SESSION_COOKIE_NAME}=${setCookieValue(res, SESSION_COOKIE_NAME)}`);
    expect(me.body.role).toBe('admin');
  });

  it('activation race: two concurrent first logins activate once, both see the same user (one audit)', async () => {
    const userId = userIdForEmail(VA_IDENTITY.email);
    const { fakeUsers, audits } = makeAuthApp({
      seedUsers: [invitedUserItem({ userId, email: VA_IDENTITY.email, role: 'va' })],
    });
    const deps = {
      usersRepo: fakeUsers.repo,
      auditRepo: {
        async append(entityKey: string, eventType: string, payload?: Record<string, unknown>) {
          audits.push({ entityKey, eventType, ...(payload !== undefined && { payload }) });
        },
      },
    };
    const [a, b] = await Promise.all([
      resolveInvitedUser(deps, VA_IDENTITY),
      resolveInvitedUser(deps, VA_IDENTITY),
    ]);
    expect(a.user.userId).toBe(b.user.userId);
    expect(fakeUsers.users.get(userId)!.status).toBe('active');
    // The same google_sub either way (if_not_exists: no clobber).
    expect(fakeUsers.users.get(userId)!.google_sub).toBe(VA_IDENTITY.sub);
  });

  it('refuses a verified, allowlisted, but UN-invited identity with AccessDeniedError (no create)', async () => {
    const { fakeUsers } = makeAuthApp(); // empty users table — nobody invited
    const deps = {
      usersRepo: fakeUsers.repo,
      auditRepo: { async append() {} },
    };
    await expect(resolveInvitedUser(deps, VA_IDENTITY)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(fakeUsers.creates).toEqual([]);
    expect(fakeUsers.activations).toEqual([]);
  });
});

describe('GET /auth/callback — refusals', () => {
  it('403 domain_not_allowed for a wrong email domain: no user, no audit, no session cookie', async () => {
    const { app, fakeUsers, audits } = makeAuthApp({
      identity: { sub: 's', email: 'outsider@gmail.com', emailVerified: true },
    });
    const res = await callback(app);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'domain_not_allowed' });
    expect(fakeUsers.creates).toEqual([]);
    expect(audits).toEqual([]);
    expect(setCookieValue(res, SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it('serves the 403 as a small HTML page to browsers (Accept: text/html)', async () => {
    const { app } = makeAuthApp({
      identity: { sub: 's', email: 'outsider@gmail.com', emailVerified: true },
    });
    const res = await request(app)
      .get('/auth/callback?code=fake-code&state=state-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', stateCookie())
      .set('accept', 'text/html');
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Domain not allowed');
  });

  it('403 when hd contradicts the allowlist even though the email domain passes', async () => {
    const { app } = makeAuthApp({
      identity: { ...VA_IDENTITY, hostedDomain: 'evil.example' },
    });
    const res = await callback(app);
    expect(res.status).toBe(403);
  });

  it('allows when hd is absent but the email domain is allowlisted AND the user is invited', async () => {
    const noHd: AuthIdentity = { sub: 's', email: 'va@housingchoice.org', emailVerified: true };
    const { app } = makeAuthApp({
      identity: noHd,
      seedUsers: [invitedUserItem({ userId: userIdForEmail(noHd.email), email: noHd.email })],
    });
    const res = await callback(app);
    expect(res.status).toBe(302);
  });

  it('403 for an unverified email', async () => {
    const { app } = makeAuthApp({ identity: { ...VA_IDENTITY, emailVerified: false } });
    expect((await callback(app)).status).toBe(403);
  });

  it('403 for everyone when the allowlist is empty (default = nobody)', async () => {
    const { app } = makeAuthApp({ allowedDomains: '' });
    expect((await callback(app)).status).toBe(403);
  });

  it('400 login_expired when the state cookie is missing', async () => {
    const { app, completeCalls } = makeAuthApp();
    const res = await request(app)
      .get('/auth/callback?code=fake-code&state=state-1')
      .set('x-origin-verify', SECRET);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('login_expired');
    expect(completeCalls).toEqual([]); // the exchange never ran
  });

  it('400 login_expired when the state cookie is tampered or expired', async () => {
    const { app } = makeAuthApp();
    const tampered = stateCookie().slice(0, -4) + 'AAAA';
    expect((await callback(app, tampered)).status).toBe(400);

    const expired = stateCookie({}, -1); // already past exp
    expect((await callback(app, expired)).status).toBe(400);
  });

  it('400 login_failed when the provider rejects the exchange (state mismatch)', async () => {
    const { app, capture } = makeAuthApp();
    // Seal a DIFFERENT state than the provider expects → completeLogin throws.
    const res = await callback(app, stateCookie({ state: 'state-other' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('login_failed');
    const warn = capture.atLevel(40).find((l) => l['msg'] === 'oauth code exchange failed');
    expect(warn).toBeDefined();
  });
});

// --- GET /auth/callback — invite gate (the access decision) -------------------------

describe('GET /auth/callback — invite gate', () => {
  it('403 not_invited for a verified, allowlisted, but UN-invited account — no session, no audit', async () => {
    // VA_IDENTITY passes the domain allowlist; the users table is empty.
    const { app, fakeUsers, audits } = makeAuthApp();
    const res = await callback(app);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'not_invited', detail: 'ask an admin for access' });
    expect(fakeUsers.creates).toEqual([]);
    expect(fakeUsers.activations).toEqual([]);
    expect(audits).toEqual([]);
    expect(setCookieValue(res, SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it('serves the not-invited 403 as its own HTML page (distinct from "Domain not allowed")', async () => {
    const { app } = makeAuthApp();
    const res = await request(app)
      .get('/auth/callback?code=fake-code&state=state-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', stateCookie())
      .set('accept', 'text/html');
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('No access yet');
    expect(res.text).not.toContain('Domain not allowed');
  });

  it('the two 403s log DISTINCT reasons (domain_not_allowed vs not_invited), neither logging the email', async () => {
    // not-invited: allowlisted domain, no invite.
    const notInvited = makeAuthApp();
    await callback(notInvited.app);
    const notInvitedWarn = notInvited.capture
      .atLevel(40)
      .find((l) => l['msg'] === 'login refused — not invited');
    expect(notInvitedWarn).toBeDefined();
    expect(notInvitedWarn!['reason']).toBe('not_invited');
    expect(notInvitedWarn!['emailDomain']).toBe('housingchoice.org');
    // No email anywhere in the line.
    expect(JSON.stringify(notInvitedWarn)).not.toContain('va@housingchoice.org');

    // domain refusal: a different message + reason.
    const wrongDomain = makeAuthApp({
      identity: { sub: 's', email: 'outsider@gmail.com', emailVerified: true },
    });
    await callback(wrongDomain.app);
    const domainWarn = wrongDomain.capture
      .atLevel(40)
      .find((l) => l['msg'] === 'login refused by domain allowlist');
    expect(domainWarn).toBeDefined();
    expect(domainWarn!['reason']).toBe('domain_not_allowed');
    expect(JSON.stringify(domainWarn)).not.toContain('outsider@gmail.com');
  });
});

// --- logout + /auth/me ------------------------------------------------------------

describe('POST /auth/logout and GET /auth/me', () => {
  it('me → 401 without a session; logout clears the cookie', async () => {
    const { app } = makeAuthApp();
    expect((await request(app).get('/auth/me').set('x-origin-verify', SECRET)).status).toBe(401);

    const logout = await request(app)
      .post('/auth/logout')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(logout.status).toBe(204);
    const cleared = (logout.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith(`${SESSION_COOKIE_NAME}=`),
    )!;
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970'); // res.clearCookie
  });

  it('me → 401 for a tampered session cookie', async () => {
    const { app } = makeAuthApp();
    const res = await request(app)
      .get('/auth/me')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE.slice(0, -4) + 'AAAA');
    expect(res.status).toBe(401);
  });

  it('me → 401 for an OAuth state token replayed as the session cookie (purpose mismatch)', async () => {
    const { app } = makeAuthApp({ seedUsers: [testUserItem()] });
    const oauthToken = seal(
      { userId: TEST_SESSION_USER.userId, email: TEST_SESSION_USER.email, role: 'va', epoch: 1 },
      { secret: DEV_SESSION_SECRET_DEFAULT, purpose: 'oauth', ttlMs: 600_000 },
    );
    const res = await request(app)
      .get('/auth/me')
      .set('x-origin-verify', SECRET)
      .set('cookie', `${SESSION_COOKIE_NAME}=${oauthToken}`);
    expect(res.status).toBe(401);
  });
});

// --- session epoch (server-side revocation) -----------------------------------------

describe('session epoch — the server-side kill switch', () => {
  it('a bumped epoch 401s an existing session (0-TTL cache = within the 60s window)', async () => {
    const { app, fakeUsers } = makeAuthApp({
      seedUsers: [testUserItem()],
      sessionEpochCache: createSessionEpochCache(0), // every request re-reads
    });
    const me = () =>
      request(app).get('/auth/me').set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);

    expect((await me()).status).toBe(200); // epoch 1 vs epoch 1

    await fakeUsers.repo.bumpSessionEpoch(TEST_SESSION_USER.userId); // → 2
    const revoked = await me();
    expect(revoked.status).toBe(401);
    // The stale cookie is cleared so the browser stops sending it.
    const cleared = (revoked.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith(`${SESSION_COOKIE_NAME}=`),
    );
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970');
  });

  it('logout revokes a COPIED cookie too — global logout by design', async () => {
    const { app } = makeAuthApp({ seedUsers: [testUserItem()] });
    // The "attacker" copied the victim's cookie value (same sealed token).
    const copiedCookie = TEST_SESSION_COOKIE;

    const logout = await request(app)
      .post('/auth/logout')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(logout.status).toBe(204);

    // The copy dies with the original: logout bumped the epoch AND evicted
    // the process cache, so the next check reads epoch 2 vs the sealed 1.
    const res = await request(app)
      .get('/auth/me')
      .set('x-origin-verify', SECRET)
      .set('cookie', copiedCookie);
    expect(res.status).toBe(401);
  });

  it('a role change + epoch bump (the user:role script) revokes within the window; the next login carries the new role', async () => {
    const { app, fakeUsers } = makeAuthApp({
      seedUsers: [testUserItem()],
      sessionEpochCache: createSessionEpochCache(0),
    });
    const oldCookie = TEST_SESSION_COOKIE; // sealed as va, epoch 1

    // What scripts/userRole.mjs does in one atomic update:
    await fakeUsers.repo.setRole(TEST_SESSION_USER.userId, 'admin');
    await fakeUsers.repo.bumpSessionEpoch(TEST_SESSION_USER.userId);

    const revoked = await request(app)
      .get('/auth/me')
      .set('x-origin-verify', SECRET)
      .set('cookie', oldCookie);
    expect(revoked.status).toBe(401); // ≤60s, not the old 24h refresh lag

    // A fresh session (sealed with the current epoch) sees the new role.
    const fresh = await request(app)
      .get('/auth/me')
      .set('x-origin-verify', SECRET)
      .set('cookie', sessionCookieFor({}, { epoch: 2 }));
    expect(fresh.status).toBe(200);
    expect(fresh.body.role).toBe('admin');
  });

  it('cache hit avoids the users-table read (one findById per TTL window)', async () => {
    const { app, fakeUsers } = makeAuthApp({ seedUsers: [testUserItem()] }); // default 60s cache
    const me = () =>
      request(app).get('/auth/me').set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);

    expect((await me()).status).toBe(200);
    expect((await me()).status).toBe(200);
    expect((await me()).status).toBe(200);
    expect(fakeUsers.findByIdCalls).toEqual([TEST_SESSION_USER.userId]); // exactly one read
  });
});

// --- the /api gate ------------------------------------------------------------------

describe('requireAuth on /api (closes the H4 exposure)', () => {
  it('401s every /api route without a session — SSE /api/events included', async () => {
    const { app } = makeWebhookHarness();
    for (const [method, path] of [
      ['get', '/api/conversations'],
      ['get', '/api/conversations/conv-1'],
      ['post', '/api/conversations/conv-1/read'],
      ['get', '/api/events'],
    ] as const) {
      const res = await request(app)[method](path).set('x-origin-verify', ORIGIN_SECRET);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    }
  });

  it('401s a tampered session cookie (and clears it)', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/conversations')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE.slice(0, -4) + 'AAAA');
    expect(res.status).toBe(401);
    const cleared = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith(`${SESSION_COOKIE_NAME}=`),
    );
    expect(cleared).toBeDefined();
  });

  it('an expired session 401s even though the cookie was once valid', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/conversations')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', sessionCookieFor({}, { now: Date.now() - 8 * 24 * 60 * 60 * 1000 }));
    expect(res.status).toBe(401);
  });

  it('webhooks and /health stay public (no session required)', async () => {
    const { app } = makeWebhookHarness();
    expect((await request(app).get('/health')).status).toBe(200);
    // Webhooks have their own HMAC — an unsigned POST is a 403 from the
    // signature check, NOT a 401 from the session gate.
    const res = await request(app)
      .post('/webhooks/twilio/sms')
      .set('x-origin-verify', ORIGIN_SECRET)
      .type('form')
      .send({ MessageSid: 'SMx' });
    expect(res.status).not.toBe(401);
  });
});

// --- the /api CSRF origin check -------------------------------------------------------

describe('CSRF origin check on mutating /api methods', () => {
  // Harness PUBLIC_BASE_URL = https://dxxxx.cloudfront.example — the allowed origin.
  async function makeAuthedHarness() {
    const harness = makeWebhookHarness();
    const conv = await harness.world.conversationsRepo.createOrGetByParticipantPhone(
      '+15550100001',
      'tenant_1to1',
    );
    return { ...harness, readPath: `/api/conversations/${conv.conversationId}/read` };
  }

  it('403s a cross-origin POST — even with a VALID session — and WARN-logs the origin', async () => {
    const { app, capture, readPath } = await makeAuthedHarness();
    const res = await request(app)
      .post(readPath)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .set('origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
    const warn = capture
      .atLevel(40)
      .find((l) => String(l['msg']).includes('cross-origin mutating request rejected'));
    expect(warn).toBeDefined();
    expect(warn!['origin']).toBe('https://evil.example');
    expect(typeof warn!['correlationId']).toBe('string');
  });

  it("rejects the literal 'null' origin (sandboxed/opaque initiators)", async () => {
    const { app, readPath } = await makeAuthedHarness();
    const res = await request(app)
      .post(readPath)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .set('origin', 'null');
    expect(res.status).toBe(403);
  });

  it('passes a same-origin POST (Origin = PUBLIC_BASE_URL origin)', async () => {
    const { app, readPath } = await makeAuthedHarness();
    const res = await request(app)
      .post(readPath)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .set('origin', PUBLIC_BASE_URL);
    expect(res.status).toBe(200);
  });

  it('passes an absent Origin (non-browser clients; SameSite=Lax is the backstop)', async () => {
    const { app, readPath } = await makeAuthedHarness();
    const res = await request(app)
      .post(readPath)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
  });

  it('passes localhost dev origins (the Vite dev server)', async () => {
    const { app, readPath } = await makeAuthedHarness();
    const res = await request(app)
      .post(readPath)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .set('origin', 'http://localhost:5173');
    expect(res.status).toBe(200);
  });

  it('does not gate non-mutating methods (cross-origin GET still answers)', async () => {
    const { app } = await makeAuthedHarness();
    const res = await request(app)
      .get('/api/conversations')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .set('origin', 'https://evil.example');
    expect(res.status).toBe(200); // SameSite=Lax means this cookie wouldn't ride along in a real browser anyway
  });
});

// --- requireRole + rolling refresh ----------------------------------------------------

describe('requireRole (built, deliberately unused on /api for now)', () => {
  // Two REAL users — the epoch check reads roles from the users table, so a
  // cookie can no longer claim a role its user item does not hold.
  const ADMIN_USER = testUserItem({
    userId: 'usr_testadmin0000000000000',
    email: 'test-admin@housingchoice.org',
    role: 'admin',
  });

  function makeRoleApp(seedUsers: UserItem[] = [testUserItem(), ADMIN_USER]) {
    const config = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET } as NodeJS.ProcessEnv);
    const { repo } = makeFakeUsersRepo(seedUsers);
    return buildApp({
      config,
      logger: createLogger({ destination: createLogCapture().stream }),
      configureRoutes: (app) => {
        app.get(
          '/admin-only',
          sessionMiddleware({ config, usersRepo: repo }),
          requireRole('admin'),
          (_req, res) => {
            res.json({ ok: true });
          },
        );
      },
    });
  }

  it('401 anonymous, 403 for a va, 200 for an admin', async () => {
    const app = makeRoleApp();
    expect((await request(app).get('/admin-only').set('x-origin-verify', SECRET)).status).toBe(401);

    const asVa = await request(app)
      .get('/admin-only')
      .set('x-origin-verify', SECRET)
      .set('cookie', sessionCookieFor({ role: 'va' }));
    expect(asVa.status).toBe(403);
    expect(asVa.body).toEqual({ error: 'forbidden' });

    const asAdmin = await request(app)
      .get('/admin-only')
      .set('x-origin-verify', SECRET)
      .set('cookie', sessionCookieFor({ userId: ADMIN_USER.userId, email: ADMIN_USER.email, role: 'admin' }));
    expect(asAdmin.status).toBe(200);
  });

  it("a cookie CLAIMING admin is overruled by the user item's actual role (va)", async () => {
    const app = makeRoleApp();
    // Sealed role says admin; the users table says va — the table wins.
    const res = await request(app)
      .get('/admin-only')
      .set('x-origin-verify', SECRET)
      .set('cookie', sessionCookieFor({ role: 'admin' })); // TEST_SESSION_USER is a va
    expect(res.status).toBe(403);
  });
});

describe('rolling refresh (day-old sessions are re-issued with the current role)', () => {
  const dayOldCookie = () =>
    sessionCookieFor({}, { now: Date.now() - 25 * 60 * 60 * 1000 }); // iat 25h ago, well inside the 7d window

  it('re-issues the cookie with the CURRENT role — a legacy item (no session_epoch) reads as epoch 1', async () => {
    const { app } = makeAuthApp({
      seedUsers: [
        {
          // Deliberately NO session_epoch: pre-epoch items default to 1,
          // matching the epoch sessionCookieFor() seals by default.
          userId: TEST_SESSION_USER.userId,
          email: TEST_SESSION_USER.email,
          google_sub: 's',
          role: 'admin', // promoted since the session was minted as 'va'
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
    });
    const res = await request(app)
      .get('/auth/me')
      .set('x-origin-verify', SECRET)
      .set('cookie', dayOldCookie());
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin'); // the table's truth, not the cookie's 'va'
    expect(setCookieValue(res, SESSION_COOKIE_NAME)).toBeDefined(); // re-issued
  });

  it('revokes the session when the user no longer exists', async () => {
    const { app } = makeAuthApp(); // empty users table
    const res = await request(app)
      .get('/auth/me')
      .set('x-origin-verify', SECRET)
      .set('cookie', dayOldCookie());
    expect(res.status).toBe(401);
  });

  it('fresh sessions are NOT re-issued (no Set-Cookie before the daily refresh)', async () => {
    const { app, fakeUsers } = makeAuthApp({ seedUsers: [testUserItem()] });
    const res = await request(app)
      .get('/auth/me')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(setCookieValue(res, SESSION_COOKIE_NAME)).toBeUndefined(); // no re-issue
    expect(fakeUsers.findByIdCalls).toHaveLength(1); // only the epoch check's read
  });
});

// --- config fail-fast -------------------------------------------------------------------

describe('config fail-fast (M1.3 auth wiring)', () => {
  const prodBase = {
    NODE_ENV: 'production',
    CF_ORIGIN_SECRET: 's',
    MESSAGING_DRIVER: 'console',
    JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/hc-test-jobs',
    SCHEDULER_TARGET_ARN: 'arn:aws:sqs:us-east-1:000000000000:hc-test-jobs',
    SCHEDULER_ROLE_ARN: 'arn:aws:iam::000000000000:role/hc-test-scheduler',
  };
  const authWiring = {
    SESSION_SECRET: 'prod-session-secret',
    GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'csecret',
    OAUTH_ALLOWED_DOMAINS: 'housingchoice.org,abt-industries.com',
  };

  it('production throws when ANY of SESSION_SECRET / GOOGLE_* / OAUTH_ALLOWED_DOMAINS is missing', () => {
    expect(() => loadConfig(prodBase)).toThrow(
      /SESSION_SECRET.*GOOGLE_CLIENT_ID.*GOOGLE_CLIENT_SECRET.*OAUTH_ALLOWED_DOMAINS/,
    );
    for (const missing of Object.keys(authWiring)) {
      const env = { ...prodBase, ...authWiring, [missing]: undefined };
      expect(() => loadConfig(env), missing).toThrow(new RegExp(missing));
    }
  });

  it('production boots with the full wiring; local NODE_ENVs default to placeholder secret + deny-all allowlist', () => {
    const config = loadConfig({ ...prodBase, ...authWiring });
    expect(config.sessionSecret).toBe('prod-session-secret');
    expect(config.oauthAllowedDomains).toEqual(['housingchoice.org', 'abt-industries.com']);

    const local = loadConfig({ NODE_ENV: 'development' });
    expect(local.sessionSecret).toBe(DEV_SESSION_SECRET_DEFAULT);
    expect(local.oauthAllowedDomains).toEqual([]); // nobody
    expect(local.googleClientId).toBeUndefined();
  });

  it('production refuses the PLACEHOLDER SESSION_SECRET value, not just absence (it is committed in .env.example)', () => {
    expect(() =>
      loadConfig({ ...prodBase, ...authWiring, SESSION_SECRET: DEV_SESSION_SECRET_DEFAULT }),
    ).toThrow(/placeholder/);
    // The same value is fine outside production (it IS the local default).
    expect(
      loadConfig({ NODE_ENV: 'test', SESSION_SECRET: DEV_SESSION_SECRET_DEFAULT }).sessionSecret,
    ).toBe(DEV_SESSION_SECRET_DEFAULT);
  });

  it('normalizes the allowlist (trim + lowercase) and rejects malformed entries', () => {
    expect(
      loadConfig({ NODE_ENV: 'test', OAUTH_ALLOWED_DOMAINS: ' HousingChoice.org , abt-industries.com ' })
        .oauthAllowedDomains,
    ).toEqual(['housingchoice.org', 'abt-industries.com']);
    for (const bad of ['not a domain', 'user@example.org', 'nodot', 'https://example.org']) {
      expect(() => loadConfig({ NODE_ENV: 'test', OAUTH_ALLOWED_DOMAINS: bad }), bad).toThrow(
        /OAUTH_ALLOWED_DOMAINS/,
      );
    }
  });
});

// --- Task 2: resolveInvitedUser — name forwarding to usersRepo ------------------
// Note: createGoogleAuthProvider name-claim extraction tests live in
// auth.adapter.test.ts (isolated vi.mock of openid-client).

describe('resolveInvitedUser — name forwarding from identity', () => {
  const BASE_EMAIL = 'va@housingchoice.org';
  const BASE_IDENTITY: AuthIdentity = {
    sub: 'google-sub-1',
    email: BASE_EMAIL,
    emailVerified: true,
    name: 'Ada Lovelace',
  };

  function makeDeps(seed: UserItem[]) {
    const fakeUsers = makeFakeUsersRepo(seed);
    const audits: { entityKey: string; eventType: string; payload?: Record<string, unknown> }[] = [];
    const deps = {
      usersRepo: fakeUsers.repo,
      auditRepo: {
        async append(entityKey: string, eventType: string, payload?: Record<string, unknown>) {
          audits.push({ entityKey, eventType, ...(payload !== undefined && { payload }) });
        },
      },
    };
    return { fakeUsers, audits, deps };
  }

  it('first-login (invited) path: forwards identity.name to activateOnLogin and reflects it on returned user', async () => {
    const userId = userIdForEmail(BASE_EMAIL);
    const { fakeUsers, deps } = makeDeps([
      invitedUserItem({ userId, email: BASE_EMAIL, role: 'va' }),
    ]);
    const result = await resolveInvitedUser(deps, BASE_IDENTITY);
    // name forwarded to the repo
    expect(fakeUsers.activateCalls).toHaveLength(1);
    expect(fakeUsers.activateCalls[0]!.name).toBe('Ada Lovelace');
    // name reflected on the returned in-memory user
    expect(result.user.name).toBe('Ada Lovelace');
    expect(result.activated).toBe(true);
  });

  it('already-active path: forwards identity.name to touchLastLogin and reflects it on returned user', async () => {
    const userId = userIdForEmail(BASE_EMAIL);
    const { fakeUsers, deps } = makeDeps([
      {
        userId,
        email: BASE_EMAIL,
        google_sub: 'google-sub-1',
        role: 'va',
        status: 'active' as const,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const result = await resolveInvitedUser(deps, BASE_IDENTITY);
    // name forwarded to the repo
    expect(fakeUsers.touchCalls).toHaveLength(1);
    expect(fakeUsers.touchCalls[0]!.name).toBe('Ada Lovelace');
    // name reflected on the returned in-memory user
    expect(result.user.name).toBe('Ada Lovelace');
    expect(result.activated).toBe(false);
  });

  it('first-login path: name is undefined when identity has no name — login must not fail', async () => {
    const userId = userIdForEmail(BASE_EMAIL);
    const { fakeUsers, deps } = makeDeps([
      invitedUserItem({ userId, email: BASE_EMAIL, role: 'va' }),
    ]);
    // Build identity without the name property at all.
    const { name: _drop, ...noNameIdentity } = BASE_IDENTITY;
    const result = await resolveInvitedUser(deps, noNameIdentity);
    expect(fakeUsers.activateCalls[0]!.name).toBeUndefined();
    expect('name' in result.user).toBe(false);
    expect(result.activated).toBe(true);
  });

  it('active path: name is undefined when identity has no name — login must not fail', async () => {
    const userId = userIdForEmail(BASE_EMAIL);
    const { fakeUsers, deps } = makeDeps([
      {
        userId,
        email: BASE_EMAIL,
        google_sub: 'google-sub-1',
        role: 'va',
        status: 'active' as const,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const { name: _drop, ...noNameIdentity } = BASE_IDENTITY;
    const result = await resolveInvitedUser(deps, noNameIdentity);
    expect(fakeUsers.touchCalls[0]!.name).toBeUndefined();
    expect('name' in result.user).toBe(false);
    expect(result.activated).toBe(false);
  });

  it('audit payload does NOT include name (PII stays minimal — email/role/google_sub only)', async () => {
    const userId = userIdForEmail(BASE_EMAIL);
    const { audits, deps } = makeDeps([
      invitedUserItem({ userId, email: BASE_EMAIL, role: 'va' }),
    ]);
    await resolveInvitedUser(deps, BASE_IDENTITY);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).not.toHaveProperty('name');
    expect(JSON.stringify(audits[0]!)).not.toContain('Ada Lovelace');
  });

  it('log lines do NOT include name in either login branch', async () => {
    const { createLogger } = await import('../src/lib/logger.js');
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });

    // First-login (invited) branch
    const userId1 = userIdForEmail('log-invited@housingchoice.org');
    const fakeUsers1 = makeFakeUsersRepo([
      invitedUserItem({ userId: userId1, email: 'log-invited@housingchoice.org', role: 'va' }),
    ]);
    await resolveInvitedUser(
      { usersRepo: fakeUsers1.repo, auditRepo: { async append() {} }, logger: log },
      { sub: 'sub-1', email: 'log-invited@housingchoice.org', emailVerified: true, name: 'Grace Hopper' },
    );

    // Already-active branch
    const userId2 = userIdForEmail('log-active@housingchoice.org');
    const fakeUsers2 = makeFakeUsersRepo([
      {
        userId: userId2,
        email: 'log-active@housingchoice.org',
        google_sub: 'sub-2',
        role: 'va',
        status: 'active' as const,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    await resolveInvitedUser(
      { usersRepo: fakeUsers2.repo, auditRepo: { async append() {} }, logger: log },
      { sub: 'sub-2', email: 'log-active@housingchoice.org', emailVerified: true, name: 'Grace Hopper' },
    );

    for (const line of capture.lines) {
      expect(JSON.stringify(line)).not.toContain('Grace Hopper');
    }
  });
});
