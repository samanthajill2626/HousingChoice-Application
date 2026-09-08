# Slice E (plan Tasks 9-10) - the positions, the ticker, the hosts

Dashboard only. Still INERT: no production row carries `relay_retry_of`, so the
projection is the identity on every relay thread in the product today and
nothing here can change a pixel until Tasks 11-13 land the server side.

## Commits

| commit | what | files |
| --- | --- | --- |
| `51b12e13` | R1 + R2 (the two orchestrator rulings) | `relayRetryJoin.ts`, `relayRetryJoin.test.ts`, `deliveryStatus.ts`, `deliveryStatus.test.ts` |
| `bbe58487` | T9 the four positions + the ticker clause | `Timeline.tsx`, `Timeline.delivery.test.tsx`, `Timeline.ticker.test.tsx`, `relayRetryJoin.ts`, `relayRetryJoin.test.ts` |
| `65bed580` | T10 the two hosts | `routes/tours/TourConversation.test.tsx`, `routes/placements/PlacementConversation.test.tsx` |

Nothing outside those seven files was touched. No host needed a source change.

## Gates

- `npm run typecheck` (bare, from `W:\tmp\relay-30003-retry-lineage`) after EACH
  commit: **exit 0, three times.**
- `npx vitest run src/routes/contact/`:
  `Test Files 58 passed (58) / Tests 1138 passed (1138)`.
- Per file, quoted from `--reporter=basic`:
  - `src/routes/contact/Timeline.test.tsx (155 tests)` - unchanged, 155
  - `src/routes/contact/Timeline.delivery.test.tsx (34 tests)` - 28 + 6
  - `src/routes/contact/Timeline.ticker.test.tsx (31 tests)` - 26 + 5
  - `src/routes/contact/Timeline.email.test.tsx (8 tests)` - unchanged
  - `src/routes/contact/deliveryStatus.test.ts (122 tests)` - 118 + 4
  - `src/routes/contact/relayRetryJoin.test.ts (33 tests)` - 27 + 6
  - `src/routes/conversation/GroupTextView.test.tsx (62 tests)` - the FENCED
    native group-text product, unchanged
  - `src/routes/tours/TourConversation.test.tsx (30 tests)` - 28 + 2
  - `src/routes/placements/PlacementConversation.test.tsx (22 tests)` - 20 + 2
- `npx vitest run src/routes/placements src/routes/tours`: 30 files, all pass.
- `npx eslint` on all nine touched paths: **1 error, PRE-EXISTING** -
  `Timeline.tsx:1450 react-hooks/set-state-in-effect` on `setNow(fresh)`, the
  same one slice D baselined against `git show main:` and left alone. It is ~530
  lines from this slice's nearest hunk. Not mine.
- ASCII: `git diff -U0 -- FILE | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c`
  prints `0` for all nine. No pre-existing non-ASCII byte was touched.

## The two rulings, as implemented

**R1 - the `unconfirmed` row copy.** `projectRelayLegs` overlays the LAST
non-terminal rung's leg (`relayRetryJoin.ts:345-348`), so `status` is `queued`
or `sent` - both already in the closed union. `presentLegDelivery` maps that
pair explicitly at `deliveryStatus.ts:666-675`, `queued` to
`STALE_QUEUED_PRESENTATION` and anything else to `STALE_SENT_PRESENTATION`,
never through `stalenessClockMs`. `presentRelayDelivery`'s J-count was already
disjoint and is unchanged; its "counts once" case is still green.

**R2 - the delivered retry's row time.** Same mechanism, the LAST DELIVERING
rung (`:312-321`).

**Both overlays are REPLACEMENTS, via one helper** (`withDecidingRung`,
`relayRetryJoin.ts:239-274`): `status`, `sid`, `sentAt`, `deliveredAt`,
`actualTransport`, `transportAggregationState` come from the rung including
their ABSENCE, `errorCode` is cleared, `requestedTransport` and everything else
survive. Replacement rather than fill-in because `recipientRowTime`
(`Timeline.tsx:499-503`) reads the slot: a rung that never sent must clear the
original's `sentAt` or the row times a send that attempt never made.
`requestedTransport` is the field that must NOT be taken from the rung - an
inbound retry row never carries one (D2) and losing it drops the transport line
to `Unknown` on exactly the inbound source whose rows are the only delivery
information a screen-reader user gets.

`retrying` and `terminal` are untouched, as slice C shipped them.

## How the projection is recomputed against the clock

Two memos and one deliberate non-memo:

1. **LINEAGE half** - `Timeline.tsx:1980`,
   `useMemo(() => indexRelayRetries(items), [items])`. **Dependency list:
   `[items]`.** Built from `items`, NOT `visible`: the D20 rule twelve lines
   above has just hidden almost every retry row, and those hidden rows are the
   evidence.
