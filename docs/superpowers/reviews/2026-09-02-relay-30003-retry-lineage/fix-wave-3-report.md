# Fix wave 3 - code review R3's three LOW items

Implementer record for X1-X3 of
[`code-review-r3-adjudications.md`](./code-review-r3-adjudications.md), the
adjudication of [`code-review-r3-rereview.md`](./code-review-r3-rereview.md).
Branch `feat/relay-30003-retry-lineage`, worktree
`W:\tmp\relay-30003-retry-lineage`, base `80125815` (the R3 review commit).

Exactly the three LOWs. R3's two NOTEs (`withDecidingRung`'s positional boolean,
`EMPTY_RETRY_INDEX` as a mutable `Map`) are RECORDED and were not acted on; no
spec decision moved; nothing else in the tree was touched.

**Every change below was verified to FAIL its test with the change reverted**,
by inverting the shipped expression, running the named file and restoring. The
inversion and the observed failure are quoted per item.

## Commits

| hash | subject |
| --- | --- |
| `8be34d1b` | fix(relay): review R3 - the route answers a thrown claim with 500 itself; the chip's not-confirmed reason is fenced to retry legs |
| (this file) | docs(records): fix wave 3 report |

Bare `git status` was read before each commit and `.git/MERGE_HEAD` confirmed
absent. Explicit paths only, never `git add -A`; nothing amended; no background
command ran at any point; `AWS_ACCESS_KEY_ID` was never exported.

## The three items

### X1 (R3 LOW 1.1) - the route answers the thrown claim itself

- `app/src/routes/webhooks/twilio.ts:3176-3198` - the `relayPtr` branch wraps
  `await handleRelayRecipientStatus(relayPtr)` in a try/catch and answers
  `res.status(500).end()`. Nothing is logged there: the failure marker the
  branch already emitted IS the one ERROR line. The comment states the two
  things a reader needs - Twilio redelivers on any 5xx, and D8's state gate
  re-claims on that redelivery because the slot is already
  terminal-plus-30003.
- `app/src/routes/webhooks/twilio.ts:3195` - **the catch is NARROW**, and this
  is the wave's one design addition (divergence 1). It answers only for the
  claim's own error, recognised by IDENTITY, and rethrows anything else. An
  unrelated fault out of that branch - a throttled slot write, a throttled
  roster read - emits no marker, so a blanket catch would have produced a 500
  with NO ERROR line anywhere, which is strictly worse than the two lines X1
  exists to reduce to one.
- `app/src/routes/webhooks/twilio.ts:2909-2917` - `let relayClaimError: unknown`
  in the route's own scope, with the docblock explaining why identity is the
  discriminator (W2's `throw claimError` is unchanged, and a request runs this
  branch at most once).
- `app/src/routes/webhooks/twilio.ts:3143-3146` - the rethrow publishes the
  error into that variable and then throws it, W2's line otherwise untouched.
- `app/src/routes/webhooks/twilio.ts:3059-3067` - the "One line, one `event`"
  claim R3 called false now says WHY it is true: it holds only because the call
  site answers the 5xx, and it is pinned by a test that counts every ERROR line
  rather than the markers.
