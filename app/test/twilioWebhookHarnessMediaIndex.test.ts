// The harness FAKE's media index, pinned (code review R2, W7).
//
// WHY THIS FILE EXISTS. The fake does not store media pointers - it DERIVES the
// index from the stored message rows and answers `listMediaPointers` from that.
// So the real repo's D13 suppression (a relay RETRY row writes no pointer rows:
// `messagesRepo.ts`, the `!isRelayRetryRow` guard on the append transaction) has
// to be mirrored as a SKIP on the read side, or the fake answers the OPPOSITE of
// production for a retry row carrying media.
//
// Fix wave 1 (F9) added that skip and the fix-wave report said plainly that no
// suite reads the derivation - so nothing held it there and a future edit that
// dropped the `continue` would have broken nothing. This is that hold. It is the
// FAKE under test, deliberately: `mediaPointers.integration.test.ts` and
// `messagesRepoRetryLineage.integration.test.ts` already cover the real repo
// against DynamoDB Local, and neither can see a divergence in the double.
import { describe, expect, it } from 'vitest';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

const CONV = 'conv-media-index';
const CONTENT_TYPE = 'image/jpeg';

describe('twilioWebhookHarness fake - listMediaPointers (D13)', () => {
  it('indexes an ORIGINAL relay source carrying media, and SKIPS its retry row', async () => {
    const world = createFakeWorld();
    const original = await world.messagesRepo.append({
      conversationId: CONV,
      providerSid: 'SMrelaysource001',
      providerTs: '2026-09-02T10:00:00.000Z',
      type: 'mms',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
      relaySenderKey: 'c-alice',
      body: 'is the unit still available?',
      mediaAttachments: [{ s3Key: 'media/original.jpg', contentType: CONTENT_TYPE }],
    });
    // The RETRY row re-sends the SAME durable s3Keys (D13 re-presigns per
    // attempt), which is exactly why it must not index them a second time: a
    // three-rung ladder would otherwise triple the gallery for one send.
    const retry = await world.messagesRepo.append({
      conversationId: CONV,
      providerSid: 'relayretry-deadbeefdeadbeef-1',
      providerTs: '2026-09-02T10:01:00.000Z',
      type: 'mms',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'queued',
      relaySenderKey: 'c-alice',
      body: 'is the unit still available?',
      mediaAttachments: [{ s3Key: 'media/original.jpg', contentType: CONTENT_TYPE }],
      relayRetryOf: original.tsMsgId,
      relayRetryMemberKey: 'c-bob',
      relayRetryAttempt: 1,
      relayRetryDestDigest: 'deadbeefdeadbeef',
      relayRetryOriginDirection: 'inbound',
      relayRetryLegBody: 'Alice: is the unit still available?',
    });

    const pointers = await world.messagesRepo.listMediaPointers(CONV, { limit: 50 });

    // Exactly one pointer, and it belongs to the ORIGINAL. Asserting the OWNER
    // rather than only the count is what makes this fail loudly if the skip ever
    // starts dropping the wrong row.
    expect(pointers).toHaveLength(1);
    expect(pointers[0]?.tsMsgId).toBe(original.tsMsgId);
    expect(pointers.some((p) => p.tsMsgId === retry.tsMsgId)).toBe(false);
  });

  it('indexes a NON-retry row of the same shape, so the skip is the lineage field', async () => {
    // The control: identical media, identical everything, no `relayRetryOf`.
    // Without it the case above would also pass on a fake that indexed nothing.
    const world = createFakeWorld();
    const plain = await world.messagesRepo.append({
      conversationId: CONV,
      providerSid: 'SMplainmms0001',
      providerTs: '2026-09-02T10:02:00.000Z',
      type: 'mms',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
      relaySenderKey: 'c-alice',
      body: 'is the unit still available?',
      mediaAttachments: [{ s3Key: 'media/original.jpg', contentType: CONTENT_TYPE }],
    });

    const pointers = await world.messagesRepo.listMediaPointers(CONV, { limit: 50 });

    expect(pointers.map((p) => p.tsMsgId)).toEqual([plain.tsMsgId]);
  });
});
