// MediaStore.setContentType adapter test (media-content-type-fidelity Task 5):
// the in-place Content-Type rewrite the one-time backfill uses to repair objects
// mirrored before the declarable tier existed. Hermetic - a fake `send` records
// the COMMAND, which is the part that can be wrong. There is no MinIO round-trip
// harness here by design (see mediaStore.test.ts's header): the real S3/MinIO
// path is exercised in the e2e harness.
import { describe, expect, it } from 'vitest';
import { CopyObjectCommand } from '@aws-sdk/client-s3';
import { S3MediaStore } from '../src/adapters/mediaStore.js';

/** Records every command handed to `send`. Cast via the ctor's own parameter
 *  type so this file needs no S3Client import (sibling idiom, see
 *  mediaStore.getBytes.test.ts). */
function recordingClient(sendImpl: (cmd: unknown) => Promise<unknown> = async () => ({})) {
  const sent: unknown[] = [];
  const client = {
    async send(cmd: unknown) {
      sent.push(cmd);
      return sendImpl(cmd);
    },
  } as unknown as ConstructorParameters<typeof S3MediaStore>[1];
  return { client, sent };
}

describe('S3MediaStore.setContentType', () => {
  it('issues a same-key CopyObject that REPLACES the metadata', async () => {
    const { client, sent } = recordingClient();
    const store = new S3MediaStore('b', client);
    await store.setContentType('media/c1/MM1/0', 'video/mp4');
    // The COMMAND CLASS is part of the contract: a PutObject carrying the same
    // input fields would satisfy a shape-only assertion while destroying the
    // bytes.
    expect(sent[0]).toBeInstanceOf(CopyObjectCommand);
    const input = (sent[0] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({
      Bucket: 'b',
      Key: 'media/c1/MM1/0',
      CopySource: 'b/media/c1/MM1/0',
      ContentType: 'video/mp4',
      // Without REPLACE, S3 COPIES the old Content-Type and the call is a no-op
      // that looks like a success - the single most likely way to ship this
      // broken.
      MetadataDirective: 'REPLACE',
    });
  });

  it('propagates transport/access errors to the caller', async () => {
    // The backfill counts failures per attachment; a swallowed error here would
    // report a repair that never happened.
    const { client } = recordingClient(async () => {
      throw new Error('s3 down');
    });
    const store = new S3MediaStore('b', client);
    await expect(store.setContentType('media/c1/MM1/0', 'video/mp4')).rejects.toThrow('s3 down');
  });
});
