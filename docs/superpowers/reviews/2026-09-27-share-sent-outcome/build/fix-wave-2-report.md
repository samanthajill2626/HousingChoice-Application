# Share sent outcome (Branch B) - fix wave 2 report

Date: 2026-09-28. Implementer: the fix-wave-2 child (Claude Opus 5.5),
dispatched by the build orchestrator. Worktree `W:\tmp\share-sent-outcome`,
branch `feat/share-sent-outcome`, base `3acb7b04` (the round-2 adjudications
on top of `6916a971`; main @3f38bcc2). Work order:
`code-review/r2-adjudications.md`, "The second wave", steps 1-5 in order.
Every command ran bare from the worktree; output went to
`.superpowers/sdd/logs/fw2-*.log` (gitignored) and was read after. No
`[dynamoAdmin]` line in any fw2 log.

## Status

DONE - five step commits in the adjudication's order, then this report. No
STOP condition was hit. One must-stay-green pin went red, and only under the
intended change (step 2, the bulk case whose fixture is found-while-fixing
1's class; below). Step 5 stayed inside the hook, the component and the
component's test file.

| Step | Commit | Items | What |
|---|---|---|---|
| 1 | `0ddf55f1` | R2-F1, R2-F2 (docs) | RUNBOOK: the under-flagged classes, the exit-1 rule, the aborting reads, the SYSTEMIC abort, the re-check wording |
| 2 | `c262e074` | R2-F2, R2-F3, FWF-1 | repair: bounded slot write + SYSTEMIC abort; honest `slotsMoved`; the carrier-instant clause |
| 3 | `7a015dc5` | R2-1 | the results route reads the share consistently in both views |
| 4 | `0d090852` | C-1, FWF-2 | comments: STRICT vs the milestone; `PreviewResponse` |
| 5 | `e824a452` | FWF-4 | the results hook's synchronous recount |

Baseline before step 1: `cd app; npx vitest run test/repairShareOutcomes.test.ts
test/broadcastApi.test.ts` - "Tests 96 passed (96)"; `cd dashboard; npx vitest
run src/routes/broadcasts/BroadcastResults.test.tsx
src/routes/broadcasts/useBroadcastResults.test.tsx` - "Tests 30 passed (30)".

## Step 1 - `0ddf55f1` (R2-F1; R2-F2's abort rule and ERROR wording)

File: `RUNBOOK.md` ("Share outcomes repair (2026-09-28)"). Documentation, no
test. `npm run typecheck` exit 0; added lines ASCII 0.

- The binding-order paragraph: three kinds of slot stay under-flagged after
  the apply if their retry delivered - a slot the repair leaves alone (only
  `unjudgeable.originalMissing` and `unjudgeable.brokenLineage` do; a
  `noContact` or `noRecipientKey` slot IS judged and moved) and the
  lineage-less pre-RSW retry, for good; and a slot named on a `slotsFailed`
  ERROR line, for good when its cause is permanent and until the re-run when
  transient. An apply that exits 1 with `COMPLETED WITH FAILURES` closes the
  window for every slot EXCEPT the ones its ERROR lines name - decide the next
  blast with that list in hand.
- The `slotsFailed` bullet: a per-slot cause only (the slot write after two
  retries), the ERROR line carries `step` and says the next run re-checks the
  slot; a SYSTEMIC failure is never counted there.
- Step 2 (Apply): the reads that ABORT are listed exactly - the Scan (or the
  one share's read under `--broadcast`), the original message and the chain's
  Query, the thread and retry-record reads, the pair's ledger row before and
  after its step, the share re-read after a move, and a failed retry-row stamp;
  the consistent reads INSIDE the two write services (the share read in
  `applyLaterAttempt`, the ledger read in `applyShareLedgerEntry`) fail per
  slot like their writes unless SYSTEMIC. The SYSTEMIC abort: the reminder
  sweep's classes by error name (the same nine names as the code, step 2), an
  ERROR naming the share, the PARTIAL report, exit 1; every other write
  failure (the 400 KB `ValidationException`, a condition that keeps losing)
  stays per slot.
- The exit-code line: 1 also for an abort on a retry-row stamp or a SYSTEMIC
  write failure.

Judgment calls: (1) one sentence beyond the mission's list: an apply that
ABORTED (a PARTIAL report) closes the window for no slot you can count on -
the adjudication's "an apply that exits 1" would otherwise cover an abort,
where the statement is false. (2) The aborting-read list names every read
outside the two write services, not only the mission's five (the one-share
read, the thread and retry-record reads, and the stamp - a WRITE that aborts,
fix wave 1's judgment call 1 - are added so the list is complete).

## Step 2 - `c262e074` (R2-F2, R2-F3, found-while-fixing 1)

Files: `app/scripts/repair-share-outcomes.ts`, `app/test/repairShareOutcomes.test.ts`.

- RED (four new cases): `npx vitest run test/repairShareOutcomes.test.ts` -
  "Tests 4 failed | 18 passed (22)": the SYSTEMIC slot case ("promise
  resolved ... instead of rejecting" - the AccessDeniedException was caught
  per slot and the walk read on through all three shares); the SYSTEMIC
  ledger case (same, resolved); R2-F3 (`slotsMoved` expected 0, received 1 -
  the reviewer's reproduction); FWF-1 (census `slotsToMove` expected 1,
  received 0).
- First green attempt: "Tests 1 failed | 21 passed (22)" - the existing
  "bulk mode (no --broadcast)" case: its `bulk-c` fixture is a bare `sent`
  original whose own row reads `sent`, exactly found-while-fixing 1's class,
  so the census now forecasts its carrier gain (`slotsToMove` 2, pinned 1).
  Updated that case's counts (census `slotsToMove` 2, apply `slotsMoved` 2)
  with a comment naming the class; its re-run-forecasts-nothing assertion is
  unchanged. The red is the authorized change, so no STOP.
- GREEN: "Tests 22 passed (22)" (18 + 4). The permanent `ValidationException`
  bulk case and the lost / ledger case stay green unchanged.
- `npm run typecheck`: first exit 2 (`TS2339: Property 'item' does not exist
  on type 'never'` - the probe's direct resets narrowed `probe.found` to
  `undefined` across the awaited write), then exit 0 with the reset in a helper
  (`resetProbe`). eslint on both files exit 0; added lines ASCII 0.

As built:

- The slot write is `applyLaterAttemptBounded` (a throw retried twice, as at
  the webhook and the reconcile). The share repo handed to the service is
  wrapped (`probedBroadcasts`) so the repair sees what the bounded call
  swallows: the last thrown error, and the share as the write's FIRST
  successful read found it (`SlotWriteProbe`, reset before each write; the
  walk is sequential).
- `'threw'` -> `failSlotOrAbort`: an error whose name is in
  `SYSTEMIC_WRITE_ERRORS` logs ONE ERROR naming the share (`broadcastId`, the
  redacted key, `conversationId`, `tsMsgId`, `step`, `err`) - "the <step>
  write failed with a SYSTEMIC error ...: ABORTING the run" - and rethrows, so
  `runRepairShareOutcomes` logs the PARTIAL report and the entrypoint exits 1.
  Anything else is `failSlot` (per slot, `slotsFailed`). The ledger write's
  catch goes through the same function. `'lost'` stays per slot.
- `failSlot`'s ERROR now reads "counted in slotsFailed and re-checked by the
  next run (a write that landed before its error surfaced reads as recorded
  there); the walk goes on" - the substring the existing pins filter on
  (`write failed for this slot`) is kept.
- `slotsMoved` (R2-F3): after an `'applied'`, the re-read slot is compared
  with the slot the write first read (status, errorCode, carrierSentAt,
  latestAttempt); equal -> INFO "slot not moved by this run: already recorded
  by a live writer ... - not counted"; different -> counted.
- `slotRecords` (FWF-1): false when the decision carries a carrier instant and
  the slot has none - the same-attempt gain `wouldApply` admits. The move
  carries no stats delta and the same ledger entry (counted by acceptance on
  the original's key).

Tests added: (a) bulk, three shares, the first in scan order denied with
`AccessDeniedException` on its slot UpdateCommand: the run rejects with it,
exactly 3 denied writes (the bounded try and two retries), ONE SYSTEMIC ERROR
naming the share at `step: 'slot'` with `err.type` `AccessDeniedException`,
the PARTIAL report after it (`sharesWalked 1, slotsWalked 1, slotsToMove 1,
slotsMoved 0, slotsFailed 0`), no per-slot line, every share's slot and ledger
row untouched; (b) one share whose LEDGER write throws
`ProvisionedThroughputExceededException`: rejects, ONE SYSTEMIC ERROR at
`step: 'ledger'`, the PARTIAL report carries the slot move that landed first
(`slotsMoved 1`); (c) R2-F3: a `sent` slot whose ROOT row failed 30007, the
live rollup (`applyAttemptOutcome`, pointer-less) injected right after the
first consistent read of the share (the census read in one-share mode):
`slotsToMove 1, slotsMoved 0`, the slot exactly the rollup's, the stats moved
once (`sent 0, failed 1`), ONE INFO `already recorded by a live writer`; (d)
FWF-1 (the round-2 reviewer's probe): census `slotsToMove 1`, apply
`slotsMoved 1`, the slot `sent` with `carrierSentAt` = the ROOT instant and no
pointer, persisted stats unchanged (`sent 1`), derived `sending 0, sent 1`,
the ledger entry counted by acceptance on ROOT, a re-run census forecasts 0.

Judgment calls:

1. The precedent has no error-name set to reuse. The reminder sweep's rule
   (`app/scripts/retire-paused-tour-reminders.ts:280-298`) is "every write
   failure but `ConditionalCheckFailedException` aborts", with its four
   systemic classes named in prose only. Reusing that predicate would abort on
   the 400 KB `ValidationException`, which the adjudication keeps per slot. So
   the repair mirrors the sweep's four NAMED classes as an explicit set of nine
   error names - credentials: `UnrecognizedClientException`,
   `InvalidSignatureException`, `ExpiredTokenException`,
   `CredentialsProviderError`; a missing grant: `AccessDeniedException`; a
   wrong prefix: `ResourceNotFoundException`; sustained throttling:
   `ProvisionedThroughputExceededException`, `ThrottlingException`,
   `RequestLimitExceeded` - matched on `err.name` (the SDK names a service
   error by its code; the serializer logs it as `type`), with a comment naming
   the precedent and why the default is inverted here.
2. `applyLaterAttemptBounded` logs and swallows its error; changing the
   service is outside step 2's files, so the repair reads the error through
   the probe it hands the service instead.
3. The SYSTEMIC check also covers the LEDGER write (R2-F2's complaint - one
   ERROR per slot through the whole walk - holds for a missing grant on the
   ledger table too), with its own test.
4. The aborting slot is NOT counted in `slotsFailed`: the PARTIAL report is
   what completed, and the abort has its own ERROR line.
5. R2-F3's baseline. "The re-read slot differs from the census's slot", read
   literally (the Scan's copy), cannot pass its own test and suppresses
   nothing anywhere: in the interleaving the census copy is `sent`, the re-read
   `failed 30007`, so they differ whether or not the repair wrote; and a census
   copy equal to the decided outcome makes `slotRecords` true, so no write is
   attempted at all. The baseline is therefore the slot as the write FIRST read
   it - after any live move since the census - on the same four fields: it
   keeps the adjudication's intent (count only what this run's write changed)
   and its test (`slotsMoved 0`). Two precision residues, both PARTIAL-report
   or counter only, and the next census reports nothing left for either slot:
   (a) a live writer that lands exactly the decided outcome between the
   service's read and its conditional write (deviation 15's second replay
   check) is still counted - a one-round-trip window; (b) the count now waits
   for the re-read, so a re-read that throws right after an applied move
   aborts with a PARTIAL report that does not count that move (before this
   wave it did).
6. The `COMPLETED WITH FAILURES` WARN summary said "could not be written and
   were left as they are" - the same inaccuracy as the ERROR line; it now reads
   "failed a write (see the ERROR lines naming them); the next run re-checks
   each" (the pins match `COMPLETED WITH FAILURES` only).
7. The header, `RepairReport.slotsFailed`, `runRepairShareOutcomes`,
   `failSlot` and `reportRepair` docs were updated so they stay true (the
   bounded write, the SYSTEMIC abort, the re-check, the honest `slotsMoved`,
   the carrier clause).

## Step 3 - `7a015dc5` (R2-1)

Files: `app/src/routes/broadcasts.ts`, `app/test/broadcastApi.test.ts`.

- RED: `npx vitest run test/broadcastApi.test.ts -t "CONSISTENTLY"` - "Tests 1
  failed | 78 skipped (79)": `expected "getByIdConsistent" to be called 1
  times, but got 0 times`.
- GREEN: `npx vitest run test/broadcastApi.test.ts` - "Tests 79 passed (79)";
  `test/contactsBatchReads.test.ts` (it also calls the route) - "Tests 10
  passed (10)". `npm run typecheck` exit 0; eslint on both files exit 0;
  added lines ASCII 0.

As built: the results route reads `broadcasts.getByIdConsistent(broadcastId)`
before the view branch, so both views and the 404 path use it; a comment says
why. The test spies on the world's repo: the full view and `?view=stats` each
call `getByIdConsistent` once (`[['b-1'], ['b-1']]`), a missing share is 404
`broadcast_not_found` in both views, and `getById` is never called.

Judgment call: the harness double's `getByIdConsistent` delegates THROUGH
`getById` (so a spy on `getById` sees every consistent read); the test points
the consistent spy at the unspied original `getById` captured before spying.
The double itself is unchanged.

## Step 4 - `0d090852` (C-1, found-while-fixing 2)

Files: `app/src/services/shareRecipientState.ts` (the header, and
`hasReached`'s doc), `dashboard/src/api/types.ts` (`PreviewResponse`'s doc).
Comments only, no test. `npm run typecheck` exit 0; added lines ASCII 0.

- The STRICT reading serves the labels, the counts and the ledger; the
  tenant's "Property sent" milestone is neither reading - it takes spec D6's
  words from the ledger, and a live pending entry reads "Property sent"
  (`contactTimeline.ts`), where the STRICT reading would not count it.
- `priorRecipientContactIds` is D1's SAFE reading over every share of the
  unit, whatever its stored status (reached, pending a live retry, Not
  confirmed, in flight); its entries are slot keys and can be `phone#<E164>`,
  which a contactId match never finds.

For the handback (the adjudication asks it to name this): the spec's D1 lists
"the milestone" among the STRICT readers while D6, the specific rule, reads a
live pending entry as "Property sent"; the code follows D6 and the comments now
say so.

## Step 5 - `e824a452` (found-while-fixing 4)

Files: `dashboard/src/routes/broadcasts/useBroadcastResults.ts`,
`BroadcastResults.tsx`, `BroadcastResults.test.tsx`.
`useBroadcastResults.test.tsx` needed no change (no pin there calls the
recount).

- RED: `npx vitest run src/routes/broadcasts/BroadcastResults.test.tsx` -
  "Tests 1 failed | 24 passed (25)": `expected 'Sending' to be 'Not sent'`
  (the tick's stale recount overrode the fetch's fresh count).
- GREEN: both files - "Tests 31 passed (31)" (25 + 6); every pre-existing
  ticker, overlay and refetch pin green and unchanged. `npm run typecheck` exit
  0; eslint on the three files exit 0; added lines ASCII 0.

As built: the hook keeps `resultsRef`; every write to the results goes through
`updateResults(change)` - the fetch's success, the SSE overlay and the
per-broadcast reset - which sets the ref and React's state to the same value.
`pendingRetryCount` moved into the hook (typed over the route's recipient
rows; same predicate). `recountRetryPending(nowMs)` keeps the rows-behind
guard, then counts `Object.values(resultsRef.current.recipients)` at `nowMs`.
The component lost `rowsRef`, its passive sync effect and `useRef`; the
ticker calls `recountRetryPending(now)` after `setServerNow(now)`.

Judgment calls: (1) `updateResults` sets a VALUE computed from the ref rather
than handing React a functional updater; since every write goes through it,
state and ref cannot diverge (the same reasoning as fix wave 1's
`updateRows`). exhaustive-deps adds the stable `updateResults` to three deps
arrays - its identity never changes, so no effect or callback re-runs. (2) The
test lives in the component file's ticker block (the reviewer's window is the
component's): it holds a Refresh response, then inside ONE `act` resolves it,
flushes microtasks with `vi.advanceTimersByTimeAsync(0)` (the fetch's
continuation runs; React renders nothing inside `act`) and dispatches `focus`
(the ticker). The old component fails it only because the continuation ran
before the focus - so the window is really reproduced.

## Final gates

- `npm run smoke`: exit 0 - "smoke-dist: OK - 1545 import specifier(s) across
  268 emitted file(s) resolve under plain Node."
- The mission's app list (`cd app && npx vitest run
  test/repairShareOutcomes.test.ts test/broadcastApi.test.ts
  test/shareRecipientState.test.ts test/shareAttemptOutcome.test.ts
  test/twilioStatusWebhook.test.ts test/sendReconcile.test.ts
  test/listingSendsApi.test.ts test/contactTimeline.test.ts`): "Test Files 8
  passed (8) / Tests 486 passed (486)" - repairShareOutcomes 22, broadcastApi
  79, shareRecipientState 19, shareAttemptOutcome 26, twilioStatusWebhook 94,
  sendReconcile 166, listingSendsApi 16, contactTimeline 64.
- `cd dashboard && npx vitest run src/routes/broadcasts src/api`: "Test Files
  22 passed (22) / Tests 325 passed (325)".
- `npm run typecheck`: exit 0 before each of the five commits (step 2 after
  the one red run named above).
- eslint over the nine TS/TSX files the wave touched: exit 0.
- ASCII: every touched file's added lines strip to 0 bytes.
- Fence: `git diff --stat 3f38bcc2 HEAD --` `jobs.ts`, `sqsJobConsumer.ts`,
  `oneToOneRetryDecision.ts`, `registerHandlers.ts` prints nothing; the wave
  touches no job, reconcile or harness file (`git diff --name-only 3acb7b04
  HEAD`: `RUNBOOK.md`, the repair script and its test, `broadcasts.ts` and
  `broadcastApi.test.ts`, `shareRecipientState.ts`, `types.ts`, the hook, the
  component and its test). Every slot write still goes through
  `applyAttemptOutcome`; nothing copies `retry_due_at` / `retry_outcome`.
- Not run (the orchestrator's): the full `npm test`, `npm run e2e`.

## Found while fixing (not fixed)

1. `applyLaterAttemptBounded`'s give-up ERROR reads "share slot write failed
   after retries (best-effort; the repair heals it)" - in the repair's own run
   it now precedes the repair's per-slot or SYSTEMIC line, so the operator
   reads "the repair heals it" from the repair itself. Service text
   (`app/src/services/shareAttemptOutcome.ts:283-286`), outside this wave.
2. The perf profiler's source fingerprints for the results hook -
   `e2e/performance/routes.ts:726` (`useBroadcastResults.ts:41-155`) and
   `:811` (`useBroadcastResults.ts:41,120-138`), pinned as strings by
   `e2e/performance/collect.test.ts:378` - no longer point at the lines they
   name: pre-existing drift since slice 3 grew the hook, shifted again here.
   Strings only (nothing reads the file), so nothing fails.
3. `RUNBOOK.md` step 3 excepts "the slots the apply named on its
   `slotsFailed` ERROR lines, which still forecast their move" - a LEDGER-step
   failure forecasts the pair's ledger change, not a move, and a slot whose
   write landed before its error forecasts nothing. Fix wave 1's text, not in
   this wave's list.
