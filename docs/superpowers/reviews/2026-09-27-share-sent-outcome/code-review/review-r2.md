# Share sent outcome (Branch B) - code review round 2

Reviewer: a fresh round-2 reviewer (Claude Opus 5.5), 2026-09-28. Tree
`feat/share-sent-outcome` @fa42bf1d (the fix-wave-1 report) on base main
@3f38bcc2; `main` has not advanced since (`git rev-parse main` = 3f38bcc2).
Read: `AGENTS.md`; the spec (v5 + restatement, D1-D9, sections 4, 8, 9); the
plan header (16 deviations, Global Constraints); `adversarial-r1.md`,
`spec-conformance-r1.md`, `r1-adjudications.md`, `build/fix-wave-1-report.md`;
the fix-wave delta (all 2.6k lines) and the whole-branch package for context;
the current source of every file the fix wave touched plus the surrounding
readers and writers.

Method. Every claim below was checked in the tree. Tests were run as
single-file vitest invocations, one at a time. Each fix was reverted locally
in a throwaway way (a one-line `sed`, or `git show <commit>^:<path>`), its
test file re-run, and the file restored with `git checkout -- <path>`; one
throwaway probe (`app/test/zz-r2-probe.test.ts`, DynamoDB Local) was written,
run and deleted. `git status` was clean after every restore. No gate, lane,
`npm test` or `npm run e2e` was run.

**Counts.** New findings: 0 CRITICAL / 0 HIGH / 0 MEDIUM / 1 LOW. Fix-diff
defects: 0 CRITICAL / 0 HIGH / 0 MEDIUM / 3 LOW. Adjudication challenges: 1
(ADV-3 - upheld on substance, a documentation correction required); ADV-1
tested and upheld. Found-while-fixing: #1 and #4 FILE (LOW), #2, #3, #5
ACCEPT; none is a must-fix. Every FIX item is real: each new test fails with
its fix reverted.

## 1. New findings (what round 1 missed)

### R2-1 [LOW] The list's stats refetch - the only path by which a finished share leaves "Sending" at a chain end - reads the share eventually-consistently, so a refetch that outruns replication locks in the pre-write label with no later event to correct it

Claim. D4's list refetch (`dashboard/src/routes/broadcasts/useBroadcastsList.ts:165-190`,
triggered at `:228-231`) calls `GET /api/broadcasts/:id/results?view=stats`,
whose handler reads the share through `broadcasts.getById`
(`app/src/routes/broadcasts.ts:875`, before the view branch at `:886`) - an
eventually consistent GetItem (`app/src/repos/broadcastsRepo.ts:592-594`,
`readById(broadcastId, false)`) - while the D1 row reads beside it are
consistent (`app/src/services/shareRecipientState.ts:167`). The refetch runs
about 400 ms after the `broadcast.updated` that the committed write emitted.

