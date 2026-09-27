// app/test/mediaStore.head.test.ts
// The voicemail-greeting webhook bounds its HeadObject with an AbortSignal
// (spec 4.6). This pins that the signal actually reaches client.send as
// `abortSignal` - the only thing that releases a pooled socket when the
// lookup budget expires. Same fake-client shape as mediaStore.getStreamRange.test.ts.
//
// The second describe pins the webhook harness's fake head/presign SEAMS
// (twilioWebhookHarness.ts): the voice-webhook greeting tests drive the lookup
// through them, so their recording, forced-failure and hang semantics are a
// contract of their own.
import { describe, expect, it } from 'vitest';
import { S3MediaStore } from '../src/adapters/mediaStore.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

describe('S3MediaStore.head', () => {
  it('passes opts.signal to client.send as abortSignal, and nothing when omitted', async () => {
    const seen: { input: Record<string, unknown>; options: unknown }[] = [];
    const client = {
      send: async (cmd: { input: Record<string, unknown> }, options?: unknown) => {
        seen.push({ input: { ...cmd.input }, options });
        return { ContentType: 'audio/mpeg', ContentLength: 427 };
      },
    } as unknown as ConstructorParameters<typeof S3MediaStore>[1];
    const store = new S3MediaStore('bucket', client);
    const signal = AbortSignal.timeout(10_000);
    await expect(store.head('settings/voicemail-greeting', { signal })).resolves.toEqual({ contentType: 'audio/mpeg', size: 427 });
    expect(seen[0]?.input).toEqual({ Bucket: 'bucket', Key: 'settings/voicemail-greeting' });
    expect((seen[0]?.options as { abortSignal?: AbortSignal }).abortSignal).toBe(signal);
    await store.head('settings/voicemail-greeting');
    expect(seen[1]?.options).toBeUndefined();
  });

  it('an aborted send rejects (never reads as a 404)', async () => {
    const client = {
      send: async () => {
        const err = new Error('Request aborted');
        (err as { name?: string }).name = 'AbortError';
        throw err;
      },
    } as unknown as ConstructorParameters<typeof S3MediaStore>[1];
    await expect(new S3MediaStore('bucket', client).head('k', { signal: AbortSignal.abort() })).rejects.toThrow('Request aborted');
  });
});

describe('webhook harness fake mediaStore: the head/presign seams', () => {
  const KEY = 'settings/voicemail-greeting';

  it('head records { key, signal } for every call, in order, and answers from mediaObjects', async () => {
    const world = createFakeWorld();
    world.mediaObjects.set(KEY, { body: Buffer.from('abc'), contentType: 'audio/mpeg' });
    await expect(world.mediaStore.head(KEY, { signal: AbortSignal.timeout(10_000) })).resolves.toEqual({
      contentType: 'audio/mpeg',
      size: 3,
    });
    await expect(world.mediaStore.head('missing')).resolves.toBeUndefined();
    expect(world.mediaHeads).toEqual([
      { key: KEY, signal: true },
      { key: 'missing', signal: false },
    ]);
  });

  it('failMediaHeads makes head REJECT for that key (the call is still recorded)', async () => {
    const world = createFakeWorld();
    world.mediaObjects.set(KEY, { body: Buffer.from('abc'), contentType: 'audio/mpeg' });
    world.failMediaHeads.add(KEY);
    await expect(world.mediaStore.head(KEY)).rejects.toThrow(`fake mediaStore: forced head failure for ${KEY}`);
    expect(world.mediaHeads).toEqual([{ key: KEY, signal: false }]);
  });

  it('hangMediaHeads never settles on its own and rejects with an AbortError only when the signal fires', async () => {
    const world = createFakeWorld();
    world.mediaObjects.set(KEY, { body: Buffer.from('abc'), contentType: 'audio/mpeg' });
    world.hangMediaHeads.add(KEY);
    const controller = new AbortController();
    let settled = false;
    const pending = world.mediaStore.head(KEY, { signal: controller.signal });
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((r) => setTimeout(r, 25));
    expect(settled).toBe(false);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // An already-aborted signal rejects at once.
    await expect(world.mediaStore.head(KEY, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(world.mediaHeads).toEqual([
      { key: KEY, signal: true },
      { key: KEY, signal: true },
    ]);
  });

  it('presign records { key, ttlSeconds } and returns a UNIQUE X-Amz-Signature URL per call', async () => {
    const world = createFakeWorld();
    const a = await world.mediaStore.presign(KEY, 600);
    const b = await world.mediaStore.presign(KEY, 600);
    expect(world.mediaPresigns).toEqual([
      { key: KEY, ttlSeconds: 600 },
      { key: KEY, ttlSeconds: 600 },
    ]);
    expect(a).toMatch(/^https:\/\/fake-s3\.local\/settings\/voicemail-greeting\?X-Amz-Signature=fakesig\d+&X-Amz-Expires=600$/);
    expect(a).not.toBe(b);
  });
});
