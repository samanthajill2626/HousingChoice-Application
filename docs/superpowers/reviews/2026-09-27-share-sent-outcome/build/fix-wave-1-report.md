# Share sent outcome (Branch B) - fix wave 1 report

Date: 2026-09-28. Implementer: the fix-wave child (Claude Opus 5.5),
dispatched by the build orchestrator. Worktree `W:\tmp\share-sent-outcome`,
branch `feat/share-sent-outcome`, base `ed83834d` (the round-1 adjudications
on top of `7386968d`; main @3f38bcc2). Work order:
`code-review/r1-adjudications.md`, "The fix wave", groups 1-8 in order. Every
command ran bare from the worktree; output went to
`.superpowers/sdd/logs/fw1-*.log` (gitignored) and was read after. No
`[dynamoAdmin]` line in any fw1 log.

## Status

DONE - eight group commits in the adjudication's order, then this report. No
STOP condition was hit. Two groups needed a judgment call where the mission's
literal wording failed its own test or a must-hold pin (group 7, ADV-7 and
G3, below); both stay inside the authorized file and finding. One ADV-10 item
moved one commit later for a compile dependency (group 2 -> group 5).

| Group | Commit | What |
|---|---|---|
| 1 | `d8e85c39` | RUNBOOK: the deploy flips the flag to under-flagging (binding order), the re-run lines, `slotsFailed`, the forecast caveat, the lineage-less pre-RSW retry |
| 2 | `8e00e495` | repair: a failed slot/ledger write is per slot (ERROR, `slotsFailed`, exit 1); a `sent` row is carrier-confirmed |
| 3 | `eee2054e` | reconcile: an own-row proof at `sent` carries its carrier instant |
| 4 | `7be6ef3c` | webhook: the retry path is bounded; ONE `RETRIED_ERROR_CODE` |
| 5 | `2fd4b799` | `nextSlot` omits the pointer on the original's own key; `pairContactId` exported and read by the repair |
| 6 | `9758c5ee` | the ledger seed helper goes through `applyShareLedgerEntry` |
| 7 | `47a00537` | dashboard: the list hook's refetch decision and cancel; the G3 hint clause; the G7 comments |
| 8 | `5be51e04` | issues: three RESOLVED blocks, the sweeper addendum, seven LOW residuals |

## Group 1 - `d8e85c39` (ADV-1, ADV-2b, ADV-4, ADV-8, T13.8 / G5)

File: `RUNBOOK.md` ("Share outcomes repair (2026-09-28)"). Checks: added lines
ASCII 0; `npm run typecheck` exit 0.

- ADV-1: a bold paragraph after "NOT YET RUN": the deploy flips the flag's
  historical error from over-flagging (safe) to UNDER-flagging for a tenant
  whose 30003 retry delivered before the deploy (slot `failed 30003`, judged
  from the slot alone past 24 minutes, not flagged, pre-checked, re-included
  by "Select all"); deploy -> census -> `--apply` -> next property blast is
  BINDING, the deploy-to-apply window is the exposure; a one-to-one share from
  a tenant's file reads the same flag; unjudgeable slots stay under-flagged.
- ADV-2b: a "When to re-run it" paragraph with a Logs Insights query.
- ADV-4: the `slotsFailed` counter line; step 2 now says a READ failure aborts
  (PARTIAL, FAILED, exit 1) while a slot or ledger WRITE failure is per slot
  (one ERROR, `slotsFailed`, the walk goes on, `COMPLETED WITH FAILURES`, exit
  1), with the permanent 400 KB case; step 3 excepts the `slotsFailed` slots
  from "zero on every `*To*`"; the exit-code line updated.
- ADV-8: one sentence after the counters: the forecast is per slot against the
  pre-run row, a multi-share pair can be forecast to flip when the apply does
  not, the past-tense counters are authoritative.
- T13.8 / G5: `unjudgeable.brokenLineage` no longer claims the lineage-less
  pre-RSW retry; the line says such a row is counted nowhere and the slot is
  judged without it.