Interleaving. e2e (b)'s shape in production: R3's final `undelivered` 30003
(the capped rung, no promise) commits the slot `failed 30003` on R3 and emits
with the count unset; the open list row still holds `retry_pending` 1, so it
schedules the refetch; the GetItem is served by a replica that has not applied
the write and returns the slot as it was - `sent` on R3 (the carrier `sent`
rollup; the row then reads Sent) or `failed 30003` on R2, whose row (read
fresh) carries a promise still inside its two-minute grace (the row reads
Sending). The chain has ended, so no event follows: the list row keeps the
wrong pill until the page is reopened. Before this branch the list patched
status and stats from the event's own ALL_NEW-derived payload only (base
`useBroadcastsList.ts:116`) and never refetched, so this path is new. The
results page has the same shape (its post-event refetch replaces the
overlay's correct stats at `useBroadcastResults.ts:103`), and there a stale
"reached" slot cannot be corrected by the ticker either; that refetch is
pre-existing, but D4's labels now make a stale read visible as a wrong pill.

Why LOW. It needs replica lag beyond roughly half a second; DynamoDB Local is
strongly consistent, so no test can see it; the wrong pill is a summary and a
reload fixes it. Direction: read the share with `getByIdConsistent` in the
results route (at least under `?view=stats`) - one item, twice the read units.

The other areas the charge named (the fix-wave interactions, the e2e
assertions against the product, the seed helper through the service, the
repair's partial apply, the route payload shapes, `updateRows` against every
rows writer, the issue notes) produced the fix-diff items in section 2 and
nothing else; section 6 says what was checked.

## 2. The fix diff, cold

### Group 1 - RUNBOOK (d8e85c39; ADV-1, ADV-2b, ADV-4, ADV-8, T13.8/G5)

Does what the adjudication asked. One defect:

**R2-F1 [LOW] The ADV-1 mitigation paragraph under-states what stays under-flagged, and the apply's new "completed with failures" exit has no rule against the binding order.**
- `RUNBOOK.md:372` ends with the classes that stay under-flagged for good if
  their retry delivered: the `unjudgeable` counters and the lineage-less
  pre-RSW retry. It omits the `slotsFailed` slots (ADV-4's own class: a
  permanent cause - the 400 KB item limit - fails on every re-run, so that
  tenant stays un-flagged for good; a transient one until the re-run), and it
  says nothing about whether the binding order "deploy -> census -> apply ->
  next blast" is satisfied by an apply that exits 1 with `COMPLETED WITH
  FAILURES` (`:393`). An operator can resume blasts with named slots still
  under-flagged. One sentence fixes it: such an apply closes the window for
  every slot except the ones its ERROR lines name; decide the next blast with
  that list in hand.
- The same line's "the `unjudgeable` counters" overstates: `noContact` and
  `noRecipientKey` slots WERE judged and moved (`repair-share-outcomes.ts:500-508`,
  `:631-634`); only `originalMissing` and `brokenLineage` leave the slot.
- Precision: `:393` lists "a pair's ledger row" among the reads that abort,
  but the consistent reads INSIDE the two write services (the share read in
  `applyLaterAttempt`, the ledger read in `applyShareLedgerEntry`) fail per
  slot (`repair-share-outcomes.ts:609-620`, `:660-666`) - declared in the fix
  report's judgment call 1, not reflected in the RUNBOOK.

Test: documentation; checked against the code's log lines and levels (every
quoted line exists at the level stated; the Logs Insights filter matches both
"lost its condition" lines).

### Group 2 - repair (8e00e495; ADV-4, ADV-5)

Sound as the adjudication specified: per-slot catch of the two write calls,
ONE ERROR with ids and the redacted key, `slotsFailed`, walk continues, exit 1
after the full report; reads still abort; `rowOutcome` stamps a `sent` row's
own instant. A half-applied share is consistent slot by slot (each move and
its stats delta are one conditional write; its ledger follows only a slot
that did not fail) and a re-run converges: moved slots read "recorded", their
ledger re-applies as refused or written, failed slots retry and either heal or
fail again by name; nothing oscillates (the slot and ledger order rules are
monotone). One defect:

**R2-F2 [LOW] The per-slot catch treats every write throw alike: a transient fault is not retried, and a systemic write fault no longer stops the run.**
- The repair calls the bare `applyLaterAttempt` inside its try
  (`repair-share-outcomes.ts:609-620`), where the reconcile's two sites and
  (since this fix wave) the webhook use `applyLaterAttemptBounded`
  (`shareAttemptOutcome.ts:274-288`), so one
  transient fault that survives the SDK's retries costs a `slotsFailed`, an
  exit 1 and a re-run.
- A write-only systemic fault (a missing `dynamodb:UpdateItem`, sustained
  throttling on the share table) is now caught per slot and the walk reads on
  through every share, one ERROR per slot, until some later read or stamp
  throws. The repository's own precedent for per-item continue draws this
  line the other way: the reminder sweep counts item failures and finishes,
  but treats a write failure other than a lost conditional check (rotated
  credentials, a missing UpdateItem grant, a wrong prefix, sustained
  throttling) as systemic and ABORTS with its PARTIAL report
  (`RUNBOOK.md:324`).
- A write that committed and then threw (a lost response past the SDK's
  retries - the SDK's own replay normally turns it into a clean `applied`
  through deviation 15) is reported "left as it is" although the slot moved;
  the re-run converges.
- Direction: use the bounded variant inside the catch, and abort on the
  error classes the sweep treats as systemic.

Tests. HEAD: 18/18. With the whole pre-fix script restored under the
post-fix test file: 3 failed | 15 passed - b-16 (ADV-5), the bulk item-size
case and the lost/ledger case. With only `rowOutcome`'s `sent` case removed:
1 failed | 17 passed (b-16). The tests prove the fixes.

### Group 3 - reconcile own-row carrier instant (eee2054e; ADV-5 live twin)

Sound. Data on the `Found` verdict only; `mapAdopted` is its only consumer
(`sendReconcile.ts:1478`, `:1483`); a re-found `sent` row whose slot already
carries the webhook's instant is now `refused` instead of a replayed `applied`
- no caller distinguishes the two (`adoptedShareRetry` checks `no_slot`
only). No record, claim or close line moved (I7 fence diff empty).
Test: with the spread line removed, the ADV-5 reconcile test fails ("expected
... to deeply equal { status: 'sent', ...(4) }"); HEAD 166/166.

### Group 4 - webhook bounded retry path, one RETRIED_ERROR_CODE (7be6ef3c; ADV-2b, ADV-10)

Sound, no more than asked. A committed-then-thrown write replays as applied
with no second delta (deviation 15); the bus isolates listener throws
(`app/src/lib/events.ts:354-359`) and `writeLedger` swallows, so `threw` only
follows a slot write that kept throwing. Test: with the call reverted to the
bare transition, both new tests fail ("expected 1 to be 2", "expected 1 to
be 3"); HEAD 94/94.

### Group 5 - no pointer on the original's own key; pairContactId (2fd4b799; G2 / ADV-11 (2), ADV-10)

Sound for every live writer: only the repair can pass an attempt key equal to
the slot's own `tsMsgId` (the webhook routes retry rows only; the reconcile's
keys come from `adoptRetry` / `ownRetryRow`, both retry rows; the job arms and
the unresolved close use row-less keys). The repo replaces the whole slot
(`broadcastsRepo.ts:977`) and the double mirrors it
(`twilioWebhookHarness.ts:3381-3382`), so omission removes the pointer. The
bucket stays pinned by the (status, latestAttempt) condition: a pointer-less
failed slot cannot change its code through `applyAttemptOutcome` (same-attempt
`failed` is terminal) and `rollIntoBroadcast` refuses a failed slot. One
defect:

**R2-F3 [LOW] Deviation 15's replay check now misfires in the repair: a pointer-less slot that the ORIGINAL row's own rollup wrote equals the repair's `next`, so the repair reports a move it did not make.** Before G2 every
`applyAttemptOutcome` write stamped the pointer, so "the slot equals `next`"
(`shareAttemptOutcome.ts:236`, `:253`) meant our own replayed write. Now
`rollIntoBroadcast`'s pointer-less shape (`twilio.ts` spread write) can equal a
ROOT-keyed `next`. Reproduced (throwaway probe, DynamoDB Local): a share slot
`sent` whose ROOT row failed 30007; between the repair's first read and
`applyLaterAttempt`'s consistent read the slot is moved to `failed 30007` (the
webhook's rollup); the apply reports `slotsToMove 1, slotsMoved 1`; with the
G2 guard reverted the same run reports `slotsMoved 0` (refused). The share's
stats are right either way (`failed 1`, no second delta; the side effects are
idempotent). Needs the ORIGINAL's receipt inside its own row-write -> rollup
window during an apply at the "quiet moment" the RUNBOOK asks for; precision
only.

Test: with the guard reverted, the G2 test fails ("expected { conversationId:
'conv-1', ...(3) } to deeply equal { status: 'delivered', ...(2) }"); HEAD
26/26.

### Group 6 - seed helper through the service (9758c5ee; ADV-10)

Sound. The service's `summarize` now writes the seeded rows; the suites still
assert literal expected values, so the seed cannot hide a service bug; a
legacy raw row is now seeded from itself (more faithful than the old helper,
which ignored its `broadcastId` / `sentAt`); a same-key re-seed now throws
(documented, no suite does it). Suites green at HEAD: listingSendsApi 16,
contactsBatchReads 10, listingSendsRepo.integration 6, repairShareOutcomes 18.

### Group 7 - dashboard (47a00537; ADV-7, G3, G7)

Sound. `updateRows` is paired with EVERY rows writer - first page
(`useBroadcastsList.ts:91`), load more (`:140`), removeRow (`:121`), the stats
refetch (`:176`), the SSE patch (`:210`) - and the filter reset clears the ref
beside its `setRows([])` (`:106-107`); ref and state apply the same ordered,
pure changes (StrictMode's double-invoked updater is harmless), so no writer
bypasses the ref. The count-carrying cancel cannot lose a newer response: an
aborted read's `.then` returns on the aborted signal, and a resolved read's
`.then` runs as a microtask before the next SSE task. G3's clause departs from
the adjudication's literal `retryPending !== true`, correctly: the literal form
hides the hint after a lapsed promise (D3), and the file's own ticker pin
proved it. Tests: the pre-fix hook fails all three ADV-7 tests (0 calls;
`expected false to be true`; called once); removing the G3 clause fails the G3
test ("expected <a ...> to be null"); HEAD 19/19 and 24/24.

### Group 8 - issues (5be51e04; D9, ADV-2a, ADV-6, ADV-9, section 8)

Sound. Every anchor I opened points at the code it names
(`retrySendWindow.ts:107`, `sqsJobConsumer.ts:129`, `api.ts:1653-1657`,
`broadcasts.ts:848`, `broadcastFanOut.ts:876`, `retrySend.ts:583`, `:604-610`,
`shareAttemptOutcome.ts:123-131`, `:262`, `:285`, `shareLedger.ts:192`,
`twilio.ts:3955`); every commit hash in the three RESOLVED blocks exists on
the branch; the cited test name exists (`broadcastApi.test.ts:1330`). ASCII:
the fix wave's added lines strip to 0 bytes.

## 3. Adjudication challenges

**C-1 ADV-3 - uphold the REJECT on substance; the adjudication must also correct the tree's documentation.** The adjudication rests on D6 verbatim
("Property sent" while a pending entry's promise is live), and D6 is the
specific rule for the milestone's words, gated by Cameron, with section 8's
"the milestone keeps the history" behind it: the code is right to follow it.
But the same spec's D1 (section 3) lists "the milestone" among the STRICT
readers ("the labels, the counts, the ledger, the milestone: reached only"),
so the spec contradicts itself, and the tree repeats D1's claim in two places
the code does not honor: `app/src/services/shareRecipientState.ts:6` and
`:94` say the STRICT reading serves the milestone, while
`app/src/routes/contactTimeline.ts:728-739` reads a live pending entry as
"Property sent" (the SAFE side). A later reader "fixing" the milestone to
`hasReached` per the header would silently reverse a product decision.
Recommendation: keep the code; reword the two comments (the milestone takes
D6's words - a live pending entry reads "Property sent"); put one line in the
handback naming the D1/D6 wording conflict for Cameron. Not a blocker.

**ADV-1 - tested, upheld.** The exposure is exactly the deploy -> apply window
that D8 and section 6 already order closed, and when the RUNBOOK is followed
the window is minutes per environment. One correction to the rationale: the
declined "keep main's over-approximation" alternative need not read the
stored status (I1) - a data-keyed variant (flag an old failed-30003 slot with
no pointer) avoids I1 - but it re-flags every historical AND new final 30003
failure (D1's un-flagging) unless a deploy cutoff is baked in, so the decline
stands on D1, not on I1. The paragraph's missing `slotsFailed` class is
R2-F1.

No other adjudication is challenged: ADV-2 (a) and (b), ADV-4 through ADV-11,
T13.8, G1-G7 and the builder divergences all hold against the spec and the
tree.

## 4. Found while fixing 1-5

1. **FILE (LOW), optional one-clause fix.** Reproduced (throwaway probe): a
   share slot `sent` with no `carrierSentAt` on its ORIGINAL, whose row reads
   `sent`, gets census `slotsToMove 0`, apply `slotsMoved 0`, and still derives
   `sending 1`; the positive control (row `delivered`) moves. `slotRecords`
   (`repair-share-outcomes.ts:522-527`) ignores the instant that ADV-5's
   `rowOutcome` now carries (`:461-464`), although `wouldApply` admits the
   same-attempt gain (`shareAttemptOutcome.ts:130`). The class is pre-existing
   (a lost original `sent`-marker rollup with no later delivery receipt),
   outside D8 step 3's named cases, and cosmetic (the pill already reads Sent;
   the row and the chips read Sending). The fix is safe - requiring
   `slot.carrierSentAt !== undefined` when the decision carries one; the move
   carries no stats delta (the persisted buckets do not split sending) and the
   ledger entry is unchanged - so take it if a small pass runs, else file.
2. **ACCEPT.** `PreviewResponse`'s doc (`dashboard/src/api/types.ts:3148-3150`)
   still calls the set "already sent"; it is D1's SAFE reading and can carry
   `phone#` keys. Fold into the next touch of the file.
3. **ACCEPT.** The other `'30003'` copies are RSW's decision gate, the
   error-class switch, the relay trigger (distinct concepts) and the fenced
   `oneToOneRetryDecision.ts` (I7). Out of ADV-10's scope.
4. **FILE (LOW) - a real defect, not "no defect".** `fetchResults` clears
   `rowsBehindRef` when the response resolves (`useBroadcastResults.ts:106`),
   before `BroadcastResults.tsx:163-165` syncs the ticker's rows in a passive
   effect. A tick landing in that window - the 60 s interval, or the focus
   listener (`:180`) on returning to the tab - recounts from the PRE-fetch rows,
   and its `setRecount` (`useBroadcastResults.ts:208-211`) is applied after the
   fetch's `setRecount(undefined)`, overriding the route's fresh count
   (`:212-220`) until the next tick, fetch or count-carrying overlay (at most
   60 s): e.g. a chain that just ended reads "Sending" / Retrying 1. The window
   is about a frame per fetch. Direction: derive the recount from the hook's
   own `results.recipients`, or clear the guard only after the rows commit.
5. **ACCEPT.** Conservative and convergent (the re-run finds the slot
   recorded and the ledger refused or written). The ERROR text "left as it
   is" is inaccurate for this case (the slot moved) - precision, with R2-F2.

## 5. Fixes real?

| FIX item | Verdict | Evidence |
|---|---|---|
| ADV-1 (RUNBOOK why + binding order) | real | `RUNBOOK.md:372`, `:397`; gaps are R2-F1 |
| ADV-2 (b) webhook bounded | real | call reverted: both new tests fail; HEAD 94/94 |
| ADV-4 repair per-slot continue | real | pre-fix script: bulk and lost/ledger tests fail; HEAD 18/18 |
| ADV-5 repair `sent` row carrier-confirmed | real | case removed: b-16 fails; scope gap is found-while-fixing 1 (reproduced) |
| ADV-5 live twin (`ownRetryRow`) | real | spread removed: the ADV-5 reconcile test fails |
| ADV-7 list hook (patched-row decision, cancel/abort) | real | pre-fix hook: 3 of 3 new tests fail |
| ADV-10 constant / pair rule / seed helper | real | one `RETRIED_ERROR_CODE` (`retrySendWindow.ts:43`), no private `'30003'` left in the three services or the repair; `pairContactId` exported (`shareAttemptOutcome.ts:161`) and read by the repair (`repair-share-outcomes.ts:593`); seed suites green |
| G2 / ADV-11 (2) pointer omitted on the original's key | real | guard reverted: the G2 test fails; side effect is R2-F3 |
| G3 hint for an unreadable pending row | real | clause removed: the G3 test fails; the departure from the literal clause is correct |
| T13.8 / G5 RUNBOOK line | real | `RUNBOOK.md:387` |
| G7 comments | real | the four comment sites read true against the code; one stale doc one interface down (found-while-fixing 2) |

## 6. What I checked and could not break

- `updateRows` against every rows writer, StrictMode's double-invoked
  updaters, the filter reset, and the cancel/abort ordering (section 2, group
  7); e2e (b)'s live flip walked with and without a carrier `sent` callback per
  rung - the list reaches Not sent either way.
- G2's reach (repair only) and the bucket pinning under a pointer-less slot;
  the whole-slot replace in the repo and the double.
- The repair's partial apply: per-slot consistency, convergence of a re-run,
  a read that fails after an applied move (aborts with the PARTIAL report; the
  re-run finds the slot recorded), the counters' arithmetic (on an apply,
  `slotsToMove` = `slotsMoved` + the slot-step `slotsFailed` + the refused or
  gone results), one `slotsFailed` per slot at most.
