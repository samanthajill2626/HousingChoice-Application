// relayRetryJoin - the thread-level join that turns relay 30003 retry lineage
// into a per-member RETRY STATE (spec D18/D19). Pure: no React, no clock of its
// own, no knowledge of how any of it renders.
//
// A relay retry is a NEW source row addressed to one member (D1), so the state
// of a retried leg is not on the leg. It is spread across the original's slot
// and the retry rows that reference it, and only a join over the WHOLE item set
// can see both. That is also why this lives at thread level rather than inside a
// bubble: D20 filters the retry rows out of the rendered set, so a bubble cannot
// reach its own retries from its props.
//
// TWO FUNCTIONS, TWO LIFETIMES, and that is the point (D18). `indexRelayRetries`
// is the LINEAGE half - which rows reference which member and how each one's own
// leg ended - and changes only when the item set changes, so a host may memoize
// it on `items`. `projectRelayLegs` is the TIME-DERIVED half: the two
// `unconfirmed` horizons are read against `nowMs` and MUST be recomputed as the
// ticker advances. Collapsing both into one `useMemo(..., [items])` would freeze
// exactly the half the ticker clause exists to drive, while still looking
// correct in every test that asserts a final state.
//
// `retryState` is a SEPARATE field and is never smuggled into `status` (D19):
// `DeliveryStatus` is a closed union, `presentDeliveryStatus` returns null
// outside it, and `presentRelayDelivery`'s counters match on `status` - so an
// overloaded `status: 'retrying'` would render as no state at all AND drop the
// leg from both the delivered and the failed bucket.
import type { DeliveryStatus, RelayRecipientDelivery, TimelineItem } from '../../api/index.js';
import { isQuietSince, type RelayDeliverySlot } from './deliveryStatus.js';

/** The four end states of a retried leg (D19).
 *  - `retrying`          a claimed rung is still plausibly in flight
 *  - `delivered-on-retry` some rung reached the member
 *  - `terminal`          every rung ended, none delivered
 *  - `unconfirmed`       a rung went quiet past its staleness horizon */
export type RelayRetryState = 'retrying' | 'delivered-on-retry' | 'terminal' | 'unconfirmed';

/** A retry row as the join sees it: its lineage plus its OWN single-entry leg. */
export interface RelayRetryRow {
  /** The retry row's own sort key (not the root's). */
  tsMsgId: string;
  /** The row's `at`, parsed. `undefined` when it is absent or does not parse -
   *  see `parseRetryClock`; a NO-CLOCK rung can never be judged stale. */
  atMs: number | undefined;
  /** D11: the ROOT source row this rung chains to. Rungs 2 and 3 chain to the
   *  ROOT, never to the previous retry row, or they orphan from this key. */
  relay_retry_of: string;
  /** D11: the member key of the retried leg - it matches the ORIGINAL's slot map. */
  relay_retry_member_key: string;
  /** D11: 1-based rung, or 0 when the row carries none. Nothing in the
   *  resolution below reads it; it orders the bucket and it is what a consumer
   *  displays ("attempt 2 of 3"). */
  relay_retry_attempt: number;
  /** D11: the ORIGINAL's direction, carried so D20's render predicate is
   *  self-contained when the original has not been paged in (D22). */
  relay_retry_origin_direction?: 'inbound' | 'outbound';
  /** The rung's own delivery slot - `delivery_recipients[relay_retry_member_key]`
   *  on the retry row. `undefined` on a malformed row, which the resolution
   *  IGNORES rather than counting as an unfinished rung. */
  leg: RelayRecipientDelivery | undefined;
}

/** The effective leg: the ORIGINAL wire slot with the join's decisions overlaid.
 *
 *  It extends `RelayRecipientDelivery` - the EIGHT-field WIRE slot - not the
 *  five-field `RelayDeliverySlot` (adjudication D1). The narrower type has no
 *  `sid`, `requestedTransport` or `actualTransport`, and dropping the last two
 *  is not cosmetic: `presentRecipientTransport` falls through to `'Unknown'`
 *  when both are absent, so every versioned relay row would lose its transport
 *  line the moment its legs were projected. */
