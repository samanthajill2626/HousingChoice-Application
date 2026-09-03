# Slice D (plan Tasks 7-8) - the render filter and the presenter

Dashboard only. Everything here is INERT: no production row carries
`relay_retry_of` and no production caller sets `retryAware`, so nothing in this
slice can change a pixel until Tasks 11-13 land the server side.

## Commits

| commit | task | files |
| --- | --- | --- |
| `5d2feb14` | T7 the D20 render filter | `dashboard/src/routes/contact/Timeline.tsx`, `dashboard/src/routes/contact/Timeline.test.tsx` |
| `e4e8b533` | T8 the presenter | `dashboard/src/routes/contact/deliveryStatus.ts`, `dashboard/src/routes/contact/deliveryStatus.test.ts` |

Nothing else was touched. In `Timeline.tsx` the ONLY hunk is
`@@ -1795,6 +1795,41 @@` - inside the `visible` memo, nothing else in the file.

## Gates

- `npm run typecheck` (bare, from `W:\tmp\relay-30003-retry-lineage`) after EACH
  commit: exit 0, both times.
- `npx vitest run src/routes/contact/Timeline.test.tsx`:
  `Test Files 1 passed (1) / Tests 155 passed (155)` - 145 pre-existing plus this
  slice's 10.
- `npx vitest run src/routes/contact/deliveryStatus.test.ts`:
  `Test Files 1 passed (1) / Tests 118 passed (118)` - 86 pre-existing plus this
  slice's 32.
- **The pre-existing 86 were run in isolation against the NEW presenter**: the
  HEAD copy of the test file was checked out beside the modified one and run
  alone - `Tests 86 passed (86)`. That is the only available proof that the
  shared labels did not move, since there is no way to import a `main` build.
- Importer suites from worklist A1.17, all PASS:
  `Test Files 9 passed (9) / Tests 355 passed (355)` for
  `Timeline.delivery.test.tsx` (28), `Timeline.email.test.tsx` (8),
  `Timeline.test.tsx` (155), `relayRetryJoin.test.ts` (27),
  `broadcasts/broadcastFormat.test.ts` (12),
  `broadcasts/BroadcastResults.test.tsx` (11),
  `broadcasts/StatChips.test.tsx` (11),
  `conversation/GroupTextView.test.tsx` (62) - the FENCED native group-text
  product - and `conversation/ConversationDetail.test.tsx` (41).
- `npx eslint` on the four touched paths: 1 error, PRE-EXISTING, and attributed
  by BASELINE COMPARISON rather than by line number -
  `Timeline.tsx react-hooks/set-state-in-effect` on `setNow(fresh)`, which
  reproduces identically on `git show main:.../Timeline.tsx` linted in place.
  It sits ~470 lines above this slice's only hunk. Not mine; left alone.
- ASCII: `git diff -U0 | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` prints
  `0` for all four files. No pre-existing byte was touched (`deliveryStatus.ts`
  keeps its real U+2026 and U+2014; `Timeline.tsx` keeps the em dash in the
  retry-collapse comment above the memo).

## T7 - the render filter (D20)

`Timeline.tsx:1798-1831`, inside the `visible` memo, ALONGSIDE the
`supersededIds` rule and not inside it (that rule hides a PREDECESSOR, this one
hides the row itself). Narrowed on `kind === 'message'` first (`:1817`), as
adjudication D7 requires, because the tour host feeds this memo a
milestone-merged list.

A `relay_retry_of`-carrying message renders only when BOTH hold:

1. `relay_retry_origin_direction === 'outbound'` (`:1823`) - anything else,
   `undefined` included, HIDES;
2. `delivery_recipients?.[relay_retry_member_key]?.status === 'delivered'`
   (`:1830`), read from the retry row's OWN slot.

Not routed through the join: `visible` is memoized on `[items, commsOnly]`, so
consuming the time-derived half would freeze it. The filter is a pure function
of the row, which is also what makes an orphaned retry decide correctly before
its original has paged in (D22).

The block carries D20's two sentences plus the `retry_of` inversion warning
(`:1806-1811`): a relay retry row must never carry `retry_of`, because that would
add the ORIGINAL to `supersededIds` and delete the original bubble.

10 new cases (`Timeline.test.tsx:3231+`): the plan's five, plus the two the brief
added - a milestone-merged list with a hidden retry row beside `MILESTONE` and
`NUMBER_ADDED` (renders the original once, both milestones survive, no throw),
and a delivered retry whose `relay_retry_origin_direction` is `undefined` - plus
a missing-member-key row. The fenced 1:1 `retry_of` collapse has its own case.

