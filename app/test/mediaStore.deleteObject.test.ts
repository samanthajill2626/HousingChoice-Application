// MediaStore.deleteObject adapter test (unit-media-cloudfront design 2026-07-21,
// D1): the idempotent S3 DeleteObject that best-effort-removes a unit photo's
// object when the photo is removed. Uses the createMediaStore injected-client
// seam (CreateMediaStoreDeps.client) so no live S3/MinIO is touched - the same
// config-shim + fake-send pattern the other adapter tests in this dir use.
import { describe, expect, it, vi } from 'vitest';
import { DeleteObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { createMediaStore } from '../src/adapters/mediaStore.js';
import { loadConfig } from '../src/lib/config.js';

const cfg = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: 's' });

function harness(sendImpl: (cmd: unknown) => Promise<unknown>) {
  const send = vi.fn(sendImpl);
  const store = createMediaStore({
    config: { ...cfg, mediaBucket: 'test-bucket', mediaS3Endpoint: undefined },
    client: { send } as unknown as S3Client,
  });
  return { store: store!, send };
}

describe('MediaStore.deleteObject', () => {
  it('sends DeleteObjectCommand for the exact bucket/key and resolves void', async () => {
    const { store, send } = harness(async () => ({}));
    await expect(store.deleteObject('unit-media/u1/k1')).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]![0] as DeleteObjectCommand;
    expect(cmd).toBeInstanceOf(DeleteObjectCommand);
    expect(cmd.input).toEqual({ Bucket: 'test-bucket', Key: 'unit-media/u1/k1' });
  });

  it('propagates transport/access errors to the caller (caller degrades to WARN)', async () => {
    const { store } = harness(async () => {
      throw new Error('s3 down');
    });
    await expect(store.deleteObject('unit-media/u1/k1')).rejects.toThrow('s3 down');
  });
});
