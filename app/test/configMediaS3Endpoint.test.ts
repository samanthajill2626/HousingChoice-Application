// app/test/configMediaS3Endpoint.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';

const base = { CF_ORIGIN_SECRET: 's' };

describe('MEDIA_S3_ENDPOINT config', () => {
  it('is read in non-production (local MinIO seam)', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development', MEDIA_S3_ENDPOINT: 'http://localhost:9000' });
    expect(cfg.mediaS3Endpoint).toBe('http://localhost:9000');
  });

  it('defaults to undefined when unset', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development' });
    expect(cfg.mediaS3Endpoint).toBeUndefined();
  });

  it('is REJECTED (throws) when set in production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', MEDIA_S3_ENDPOINT: 'http://localhost:9000', MESSAGING_DRIVER: 'console' }),
    ).toThrow(/MEDIA_S3_ENDPOINT/);
  });
});