## T8 - the exact presenter contract slice E consumes

`dashboard/src/routes/contact/deliveryStatus.ts`:

```ts
// :16 - TYPE-ONLY. relayRetryJoin.ts imports VALUES from this module, so a value
// import back would be a runtime cycle. No lint rule fired (the flat config
// carries no `import` plugin, so there is no `import/no-cycle`).
import type { RelayRetryState } from './relayRetryJoin.js';

// :177 - the widened leg type. Structurally the SUPERTYPE of slice C's
// `EffectiveRelayLeg`, and `retryState` is optional, so every pre-retry caller
// still passes a bare `RelayDeliverySlot`.
export interface RetryAwareRelayLeg extends RelayDeliverySlot {
  retryState?: RelayRetryState;
}

// :386 - on RelayDeliveryOptions. OFF by default.
retryAware?: boolean;

// :423 - widened parameter; `readonly` so a ReadonlyArray of projected legs
// passes without a copy.
export function presentRelayDelivery(
  slots: readonly RetryAwareRelayLeg[],
  opts: RelayDeliveryOptions = {},
): DeliveryPresentation | null;

// :590 - widened first parameter only; the other three are unchanged.
export function presentLegDelivery(
  slot: RetryAwareRelayLeg,
  rosterKind: LegRosterKind,
  messageAtMs?: number,
  nowMs?: number,
): DeliveryPresentation | null;
```

**`retryAware` absent or false ignores `retryState` entirely.** `retryStateOf`
(`:445`) reads `undefined` for every leg, so all four counts collapse to the two
this function shipped with. Native group text and the broadcasts routes never
pass it.

**The chip arithmetic under the flag** (`:456-495`):

| count | rule | anchor |
| --- | --- | --- |
| delivered | unchanged - the join already overlaid `status: 'delivered'` on a `delivered-on-retry` leg, so it counts itself | `:455` |
| K `failed` | hard-failed AND retryState `terminal` or absent | `:458-463` |
| R `retrying` | retryState `retrying` | `:465` |
| `on retry` | retryState `delivered-on-retry` - a SUFFIX on the delivered count, not a category | `:468` |
| J `not confirmed` | UNION of retryState `unconfirmed` and `isStaleLeg`, with live/delivered ladders excluded outright, so a leg that is both counts ONCE | `:473-479` |

K, R and J are disjoint by construction and the label adds them. Compose order is
FIXED - `on retry`, then failed, retrying, not confirmed - comma-joined after
`delivered N/M - `, zero-count categories omitted (`:488-495`).

Labels, tones and `isFailure`:

| situation | label | tone | isFailure |
| --- | --- | --- | --- |
| K > 0 | `delivered 3/4 - 1 failed` (+ reason from the K legs only) | danger | true |
| R or J > 0, K == 0 | `delivered 3/4 - 1 retrying` / `- 1 not confirmed` | danger | false |
| all delivered, no ladder | `Delivered 4/4` (CAPITAL, shared, unmoved) | success | false |
| all delivered, one on retry | `delivered 4/4 - 1 on retry` | success | false |
| in flight, one on retry | `delivered 1/2 - 1 on retry` | neutral | false |
| three at once | `delivered 1/4 - 1 failed, 1 retrying, 1 not confirmed` | danger | true |

The cap-exhausted string is today's, unchanged:
`delivered 3/4 - 1 failed` + reason `Phone unreachable (error 30003)`.

**`presentLegDelivery` per retry state** (`:637-661`), `rosterKind === 'relay'`
ONLY - a `group_text` leg carrying any `retryState` is untouched:

| retryState | returns |
| --- | --- |
| `retrying` | `{ label: 'Retrying', tone: 'danger', isFailure: false, reason: deliveryReason(slot.errorCode, { relay: true }) }` |
| `delivered-on-retry` | `{ label: 'Delivered on retry', tone: 'success', isFailure: false }` |
| `terminal` | falls through unchanged - the projected close code reaches the caller through `deliveryReason` |
| `unconfirmed` | falls through unchanged |

Decision order is opted-out short-circuit -> excluded -> RETRY STATES -> stale ->
`presentDeliveryStatus(slot.status)`. The opted-out short-circuit stays FIRST and
has its own test: a member who opted out was never sent to, so no ladder exists.

**The four D15 codes** (`INTERNAL_CODE_REASONS`, `:823-826`), with no
`(error N)` tail because internal codes short-circuit before every product map:

