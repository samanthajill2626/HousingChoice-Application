// M1.4: VAPID config parsing + the webPush adapter factory gate.
//   - isPushConfigured is true only when ALL THREE VAPID values are present
//   - VAPID_SUBJECT must be a mailto:/https: URI (loadConfig fails fast)
//   - createWebPushAdapter returns undefined when push is off, an adapter when on
//   - a malformed VAPID key does NOT crash adapter construction (push is a
//     feature, not core — bad keys surface at send time, never at boot)
import { describe, expect, it } from 'vitest';
import { createWebPushAdapter, isAllowedPushEndpoint } from '../src/adapters/webPush.js';
import { isPushConfigured, loadConfig } from '../src/lib/config.js';

const ALL = {
  NODE_ENV: 'test',
  VAPID_PUBLIC_KEY: 'public',
  VAPID_PRIVATE_KEY: 'private',
  VAPID_SUBJECT: 'mailto:ops@housingchoice.org',
} as NodeJS.ProcessEnv;

describe('VAPID config', () => {
  it('isPushConfigured is false unless all three values are present', () => {
    expect(isPushConfigured(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv))).toBe(false);
    expect(
      isPushConfigured(
        loadConfig({ NODE_ENV: 'test', VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b' } as NodeJS.ProcessEnv),
      ),
    ).toBe(false); // missing subject
    expect(isPushConfigured(loadConfig(ALL))).toBe(true);
  });

  it('production does NOT fail fast on unset VAPID (push is a feature)', () => {
    // The other production fail-fast keys are present in this env; VAPID is NOT
    // — loadConfig must still succeed (push off, app boots).
    const cfg = loadConfig({
      NODE_ENV: 'production',
      CF_ORIGIN_SECRET: 'x',
      JOBS_QUEUE_URL: 'q',
      SCHEDULER_TARGET_ARN: 't',
      SCHEDULER_ROLE_ARN: 'r',
      SESSION_SECRET: 'not-the-placeholder',
      GOOGLE_CLIENT_ID: 'g',
      GOOGLE_CLIENT_SECRET: 's',
      OAUTH_ALLOWED_DOMAINS: 'housingchoice.org',
      MESSAGING_DRIVER: 'console',
    } as NodeJS.ProcessEnv);
    expect(isPushConfigured(cfg)).toBe(false);
  });

  it('VAPID_SUBJECT must be a mailto:/https: URI', () => {
    expect(() =>
      loadConfig({ ...ALL, VAPID_SUBJECT: 'ops@housingchoice.org' } as NodeJS.ProcessEnv),
    ).toThrowError(/VAPID_SUBJECT/);
    // mailto: and https: are accepted.
    expect(() => loadConfig({ ...ALL, VAPID_SUBJECT: 'https://housingchoice.org' } as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe('isAllowedPushEndpoint (C1 SSRF allowlist)', () => {
  it('accepts the known web-push vendor hosts', () => {
    for (const url of [
      'https://fcm.googleapis.com/fcm/send/abc123', // FCM
      'https://updates.push.services.mozilla.com/wpush/v2/xyz', // Mozilla autopush
      'https://db5p.notify.windows.com/w/?token=abc', // WNS
      'https://web.push.apple.com/QABC123', // Apple
      'https://push.services.mozilla.com/abc', // mozilla.com subdomain
      'https://updates.push.services.mozaws.net/abc', // mozaws.net (Mozilla)
    ]) {
      expect(isAllowedPushEndpoint(url), url).toBe(true);
    }
  });

  it('rejects internal/loopback/private/attacker hosts and non-https', () => {
    for (const url of [
      'https://169.254.169.254/latest/meta-data/', // cloud metadata (SSRF classic)
      'https://localhost/x',
      'http://localhost/x',
      'https://127.0.0.1/x',
      'https://10.0.0.5/x', // RFC-1918
      'https://192.168.1.1/x',
      'https://[::1]/x', // IPv6 loopback
      'https://attacker.example.com/collect', // arbitrary host
      'http://fcm.googleapis.com/fcm/send/abc', // right host, wrong scheme
      'https://googleapis.com.attacker.com/x', // suffix-spoof: NOT a googleapis.com subdomain
      'https://notgoogleapis.com/x', // substring, not a suffix match
      'ftp://fcm.googleapis.com/x',
      'not a url',
      '',
    ]) {
      expect(isAllowedPushEndpoint(url), url).toBe(false);
    }
  });
});

describe('createWebPushAdapter', () => {
  it('returns undefined when push is off', () => {
    expect(createWebPushAdapter(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv))).toBeUndefined();
  });

  it('returns an adapter when configured — even with a malformed key (no boot crash)', () => {
    // Keys are obviously not real VAPID keys; construction must NOT validate
    // (that would crash boot). The adapter is created; a bad key would only
    // fail an actual send.
    const adapter = createWebPushAdapter(loadConfig(ALL));
    expect(adapter).toBeDefined();
    expect(typeof adapter?.sendToSubscription).toBe('function');
  });
});