export interface EffectiveRelayLeg extends RelayRecipientDelivery {
  retryState?: RelayRetryState;
}

/** Compile-time proof of D1's load-bearing claim: an `EffectiveRelayLeg` is
 *  STILL a `RelayDeliverySlot`, so every presenter that takes the five-field
 *  slot - and the FENCED native group-text product shares those presenters -
 *  keeps compiling when it is handed a projected leg. If a required field is
 *  ever added to `RelayDeliverySlot`, this line fails the typecheck rather than
 *  the call sites failing one by one. */
type AssertAssignable<T extends U, U> = T;
type _EffectiveLegIsASlot = AssertAssignable<EffectiveRelayLeg, RelayDeliverySlot>;

/** A rung whose leg is present. The resolution only ever reasons about these. */
type SettledRung = RelayRetryRow & { leg: RelayRecipientDelivery };

/** A rung's leg has reached an END STATE when its status is one of these. */
const TERMINAL_RUNG_STATUSES: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>([
  'delivered',
  'undelivered',
  'failed',
]);

/** The bucket key: the ROOT row plus the member key. Exported so no consumer
 *  builds it by hand - a key built the other way round silently finds nothing. */
export function relayRetryKey(rootTsMsgId: string, memberKey: string): string {
  return `${rootTsMsgId}|${memberKey}`;
}

/** Parse an ISO clock off the wire, or `undefined` when it is absent or does not
 *  parse. Deliberately mirrors `parseWireClock` in deliveryStatus.ts, which is
 *  private to that module: a present-but-malformed clock must fall to the
 *  NO-CLOCK case, where the rule is explicit, rather than becoming a NaN that
 *  silently never ages. (`isQuietSince` answers false for both, so the two
 *  modules agree even though the parser could not be shared.) */
function parseRetryClock(iso: string | undefined): number | undefined {
  if (iso === undefined || iso.length === 0) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Rungs sort by attempt, then by clock, then by key - so "the LAST rung" is the
 *  same rung whatever order the host merged the page in. */
function compareRungs(a: RelayRetryRow, b: RelayRetryRow): number {
  if (a.relay_retry_attempt !== b.relay_retry_attempt) {
    return a.relay_retry_attempt - b.relay_retry_attempt;
  }
  const aAt = a.atMs ?? Number.POSITIVE_INFINITY;
  const bAt = b.atMs ?? Number.POSITIVE_INFINITY;
  if (aAt !== bAt) return aAt - bAt;
  if (a.tsMsgId === b.tsMsgId) return 0;
  return a.tsMsgId < b.tsMsgId ? -1 : 1;
}

/**
 * LINEAGE half - memoizable on `items`.
 *
 * Buckets every retry row in the thread under `${relay_retry_of}|${member key}`.
 * Rows that are not retry rows, and rows missing either half of the key, are
 * skipped: the key is what the projection looks up, so a row without one could
 * only be attached to a leg by guessing.
 */
export function indexRelayRetries(items: readonly TimelineItem[]): Map<string, RelayRetryRow[]> {
  const byKey = new Map<string, RelayRetryRow[]>();
  for (const item of items) {
    // Narrow on the KIND first, the same order the `visible` memo reads in: the
    // tour host feeds a milestone-MERGED list, and a milestone carries no
    // tsMsgId and no lineage at all.
    if (item.kind !== 'message') continue;
    const rootTsMsgId = item.relay_retry_of;
    const memberKey = item.relay_retry_member_key;
    if (typeof rootTsMsgId !== 'string' || rootTsMsgId.length === 0) continue;
    if (typeof memberKey !== 'string' || memberKey.length === 0) continue;
    const attempt = item.relay_retry_attempt;
    const row: RelayRetryRow = {
      tsMsgId: item.tsMsgId,
      atMs: parseRetryClock(item.at),
      relay_retry_of: rootTsMsgId,
      relay_retry_member_key: memberKey,
      relay_retry_attempt: typeof attempt === 'number' && Number.isFinite(attempt) ? attempt : 0,
      ...(item.relay_retry_origin_direction !== undefined && {
        relay_retry_origin_direction: item.relay_retry_origin_direction,
      }),
      leg: item.delivery_recipients?.[memberKey],
    };
    const key = relayRetryKey(rootTsMsgId, memberKey);
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, [row]);
    else bucket.push(row);
  }
  for (const bucket of byKey.values()) bucket.sort(compareRungs);
  return byKey;
}

