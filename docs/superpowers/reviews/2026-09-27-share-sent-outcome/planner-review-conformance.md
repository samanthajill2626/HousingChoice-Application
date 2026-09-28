# Share sent outcome (Branch B) - planner's independent spec-conformance review

Date: 2026-09-28. Reviewer: Claude Opus 5.5 (planner's reviewer, read-only).
Branch `feat/share-sent-outcome`, worktree `W:\tmp\share-sent-outcome`.
Code final `e824a452`; records through `a33e0d7f`; base = merge base with main
= `3f38bcc2` (main is still there: `git rev-list --count e824a452..main` = 0).
Spec: `docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md` (v5 +
the 2026-09-28 restatement + the two section 8 amendments; section 9 rulings).
Work map: plan revision 5 (16 declared deviations) and `handback.md` (11
build-added deviations).

Method: read-only. Only git read commands and file reads; no npm, no tests, no
lane (a gate run is live in this worktree). The five gates are therefore
CLAIMED by the handback, not re-verified here. All `file:line` references are
at `e824a452` (the app/dashboard/e2e/RUNBOOK/README tree is byte-identical at
`a33e0d7f`: `git diff --stat e824a452 a33e0d7f -- app dashboard e2e RUNBOOK.md
README.md` is empty).

## Summary

| Area | Items | CONFORMS | PARTIAL | MISSING |
|---|---|---|---|---|
| Decisions D1-D9 | 46 | 44 | 2 | 0 |
| Invariants I1-I9 | 9 | 9 | 0 | 0 |
| Section 0 (1b interface, the fence) | 2 | 2 | 0 | 0 |
| Section 5 surfaces | 11 | 11 | 0 | 0 |
| Section 7 hermetic tests | 9 | 9 | 0 | 0 |
| Section 7 end to end (a)-(d) | 4 | 3 | 1 | 0 |
| Section 7 rewritten pins | 8 | 8 | 0 | 0 |
| Section 9 rulings | 3 | 3 | 0 | 0 |
| **Total** | **92** | **89** | **3** | **0** |

The three PARTIALs: D1.2 (a spec-internal conflict, D1 vs D6 - the code
follows D6 as gated; not a build defect), D8.6 (the lineage-less pre-RSW retry
is neither reported nor left alone on the LEDGER side), and e2e (a) (the
"will retry" row copy is pinned by unit tests and self-QA, not end to end).

Deviations: the plan's 16 are all permitted by the spec (two of them, 11 and
16, by the spec's own section 8 amendments). Of the handback's 11, nine are
permitted; #6 (the repair creates un-counted ledger rows) departs from D8 step
4's letter and was accepted in round 1; #11 (the lineage-less class) is
declared only for its REPORT half - its ledger half is new here (item 2 below).

Handback claims verified by reading: the fence proof, the ASCII claim, no
infrastructure, 0 behind main, records-only commits after the code final, the
three RESOLVED blocks, the sweeper amendment, the seven filed issues, the
RUNBOOK repair section and its binding order. One wording inaccuracy in the
handback about the issues' status (item 5).

## A. Decisions

### D1 - the recipient state and its two readings

- D1.1 The state table - CONFORMS. `app/src/services/shareRecipientState.ts:67-91`:
  skipped; delivered/sent -> reached (confirmed or not); queued in a `sending`
  share -> in flight; queued elsewhere: record not asked or unreadable -> in
  flight, read-and-absent or `expired` -> stranded, `done` with one of
  `refused|rejected|enqueue_failed|redrive_refused` (`:49`) -> stranded, any
  other shape -> in flight; failed `send_unconfirmed` -> unconfirmed; a
  non-30003 failure -> failed without a read; a 30003 failure: no read
  (outside the bound) -> failed, unreadable -> pending, `retry_outcome`
  unconfirmed -> unconfirmed, else live promise -> pending / lapsed or
  withdrawn -> failed.
- D1.2 The two readings - PARTIAL (spec conflict, not a build defect). SAFE
  `mayHaveReached` (`:94-96`) and STRICT `hasReached` (`:102-104`) are exactly
  D1's sets, and the labels, the counts and the ledger take the strict reading.
  D1's parenthetical names "the milestone" among the STRICT readers; D6 reads a
  live `pending` entry as "Property sent". The code follows D6 (see D6.2, and
  the header comment `shareRecipientState.ts:7-9`). D6's text is byte-identical
  between the gate commit `0bb4042d` and HEAD, and D1's conflicting sentence
  was ALSO in the gated text (`0bb4042d` spec lines 208-211). So what shipped
  is D6 exactly as Cameron approved it; the conflict was in the gated spec.
  Item 1.
- D1.3 The stored status never decides - CONFORMS. The classifier reads
  `share.status` only for `sending` vs not (`:75`, `:125`, `:190`);
  `priorRecipientKeys` walks every share of the unit whatever its status
  (`:249-269`); the repo's interim rule is deleted (plan deviation 2).
- D1.4 The record read and its 30-day bound - CONFORMS. One keyed read per
  queued slot of a non-`sending` share (`:190-206`), bounded from `updated_at`
  falling back to `created_at` (`:124-128`; spec section 8 amendment); past
  the bound `expired` reads stranded without a read (`:191-193`); a failed read
  reads in flight and WARNs with the key redacted (`:197-204`).
- D1.5 The row read and its derived 24-minute bound - CONFORMS. The constant is
  the sum, not a figure (`:43-44`: window + last reconcile delay + 2 x grace +
  60 s = 15+4+2+2+1); measured from the newest attempt key's provider instant
  (`:111-116`); a row-less marker reads the retried row (`:171-172`); a failed
  read reads pending and WARNs (`:182-188`).
- D1.6 ONE new slot attribute - CONFORMS. `latestAttempt`
  (`app/src/repos/broadcastsRepo.ts:188`); the promise and chain end are never
  copied onto the slot (see I5).

### D2 - one attempt-ordered transition

- D2.1 The new primitive - CONFORMS. `applyAttemptOutcome`
  (`broadcastsRepo.ts:951-987`): one UpdateItem whose condition names the
  slot's status AND its recorded attempt (`attribute_not_exists` for the
  original, else `= :pa`) and ADDs the stats delta in the same write.
