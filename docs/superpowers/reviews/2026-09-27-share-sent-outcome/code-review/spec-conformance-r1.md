# Share sent outcome (Branch B) - spec conformance review, round 1

Reviewer: the spec-conformance reviewer (read and reason only: git, grep and
file reads; no test, lane, build or gate was run). Date 2026-09-28. Tree:
`feat/share-sent-outcome` @ 7386968d in `W:\tmp\share-sent-outcome`, base main
@ 3f38bcc2. Read: the mission block (a8a75e8e), the spec (v5 plus the
2026-09-28 restatement and its section 8 amendments), the plan (revision 5,
95d18c4d), the diff package `.superpowers/review/share-sent-outcome-diff.txt`,
the five slice reports under `build/`, and the two research maps. Every
`file:line` is at HEAD unless it says "base"; every verdict was checked in the
tree, never taken from a report.

**CONFORMS 88 / PARTIAL 1 / MISSING 0** over the 89 work-map sub-items of
T1-T14. T15's five sub-items (issue notes, live self-QA, drift report, the five
gates on a quiet tree, handback) are orchestrator-owned and pending. No
BLOCKING and no MAJOR finding. The one PARTIAL is MINOR (a RUNBOOK line); the
seven adjudication asks in section G are all MINOR.

## A. The work map, sub-item by sub-item

### T1 - order key, slot pointer, applyAttemptOutcome, getByIds, stats opts, cap

| # | Sub-item | Verdict | Evidence |
|---|---|---|---|
| 1 | attempt order key (row-less `~`, legacy `!legacy`) | CONFORMS | `app/src/lib/shareAttemptOrder.ts:11-13` (constants incl. `!individual`), `:15-25` (marker helpers), `:27-29` (plain code-unit compare), `:32-38` (instant from the key); import-free leaf; `app/test/shareAttemptOrder.test.ts` |
| 2 | the slot's `latestAttempt` pointer | CONFORMS | `app/src/repos/broadcastsRepo.ts:188` - the ONLY attribute `BroadcastRecipient` gains (see G2 for a repair-only precision drift on its absence rule) |
| 3 | `applyAttemptOutcome`: ONE conditional write naming the recorded attempt + status, carrying the delta | CONFORMS | interface `broadcastsRepo.ts:509-515`, `AttemptOutcomeExpect` `:569`; impl `:951-989` (condition `:978` names status AND `latestAttempt` - `attribute_not_exists` when undefined; ADD only for non-zero buckets; ConditionalCheckFailed -> `applied: false`); double `app/test/helpers/twilioWebhookHarness.ts:3375`; parity `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts:864`; repo test `app/test/broadcastsRepoAttemptOutcome.integration.test.ts` |
| 4 | `getByIds` (projected BatchGet) | CONFORMS | `broadcastsRepo.ts:523`, `:991-1014` (chunks of 100, one retry of unprocessed keys, then WARN + absent; `stats` projection aliases `#s`); double `twilioWebhookHarness.ts:3394` mirrors the projection; parity `:889` |
| 5 | `deriveBroadcastStats` opts (`retry_pending`, `unconfirmedKeys`); the identity pin holds | CONFORMS | `broadcastsRepo.ts:305-363` (`:311-312` returns `b.stats` ITSELF with no opts, `:341` `unconfirmedKeys`, `:362` count only when supplied); pin `app/test/deriveBroadcastStats.test.ts:22-27` intact; new cases at the file's end |
| 6 | cap 1500 -> 1000 | CONFORMS | `broadcastsRepo.ts:75`; budget comment rewritten in ASCII for six attributes `:57-74` |

### T2 - the recipient state service (`app/src/services/shareRecipientState.ts`)

| # | Sub-item | Verdict | Evidence |
|---|---|---|---|
| 1 | D1's state table | CONFORMS | `:65-89` - skipped; delivered/sent reached; queued in a sending share in flight; queued in a finished share by the record fact; failed `send_unconfirmed` unconfirmed; failed 30003 by the row (unconfirmed / pending / failed; unreadable -> pending; no fact -> failed); any other failure failed |
| 2 | the two readings | CONFORMS | `:92-98` (SAFE reached, pending, unconfirmed, in flight; STRICT reached) |
| 3 | the 24-minute row bound | CONFORMS | `:39-40` derived from `RETRY_SEND_WINDOW_MS` + the last reconcile delay + 2 x grace + 60 s; `needsRowRead` `:105-110` measures from the newest attempt key's own instant; pinned `app/test/shareRecipientState.test.ts:106` |
| 4 | the 30-day record bound from `updated_at` | CONFORMS | `:42`, `needsRecordRead` `:118-122` (`updated_at ?? created_at`, deviation 16) |
| 5 | the record fact's meanings | CONFORMS | `:52-57`, `:74-77`, `:184-199` (absent = not asked -> in flight; null -> stranded; `expired` -> stranded without a read; `unreadable` -> in flight + WARN with the key redacted `:194`) |
| 6 | `mapLimit` 8 | CONFORMS | `:131-146`; pinned `shareRecipientState.test.ts:191` |
| 7 | `priorRecipientKeys` | CONFORMS | `:243-263` (every page of `listByUnit`, `recordReads: true`, never throws, WARN + what it has) |

### T3 - the ledger's per-share memory

