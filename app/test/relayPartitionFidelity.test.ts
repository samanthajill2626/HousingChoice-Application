/**
 * The relay partition question is answered by `relay_status`, not `status`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `listRelayGroups` in the real repo Queries the sparse `byRelayStatus` GSI,
 * whose HASH is `relay_status` (`relay_group#<status>`) - and consults nothing
 * else (conversationsRepo.ts:1954-1976). The in-memory double in
 * `twilioWebhookHarness.ts` used to filter on `type === 'relay_group' &&
 * status === status` instead. Those are different fields and they genuinely
 * skew: `touchLastActivity` stamps `status = 'open'` on any non-`group_text`
 * conversation that receives activity and never touches `relay_status`
 * (conversationsRepo.ts:1506-1534), so a CLOSED relay group that gets an inbound
 * sits at `status: 'open'` with `relay_status: 'relay_group#closed'`.
 *
 * The old double was therefore strictly MORE PERMISSIVE than production: it
 * could return a row the real GSI would never surface, and never the reverse.
 * That went from harmless to load-bearing when duplicate detection made the
 * partition user-visible - the confirm dialog picks between "already have an
 * open relay group" and "...being connected" from it, and the rule "closed
 * groups are NOT duplicates" rests entirely on which partition a row is in.
 *
 * The double is corrected. This file is the guard that keeps it corrected: it
 * pins the two shapes the drift made indistinguishable. Without it, someone
 * re-pointing either implementation at `conv.status` gets a green suite again.
 *
 * See docs/issues/relay-duplicate-detection-fake-partition-drift.md.
 */
import { describe, expect, it } from 'vitest';

import { makeWebhookHarness } from './helpers/twilioWebhookHarness.js';

describe('listRelayGroups partitions on relay_status, not status', () => {
  it('does NOT return a closed group that activity re-stamped status=open', () => {
    // THE EXACT SKEW `touchLastActivity` produces. Production cannot return this
    // row from the open partition, because the GSI never saw the status change.
    const { world } = makeWebhookHarness();
    world.conversations.set('conv-skewed', {
      conversationId: 'conv-skewed',
      type: 'relay_group',
      status: 'open', // re-stamped by activity...
      relay_status: 'relay_group#closed', // ...but the INDEX still says closed
      participant_phone: '+15550000001',
      last_activity_at: '2026-08-21T12:00:00.000Z',
      created_at: '2026-08-21T11:00:00.000Z',
      ai_mode: 'manual',
      participants: [],
    } as never);

    return world.conversationsRepo.listRelayGroups('open').then((open) => {
      expect(
        open.items.map((c) => c.conversationId),
        'a closed group re-stamped status=open must NOT appear in the open partition',
      ).not.toContain('conv-skewed');
      return world.conversationsRepo.listRelayGroups('closed').then((closed) => {
        expect(
          closed.items.map((c) => c.conversationId),
          'it belongs to the partition its relay_status names',
        ).toContain('conv-skewed');
      });
    });
  });

  it('does NOT return a relay row that carries no relay_status at all', async () => {
    // A row shape production cannot produce - the writer stamps relay_status in
    // lockstep - but one that fixtures wrote for months because the old double
    // never looked at the field. Eight tests in contactRelayGroups.test.ts were
    // built on it.
    const { world } = makeWebhookHarness();
    world.conversations.set('conv-unindexed', {
      conversationId: 'conv-unindexed',
      type: 'relay_group',
      status: 'open',
      participant_phone: '+15550000002',
      last_activity_at: '2026-08-21T12:00:00.000Z',
      created_at: '2026-08-21T11:00:00.000Z',
      ai_mode: 'manual',
      participants: [],
    } as never);

    const open = await world.conversationsRepo.listRelayGroups('open');
    expect(
      open.items.map((c) => c.conversationId),
      'a row absent from the sparse index is invisible to every relay read',
    ).not.toContain('conv-unindexed');
  });

  it('returns a correctly-stamped group in its own partition', async () => {
    // The positive control: without this, the two assertions above would also
    // pass against a double that returned nothing at all.
    const { world } = makeWebhookHarness();
    for (const status of ['open', 'closed', 'connecting'] as const) {
      world.conversations.set(`conv-${status}`, {
        conversationId: `conv-${status}`,
        type: 'relay_group',
        status,
        relay_status: `relay_group#${status}`,
        participant_phone: `+1555000100${status.length}`,
        last_activity_at: '2026-08-21T12:00:00.000Z',
        created_at: '2026-08-21T11:00:00.000Z',
        ai_mode: 'manual',
        participants: [],
      } as never);
    }

    for (const status of ['open', 'closed', 'connecting'] as const) {
      const res = await world.conversationsRepo.listRelayGroups(status);
      expect(res.items.map((c) => c.conversationId)).toContain(`conv-${status}`);
      expect(res.items).toHaveLength(1);
    }
  });
});
