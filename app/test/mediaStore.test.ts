// Unit tests for createMediaStore wiring (gating + local-endpoint construction).
// The real S3/MinIO streaming path is exercised in the e2e harness; here we only
// assert the factory's gating and that a local endpoint configures cleanly.
import { describe, expect, it } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { createInboundMailRawStore, createMediaStore, S3MediaStore } from '../src/adapters/mediaStore.js';
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

describe('createInboundMailRawStore (email-channel B4 wires this)', () => {
  it('returns undefined when INBOUND_MAIL_BUCKET is unset (consumer no-ops - ADJ-11)', () => {
    expect(createInboundMailRawStore({ config: { ...cfg, inboundMailBucket: undefined } })).toBeUndefined();
  });

  it('returns a store satisfying InboundRawStore (head + getBytes) when the bucket is set', () => {
    const store = createInboundMailRawStore({
      config: { ...cfg, inboundMailBucket: 'hc-local-inbound-mail-1', mediaS3Endpoint: 'http://localhost:9000' },
    });
    expect(store).toBeDefined();
    // The B2 InboundRawStore contract is head + getBytes.
    expect(typeof store!.head).toBe('function');
    expect(typeof store!.getBytes).toBe('function');
  });

  it('returns a store over the inbound bucket on the real AWS path (no local endpoint)', () => {
    expect(
      createInboundMailRawStore({ config: { ...cfg, inboundMailBucket: 'b', mediaS3Endpoint: undefined } }),
    ).toBeDefined();
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

describe('S3MediaStore.createPresignedPost', () => {
  // createPresignedPost signs the POST policy LOCALLY (SigV4, no S3 round trip -
  // spike Q1), so this is hermetic against the same local MinIO client.
  const localClient = new S3Client({
    region: 'us-east-1',
    endpoint: 'http://localhost:9000',
    forcePathStyle: true,
    credentials: { accessKeyId: 'local', secretAccessKey: 'locallocal' },
  });

  it('mints { url, fields } with the exact key + content-type + size policy', async () => {
    const store = new S3MediaStore('hc-local-media', localClient);
    const key = 'unit-media/unit-1/abc-123';
    const { url, fields } = await store.createPresignedPost(key, { contentType: 'image/png' });
    // Path-style (forcePathStyle): the bucket appears in the URL path.
    expect(url).toContain('hc-local-media');
    expect(url.startsWith('http://localhost:9000')).toBe(true);
    // The form carries the exact key, the content-type, and the signed policy.
    expect(fields['key']).toBe(key);
    expect(fields['Content-Type']).toBe('image/png');
    expect(fields['Policy']).toBeDefined();
    expect(fields['X-Amz-Signature']).toBeDefined();
    // Decode the policy and assert the three edge-enforced conditions are pinned.
    const policy = JSON.parse(Buffer.from(fields['Policy']!, 'base64').toString('utf8'));
    const conds: unknown[] = policy.conditions;
    const stringified = conds.map((c) => JSON.stringify(c));
    // Exact key match (the SDK adds { key: <key> }); content-type exact match;
    // content-length-range 1..5MB.
    expect(stringified).toContain(JSON.stringify({ key }));
    expect(stringified).toContain(JSON.stringify({ 'Content-Type': 'image/png' }));
    expect(stringified).toContain(JSON.stringify(['content-length-range', 1, 5 * 1024 * 1024]));
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