- D2.2 The order rule - CONFORMS. `shareAttemptOutcome.ts:123-131`: only from
  `failed` or `sent`; a newer attempt always; the same attempt only forward
  from `sent` (to delivered, to failed, or gaining its carrier instant),
  `failed` terminal; an older attempt only as a delivery; `nextSlot`
  (`:97-115`) never produces `queued`, a newer attempt never inherits the old
  carrier instant, an older delivery records itself as the newest.
- D2.3 A lost condition - CONFORMS. Re-read consistently and re-decided up to
  `MAX_REAPPLY` (`:222-261`), then ONE WARN with the ids (`:262`).
- D2.4 The row-less attempt's order - CONFORMS. `<retried>~`
  (`app/src/lib/shareAttemptOrder.ts:15-17`; plan deviation 3).
- D2.5 Caller: the webhook - CONFORMS. The `retry_of` skip is gone; a retry row
  is routed by `broadcast_id` + `retry_root` (`app/src/routes/webhooks/twilio.ts:3561-3562`,
  `:3941-3966`); outcomes are only the carrier-confirmed `sent`, `delivered`
  and failures (`outcomeOf`, `:3919-3927`).
- D2.6 Caller: the retry adoption, BEFORE the record close - CONFORMS.
  `app/src/jobs/sendReconcile.ts:580-583` (the hook, then
  `closeFromReconcile(adopted)`); the found verdict carries the attempt
  (`adoptRetry`, `ownRetryRow`, `ownRowCarrierInstant` `:1200`); `mapAdopted`
  maps as the share adoption does (`:1475-1488`).
- D2.7 Callers: the four unresolved-end sites - CONFORMS. The reconcile's
  unresolved close and its superseded-exit re-apply share one arm: the
  WITHDRAW first, then the row-less slot write (`sendReconcile.ts:1446-1460`,
  `unresolvedShareRetry` `:1527`); the job's second-unknown arm and its
  hand-off enqueue-failure arm write the slot FIRST through `guardWrite`
  (`app/src/jobs/retrySend.ts:811-838`, `:855` before `:858`, `:919` before
  `:920`).
- D2.8 A retry's mere acceptance writes nothing - CONFORMS. `outcomeOf` maps
  `queued`/`queued_pending` to nothing (`twilio.ts:3919-3927`); the retry job
  writes a slot only at its two unresolved arms.

### D3 - the results row, the promise and the hint

- D3.1 The route returns the newest attempt's `retry_due_at` / `retry_outcome`
  for a young 30003 row - CONFORMS. `app/src/routes/broadcasts.ts:235-244`,
  `:889`, `:896-898`.
- D3.2 The page judges liveness on the server clock, re-judged on a one-minute
  ticker - CONFORMS. `dashboard/src/routes/broadcasts/BroadcastResults.tsx:43`,
  `:151-178`; `DeliveryBadge.tsx` / `broadcastFormat.ts:188-202` ("will retry",
  "retry not confirmed", plain).
