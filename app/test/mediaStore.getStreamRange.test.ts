// S3MediaStore.getStream RANGE pass-through (call-recording seekable audio).
// The route forwards the client's Range header verbatim and mirrors S3's
// partial response back; S3 owns the RFC 7233 semantics. These tests pin the
// three things the route depends on: the header REACHES GetObjectCommand,
// ContentRange comes back out, and an unsatisfiable range becomes a TYPED
// error (so the route can answer 416 instead of a 500).
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { RangeNotSatisfiableError, S3MediaStore } from '../src/adapters/mediaStore.js';

type SeenInput = Record<string, unknown>;

/** A fake S3 client that records each GetObject input and answers like S3. */
function fakeClient(
  seen: SeenInput[],
  behavior:
    | { kind: 'ok'; bytes: Buffer; contentRange?: string }
    | { kind: 'error'; name: string; httpStatusCode?: number },
) {
  return {
    send: async (cmd: { input: SeenInput }) => {
      seen.push({ ...cmd.input });
      if (behavior.kind === 'error') {
        const err = new Error(behavior.name);
        (err as { name?: string }).name = behavior.name;
        if (behavior.httpStatusCode !== undefined) {
          (err as { $metadata?: { httpStatusCode?: number } }).$metadata = {
            httpStatusCode: behavior.httpStatusCode,
          };
        }
        throw err;
      }
      return {
        Body: Readable.from([behavior.bytes]),
        ContentType: 'audio/mpeg',
        ContentLength: behavior.bytes.length,
        ...(behavior.contentRange !== undefined && { ContentRange: behavior.contentRange }),
      };
    },
  } as unknown as ConstructorParameters<typeof S3MediaStore>[1];
}

describe('S3MediaStore.getStream (Range pass-through)', () => {
  it('forwards the Range header to GetObjectCommand and surfaces ContentRange', async () => {
    const seen: SeenInput[] = [];
    const store = new S3MediaStore(
      'bucket',
      fakeClient(seen, { kind: 'ok', bytes: Buffer.from('abcd'), contentRange: 'bytes 0-3/1000' }),
    );

    const out = await store.getStream('recordings/CA1.mp3', { range: 'bytes=0-3' });

    expect(seen[0]?.['Range']).toBe('bytes=0-3');
    expect(out?.contentRange).toBe('bytes 0-3/1000');
    // contentLength is the PART length on a partial response, not the object's.
    expect(out?.contentLength).toBe(4);
  });

  it('omits Range entirely when no range is requested (existing callers unchanged)', async () => {
    const seen: SeenInput[] = [];
    const store = new S3MediaStore('bucket', fakeClient(seen, { kind: 'ok', bytes: Buffer.from('abcd') }));

    const out = await store.getStream('recordings/CA1.mp3');

    expect('Range' in (seen[0] ?? {})).toBe(false);
    expect(out?.contentRange).toBeUndefined();
  });

  it('maps an InvalidRange S3 error to RangeNotSatisfiableError', async () => {
    const store = new S3MediaStore('bucket', fakeClient([], { kind: 'error', name: 'InvalidRange' }));
    await expect(store.getStream('recordings/CA1.mp3', { range: 'bytes=99999-' })).rejects.toBeInstanceOf(
      RangeNotSatisfiableError,
    );
  });

  it('maps a 416 status to RangeNotSatisfiableError even when the name differs', async () => {
    const store = new S3MediaStore(
      'bucket',
      fakeClient([], { kind: 'error', name: 'SomeOtherName', httpStatusCode: 416 }),
    );
    await expect(store.getStream('recordings/CA1.mp3', { range: 'bytes=99999-' })).rejects.toBeInstanceOf(
      RangeNotSatisfiableError,
    );
  });

  it('GUARDRAIL: an absent key still returns undefined, range requested or not', async () => {
    const store = new S3MediaStore('bucket', fakeClient([], { kind: 'error', name: 'NoSuchKey' }));
    expect(await store.getStream('recordings/gone.mp3')).toBeUndefined();
    expect(await store.getStream('recordings/gone.mp3', { range: 'bytes=0-3' })).toBeUndefined();
  });

  it('GUARDRAIL: a non-range, non-absent error still bubbles (never a silent 404/416)', async () => {
    const store = new S3MediaStore('bucket', fakeClient([], { kind: 'error', name: 'AccessDenied' }));
    await expect(store.getStream('recordings/CA1.mp3', { range: 'bytes=0-3' })).rejects.toThrow('AccessDenied');
  });

  it('GUARDRAIL: InvalidRange with NO range requested is not swallowed as a 416', async () => {
    // The 416 mapping is gated on us having actually asked for a range, so a
    // stray InvalidRange on a plain read stays a real error.
    const store = new S3MediaStore('bucket', fakeClient([], { kind: 'error', name: 'InvalidRange' }));
    await expect(store.getStream('recordings/CA1.mp3')).rejects.not.toBeInstanceOf(RangeNotSatisfiableError);
  });
});
