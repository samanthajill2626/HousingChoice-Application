// /auth router (M1.3) — Google OAuth login (authorization-code + PKCE via
// the AuthProvider seam), app-managed sealed-cookie sessions, /auth/me.
//
// Mounted in the ROUTE stage of the locked chain (app.ts stage 4): every
// request here has already passed the CloudFront origin-secret validator.
//
//   GET  /auth/login     → 302 to Google; state+PKCE sealed into a short-
//                          lived cookie (the browser is the only state store)
//   GET  /auth/callback  → verify state/PKCE, exchange code, enforce the
//                          domain allowlist, find-or-create the user, set the
//                          session cookie, redirect /
//   POST /auth/logout    → clear the session cookie (204)
//   GET  /auth/me        → { userId, email, role } | 401
//
// ALLOWLIST DECISION (documented per the M1.3 brief): the EMAIL DOMAIN is
// authoritative — it must be on config.oauthAllowedDomains. The Google `hd`
// (hosted domain) claim is corroboration: absent is acceptable (hd is not
// guaranteed on every account shape), but when present it must ALSO be on
// the allowlist — a mismatch is a refusal. email_verified must be true.
// Empty allowlist = nobody logs in.
import { Router } from 'express';
import { createGoogleAuthProvider, type AuthIdentity, type AuthProvider } from '../adapters/auth.js';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  open,
  parseCookies,
  seal,
  OAUTH_STATE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '../lib/sessionCookie.js';
import {
  sealSession,
  sessionCookieOptions,
  sessionMiddleware,
  type AuthedRequest,
} from '../middleware/auth.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { createUsersRepo, type UsersRepo } from '../repos/usersRepo.js';
import { findOrCreateUser } from '../services/userProvisioning.js';

/** The login attempt's lifetime: state cookie sealed for 10 minutes. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export type RefusalReason = 'email_unverified' | 'domain_not_allowed';

/**
 * The allowlist gate (pure — unit-tested directly). See the module header
 * for the email-domain-authoritative / hd-corroboration decision.
 */
export function evaluateIdentity(
  identity: AuthIdentity,
  allowedDomains: readonly string[],
): { allowed: true } | { allowed: false; reason: RefusalReason } {
  if (!identity.emailVerified) return { allowed: false, reason: 'email_unverified' };
  const at = identity.email.lastIndexOf('@');
  const emailDomain = at >= 0 ? identity.email.slice(at + 1).toLowerCase() : '';
  if (emailDomain.length === 0 || !allowedDomains.includes(emailDomain)) {
    return { allowed: false, reason: 'domain_not_allowed' };
  }
  if (identity.hostedDomain !== undefined && !allowedDomains.includes(identity.hostedDomain)) {
    return { allowed: false, reason: 'domain_not_allowed' };
  }
  return { allowed: true };
}

/** Where Google sends the browser back: `${PUBLIC_BASE_URL}/auth/callback` (localhost:PORT locally). */
export function callbackRedirectUri(config: AppConfig): string {
  const base = config.publicBaseUrl ?? `http://localhost:${config.port}`;
  return `${base.replace(/\/+$/, '')}/auth/callback`;
}