- The webhook's bounded path: no double delta on a replay, no propagation,
  the later 30003 enqueue still runs in the same request.
- The e2e spec's four scenarios against the product: (a)'s pending payload
  (`retryPending` true, `retryDueAt` = the row's own stamp) and the settled
  pointer; (b)'s capped rung (no promise -> failed -> hint, not flagged,
  ledger `failed` -> "Property text failed"); (c)'s 30007 (no row read, hint);
  (d)'s original closed unresolved (no pointer, no hint, flagged, not listed).
  None of the fix wave's changes alters a path they exercise except the list
  hook and the G3 clause, which is never true on those rows.
- Route payload shapes: `retryPending` only for a pending state, and "pending
  with no due instant" if and only if the row read threw; the withdrawn
  sentinel passes through and reads lapsed; the list always carries
  `retry_pending`; the stats view carries status and stats only; GSI
  projections are ALL (`dynamoAdmin.ts:57`), so list items carry the map.
- The reconcile's `Found.carrierSentAt` has no consumer but `mapAdopted`; the
  one-hop `broadcast_id` stamp on history does not change any row's holder
  classification (`sendReconcile.ts:823-830` keys on `retry_of`).
- The I7 fence: `git diff --stat 3f38bcc2 HEAD` over `jobs.ts`,
  `sqsJobConsumer.ts`, `oneToOneRetryDecision.ts`, `registerHandlers.ts`,
  `retryPromiseWrites.ts`, `retryChain.ts`, `sendAttemptsRepo.ts` is empty; the
  fix wave leaves `retrySend.ts` untouched.
- HEAD green on every suite I ran: repairShareOutcomes 18, shareAttemptOutcome
  26, twilioStatusWebhook 94, sendReconcile 166, shareLedger 16,
  shareRecipientState 19, listingSendsApi 16, contactsBatchReads 10,
  listingSendsRepo.integration 6; dashboard BroadcastsList 19,
  BroadcastResults 24. No `[dynamoAdmin]` line in the HEAD runs.