2. **TIME-DERIVED half** - `Timeline.tsx:1010-1022`, `projectRelayLegs({entries:
   recipientEntries, rootTsMsgId: msg.tsMsgId, retries: retryIndex, nowMs:
   bubbleNowMs})`. **NOT MEMOIZED AT ALL.** It runs in the bubble body on every
   render, so it recomputes whenever `tickNow` moves, and there is no dependency
   list that could freeze it. The entries and rows beside it are recomputed per
   render too, so this matches the file's existing shape.
3. `tickerArmed` - `Timeline.tsx:2031-2034`, deps `[visible, tickNow,
   retryIndex]`.

The projection is gated on `rosterKind === 'relay'`, so the fenced native
group-text product's slots are not even copied.

## The four positions

All read ONE derived set - `RecipientRow.slot` is now the `EffectiveRelayLeg`
(`Timeline.tsx:482-490`), so the type system carries `retryState` to the rows
rather than erasing it:

- rollup chip: `Timeline.tsx:1031-1048`, `retryAware: isRelayLeg`
- rollup recital + inbound recital: both through
  `recipientSummaryName(... recipientRows ...)` - `rollupName` `:1067-1078`,
  `inboundRecipientName` `:1111-1122`
- per-recipient rows, `orderRecipientRows` and `recipientRowTime`: `:1051`,
  rendered `:1213-1241`

**One change the brief called for and I want flagged as a real edit, not
plumbing**: BOTH reason sites now read
`leg?.reason ?? (leg?.isFailure === true ? deliveryReason(...) : undefined)`
(`Timeline.tsx:608-613` and `:1236-1241`). Without it `Retrying` renders with no
reason at all: slice D put the reason ON the presentation precisely because the
caller's own `deliveryReason` call fires only on `isFailure`, and `Retrying`
deliberately is not one. `presentLegDelivery` returns a `reason` for that state
and no other, so the `??` is inert everywhere else.

**Untouched, as fenced**: the rollup's `outbound` gate, `stalenessClockMs`,
`ALLOWED_PRIOR`, the T7 filter block, the 1:1 `retry_of` collapse, and the
message-level chip's accessible name.

## The final clause counts in Timeline.tsx, quoted

```
:771  * FIVE distinct non-terminations have been shipped-and-caught behind this one
:772  * line and a SIXTH was designed out before it could ship - six in total, each
:773  * closed by a specific clause here:
:817  * cannot change any pixel, so it must not buy an interval. SIX clauses carry
:1987   // see `hasTickableLeg` for the six non-terminations that predicate closes.
```

Both counts land on SIX and both lists now have six items: the docblock gains
item 6 (`:796-810`, the frozen retry state) and the mirror gains a sixth bullet
(`:833-841`, the live retry rung). The `:771` sentence is REWORDED rather than
just renumbered - "have been shipped-and-caught" was a historical claim, and the
sixth was designed out rather than shipped, so the plain "Six distinct
non-terminations have been shipped-and-caught" the brief's arithmetic implies
would have been false. `Timeline.ticker.test.tsx:11` states a count of REVIEW
ROUNDS, not of predicate clauses, and is left alone per adjudication D2.

## Divergences from the plan / the rulings, and why

