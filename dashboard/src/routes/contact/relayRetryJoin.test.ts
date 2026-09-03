import { describe, expect, it } from 'vitest';
import type { RelayRecipientDelivery, TimelineItem, TimelineMessage } from '../../api/index.js';
// D18 reuses the module's ONLY staleness budget so two horizons cannot drift
// apart; the fixtures below are built off it rather than off a literal.
import { STALE_SENT_AFTER_MS } from './deliveryStatus.js';
import {
  canRetryRungGoQuiet,
  indexRelayRetries,
  isRetryRungLive,
  isRetryRungTerminal,
  projectRelayLegs,
  relayRetryKey,
  type EffectiveRelayLeg,
} from './relayRetryJoin.js';

const ROOT = '2026-09-02T10:00:00.000Z#SM1';
const MEMBER = 'contact-1';
const NOW = Date.parse('2026-09-02T10:30:00.000Z');

const iso = (ms: number): string => new Date(ms).toISOString();

/** The ORIGINAL leg: sent, then rejected 30003. All eight wire fields matter -
 *  five of them are ones the join must not touch. */
const ORIGINAL: RelayRecipientDelivery = {
  status: 'failed',
  errorCode: '30003',
  sid: 'SMoriginalleg',
  sentAt: '2026-09-02T10:00:01.000Z',
  requestedTransport: 'sms',
  actualTransport: 'mms',
  transportAggregationState: 'attempted',
};

function queuedLeg(): RelayRecipientDelivery {
  return { status: 'queued', requestedTransport: 'sms', transportAggregationState: 'attempted' };
}

function sentLeg(sentAtMs: number): RelayRecipientDelivery {
  return {
    status: 'sent',
    sid: 'SMrungsent',
    sentAt: iso(sentAtMs),
    requestedTransport: 'sms',
    transportAggregationState: 'attempted',
  };
}

function deliveredLeg(deliveredAtMs: number): RelayRecipientDelivery {
  return {
    status: 'delivered',
    sid: 'SMrungdelivered',
    sentAt: iso(deliveredAtMs - 2_000),
    deliveredAt: iso(deliveredAtMs),
    requestedTransport: 'sms',
    actualTransport: 'sms',
    transportAggregationState: 'attempted',
  };
}

function failedLeg(errorCode?: string): RelayRecipientDelivery {
  return {
    status: 'failed',
    ...(errorCode !== undefined && { errorCode }),
    sid: 'SMrungfailed',
    transportAggregationState: 'attempted',
  };
}

/** A retry ROW as the relay projector hands it to the timeline. */
function retryItem(opts: {
  attempt: number;
  leg?: RelayRecipientDelivery;
  atMs?: number;
  memberKey?: string;
  rootTsMsgId?: string;
  originDirection?: 'inbound' | 'outbound';
  omitMemberKey?: boolean;
}): TimelineMessage {
  const memberKey = opts.memberKey ?? MEMBER;
  const atMs = opts.atMs ?? NOW - 60_000;
  const at = iso(atMs);
  const tsMsgId = `${at}#relayretry-${String(opts.attempt)}`;
  return {
    kind: 'message',
    id: tsMsgId,
    at,
    conversationId: 'c1',
    tsMsgId,
    direction: 'outbound',
    author: 'teammate',
    type: 'sms',
    delivery_status: 'queued',
    relay_retry_of: opts.rootTsMsgId ?? ROOT,
    ...(opts.omitMemberKey !== true && { relay_retry_member_key: memberKey }),
    relay_retry_attempt: opts.attempt,
    relay_retry_origin_direction: opts.originDirection ?? 'outbound',
    ...(opts.leg !== undefined && { delivery_recipients: { [memberKey]: opts.leg } }),
  };
}

function project(
  items: readonly TimelineItem[],
  nowMs: number | undefined,
  slot: RelayRecipientDelivery = ORIGINAL,
): EffectiveRelayLeg | undefined {
  return projectRelayLegs({
    entries: [[MEMBER, slot]],
    rootTsMsgId: ROOT,
    retries: indexRelayRetries(items),
    nowMs,
  }).get(MEMBER);
}