- `retry_group_closed` -> `Not retried - group closed`
- `retry_member_removed` -> `Not retried - no longer in this group`
- `retry_number_changed` -> `Not retried - number changed since`
- `retry_opted_out` -> `Not retried - opted out`

## Divergences, and why

1. **`RetryAwareRelayLeg` is declared HERE, not imported from
   `relayRetryJoin.ts`.** The brief allowed importing `EffectiveRelayLeg`, but
   that type `extends RelayRecipientDelivery` and would have narrowed this
   presenter to the RELAY wire shape - and the same function serves the FENCED
   native group-text product and the broadcasts routes, which pass plain
   `RelayDeliverySlot`s. Declaring the supertype here keeps every existing caller
   compiling by construction and keeps slice C's contract stable: an
   `EffectiveRelayLeg` is assignable to it, so slice E passes the projected map
   straight through with no cast. Only `RelayRetryState` crosses the module
   boundary, type-only.
2. **`slots` is `readonly RetryAwareRelayLeg[]`, not `RelayDeliverySlot[]`.**
   The brief's own suggested shape. `projectRelayLegs` returns a `Map`, so slice
   E will hand over `[...legs.values()]`; the `readonly` costs nothing and stops
   a future in-place sort of a caller's array.
3. **The `on retry` suffix is placed FIRST in a composed label**, e.g.
   `delivered 2/4 - 1 on retry, 1 failed, 1 retrying`. D19 fixes the order of the
   three CATEGORIES but calls `on retry` a suffix on the delivered count and
   leaves its position in a mixed label undecided. First keeps it adjacent to the
   count it qualifies and keeps the failure reason - appended inline by the
   bubble - last, which is the existing rule at `:497-500`. Reopen here if the
   founder reads it the other way; it is one line.
4. **All-delivered-with-one-on-retry is `success`**, as recommended: every leg
   did in the end deliver, so a danger cue would train staff to ignore the cue.
   The lowercase `delivered` is what distinguishes it from `Delivered N/N`, which
   now means "finalized clean, no ladder ever ran".
5. **`presentLegDelivery` takes NO `retryAware` gate.** It is gated on
   `rosterKind === 'relay'` plus the presence of `retryState`, per the brief. No
   production slot carries the field, so it is inert without one, and adding a
   fifth positional parameter to a four-parameter function used at two Timeline
   call sites buys nothing.
6. **The `retrying` row's reason is computed with `{ relay: true }` only**, not
   with the caller's media hedge. `presentLegDelivery` has no options bag, and
   the row's own `deliveryReason` call (`Timeline.tsx:1114`) fires only on
   `isFailure`, which `Retrying` deliberately is not - so the reason has to ride
   the presentation. A relay MMS leg that is retrying will therefore read
   `Retrying - Phone unreachable (error 30003)` rather than the MMS hedge.
7. **32 new tests, not the plan's ~11.** All of the plan's are present. The rest
   are the brief's five additions plus the disjointness boundaries (a leg that is
   both stale and unconfirmed; the on-retry suffix on an in-flight chip; a
   `retry_opted_out` leg proving the rollup is not nulled; group-text legs
   carrying each live state).

## For the orchestrator

- **The `unconfirmed` ROW does not say "not confirmed".** Per the brief,
  `unconfirmed` falls through to today's logic - and `isStaleLeg` is FALSE for
  every terminal status, so the original's `undelivered` slot renders
  `Undelivered` on the row while the chip counts it under `1 not confirmed`. The
  spec's second table (Sec 5, D19) says the row shows "today's not-confirmed row
  copy", which is only reachable when the leg is genuinely stale. The two
  positions therefore agree on the FACT but not on the WORD. Not changed here -
  the brief is explicit - but slice E or the reviewer should decide whether the
  row needs its own `unconfirmed` clause.
- **Slice C's residual is now closed on the D20 side.** A corrupt
  `relay_retry_origin_direction` reaches the predicate as `undefined` and HIDES,
  explicitly and with the reason in the comment.
- **`Delivered N/N` is now conditional.** Any future reader who greps for that
  label should know it is emitted only when `onRetry === 0`
  (`deliveryStatus.ts:507-510`).
- **Nothing consumes either half yet.** `Timeline.tsx` still discards the
  recipient keys at its entries call site (`:937`) and still calls
  `presentRelayDelivery` with bare slots and no `retryAware`; wiring both is
  slice E's Task 9.
- **`e2e/support/selectors.md:49` is untouched**, per adjudication E3 - the two
  new relay row strings and the four `retry_*` codes are slice H's edit.