Judgment calls: (1) the adjudication names four "re-run the repair" lines; the
section names four more that the same re-run heals - `broadcast delivery
rollup: retry row without retry_root - unrouted`, `share ledger: entry write
failed`, `broadcastFanOut: recording listing-send entry failed`, and
guardWrite's `failure-arm write failed` with `label: shareSlotUnconfirmed`.
(2) Levels as coded: `share attempt outcome: the slot write lost its condition
past the re-read bound` is a WARN (`shareAttemptOutcome.ts:262`), not an ERROR;
the RUNBOOK says so. (3) `broadcast delivery rollup failed` carries a
pre-existing em dash further along (`twilio.ts:3582`): the RUNBOOK quotes the
ASCII prefix and says match on it (the automation section's precedent).

## Group 2 - `8e00e495` (ADV-4, ADV-5 in the repair)

Files: `app/scripts/repair-share-outcomes.ts`, `app/test/repairShareOutcomes.test.ts`.

- Baseline: `npx vitest run test/repairShareOutcomes.test.ts` - "Tests 15
  passed (15)".
- RED (three new cases): "Tests 3 failed | 15 passed (18)" - the ADV-5 case
  (the slot `sent` had no `carrierSentAt`), the bulk case (the injected
  `ValidationException` aborted the run from `repairSlot`), the lost/ledger
  case (the old `lost` Error aborted the run).
- GREEN: "Tests 18 passed (18)". `npm run typecheck` exit 0; `npx eslint` on
  both files exit 0; added lines ASCII 0.

As built: `failSlot` logs ONE ERROR (`repair-share-outcomes - the <slot|ledger>
write failed for this slot: counted in slotsFailed and left as it is, the walk
goes on (fix the cause and re-run)`) with `broadcastId`, `recipientKey`
(`safeRecipientKey`), `conversationId`, `tsMsgId`, `step`, and either `err`
(the wired key: the safe serializer emits the error's name as `type`, its
message, code and `$metadata`) or `result: 'lost'`; `slotsFailed += 1`; the
slot is left and the walk goes on. `RepairReport.slotsFailed` and
`emptyReport` gained it; `reportRepair` returns 1 and logs the FULL report at
WARN as `COMPLETED WITH FAILURES` when `slotsFailed > 0` (the precedent is
`reportEnableRun` in `enable-conversation-automation.ts`); the entrypoint
already sets `process.exitCode` from it. `rowOutcome`: `sent` ->
`{ kind: 'sent', carrierSentAt: <ISO of attemptKeyTimestampMs(row.tsMsgId)> }`
(omitted if the key has no instant); `queued` / `queued_pending` stay bare.
The header and the run's docstring say reads abort and writes are per slot.

Judgment calls: (1) only the two WRITE calls are caught - `applyLaterAttempt`
and `applyShareLedgerEntry`, including the consistent read each makes inside;
every other read stays fatal as today (the Scan, the original read, the
chain's Query, the ledger reads before/after, the share re-read), and so does
the retry-row stamp (`stampRetryAttribution` writes a message row, not a slot
or ledger row). (2) A failed slot's LEDGER FORECAST still counts (step 5 runs
its `*To*` counting), so an apply's forecast equals a census's; only the
ledger WRITE is skipped after a failed slot write (the ledger follows the
slot). (3) The bulk test reads the table's own Scan order first and fails the
FIRST share, so "after it in scan order" holds by construction (DynamoDB
Local's order is not insertion order); a second run asserts `slotsFailed 1`,
`slotsToMove 1`, `rowsToCreate 1`, `pairsToRecount 1` - the failing share's
own forecast, zero for the others - and an ERROR naming only that share. (4)
One case beyond the mission's: a slot write that keeps losing its condition
(4 writes, `lost`) and a ledger write that throws, each one ERROR and
`slotsFailed 1`, no PARTIAL. (5) ADV-10's `pairContactId` switch in this file
moved to group 5, where the export lands (it cannot compile earlier).

## Group 3 - `eee2054e` (ADV-5 live twin)

Files: `app/src/jobs/sendReconcile.ts`, `app/test/sendReconcile.test.ts`.

- RED: `npx vitest run test/sendReconcile.test.ts -t "ADV-5"` - "Tests 1
  failed | 165 skipped (166)" (the slot `sent` without `carrierSentAt`).
- GREEN: `npx vitest run test/sendReconcile.test.ts test/retrySendAttempt.test.ts`
  - "Tests 213 passed (213)" (166 + 47). Typecheck 0; eslint 0; ASCII 0.

As built: `ownRetryRow`'s `Found` spreads `ownRowCarrierInstant(row.tsMsgId)`
when `row.delivery_status === 'sent'` (a new file-private helper), so
`mapAdopted` records a carrier-confirmed `sent`. The test: a share root, THIS
attempt's own child at `sent` outside the lookup window, check 0 found from
the row (no provider list call), the slot `toEqual` `{ status: 'sent', ...,
latestAttempt: child, carrierSentAt: child.provider_ts }`, derived `sent 1,
sending 0`, the record `done/adopted`, no ERROR.

Judgment call: the import line and two comments (the `Found` doc, the return's
comment) are MODIFIED lines; every record, claim and close line is untouched
(I7) - the change is data on the verdict. An adoption that already stamped the
provider's `date_sent` keeps it: a re-found `sent` row's own instant is
refused by the same-attempt rule, which never swaps one instant for another.

## Group 4 - `7be6ef3c` (ADV-2b in code, ADV-10 constant)

Files: `app/src/lib/retrySendWindow.ts`, `app/src/routes/webhooks/twilio.ts`,
`app/src/services/shareAttemptOutcome.ts`, `app/src/services/shareLedger.ts`,
`app/src/services/shareRecipientState.ts`, `app/test/twilioStatusWebhook.test.ts`.

- RED: `npx vitest run test/twilioStatusWebhook.test.ts -t "share rollup"` -
  "Tests 2 failed | 12 passed | 80 skipped (94)": `expected 1 to be 2`
  (transient: one call, the rollup's catch took the throw) and `expected 1 to
  be 3` (permanent).
- GREEN: `npx vitest run test/twilioStatusWebhook.test.ts test/shareAttemptOutcome.test.ts
  test/shareLedger.test.ts test/shareRecipientState.test.ts` - "Tests 153
  passed (153)" (94 + 24 + 16 + 19). Typecheck 0; eslint on the six files 0;
  ASCII 0.

As built: `rollRetryIntoBroadcast` calls `applyLaterAttemptBounded` (the
rollup's own try/catch stays for everything else); the transient test pins the
slot delivered after 2 calls and ZERO ERROR lines; the permanent test pins 3
calls, exactly ONE `share slot write failed after retries` ERROR (with
`broadcastId`, `retryRoot`, `attempt`), no `broadcast delivery rollup failed`,
ONE ERROR in total, 200. `RETRIED_ERROR_CODE = '30003'` is new in
`retrySendWindow.ts` (no exported copy existed there or in `sendOutcome.ts`)
and replaces the three services' private `RETRIED_CODE` and the webhook's
terminal-emit literal (`twilio.ts:4112`). `shareLedger.ts` now imports the
pure, import-free `retrySendWindow.ts` (no cycle; smoke 0).

## Group 5 - `2fd4b799` (G2 / ADV-11 (2), ADV-10 `pairContactId`)

Files: `app/src/services/shareAttemptOutcome.ts`, `app/test/shareAttemptOutcome.test.ts`,
`app/scripts/repair-share-outcomes.ts`.

- RED: `npx vitest run test/shareAttemptOutcome.test.ts` - "Tests 2 failed |
  24 passed (26)": the slot kept `latestAttempt: ROOT`; `pairContactId is not a
  function`.
- GREEN: `npx vitest run test/shareAttemptOutcome.test.ts test/repairShareOutcomes.test.ts
  test/twilioStatusWebhook.test.ts test/sendReconcile.test.ts test/retrySendAttempt.test.ts`
  - "Tests 351 passed (351)" (26 + 18 + 94 + 166 + 47). Typecheck 0; eslint 0;
  ASCII 0.

As built: `nextSlot` spreads `latestAttempt` only when `input.attemptKey !==
slot.tsMsgId`. Checked: `slotEquals` and both already-applied checks compare
against `nextSlot` (same shape, so a re-apply reads applied - pinned, one
write in total); `projectSlot` is `nextSlot`; the repair's `slotRecords`, the
state service's `newestKey`, `ledgerEntryForSlot` and the dashboard's hint gate
all read `latestAttempt ?? tsMsgId`; the `applyAttemptOutcome` condition still
names the RECORDED attempt - pinned as `{ status: 'sent', latestAttempt:
undefined }`, and for the original's delivery over a newer failed retry
`{ status: 'failed', latestAttempt: RETRY }` (that slot is left with NO
pointer: it records the original again). `pairContact` became the exported
`pairContactId` (two internal callers renamed, a unit pin added) and the
repair's pair rule reads it (`pairContactId(contactKey,
nonEmpty(newest.recipient_contact_id))` - the same result as its old copy).

## Group 6 - `9758c5ee` (ADV-10 seed helper)

File: `app/test/helpers/listingSendSeed.ts` - a refactor; the suites are its
pins (no red by design).

- GREEN, unchanged: `npx vitest run test/listingSendsApi.test.ts
  test/contactsBatchReads.test.ts test/repairShareOutcomes.test.ts
  test/contactTimeline.test.ts test/listingSendsRepo.integration.test.ts` -
  "Tests 114 passed (114)" (16 + 10 + 18 + 64 + 6). Typecheck 0; eslint 0;
  the file is ASCII 0.

As built: the helper builds the legacy entry (`!legacy` / `!individual`,
`counted` by `acceptance`, `countedAt: sentAt`) keyed by `broadcastId ??
'individual'` and writes it through `applyShareLedgerEntry` (a silent logger);
anything but `written` throws. Signature kept. `contactTimeline.test.ts` does
not use the helper (run as named); `listingSendsRepo.integration.test.ts`
does (not in the named list, run anyway). Every same-pair re-seed in the
suites uses a DIFFERENT key (`listingSendsRepo.integration` :80/:83/:90,
`listingSendsApi` :361/:364), which the service merges exactly as the old
helper did; a same-key re-seed would now throw (refused) - no suite does it,
so no STOP.

## Group 7 - `47a00537` (ADV-7, G3, G7)

Files: `dashboard/src/routes/broadcasts/useBroadcastsList.ts`,
`BroadcastsList.test.tsx`, `BroadcastResults.tsx`, `BroadcastResults.test.tsx`,
`BroadcastStatusPill.tsx`, `dashboard/src/api/types.ts`,
`dashboard/src/routes/contact/deliveryStatus.ts`, `app/test/broadcastApi.test.ts`.

ADV-7. RED: `npx vitest run src/routes/broadcasts/BroadcastsList.test.tsx` -
"Tests 3 failed | 16 passed (19)": back-to-back (`getBroadcastStats` called 0
times), in flight (`expected false to be true`: not aborted), pending timer
(called once). The FIRST implementation was the mission's literal form -
`rowsRef.current = next` assigned inside the functional updater, plus the
count-carrying cancel: the in-flight and timer cases went green, the
back-to-back case stayed RED (1 failed | 18 passed (19)). A throwaway probe
(logging in the updater and at the decision; reverted, `fw1-g7-probe.log`)
showed BOTH updaters ran at the render, AFTER the second event had decided:
React computes an updater eagerly only while neither fiber has pending work
(after a render the alternate still carries the lane), so an assignment inside
the updater cannot reach a handler that runs before the next render.
Judgment call - the adjudication's "keep `rowsRef` in sync", made synchronous:
every write to the rows goes through `updateRows(change)`, which applies the
change to `rowsRef` at once and to React's state as the same PURE functional
update; the filter reset clears `rowsRef` beside its `setRows([])`; the
render-synced `useEffect` is gone (it could only lag, and could overwrite a
newer patch with an older render's rows). The decision reads the row as
patched from `rowsRef`; a count-carrying event cancels the row's timer and
aborts its in-flight read (`cancelStatsRefetch`, which `scheduleStatsRefetch`
now also calls); the 400 ms per-row debounce is kept. GREEN: "Tests 19 passed
(19)". A third test beyond the mission's two pins the timer cancel.

G3. RED: `npx vitest run src/routes/broadcasts/BroadcastResults.test.tsx` -
"Tests 1 failed | 23 passed (24)" (the hint link present). The literal clause
`row.retryPending !== true` made it green but turned the ticker pin RED ("a
tick past the promise shows the hint AND moves the pill from Sending to Not
sent", 1 failed | 23 passed (24)): after a lapse the row still carries the
route's `retryPending: true`, has left the Retrying count, and must show the
hint (spec D3). Judgment call: the clause is `!(row.retryPending === true &&
row.retryDueAt === undefined)` - G3's exact condition ("retryPending: true, no
retryDueAt") and `pendingRetryCount`'s own rule, so no row is both counted in
Retrying and offered the hint. GREEN: "Tests 24 passed (24)".

G7 (comment-only): the `PreviewCandidate` doc in `types.ts` (the SAFE reading
over every share); `DeliveryReasonOptions.retryScheduled` /
`retryUnconfirmed` in `deliveryStatus.ts` (now two callers: the one-to-one
chip and the property-send results row); `BroadcastStatusPill.tsx`'s header
and JSDoc (Sent / Sending / Not confirmed / Not sent); `broadcastApi.test.ts`
`:655` and `:1083`, the only two "1500" comments at HEAD (slice 1's `:575` /
`:1003` are the same two lines before later slices moved them).

Runs: `npx vitest run src/routes/broadcasts` - "Test Files 12 passed (12) /
Tests 199 passed (199)"; with `src/routes/contact/deliveryStatus.test.ts` and
`src/api` - "Tests 487 passed (487)"; app `npx vitest run test/broadcastApi.test.ts`
- "Tests 78 passed (78)". Typecheck 0; eslint on the eight files 0; ASCII 0.

## Group 8 - `5be51e04` (spec D9, ADV-2a, ADV-6, ADV-9, section 8)

- RESOLVED blocks (status `resolved`, `resolved: 2026-09-28`, "UNMERGED at
  this writing - the merge closes it", the remove-dev-outbox precedent), each
  with the spec decision, the commits by task and the residuals:
  `docs/issues/broadcast-30003-retry-never-updates-slot.md` (D2, D8),
  `docs/issues/unconfirmed-share-invites-resend.md` (D1, D4),
  `docs/issues/tenant-timeline-property-sent-milestone-after-failed-delivery.md`
  (D6, D7).
- Addendum: `docs/issues/send-attempt-sweeper.md` (D1's in-flight population;
  a sweeper close feeds the flag; 1b's `already_sent` note referenced, not
  repeated - the repair reads a `retry_send` record only as unresolved).
- New (LOW, open): `share-retry-late-send-flag-window.md` (ADV-2a),
  `share-results-promise-refresh-not-emitted.md` (ADV-6),
  `share-list-sse-patch-rebucket-and-refresh.md` (ADV-9).
- Section-8 residuals - grepped first; none was on file for the SHARE side
  (the fork and the stale tab exist on the thread side in
  `manual-retry-double-send-residual-windows` and `send-reconcile-job-residues`;
  `broadcast-route-markfailed-blocks-finalize` covers the route, not the
  flag): `share-slot-two-child-fork-reads-failed.md`,
  `share-route-failed-pass-unclaimed-read-stranded.md`,
  `share-retry-rollup-lost-past-reread-bound.md`,
  `share-unitless-pre1b-chain-unattributed.md`.
- `npm run issues` exit 0 ("359 open, 188 closed, 547 total");
  `docs/issues/INDEX.md` is gitignored (`.gitignore:62`) and nothing from it
  was committed. Every issue file ASCII 0. Typecheck 0.

## Final gates

- `npm run smoke`: exit 0 - "smoke-dist: OK - 1545 import specifier(s) across
  268 emitted file(s) resolve under plain Node."
- The mission's list (`cd app && npx vitest run test/repairShareOutcomes.test.ts
  ... test/broadcastFanOut.test.ts`): "Test Files 14 passed (14) / Tests 702
  passed (702)" - repairShareOutcomes 18, sendReconcile 166,
  twilioStatusWebhook 94, shareAttemptOutcome 26, shareLedger 16,
  shareRecipientState 19, listingSendsApi 16, contactsBatchReads 10,
  contactTimeline 64, broadcastApi 78, twilioWebhookHarnessRepoAdditions 23,
  twilioWebhookHarnessRetryFields 14, retrySendAttempt 47, broadcastFanOut 111.
- `npm run typecheck`: exit 0 before each of the eight commits.
- Fence: `git diff --stat 3f38bcc2 HEAD --` jobs.ts, sqsJobConsumer.ts,
  oneToOneRetryDecision.ts, registerHandlers.ts prints nothing; the fix wave
  also leaves `retrySend.ts`, `retryPromiseWrites.ts`, `retryChain.ts` and
  `sendAttemptsRepo.ts` untouched. No harness double changed (no repo behavior
  changed).
- Not run (the orchestrator's): the full `npm test`, `npm run e2e`.

## Found while fixing (not fixed)

1. The repair cannot heal a same-attempt carrier gain: a slot `sent` WITHOUT
   `carrierSentAt` on the attempt whose row reads `sent` (a lost original
   `sent` rollup, lasting when the carrier never sends a delivery receipt) is
   not "to move" - `slotRecords` compares status, code and attempt only, so
   ADV-5's decided instant is never written although `wouldApply` allows it.
   Healing it needs `slotRecords` to compare the instant's presence too.
2. `PreviewResponse`'s doc in `dashboard/src/api/types.ts`
   (`priorRecipientContactIds` "the set already sent for this unit") is G7's
   staleness one interface down; not in G7's list, left.
3. Other copies of `'30003'` outside ADV-10's list: `twilio.ts` (the retry
   decision's gate, the error-class `case`, `TRANSIENT_RETRYING_DELIVERY_CODES`,
   `RELAY_RETRY_TRIGGER_CODE`) and the fenced `oneToOneRetryDecision.ts`.
4. The results page syncs ITS `rowsRef` (the ticker's) with a passive
   `useEffect` (`BroadcastResults.tsx`) - ADV-7's lag pattern; there it can
   only delay a 60 s tick's recount by one render, so no defect was found.
5. A repair ledger-write failure after a slot MOVED is counted in
   `slotsFailed` even when `applyLaterAttempt`'s own ledger write already
   landed (the pair is then right; its past-tense counters are skipped) - the
   conservative side; the next run reports nothing left for it. A `lost`
   ledger write logs two lines (the service's ERROR and the repair's).
