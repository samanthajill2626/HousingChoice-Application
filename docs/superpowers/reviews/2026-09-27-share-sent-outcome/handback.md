# Share sent outcome (Branch B) - build handback

Date: 2026-09-28. Orchestrator: Claude Fable 5.1 (children: Claude Opus 5.5).
Branch `feat/share-sent-outcome`, worktree `W:\tmp\share-sent-outcome`.
Base: main @3f38bcc2 (the one sync at cebc7d23; Stage 1b merged). Mission
block a8a75e8e; plan v5 @95d18c4d; spec v5 + the 2026-09-28 restatement.

**MERGE-READY - code final `e824a452`; gates green at `6e449c22` (the commits
after e824a452 are records only: two review rounds' adjudications, the
fix-wave-2 report, the self-QA); 0 behind main (main is still @3f38bcc2, the
merge base - NO drift, no second sync needed); UNMERGED (human gate).**

## Post-merge obligations - LOUD

- NO infrastructure: no Terraform, no secrets, no flags, no schema, no
  dependency, no `.env`. The `byContact` GSI becomes sparse by attribute
  ABSENCE (a contract note in `tables.ts` + README; `gen-tables` emits nothing
  for it).
- THE REPAIR IS OWED, AND ITS ORDER IS BINDING: deploy -> census
  (`npx tsx app/scripts/repair-share-outcomes.ts --env dev`) -> `--apply` ->
  the next property blast, dev then prod (RUNBOOK "Share outcomes repair
  (2026-09-28)"). WHAT IS BROKEN UNTIL THE APPLY (code review ADV-1, HIGH,
  accepted): before this branch the composer's "Already sent" flag over-flagged
  (every recipient of a sent/sending share); the deployed code flags only a
  recipient the text may have reached, and a historical slot whose 30003 retry
  DELIVERED before the deploy still reads `failed 30003` (nothing ever routed
  its retry), so from the deploy until the apply that tenant is NOT flagged,
  starts pre-checked in the composer, and the next blast of that unit texts
  them the same property again - the flag's historical error flips from safe
  to a double text (HIGH at most on Cameron's scale). A one-to-one share from
  a tenant's file reads the same flag. After the apply, three classes stay
  under-flagged for good if their retry delivered: the slots the repair cannot
  judge (`unjudgeable.originalMissing` / `brokenLineage`), the lineage-less
  pre-RSW retry the census cannot see, and the slots an apply names on
  `slotsFailed` ERROR lines with a permanent cause (the 400 KB item limit on a
  legacy >1000-recipient share). An apply that exits 1 `COMPLETED WITH
  FAILURES` closes the window for every slot except the ones its ERROR lines
  name; an ABORTED apply (a PARTIAL report) for none - fix and re-run.
- The human resolves the three closed issues at merge (their RESOLVED blocks
  are written; status stays open until merged).
- The RUNBOOK names the log lines that mean "re-run the repair" (a Logs
  Insights query is given); nothing schedules it.

## For Cameron - one wording conflict in the spec (not a blocker)

Spec D1 lists "the milestone" among the STRICT readers ("reached only"), but
D6 - the specific rule for the milestone's words, gated in section 9 - reads a
live `pending` entry as "Property sent" while the promise is live. The code
follows D6 (the plan-blind reviewer's ADV-3 challenged it; rejected as a
defect on D6 verbatim; the round-2 reviewer upheld the rejection and asked for
the comments to match, done). If D1's wording was the intent, it is a one-word
change in `propertySentWords` plus its tests - say so at the merge.

## Work map - shipped / deviated / skipped

| Item | Verdict | Where |
|---|---|---|
| T1 order key, `latestAttempt`, `applyAttemptOutcome`, `getByIds`, stats opts, cap 1000 | SHIPPED | ca55f3b3; `app/src/lib/shareAttemptOrder.ts`, `broadcastsRepo.ts` |
| T2 recipient-state service (D1, two readings, 24-min row bound, 30-day record bound from `updated_at`, mapLimit 8, `priorRecipientKeys`) | SHIPPED (+ redacted slot keys in WARNs) | 5ea5005f, a9ed3ab3; `app/src/services/shareRecipientState.ts` |
| T3 ledger memory (`shares`, `counted`, `shares_op`, sparse by ABSENCE, `putShareMemory`, `getByKeys`, `applyShareLedgerEntry`, `ledgerEntryForSlot`) | SHIPPED; readers list `counted !== false` AND `sentAt` present (the plan's text; the sketch filtered `counted` only) | 3c885850; `listingSendsRepo.ts`, `app/src/services/shareLedger.ts` |
| T4 `applyLaterAttempt` (D2 rule, lost-condition re-read, already-applied at the top and after a refusal, sideEffects, `wouldApply`, `projectSlot`, bounded variant) | SHIPPED; DEVIATED from one sketch line: a re-applied row-less marker answers `applied` with NO write (deviation 15's own rule; the sketch's test said `refused`) | 71a57f58; `app/src/services/shareAttemptOutcome.ts` |
| T7 `recordPropertySent` entry + milestone `broadcastId`; `recordSend` DELETED | SHIPPED | 3a68c164 |
| T5 webhook: `retry_of` skip removed, retry rows routed by `broadcast_id` + `retry_root`, the promise from `oneToOneRetry.runAt`, the original row's entry, `retry_pending` 1 on the 30003 emit, the withdrawal emit with the count UNSET, give-up line ASCII, harness ledger repo | SHIPPED; the withdrawal emit fires only when the WITHDRAW succeeded (a failed one leaves the promise live, which the route still counts) | 7a23711e; fix wave 1 made the retry path BOUNDED (7be6ef3c) |
| T6 the five 1b sites (adoption hook BEFORE `closeFromReconcile(adopted)`, bounded; unresolved arm AFTER the WITHDRAW, bounded; the job's two arms slot-FIRST through `guardWrite`; `no_slot` at ERROR; `Found` widened; `wire()` both repos; `registerHandlers` UNTOUCHED) | SHIPPED; `no_broadcast` logs ONE WARN (the service's) not two | ad45ef4a; fence diff EMPTY over jobs.ts, sqsJobConsumer.ts, oneToOneRetryDecision.ts, registerHandlers.ts (retrySend.ts insert-only) |
| T8 composer flag via `priorRecipientKeys`; repo rule + mirror DELETED; pins rewritten | SHIPPED | 56681acc |
| T9 results (`retryDueAt`/`retryOutcome`/`latestAttempt`/`retryPending`, true `retry_pending`, `unconfirmedKeys`, `?view=stats` 400 `invalid_view`) + list | SHIPPED; the withdrawn sentinel passes through on the wire (I5; never live); fix wave 2 made the read CONSISTENT in both views (7a015dc5) | cbc84296 |
| T10 dashboard (types, `presentShareLabel`, `Retrying` chip + `progress` tone + clamp, badge props, the hint, the tick-only recount with the override rules, both hooks' merge + the finished-share stats refetch) | SHIPPED; the tick override lives in the hook; a rows-behind guard; `BroadcastsList.tsx` needed no change; fix waves: the list hook decides from the rows as patched + cancels on a count-carrying event (47a00537), the hint hides a pending-by-unreadable-row recipient (G3), the results hook recounts from its own synchronous `resultsRef` (e824a452) | ab48caf0 |
| T11 D5 recount (units activity guarded; landlord relabel after the slice, guarded, landlord-only; "No tenants reached") | SHIPPED | b335a54e |
| T12 D6 milestone words from the ledger (pending read from the row within the bound) | SHIPPED | 417b16d6 |
| T13 `repair-share-outcomes` (one Scan; chain / break / decided attempt; stamps missing OR wrong; `wouldApply` gates "to move"; the ledger follows the SLOT; census forecasts; per-fixture rows; RUNBOOK) | SHIPPED; fix waves added: per-slot write failures continue (`slotsFailed`, exit 1) with a SYSTEMIC-class abort (the reminder sweep's rule), a bounded slot write, a `sent` row carrier-confirmed at its own instant, an honest `slotsMoved`, the carrier-instant clause in `slotRecords` | 5005a606, 8e00e495, c262e074 |
| T14 e2e spec (four scenarios; (a) pending via the API; (b) the list opened after the stamp; helpers COPIED) + 3 pins + `selectors.md` | SHIPPED (uid block from 94, disjoint from retry-send-adoption's 91-93) | 329d136a |
| T15 issues, self-QA, drift, gates, handback | SHIPPED (issues in fix wave 1, 5be51e04; self-QA 6e449c22; this file) | - |

Skipped: nothing.

## Gates on the FINAL tree (HEAD 6e449c22; code final e824a452) - bare, from the worktree, each its own command

- `npm run typecheck` -> `EXIT=0`.
- `npm test` (after `npm run db:stop; npm run db:start`) -> `EXIT=0`:
  `Test Files  399 passed (399)` (app), `210 passed (210)` (dashboard),
  `21 passed (21)` (e2e workspace), `34 passed (34)` (fake-twilio),
  `13 passed (13)` (fake-twilio-web). No `[dynamoAdmin]` line.
- `npm run smoke` -> `EXIT=0`: `smoke-dist: OK - 1545 import specifier(s)
  across 268 emitted file(s) resolve under plain Node.`
- `timeout 1800 npm run e2e` -> `EXIT=0`: `Running 304 tests using 1 worker`
  ... `304 passed (22.8m)`; the new spec's four scenarios ok 178-181.
- `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts'
  '*.tsx' '*.js' '*.mjs' '*.cjs')` -> `EXIT=0` over 72 files, zero output (no
  baseline attribution needed).

The FIRST battery (at 71081173, before the reviews): typecheck 0, smoke 0,
eslint 0 (68 files), e2e `304 passed (22.6m)` EXIT=0, and `npm test` EXIT=1
with ONE red file - `app/test/repoPagingWiring.test.ts` (two `listingSends`
paging cases: `expected [] to deeply equal [ 'u1', 'u2' ]`) - a fixture of
minimal rows with no `sentAt` and no `counted`, a shape no real row has; the
readers now list counted rows, which always carry `sentAt`. Fixture flipped by
the orchestrator (7386968d; both reviewers agreed); green alone and in the
final battery. No named flake (the list is empty); no re-run-and-compare was
needed; no `[dynamoAdmin]` sighting in any run.

## Files, commits, delta

- 42 commits a8a75e8e..6e449c22 (20 build + 1 gate fix + 6 review records +
  15 fix-wave commits incl. reports and issues). Code final e824a452.
- Code/tests/ops diff vs main: `87 files changed, 9437 insertions(+), 677
  deletions(-)` (76 files under app/dashboard/e2e/RUNBOOK/README; the rest
  under `docs/issues/`). Everything incl. the mission records: `126 files
  changed, 23620 insertions(+), 771 deletions(-)`.
- New: `app/src/lib/shareAttemptOrder.ts`, `app/src/services/shareRecipientState.ts`,
  `shareLedger.ts`, `shareAttemptOutcome.ts`, `app/scripts/repair-share-outcomes.ts`,
  `app/test/helpers/listingSendSeed.ts`, seven app test files,
  `dashboard/src/routes/broadcasts/DeliveryBadge.test.tsx`,
  `e2e/tests/dashboard-next/share-sent-outcome.spec.ts`, seven issue files.
- Fence proof: `git diff --stat 3f38bcc2 HEAD -- app/src/jobs/jobs.ts
  app/src/adapters/sqsJobConsumer.ts app/src/services/oneToOneRetryDecision.ts
  app/src/jobs/registerHandlers.ts` prints nothing; `retryPromiseWrites.ts`,
  `retryChain.ts`, `sendAttemptsRepo.ts` untouched; `retrySend.ts` insert-only.
- ASCII: every added line of the branch strips to 0 bytes; the three named
  pre-existing non-ASCII lines were re-worded where touched.

## Declared deviations (the plan's 16 hold as shipped; build-added)

1. T4: a re-applied row-less marker answers `applied` with no write (deviation 15).
2. T5: the withdrawal emit only after a successful WITHDRAW.
3. T3: `isListed` = `counted !== false` AND `sentAt` present (both readers).
4. T9: the withdrawn sentinel passes through `retryDueAt` on the wire (never live).
5. T10: the tick override lives in the hook; a rows-behind guard; the ticker is always armed (visibility-gated); `BroadcastsList.tsx` unchanged.
6. T13 (G1): the repair creates `counted: false` ledger rows for un-reached pairs (spec D8 step 4 says "for a reached recipient"; plan-mandated; both readers and the index skip them; D6 needs the memory).
7. G2 fixed: an `applyLaterAttempt` on the original's own key leaves NO `latestAttempt` (the type's contract).
8. Repair (fix waves): per-slot write failures continue with `slotsFailed` and exit 1; SYSTEMIC error classes abort; `slotsMoved` counts only the run's own change; a `sent` row is carrier-confirmed at its own instant; `lost` past the bound is per slot.
9. Results route: `getByIdConsistent` in both views (R2-1).
10. The gate fixture flip (7386968d).
11. Unjudgeable slots: `noContact` / `noRecipientKey` ARE judged and moved (only `originalMissing` / `brokenLineage` leave a slot); a lineage-less pre-RSW retry is counted nowhere (spec D8 names it among the reported; the RUNBOOK says so).

## Review findings and resolutions

Round 1 (fec9bfef; adjudications ed83834d). Spec-conformance: 88 CONFORMS / 1
PARTIAL (T13.8, a RUNBOOK line - fixed) / 0 MISSING; asks G1-G7 (G1 accept,
G2 fix, G3 fix, G4 accept, G5 RUNBOOK fix, G6 accept, G7 fix). Plan-blind
adversarial: 0 CRITICAL / 1 HIGH / 4 MEDIUM / 6 LOW, every HIGH+ reproduced.
ADV-1 (HIGH, the deploy-before-repair flag flip) - ACCEPTED as documentation
+ the binding order above (no code: the alternatives either re-flag every
final 30003 failure - D1's un-flagging - or cannot see pre-pointer rows).
ADV-2a (late retry gap) - accepted residual (spec section 8), FILED
`share-retry-late-send-flag-window`. ADV-2b - FIXED (the webhook's retry path
bounded; RUNBOOK re-run triggers). ADV-3 (milestone words) - REJECTED (spec
D6 verbatim), comments corrected in wave 2. ADV-4 (repair abort on one bad
share) - FIXED. ADV-5 (`sent` row repaired as bare acceptance) - FIXED (repair
+ the live `ownRetryRow` twin). ADV-6 (promise refresh emits no share event) -
FILED `share-results-promise-refresh-not-emitted`. ADV-7 (list hook ref lag,
stale refetch) - FIXED. ADV-8 (census forecast per slot) - RUNBOOK sentence.
ADV-9 (Not-confirmed re-bucketing only in routes) - FILED
`share-list-sse-patch-rebucket-and-refresh`. ADV-10 (duplicated rules) -
FIXED (one `RETRIED_ERROR_CODE`, `pairContactId`, the seed helper through the
service). ADV-11 - (1) accepted, (2) FIXED (= G2), (3) accepted.

Fix wave 1 (d8e85c39..fa42bf1d): every fix proven real by revert in round 2.

Round 2 (6916a971; adjudications 3acb7b04; a fresh reviewer): 0 CRITICAL /
0 HIGH / 0 MEDIUM / 1 LOW new (R2-1, consistent read - FIXED), 3 LOW fix-diff
defects (R2-F1 RUNBOOK - FIXED; R2-F2 transient/systemic write faults - FIXED;
R2-F3 `slotsMoved` misfire - FIXED), 1 challenge (C-1: keep ADV-3's rejection,
reword two comments - DONE; the D1/D6 conflict above). Found-while-fixing: #1
FIXED (the carrier-instant clause), #4 FIXED (the results hook's synchronous
ref), #2 comment fixed, #3 and #5 accepted. Fix wave 2 (0ddf55f1..0002fbbc)
was reviewed by the ORCHESTRATOR itself (LOW-only precision; recorded in
3acb7b04) and re-gated on the touched suites, typecheck and smoke before the
final battery.

## Live self-QA (`self-qa.md`, 6e449c22; screenshots in the worktree's ignored `.playwright-mcp/share-sent-outcome-selfqa-*.png`)

On the hermetic lane 7 (booted fresh; curl for the API side, the plugin
Playwright MCP for the eyeball): H1 the pending copy ON SCREEN (pill Sending,
Retrying 1, the row "Failed - Phone unreachable - will retry (error 30003)");
(a) a retry that delivers (pill Sent, Delivered 1, the ledger at the retry's
instant, "Property sent", the flag on); (b) four failures with the LIST OPEN:
the row flipped Sending -> Not sent live at the fourth failure, the network
panel showing `GET /api/broadcasts/<id>/results?view=stats => 200` (the
stats-only read at the boundary), the results page Not sent + the alert + the
hint, the flag off, the pair gone from Properties sent, "Property text
failed"; (c) 30007 (Not sent, the hint, "No tenants reached" on the property
Activity card); (d) Not confirmed (no alert, no hint, the flag ON, not
listed, no milestone); H2 a share RETRY reaching the reconcile's unresolved
close (the original slot `send_unconfirmed` with the row-less pointer, the
row's withdrawn sentinel + `retry_outcome`, "Property sent - not confirmed");
H4 the landlord timeline ("Sent to 1 tenant", three "No tenants reached");
H5 the repair census -> apply -> census on the lane: 10 shares / 4 slots
walked, every counter 0 both times, no WARN/ERROR. H3 (the ~150 ms mid-chain
"Sent" flash slice 4b measured) was not caught at snapshot cadence - named.
The three console errors at the end were the SSE reconnects when the lane
was stopped (benign).

## Issues

Closed (RESOLVED blocks written; the human resolves at merge):
`broadcast-30003-retry-never-updates-slot`, `unconfirmed-share-invites-resend`,
`tenant-timeline-property-sent-milestone-after-failed-delivery`. Amended:
`send-attempt-sweeper`. Filed (LOW, accepted residuals):
`share-retry-late-send-flag-window`, `share-results-promise-refresh-not-emitted`,
`share-list-sse-patch-rebucket-and-refresh`, `share-slot-two-child-fork-reads-failed`,
`share-route-failed-pass-unclaimed-read-stranded`,
`share-retry-rollup-lost-past-reread-bound`, `share-unitless-pre1b-chain-unattributed`.

## Residuals named (not blocking, your eye)

- The D1/D6 wording conflict (above).
- A slot `failed` at its OWN attempt whose row reads delivered stays failed
  (D2's same-attempt terminal rule; unreachable through the message machine).
- The census forecast can predict a multi-share pair flipping when the apply
  does not (RUNBOOK); a legacy row's count is attributed to its last
  `broadcastId` only (spec D7), so an unjudgeable earlier share can leave a
  received pair un-counted (narrow).
- `outcomeOf` writes `errorCode: 'unknown'` for a code-less failure of a
  retry row while the original rollup writes none (rare; the carrier stamps
  a code).
- The results page's clock snapshot is re-taken on ticks, not on refetches
  (at most one tick old); a failed refetch leaves the rows-behind mark set
  until the next successful fetch.
- The list reads Sending past a promise's lapse with no event (D4's accepted
  staleness); the results page ticks.
- Perf fingerprint strings in `e2e/performance/routes.ts:726`, `:811` point at
  stale `useBroadcastResults.ts` lines (strings only; nothing fails).
- The composer flag walks every share of a unit with record reads (bounded
  by the 30-day record life and the 24-minute row bound); production scale
  not measurable on a lane.
- `hasReached` has no production caller (kept as the documented STRICT
  predicate of the shared interface).

## Recoveries and process

Zero recoveries, zero cold-dispatch misfires, zero background-child waits:
eight fresh foreground children (four implementers, one T13, one T14, one
fix wave, one fix wave 2) plus four fresh reviewers (two round-1, one
round-2, none resumed). Every long command ran in the background with an exit
marker and was waited on in sliced foreground checks. The project Playwright
MCP's bundled Chromium build was missing (a download to install - not done);
the plugin Playwright MCP on the Chrome channel served the eyeball. Records
committed as produced under `docs/superpowers/reviews/2026-09-27-share-sent-outcome/`
(`build/` five slice + two fix-wave reports, `code-review/` five files,
`self-qa.md`, this handback); `.superpowers/` holds the ledger, heartbeat,
logs, references and the review diff packages.