describe('projectRelayLegs - the four end states', () => {
  it('is retrying while a claimed rung is live', () => {
    const legs = project([retryItem({ attempt: 1, leg: queuedLeg(), atMs: NOW - 1_000 })], NOW);

    // The carrier code SURVIVES: the row copy for this state recites it
    // ("Retrying - Phone unreachable (error 30003)").
    expect(legs).toMatchObject({ retryState: 'retrying', status: 'failed', errorCode: '30003' });
  });

  it('is delivered-on-retry once any rung delivered', () => {
    const legs = project(
      [
        retryItem({ attempt: 1, leg: failedLeg('30003'), atMs: NOW - 300_000 }),
        retryItem({ attempt: 2, leg: deliveredLeg(NOW - 60_000), atMs: NOW - 120_000 }),
      ],
      NOW,
    );

    expect(legs).toMatchObject({ status: 'delivered', retryState: 'delivered-on-retry' });
    // An effective `delivered` beside a live 30003 is a contradiction four
    // independent reason sites would read.
    expect(legs).not.toHaveProperty('errorCode');
  });

  // A delivered retry cannot be un-delivered by a later failed rung arriving out
  // of order.
  it('keeps delivered-on-retry when an older rung reports failure afterwards', () => {
    const legs = project(
      [
        retryItem({ attempt: 1, leg: deliveredLeg(NOW - 200_000), atMs: NOW - 300_000 }),
        retryItem({ attempt: 2, leg: failedLeg('30003'), atMs: NOW - 120_000 }),
      ],
      NOW,
    );

    expect(legs).toMatchObject({ retryState: 'delivered-on-retry' });
  });

  // Delivered wins over a rung that is still LIVE too, not just over a failed
  // one: a queued rung 2 must not pull the leg back to `retrying`.
  it('keeps delivered-on-retry when a later rung is still queued', () => {
    const legs = project(
      [
        retryItem({ attempt: 1, leg: deliveredLeg(NOW - 200_000), atMs: NOW - 300_000 }),
        retryItem({ attempt: 2, leg: queuedLeg(), atMs: NOW - 1_000 }),
      ],
      NOW,
    );

    expect(legs).toMatchObject({ status: 'delivered', retryState: 'delivered-on-retry' });
  });

  it('is terminal at the cap, keeping the carrier reason', () => {
    const legs = project(
      [
        retryItem({ attempt: 1, leg: failedLeg('30003'), atMs: NOW - 300_000 }),
        retryItem({ attempt: 2, leg: failedLeg('30003'), atMs: NOW - 200_000 }),
        retryItem({ attempt: 3, leg: failedLeg('30003'), atMs: NOW - 100_000 }),
      ],
      NOW,
    );

    expect(legs).toMatchObject({
      status: 'failed',
      errorCode: '30003',
      retryState: 'terminal',
    });
  });

  // D19: the close code is PROJECTED onto the original, because the refused
  // retry row has no bubble of its own to carry it.
  it('projects a gate refusal code onto the original leg', () => {
    const legs = project(
      [retryItem({ attempt: 1, leg: failedLeg('retry_number_changed'), atMs: NOW - 60_000 })],
      NOW,
    );

    expect(legs).toMatchObject({ errorCode: 'retry_number_changed', retryState: 'terminal' });
  });

  // A terminal rung with NO code of its own must not blank the original's.
  it('leaves the original carrier code when the last rung carries none', () => {
    const legs = project([retryItem({ attempt: 1, leg: failedLeg(), atMs: NOW - 60_000 })], NOW);

    expect(legs).toMatchObject({ errorCode: '30003', retryState: 'terminal' });
  });

  // D18, half one: the stranded claim - created, never sent.
  it('is unconfirmed when a rung never reached sent inside the budget', () => {
    const legs = project(
      [retryItem({ attempt: 1, leg: queuedLeg(), atMs: NOW - STALE_SENT_AFTER_MS - 1 })],
      NOW,
    );

    expect(legs).toMatchObject({ retryState: 'unconfirmed' });
  });

  // D18, half two: sent, no receipt. Specifying only half one is how "retrying"
  // nearly became a permanent lie for the third time in this design's review.
  it('is unconfirmed when a sent rung got no receipt inside the budget', () => {
    const legs = project(
      [
        retryItem({
          attempt: 1,
          leg: sentLeg(NOW - STALE_SENT_AFTER_MS - 1),
          atMs: NOW - STALE_SENT_AFTER_MS - 5_000,
        }),
      ],
      NOW,
    );

    expect(legs).toMatchObject({ retryState: 'unconfirmed' });
  });

  // A sent rung inside its OWN budget stays live even though the retry ROW's
  // clock is already past the stranded-claim horizon - the two halves run off
  // different clocks and half two is the later one.
  it('is retrying when an old row sent recently', () => {
    const legs = project(
      [
        retryItem({
          attempt: 1,
          leg: sentLeg(NOW - 1_000),
          atMs: NOW - STALE_SENT_AFTER_MS - 60_000,
        }),
      ],
      NOW,
    );

    expect(legs).toMatchObject({ retryState: 'retrying' });
  });

  it('reads a live rung 3 as retrying even though rungs 1 and 2 failed', () => {
    const legs = project(
      [
        retryItem({ attempt: 1, leg: failedLeg('30003'), atMs: NOW - 400_000 }),
        retryItem({ attempt: 2, leg: failedLeg('30003'), atMs: NOW - 300_000 }),
        retryItem({ attempt: 3, leg: queuedLeg(), atMs: NOW - 2_000 }),
      ],
      NOW,
    );

    expect(legs).toMatchObject({ retryState: 'retrying' });
  });

  // Calling a ladder dead needs a clock. Without one, the alternative is a
  // guess - and the guess that reads `unconfirmed` is the indefinite promise
  // this design removed, inverted.
  it('never yields unconfirmed without a clock', () => {
    const stranded = [
      retryItem({ attempt: 1, leg: queuedLeg(), atMs: NOW - STALE_SENT_AFTER_MS * 10 }),
    ];

    expect(project(stranded, undefined)).toMatchObject({ retryState: 'retrying' });
    expect(project(stranded, NOW)).toMatchObject({ retryState: 'unconfirmed' });
  });
});

