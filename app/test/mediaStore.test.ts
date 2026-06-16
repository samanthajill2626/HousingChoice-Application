// Unit tests for createMediaStore wiring (gating + local-endpoint construction).
// The real S3/MinIO streaming path is exercised in the e2e harness; here we only
// assert the factory's gating and that a local endpoint configures cleanly.
import { describe, expect, it } from 'vitest';
import { createMediaStore } from '../src/adapters/mediaStore.js';
import { loadConfig } from '../src/lib/config.js';

const cfg = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: 's' });

describe('createMediaStore', () => {
  it('returns undefined when MEDIA_BUCKET is unset', () => {
    expect(createMediaStore({ config: { ...cfg, mediaBucket: undefined } })).toBeUndefined();
  });

  it('returns a store when a bucket is set (real AWS path)', () => {
    expect(createMediaStore({ config: { ...cfg, mediaBucket: 'b', mediaS3Endpoint: undefined } })).toBeDefined();
  });

  it('returns a store when a local S3 endpoint is configured (MinIO)', () => {
    const store = createMediaStore({
      config: { ...cfg, mediaBucket: 'hc-local-media', mediaS3Endpoint: 'http://localhost:9000' },
    });
    expect(store).toBeDefined();
  });
});
