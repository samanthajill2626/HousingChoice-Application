// app/test/configEmail.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';

const base = { CF_ORIGIN_SECRET: 's' };

// Full production wiring so loadConfig gets past the CF/job-delivery/auth
// fail-fast gates (mirror configAiExtraction.test.ts's prodBase). The email
// driver default (ses) then still needs a sender identity.
const prodBase = {
  NODE_ENV: 'production',
  CF_ORIGIN_SECRET: 's',
  MESSAGING_DRIVER: 'console',
  JOBS_QUEUE_URL: 'https://sqs.example/q',
  SCHEDULER_TARGET_ARN: 'arn:aws:sqs:us-east-1:0:q',
  SCHEDULER_ROLE_ARN: 'arn:aws:iam::0:role/r',
  SESSION_SECRET: 'a-real-prod-session-secret',
  GOOGLE_CLIENT_ID: 'gid',
  GOOGLE_CLIENT_SECRET: 'gsecret',
  OAUTH_ALLOWED_DOMAINS: 'example.org',
};
// prod wiring WITH the SES sender identity present (driver 'ses' boots clean).
const prodEmail = {
  ...prodBase,
  EMAIL_SENDER_DOMAIN: 'mail.housingchoice.org',
  EMAIL_FROM_ADDRESS: 'team@mail.housingchoice.org',
};

describe('EMAIL_DRIVER config', () => {
  it('defaults to console for local NODE_ENVs', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development' });
    expect(cfg.emailDriver).toBe('console');
  });

  it('defaults to ses when deployed (NODE_ENV=production)', () => {
    const cfg = loadConfig({ ...prodEmail });
    expect(cfg.emailDriver).toBe('ses');
  });

  it('honors an explicit EMAIL_DRIVER override', () => {
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'development',
      EMAIL_DRIVER: 'ses',
      EMAIL_SENDER_DOMAIN: 'mail.x.org',
      EMAIL_FROM_ADDRESS: 'team@mail.x.org',
    });
    expect(cfg.emailDriver).toBe('ses');
  });

  it('rejects an unknown EMAIL_DRIVER value', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'development', EMAIL_DRIVER: 'bogus' })).toThrow(
      /EMAIL_DRIVER must be/,
    );
  });
});

describe('EMAIL_DRIVER=ses sender-identity gate', () => {
  it('throws when the ses driver is missing EMAIL_SENDER_DOMAIN + EMAIL_FROM_ADDRESS', () => {
    expect(() => loadConfig({ ...prodBase })).toThrow(/EMAIL_DRIVER=ses requires/);
  });

  it('names the still-missing EMAIL_FROM_ADDRESS when only the domain is set', () => {
    expect(() => loadConfig({ ...prodBase, EMAIL_SENDER_DOMAIN: 'mail.x.org' })).toThrow(
      /EMAIL_FROM_ADDRESS/,
    );
  });

  it('boots and exposes the trimmed sender identity when both are present', () => {
    const cfg = loadConfig({ ...prodEmail });
    expect(cfg.emailSenderDomain).toBe('mail.housingchoice.org');
    expect(cfg.emailFromAddress).toBe('team@mail.housingchoice.org');
  });

  it('does NOT require a sender identity for the console driver', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development' });
    expect(cfg.emailDriver).toBe('console');
    expect(cfg.emailSenderDomain).toBeUndefined();
    expect(cfg.emailFromAddress).toBeUndefined();
  });
});

describe('EMAIL_SENDING_ENABLED kill-switch', () => {
  it('defaults ON with the console driver (local/test)', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development' });
    expect(cfg.emailSendingEnabled).toBe(true);
  });

  it('defaults OFF with the ses driver (deployed)', () => {
    const cfg = loadConfig({ ...prodEmail });
    expect(cfg.emailSendingEnabled).toBe(false);
  });

  it('parses truthy overrides (true/1/yes)', () => {
    for (const v of ['true', '1', 'yes', 'TRUE']) {
      expect(loadConfig({ ...prodEmail, EMAIL_SENDING_ENABLED: v }).emailSendingEnabled).toBe(true);
    }
  });

  it('parses falsy overrides (false/0/no)', () => {
    for (const v of ['false', '0', 'no']) {
      expect(
        loadConfig({ ...base, NODE_ENV: 'development', EMAIL_SENDING_ENABLED: v }).emailSendingEnabled,
      ).toBe(false);
    }
  });

  it('warns and falls back to the default on an unparseable value', () => {
    // console driver default is ON; a garbage value keeps the default (no crash).
    const cfg = loadConfig({ ...base, NODE_ENV: 'development', EMAIL_SENDING_ENABLED: 'maybe' });
    expect(cfg.emailSendingEnabled).toBe(true);
  });
});

describe('SES_API_BASE_URL (SECURITY-CRITICAL dev-only override)', () => {
  it('is read in non-production', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development', SES_API_BASE_URL: 'http://localhost:8890' });
    expect(cfg.sesApiBaseUrl).toBe('http://localhost:8890');
  });

  it('defaults to undefined when unset', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development' });
    expect(cfg.sesApiBaseUrl).toBeUndefined();
  });

  it('is REJECTED (throws) when set in production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', SES_API_BASE_URL: 'http://evil', MESSAGING_DRIVER: 'console' }),
    ).toThrow(/SES_API_BASE_URL/);
  });

  it('throws a clear error in non-production when set to a malformed URL', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'development', SES_API_BASE_URL: 'not a url' }),
    ).toThrow(/SES_API_BASE_URL must be a valid URL/);
  });

  it('prod-rejection fires even when the value is a malformed URL (prod check wins)', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', SES_API_BASE_URL: 'not a url', MESSAGING_DRIVER: 'console' }),
    ).toThrow(/refusing to start/);
  });
});

describe('inbound-mail pass-through (Phase B)', () => {
  it('reads INBOUND_MAIL_BUCKET + INBOUND_MAIL_QUEUE_URL when set', () => {
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'development',
      INBOUND_MAIL_BUCKET: 'hc-local-inbound-mail',
      INBOUND_MAIL_QUEUE_URL: 'https://sqs.example/inbound',
    });
    expect(cfg.inboundMailBucket).toBe('hc-local-inbound-mail');
    expect(cfg.inboundMailQueueUrl).toBe('https://sqs.example/inbound');
  });

  it('defaults both to undefined when unset', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development' });
    expect(cfg.inboundMailBucket).toBeUndefined();
    expect(cfg.inboundMailQueueUrl).toBeUndefined();
  });
});