- D3.3 The hint rule - CONFORMS. `BroadcastResults.tsx:88-95`: a message row
  (`tsMsgId` or `latestAttempt`), failed, no live promise, not Not confirmed,
  not ended unresolved (plus the round-1 G3 clause: not pending-by-unreadable-row).

### D4 - share labels derive from recipients

- D4.1 The label table - CONFORMS. `dashboard/src/routes/broadcasts/broadcastFormat.ts:108-120`:
  Sent (delivered + sent + sending > 0), Sending (progress), Not confirmed
  (danger - plan deviation 4), Not sent (neutral only when all skipped).
- D4.2 Draft/Sending keep the stored label; `last_error` under Not sent only;
  tabs unchanged; "Failed" retires as a pill - CONFORMS. `broadcastFormat.ts:111`,
  `BroadcastResults.tsx:212-213`, `BroadcastsList.tsx` unchanged.
- D4.3 `retry_pending` an optional SUB-bucket of failed - CONFORMS.
  `broadcastsRepo.ts:147`, `:305-363` (absent unless supplied; never in the
  sum; the identity pin kept). `unconfirmedKeys` (`:341`) moves a
  row-said-unresolved slot to `unconfirmed` on the routes only (finalize and the
  persisted counters call it without options).
- D4.4 The results and list routes compute the true count - CONFORMS.
  `broadcasts.ts:251-256`, `:889-890`, `:944-946`.
- D4.5 The rollup emits a lower bound; every other emitter leaves it unset -
  CONFORMS. Original rows `twilio.ts:4112-4117`; retry rows
  `shareAttemptOutcome.ts:205-210`; the reconcile maps an adopted failure with
  no promise (`sendReconcile.ts:1475-1488`); the withdrawal re-emit is unset
  (`twilio.ts:3703-3718`, plan deviation 13).
- D4.6 The page merge and the finished-share stats refetch - CONFORMS. List:
  `dashboard/src/routes/broadcasts/useBroadcastsList.ts:208-233` (kept count;
  refetch only for a stored `sent`/`failed` share with a positive kept count;
  a count-carrying event cancels); `getBroadcastStats` via `?view=stats`
  (`:173`). Results: `useBroadcastResults.ts:190-215`.
- D4.7 The chips - CONFORMS. `StatChips.tsx:45-46` (Failed minus Retrying,
  clamped; Retrying in the progress tone).

### D5 - "Sent to N tenants" at read time

- D5.1 The property Activity entry - CONFORMS. `app/src/routes/units.ts:1266-1294`
  (one projected batch read; N = `reachedCount`, the strict reading);
  `dashboard/src/routes/listing/listingFormat.ts:136` ("No tenants reached";
  the link kept).
- D5.2 The landlord timeline, after the merge and slice - CONFORMS.
  `app/src/routes/contactTimeline.ts:1452-1484`, `sentToLabel` `:695-697`.
- D5.3 A missing share keeps the stored count and words - CONFORMS
  (`units.ts:1292`, `contactTimeline.ts:1475`). R1 G6's cosmetic edge (a
  missing share whose stored count is 0 reads "No tenants reached" on the
  property card) stands accepted.

### D6 - the milestone follows the ledger

- D6.1 The milestone records its share id - CONFORMS.
  `app/src/jobs/broadcastFanOut.ts:1246`; `activityEventsRepo.ts:85`, `:99`,
  `:147`.
- D6.2 The words from THAT share's entry, a pending entry judged from its
  attempt's row within D1's bound - CONFORMS to D6 verbatim.
  `contactTimeline.ts:713-742`: counted -> "Property sent", unconfirmed -> "...
  - not confirmed", failed -> "Property text failed", pending -> the row read
  (unresolved -> not confirmed; live -> "Property sent"; lapsed, missing,
  unreadable or past the bound -> failed). The ledger holds no promise.
- D6.3 A pre-branch milestone reads the pair; a pair with no row keeps its
  words - CONFORMS (`:720`, `:1391-1392`). Precision (item 7): a milestone that
  CARRIES a share id whose entry is absent from an existing row also reads the
  pair - D6 defines the pair rule only for milestones without a share id.
- D6.4 One batched ledger read per page - CONFORMS (`:1385-1389`; unit-less
  milestones, `refType` broadcast, are never re-worded - the non-goal).

### D7 - the ledger follows the rule

- D7.1 Per-share memory, `counted`, `sentAt`/`broadcastId` of the latest
  counted share, `sentAt` REMOVED when nothing counts - CONFORMS.
  `app/src/services/shareLedger.ts:112-120`; `listingSendsRepo.ts:210-270`
  (`:246` removes). No due instant on an entry (I5).