/**
 * Has this rung reached an END STATE of its own? Exported because the ticker
 * clause (D18) must ask the same question this module answers - a second
 * derivation is how the ticker and the chip come to disagree about whether a
 * ladder is still running.
 *
 * A malformed rung (no leg) is NOT terminal and NOT live: it is ignored.
 */
export function isRetryRungTerminal(row: RelayRetryRow): boolean {
  const leg = row.leg;
  if (leg === undefined) return false;
  return TERMINAL_RUNG_STATUSES.has(leg.status);
}

/**
 * The clock a non-terminal rung's staleness budget runs FROM (D18's two halves).
 *
 * A relay leg cannot reach `sent` without a `sentAt`, so the presence of a
 * parseable `sentAt` IS "this rung reached sent": from there the budget is the
 * ordinary missing-receipt window. Without one, the rung never left the claim
 * and the budget runs from the RETRY ROW's own `at` - the stranded-claim half.
 * A `sent` rung whose `sentAt` will not parse falls back to the row clock,
 * which is earlier, so it ages sooner rather than never.
 */
function rungStalenessClockMs(row: RelayRetryRow): number | undefined {
  const leg = row.leg;
  if (leg === undefined) return undefined;
  return parseRetryClock(leg.sentAt) ?? row.atMs;
}

/**
 * Is this rung still plausibly in flight? Exported for the same reason as
 * `isRetryRungTerminal`.
 *
 * `nowMs === undefined` means NO time-derived judgement is available (a host
 * with no ticker, or a test asserting the clockless case): a non-terminal rung
 * then reads live and can never be called `unconfirmed`, because calling a
 * ladder dead needs a clock and the alternative - guessing - is the indefinite
 * promise this design removed.
 */
export function isRetryRungLive(row: RelayRetryRow, nowMs: number | undefined): boolean {
  if (row.leg === undefined) return false;
  if (isRetryRungTerminal(row)) return false;
  if (nowMs === undefined) return true;
  // The module's ONLY staleness budget, reused through its own predicate so the
  // two horizons cannot drift apart from the leg-level one (D18). This
  // deliberately does NOT route through `stalenessClockMs`: that helper is
  // shared with the FENCED native group-text product, its refusal to age a
  // `queued` leg is deliberate, and it yields one clock per bubble - while this
  // state is computed from one row's clock and rendered on another's.
  return !isQuietSince(rungStalenessClockMs(row), nowMs);
}

/**
 * Overlay the DECIDING rung's own leg onto the original slot.
 *
 * A retried leg's per-attempt facts belong to the ATTEMPT that decided it, not
 * to the first one: the original slot's `sentAt`, `sid` and `actualTransport`
 * describe a send that failed, so leaving them in place makes the row recite the
 * FAILED attempt's clock and transport beside a state derived from a later one.
 * The row's own time comes straight off this slot (`recipientRowTime` in
 * Timeline.tsx), which is why the overlay is a REPLACEMENT rather than a
 * fill-in: a rung that never sent must clear the original's `sentAt` instead of
 * inheriting it, or the row times a send this attempt never made.
 *
 * `errorCode` is CLEARED. The original's carrier code belongs to the attempt
 * that earned it; a code beside a deciding rung that delivered - or that is
 * merely quiet - is a contradiction the four independent reason sites read.
 *
 * `requestedTransport` is PRESERVED from the original, and it is the one field
 * that must be: an inbound retry row never carries a message-level
 * `requestedTransport` (D2), so taking the rung's absent value would drop the
 * transport line to `Unknown` on exactly the inbound source whose rows are the
 * only delivery information a screen-reader user gets. Every other field the
 * spread does not name survives too.
 */
