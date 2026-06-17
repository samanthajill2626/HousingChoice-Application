// AuthProvider — the ONLY place openid-client is imported (adapter rule).
//
// THE THIN SEAM (doc mandate): routes/auth.ts talks exclusively to the
// AuthProvider interface below — build-redirect + exchange-code, nothing
// provider-shaped leaks past AuthIdentity. Swapping Google for Cognito's
// hosted UI later means one new createXxxAuthProvider() here; routes,
// middleware, sessions and the users table do not change.
//
// Google specifics live only in this file: the accounts.google.com issuer
// (discovery is fetched lazily on first login and cached; a failure clears
// the cache so the next attempt retries), authorization-code flow with PKCE
// (S256) + state, and the `hd` hosted-domain claim surfaced for the
// allowlist's corroboration check.
import * as oidc from 'openid-client';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';

/** What GET /auth/login needs: where to send the browser + what to remember. */
export interface AuthorizationRequest {
  /** The provider authorization URL to 302 the browser to. */
  url: string;
  /** CSRF state — sealed into the short-lived oauth cookie, verified on callback. */
  state: string;
  /** PKCE code verifier — sealed alongside state, replayed at the token exchange. */
  codeVerifier: string;
}

/** The verified identity a completed login yields — all the routes ever see. */
export interface AuthIdentity {
  /** Provider-stable subject (Google OIDC `sub`). */
  sub: string;
  /** Login email, lowercased. */
  email: string;
  /** Provider's email-verification assertion — unverified emails are refused upstream. */
  emailVerified: boolean;
  /**
   * Google Workspace hosted domain (`hd` claim) — present only for Workspace
   * accounts. The allowlist treats the email domain as authoritative and
   * this as corroboration (routes/auth.ts).
   */
  hostedDomain?: string;
  /**
   * Freeform Google profile display name (`name` claim from the `profile` scope).
   * Absent when the claim is not granted, empty, or blank. Trimmed and capped at
   * 120 characters by the adapter — callers receive a non-empty string or nothing.
   * NEVER logged (PII posture, doc §9).
   */
  name?: string;
}

export interface AuthProvider {
  /** Begin a login: build the provider redirect plus the per-attempt secrets. */
  startLogin(redirectUri: string): Promise<AuthorizationRequest>;
  /**
   * Complete a login: exchange the callback's code (verifying state + PKCE)
   * for a verified identity. Throws on any provider/verification failure —
   * the route maps every throw to a 400, details to the log only.
   */
  completeLogin(
    callbackUrl: URL,
    expected: { state: string; codeVerifier: string },
  ): Promise<AuthIdentity>;
}

export interface GoogleAuthProviderOptions {
  clientId: string;
  clientSecret: string;
  logger?: Logger;
  /** Test seam: issuer override (never used in production). */
  issuer?: string;
}

const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_SCOPE = 'openid email profile';

export function createGoogleAuthProvider(opts: GoogleAuthProviderOptions): AuthProvider {
  const log = opts.logger ?? defaultLogger;
  const issuer = opts.issuer ?? GOOGLE_ISSUER;

  // Lazy, cached discovery: no network at construction (buildApp must stay
  // offline-constructible), one metadata fetch per process on the first
  // login, and a failed fetch is NOT cached so the next login retries.
  let discovered: Promise<oidc.Configuration> | undefined;
  function configuration(): Promise<oidc.Configuration> {
    discovered ??= oidc
      .discovery(new URL(issuer), opts.clientId, opts.clientSecret)
      .catch((err: unknown) => {
        discovered = undefined;
        throw err;
      });
    return discovered;
  }

  return {
    async startLogin(redirectUri) {
      const config = await configuration();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const state = oidc.randomState();
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: GOOGLE_SCOPE,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return { url: url.href, state, codeVerifier };
    },

    async completeLogin(callbackUrl, expected) {
      const config = await configuration();
      // Verifies state, exchanges the code with the PKCE verifier, and
      // validates the ID token (signature, iss, aud, exp) per OIDC.
      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        expectedState: expected.state,
        pkceCodeVerifier: expected.codeVerifier,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error('token response carried no ID token claims');
      const { sub } = claims;
      const email = claims['email'];
      if (typeof email !== 'string' || email.length === 0) {
        throw new Error('ID token carried no email claim (is the email scope granted?)');
      }
      const hostedDomain = claims['hd'];
      const rawName = claims['name'];
      const name =
        typeof rawName === 'string' && rawName.trim().length > 0
          ? rawName.trim().slice(0, 120)
          : undefined;
      const identity: AuthIdentity = {
        sub,
        email: email.trim().toLowerCase(),
        emailVerified: claims['email_verified'] === true,
        ...(typeof hostedDomain === 'string' && hostedDomain.length > 0
          ? { hostedDomain: hostedDomain.toLowerCase() }
          : {}),
        ...(name !== undefined && { name }),
      };
      // sub only — emails and names stay out of logs (PII posture, doc §9).
      log.info({ sub }, 'oauth code exchange completed');
      return identity;
    },
  };
}
