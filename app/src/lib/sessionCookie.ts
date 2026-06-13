// Sealed (encrypted + authenticated) cookie tokens — the M1.3 app-managed
// session primitive, plus the short-lived OAuth state cookie.
//
// Format: `v1.<iv>.<ciphertext>.<tag>` (base64url segments). AES-256-GCM —
// one primitive gives both confidentiality AND integrity (the GCM tag is the
// signature: any tampered bit fails decryption, so "signed+encrypted" needs
// no separate HMAC). The key is derived from SESSION_SECRET via HKDF-SHA256,
// so the raw secret never doubles as key material.
//
// open() returns undefined for ANYTHING invalid — wrong shape, bad base64,
// failed auth tag (tamper), expired, wrong purpose — never throws on attacker
// input. The expiry lives INSIDE the sealed envelope (iat/exp), so a client
// cannot extend its own session by editing cookie attributes. A `purpose`
// discriminator is ALSO sealed inside: both cookies share one secret, so
// without it a sealed OAuth-state token would open as a (garbage) session
// token and vice versa — open() rejects any purpose mismatch outright.
//
// Pure crypto + parsing only: no Express types, no config reads — unit-tested
// offline in app/test/sessionCookie.test.ts.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** The session cookie (7-day rolling — middleware/auth.ts re-issues it). */
export const SESSION_COOKIE_NAME = 'hc_session';

/** The short-lived OAuth state/PKCE cookie set by GET /auth/login. */
export const OAUTH_STATE_COOKIE_NAME = 'hc_oauth';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_SALT = 'hc-cookie';
const HKDF_INFO = 'hc-sealed-cookie-v1';

// One derived key per secret per process (the app uses exactly one secret;
// tests use a couple). hkdfSync is cheap but not free on every request.
const keyCache = new Map<string, Buffer>();

function deriveKey(secret: string): Buffer {
  let key = keyCache.get(secret);
  if (!key) {
    key = Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO, 32));
    keyCache.set(secret, key);
  }
  return key;
}

/**
 * What a sealed token is FOR — sealed inside the envelope so the two cookie
 * kinds (which share SESSION_SECRET) can never be replayed as each other.
 */
export type SealedPurpose = 'session' | 'oauth';

/** What seal() encrypts: caller data plus the tamper-proof validity window. */
interface SealedEnvelope {
  p: SealedPurpose;
  d: Record<string, unknown>;
  iat: number; // epoch ms
  exp: number; // epoch ms
}

export interface SealOptions {
  /** SESSION_SECRET (config.sessionSecret). */
  secret: string;
  /** What the token is for; open() rejects any mismatch. */
  purpose: SealedPurpose;
  /** Validity window; exp = now + ttlMs, sealed into the token. */
  ttlMs: number;
  /** Test seam: clock override (epoch ms). */
  now?: number;
}

/** Seal data into an encrypted, authenticated, expiring, purpose-tagged token. */
export function seal(data: Record<string, unknown>, opts: SealOptions): string {
  const now = opts.now ?? Date.now();
  const envelope: SealedEnvelope = { p: opts.purpose, d: data, iat: now, exp: now + opts.ttlMs };
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(opts.secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(envelope), 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

export interface OpenedToken {
  data: Record<string, unknown>;
  /** When the token was sealed (epoch ms) — drives the rolling refresh. */
  issuedAt: number;
  expiresAt: number;
}

/**
 * Open a sealed token. Returns undefined for anything invalid — malformed,
 * tampered (auth-tag failure), wrong secret, wrong purpose, or expired.
 * Never throws on attacker-shaped input.
 */
export function open(
  token: string,
  secret: string,
  purpose: SealedPurpose,
  now = Date.now(),
): OpenedToken | undefined {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return undefined;
  try {
    const iv = Buffer.from(parts[1] as string, 'base64url');
    const ciphertext = Buffer.from(parts[2] as string, 'base64url');
    const tag = Buffer.from(parts[3] as string, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return undefined;
    const decipher = createDecipheriv(ALGORITHM, deriveKey(secret), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const envelope: unknown = JSON.parse(plaintext.toString('utf8'));
    if (typeof envelope !== 'object' || envelope === null) return undefined;
    const { p, d, iat, exp } = envelope as Partial<SealedEnvelope>;
    if (p !== purpose) return undefined; // cross-purpose replay (e.g. oauth token as session)
    if (typeof d !== 'object' || d === null || Array.isArray(d)) return undefined;
    if (typeof iat !== 'number' || typeof exp !== 'number') return undefined;
    if (now >= exp) return undefined;
    return { data: d, issuedAt: iat, expiresAt: exp };
  } catch {
    // bad base64 / auth-tag failure / non-JSON plaintext — all just "invalid"
    return undefined;
  }
}

/**
 * Minimal Cookie-header parser (first occurrence wins, names verbatim).
 * Express has res.cookie() for SETTING cookies but no built-in request
 * parser; sessions only need this one read, so no cookie-parser dependency.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name.length === 0 || name in cookies) continue;
    let value = pair.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value; // not URL-encoded — keep verbatim
    }
  }
  return cookies;
}
