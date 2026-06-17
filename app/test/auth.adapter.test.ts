// Unit tests for createGoogleAuthProvider.completeLogin — name claim capture.
// (Task 2: profile scope + name claim extraction + PII posture verification.)
//
// Isolated from the integration test in auth.test.ts so we can use vi.mock on
// openid-client without affecting the rest of the auth suite. The ESM module
// namespace is immutable so spying must be done via vi.mock + vi.hoisted().
//
// These tests drive the REAL claim-extraction code path in auth.ts (trim,
// length-cap at 120, absent/blank → undefined).
import { describe, expect, it, vi } from 'vitest';

// vi.hoisted runs before module resolution so the factory can reference the
// returned values without temporal-dead-zone errors.
const { mockDiscovery, mockAuthorizationCodeGrant } = vi.hoisted(() => ({
  mockDiscovery: vi.fn(),
  mockAuthorizationCodeGrant: vi.fn(),
}));

vi.mock('openid-client', () => ({
  discovery: mockDiscovery,
  authorizationCodeGrant: mockAuthorizationCodeGrant,
  randomPKCECodeVerifier: vi.fn().mockResolvedValue('verifier'),
  calculatePKCECodeChallenge: vi.fn().mockResolvedValue('challenge'),
  randomState: vi.fn().mockReturnValue('state'),
  buildAuthorizationUrl: vi.fn().mockReturnValue(new URL('https://provider.example/auth')),
}));

// Import AFTER vi.mock so the adapter picks up the stubbed module.
import { createGoogleAuthProvider } from '../src/adapters/auth.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

/** Build a provider and run completeLogin using the given claims map. */
async function completeWithClaims(
  claims: Record<string, unknown>,
  opts: { logCapture?: ReturnType<typeof createLogCapture> } = {},
) {
  // discovery: return a minimal config placeholder (never network).
  mockDiscovery.mockResolvedValueOnce({});
  // authorizationCodeGrant: return a token-like object with the provided claims.
  mockAuthorizationCodeGrant.mockResolvedValueOnce({ claims: () => claims });

  const log = opts.logCapture
    ? createLogger({ level: 'info', destination: opts.logCapture.stream })
    : undefined;

  const provider = createGoogleAuthProvider({
    clientId: 'cid',
    clientSecret: 'csecret',
    issuer: 'https://fake-issuer.example',
    ...(log !== undefined && { logger: log }),
  });

  return provider.completeLogin(
    new URL('https://app.example/auth/callback?code=x&state=s'),
    { state: 's', codeVerifier: 'v' },
  );
}

describe('createGoogleAuthProvider — completeLogin name claim capture', () => {
  it('trims a padded name claim and includes it on the identity', async () => {
    const identity = await completeWithClaims({
      sub: 'sub-1', email: 'user@example.com', email_verified: true,
      name: '  Ada Lovelace  ',
    });
    expect(identity.name).toBe('Ada Lovelace');
  });

  it('omits name (absent from object) when the claim is absent', async () => {
    const identity = await completeWithClaims({
      sub: 'sub-1', email: 'user@example.com', email_verified: true,
    });
    expect(identity.name).toBeUndefined();
    expect('name' in identity).toBe(false);
  });

  it('omits name when the claim is blank/whitespace-only', async () => {
    const identity = await completeWithClaims({
      sub: 'sub-1', email: 'user@example.com', email_verified: true,
      name: '   ',
    });
    expect(identity.name).toBeUndefined();
    expect('name' in identity).toBe(false);
  });

  it('caps an overlong name at 120 characters', async () => {
    const identity = await completeWithClaims({
      sub: 'sub-1', email: 'user@example.com', email_verified: true,
      name: 'A'.repeat(200),
    });
    expect(identity.name).toBe('A'.repeat(120));
  });

  it('login succeeds (email + sub unchanged) when name claim is absent', async () => {
    const identity = await completeWithClaims({
      sub: 'sub-missing-name', email: 'noname@example.com', email_verified: true,
    });
    expect(identity.email).toBe('noname@example.com');
    expect(identity.sub).toBe('sub-missing-name');
    expect(identity.name).toBeUndefined();
  });

  it('login succeeds when name claim is blank — email is the fallback, no throw', async () => {
    const identity = await completeWithClaims({
      sub: 'sub-blank', email: 'blank@example.com', email_verified: true,
      name: '   ',
    });
    expect(identity.email).toBe('blank@example.com');
    expect(identity.name).toBeUndefined();
  });

  it('log.info carries sub only — name NEVER appears in log output (PII posture)', async () => {
    const cap = createLogCapture();
    await completeWithClaims({
      sub: 'sub-pii', email: 'pii@example.com', email_verified: true,
      name: 'Grace Hopper',
    }, { logCapture: cap });

    // The adapter emits exactly one info line ("oauth code exchange completed").
    const infoLines = cap.lines.filter((l) => l['level'] === 30);
    expect(infoLines.length).toBeGreaterThan(0);
    for (const line of infoLines) {
      const raw = JSON.stringify(line);
      expect(raw).toContain('sub-pii');           // sub is logged
      expect(raw).not.toContain('Grace Hopper');  // name is NOT
      expect(raw).not.toContain('"name"');         // field not present
    }
  });
});
