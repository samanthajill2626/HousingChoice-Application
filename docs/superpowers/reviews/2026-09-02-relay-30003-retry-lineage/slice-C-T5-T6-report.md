# Slice C (plan Tasks 5-6) - the wire fields and the retry join

Dashboard only. Everything here is INERT: no retry row exists until Tasks 11-13
land, so nothing in this slice can change a pixel today.

## Commits

| commit | task | files |
| --- | --- | --- |
| `c8b0724d` | T5 wire fields | `dashboard/src/api/types.ts`, `dashboard/src/routes/conversation/useRelayThread.ts`, `dashboard/src/routes/conversation/useRelayThread.test.tsx` |
| `6332843b` | T6 the join | `dashboard/src/routes/contact/relayRetryJoin.ts` (new), `dashboard/src/routes/contact/relayRetryJoin.test.ts` (new) |

Nothing else was touched. `messageTransport.ts`, `contactTimeline.ts`,
`buildTimelineFallback.ts`, `Timeline.tsx` and `deliveryStatus.ts` are unmodified.

## Gates

- `npm run typecheck` (bare, worktree root) after EACH commit: exit 0, both times.
- `npx vitest run src/routes/conversation/useRelayThread.test.tsx`:
  `Test Files 1 passed (1) / Tests 22 passed (22)` - 19 pre-existing plus this
  slice's 3.
- `npx vitest run src/routes/contact/relayRetryJoin.test.ts`:
  `Test Files 1 passed (1) / Tests 27 passed (27)` - all new.
- `npx eslint` on the five touched paths: `0 errors, 3 warnings`. The three are
  pre-existing unused `eslint-disable` directives in `useRelayThread.ts`
  (`react-hooks/set-state-in-effect`, three sites) that this slice's added lines
  shifted downward; no disable directive was added.
- ASCII: `tr -d` over both NEW files prints `0`; over the added lines of the three
  modified files, `0`.

## T5 - what crossed the wire

`TimelineMessage` gains the four at `dashboard/src/api/types.ts:2504-2511`, and
the raw `Message` wire row gains the same four at `:2299-2312`. The header
comment on each block says the digest and the leg body deliberately do NOT cross
the wire, with D11's reason (the endpoint returns stored rows as-is, so a
declared field reaches every browser on every relay thread load).

`toTimelineMessage` projects them beside `imported_from` at
`dashboard/src/routes/conversation/useRelayThread.ts:126-142`, each behind a
value guard.

## T6 - the exported contract (what slices D and E build against)

`dashboard/src/routes/contact/relayRetryJoin.ts`:

```ts
// :34
export type RelayRetryState = 'retrying' | 'delivered-on-retry' | 'terminal' | 'unconfirmed';

// :37
export interface RelayRetryRow {
  tsMsgId: string;
  atMs: number | undefined;
  relay_retry_of: string;
  relay_retry_member_key: string;
  relay_retry_attempt: number;
  relay_retry_origin_direction?: 'inbound' | 'outbound';
  leg: RelayRecipientDelivery | undefined;
}

// :69
export interface EffectiveRelayLeg extends RelayRecipientDelivery {
  retryState?: RelayRetryState;
}

// :94 - the bucket key, exported so no consumer builds it by hand
export function relayRetryKey(rootTsMsgId: string, memberKey: string): string;

// :131 - LINEAGE half, memoizable on `items`
export function indexRelayRetries(items: readonly TimelineItem[]): Map<string, RelayRetryRow[]>;

// :171 / :203 - the two rung predicates the ticker clause must reuse
export function isRetryRungTerminal(row: RelayRetryRow): boolean;
export function isRetryRungLive(row: RelayRetryRow, nowMs: number | undefined): boolean;

// :281 - TIME-DERIVED half, recompute against nowMs
export function projectRelayLegs(args: {
  entries: readonly (readonly [string, RelayRecipientDelivery])[];
  rootTsMsgId: string;
  retries: Map<string, RelayRetryRow[]>;
  nowMs: number | undefined;
}): Map<string, EffectiveRelayLeg>;
```

`type _EffectiveLegIsASlot = AssertAssignable<EffectiveRelayLeg, RelayDeliverySlot>`
(`:79-80`) pins D1's load-bearing claim at compile time: a required field added
to `RelayDeliverySlot` fails THAT line rather than every presenter call site.

## Resolution order as implemented (`:217-264`)

1. **Delivered wins permanently** (`:233`) - any rung with `leg.status ===
   'delivered'`. Overlays `status: 'delivered'` and REMOVES the original's
   `errorCode`. Beats a later failed rung AND a later live rung.
2. **Any live rung inside the budget -> `retrying`** (`:244`). `status` and
   `errorCode` untouched, so the row copy can still recite
   `Retrying - Phone unreachable (error 30003)`; it is the consumer's
   `retryState` branch, not a rewritten status, that moves the leg out of the
   failed count.
3. **A non-terminal rung past either horizon -> `unconfirmed`** (`:251`).
4. **Else `terminal`** (`:257-263`): close code from the LAST rung when it
   carries one, otherwise the original's carrier code stands.

