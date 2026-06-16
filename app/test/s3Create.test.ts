// Unit tests for the local media-bucket creation helper's idempotency: a
// concurrent launcher (or a HeadBucket false-negative during MinIO's
// liveness→readiness window) can lose the Head→Create race; the loser's
// BucketAlreadyOwnedByYou / BucketAlreadyExists must be treated as success, not
// a boot-aborting error.
import { describe, expect, it, vi } from 'vitest';

// Mock the S3 client so no real network/MinIO is needed. The command classes are
// passed through as tag objects; `send` dispatches on the injected behavior.
const sendMock = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = sendMock;
    destroy = vi.fn();
  },
  HeadBucketCommand: class {
    constructor(public input: unknown) {}
  },
  CreateBucketCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { ensureBucket } = await import('../scripts/s3-create.js');

function notFound(): Error {
  const e = new Error('not found');
  e.name = 'NotFound';
  return e;
}

describe('ensureBucket', () => {
  it('is a no-op when the bucket already exists (HeadBucket succeeds)', async () => {
    sendMock.mockReset();
    sendMock.mockResolvedValueOnce({}); // HeadBucket OK
    await ensureBucket('http://localhost:9000', 'hc-local-media');
    // Only HeadBucket — no CreateBucket.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('creates the bucket when absent (HeadBucket 404 → CreateBucket)', async () => {
    sendMock.mockReset();
    sendMock.mockRejectedValueOnce(notFound()); // HeadBucket
    sendMock.mockResolvedValueOnce({}); // CreateBucket OK
    await ensureBucket('http://localhost:9000', 'hc-local-media');
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('swallows BucketAlreadyOwnedByYou from a lost create race (idempotent)', async () => {
    sendMock.mockReset();
    sendMock.mockRejectedValueOnce(notFound()); // HeadBucket
    const owned = new Error('owned');
    owned.name = 'BucketAlreadyOwnedByYou';
    sendMock.mockRejectedValueOnce(owned); // CreateBucket loses the race
    await expect(ensureBucket('http://localhost:9000', 'hc-local-media')).resolves.toBeUndefined();
  });

  it('swallows BucketAlreadyExists too', async () => {
    sendMock.mockReset();
    sendMock.mockRejectedValueOnce(notFound());
    const exists = new Error('exists');
    exists.name = 'BucketAlreadyExists';
    sendMock.mockRejectedValueOnce(exists);
    await expect(ensureBucket('http://localhost:9000', 'hc-local-media')).resolves.toBeUndefined();
  });

  it('rethrows a genuine CreateBucket failure', async () => {
    sendMock.mockReset();
    sendMock.mockRejectedValueOnce(notFound());
    const boom = new Error('access denied');
    boom.name = 'AccessDenied';
    sendMock.mockRejectedValueOnce(boom);
    await expect(ensureBucket('http://localhost:9000', 'hc-local-media')).rejects.toThrow(/access denied/);
  });
});
