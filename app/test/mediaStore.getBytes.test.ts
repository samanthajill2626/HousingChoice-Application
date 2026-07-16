import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { S3MediaStore } from '../src/adapters/mediaStore.js';

function fakeClient(bytes: Buffer | null) {
  return {
    send: async () => {
      if (bytes === null) { const e = new Error('missing'); (e as { name?: string }).name = 'NoSuchKey'; throw e; }
      return { Body: Readable.from([bytes]) };
    },
  } as unknown as ConstructorParameters<typeof S3MediaStore>[1];
}

describe('S3MediaStore.getBytes', () => {
  it('reads the whole object into a Buffer', async () => {
    const store = new S3MediaStore('bucket', fakeClient(Buffer.from('hello world')));
    const out = await store.getBytes('uploads/x');
    expect(out?.toString()).toBe('hello world');
  });
  it('returns undefined for an absent key', async () => {
    const store = new S3MediaStore('bucket', fakeClient(null));
    expect(await store.getBytes('uploads/missing')).toBeUndefined();
  });
});