const DOMAIN_NOT_ALLOWED_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>HousingChoice — not allowed</title></head>
<body style="font-family: system-ui, sans-serif; text-align: center; padding: 4rem 2rem;">
<h1 style="font-size:1.5rem">Domain not allowed</h1>
<p>Your Google account's domain is not authorized for HousingChoice.</p>
<p><a href="/auth/login">Try a different account</a></p>
</body></html>`;

export interface AuthRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  /** Test seam: a fake provider — openid-client is never hit in tests. */
  authProvider?: AuthProvider;
  usersRepo?: UsersRepo;
  auditRepo?: AuditRepo;
}

export function createAuthRouter(deps: AuthRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const usersRepo = deps.usersRepo ?? createUsersRepo({ logger: deps.logger });
  const auditRepo = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });

  // The real provider exists only when OAuth is configured; the injected
  // fake wins regardless (so tests need no client credentials).
  const provider: AuthProvider | undefined =
    deps.authProvider ??
    (config.googleClientId && config.googleClientSecret
      ? createGoogleAuthProvider({
          clientId: config.googleClientId,
          clientSecret: config.googleClientSecret,
          logger: log,
        })
      : undefined);

  const redirectUri = callbackRedirectUri(config);
  const stateCookieOptions = {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax' as const,
    path: '/auth', // only login/callback ever see it
    maxAge: OAUTH_STATE_TTL_MS,
  };

  const router = Router();

  // GET /auth/login — begin the authorization-code + PKCE flow.
  router.get('/login', async (_req, res) => {
    if (!provider) {
      res.status(503).json({
        error: 'oauth_not_configured',
        detail: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set',
      });
      return;
    }
    const { url, state, codeVerifier } = await provider.startLogin(redirectUri);
    // The per-attempt secrets ride a sealed cookie — same primitive as the
    // session, 10-minute TTL, scoped to /auth.
    const stateToken = seal(
      { state, codeVerifier },
      { secret: config.sessionSecret, ttlMs: OAUTH_STATE_TTL_MS },
    );
    res.cookie(OAUTH_STATE_COOKIE_NAME, stateToken, stateCookieOptions);
    res.redirect(url);
  });

  // GET /auth/callback — Google sends the browser back here.
  router.get('/callback', async (req, res) => {
    res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: '/auth' }); // one shot either way
    if (!provider) {
      res.status(503).json({ error: 'oauth_not_configured' });
      return;
    }

    const stateToken = parseCookies(req.headers.cookie)[OAUTH_STATE_COOKIE_NAME];
    const opened = stateToken !== undefined ? open(stateToken, config.sessionSecret) : undefined;
    const state = opened?.data['state'];
    const codeVerifier = opened?.data['codeVerifier'];
    if (typeof state !== 'string' || typeof codeVerifier !== 'string') {
      // Missing/expired/tampered state cookie — a stale or forged attempt.
      res.status(400).json({ error: 'login_expired', detail: 'restart at /auth/login' });
      return;
    }

    let identity: AuthIdentity;
    try {
      identity = await provider.completeLogin(new URL(req.originalUrl, redirectUri), {
        state,
        codeVerifier,
      });
    } catch (err) {
      // State mismatch, code replay, provider error… — details to the log,
      // a generic 400 to the browser.
      log.warn({ err }, 'oauth code exchange failed');
      res.status(400).json({ error: 'login_failed', detail: 'restart at /auth/login' });
      return;
    }

    const verdict = evaluateIdentity(identity, config.oauthAllowedDomains);
    if (!verdict.allowed) {
      // Domains only in the log line — never the email (PII posture, §9).
      log.warn(
        {
          reason: verdict.reason,
          emailDomain: identity.email.slice(identity.email.lastIndexOf('@') + 1),
          hostedDomain: identity.hostedDomain ?? null,
        },
        'login refused by domain allowlist',
      );
      if (req.accepts(['json', 'html']) === 'html') {
        res.status(403).type('html').send(DOMAIN_NOT_ALLOWED_HTML);
      } else {
        res.status(403).json({ error: 'domain_not_allowed' });
      }
      return;
    }

    const { user } = await findOrCreateUser({ usersRepo, auditRepo, logger: log }, identity);
    res.cookie(
      SESSION_COOKIE_NAME,
      sealSession({ userId: user.userId, email: user.email, role: user.role }, config),
      sessionCookieOptions(config),
    );
    res.redirect('/');
  });

  // POST /auth/logout — drop the session. POST (not GET) so prefetchers and
  // link scanners can never log anyone out.
  router.post('/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.status(204).end();
  });

  // GET /auth/me — who am I (the dashboard shell's session probe).
  router.get(
    '/me',
    sessionMiddleware({ config, usersRepo, ...(deps.logger !== undefined && { logger: deps.logger }) }),
    (req: AuthedRequest, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      res.json(req.user);
    },
  );

  return router;
}
