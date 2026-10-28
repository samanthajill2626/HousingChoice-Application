// app/test/configAiExtraction.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig, parseExtractionFactMinConfidence } from '../src/lib/config.js';

const base = { CF_ORIGIN_SECRET: 's' };

// Full production wiring so loadConfig gets past the CF/job-delivery/auth
// fail-fast gates; extraction defaults (disabled in prod) then need no key.
// EMAIL_DRIVER=console neutralizes the email-channel-v1 ses sender-identity
// gate (ses is the email default in production).
const prodBase = {
  NODE_ENV: 'production',
  CF_ORIGIN_SECRET: 's',
  MESSAGING_DRIVER: 'console',
  EMAIL_DRIVER: 'console',
  JOBS_QUEUE_URL: 'https://sqs.example/q',
  SCHEDULER_TARGET_ARN: 'arn:aws:sqs:us-east-1:0:q',
  SCHEDULER_ROLE_ARN: 'arn:aws:iam::0:role/r',
  SESSION_SECRET: 'a-real-prod-session-secret',
  GOOGLE_CLIENT_ID: 'gid',
  GOOGLE_CLIENT_SECRET: 'gsecret',
  OAUTH_ALLOWED_DOMAINS: 'example.org',
};

describe('AI extraction config', () => {
  it('applies development defaults (enabled, console driver, model, debounce)', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development' });
    expect(cfg.aiExtractionEnabled).toBe(true);
    expect(cfg.extractionDriver).toBe('console');
    expect(cfg.aiExtractionModel).toBe('claude-opus-4-8');
    expect(cfg.aiExtractionDebounceMs).toBe(30000);
    expect(cfg.anthropicApiKey).toBeUndefined();
    expect(cfg.anthropicApiBaseUrl).toBeUndefined();
  });

  it('applies production defaults (disabled, anthropic driver)', () => {
    const cfg = loadConfig({ ...prodBase });
    expect(cfg.aiExtractionEnabled).toBe(false);
    expect(cfg.extractionDriver).toBe('anthropic');
    expect(cfg.aiExtractionModel).toBe('claude-opus-4-8');
    expect(cfg.aiExtractionDebounceMs).toBe(30000);
  });

  it('honors explicit overrides', () => {
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'development',
      AI_EXTRACTION_ENABLED: 'false',
      EXTRACTION_DRIVER: 'fake',
      AI_EXTRACTION_MODEL: 'claude-test-model',
      AI_EXTRACTION_DEBOUNCE_MS: '5000',
      ANTHROPIC_API_KEY: 'sk-test-key',
      ANTHROPIC_API_BASE_URL: 'http://localhost:1234',
    });
    expect(cfg.aiExtractionEnabled).toBe(false);
    expect(cfg.extractionDriver).toBe('fake');
    expect(cfg.aiExtractionModel).toBe('claude-test-model');
    expect(cfg.aiExtractionDebounceMs).toBe(5000);
    expect(cfg.anthropicApiKey).toBe('sk-test-key');
    expect(cfg.anthropicApiBaseUrl).toBe('http://localhost:1234');
  });

  it('rejects an unknown EXTRACTION_DRIVER value', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'development', EXTRACTION_DRIVER: 'bogus' }),
    ).toThrow(/EXTRACTION_DRIVER/);
  });

  it('rejects EXTRACTION_DRIVER=fake in production', () => {
    expect(() => loadConfig({ ...prodBase, EXTRACTION_DRIVER: 'fake' })).toThrow(
      /EXTRACTION_DRIVER=fake/,
    );
  });

  it('throws when enabled + anthropic driver + no key in production', () => {
    expect(() => loadConfig({ ...prodBase, AI_EXTRACTION_ENABLED: 'true' })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it('does NOT throw when enabled + anthropic driver + key present in production', () => {
    const cfg = loadConfig({
      ...prodBase,
      AI_EXTRACTION_ENABLED: 'true',
      ANTHROPIC_API_KEY: 'sk-prod-key',
    });
    expect(cfg.aiExtractionEnabled).toBe(true);
    expect(cfg.extractionDriver).toBe('anthropic');
    expect(cfg.anthropicApiKey).toBe('sk-prod-key');
  });

  it('rejects ANTHROPIC_API_BASE_URL when set in production', () => {
    expect(() =>
      loadConfig({ ...prodBase, ANTHROPIC_API_BASE_URL: 'http://localhost:9999' }),
    ).toThrow(/ANTHROPIC_API_BASE_URL/);
  });

  it('warns and falls back to 30000 on an unparseable debounce', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development', AI_EXTRACTION_DEBOUNCE_MS: 'abc' });
    expect(cfg.aiExtractionDebounceMs).toBe(30000);
  });

  it('warns and falls back to 30000 on a non-positive debounce', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development', AI_EXTRACTION_DEBOUNCE_MS: '0' });
    expect(cfg.aiExtractionDebounceMs).toBe(30000);
  });
});

// B1 spec D4: the Notes line confidence floor. Fail-fast, unlike the debounce:
// a floor typo silently writing (or dropping) every line is worse than a crash.
describe('EXTRACTION_FACT_MIN_CONFIDENCE', () => {
  it('defaults to 0.7 in development and production', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).extractionFactMinConfidence).toBe(0.7);
    expect(loadConfig({ ...prodBase }).extractionFactMinConfidence).toBe(0.7);
  });

  it('honors a value in (0, 1], 1 included, and treats empty as unset', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'development', EXTRACTION_FACT_MIN_CONFIDENCE: '0.85' }).extractionFactMinConfidence).toBe(0.85);
    expect(loadConfig({ ...base, NODE_ENV: 'development', EXTRACTION_FACT_MIN_CONFIDENCE: ' 1 ' }).extractionFactMinConfidence).toBe(1);
    expect(loadConfig({ ...base, NODE_ENV: 'development', EXTRACTION_FACT_MIN_CONFIDENCE: '' }).extractionFactMinConfidence).toBe(0.7);
  });

  it.each(['0', '1.5', 'abc', '-0.1', 'NaN', 'Infinity'])('refuses to start on %s', (raw) => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'development', EXTRACTION_FACT_MIN_CONFIDENCE: raw })).toThrow(
      /EXTRACTION_FACT_MIN_CONFIDENCE/,
    );
  });

  it('the exported parser is the same rule (the probe reads the floor through it, B1 PR4)', () => {
    expect(parseExtractionFactMinConfidence(undefined)).toBe(0.7);
    expect(parseExtractionFactMinConfidence('0.9')).toBe(0.9);
    expect(() => parseExtractionFactMinConfidence('0')).toThrow(/EXTRACTION_FACT_MIN_CONFIDENCE/);
  });
});
