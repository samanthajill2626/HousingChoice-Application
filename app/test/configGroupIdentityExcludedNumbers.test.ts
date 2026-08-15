// app/test/configGroupIdentityExcludedNumbers.test.ts
//
// GROUP_IDENTITY_EXCLUDED_NUMBERS is part of the group-thread IDENTITY contract
// (spec 4.1): the ids detection mints are derived from the roster left AFTER the
// exclusion set is subtracted, so a number missing from the list mints divergent
// ids for every group it appears in, and a stale/typo'd extra number silently
// subtracts a real member from every roster containing them.
//
// It therefore copies the BUSINESS_PHONE_NUMBER three-tier idiom:
//   1. shape throw  - a PRESENT but malformed entry throws everywhere
//   2. WARN         - unset on a non-production twilio-driver stack
//   3. THROW        - unset on a production twilio-driver stack
// plus the literal `none`, which is how a stack DELIBERATELY asserts "this org
// has no extra numbers" (empty-by-omission is the dangerous default and must be
// impossible to reach silently).
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';

const base = { CF_ORIGIN_SECRET: 's' };

// A fully-valid production env (clears every other fail-fast gate) - copied from
// configRelayLiveProvisioning.test.ts, which is the closest tier-idiom suite.
const prodBase = {
  NODE_ENV: 'production',
  CF_ORIGIN_SECRET: 's',
  MESSAGING_DRIVER: 'twilio',
  EMAIL_DRIVER: 'console',
  JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/hc-test-jobs',
  SCHEDULER_TARGET_ARN: 'arn:aws:sqs:us-east-1:000000000000:hc-test-jobs',
  SCHEDULER_ROLE_ARN: 'arn:aws:iam::000000000000:role/hc-test-scheduler',
  SESSION_SECRET: 'prod-session-secret',
  GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'csecret',
  OAUTH_ALLOWED_DOMAINS: 'housingchoice.org',
  TWILIO_ACCOUNT_SID: 'ACxxx',
  TWILIO_API_KEY_SID: 'SKxxx',
  TWILIO_API_KEY_SECRET: 'secret',
  TWILIO_AUTH_TOKEN: 'token',
  TWILIO_MESSAGING_SERVICE_SID: 'MGxxx',
  TWILIO_CONVERSATIONS_SERVICE_SID: 'ISxxx',
  TWILIO_EVENTS_WEBHOOK_SECRET: 'evsecret',
  BUSINESS_PHONE_NUMBER: '+15555550100',
};

describe('GROUP_IDENTITY_EXCLUDED_NUMBERS - tier 1 (shape)', () => {
  it('parses a comma list into E.164 entries, tolerating whitespace', () => {
    const cfg = loadConfig({
      ...base,
      GROUP_IDENTITY_EXCLUDED_NUMBERS: ' +15555550101, +15555550102 ,+442079460958',
    });
    expect(cfg.groupIdentityExcludedNumbers).toEqual([
      '+15555550101',
      '+15555550102',
      '+442079460958',
    ]);
  });

  it('throws on a malformed entry even outside production', () => {
    expect(() =>
      loadConfig({ ...base, GROUP_IDENTITY_EXCLUDED_NUMBERS: '+15555550101,555-0102' }),
    ).toThrow(/GROUP_IDENTITY_EXCLUDED_NUMBERS/);
  });

  it('throws on a malformed entry in production too (never silently dropped)', () => {
    expect(() =>
      loadConfig({ ...prodBase, GROUP_IDENTITY_EXCLUDED_NUMBERS: 'not-a-number' }),
    ).toThrow(/E\.164/);
  });
});

describe('GROUP_IDENTITY_EXCLUDED_NUMBERS - the `none` assertion', () => {
  it('accepts the literal `none` as an empty list, in production too', () => {
    const cfg = loadConfig({ ...prodBase, GROUP_IDENTITY_EXCLUDED_NUMBERS: 'none' });
    expect(cfg.groupIdentityExcludedNumbers).toEqual([]);
  });

  it('accepts `none` case-insensitively with surrounding whitespace', () => {
    const cfg = loadConfig({ ...base, GROUP_IDENTITY_EXCLUDED_NUMBERS: '  NONE ' });
    expect(cfg.groupIdentityExcludedNumbers).toEqual([]);
  });
});

describe('GROUP_IDENTITY_EXCLUDED_NUMBERS - tiers 2 and 3 (unset)', () => {
  it('THROWS when unset on a production twilio stack', () => {
    const { GROUP_IDENTITY_EXCLUDED_NUMBERS: _omitted, ...withoutVar } = {
      ...prodBase,
      GROUP_IDENTITY_EXCLUDED_NUMBERS: undefined,
    };
    expect(() => loadConfig(withoutVar)).toThrow(/GROUP_IDENTITY_EXCLUDED_NUMBERS/);
  });

  it('THROWS on a production twilio stack when the value is blank (empty-by-omission)', () => {
    expect(() => loadConfig({ ...prodBase, GROUP_IDENTITY_EXCLUDED_NUMBERS: '' })).toThrow(
      /GROUP_IDENTITY_EXCLUDED_NUMBERS/,
    );
  });

  it('does NOT throw when unset on a non-production twilio stack (WARN tier)', () => {
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'development',
      MESSAGING_DRIVER: 'twilio',
      TWILIO_API_BASE_URL: 'http://localhost:8889',
      TWILIO_ACCOUNT_SID: 'ACxxx',
      TWILIO_API_KEY_SID: 'SKxxx',
      TWILIO_API_KEY_SECRET: 'secret',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_MESSAGING_SERVICE_SID: 'MGxxx',
  TWILIO_CONVERSATIONS_SERVICE_SID: 'ISxxx',
    });
    expect(cfg.groupIdentityExcludedNumbers).toEqual([]);
  });

  it('does NOT throw when unset on a console-driver stack', () => {
    const cfg = loadConfig({ ...base, MESSAGING_DRIVER: 'console' });
    expect(cfg.groupIdentityExcludedNumbers).toEqual([]);
  });
});
