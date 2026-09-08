# Slice E2 - the two gaps slice E flagged (rulings B4 and B5)

Dashboard only, and still INERT: no production row carries `relay_retry_of` and
no production caller sets `retryAware`, so neither fix can change a pixel until
Tasks 11-13 land the server side.

## Commit

| commit | what | files |
| --- | --- | --- |
| `845cfa54` | B4 the retry bubble's own chip + B5 the clockless rung | `deliveryStatus.ts`, `relayRetryJoin.ts`, `Timeline.tsx`, `deliveryStatus.test.ts`, `relayRetryJoin.test.ts`, `Timeline.delivery.test.tsx`, `Timeline.ticker.test.tsx` |

Nothing outside those seven files was touched.

## Gates

- `npx vitest run src/routes/contact/`:
  `Test Files 58 passed (58) / Tests 1145 passed (1145)` - the 1138 slice E left
  green, plus this slice's 7. Per file, quoted from `--reporter=basic`:
  - `deliveryStatus.test.ts (125 tests)` - 122 + 3
  - `relayRetryJoin.test.ts (35 tests)` - 33 + 2
  - `Timeline.delivery.test.tsx (35 tests)` - 34 + 1
  - `Timeline.ticker.test.tsx (32 tests)` - 31 + 1
  - `Timeline.test.tsx (155 tests)` - unchanged
- The FENCED products and the two hosts, run separately because the presenter is
  shared: `npx vitest run src/routes/conversation src/routes/broadcasts
  src/routes/tours src/routes/placements` -
  `Test Files 47 passed (47) / Tests 825 passed (825)`.
- `npm run typecheck` (bare, from `W:\tmp\relay-30003-retry-lineage`, output
  captured to a file rather than piped): **exit 0**.
- `npx eslint` on all seven touched paths: **1 error, PRE-EXISTING** -
  `Timeline.tsx:1463 react-hooks/set-state-in-effect` on `setNow(fresh)`, the
  same one slices D and E baselined against `git show main:`. It was at `:1450`
  before this slice and moved only because 13 comment lines were added above it.
  Not mine.
- ASCII: `git diff -U0 -- FILE | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c`
  prints `0` for all seven. No pre-existing non-ASCII byte was touched.

## B4 - the retry bubble's own chip, as implemented

`RelayDeliveryOptions.retryRow?: boolean` (`deliveryStatus.ts:387-396`), read
ONLY under `retryAware`. In `presentRelayDelivery` it is the FIRST clause inside
the `delivered === total` branch (`:538-550`) and returns

```
{ label: `delivered ${total}/${total} on retry`, tone: 'success', isFailure: false }
```

Placed inside that branch rather than above the arithmetic on purpose: a retry
row that has NOT delivered is not rendered at all (the T7 / D20 filter), so no
other branch is reachable by one, and every non-retry row keeps taking the
shared `Delivered N/N` by construction rather than by argument.

**The suffix is written on the WHOLE count, not as an `N on retry` category.**
The original's chip still reads `delivered 2/2 - 1 on retry` because only one of
its legs took the ladder; the retry row is all ladder - one leg, addressed to the
one member it was claimed for (D1) - so a category count would state a proportion
of nothing. That is D19's first table read literally.

`Timeline.tsx:1053-1058` passes `retryRow: msg.relay_retry_of !== undefined` at
the rollup call site - off the ROW, because the join buckets rungs under the ROOT
id and this bubble's own leg therefore carries no `retryState` to read.

**No second call site was needed.** `rollupName` builds its headline from
`chipText(deliveredSummary, deliveredSummary.reason)` (`Timeline.tsx:1080-1091`),
i.e. from the presentation this option already changed, so the spoken headline
moves with the visible chip and cannot disagree with it. `messageChipName` reads
`msg.error_code` and is reached only when every leg opted out; a retry row is
addressed to one member who was sent to, so it can never take that branch.

## B5 - a clockless rung, as implemented

`isRetryRungLive` gains one line after the `nowMs === undefined` early return
(`relayRetryJoin.ts:220-221`):

```ts
  if (nowMs === undefined) return true;
  if (!canRetryRungGoQuiet(row)) return false;
```

so `projectOneLeg` falls past step 2 and resolves the leg at step 3 -
`unconfirmed`, with the quiet rung's own leg overlaid, which is what lets the row
recite today's not-confirmed copy.

**The asymmetry is the ruling and it is documented on the predicate.** No READING
clock is OUR blindness and stays live; a rung whose OWN clocks did not parse is
the ROW being unreadable, and `unconfirmed` is the honest word. Docblocks updated
on both predicates plus `rungStalenessClockMs` and step 3's comment.

`rungStalenessClockMs` is unchanged and its choice is now asserted: a rung that
reached `sent` with an unparseable `sentAt` but a valid row `at` falls back to
the ROW clock, which is earlier, so it still ages - half two's budget run off the
only clock left - and is NOT swept up by the new clause. Only when both clocks
are gone is the rung undatable.

The ticker clause at `Timeline.tsx:857-874` is unchanged in behaviour:
`canRetryRungGoQuiet` there is now redundant (`isRetryRungLive` asks it itself
whenever it has a reading clock, which is exactly that call). Kept deliberately,
with the reason in place - it mirrors the `canEverGoStale(...) && !isStaleLeg(...)`
shape beside it and keeps the clause terminating on its own terms if the
`bubbleNowMs === undefined` guard above it ever moves.

## Divergences

1. **One pre-existing case had to move, and only one.**
   `relayRetryJoin.test.ts`'s "refuses a rung with no clock to age from" asserted
   `isRetryRungLive(clockless, NOW) === true` - the disclosed trade slice E left
   open, and exactly what B5 reverses. It now asserts `false` against a reading
   clock and `true` with none, so both halves of the asymmetry are pinned in the
   place the rule lives. Every other pre-existing case in all four test files is
   untouched and green.
2. **The accessible-name assertion is on the SPOKEN form.** The brief asked that
   the retry bubble's accessible name contain `delivered 1/1 on retry`;
   `speakDeliveryText` (`Timeline.tsx:564-566`) expands `N/M` to `N of M`, so the
   name is `delivered 1 of 1 on retry.` and the test asserts that. Same
   transformation slice E flagged for the ` - ` separator; the label itself
   carries no ` - `, so nothing else moves. The VISIBLE chip is asserted as
   `delivered 1/1 on retry` verbatim.
3. **7 new tests, one above the brief's six.** The extra is
   `deliveryStatus.test.ts`'s `retryRow: false` sweep, which compares seven leg
   shapes with the flag explicitly false against the same shapes with it omitted
   - `retryRow: false` is what EVERY non-retry bubble passes, so
   indistinguishability is the property that matters, not just "the guarded
   branch is unchanged".
4. **The fenced suites were run even though the brief named only
   `src/routes/contact/`.** `presentRelayDelivery` also serves native group text
   and the broadcasts routes; 47 files / 825 tests green.

## New rendered string, for slice H

`delivered 1/1 on retry` - the retry bubble's own rollup chip. It joins the eight
slice E listed. `e2e/support/selectors.md` is still untouched, per adjudication
E3.

## For the orchestrator

- Both gaps slice E flagged are closed. The e2e in Sec 7 / T14 asserts "a second
  bubble reading `delivered 1/1 on retry`" and that string now renders.
- **`Delivered N/N` now has TWO gates**, not one: it is emitted only when
  `onRetry === 0` AND `retryRow` is not set. Any future reader grepping for the
  label should know both.
- Nothing in a fenced product moved, and no server-side behaviour changed.
