# Fix wave 2 - code review R2's nine adjudicated items

Implementer record for W1-W8 plus W9c of
[`code-review-r2-adjudications.md`](./code-review-r2-adjudications.md), the
adjudication of [`code-review-r2-rereview.md`](./code-review-r2-rereview.md).
Branch `feat/relay-30003-retry-lineage`, worktree
`W:\tmp\relay-30003-retry-lineage`, base `a0fe28d2` (the R2 adjudications
commit).

Exactly the nine items - four corrections to fix wave 1 (F1, F2, F5, F7) and
three small system gaps - each with a test where the item is behaviour. Nothing
the adjudication marks OPEN (Q1, Q3, Q4, the residual half of 1.1) or RECORDED
(2.7, 2.8, 2.10, F6, the F11 rider) was acted on. No spec decision (D1-D23)
moved and no STOP condition was hit.

**Every test below was verified to FAIL with its change reverted**, by
temporarily inverting the shipped predicate, running the named case, and
restoring. The exact inversion and the observed failure are quoted per item.

## Commits

| hash | subject |
| --- | --- |
| `46d0466e` | fix(relay): review R2 - slot_settled vs slot_ineligible, a thrown claim rethrows after the tail, lane override guarded, suppression gate passed through |
| `61cd65cb` | fix(dashboard): review R2 - an unconfirmed leg keeps its carrier reason at every position; reason options flow from the caller; roster-gated retry index |
| `fa17ddc9` | test(relay): pin the harness fake's retry-row media skip |
| (this file) | docs(records): fix wave 2 report |

Bare `git status` was read before every commit and `.git/MERGE_HEAD` confirmed
absent each time. Explicit paths only, never `git add -A`; nothing amended; no
commit while an e2e run was in flight; `AWS_ACCESS_KEY_ID` was never exported.

## The nine items

### W1 (2.1, 3.1) - narrow F1 into two outcomes

- `app/src/lib/relayRetryClaim.ts:59-77` - `RelayRetryClaimOutcome` gains
  `slot_settled` (THIRTEEN values). Both members carry their own docblock
  naming the shape they describe and the severity that follows.
- `app/src/routes/webhooks/twilio.ts:2733-2753` - the claim's step 5 splits:
  absent slot -> `slot_ineligible`; `delivered` -> `slot_settled`; non-terminal
  -> `slot_ineligible`; terminal on another code -> `slot_settled`.
- `app/src/routes/webhooks/twilio.ts:437-444` - `isTerminalRelayLegFailure`'s
  WARN arm is now `claimed`, `already_claimed`, `fenced_announcement`,
  `slot_settled`. `slot_ineligible` is ERROR.
- `app/src/routes/webhooks/twilio.ts:368-387` - a new
  `RELAY_ANOMALY_FAILURE_MESSAGES` map gives `slot_ineligible` its own message
  ("the member delivery slot is missing or was never written") beside
  `source_unreadable`'s and `claim_failed`'s. The three-way ternary that held
  two of them became a partial `Record` plus the caller's `??` fallback.
- `app/src/routes/webhooks/twilio.ts:333-338`, `:398-419` - the shared-set
  taxonomy comment and the severity docblock say which shapes WARN and which
  ERROR, and why the whole-value whitelist was wrong.
- `docs/.../research-adjudications.md` S2a - amended a SECOND time, in place,
  marked "amended by code-review-r2 W1", naming `slot_settled` as the fourth
  WARN outcome and `slot_ineligible` as ERROR.

Tests:

- `app/test/relayRetryClaim.test.ts:51` "enumerates exactly the thirteen claim
  outcomes" - the `Record` keyed by the union stays exhaustive in both
  directions, so the list cannot drift from the type.
- `app/test/twilioStatusWebhook.test.ts:1352` (`delivered` -> WARN +
  `slot_settled`) and `:1370` (30007 -> WARN + `slot_settled`) - the two F1
  cases, re-pointed at the new value.