- D7.2 The readers and the sparse index - CONFORMS. `listingSendsRepo.ts:156-158`
  (`counted !== false` AND `sentAt`, handback deviation 3), `:318`, `:332`;
  the tour form's default is the first listed row
  (`dashboard/src/routes/contact/ContactDetail.tsx:1162`); `tables.ts:423-424`
  + `README.md:45` record the contract.
- D7.3 The order rule, create-on-first-write, legacy seeding - CONFORMS.
  `shareLedger.ts:68-90` (newer applies; same attempt forward only - counted
  by acceptance -> delivery | pending | failed, pending -> failed; older only
  as a delivery; delivery-counted terminal; `!legacy` / `individual` seed).
- D7.4 The writers - CONFORMS. The pass and the share adoption
  (`broadcastFanOut.ts:837`, `:1260-1270`, `:1496`); the original row's
  rollup for delivered and failed (`twilio.ts:3576-3579`,
  `shareAttemptOutcome.ts:297-302`); the D2 callers (`shareAttemptOutcome.ts:147-158`,
  `:188-204`); the repair.
- D7.5 A conditional read-modify-write, bounded re-read, ERROR on exhaustion -
  CONFORMS (`shareLedger.ts:178-195`; the token is `shares_op`, plan deviation 8).
- D7.6 The share's unresolved close of an ORIGINAL writes nothing - CONFORMS
  (the `broadcast` arm of `closeSlot`, `sendReconcile.ts:1411-1415`).
- D7.7 The pair's contact - CONFORMS. `pairContactId`
  (`shareAttemptOutcome.ts:161-163`; plan deviation 6).

### D8 - the repair

- D8.1 The script's shape - CONFORMS. `app/scripts/repair-share-outcomes.ts`:
  the stage resolver with the account guard first (`:857-863`, `:888-895`),
  `--env`/`--lane`/`--broadcast`/`--apply` (`:866-868`), dry run by default,
  every write conditional (`:62-64`), ids and counts only.
- D8.2 Step 1, the walk - CONFORMS with plan deviation 1 (one consistent Scan,
  `:454-484`); the chain by lineage (`:492-537`).
- D8.3 Step 2, stamps missing OR wrong - CONFORMS (`:698-718`;
  `messagesRepo.ts:3442-3466`).