1. **A THIRD export was added to `relayRetryJoin.ts`: `canRetryRungGoQuiet`**
   (`:286-289`), beyond R1 and R2. The ticker clause could not otherwise
   terminate. `isRetryRungLive` answers TRUE FOR EVER on a rung with no clock to
   age from, because `rungStalenessClockMs` returns `undefined` and
   `isQuietSince` reads "no clock" as "not quiet". That is reachable - the join
   parses the retry ROW's `at`, and `messageInstant`
   (`useRelayThread.ts:41-45`) answers `''` for a row with no `provider_ts` and
   a non-ISO `tsMsgId` - and it is the NaN-clock non-termination (#4) one level
   down. The predicate is derived from the join's own private clock helper so
   nothing drifts, and the clause reads
   `canRetryRungGoQuiet(rung) && isRetryRungLive(rung, bubbleNowMs)`
   (`Timeline.tsx:864-868`), the same shape as the
   `canEverGoStale(...) && !isStaleLeg(...)` beside it. `stalenessClockMs` is
   NOT touched.
   **Disclosed trade, in the same shape as `canEverGoStale`'s own**: it does not
   change how such a rung PROJECTS. A clockless rung still reads `retrying`, for
   ever. Closing THAT needs a decision on the join's four-state resolution -
   see "For the orchestrator".
2. **One pre-existing case had to move**, and only one. The
   `it.each([['terminal'], ['unconfirmed']])` "falls through to the logic shipped
   today" case encoded exactly the behaviour R1 reverses. It is split: `terminal`
   keeps that assertion, `unconfirmed` gets the two shapes the projection can
   actually produce, a no-clock case proving the staleness path is not
   re-derived, and a group-text case proving the fence. Every other pre-existing
   case in both files is untouched and green.
3. **`withDecidingRung` also replaces `deliveredAt` on the `unconfirmed` path**,
   where R1 named five fields. Unreachable in practice (a non-terminal rung has
   no `deliveredAt`, and an original that earned a ladder is failed/undelivered
   and has none either) and it keeps ONE overlay helper rather than two
   near-identical ones. Say the word and it is a two-line split.
4. **`RecipientRow.slot` and `orderRecipientRows`'s parameter were widened** to
   `EffectiveRelayLeg`. Not in the brief's file list as a change, but erasing to
   the wire type would have carried `retryState` at runtime while the static type
   denied it - the shape the whole "one derived set" argument exists to prevent.
5. **The tour host needed THREE api mocks added** (`getConversation`,
   `getConversationMembers`, `getConversationScheduled`), per adjudication D5.
   Harness only; no source change. Without them the roster was `[]` and every
   recital collapsed through `recipientSummaryName`'s case-3 clause, so the
   plan's third assertion (the named recital) was unassertable there.
6. **The `messageChipName` recital shares `recipientRows`** with the other three.
   Its HEADLINE - the fenced part, which reads `msg.error_code` - is untouched,
   and the site is inert by construction: it renders only when every leg opted
   out, and an opted-out leg was never sent to, so no ladder exists for it. Noted
   in place at `Timeline.tsx:1089-1099` so a later auditor does not read it as an
   oversight.
7. **Test counts are above the plan's.** 6 new delivery cases (the plan's 2, plus
   `retrying`, `terminal`, `unconfirmed`, and the IDENTITY case that pins a
   no-retry bubble byte for byte against the shipped 30003 strings), 5 ticker
   cases (the plan's 3, plus termination on the horizon and the already-quiet
   silent case), 6 join cases, 4 presenter cases.

## For the orchestrator

- **THE RETRY BUBBLE'S OWN CHIP READS `Delivered 1/1`, NOT `delivered 1/1 on
  retry`.** Spec D19's table and D22 both call for the latter, and the e2e in
  Sec 7 / T14 asserts "a second bubble reading `delivered 1/1 on retry`".
  Nothing in slices C-E produces it: the join buckets on the ROOT id, so a retry
  row's own leg has no `retryState`, and its rollup takes the shared
  all-delivered label. This was outside T9's four positions and I did not force
  it. It needs one decision - roughly "a message carrying `relay_retry_of` whose
  own leg delivered projects `delivered-on-retry`" - and it will otherwise
  surface as a T14 failure. The delivery test at
  `Timeline.delivery.test.tsx:874-876` asserts `getAllByRole('img')` has length
  2, so the second chip's existence is already pinned; only its text is open.
- **A clockless rung reads `retrying` for ever** (divergence 1). The ticker no
  longer spins for it, but the display promise is the M5 falsehood one level
  down. The honest answer is `unconfirmed`, and the one-line change is an early
  `if (nowMs !== undefined && !canRetryRungGoQuiet(row)) return false;` in
  `isRetryRungLive`. I did not make it: it changes the four-state resolution,
  which is slice C's adjudicated contract and beyond my two rulings.
- **Nothing in a fenced product moved.** `GroupTextView.test.tsx` 62 green, and
  the presenter's group-text fence now has explicit `unconfirmed` coverage
  (`deliveryStatus.test.ts:1399-1426`), including the `queued` shape the new
  clause would otherwise match. The broadcasts suites are green too.
- **`e2e/support/selectors.md` is still untouched**, per adjudication E3 - the
  two new relay row strings and the four `retry_*` codes are slice H's edit. The
  strings this slice renders, verbatim: `Retrying - Phone unreachable (error
  30003)`, `Delivered on retry`, `Queued - not confirmed`, `Sent - not
  confirmed`, `Undelivered - Not retried - number changed since`,
  `delivered 2/2 - 1 on retry`, `delivered 1/2 - 1 retrying`,
  `delivered 1/2 - 1 not confirmed`.
- **The recital's separator is a COMMA, not a dash.** `speakDeliveryText` splits
  on ` - `, so the row's `Retrying - Phone unreachable (error 30003)` is recited
  as `Retrying, Phone unreachable (error 30003)`. Every accessible-name
  assertion here uses the comma form; a reviewer diffing the two tables should
  not read that as a disagreement.