- `app/test/twilioStatusWebhook.test.ts:1389` "ERRORs a 30003 whose member slot
  is ABSENT, with the anomalys own message" and `:1406` "ERRORs a 30003 whose
  slot write was REFUSED and still reads sent" - R2 2.1's two reproductions,
  now real cases. The first needed one new `seedRelayLeg` option (`noSlot`,
  seeding `deliveryRecipients: {}` with the pointer present); the second stubs
  `updateRecipientDeliveryStatus` to return false, the repo's own refusal path.
- `app/test/relayRetryClaim.webhook.test.ts:390` "claims nothing when the slot
  already reads a different terminal code" - the 30007 shape's assertion moved
  from `slot_ineligible` to `slot_settled`.

REVERT PROOF: adding `claim !== 'slot_ineligible'` back to the WARN arm ->
both new cases fail (`2 failed | 1 passed | 49 skipped`).

### W2 (2.3, 2.5, 2.6) - a thrown claim rethrows AFTER the tail

- `app/src/routes/webhooks/twilio.ts:2957-2990` - the try/catch stays and now
  captures the error into `claimError` instead of logging a second line.
- `app/src/routes/webhooks/twilio.ts:3106-3111` - the RETHROW, last, after the
  failure marker, the SSE and the escalation have all run. The route's
  `await handleRelayRecipientStatus(...)` then rejects, Express 5 forwards it to
  `createExpressErrorHandler`, and the callback 500s - so Twilio redelivers and
  D8's state gate re-claims.
- `app/src/routes/webhooks/twilio.ts:3033-3043` - the diagnostic ERROR is FOLDED
  into the failure marker: `err` plus the log-safe member key ride the line that
  already carries `event: 'delivery_failed'`. One ERROR line per throttled
  claim, not two, and the surviving one is attributable (2.5).
- `app/src/routes/webhooks/twilio.ts:2846-2894` - the enqueue-failure close is
  guarded separately. If `closeRetryLegEnqueueFailed` throws, the outcome stays
  `enqueue_failed` (a row exists), the close's own error rides the line as
  `closeErr: summarizeError(e)`, `closeCode` is OMITTED because nothing was
  written, and the message says so (2.6).
- The call-site docblock states what is traded and why: the tail repeats on each
  redelivery (one more log line, one more refresh of the same state), the
  escalation cannot repeat because it is gated on `transitioned`, and losing the
  send is the strictly worse failure.

Tests (`app/test/relayRetryClaim.webhook.test.ts`):

- `:636` "runs the whole tail and then REJECTS when the claim itself throws" -
  `append` rejected once; asserts the route returns **500**, exactly ONE ERROR
  marker carrying `retryClaim: 'claim_failed'`, `err`, the cause string and no
  phone, zero WARN markers, the existing SSE once and exactly one escalation.
- `:677` "CLAIMS on the redelivery that the rejection triggered" - the recovery.
  After the 500, replaying the same callback yields `retryRows()` length 1 and
  one scheduled rung, with the escalation still at 1.
- `:699` "keeps enqueue_failed when the enqueue-failure close throws as well" -
  the close path throws (`setRecipientDelivery`, the legacy write); the outcome
  is `enqueue_failed`, no `claim_failed` line exists, the line carries
  `closeErr` and NO `closeCode`.

The wave-1 assertion that pinned the loss (`expect(retryRows()).toHaveLength(0)`
after the throw, with no replay) is REPLACED by the contract above. It survives
only inside the first case, where it states the pre-redelivery state rather than
the final one.

REVERT PROOF: guarding the rethrow off -> both the 500 case and the recovery
case fail (`1 failed | 29 skipped` each).

### W3 (2.4) - the lane override is topology-guarded again

- `app/src/jobs/relayRetryLeg.ts:161-190` - `laneBackoffOverride` returns
  `undefined` whenever `process.env['JOBS_QUEUE_URL']` is a non-empty string.
  The docblock states why that variable is the discriminator: setting it IS what
  makes the app process register no handlers and hand every job to the worker,
  and it is unset in the only topology where a lane exists.