function withDecidingRung(
  slot: RelayRecipientDelivery,
  leg: RelayRecipientDelivery,
): RelayRecipientDelivery {
  const {
    errorCode: _clearedWithTheFailedAttempt,
    status: _statusIsTheRungs,
    sid: _sidIsTheRungs,
    sentAt: _sentAtIsTheRungs,
    deliveredAt: _deliveredAtIsTheRungs,
    actualTransport: _actualTransportIsTheRungs,
    transportAggregationState: _aggregationStateIsTheRungs,
    ...preserved
  } = slot;
  return {
    ...preserved,
    status: leg.status,
    ...(leg.sid !== undefined && { sid: leg.sid }),
    ...(leg.sentAt !== undefined && { sentAt: leg.sentAt }),
    ...(leg.deliveredAt !== undefined && { deliveredAt: leg.deliveredAt }),
    ...(leg.actualTransport !== undefined && { actualTransport: leg.actualTransport }),
    ...(leg.transportAggregationState !== undefined && {
      transportAggregationState: leg.transportAggregationState,
    }),
  };
}

/**
 * COULD this rung ever go quiet? The ticker's retry clause is
 * `canRetryRungGoQuiet(rung) && isRetryRungLive(rung, nowMs)` - deliberately the
 * same shape as the leg-level `canEverGoStale(...) && !isStaleLeg(...)` beside
 * it, and for the same reason: a rung that can never age would answer "live" on
 * every tick for ever, and the interval that exists to re-render it would never
 * terminate.
 *
 * Reachable, not defensive. A rung ages from its leg's `sentAt` or, failing
 * that, from the retry ROW's own `at` - and `messageInstant`
 * (conversation/useRelayThread.ts) answers `''` for a row with no `provider_ts`
 * and a non-ISO `tsMsgId`, which parses to nothing. A `queued` rung on such a
 * row has neither clock.
 *
 * WHAT THIS DOES NOT DO, and it is a disclosed trade in the same shape as
 * `canEverGoStale`'s: it does not change how such a rung PROJECTS. With no clock
 * to age from, `isRetryRungLive` still answers true and the leg still reads
 * `retrying`. The ticker simply stops paying for a re-render that could never
 * change the answer.
 */
export function canRetryRungGoQuiet(row: RelayRetryRow): boolean {
  const clock = rungStalenessClockMs(row);
  return clock !== undefined && Number.isFinite(clock);
}