- `app/src/routes/webhooks/twilio.ts:2982-2989` - the W2 tail docblock gains the
  same clause (the call site answers 500, no status code moves, the generic
  handler's second unattributable line is what is bought).

Tests (`app/test/relayRetryClaim.webhook.test.ts`):

- `:655`, inside the existing "runs the whole tail and then REJECTS when the
  claim itself throws" - **the assertion the wave-2 report cites, corrected**.
  It read `failureLines(ERROR).filter(retryClaim === 'claim_failed')` and
  counted MARKERS, which is precisely why wave 2 could not see the second line
  it had introduced. It now also asserts `capture.atLevel(ERROR)` has length 1 -
  every ERROR line in the capture. The existing `res.status === 500`, the
  marker's shape, the single SSE and the single escalation are unchanged.
- `:705` NEW, "lets an UNRELATED relay fault keep the generic handlers ERROR
  line" - `updateRecipientDeliveryStatus` throws, so the tail never runs and no
  marker exists. Asserts 500, zero failure markers, exactly one ERROR line, and
  that it is the generic `unhandled error while handling request` carrying the
  cause. This is what makes the narrow catch a property rather than an
  intention.
- The recovery case at `:682` ("CLAIMS on the redelivery that the rejection
  triggered") is untouched and green - the 500 still comes back and the replayed
  callback still claims.

REVERT PROOF, in two parts because the catch has two halves:

- `if (err !== relayClaimError) throw err;` -> `throw err;` (i.e. pre-X1: the
  rethrow travels to Express) - the tail case fails with
  `expected [ { level: 50, ...(15) }, ...(1) ] to have a length of 1 but got 2`
  (`1 failed | 30 passed`). That is R3's reproduction, exactly.
- The guard removed entirely (a blanket catch) - the new case fails with
  `expected [] to have a length of 1 but got +0` (`1 failed | 30 passed`), i.e.
  a 500 with no ERROR line at all.

### X2 (R3 LOW 1.2) - the redelivery multiplier, in the W9c comment

`app/src/routes/webhooks/twilio.ts:3038-3045`. The DeliveryFailures note named
root + three rungs; it now adds that the marker sits BEFORE the claim's rethrow,
so a callback whose claim throws emits `delivery_failed` on the 5xx AND again on
the redelivery the 5xx triggers, once per redelivery for as long as the fault
lasts. The clause says plainly that this is not new with the branch - any
redelivered failure callback has always re-entered this handler and re-emitted
the event - but that Q4's number is per MESSAGE, and this is the term that makes
it unbounded rather than four. Comment only; no metric, filter or alarm changed,
and no test (there is no behaviour here to pin).

### X3 (R3 LOW 1.3) - the chip's not-confirmed reason, fenced to retry legs

- `dashboard/src/routes/contact/deliveryStatus.ts:567-570` - the
  `retrying || notConfirmed` branch builds its reason from `retryingLegs` plus
  the legs whose `retryState === 'unconfirmed'`, never from the whole J union.
  One filter and one renamed argument; `joinReasons`, the label, the tone and
  `isFailure` are untouched, so no founder copy moves.
- `deliveryStatus.ts:547-566` - the comment records what J actually is (the
  retry `unconfirmed` legs AND every plain `isStaleLeg` leg), that the fan-out
  writes `{ status: 'queued', errorCode: <transient> }` so a non-terminal leg
  CAN carry a code, and that `deliveryReason` renders an unmapped code as a
  failure sentence - the chain that let the chip assert a failure about a leg
  the same call reports `isFailure: false`.
- A property worth naming: `retryStateOf` already returns undefined for every
  leg when `retryAware` is off, so this branch now reverts to the exact
  no-reason presentation it shipped with for every non-retry-aware caller -
  structurally, not by the legs happening to carry no code.

Tests (`dashboard/src/routes/contact/deliveryStatus.test.ts`):

- `:1264` "takes NO reason from a stale leg that is not on a ladder" - one
  delivered leg plus `{ status: 'queued', sentAt: QUIET, errorCode: '30022' }`
  with NO `retryState`, under `RETRY_OPTS` + the clocks. `toEqual` on the whole
  chip, so an added `reason` key fails it.
- `:1277` "still names the carrier failure on an unconfirmed RETRY leg" - the
  other side of the fence: `{ status: 'queued', errorCode: '30003', retryState:
  'unconfirmed' }` still reads `Phone unreachable (error 30003)`.
- `:1288` "names ONLY the retry legs reason when both halves of J meet" - both
  legs on one bubble: they still COUNT together (`delivered 1/3 - 2 not
  confirmed`) and only the ladder half speaks.
- The pre-existing `:1246` "adds no reason when the not-confirmed legs carry no
  code" is unchanged; R3 is right that it pinned the half that was already safe,
  and the three above are what it was missing.

REVERT PROOF, in two directions because a fence can fail either way:

- Fence removed (`joinReasons([...retryingLegs, ...notConfirmedLegs])`) - 2
  failures (`2 failed | 135 passed`): the stale case with
  `expected { ...(4) } to deeply equal { ...(3) }`, and the both-halves case
  with `expected 'Delivery failed (error 30022); Phone ...' to be 'Phone
  unreachable (error 30003)'` - R3's reproduced string, character for
  character.
- OVER-fenced (retrying legs only, the failure the "still names" case exists to
  catch) - 4 failures (`4 failed | 133 passed`): the two new unconfirmed cases
  plus W5's own `:1222` and `:1258`.

## Gates

| gate | result |
| --- | --- |
| `npm run typecheck` (bare, worktree root) | **exit 0** |
| app: `relayRetryClaim.webhook` + `twilioStatusWebhook` + `relayWebhook` | **110 passed (3 files)**, exit 0 |
| dashboard: `deliveryStatus` + `Timeline.delivery` + `Timeline.ticker` | **205 passed (3 files)**, exit 0 |
| `npx eslint` on the four touched files | **exit 0, no output** |
| ASCII on added lines | **0** every file |

App battery, quoted from the runner (pass glyphs rendered `[ok]` so this file
stays ASCII):

```
 [ok] test/relayWebhook.test.ts (27 tests) 311ms
 [ok] test/relayRetryClaim.webhook.test.ts (31 tests) 372ms
 [ok] test/twilioStatusWebhook.test.ts (52 tests) 612ms

 Test Files  3 passed (3)
      Tests  110 passed (110)
```

Dashboard:

```
 [ok] src/routes/contact/deliveryStatus.test.ts (137 tests) 22ms
 [ok] src/routes/contact/Timeline.ticker.test.tsx (33 tests) 308ms
 [ok] src/routes/contact/Timeline.delivery.test.tsx (35 tests) 382ms

 Test Files  3 passed (3)
      Tests  205 passed (205)
```

Movement: `relayRetryClaim.webhook` 30 -> **31** (X1's unrelated-fault case),
`deliveryStatus` 134 -> **137** (X3's three). `twilioStatusWebhook` 52,
`relayWebhook` 27, `Timeline.delivery` 35 and `Timeline.ticker` 33 are UNMOVED,
which is the claim that X3 changed no shipped string: the six exact-text chip
assertions W5 re-pointed in `Timeline.ticker.test.tsx` all read a RETRY leg's
reason and are untouched by the fence.

**Zero eslint findings on the four touched files.** `Timeline.tsx` and
`useRelayThread.ts` are not in this wave's diff, so wave 2's known pre-existing
`react-hooks/set-state-in-effect` error and the three unused-directive warnings
do not appear and nothing needed baselining.

`npm test`, `npm run smoke`, `npm run e2e` and every Playwright entry point were
deliberately NOT run - the orchestrator owns the battery. X1 changes no status
code (the relay claim path already 500'd after W2) and X3 changes no rendered
string on any retry leg, so no browser proof is owed by this wave.

## Divergences, and things for the orchestrator

1. **X1's catch is NARROW, which the task did not ask for.** The instruction was
   that the route catches the rethrow and answers 500. Implemented literally - a
   blanket catch - it would also swallow every OTHER fault out of the relay
   branch, none of which emits a marker, leaving a 500 with zero ERROR lines.
   That is a new defect, and it is reproduced above (`expected [] to have a
   length of 1 but got +0`). The shipped catch therefore rethrows anything that
   is not the claim error, discriminated by identity through a request-scoped
   `relayClaimError`. Nothing else about W2 moved: the rethrow is still
   `throw claimError`, still last, still after the whole tail.
2. **X1 added a second test case** (`:705`) for the same reason - the narrowing
   is code, so it is pinned rather than asserted in prose. The task named one
   test; this wave ships two.
3. **The wave-2 report was NOT edited.** R3's minimum and the adjudication both
   say "comment and report corrected", but this task's file scope is twilio.ts,
   deliveryStatus.ts, the two test files and this record. For the record:
   `fix-wave-2-report.md:90-91` ("One ERROR line per throttled claim, not two")
   was false when written and is TRUE as of `8be34d1b`; a reader who wants the
   history should read R3 finding 1.1 and X1 above. If the orchestrator wants
   the historical file annotated, that is a one-line edit somebody else should
   make deliberately.
4. **The response BODY on the thrown-claim path changed, the status did not.**
   `createExpressErrorHandler` answered `500 {"error":"internal server error"}`;
   the route now answers a bare `500` with no body, matching every other
   `res.status(...).end()` in this handler. Twilio reads the status only.
5. **`code-review-r3-adjudications.md` is UNTRACKED in the worktree** and was
   left exactly as found - it is the orchestrator's file, not this wave's, and
   this wave commits explicit paths only. It shows in a bare `git status`.
6. **R3's two NOTEs are open and untouched**: `withDecidingRung`'s positional
   boolean (`relayRetryJoin.ts:261-264`) and `EMPTY_RETRY_INDEX` as a mutable
   `Map` (`Timeline.tsx:849`). Both are cosmetic and both are recorded in R3's
   own file.
7. **Gate 5's `.mjs` hole is not in play** - this wave touches only `.ts` files.
8. **The stale `e2e/.artifacts/session.pid` wave 2 reported is still there.**
   Gitignored, the process does not exist, left as found.

No background command and no lane is running.