- D8.4 Step 3, the slot transition incl. the retry-record read - CONFORMS
  (`:584-616`: the delivered exception, the row's own `retry_outcome`, the
  `done/unresolved` record, the stale `reconciling` record; `:732-775` under
  D2's rule through `applyLaterAttemptBounded`).
- D8.5 Step 4, the ledger from the slot - CONFORMS with handback deviation 6
  (`:777-826`): it also CREATES un-counted rows for un-reached pairs (R1 G1,
  accepted); the entry order rule keeps anything written after the census.
- D8.6 The report and "left as they are" - PARTIAL. `originalMissing` and
  `brokenLineage` are reported and left alone, slot and ledger
  (`:692-696`). A pre-RSW retry whose lineage was never written is neither
  reported (declared, handback deviation 11) NOR left alone on the ledger side
  (undeclared): its slot (the original's 30003 failure, empty chain) is judged
  without it and unchanged, but step 4 then writes the `failed` entry the slot
  implies (`:783-816`), which replaces a legacy row's seeded counted entry
  (`shareLedger.ts:72-74`, `:81-82`) - the pair is UN-COUNTED (it leaves
  "Properties sent", the tour default moves) and a pre-branch milestone reads
  "Property text failed" (`contactTimeline.ts:720`), even when the unseen retry
  delivered. The spec: "those slots and rows are left as they are". Item 2.
- D8.7 The RUNBOOK and the binding order - CONFORMS. `RUNBOOK.md:368-402`:
  "NOT YET RUN", the order deploy -> census -> `--apply` -> next blast stated
  as BINDING (`:372`) with the exposure (the flag's error flips from over- to
  under-flagging), dev then prod, the re-run triggers with a Logs Insights
  query, exit codes, "no agent runs it against dev or prod". Every log string
  it names exists (`shareAttemptOutcome.ts:262`, `:285`; `shareLedger.ts:192`;
  `twilio.ts:3582`, `:3952`; `broadcastFanOut.ts:1272`; `guardWrite.ts:26`
  with `label: shareSlotUnconfirmed`).

### D9 - issues

- D9 - CONFORMS. RESOLVED blocks at line 14 of
  `broadcast-30003-retry-never-updates-slot.md`,
  `unconfirmed-share-invites-resend.md`,
  `tenant-timeline-property-sent-milestone-after-failed-delivery.md`; the
  sweeper amendment `send-attempt-sweeper.md:566`; seven residuals filed
  (`share-retry-late-send-flag-window`, `share-results-promise-refresh-not-emitted`,
  `share-list-sse-patch-rebucket-and-refresh`, `share-slot-two-child-fork-reads-failed`,
  `share-route-failed-pass-unclaimed-read-stranded`,
  `share-retry-rollup-lost-past-reread-bound`,
  `share-unitless-pre1b-chain-unattributed`), each `status: open`, severity
  low, with refs. The plan T15's four named residuals are all among them.

## B. Invariants

- I1 - CONFORMS (one service, `resolveRecipientStates`; the flag safe, the
  labels/counts/ledger strict; no stored-status verdict). The milestone takes
  D6's words (item 1).
- I2 - CONFORMS. Slot: `allowed` refuses `delivered` (`shareAttemptOutcome.ts:124`);
  the pre-existing original rollup too. Ledger: a delivery-counted entry is
  terminal (`shareLedger.ts:80`).
- I3 - CONFORMS. A failed slot moves only for a newer attempt or an older
  delivery (`shareAttemptOutcome.ts:126-128`), under a condition naming the
  attempt read, a lost condition re-applied; skipped never moves; nothing
  writes `queued`.
- I4 - CONFORMS. Every slot write the branch adds goes through
  `applyAttemptOutcome` (the only added slot writer in the diff; the webhook,
  the reconcile, the job arms and the repair all reach it through
  `applyLaterAttempt`); the original row's two-write rollup is untouched
  (SOR's residue).
- I5 - CONFORMS. No added line writes `retry_due_at` / `retry_outcome` to a slot
  or a ledger entry: `nextSlot` carries no promise (`shareAttemptOutcome.ts:110-113`),
  `ShareLedgerEntry` has no due field (`listingSendsRepo.ts:49-59`), the promise
  only picks `pending` and the emit's lower bound; the routes pass the row's
  own values through per request.
- I6 - CONFORMS. Only `counted` entries count (`shareLedger.ts:93-95`,
  `:112-120`).
- I7 - CONFORMS. The fence diff is empty (below); `retrySend.ts` is insert-only;
  the reconcile's record, claim and close calls are unchanged - the new calls
  are bounded or guarded and never throw.
- I8 - CONFORMS. No infra, no dependency, no `.env` in the diff; the repair is
  operator-run only (RUNBOOK).
- I9 - CONFORMS. Slot statuses unchanged (`broadcastsRepo.ts:161`), share
  statuses unchanged, no table or GSI; `sparse: true` is a pre-existing
  `TableSpec` field used as a contract note (`tables.ts:52`, `:424`).

## C. Section 0 and section 5

- S0.1 1b's four interface facts - CONFORMS (verified by the plan's first task,
  `research-1b-as-built-findings.md`; spot-checked here: `resolveRetryRoot`
  and the one-hop `broadcast_id` in `retrySend.ts`, `isBroadcastRowFor` 1b's
  own at `broadcastFanOut.ts:1324`).
- S0.2 The fence opened; miss levels - CONFORMS. An original's miss stays WARN in
  ASCII (`twilio.ts:4035`); a retry row's miss is ERROR (`:3952`, `:3964`,
  `sendReconcile.ts:1511-1516`, `:1537-1542`, `retrySend.ts:834-836`).
- S5.1 Slot writers - CONFORMS (fan-out arms and the reconcile's share closes
  unchanged; rollup, adoption, four sites, repair as above).
- S5.2 Slot readers - CONFORMS (composer flag through the service with the
  harness double mirroring reads; results route/row; derived stats with
  `retry_pending`; the SSE payload; `?view=stats`; finalize unchanged; both
  "Sent to N" surfaces; the harness double `twilioWebhookHarness.ts`).
- S5.3 The promise/chain end read through the pointer within the bound
  (results and preview) - CONFORMS.
- S5.4 Retry rows read by the rollup and the repair - CONFORMS.
- S5.5 Ledger readers (tenant API/card `contacts.ts:1168`, property API/card
  `units.ts:954`, the tour default, the milestone words, the seed history
  guard `lib/seed/history.ts:1004`, the repair) - CONFORMS.
- S5.6 The ledger double mirrors the sparse readers and the memory, with a
  parity suite (`twilioWebhookHarnessRepoAdditions.integration.test.ts`) -
  CONFORMS.
- S5.7 The milestone: writer timing unchanged, share id carried, words
  composed app-side - CONFORMS.
- S5.8 D5/D6 batch reads (`getByIds`, `getByKeys`) and their doubles - CONFORMS.
- S5.9 The `broadcast_sent` audit row unchanged - CONFORMS.
- S5.10 Seeds unchanged (the history generator skips an un-counted row) - CONFORMS.
- S5.11 Dashboard copy (pills, `Retrying`, the hint without the glyph, the two
  "Sent to N" labels, the milestone words) - CONFORMS.

## D. Section 7

Hermetic (all CONFORMS):
- D1 state table incl. the lapse on a fake clock, withdrawn, unresolved, the old
  slot without a read, the failed read, the in-flight rule -
  `app/test/shareRecipientState.test.ts:55-240`.
- D2 through all three callers (every refusal, every move incl. an older
  delivery, the slot-first order, a later adoption superseding, a lost
  condition, the row-less ordering) - `shareAttemptOutcome.test.ts`,
  `twilioStatusWebhook.test.ts` (share rollup block), `sendReconcile.test.ts`,
  `retrySendAttempt.test.ts`, `broadcastsRepoAttemptOutcome.integration.test.ts`.
- D3 promise read and hint per failed-row kind - `broadcastApi.test.ts`,
  `BroadcastResults.test.tsx`, `DeliveryBadge.test.tsx`, `broadcastFormat.test.ts`.
- D4 label table, chip balance, the rollup's count on the emit, both hooks'
  merge - `broadcastFormat.test.ts`, `StatChips.test.tsx`,
  `twilioStatusWebhook.test.ts`, `BroadcastsList.test.tsx`,
  `useBroadcastResults.test.tsx`.
- D7 both orders, across attempts, older delivery, delivery-terminal (`shareLedger.test.ts:58`),
  legacy seed, lost condition - `shareLedger.test.ts`, `broadcastFanOut.test.ts`.
- The sparse index and its return - `listingSendsRepoShares.integration.test.ts:77`.
- D5 with a missing share - `unitsApiActivity.test.ts`, `contactTimeline.test.ts`.
- D6 every state incl. live/refreshed/withdrawn/lapsed pending and a
  milestone without a share id - `contactTimeline.test.ts`.
- D8 dry run, idempotent apply, the account guard, an unstamped ancestor, a
  `done/unresolved` record - `repairShareOutcomes.test.ts:282`, `:294`, `:794`,
  `:307`, `:396`.

End to end (`e2e/tests/dashboard-next/share-sent-outcome.spec.ts`):
- (a) - PARTIAL. Delivered, Sent, flagged, listed: asserted (`:409-501`). "The
  results row reading 'will retry' in between" is read through the API
  (`:435-445`, `retryDueAt` equal to the row's own promise), the COPY pinned by
  `DeliveryBadge.test.tsx` and seen live in self-QA H1 - plan T14's choice
  (a ~10 s window), not among the plan's 16 declared deviations; R1 G4
  accepted it. Item 3.
- (b) - CONFORMS (`:503-619`: four failed texts re-armed, the OPEN list turns
  Not sent without a reload, Failed + plain 30003 + hint, not flagged, not
  listed, "Property text failed", no "will retry").
- (c) - CONFORMS (`:621-674`, incl. "No tenants reached" on the property card).
- (d) - CONFORMS (`:676-727`: Not confirmed, flagged, not listed, no alert).

Rewritten pins (all CONFORMS):
- `share-skip-fix.spec.ts` failed-stays-flagged -> NOT flagged after a final 30007.
- The `priorRecipientContactIds` repo and route tests: the repo cases went with
  the method (plan deviation 2); the route cases in `broadcastApi.test.ts`
  keep in-flight-in-a-sending-share, hold DRAFT as stranded, turn the FAILED
  share into record cases (`:1371-1391`), and flip "a failed one still
  does/is" to "a final failure does not" (`:1340-1369`).
- 1b's webhook skip pin -> the routed pin (`twilioStatusWebhook.test.ts`).
- The keyless failed-row hint pin -> no hint without a message row
  (`BroadcastResults.test.tsx`).
- SOR's all-unconfirmed "Failed" pill -> Not confirmed; its `last_error`
  alert -> absent; its 21211 hint -> absent (`send-outcome-reconcile.spec.ts`).
- "Sent to N tenants" label tests (`listingFormat.test.ts`,
  `contactTimeline.test.ts`, `unitsApiActivity.test.ts`).
- The label table's sent + skipped + failed -> Not sent, danger
  (`broadcastFormat.test.ts`).
- `broadcasts.spec.ts`'s "Already sent" kept (untouched in the diff).

Gates: claimed green at `6e449c22` (typecheck 0, npm test 0, smoke 0, e2e
304/304, eslint 0 over 72 files) - NOT re-run by this read-only review.

## E. Section 9 rulings

- Ruling 1, the stats-only QUERY FLAG on the existing route - CONFORMS.
  `broadcasts.ts:871-895` (`?view=stats` only, anything else 400
  `invalid_view`, no recipient list, no contact reads); the client's
  `getBroadcastStats` (`dashboard/src/api/endpoints.ts`); no new endpoint.
- Ruling 2, no relay to SOR - CONFORMS. `retrySend.ts` is insert-only; a post-1b
  retry of an unstamped pre-1b retry row still carries no `broadcast_id` and
  bypasses the share until the repair stamps it.
- The recipient cap to 1000 - CONFORMS (`broadcastsRepo.ts:75`, the budget
  comment rewritten).

## F. Deviations verdict

Plan's 16 (all PERMITTED):
1. One Scan for D8 - permitted: complete by construction (pre-backfill shares
   included); the cost is named in the RUNBOOK.
2. The flag's rule moves to the service; the repo method and harness mirror
   deleted - permitted: section 5's "the double must mirror" is met by the
   double serving the reads the one rule runs on.
3. `<retried>~` and `!legacy` - permitted (the implementation of D2/D7's order).
4. Not confirmed in the danger tone - permitted (the spec names the label only).
5. `conversationId` on an entry - permitted (D6 needs it to read the row).
6. The original rollup's pair contact from `recipient_contact_id`, none -> INFO
   - permitted (D7's "the contact that held the number at send time").
7. `retry_pending` as a lower bound, the merge, the `?view=stats` refetch, the
   results ticker recount - permitted (D4 and ruling 1).
8. `shares_op` as the change token instead of `updated_at` - permitted (same
   conditional semantics; a random token cannot collide).
9. `countedAt` = the attempt's provider instant - permitted; "the instant the
   entry last counted" is read as the counted attempt's instant, so a delivery
   never moves `sentAt`.
10. `recordSend` retired - permitted (D7 requires conditional writers).
11. The reconcile sites bounded, WITHDRAW first - permitted by the spec's own
   section 8 amendment (plan review round 2).
12. Record reads only for the flag - permitted (no other surface tells in
   flight from stranded).
13. The withdrawal re-emit with the count unset - permitted (D4's "every other
   emitter leaves it unset").
14. `retryPending` per recipient; the page recounts only on its ticker -
   permitted.
15. The already-applied replay check - permitted (idempotence; the ledger skip
   for a promise-less replayed 30003 prevents a downgrade).
16. The record bound from `updated_at` - permitted by the section 8 amendment.

Handback's 11:
1. A re-applied row-less marker answers `applied` with no write - permitted
   (deviation 15's rule).
2. The withdrawal emit only after a successful WITHDRAW - permitted (a failed
   WITHDRAW leaves the promise live, which the count still reflects).
3. `isListed` = counted and `sentAt` - permitted (stricter; equal on every real row).
4. The withdrawn sentinel on the wire - permitted (I5; never live).
5. The tick override in the hook; the rows-behind guard - permitted.
6. The repair creates un-counted rows for un-reached pairs - a DEPARTURE from
   D8 step 4's letter ("for a reached recipient"), accepted in round 1 (G1).
   Its behavior change: those pairs' milestones re-word from the stored
   "Property sent" to the ledger's words after the apply. That is D6 applied,
   and the live writers create such rows too (D7's create-on-first-write), so
   it is consistent with the spec's intent; the RUNBOOK names it (`rowsToCreate`).
7. No `latestAttempt` on the original's own key - permitted (the type's contract).
8. The repair's per-slot failure handling, systemic abort, honest `slotsMoved`,
   a `sent` row carrier-confirmed at its own instant - permitted (the spec is
   silent; operational robustness).
9. A consistent read in both results views - permitted.
10. The gate fixture flip - permitted (a row shape no real row has).
11. `noContact` / `noRecipientKey` judged and moved; a lineage-less pre-RSW
   retry counted nowhere - the REPORT half is a declared departure (accepted
   R1 G5); the LEDGER half is undeclared and changes behavior the spec
   promised ("rows ... left as they are") - item 2.

## G. Handback claims verified by reading

- Fence: `git diff --stat 3f38bcc2 e824a452 -- app/src/jobs/jobs.ts
  app/src/adapters/sqsJobConsumer.ts app/src/services/oneToOneRetryDecision.ts
  app/src/jobs/registerHandlers.ts app/src/services/retryPromiseWrites.ts
  app/src/services/retryChain.ts app/src/repos/sendAttemptsRepo.ts` prints
  nothing (all seven files exist). `retrySend.ts`: 0 removed lines, four
  insertions (imports, two deps, `markShareUnconfirmed`, two call sites).
- ASCII: `git diff 3f38bcc2 e824a452 | grep '^+' | LC_ALL=C tr -d
  '\11\12\15\40-\176' | wc -c` prints 0 (and 0 through `a33e0d7f`).
- No infrastructure: no diff under `infra/`, `package.json`,
  `package-lock.json`, `app/package.json` or any `.env*`.
- Drift: main = merge base = `3f38bcc2`; 0 behind. The commits after
  `e824a452` touch records only.
- Issues: the three RESOLVED blocks and the sweeper amendment are present; the
  seven filed issues exist and are open. The three closed issues' frontmatter
  already reads `status: resolved` / `resolved: 2026-09-28` on the branch
  (item 5).
- RUNBOOK: the repair section and its binding order are present
  (`RUNBOOK.md:368-402`).

## H. For the planner to adjudicate

1. **D1/D6 wording conflict (Cameron's call; not a build defect).** The code
   follows D6: a live `pending` entry reads "Property sent"
   (`contactTimeline.ts:728-741`). D6 shipped exactly as gated (identical text
   at `0bb4042d` and HEAD); D1's "the STRICT reading (..., the milestone)" was
   also in the gated text. Visible consequence during a retry's backoff: the
   tenant's file shows the milestone "Property sent" while "Properties sent"
   omits the pair (D7). Recommendation: confirm D6 and correct D1's
   parenthetical as a spec erratum (no code change); if D1 was meant, the
   `pending` arm of `propertySentWords` and its tests change. NOTE: while this
   review ran, an UNCOMMITTED edit appeared in the worktree's spec (not this
   reviewer's) rewording D1's STRICT sentence to drop "the milestone" and
   defer to D6 - this review was made against the committed spec; if that
   edit is committed, item 1 reduces to Cameron's confirmation.
2. **D8.6 - the lineage-less pre-RSW retry's ledger row is not left alone.**
   Beyond "not reported" (declared), the apply writes the slot's `failed` entry
   over a legacy row's seeded counted entry for that share
   (`repair-share-outcomes.ts:783-816`, `shareLedger.ts:72-82`): the pair leaves
   "Properties sent", the tour default moves, and a pre-branch milestone reads
   "Property text failed" (`contactTimeline.ts:720`) - even when the unseen
   retry delivered. Spec D8: such "slots and rows are left as they are". The
   class is narrow (a lost pre-RSW `retry_of` annotate). Decide: accept and
   name the ledger/milestone consequence in RUNBOOK step 1 and the handback
   residuals (today they name only the under-flag), or file it.
3. **E2E (a)'s "will retry" row copy** is asserted via the API plus unit tests
   and self-QA H1, not end to end - a narrowing of section 7 (a) chosen in plan
   T14's body but absent from the plan's 16 declared deviations. R1 G4
   accepted it; confirm, and list it among the declared deviations in the
   records if kept.
4. **Handback deviation 6 (G1), confirm-only.** The repair's un-counted rows
   re-word existing milestones of un-reached pairs after the apply (D6 applied
   to rows D8 step 4 did not ask for). Consistent with D6/D7 and the live
   writers; already accepted in round 1 - confirm the re-wording is intended.
5. **Handback wording (records).** "The human resolves the three closed issues
   at merge (... status stays open until merged)" - the branch already sets
   `status: resolved` and `resolved: 2026-09-28` in all three files; the merge
   itself carries the flip and no human edit is needed. Correct the sentence or
   accept.
6. **Spec erratum (text only).** D7's writer bullet "failed 30003 with a live
   promise -> `pending` with its due" contradicts D7's first bullet and I5 ("no
   copy of the promise"); the code follows I5 (an entry has no due field).
7. **D6 precision (minor, undeclared).** A milestone that carries a share id
   whose entry is absent from an EXISTING row reads the pair-level flag
   (`contactTimeline.ts:719-720`); D6 defines the pair rule only for a
   milestone without a share id. Reachable when the pass's entry write was
   dropped but another share of the pair wrote the row. Accept or declare.
8. **The five gates** are the handback's claim (green at `6e449c22`); this
   review ran nothing. Take them from the orchestrator's record or the gate run
   now in progress.