describe('projectRelayLegs - what it must not touch', () => {
  // THE TWO NON-OVERLAY STATES. `retrying` and `terminal` still describe the
  // ORIGINAL leg, so every one of its own facts survives byte for byte -
  // including `requestedTransport` and `actualTransport`, the two the narrower
  // slot type would have dropped (`presentRecipientTransport` renders `Unknown`
  // when both are absent).
  it('preserves every slot field on a RETRYING leg', () => {
    const legs = project([retryItem({ attempt: 1, leg: queuedLeg(), atMs: NOW - 1_000 })], NOW);

    expect(legs).toEqual({ ...ORIGINAL, retryState: 'retrying' });
  });

  it('preserves every slot field on a TERMINAL leg but the close code', () => {
    const legs = project(
      [retryItem({ attempt: 1, leg: failedLeg('retry_number_changed'), atMs: NOW - 60_000 })],
      NOW,
    );

    expect(legs).toEqual({
      ...ORIGINAL,
      errorCode: 'retry_number_changed',
      retryState: 'terminal',
    });
  });

  // THE TWO OVERLAY STATES. The DECIDING rung owns the per-attempt facts: the
  // row's time comes straight off this slot, so a delivered-on-retry leg that
  // kept the failed attempt's `sentAt` would time the send that did NOT land.
  // `requestedTransport` is the one field the rung must never take over - an
  // inbound retry row carries none (D2), and losing it drops the transport line
  // to `Unknown`.
  it('takes the DELIVERING rungs own leg, keeping the requested transport', () => {
    const legs = project([retryItem({ attempt: 1, leg: deliveredLeg(NOW - 60_000) })], NOW);

    expect(legs).toEqual({
      status: 'delivered',
      retryState: 'delivered-on-retry',
      sid: 'SMrungdelivered',
      sentAt: iso(NOW - 62_000),
      deliveredAt: iso(NOW - 60_000),
      actualTransport: 'sms',
      transportAggregationState: 'attempted',
      // The original's, not the rung's.
      requestedTransport: 'sms',
    });
    expect(legs).not.toHaveProperty('errorCode');
  });

  it('takes the QUIET rungs own leg, clearing what the failed attempt left behind', () => {
    const legs = project(
      [retryItem({ attempt: 1, leg: queuedLeg(), atMs: NOW - STALE_SENT_AFTER_MS - 1 })],
      NOW,
    );

    // A rung that never sent has no clock, no sid and no actual transport, so
    // the original's are CLEARED rather than inherited: the row must not time a
    // send this attempt never made.
    expect(legs).toEqual({
      status: 'queued',
      retryState: 'unconfirmed',
      transportAggregationState: 'attempted',
      requestedTransport: 'sms',
    });
    expect(legs).not.toHaveProperty('errorCode');
    expect(legs).not.toHaveProperty('sentAt');
    expect(legs).not.toHaveProperty('sid');
  });

  it('carries a QUIET SENT rungs clock, so the row times the attempt that stalled', () => {
    const sentAtMs = NOW - STALE_SENT_AFTER_MS - 1;
    const legs = project(
      [retryItem({ attempt: 1, leg: sentLeg(sentAtMs), atMs: sentAtMs - 5_000 })],
      NOW,
    );

    expect(legs).toMatchObject({
      status: 'sent',
      retryState: 'unconfirmed',
      sid: 'SMrungsent',
      sentAt: iso(sentAtMs),
    });
  });

  it('leaves a leg with no retry rows completely untouched', () => {
    const legs = project([], NOW);

    expect(legs).toEqual(ORIGINAL);
    expect(legs?.retryState).toBeUndefined();
  });

  // D5: one contact on two numbers collapses into ONE slot today. The join must
  // not invent a second one.
  it('keys strictly on the member key the retry row names', () => {
    const legs = project(
      [retryItem({ attempt: 1, leg: deliveredLeg(NOW - 60_000), memberKey: 'other' })],
      NOW,
    );

    expect(legs?.retryState).toBeUndefined();
    expect(legs).toEqual(ORIGINAL);
  });

  it('ignores a retry row whose own leg is missing', () => {
    const legs = project([retryItem({ attempt: 1, atMs: NOW - STALE_SENT_AFTER_MS - 1 })], NOW);

    // Not `unconfirmed`: a malformed row is no evidence of anything.
    expect(legs).toEqual(ORIGINAL);
  });

  it('projects every entry it is given, retried or not', () => {
    const projected = projectRelayLegs({
      entries: [
        [MEMBER, ORIGINAL],
        ['contact-2', { status: 'delivered', sid: 'SMok' }],
      ],
      rootTsMsgId: ROOT,
      retries: indexRelayRetries([retryItem({ attempt: 1, leg: queuedLeg(), atMs: NOW - 1_000 })]),
      nowMs: NOW,
    });

    expect(projected.size).toBe(2);
    expect(projected.get(MEMBER)).toMatchObject({ retryState: 'retrying' });
    expect(projected.get('contact-2')).toEqual({ status: 'delivered', sid: 'SMok' });
  });
});