A rung whose `leg` is `undefined` is filtered out before step 1 (`:222`), so a
malformed row is ignored rather than counted as unfinished. A member with no
rungs gets a copy of its slot and no `retryState`.

Horizons (`rungStalenessClockMs`, `:187-192`): the budget runs from
`leg.sentAt` when it parses (that presence IS "this rung reached sent" - a relay
leg cannot reach `sent` without one), else from the retry ROW's own `at`. Both
go through the exported `isQuietSince`, so `now - clock >= STALE_SENT_AFTER_MS`
is the same boundary the leg-level staleness uses. `stalenessClockMs` is not
called and not modified.

`nowMs === undefined` means no time-derived judgement: every non-terminal rung
reads live, so `unconfirmed` can never be asserted without a clock.

## Divergences from the plan's Interfaces block (each deliberate)

1. **`EffectiveRelayLeg extends RelayRecipientDelivery`**, not
   `RelayDeliverySlot` - adjudication D1, as briefed.
2. **`projectRelayLegs`'s `entries` are `RelayRecipientDelivery` pairs**, not
   `RelayDeliverySlot` pairs. Same reasoning one step earlier: the call site
   (`includedRecipientEntries(msg.delivery_recipients)`) yields wire slots, and
   typing the input narrower would erase `sid` and both transports statically
   while the output type still claims them. Both slot types are mutually
   assignable (every differing field is optional), so no caller is excluded.
3. **`RelayRetryRow.leg` is `RelayRecipientDelivery | undefined`**, not
   `RelayDeliverySlot | undefined` - it IS the wire slot, and a consumer reading
   the delivering rung's own transport or `deliveredAt` needs the eight fields.
4. **`RelayRetryRow.atMs` is `number | undefined`**, not `number`. Briefed:
   `parseWireClock` is private to `deliveryStatus.ts` and exporting a helper
   from it is out of scope here, so the clock is parsed with `Date.parse` guarded
   to `undefined` on NaN (`parseRetryClock`, `:104-107`). A present-but-malformed
   clock must fall to the NO-CLOCK case, where the rule is explicit, rather than
   becoming a NaN that silently never ages; `isQuietSince` answers false for both,
   so the two modules still agree.
5. **`deliveredAt` is NOT overlaid** on a delivered-on-retry leg (the point the
   brief left to this slice). The receipt clock belongs to the retry ROW, which
   consumers can already reach through `retries`; copying it onto a slot that
   never delivered mixes two rows' clocks from two different sources, which is
   the exact hazard `RelayDeliverySlot`'s own docblock warns about. It also lets
   the preservation test assert all six non-decided fields survive untouched,
   `deliveredAt` included, on the delivered fixture.
6. **`errorCode` IS removed on delivered-on-retry.** An effective `delivered`
   beside a live 30003 is a contradiction that four independent reason sites
   read. The one hazard is documented in place (`:225-232`): an `excluded` slot
   whose code was removed would drop out of `includedRecipientEntries` - and it
   is unreachable, because a leg must have been ATTEMPTED to earn a carrier
   failure, and a never-attempted leg has no retry row.
7. **Two additions to the plan's export list**: `relayRetryKey` (so a consumer
   cannot build the bucket key backwards) and the two rung predicates the brief
   required for slice E.
8. **`isQuietSince` is imported from `deliveryStatus.ts`** alongside
   `STALE_SENT_AFTER_MS` and `RelayDeliverySlot`. That module's own docblock says
   the predicate exists so callers "differ in WHICH legs they consider without
   ever diverging on the threshold" - which is precisely D18's requirement. No
   line of `deliveryStatus.ts` was changed.
9. **`relay_retry_attempt` falls back to `0`** when a row carries none, so a
   malformed row still participates. Nothing in the resolution reads it; it
   orders the bucket and is what a consumer displays.
10. **Test count is 27, not the plan's 11.** All eleven are present; the rest are
    the five the brief added plus boundary and predicate coverage (the horizon
    `>=` boundary, a terminal rung with no code of its own, a sent rung inside
    its own budget on a row already past the stranded-claim horizon, and
    multi-entry projection).

## For the orchestrator

- **Bucket ordering is defined here** (`compareRungs`, `:112-123`: attempt, then
  clock, then key). "The LAST rung", whose close code the terminal branch takes,
  is therefore stable whatever order the host merged the page in. Slice D should
  not re-sort.
- **`indexRelayRetries` narrows on `kind === 'message'` FIRST** (`:137`), the
  same order the `visible` memo reads in, and there is a test feeding it a
  milestone and a call carrying lineage-shaped keys.
- **Nothing consumes the join yet.** `Timeline.tsx` still discards the recipient
  keys at its entries call site; wiring that up is slice D's Task 9.
- **The four wire fields are now DECLARED on the raw `Message` type**, so slice D
  and E read them as typed properties rather than bracket reads. The retry row
  still must never carry `retry_of` (D20) - nothing in this slice reads or writes
  it.
- One residual worth an eye at review: the direction guard in the projector drops
  a `relay_retry_origin_direction` outside the union, so D20's predicate sees
  `undefined` rather than a third case. A row with a corrupt direction therefore
  falls to whatever the predicate does with an absent direction - which is slice
  D's decision to make explicit.
