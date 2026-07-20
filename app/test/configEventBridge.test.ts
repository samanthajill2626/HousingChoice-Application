// app/test/configEventBridge.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';

const base = { CF_ORIGIN_SECRET: 's' };

describe('EVENT_BRIDGE_URL config', () => {
  it('eventBridgeUrl is undefined when unset', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).eventBridgeUrl).toBeUndefined();
  });

  it('eventBridgeUrl is undefined when blank', () => {
    expect(
      loadConfig({ ...base, NODE_ENV: 'development', EVENT_BRIDGE_URL: '  ' }).eventBridgeUrl,
    ).toBeUndefined();
  });

  it('eventBridgeUrl parses a valid URL (production-legal - it IS the production path)', () => {
    expect(
      loadConfig({ ...base, NODE_ENV: 'development', EVENT_BRIDGE_URL: 'http://app:8080' }).eventBridgeUrl,
    ).toBe('http://app:8080');
  });

  it('eventBridgeUrl rejects a malformed URL at boot', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'development', EVENT_BRIDGE_URL: 'not a url' }),
    ).toThrow(/EVENT_BRIDGE_URL/);
  });
});

describe('WORKER_POLL_INTERVAL_MS config', () => {
  it('workerPollIntervalMs defaults to 60000 when unset', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).workerPollIntervalMs).toBe(60000);
  });

  it('workerPollIntervalMs parses a positive integer', () => {
    expect(
      loadConfig({ ...base, NODE_ENV: 'development', WORKER_POLL_INTERVAL_MS: '1500' }).workerPollIntervalMs,
    ).toBe(1500);
  });

  it('workerPollIntervalMs rejects zero, negative, non-numeric, and fractional values', () => {
    for (const bad of ['0', '-5', 'abc', '1.5']) {
      expect(() =>
        loadConfig({ ...base, NODE_ENV: 'development', WORKER_POLL_INTERVAL_MS: bad }),
      ).toThrow(/WORKER_POLL_INTERVAL_MS/);
    }
  });
});
