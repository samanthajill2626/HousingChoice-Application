// Unit tests for createMediaStore wiring (gating + local-endpoint construction).
// The real S3/MinIO streaming path is exercised in the e2e harness; here we only
// assert the factory's gating and that a local endpoint configures cleanly.
import { describe, expect, it } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { createMediaStore, S3MediaStore } from '../src/adapters/mediaStore.js';
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

describe('S3MediaStore.presign', () => {
  // getSignedUrl computes the SigV4 signature LOCALLY from the client config
  // and static creds (no network), so this is hermetic against the same local
  // MinIO client construction createMediaStore uses. Spec S12 requires the
  // presigned URL to carry an X-Amz-Signature-bearing query.
  const localClient = new S3Client({
    region: 'us-east-1',
    endpoint: 'http://localhost:9000',
    forcePathStyle: true,
    credentials: { accessKeyId: 'local', secretAccessKey: 'locallocal' },
  });

  it('returns a signed GET URL bearing X-Amz-Signature for the key', async () => {
    const store = new S3MediaStore('hc-local-media', localClient);
    const url = await store.presign('uploads/abc-123', 3600);
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Expires=3600');
    // Path-style (forcePathStyle): bucket + key appear in the path.
    expect(url).toContain('hc-local-media');
    expect(url).toContain('uploads/abc-123');
    expect(url.startsWith('http://localhost:9000')).toBe(true);
  });
});

describe('S3MediaStore.head', () => {
  it('returns contentType + size from HeadObject metadata', async () => {
    const fakeClient = {
      send: async () => ({ ContentType: 'image/png', ContentLength: 4096 }),
    } as unknown as S3Client;
    const store = new S3MediaStore('b', fakeClient);
    await expect(store.head('uploads/x')).resolves.toEqual({
      contentType: 'image/png',
      size: 4096,
    });
  });

  it('returns undefined when the object does not exist (404 NotFound)', async () => {
    const fakeClient = {
      send: async () => {
        throw Object.assign(new Error('not found'), { name: 'NotFound' });
      },
    } as unknown as S3Client;
    const store = new S3MediaStore('b', fakeClient);
    await expect(store.head('uploads/missing')).resolves.toBeUndefined();
  });

  it('re-throws a non-404 error (auth/network)', async () => {
    const fakeClient = {
      send: async () => {
        throw Object.assign(new Error('boom'), { name: 'AccessDenied' });
      },
    } as unknown as S3Client;
    const store = new S3MediaStore('b', fakeClient);
    await expect(store.head('uploads/x')).rejects.toThrow('boom');
  });
});