describe('indexRelayRetries', () => {
  // Rungs 2 and 3 chain to the ROOT, never to the previous retry row - otherwise
  // they orphan from this key and from the changed-number digest.
  it('indexes every rung under the ROOT key', () => {
    const idx = indexRelayRetries([
      retryItem({ attempt: 1, leg: failedLeg('30003'), atMs: NOW - 300_000 }),
      retryItem({ attempt: 2, leg: failedLeg('30003'), atMs: NOW - 200_000 }),
      retryItem({ attempt: 3, leg: queuedLeg(), atMs: NOW - 100_000 }),
    ]);

    expect(idx.get(relayRetryKey(ROOT, MEMBER))).toHaveLength(3);
  });

  it('orders a bucket by attempt whatever order the page merged in', () => {
    const idx = indexRelayRetries([
      retryItem({ attempt: 3, leg: failedLeg('rung3'), atMs: NOW - 100_000 }),
      retryItem({ attempt: 1, leg: failedLeg('rung1'), atMs: NOW - 300_000 }),
      retryItem({ attempt: 2, leg: failedLeg('rung2'), atMs: NOW - 200_000 }),
    ]);

    expect(idx.get(relayRetryKey(ROOT, MEMBER))?.map((row) => row.relay_retry_attempt)).toEqual([
      1, 2, 3,
    ]);
    // And "the LAST rung" - whose close code the terminal branch takes - is the
    // one the ladder actually ended on.
    expect(project(
      [
        retryItem({ attempt: 3, leg: failedLeg('rung3'), atMs: NOW - 100_000 }),
        retryItem({ attempt: 1, leg: failedLeg('rung1'), atMs: NOW - 300_000 }),
      ],
      NOW,
    )).toMatchObject({ errorCode: 'rung3' });
  });

  it('carries the rung lineage a consumer needs', () => {
    const idx = indexRelayRetries([
      retryItem({ attempt: 2, leg: queuedLeg(), atMs: NOW - 1_000, originDirection: 'inbound' }),
    ]);

    expect(idx.get(relayRetryKey(ROOT, MEMBER))?.[0]).toMatchObject({
      relay_retry_of: ROOT,
      relay_retry_member_key: MEMBER,
      relay_retry_attempt: 2,
      relay_retry_origin_direction: 'inbound',
      atMs: NOW - 1_000,
    });
  });

  it('skips a retry row that names no member key', () => {
    const idx = indexRelayRetries([
      retryItem({ attempt: 1, leg: queuedLeg(), omitMemberKey: true }),
    ]);

    expect(idx.size).toBe(0);
  });

  it('skips an ordinary message that carries no lineage', () => {
    const plain: TimelineMessage = {
      kind: 'message',
      id: ROOT,
      at: '2026-09-02T10:00:00.000Z',
      conversationId: 'c1',
      tsMsgId: ROOT,
      direction: 'outbound',
      author: 'teammate',
      type: 'sms',
      delivery_status: 'failed',
      delivery_recipients: { [MEMBER]: ORIGINAL },
    };

    expect(indexRelayRetries([plain]).size).toBe(0);
  });

  // The tour host feeds a MILESTONE-MERGED list, so the narrow on
  // `kind === 'message'` has to come first: a milestone carries no tsMsgId at
  // all, and a call row carries no delivery slots.
  it('ignores milestone and call items in a merged list', () => {
    const milestone = {
      kind: 'milestone',
      id: 'ms-1',
      at: iso(NOW - 10_000),
      relay_retry_of: ROOT,
      relay_retry_member_key: MEMBER,
    } as unknown as TimelineItem;
    const call = {
      kind: 'call',
      id: 'ca-1',
      at: iso(NOW - 5_000),
      relay_retry_of: ROOT,
      relay_retry_member_key: MEMBER,
    } as unknown as TimelineItem;

    const idx = indexRelayRetries([
      milestone,
      call,
      retryItem({ attempt: 1, leg: queuedLeg(), atMs: NOW - 1_000 }),
    ]);

    expect(idx.get(relayRetryKey(ROOT, MEMBER))).toHaveLength(1);
  });
});