/** Resolve one leg against its own rungs. See `projectRelayLegs`. */
function projectOneLeg(
  slot: RelayRecipientDelivery,
  rows: readonly RelayRetryRow[] | undefined,
  nowMs: number | undefined,
): EffectiveRelayLeg {
  const rungs = (rows ?? []).filter((row): row is SettledRung => row.leg !== undefined);
  if (rungs.length === 0) return { ...slot };

  // 1. DELIVERED WINS PERMANENTLY. A rung that reached the member cannot be
  //    un-reached by a sibling rung reporting failure afterwards, whatever
  //    order the callbacks land in. The DELIVERING rung's own leg is overlaid
  //    (see `withDecidingRung`), so the row's time and transport line describe
  //    the send that actually landed rather than the one that failed. The
  //    original's carrier code goes with it: an effective status of `delivered`
  //    beside a live 30003 is a contradiction, and the row copy for this state
  //    carries no reason.
  //    (An `excluded` slot carrying a code would drop out of
  //    `includedRecipientEntries` if its code were removed - unreachable here,
  //    because a leg must have been ATTEMPTED to earn a carrier failure, and a
  //    leg that was never attempted has no retry row.)
  const delivering = rungs.filter((rung) => rung.leg.status === 'delivered').at(-1);
  if (delivering !== undefined) {
    return {
      ...withDecidingRung(slot, delivering.leg),
      // Restated rather than inherited: `presentRelayDelivery` counts a
      // `delivered-on-retry` leg through `status === 'delivered'` alone, so the
      // one field that arithmetic depends on is visible at this branch.
      status: 'delivered',
      retryState: 'delivered-on-retry',
    };
  }

  // 2. ANY live rung inside the budget is `retrying`. The original's `status`
  //    and `errorCode` are left exactly as they are: the row copy for this
  //    state recites the carrier reason ("Retrying - Phone unreachable (error
  //    30003)"), and it is the consumer's `retryState` branch - not a rewritten
  //    status - that moves this leg out of the failed count (D19).
  if (rungs.some((rung) => isRetryRungLive(rung, nowMs))) {
    return { ...slot, retryState: 'retrying' };
  }

  // 3. A rung past EITHER horizon with no terminal outcome is `unconfirmed`.
  //    Reachable only with a clock: without one every non-terminal rung is live
  //    at step 2, so `unconfirmed` is never asserted on a guess.
  //
  //    The QUIET RUNG's own leg is overlaid, which is what lets the row and the
  //    recital recite today's not-confirmed copy (D19's second table). The
  //    original slot's status is TERMINAL - that is why a ladder exists at all -
  //    and a terminal status can never present as not-confirmed, so leaving it
  //    in place would render `Undelivered` on the row beside a chip counting
  //    the same leg under "not confirmed". `status` still carries only values
  //    the closed `DeliveryStatus` union admits: a non-terminal rung is
  //    `queued` or `sent` by construction.
  const quiet = rungs.filter((rung) => !isRetryRungTerminal(rung)).at(-1);
  if (quiet !== undefined) {
    return { ...withDecidingRung(slot, quiet.leg), retryState: 'unconfirmed' };
  }

  // 4. Otherwise every rung ended and none delivered. The close code comes from
  //    the LAST rung when it carries one - a D9 gate refusal or an enqueue
  //    failure has no bubble of its own, so its reason can only be read here -
  //    and otherwise the original's carrier code stands (D19).
  const last = rungs[rungs.length - 1];
  const closeCode = last?.leg.errorCode;
  return {
    ...slot,
    ...(closeCode !== undefined && { errorCode: closeCode }),
    retryState: 'terminal',
  };
}

/**
 * TIME-DERIVED half - MUST be recomputed against `nowMs`.
 *
 * Projects one message's recipient ENTRIES into effective legs. Each entry's
 * ORIGINAL slot is SPREAD and only what this module decides is overlaid, and
 * WHICH fields those are depends on the state:
 *
 *  - `retrying` and `terminal` touch the slot's OWN facts not at all. The
 *    original leg is still the one being described: `retrying` recites its
 *    carrier reason ("Retrying - Phone unreachable (error 30003)") and
 *    `terminal` only replaces `errorCode` when the last rung carries a close
 *    code of its own.
 *  - `delivered-on-retry` and `unconfirmed` overlay the DECIDING rung's leg -
 *    `status`, `sid`, `sentAt`, `deliveredAt`, `actualTransport`,
 *    `transportAggregationState` - and clear `errorCode`. See
 *    `withDecidingRung` for why that is a replacement rather than a fill-in,
 *    and why `requestedTransport` is the field it must preserve.
 *
 * A member with no retry rows gets a copy of its slot and NO `retryState`, so a
 * thread that has never had a retry projects to exactly what it started with.
 */
export function projectRelayLegs(args: {
  entries: readonly (readonly [string, RelayRecipientDelivery])[];
  rootTsMsgId: string;
  retries: Map<string, RelayRetryRow[]>;
  nowMs: number | undefined;
}): Map<string, EffectiveRelayLeg> {
  const { entries, rootTsMsgId, retries, nowMs } = args;
  const projected = new Map<string, EffectiveRelayLeg>();
  for (const [memberKey, slot] of entries) {
    // Strictly on the member key the retry row names. One contact on two
    // numbers already collapses into ONE slot (D5); the join must not invent a
    // second one by matching on anything looser.
    const rows = retries.get(relayRetryKey(rootTsMsgId, memberKey));
    projected.set(memberKey, projectOneLeg(slot, rows, nowMs));
  }
  return projected;
}