- `app/src/jobs/relayRetryLeg.ts:192-210` - `resolveRelayRetryBackoff`'s chain
  doc gains the one-line consequence ("production sets `JOBS_QUEUE_URL`, so the
  override cannot reshape a real ladder").
- `scripts/e2e-session.mjs:254-261` - the comment is structural again rather
  than true-by-nobody-setting-it.

Tests (`app/test/relayRetryLeg.test.ts`, the seam describe, whose beforeEach now
saves/deletes/restores `JOBS_QUEUE_URL` as well):

- `:1020` "IGNORES the override in production topology - the free enqueue" and
  `:1026` "... through the handler too" - override 9000 + queue URL set ->
  `[60, 120, 240]` on both paths.
- `:1038` "honors the SAME override with JOBS_QUEUE_URL unset" -> `[9, 9, 9]`.
  (The handler-path mirror is the pre-existing "shortens EVERY rung on a valid
  positive value", which registers with the queue URL deleted by the beforeEach.)
- `:1046` "treats an EMPTY JOBS_QUEUE_URL as unset" - an empty string is how a
  shell or `.env` carries an unset value, and reading it as production would
  silently take the lane's override away.

REVERT PROOF: `&& false` on the guard -> both production-topology cases fail
(`2 failed | 48 skipped`).

### W4 (2.2, 3.2, 1.6) - F7 on the live shape

- `app/src/jobs/relayFanOut.ts:1264-1285` - `sendOneRelayLeg` gains optional
  `suppressionChecked?: boolean` (default false), destructured at `:1302`, and
  its docblock explains that the caller ran `isMemberSuppressed` moments before
  and the two reads must not be allowed to disagree.
- `app/src/jobs/relayFanOut.ts:1310` - the suppression read is now
  `if (!suppressionChecked && (await isMemberSuppressed(...)))`.
- `app/src/jobs/relayRetryLeg.ts:519-528` - the retry job passes
  `suppressionChecked: true`. The fan-out passes NOTHING, so its behaviour is
  byte-identical by construction.
- `app/src/jobs/relayRetryLeg.ts:596-625` - the wave-1 re-stamp
  (`closeTerminally('retry_opted_out')`) and the conditional `closeCode` field
  on the `suppressed` branch are GONE. The branch stays as a defensive ERROR
  with no close code, and the comment says the arm is now unreachable from this
  job and why the re-stamp was inert.
- Same block - the stale `deliveryStatus.ts:408` citation is corrected to
  `:449`, verified against the live tree (`:449` is
  `const fanned = included.filter((s) => s.errorCode !== 'contact_opted_out')`;
  `:408` is inside a docblock).

Test: `app/test/relayRetryLeg.test.ts:774` "sends the leg when the suppression
answer flips after the gate, on a VERSIONED row" - the REAL `sendOneRelayLeg`
(no `legSend.override`), on `seedRetryRow`'s default versioned row, with
`contactsRepo.getById` wrapped so read 1 answers "not suppressed" and any read
after it answers "suppressed". Asserts `reads === 1`, one real send, and a slot
carrying no error code at all. That is R2 2.2's reproduction with the outcome
inverted.

The four relay suites are unchanged at **186** (`relayFanOut` 81 +
`relayAnnouncements` 19 + `relayWebhook` 27 + `relayApi` 59).

REVERT PROOF: `suppressionChecked: false` -> the case fails with
`expected 2 to be 1`, i.e. the duplicate read is back.

### W5 (3.5, 1.1 in part) - an unconfirmed leg keeps its carrier reason

Amends build-time ruling **B1**: the quiet-rung overlay no longer clears
`errorCode`. Recorded here and in the code, not by rewriting the ledger.

- `dashboard/src/routes/contact/relayRetryJoin.ts:231-279` - `withDecidingRung`
  takes `keepErrorCode = false`; the docblock states the asymmetry (a rung that
  DELIVERED makes the code history; a rung that merely went QUIET does not - the
  leg still failed 30003).
- `relayRetryJoin.ts:382` - the `unconfirmed` branch passes `true`. The
  `delivered` branch at `:341` is untouched and still clears.
- `relayRetryJoin.ts:400-414` - `projectRelayLegs`'s overlay table updated.
- `dashboard/src/routes/contact/deliveryStatus.ts:729-746` - the `unconfirmed`
  arm returns the not-confirmed presentation PLUS
  `reason: deliveryReason(slot.errorCode, ...)` when a code is present. The
  LABEL is untouched, so D19's second table stands and no founder copy moves.
- `deliveryStatus.ts:462-476` - a `joinReasons` helper, extracted from the
  failed branch so both danger branches build a reason list ONE way.
- `deliveryStatus.ts:540-560` - the `retrying || notConfirmed` branch gains a
  `reason` built from the `retrying` and `unconfirmed` legs' codes. Legs with no
  code contribute nothing, which is what keeps every "not confirmed" string
  shipped today byte-identical rather than merely still-passing.

Tests:

- `relayRetryJoin.test.ts:356` "takes the QUIET rungs own leg, clearing what the
  failed attempt left behind" - now expects `errorCode: '30003'` alongside the
  cleared `sentAt`/`sid`; `:385` "keeps the originals carrier code on a QUIET
  SENT rung too" is new, covering the other half of `unconfirmed`. The delivered
  overlay's `expect(legs).not.toHaveProperty('errorCode')` at `:353` is
  unchanged.
- `deliveryStatus.test.ts:1506` "names the carrier failure on an unconfirmed %s
  rung" (both halves) asserts `rowTextOf` reads
  `Queued - not confirmed - Phone unreachable (error 30003)` and the
  `Sent - ...` twin; `:1515` keeps that state out of `isFailure`.
- `deliveryStatus.test.ts:1222` "names the carrier failure on an unconfirmed
  chip" (`delivered 0/1 - 1 not confirmed`, `reason` containing 30003), `:1234`
  the retrying twin, `:1246` the no-code fence, `:1258` the join/collapse rule.
- `Timeline.delivery.test.tsx:1026` "reads a stranded claim as not confirmed,
  with the carrier reason, at all three positions" - the chip's text, the
  recital's accessible name and the row's exact `getByText` string, plus the
  standing "no `will retry`" assertion.

RIPPLE, disclosed: six exact-text assertions in
`Timeline.ticker.test.tsx`'s relay-retry-clause describe read the chip string
whole, so they now read `... - Phone unreachable (error 30003)`. They are
re-pointed at two named constants (`RETRYING_CHIP`, `NOT_CONFIRMED_CHIP`) rather
than loosened to regexes - a regex `getByText` matches ancestors too.

REVERT PROOF, in three parts because the change has three halves:
`withDecidingRung(..., false)` -> 3 failures (both join cases + the Timeline
three-position case); the `unconfirmed` arm's reason removed -> 4 failures (both
row cases, the W6 unconfirmed case, the Timeline case); the chip branch's reason
emptied -> 8 failures (3 chip cases, the Timeline case, 4 ticker cases).

### W6 (1.3) - reason options flow from the caller

- `dashboard/src/routes/contact/deliveryStatus.ts:616-657` -
  `presentLegDelivery` takes a fifth optional parameter,
  `reasonOpts?: DeliveryReasonOptions`; the `retrying` and `unconfirmed` reasons
  use `reasonOpts ?? { relay: true }`, so every existing caller and test is
  byte-identical.
- `dashboard/src/routes/contact/Timeline.tsx:602-614` (the recital's
  `recipientSummaryName`) and `:1238-1252` (the per-recipient row) each build
  ONE `{ media, relay }` bag and hand it to both the presenter and their own
  `deliveryReason` fallback.

Test: `deliveryStatus.test.ts:1528` "derives a %s legs reason with the CALLERS
options", for `retrying` and `unconfirmed`. Pinned by comparing against a DIRECT
`deliveryReason('30005', { media: true, relay: true })` call rather than a
literal - a literal would encode today's answer and pass whatever the options
did - plus an assertion that the media hedge really is a different string from
the relay default, so the case stays an assertion if the maps ever overlap.

REVERT PROOF: `{ relay: true }` hard-coded back -> both cases fail
(`2 failed | 132 passed`).

### W7 (2.9) - the harness fake's retry-row media skip, pinned

- NEW `app/test/twilioWebhookHarnessMediaIndex.test.ts` (2 cases). The fake
  DERIVES its media index from stored rows, so the real repo's D13 suppression
  has to be mirrored as a read-side skip or the double answers the opposite of
  production. Case 1: an original and its retry row carrying the same durable
  s3Key yield exactly ONE pointer, and it belongs to the ORIGINAL (the owner is
  asserted, not only the count). Case 2, the control: the identical row WITHOUT
  `relay_retry_of` IS indexed, so the skip is proven to be the lineage field
  rather than a fake that indexes nothing.

Placed in `app/test/` rather than beside the helper: `app/test/helpers/` holds
no test files today, and the whole suite lives one level up. Divergence 1 below.

REVERT PROOF: `&& false` on the fake's `continue` -> case 1 fails with
`expected [ ... ] to have a length of 1 but got 2`.

### W8 (1.5) - the retry index is roster-gated

- `dashboard/src/routes/contact/Timeline.tsx:2036-2039` - `retryIndex` is
  `useMemo(() => rosterKind === 'relay' ? indexRelayRetries(items) : EMPTY_RETRY_INDEX, [items, rosterKind])`.
- `Timeline.tsx:845-849` - `EMPTY_RETRY_INDEX`, a module-scope shared empty Map,
  so the memo's identity is stable for a group text and the `tickerArmed` memo
  beside it does not recompute per render. Every reader is read-only (`.get`),
  which is what makes one shared instance safe.

Test: `Timeline.ticker.test.tsx:872` "does NOT arm for a retry row on a native
GROUP TEXT roster" - the same item set that arms exactly once on a relay roster
(the case directly above it is the control), rendered with
`rosterKind: 'group_text'`: `window.setInterval` is never called, no clock
movement changes that, and neither retry word appears on the bubble.

REVERT PROOF: gate changed to `rosterKind !== undefined` -> the case fails
(`1 failed | 32 passed`).

### W9c (1.2) - the DeliveryFailures comment, corrected

`app/src/routes/webhooks/twilio.ts:3006-3022`. The old sentence - "the `event`
field is unchanged either way, so the DeliveryFailures count metric ... is
unaffected" - is true of the SEVERITY change it was attached to and false of the
feature. It now says both: the severity change does not move the metric, AND
every rung's own failed callback re-enters this handler and emits its own
`delivery_failed`, so a permanently dead handset produces up to four events per
relayed message where main produced one - the relay ladder counting the way the
1:1 ladder already does. The alarm's single-period shape is named and pointed at
Q4. Comment only; no metric, filter or alarm changed.

## Gates

| gate | after commit 1 | after commit 2 | after commit 3 |
| --- | --- | --- | --- |
| `npm run typecheck` (bare, worktree root) | **exit 0** | **exit 0** | **exit 0** |
| named app suites | 324 passed (9 files) | - | **326 passed (10 files)** |
| named dashboard suites (`src/routes/contact/`) | - | **1165 passed (59 files)** | - |
| `npx eslint` on the touched files | exit 0, no output | 1 PRE-EXISTING error (below) | exit 0, no output |
| ASCII on added lines | **0** every file | **0** every file | **0** |

Final app battery, quoted from the runner (pass glyphs rendered `[ok]` so this
file stays ASCII):

```
 [ok] test/twilioWebhookHarnessMediaIndex.test.ts (2 tests) 7ms
 [ok] test/relayRetryClaim.webhook.test.ts (30 tests) 375ms
 [ok] test/twilioStatusWebhook.test.ts (52 tests) 637ms
 [ok] test/relayApi.test.ts (59 tests) 695ms
 [ok] test/relayWebhook.test.ts (27 tests) 315ms
 [ok] test/relayFanOut.test.ts (81 tests) 96ms
 [ok] test/relayAnnouncements.test.ts (19 tests) 25ms
 [ok] test/relayRetryClaim.test.ts (5 tests) 4ms
 [ok] test/relayRetryLeg.test.ts (50 tests) 59ms
 [ok] test/registerHandlers.test.ts (1 test) 3ms

 Test Files  10 passed (10)
      Tests  326 passed (326)
```

Dashboard, the four files this wave touched:

```
 [ok] src/routes/contact/relayRetryJoin.test.ts (36 tests) 11ms
 [ok] src/routes/contact/deliveryStatus.test.ts (134 tests) 25ms
 [ok] src/routes/contact/Timeline.ticker.test.tsx (33 tests) 308ms
 [ok] src/routes/contact/Timeline.delivery.test.tsx (35 tests) 385ms
```

Movement: `twilioStatusWebhook` 50 -> **52** (W1's two anomaly cases),
`relayRetryClaim.webhook` 28 -> **30** (W2's recovery + close-throw),
`relayRetryLeg` 46 -> **50** (W3's four; W4 replaced F7's case one-for-one),
`relayRetryClaim` 5 (the union test moved, not added),
`twilioWebhookHarnessMediaIndex` **+2** (new file). `relayFanOut` 81,
`relayAnnouncements` 19, `relayWebhook` 27, `relayApi` 59 and `registerHandlers`
1 are UNMOVED - the four relay suites are still **186**, which is W4's
byte-identical-fan-out claim.
Dashboard: `relayRetryJoin` 35 -> **36**, `deliveryStatus` 125 -> **134**,
`Timeline.ticker` 32 -> **33**, `Timeline.delivery` **35** unchanged (W5
extended a case rather than adding one).

**The one eslint error is PRE-EXISTING and is not ours.**
`dashboard/src/routes/contact/Timeline.tsx:1484` `react-hooks/set-state-in-effect`,
in the image-viewer clock effect this wave never touched. Attributed by BASELINE
COMPARISON, not by line number: the same file at the merge base `f82c149c`,
written out and linted, reports the identical single error at its own `:1328`
(`1 problem (1 error, 0 warnings)`). Nothing else was reported on any touched
file; the three `useRelayThread.ts` "unused eslint-disable directive" warnings
wave 1 recorded do not appear because this wave does not touch that file.

## The e2e proof

W3 changes the seam the browser proof depends on, so the spec was run ONCE from
the e2e workspace, in the foreground, on lane 9 (`9901/9911/9921/9931`),
confirmed free before the run and after it:

```
.superpowers/sdd/e2e-fixwave2-run1.log      EXIT: 0

  ok 1 [chromium] > tests\dashboard-next\relay-30003-retry.spec.ts:131:1 > a failed relay leg retries to delivered without duplicating: chip, accessible name, row and send counts (18.5s)
  ok 2 [chromium] > tests\dashboard-next\relay-open-stop.spec.ts:114:1 > open-path STOP suppresses relay legs; START resumes them (A2P parity) (14.2s)
  2 passed (46.0s)
```

(The reporter's `>` is a U+203A in the log; rendered ASCII here. `2 passed`
because `--grep "relay leg"` also selects `relay-open-stop.spec.ts` - slice H's
divergence 1.) Identical timings to fix wave 1's two runs, which is the point:
the lane still gets its 10s rung, so the guard is a guard and not a removal.
**Zero `[dynamoAdmin]` lines** in the log. The log also carries the shipped
severity line for the happy path -
`"retryClaim":"claimed","retryAttempt":1` at WARN - so W1's narrowing did not
disturb the claimed case.

`npm test`, `npm run smoke` and the full `npm run e2e` were deliberately NOT
run; the orchestrator owns the battery.

## A correction to fix wave 1's report

**Wave 1's divergence 1 has the two populations the wrong way round, and the
correction is the reason W4 exists.** It reads: "the fix lands on the LEGACY
shape, which is the ordinary one (every relay source written before 2026-09-02
is legacy)". That is true of HISTORY and false of the live population. Every
relay source appended TODAY is VERSIONED - member-originated at
`app/src/routes/webhooks/twilio.ts:840`, team-originated at
`app/src/routes/api.ts:1816`, both stamping `transportSchemaVersion`
unconditionally - and the claim mirrors that onto the retry row. A ladder runs
seconds to minutes after the send, so the source it retries is essentially
always versioned. On that shape `applyRecipientSendResult` preserves the FIRST
terminal code, so F7's re-stamp was refused and the ERROR line reported a
`closeCode` nothing had written. The bound was not a bound; it was the whole
case. W4 removes the re-stamp and the false field and closes the read window
instead.

Wave 1's divergence 3 ("F7's ERROR line gained `closeCode`") is therefore also
withdrawn: that field is gone from the `suppressed` branch, and the file's
contract - `closeCode` appears where the JOB wrote one - is true again on every
arm.

## Divergences, and things for the orchestrator

1. **W7's file lives in `app/test/`, not beside the helper.** The adjudication
   allowed "a small new file beside `twilioWebhookHarness.ts`";
   `app/test/helpers/` contains no test files at all today and the whole suite
   lives one level up, so `app/test/twilioWebhookHarnessMediaIndex.test.ts`
   follows the repo's convention. It is not in the named gate list and was run
   explicitly.
2. **W2's folded marker carries the log-safe member key as well as `err`.** The
   adjudication said "attach `err`". The line it replaced carried
   `memberKey: logSafeStoredRelayMemberKey(...)` too, and dropping that would
   have cost the diagnosis the fold exists to preserve. PII-safe by the same
   helper; asserted absent-of-phone in the test.
3. **W2's close-throw error is logged as `closeErr: summarizeError(e)`, not
   raw.** Only `err`/`error`/`cause`/`reason` get the safe serializer
   (`lib/logSerializers.ts`), so a second raw Error under any other key
   serialises to `{}`. `summarizeError` is the repo's existing safe secondary
   shape (11 sites) and passes through untouched.
4. **W5 forced six exact-text updates in `Timeline.ticker.test.tsx`.** Disclosed
   above. They are the pre-existing relay-retry-clause assertions reading the
   chip string whole; no assertion was weakened, and the two new constants make
   the reason part of what those cases pin.
5. **W2 changes the HTTP contract of one path.** A relay status callback whose
   claim throws now 500s where it used to 200. That is the adjudicated intent -
   the 5xx IS the recovery - but it is the only response-code change on the
   branch and worth naming in the handback.
6. **Gate 5's `.mjs` hole applies again.** `npx eslint scripts/e2e-session.mjs`
   exits 0 having checked NOTHING (the flat config has no base JS block). Do not
   read that zero as a lint pass on that file.
7. **Nothing outside W1-W9c was touched.** Q1, Q3, Q4 and the residual half of
   1.1 (no alarm for a claim that was durable but never enqueued - nobody
   observes that state without the sweep, and it stays inside
   `relay-retry-stranded-claim-window`) are left exactly as adjudicated. So are
   the RECORDs: 2.7, 2.8, 2.10, F6 and the F11 rider. No fenced file changed -
   `relayAnnouncements.ts`, `tourReminders.ts`, `retrySend.ts`, `ALLOWED_PRIOR`,
   `stalenessClockMs`, the rollup outbound gate, `flagPlacementAttention`'s body
   and the 1:1 path are all absent from this wave's diff.
8. **A stale `e2e/.artifacts/session.pid` (38476) sits in the worktree.** It is
   gitignored, the process does not exist, and the lane's four ports are free.
   Left as found.

No background command and no lane is running.