// Exported so the ticker clause (D18) asks THIS module whether a ladder is still
// running rather than re-deriving it and drifting.
describe('rung predicates', () => {
  const rung = (leg: RelayRecipientDelivery | undefined, atMs: number) =>
    indexRelayRetries([retryItem({ attempt: 1, leg, atMs })]).get(
      relayRetryKey(ROOT, MEMBER),
    )?.[0];

  it('calls a delivered, undelivered or failed rung terminal', () => {
    expect(isRetryRungTerminal(rung(deliveredLeg(NOW - 1_000), NOW - 2_000)!)).toBe(true);
    expect(isRetryRungTerminal(rung(failedLeg('30003'), NOW - 2_000)!)).toBe(true);
    expect(isRetryRungTerminal(rung({ status: 'undelivered' }, NOW - 2_000)!)).toBe(true);
    expect(isRetryRungTerminal(rung(queuedLeg(), NOW - 2_000)!)).toBe(false);
  });

  it('calls a malformed rung neither terminal nor live', () => {
    const malformed = rung(undefined, NOW - 2_000)!;

    expect(isRetryRungTerminal(malformed)).toBe(false);
    expect(isRetryRungLive(malformed, NOW)).toBe(false);
    expect(isRetryRungLive(malformed, undefined)).toBe(false);
  });

  it('stops calling a rung live once it is terminal, so the ticker can stop', () => {
    expect(isRetryRungLive(rung(queuedLeg(), NOW - 1_000)!, NOW)).toBe(true);
    expect(isRetryRungLive(rung(deliveredLeg(NOW - 1_000), NOW - 2_000)!, NOW)).toBe(false);
    expect(isRetryRungLive(rung(failedLeg('30003'), NOW - 2_000)!, NOW)).toBe(false);
    // And the stranded claim terminates too, on the clock alone.
    expect(isRetryRungLive(rung(queuedLeg(), NOW - STALE_SENT_AFTER_MS - 1)!, NOW)).toBe(false);
  });

  it('treats the horizon boundary the way the module already does', () => {
    // isQuietSince is `now - clock >= STALE_SENT_AFTER_MS`, so the budget's last
    // millisecond is still live.
    expect(isRetryRungLive(rung(queuedLeg(), NOW - STALE_SENT_AFTER_MS + 1)!, NOW)).toBe(true);
    expect(isRetryRungLive(rung(queuedLeg(), NOW - STALE_SENT_AFTER_MS)!, NOW)).toBe(false);
  });

  // THE TICKER'S OTHER HALF. `isRetryRungLive` answers TRUE for ever on a rung
  // with no clock to age from - `isQuietSince` reads "no clock" as "not quiet" -
  // so a predicate built on it alone would keep the interval armed for the life
  // of the mount. Reachable, not hypothetical: `messageInstant` answers `''` for
  // a row with no provider_ts and a non-ISO tsMsgId.
  it('refuses a rung with no clock to age from, so the ticker can terminate', () => {
    const clockless = indexRelayRetries([
      { ...retryItem({ attempt: 1, leg: queuedLeg() }), at: '' },
    ]).get(relayRetryKey(ROOT, MEMBER))?.[0];

    expect(clockless).toBeDefined();
    // Still LIVE - the projection is unchanged and the leg still reads
    // `retrying`. The ticker just stops paying for a re-render that could never
    // change the answer.
    expect(isRetryRungLive(clockless!, NOW)).toBe(true);
    expect(canRetryRungGoQuiet(clockless!)).toBe(false);
  });

  it('accepts a rung ageing from either clock', () => {
    // The leg's own sentAt...
    expect(canRetryRungGoQuiet(rung(sentLeg(NOW - 1_000), NOW - 2_000)!)).toBe(true);
    // ...or, failing that, the retry ROW's own `at`.
    expect(canRetryRungGoQuiet(rung(queuedLeg(), NOW - 2_000)!)).toBe(true);
    // A malformed rung has no leg, so it has no clock either.
    expect(canRetryRungGoQuiet(rung(undefined, NOW - 2_000)!)).toBe(false);
  });
});