| # | Sub-item | Verdict | Evidence |
|---|---|---|---|
| 1 | `shares` memory | CONFORMS | `app/src/repos/listingSendsRepo.ts:46-69` (state, entry with `conversationId`, write shape), `:92` |
| 2 | `counted` | CONFORMS | `listingSendsRepo.ts:90`; `app/src/services/shareLedger.ts:113-121` (true exactly while a counted entry with an instant exists) |
| 3 | `shares_op` change token | CONFORMS | `listingSendsRepo.ts:94`, `:219`, `:229` (fresh `randomUUID`), `:254-257` (`attribute_not_exists` when no token expected, else `= :tok`) |
| 4 | sparse `byContact` by ABSENCE | CONFORMS | `app/src/lib/tables.ts:422-424`; `README.md:45`; `sentAt` REMOVED when nothing counts (`listingSendsRepo.ts:241-253`); readers `isListed` `:156-158`, `:318`, `:332`; pin `app/test/tables.test.ts:96` |
| 5 | `sentAt` optional | CONFORMS | `listingSendsRepo.ts:81`; `toListingSendRow` guard `:172-175`; seed guard `app/src/lib/seed/history.ts:1004` |
| 6 | `putShareMemory` | CONFORMS | `listingSendsRepo.ts:210-279`; double `twilioWebhookHarness.ts:3125`; parity cases `twilioWebhookHarnessRepoAdditions.integration.test.ts:1000`, `:1013` |
| 7 | `getByKeys` | CONFORMS | `listingSendsRepo.ts:281-305`; double `twilioWebhookHarness.ts:3146` |
| 8 | `applyShareLedgerEntry` with the attempt-instant clock | CONFORMS | `shareLedger.ts:50-66` (`countedAt` = the attempt key's instant), `:69-76` (legacy seeding), `:79-91` (order rule, delivery terminal), `:178-195` (1 + 3 re-reads, then ONE ERROR, `lost`) |
| 9 | `ledgerEntryForSlot` | CONFORMS | `shareLedger.ts:156-170` |
| 10 | `recordSend` deprecated (then retired in T7) | CONFORMS | no `recordSend` left in `app/`, `dashboard/` or `e2e/` source (grep) |

### T4 - `applyLaterAttempt` (`app/src/services/shareAttemptOutcome.ts`)

| # | Sub-item | Verdict | Evidence |
|---|---|---|---|
| 1 | from `failed` or `sent` only | CONFORMS | `:119` |
| 2 | a newer attempt applies (status, code, carrier instant, pointer) | CONFORMS | `:121`; `nextSlot` `:92-110` - the carrier instant comes from the outcome and is never inherited by a newer attempt (`:99`) |
| 3 | the same attempt only forward | CONFORMS | `:123-125` (from `sent`: to delivered, to failed, or sent gaining its instant; `failed` terminal) |
| 4 | an older attempt only as a delivery | CONFORMS | `:122`; the pointer records the delivered attempt (`:96`) |
| 5 | the lost-condition re-read | CONFORMS | loop `:216`, refused write `:242-247`, bound `MAX_REAPPLY` `:78`, ONE WARN `:256` |
| 6 | the already-applied check at the TOP of the loop and after a refusal | CONFORMS | `:226-234`, `:242-250` (deviation 15) |
| 7 | `sideEffects` | CONFORMS | `:183-205` - ledger through `writeLedger` `:161-180` (best-effort, ONE ERROR), the replayed-30003-without-promise skip `:193-196`, the emit with `retry_pending: 1` only for a failure with a live promise `:199-204` |
| 8 | `wouldApply` | CONFORMS | `:129-131` |
| 9 | `projectSlot` | CONFORMS | `:134-136` |
| 10 | `applyLaterAttemptBounded` | CONFORMS | `:268-282` (three tries, then ONE ERROR and `threw`, never propagated) |

### T5 - the status webhook (`app/src/routes/webhooks/twilio.ts`)

| # | Sub-item | Verdict | Evidence |
|---|---|---|---|
| 1 | the `retry_of` skip removed | CONFORMS | gate `:3558` (no `retry_of` clause); the old pin is rewritten (section D) |
| 2 | retry rows routed by `broadcast_id` + `retry_root` | CONFORMS | `:3560-3561`, `rollRetryIntoBroadcast` `:3935-3960` -> `applyLaterAttempt`, which matches `conversationId` + `tsMsgId === retryRoot`, never the key (`shareAttemptOutcome.ts:222`); missing `retry_root` ONE ERROR `:3946`; no slot ONE ERROR `:3958` |
| 3 | the promise from `oneToOneRetry.runAt`, never the pre-write image | CONFORMS | `:3488` is the mission block's expression verbatim; copy-read pins for both paths in `app/test/twilioStatusWebhook.test.ts` (the `share rollup` describe at `:380`) |
| 4 | the original row's ledger entry | CONFORMS | `:3563-3579` (`rollIntoBroadcast` returns `{ item, contactKey }` `:4065`, `:4113`; `originalRowLedgerWrite` for delivered/failed only; `shareAttemptOutcome.ts:291-296`) |
| 5 | `retry_pending` 1 on the 30003 emit | CONFORMS | original path `:4106-4111`; retry path `shareAttemptOutcome.ts:199-204` |
| 6 | the withdrawal emit with the count UNSET | CONFORMS | `:3676-3717` (no-opts `deriveBroadcastStats` `:3709`; original path uses `rolled.item`, a retry row re-reads the share); narrowed to a successful WITHDRAW (section C, deviation 13) |
| 7 | the give-up line ASCII (WARN) | CONFORMS | `:4029` |
| 8 | the harness `webhooks` block gets the ledger repo | CONFORMS | `twilioWebhookHarness.ts:5190-5191` |

### T6 - the five 1b sites

| # | Sub-item | Verdict | Evidence |
|---|---|---|---|
| 1 | adoption hook BEFORE `closeFromReconcile(adopted)`, bounded | CONFORMS | `app/src/jobs/sendReconcile.ts:580` precedes `:582`; `adoptedShareRetry` `:1484-1507` through `applyLaterAttemptBounded`; `mapAdopted` `:1463-1475` |
| 2 | the unresolved arm AFTER the WITHDRAW, bounded | CONFORMS | WITHDRAW `:1435` (its throw on failed/lost unchanged), then `:1446`; `unresolvedShareRetry` `:1515-1531`; also serves the superseded exit's re-apply through `closeSlot` |
| 3 | the job's two arms slot-FIRST through `guardWrite` | CONFORMS | `app/src/jobs/retrySend.ts:811-838` (`markShareUnconfirmed`, guard label `shareSlotUnconfirmed` `:817`); hand-off catch `:855` before `:857`; second unknown `:919` before `:920` |
| 4 | `no_slot` at ERROR | CONFORMS | `sendReconcile.ts:1500-1505`, `:1524-1529`; `retrySend.ts:835-837`; webhook `twilio.ts:3958` |
| 5 | `Found` widened | CONFORMS | `sendReconcile.ts:414-423`; `adoptRetry` `:991-1004` (row key, code, `date_sent` as the carrier instant, send-time contact); `ownRetryRow` `:1180-1190` |
| 6 | `wire()` gets both repos | CONFORMS | `app/test/retrySendAttempt.test.ts:116-117` |
| 7 | `registerHandlers` UNTOUCHED | CONFORMS | empty `git diff --stat 3f38bcc2 HEAD -- app/src/jobs/registerHandlers.ts`; lazy repos `retrySend.ts:337-338`, `:819-820`; `sendReconcile.ts:453` |

### T7 - the pass and the adoption write an ENTRY

| # | Sub-item | Verdict | Evidence |
|---|---|---|---|
| 1 | `recordPropertySent` writes a ledger ENTRY (pass and adoption) | CONFORMS | `app/src/jobs/broadcastFanOut.ts:1222-1276` (`applyShareLedgerEntry` `:1260-1268`, swallow line `:1272`); the pass's attempt `:837`, `:956`; the adoption `:1491-1497` (delivered -> by delivery, else by acceptance) |
| 2 | the milestone carries `broadcastId` | CONFORMS | `broadcastFanOut.ts:1246`; `app/src/repos/activityEventsRepo.ts:85`, `:99`, `:147`; the activity double stores it |
| 3 | `recordSend` DELETED | CONFORMS | interface, impl and double gone; grep empty |
| 4 | its tests re-seeded | CONFORMS | `app/test/helpers/listingSendSeed.ts:14-44` (`!legacy` / `!individual`, `countedAt = sentAt`); `app/test/listingSendsRepo.integration.test.ts:60`, `:77`; `app/test/contactsBatchReads.test.ts:152`; `app/test/listingSendsApi.test.ts` |

### T8 - the composer flag

| # | Sub-item | Verdict | Evidence |
|---|---|---|---|
| 1 | the flag via `priorRecipientKeys` | CONFORMS | `app/src/routes/broadcasts.ts:602`; deps `:90`, `:95`, defaults `:393-394`; `app/src/routes/api.ts` forwards both repos to the broadcasts router |
| 2 | record reads here ONLY | CONFORMS | results `broadcasts.ts:884` and list `:940` resolve without `recordReads`; zero-call pin `app/test/broadcastApi.test.ts:1548` |
| 3 | the repo method and its harness mirror DELETED | CONFORMS | no `priorRecipientContactIds` left except the wire field (`broadcasts.ts:648`) and its dashboard reader (`RecipientPreview.tsx:105-106`); the double's `listByUnit` comment `twilioWebhookHarness.ts:3439-3441` |
| 4 | the pins rewritten | CONFORMS | section D |

### T9 - results and list routes (`app/src/routes/broadcasts.ts`)

| # | Sub-item | Verdict | Evidence |
|---|---|---|---|
| 1 | per-recipient `retryDueAt` / `retryOutcome` / `latestAttempt` / `retryPending` | CONFORMS | `EnrichedRecipient` + `promiseFields` `:225-243` (`retryPending: true` for a pending state, deviation 14) |
| 2 | the true `retry_pending` and `unconfirmedKeys` on results | CONFORMS | `statsWithStates` `:251-256`, results `:884-893` |
| 3 | `?view=stats` | CONFORMS | `:868-894` (400 `invalid_view` `:871-874`; `toBroadcastStatsView` `:365-367`; no contact reads) |
| 4 | the list carries `retry_pending` + `unconfirmedKeys` | CONFORMS | `:932-944` (rows in sequence, reads stay 8 in flight) |
| 5 | no record reads on results / list / stats | CONFORMS | as T8.2 |

### T10 - the dashboard

| # | Sub-item | Verdict | Evidence |
|---|---|---|---|
| 1 | types | CONFORMS | `dashboard/src/api/types.ts:2993` (sub-bucket, out of the sum), `:3047-3063`, `BroadcastStatsView` `:3069-3075`, view fields `:3113-3120`; `getBroadcastStats` `dashboard/src/api/endpoints.ts:1892-1900` |
| 2 | `presentShareLabel` | CONFORMS | `dashboard/src/routes/broadcasts/broadcastFormat.ts:108-120` |
| 3 | `StatChips`: progress tone and the clamp | CONFORMS | `StatChips.tsx:38-48` (`Failed = max(0, failed - retry_pending)`, `Retrying` after it), `:57`; `StatChips.module.css:49-55` |
| 4 | `DeliveryBadge` props | CONFORMS | `DeliveryBadge.tsx:32-40`, `:43-63`; `shareRecipientReason` `broadcastFormat.ts:183-203` |
| 5 | the hint | CONFORMS | `BroadcastResults.tsx:90-96` (the plan's rule verbatim), ASCII copy `:117`; see G3 |
| 6 | the tick-only recount with the override rules | CONFORMS | `BroadcastResults.tsx:42-51`, `:154-182` (60 s, visibility-gated, server clock); `useBroadcastResults.ts:105`, `:135` (cleared by a fetch), `:175-176` (rows-behind mark; cleared by a count-carrying overlay), recount + `liveStats` `:206-220` |
| 7 | both hooks' merge | CONFORMS | `useBroadcastResults.ts:160-171`; `useBroadcastsList.ts:183-193` |
| 8 | the finished-share stats refetch | CONFORMS | `useBroadcastsList.ts:43`, `:138-181` (per-row 400 ms debounce, abort, unmount cleanup), trigger `:195-203` (unset count, kept count > 0, event status sent/failed) |

### T11 - D5 recount

| # | Sub-item | Verdict | Evidence |
|---|---|---|---|
| 1 | units activity recount, guarded | CONFORMS | `app/src/routes/units.ts:1266-1294` (one projected batch read; a missing share keeps its count; a failed read keeps every count, ONE ERROR, never a 500) |
| 2 | landlord relabel after the slice, guarded, landlord-only | CONFORMS | `app/src/routes/contactTimeline.ts:1452-1484` (after the merge and slice, `contact.type === 'landlord'`, ONE ERROR) |
| 3 | "No tenants reached" | CONFORMS | `contactTimeline.ts:695-697`; `dashboard/src/routes/listing/listingFormat.ts:136` |

### T12 - D6 milestone words

| # | Sub-item | Verdict | Evidence |
|---|---|---|---|
| 1 | words from the share's ledger entry | CONFORMS | `contactTimeline.ts:713-741`, applied `:1367-1400` (ONE `getByKeys` `:1388`) |
| 2 | a pending entry reads its attempt row within the bound | CONFORMS | `:728-739` |
| 3 | the pair rule (pre-branch pin, dropped entry), stored words without a row, ERROR on a failed read | CONFORMS | `:720`, `:1391-1392`, `:1396-1399` |

### T13 - the repair (`app/scripts/repair-share-outcomes.ts`)

| # | Sub-item | Verdict | Evidence |
|---|---|---|---|
| 1 | one broadcasts Scan | CONFORMS | `:330-361` (consistent, filtered `attribute_exists(#unit)`, paged; `--broadcast` one share) |
| 2 | the chain / break / decided-attempt definitions | CONFORMS (to the plan; see G5 for the spec) | chain `:369-414`; break `:410`; decided attempt `:450-482` (latest delivery first, else the newest row, then ONE next-attempt check: the row's `retry_outcome`, a `done/unresolved` record, a stale `reconciling` record `:435-440`) |
| 3 | stamps, missing OR wrong | CONFORMS | `:505-525`; `app/src/repos/messagesRepo.ts:1573`, `:3442-3466`; double `twilioWebhookHarness.ts:1527` |
| 4 | `wouldApply` gates "to move" | CONFORMS | `:485-490`, `:538-565` (the move itself through `applyLaterAttempt`) |
| 5 | the ledger follows the SLOT | CONFORMS | `:567-608` (projected slot on a census, re-read slot on an apply); see G1 |
| 6 | census forecasts | CONFORMS | `:573-586` through `ledgerWouldChange` (`shareLedger.ts:133-146`) |
| 7 | per-fixture rows | CONFORMS | `app/test/repairShareOutcomes.test.ts:71-82` (`ids(id)`: unit, contact, conversation and SIDs per fixture) |
| 8 | RUNBOOK | **PARTIAL - MINOR** | see below |

T13.8, the RUNBOOK. Asked (plan T13 step 4): the section beside the automation
switch, the census first, the report fields and what each means, then
`--apply`, dev then prod, re-runnable, the agent line. The tree: every part is
there (`RUNBOOK.md:368-396`), but `:385` says `unjudgeable.brokenLineage`
covers "a pre-RSW retry whose lineage was never written". The walk can count a
break only for a collected row whose `retry_root` names the original
(`repair-share-outcomes.ts:410`); a lineage-less pre-RSW retry has neither
`retry_of` nor `retry_root` (1b stamps `retry_root` only on rows it appends),
so the walk stops at it (`:397`) and no counter ever names it. An operator
reading the census would believe such slots were reported when they are
silently judged without that row. Severity MINOR (operator documentation; the
slot is left alone either way). Fix: drop or correct the parenthetical; name
the invisible class in the handback (G5).

### T14 - end to end

| # | Sub-item | Verdict | Evidence |
|---|---|---|---|
| 1 | the four scenarios | CONFORMS | `e2e/tests/dashboard-next/share-sent-outcome.spec.ts:409` (a), `:503` (b), `:621` (c), `:676` (d) |
| 2 | (a) the pending state through the API | CONFORMS | `:435-445` (polled after the stamp; `retryDueAt` equals the stored row's own promise); see G4 |
| 3 | (b) the list opened after the failure is stamped | CONFORMS | arm `:518`, stamp `:521`, re-arm `:525-526`, list `:532`, live flip without reload `:560-561` |
| 4 | helpers COPIED | CONFORMS | file-local helpers `:142-404`; imports are fixtures/support only (`:1-6`) |
| 5 | three pins rewritten | CONFORMS | `e2e/tests/dashboard-next/share-skip-fix.spec.ts:16-22`, `:250-287`; `e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts:465`, `:537`, `:538-540` |
| 6 | `selectors.md` | CONFORMS | `e2e/support/selectors.md:116` |

### T15 - orchestrator-owned, pending

Issue notes (the three closed issues and the sweeper addendum - `docs/issues/*`
is untouched in the branch diff), the live self-QA, the drift report, the five
gates on a quiet tree, and the handback: orchestrator-owned, pending.

## B. Spec decisions and invariants

| Item | Verdict | Enforced by / swept |
|---|---|---|
| D1 recipient state, two readings | holds | `shareRecipientState.ts:65-98` (table, readings), `:105-122` (bounds), `:155-214` (reads, safe sides); SAFE at the composer (`broadcasts.ts:602`), STRICT everywhere else (`broadcasts.ts:884`, `:940`; `reachedCount` `shareRecipientState.ts:233-236` for D5) |
| D2 one attempt-ordered transition | holds | rule `shareAttemptOutcome.ts:214-258`; write `broadcastsRepo.ts:951-989`; callers: receipt `twilio.ts:3561`, adoption before the close `sendReconcile.ts:580`, unresolved close after the WITHDRAW `:1446`, job arms first `retrySend.ts:855`, `:919`; row-less order `shareAttemptOrder.ts:15-17` |
| D3 results row, promise, hint | holds | promise facts from the newest attempt's row within the bound (`shareRecipientState.ts:164-183`, `broadcasts.ts:235-243`); server-clock judgement re-taken on a 60 s ticker (`BroadcastResults.tsx:154-182`, `DeliveryBadge.tsx:54-58`); hint `BroadcastResults.tsx:90-96`; precision note G3 |
| D4 labels, `retry_pending`, merges, stats-only read | holds | `broadcastFormat.ts:108-120`; sub-bucket `broadcastsRepo.ts:147`, `:362`; true count on results/list (`broadcasts.ts:251-256`); rollup lower bound (`twilio.ts:4106-4111`, `shareAttemptOutcome.ts:199-204`); every other emitter unset (fan-out, finalize, reconcile untouched; the withdrawal emit `twilio.ts:3709`); merges and refetch (T10.7-8); `last_error` under Not sent only (`BroadcastResults.tsx:214-217`) |
| D5 recount at read time | holds | T11; cosmetic note G6 |
| D6 milestone words from the ledger | holds | share id `broadcastFanOut.ts:1246`; words T12 |
| D7 ledger follows the rule | holds | memory and writer T3; writers: pass/adoption `broadcastFanOut.ts:1260-1268`, original-row rollup `twilio.ts:3574-3579`, later attempts `shareAttemptOutcome.ts:161-180`, repair `repair-share-outcomes.ts:592-599`; readers filter `listingSendsRepo.ts:156-158`; seed guard `history.ts:1004`; the share's own unresolved close of an ORIGINAL writes no entry (SOR's `closeRecipientIfQueued` untouched) |
| D8 the repair | holds, one reporting gap (MINOR) | T13; account guard before any read `repair-share-outcomes.ts:626-632` (test `repairShareOutcomes.test.ts:526`); dry run by default `:651`; exit codes `:639-690`. Gap: the spec's report names "a pre-RSW retry whose lineage was never written" among the rows it could not judge; that row is invisible to the walk and counted nowhere (G5, and the T13.8 PARTIAL) |
| D9 issues | orchestrator-owned, pending (T15) | `docs/issues/*.md` untouched in the diff |
| I1 no surface reads the stored status for reach | holds | Sweep: the stored status is read only to tell a running pass (`shareRecipientState.ts:73`) and, on the dashboard, to keep the Draft/Sending labels D4 keeps (`broadcastFormat.ts:112`). The composer flag has ONE source (`priorRecipientKeys`). Every other reach surface derives from slots (`deriveBroadcastStats`, `reachedCount`) or the filtered ledger (`app/src/routes/contacts.ts:1168`, `units.ts:954`, D6 `contactTimeline.ts:1388`). The remaining stored-status comparisons in `app/src` (`broadcastFanOut.ts:664` fence counter, `:1573` finalize's `last_error`) decide no reach and are unchanged |
| I2 a delivery is never erased | holds | D2 refuses from delivered (`shareAttemptOutcome.ts:119`); the original-row rollup still refuses a terminal slot (`twilio.ts:4034`); the repair moves only through `applyLaterAttempt` (`repair-share-outcomes.ts:548`); ledger delivery-terminal `shareLedger.ts:81` |
| I3 a failed slot moves only through a newer attempt or the repair | holds as D2 specifies | the condition names the recorded attempt (`broadcastsRepo.ts:970-978`); lost conditions re-apply (`shareAttemptOutcome.ts:242-247`); never to queued, skipped never moves. I3's "only a NEWER attempt" wording glosses D2's own older-DELIVERY carve-out, which the build implements (`:122`) |
| I4 every added slot write carries its delta in the same write | holds | Sweep of added lines for `setRecipient`, `recordRecipientOutcome`, `closeRecipientIfQueued`, `bumpStats`, `markFailed`, `finalizeStatus`, `markSending`: none; the only added slot write is `applyAttemptOutcome`, called once (`shareAttemptOutcome.ts:241`). The original-row rollup's two-write shape (`twilio.ts:4074-4100`) is unchanged, not widened |
| I5 one source of the promise and the chain end | holds | Sweep: every added read of `retry_due_at` / `retry_outcome` (and the `retryDueAt` / `retryOutcome` fields) is a read, a decision, a wire passthrough or an emit count (`shareRecipientState.ts:168-183`, `broadcasts.ts:235-243`, `contactTimeline.ts:733-736`, `shareAttemptOutcome.ts:151`, `:193`, `:199`, repair `:426`, `:460`, `:573`); the slot gains only `latestAttempt`; `ShareLedgerEntry` has no due field (`listingSendsRepo.ts:49-60`) |
| I6 the ledger counts no time-bound fact | holds | only counted entries with an instant count (`shareLedger.ts:94-96`, `:113-121`); a pending entry never counts |
| I7 1b's record, claim and close semantics untouched | holds | Sweep: `git diff --stat 3f38bcc2 HEAD -- app/src/jobs/jobs.ts app/src/adapters/sqsJobConsumer.ts app/src/services/oneToOneRetryDecision.ts app/src/jobs/registerHandlers.ts` prints nothing; `retryChain.ts`, `retryPromiseWrites.ts`, `sendAttemptsRepo.ts` untouched; `MAX_HOP_COUNT` absent from the diff. `retrySend.ts` has ZERO removed lines (insert-only: deps, lazy repos, `markShareUnconfirmed` and its two calls). `sendReconcile.ts` removes only the `Found` type and the two found returns (widened with data, `:414-423`, `:991-1004`, `:1180-1190`) and the adopt deps' second ledger instance (`:453`); every record, claim and close call keeps its place and order, the inserts sit before `closeFromReconcile(adopted)`, after the WITHDRAW, and before the job arms' closes |
| I8 production written only by deployed paths and the Cameron-run repair | holds | no package, lockfile, Terraform, `.env` or infra file in the diff (outside app/dashboard/e2e/docs only `README.md`, `RUNBOOK.md`); the repair refuses a foreign account before a read |
| I9 no new status, table or GSI; the sparse contract documented | holds | status unions unchanged; `tables.ts:422-424`; `README.md:45` |

## C. The plan's 16 declared deviations

| # | Verdict |
|---|---|
| 1 one Scan | shipped as declared (`repair-share-outcomes.ts:330-361`) |
| 2 the rule leaves the repo | shipped (method and mirror deleted; `shareRecipientState.ts:243-263`) |
| 3 `<retried>~`, `!legacy` | shipped (`shareAttemptOrder.ts:11-17`) |
| 4 Not confirmed takes danger | shipped (`broadcastFormat.ts:115`) |
| 5 entry stores `conversationId` | shipped (`listingSendsRepo.ts:52-53`; `shareLedger.ts:51`) |
| 6 the original row's contact | shipped as REFINED by T4's interface: the slot key when it is a contact id, else the row's `recipient_contact_id`, else INFO and no entry (`shareAttemptOutcome.ts:156-158`, `:170-173`). The header's one-line wording ("from the row's own `recipient_contact_id`") is looser than the task it summarizes; the code matches spec D7 and T4. No drift in substance |
| 7 `retry_pending` lower bound, true counts, merges, results recount | shipped (the override lives in the hook, `useBroadcastResults.ts:206-220` - precision) |
| 8 `shares_op` token | shipped (`listingSendsRepo.ts:219`, `:229`, `:254-257`) |
| 9 `countedAt` = the attempt's instant | shipped (`shareLedger.ts:52-58`; a seeded entry keeps the row's `sentAt` `:74-75`) |
| 10 `recordSend` retired; individual pair keeps `broadcastId` absent | shipped (`shareLedger.ts:120`; `putShareMemory` REMOVEs it) |
| 11 reconcile sites bounded; WITHDRAW first; job arms keep `guardWrite` | shipped (`shareAttemptOutcome.ts:268-282`; `sendReconcile.ts:1435-1446`, `:580`; `retrySend.ts:817`) |
| 12 record reads only for the flag; absent vs `expired` | shipped (`shareRecipientState.ts:184-199`, `:74-77`) |
| 13 the withdrawal emit, count unset | shipped, NARROWED: it fires only when the WITHDRAW itself succeeded (`twilio.ts:3676`, `:3702`). A failed withdrawal leaves the promise live on the row, so the route's truth still counts it until the lapse; the narrowing changes nothing observable before then. Accept |
| 14 `retryPending: true`; ticker-only recount | shipped (`broadcasts.ts:241`; `BroadcastResults.tsx:47-51`, `:166`), plus a rows-behind guard (`useBroadcastResults.ts:175`: a tick is ignored between an overlay and its refetch) - precision |
| 15 already-applied at the top and after a refusal | shipped (`shareAttemptOutcome.ts:226-234`, `:242-250`, `:193`). Declared consequence (slice 2): a re-applied row-less marker answers `applied` with no write rather than the plan sketch's `refused`; the spec's "re-applies as a no-op" holds (no write, no delta, one extra emit) |
| 16 record bound from `updated_at` | shipped (`shareRecipientState.ts:118-122`) |

## D. Pins

Pins the spec (section 7) and the plan name as FLIPPING - every one rewritten
as specified:

| Pin (base location) | Now |
|---|---|
| `share-skip-fix.spec.ts:250` failed-stays-flagged + header `:16-22` | `:250-287` asserts NO "Already sent" (`:285`); header rewritten |
| `broadcastsRepo.integration.test.ts:298`, `:347`, `:359` (the repo rule) | deleted with the method (deviation 2); coverage `shareRecipientState.test.ts:212-238` |
| `broadcastApi.test.ts:1088` (prior sent flags) | extended `:1168` (reached + in flight in a sending share) |
| `broadcastApi.test.ts:1183` (draft/failed not flagged) | kept `:1273`, holds as the stranded case |
| `broadcastApi.test.ts:1207` ("a failed one still is") | replaced by the final-failure case `:1340`; new cases `:1316` (pending), `:1330` (Not confirmed), `:1371` (draft / strand / live record), `:1393` (failed read) |
| `twilioStatusWebhook.test.ts:374` (1b's skip pin) | rewritten as the `share rollup` describe `:380` (routed, copy-read, withdrawal emits, ASCII give-up at WARN) |
| `BroadcastResults.test.tsx:139` (hint on a keyless row) | flipped `:164` (no hint); positive control `:178`; promise and unresolved `:204`, `:226` |
| `send-outcome-reconcile.spec.ts:464` (21211 hint) | `:465` count 0 |
| `send-outcome-reconcile.spec.ts:534` ("Failed" pill), `:535-537` (alert) | `:537` Not confirmed; `:538-540` alert count 0 |
| "Sent to N tenants" labels (`listingFormat.test.ts:180-192`) | `:199-204` "No tenants reached" |
| label table (`broadcastFormat.test.ts:224`, `:226`, `:228`, `:242`) | `:256`, `:259`, `:262` Not sent/danger; the unconfirmed case `:303-306` Not confirmed/danger; new first-match-wins case `:266-291` |
| `broadcastFormat.test.ts:185` (30003 promises nothing) | the no-options assertion kept `:184`; the three readings added |
| `StatChips.test.tsx:77` order; `:177-181` badge | order with Retrying `:99`; balance/clamp `:108`, `:130`; badge moved to `DeliveryBadge.test.tsx:19` |
| `broadcastApi.test.ts:1271-1282` results stats `toEqual` | `retry_pending: 0` at `:1454` |
| `broadcastFanOut.test.ts:1054` swallowed ledger write | `:1111` stubs `putShareMemory`, matches the new line (`:1139`) |
| `listingSendsRepo.integration.test.ts:56-150` (`recordSend`) | rewritten as `putShareMemory` cases `:60`, `:77` |

One pin NOT in the named list changed at the gate (orchestrator commit
7386968d): `app/test/repoPagingWiring.test.ts` - the two `listingSends`
paging fixtures gained `sentAt`. Its assertion (both pages returned) is intact;
the fixture shape (no `sentAt`, no `counted`) is one no real row has, and the
stricter reader matches plan T3 ("an absent `sentAt` is not listed"). Accept.

Pins named MUST STAY GREEN - each present with its assertion intact:
`deriveBroadcastStats.test.ts:22-27` (identity); `broadcastApi.test.ts:655`,
`:1074` (the cap by the constant; the `:655` COMMENT still says 1500, G7);
`twilioStatusWebhook.test.ts:245`, `:296`, `:344` (no hunk touches them);
`retrySendAttempt.test.ts` 1c, 1d, the two FW1 C-5 cases, 7, 8 (hunks at
`:41`, `:105`, and an insertion after `:1369` only); `sendReconcile.test.ts`
10a, 10d, 10e, 12, 12c, C-2, the own-row cases, 13a and the holder/
`isBroadcastRowFor` pins (hunks at `:59`, `:380`, `:423`, and an insertion at
`:4009` only); `retryChain.test.ts`, `retry-send-adoption.spec.ts`,
`broadcasts.spec.ts` and `landlord-activity.spec.ts` untouched;
`listing-activity.spec.ts` (only a comment at `:195`); `unitsApiActivity.test.ts`
(the missing-share pin, now `:181-189`); `contactTimeline.test.ts` (the stored
"4", now `:1085-1121`); `broadcastFormat.test.ts` delivered/sending/draft/no-stats
(`:255`, `:257`, `:260`, `:263`); `BroadcastResults.test.tsx` unconfirmed row
(`:252`) and overlay (`:319`); the reconcile property-row pins (extended at
`:382-400`, `:431-445`); the fan-out ledger pins (kept and extended).

## E. Watch items

1. FENCE - honored (I7).
2. One promise source; exactly ONE new slot attribute - honored (I5; `broadcastsRepo.ts:188`).
3. Every added slot write through `applyAttemptOutcome`; aliases; no empty REMOVE - honored. `applyAttemptOutcome` (`broadcastsRepo.ts:956-978`): `#la` is used by both condition forms, `:pa` bound only when named, `#aN`/`:vN` only for non-zero buckets. `putShareMemory` (`listingSendsRepo.ts:212-266`): every declared alias lands in SET, REMOVE or the condition; `:sentAt`, `:bid`, `:tok` bound only when used; REMOVE appended only when non-empty (`:264`). `getByIds` `#s` (`broadcastsRepo.ts:995-997`); `stampRetryAttribution` `#b`/`#r`/`:b`/`:r` (`messagesRepo.ts:3451-3454`); the repair Scan `#unit` (`repair-share-outcomes.ts:349-350`).
4. The webhook's promise value - honored verbatim (`twilio.ts:3488`), with copy-read pins for both paths.
5. Record reads only for the composer flag - honored; zero-call pin over results, `?view=stats` and list (`broadcastApi.test.ts:1548`).
6. Import cycle - honored: the three services import repos and libs only (`shareAttemptOutcome.ts:32-41`, `shareLedger.ts:19-23`, `shareRecipientState.ts:14-28`).
7. Test-helper facts - honored (spot-checked: `createLogCapture`/`createLogger` in the new suites; `mock.invocationCallOrder` in the T6 order pins).
8. Flipping pins named per task - honored (section D); the one unnamed change is the gate's fixture fix above.
9. E2E - honored: per-run numbers in the 90s block (`uid` starts at 94, `share-sent-outcome.spec.ts:83`, declared: disjoint from retry-send-adoption's 91-93); no `contact-tenant-0002` / `conv-0002` use (a comment only, `:48`; the created units' landlord is the seed `contact-landlord-0001`, `:157`); single-use arming re-armed after each landed create in (b) (`:525-526`, `:540-543`); helpers file-local. Lane boot and port hygiene are slice 4b's record, not verifiable from the tree.
10. ASCII - honored: the added lines of every touched file under `app/`, `dashboard/`, `e2e/`, `README.md` and `RUNBOOK.md` strip to 0 bytes with `LC_ALL=C tr -d '\11\12\15\40-\176'`, and every new file is 0. The three named pre-existing non-ASCII lines were re-worded where touched (the give-up line `twilio.ts:4029`; the hint `BroadcastResults.tsx:117`; the base `broadcastsRepo.ts:740` WARN went with `priorRecipientContactIds`). Untouched pre-existing non-ASCII lines (e.g. `twilio.ts:4005`, the rollup catch line) are not touched lines.
11. Commit discipline - every build commit carries a Co-Authored-By trailer; explicit-path staging is not verifiable from the tree.
12. Mission records - the five slice reports are committed under `build/`; T15's self-QA and handback pending.
13-15. Children models, the gate runs, the e2e footguns - process items, not verifiable from the tree (N/A here).

## F. Dashboard copy (Global Constraints) - every literal present exactly

- Pills `Sent` / `Sending` / `Not confirmed` / `Not sent`: `broadcastFormat.ts:113`, `:114`, `:115`, `:117`.
- Chip `Retrying`: `StatChips.tsx:46`.
- Hint `open conversation to retry`: `BroadcastResults.tsx:117` (no glyph).
- `Sent to N tenants` / `Sent to 1 tenant` / `No tenants reached`: `contactTimeline.ts:696` (`sentToLabel`), `listingFormat.ts:136`.
- `Property sent` / `Property sent - not confirmed` / `Property text failed`: `contactTimeline.ts:720-738`.

## G. Beyond the spec, and divergences for adjudication

G1 (beyond spec D8 step 4 - MINOR). The repair CREATES ledger rows for pairs
whose slot entry does not count (failed, pending, unconfirmed): `rowsToCreate`
is not limited to reached recipients (`repair-share-outcomes.ts:575-586`,
`:592-608`; plan T13's b-7 case expects it; `RUNBOOK.md:381` explains it). The
spec says the repair "fills a row the pass's swallowed write never created, for
a reached recipient". The created rows are `counted: false` with no `sentAt`:
invisible to both readers and the index, and they give D6's pair rule the right
words. Recommendation: ACCEPT as plan-mandated; declare it in the handback as a
deviation from D8's wording (the census's `rowsToCreate` includes them).

G2 (undeclared precision - MINOR). When the repair moves a slot on its ORIGINAL
attempt (an empty chain, or the original is the latest delivered row -
`repair-share-outcomes.ts:455-456`), `nextSlot` stamps `latestAttempt` equal to
the slot's own `tsMsgId` (`shareAttemptOutcome.ts:96`; plan T4 step 4 says
"always ... `latestAttempt = input.attemptKey`"). Spec D1 and the plan's
interface comment say the pointer is ABSENT while the original is newest.
Harmless (every reader uses `latestAttempt ?? tsMsgId`; the next conditional
write names it; a re-census agrees), and only the repair can produce it; the
repair tests assert with `toMatchObject` and never pin the absence.
Recommendation: ACCEPT and declare (a plan-internal inconsistency), or a
one-line guard in `nextSlot` omitting the pointer when the attempt key equals
`slot.tsMsgId` - orchestrator's call; no behavior depends on it.

G3 (precision inside D3/D4 - MINOR; slice 3 worry 1). A recipient pending
because its row read FAILED (`retryPending: true`, no `retryDueAt`) is counted
in the Retrying chip AND shows the "open conversation to retry" hint: the hint
rule (`BroadcastResults.tsx:90-96`, the plan's rule verbatim) tests only
`isRetryPromiseLive(retryDueAt)`. Needs a DynamoDB read fault at request time;
the thread's own Retry guard still judges the real row. Recommendation: add a
`retryPending !== true` clause if a fix wave runs anyway; else ACCEPT and name it.

G4 (spec section 7 (a) narrowed by the plan - MINOR). The spec's scenario (a)
asks for the results ROW "reading 'will retry' in between"; the e2e reads the
pending state through the API (`share-sent-outcome.spec.ts:435-445`) and the
copy is pinned by unit tests (`DeliveryBadge.test.tsx`, `BroadcastResults.test.tsx:204`)
- plan T14's deliberate choice for a 10 s window. Recommendation: ACCEPT; the
live self-QA eyeballs the copy (H1) and the handback states the split.

G5 (spec D8's report narrowed by the plan - MINOR). The spec's report names
"a pre-RSW retry whose lineage was never written" among the rows the repair
could not judge. Such a row (no `retry_of`, no `retry_root`) is invisible to
the plan's chain definition: it joins no chain (`repair-share-outcomes.ts:397`),
claims no original (`:410`), and no counter names it; its slot is judged
without it - left as it is when the rest of its chain is empty, as the spec
wants - but not REPORTED. The class is narrow: pre-RSW retries were annotated
with `retry_of` after the send (base `retrySend.ts` at 4809b5c2^), so only a
lost annotate leaves one. `RUNBOOK.md:385` attributes it to `brokenLineage`,
which cannot see it (the T13.8 PARTIAL). Recommendation: correct the RUNBOOK
line; name the invisible class in the handback's residuals; no code change.

G6 (cosmetic - MINOR; slice 3 T11 note). For a share that no longer exists
and whose stored count is 0, the property Activity card reads "No tenants
reached" (client words from the stored count, `listingFormat.ts:136`) where D5
says the stored words; the landlord timeline keeps "Sent to 0 tenants".
Unreachable in practice (a finalized share is never deleted, and a share with
no recipients cannot be sent). Recommendation: ACCEPT.

G7 (stale comments - MINOR, T15 material).
`dashboard/src/api/types.ts:3124-3125` (the preview flag doc still says "a
prior sent/sending broadcast ... already included them");
`dashboard/src/routes/contact/deliveryStatus.ts:1014-1017`, `:1021-1023` (the
options doc says the property-send results row omits `retryScheduled` /
`retryUnconfirmed` - it now passes both);
`dashboard/src/routes/broadcasts/BroadcastStatusPill.tsx:4-5`, `:17-18` (names
only the all-skipped case); `app/test/broadcastApi.test.ts:655` (comment
"1500"). Recommendation: fix in T15.

Every other divergence the slice reports declare reads as PRECISION, not a
changed decision, and needs no adjudication: the doubles mirroring the
projection and `removeUndefinedValues` (slice 1); `isListed` also requiring
`sentAt` (slice 1, plan T3's text); `listingSendKey` / `ledgerRowCounted` /
`ledgerEntryCounts` exports; `putShareMemory` stamping `via` only if absent;
redacted slot keys in logs; `projectSlot` / `applyLaterAttemptBounded` shipped
in T4; ONE `no_broadcast` WARN at the reconcile sites; `outcomeOf` pinned with
`queued` / `queued_pending`; the withdrawn sentinel passed through on the wire
(I5-consistent); the view check before the 404; the always-armed ticker and
the rows-behind guard; `unitAuditToMilestone` without a `reached?` parameter;
the landlord relabel also requiring a `Sent to ` label; D6 re-wording over the
gathered `limit + 1` events and without a contact-type guard; the repair's
per-fixture SIDs, its ledger read before the slot step, its re-read after any
attempted move, its consistent Scan, `lost` aborting the run, and an unknown
`--broadcast` id as a usage error; the e2e's `uid` block, early re-arm in (b)
and `expectCreatesLanded(count)`.

## H. Gaps and risks a spec-conformant build still leaves for live self-QA

H1. The pending window on screen (about 10 s at the lane backoff): the results
row reading "will retry", the pill Sending, Retrying 1, and the list row
Sending. The e2e proves the state through the API only (G4).

H2. A share RETRY that reaches the reconcile is unit-tested only: the adoption
(site 5) and the unresolved close (sites 1-2) have no e2e. A lane rehearsal
exists: arm 30003 on the original, then `drop_before_create` + `failList` x3
for the retry's create. Expect the slot `send_unconfirmed` with the row-less
pointer, the pill Not confirmed, the tenant flagged, the milestone "Property
sent - not confirmed", nothing under Properties sent. The job arms (sites 3-4)
and every crash/redelivery re-apply stay unit-only by construction (lane jobs
run in process; a delayed dispatch is never redelivered).

H3. The mid-chain "Sent" flash (slice 4b: about 150 ms per rung) on the list
and the results pill, with a transient Properties-sent listing and "Property
sent" words mid-chain - D1-conformant (a carrier-accepted attempt reached);
eyeball it and name it in the handback.

H4. The landlord timeline's recount live ("No tenants reached" for scenario
(c)'s property owner); only unit tests and landlord-activity's two-delivered
case cover it.

H5. The repair rehearsal on the self-QA lane (census, apply, census): after
the e2e shares every `*To*` counter should be 0 - a non-zero one is a
live-writer gap. `STALE_RECONCILING_MS` is production's (6 min), so a young
lane `reconciling` record decides nothing.

H6. Unit-only transitions: deviation 13's re-emit (needs an SQS enqueue
failure), the results ticker recount on a lapse with no event, and the list
keeping a count for a share stored `sending`.

H7. Residuals the handback should name: the lineage-less pre-RSW retries
invisible to the census (G5); a slot `failed` at its own attempt whose row
reads delivered stays failed (D2's same-attempt terminal rule; slice 4a worry
2); the repair's un-counted rows (G1) and its `latestAttempt` on an original
(G2); the hint on an unreadable-row pending recipient (G3); a failed refetch
leaving the rows-behind mark set (the ticker cannot recount until the next
fetch); the list reading Sending past a lapse with no event (D4's accepted
staleness); a lost retry rollup (the webhook's retry path is unbounded by
design - a throw is the rollup's own ERROR, spec section 8).

H8. Production scale, not provable on a lane: the composer flag's reads over a
unit's whole share history (records bounded by 30 days, rows by 24 minutes);
the list page's row reads for young 30003 slots; `getByIds` with `recipients`
projected against BatchGet's 16 MB response (the overflow degrades to stored
counts with a WARN); a legacy share near the old 1500 cap gaining retried
slots (the item-size write is bounded at the reconcile sites and caught at the
webhook); the repair's runtime on prod (RUNBOOK: minutes).

H9. The drift report (`git log HEAD..main`) and the five gates on a quiet tree
remain T15's.
