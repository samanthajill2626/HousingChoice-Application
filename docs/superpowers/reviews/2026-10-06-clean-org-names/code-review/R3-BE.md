# R3-BE - adversarial re-review, round 3, BACKEND half (after fix wave FW2-A)

Reviewer: R3-BE. Branch feat/clean-org-names (merge base d839494a), app/ only, read
plan-blind per the standing charter. Inputs: R1-ADV-BE.md, R2-BE.md, R1-adjudications.md
(A1-A5), R2-adjudications.md (A6-A10), the FW2-A diff (c15ae9a7..f9d0fa29, 5 commits),
the FW-A diff and the whole branch, with the repository swept for other readers and
writers of what the wave touches.

Covered, in the charge's order:
1. The wave-2 diff cold, line by line: OrgRewriteService.claim / heartbeat /
   revalidationProblem / runAgain, jobs/orgRewrite.ts, the orgRecords pass that calls the
   heartbeat, the cleanup's counters (flatCounts, the WARN done line, contactKeepsBlank /
   unitKeepsBlank, planUnit othersRemain), the RUNBOOK and issue text, the new tests.
   Seven interleavings walked with their reads and writes (section "Interleavings").
2. A fresh hunt over what rounds 1 and 2 missed: the list repo's mutate under the SDK's
   automatic retry, the record writers, the pass's heartbeat placement, the cleanup's
   preview counts, readers of lastRewrite (dashboard, e2e), the SQS consumer.
3. The wave-2 rulings and the two ACCEPTs (R2-BE-5, R2-BE-6).
4. Whether each wave-2 test fails with its fix reverted.

Counts: CRITICAL 0 | HIGH 0 | MEDIUM 0 | LOW 2 | INFO 2.
Reproduced (CONFIRMED) with throwaway tests run alone and deleted by exact name:
R3-BE-1 (zz-review-R3-BE-1.test.ts, two cases), R3-BE-2 (zz-review-R3-BE-2.test.ts, the
list half), R3-BE-3 (zz-review-R3-BE-3.test.ts). R3-BE-4 and the record-writer half of
R3-BE-2 are PLAUSIBLE (traced).

Verdict on the claim itself: sound for what A6 targeted. Every delivery after a lapse is
re-validated in the same conditional write that refreshes the heartbeat, a refusal is
recorded failed in that write, and no path revives a lapsed lock without re-validation.
What remains is a lapse that happens DURING a pass (R3-BE-1), not before it.

---

## R3-BE-1 | LOW | CONFIRMED | app/src/services/orgRecords.ts:578,598 (beat after the write) and :504-512 (a thrown heartbeat ignored) ; app/scripts/clean-org-names.ts:674-679

**A claimed pass can still write records under a LAPSED lock.** A6's stale refusal is
only consulted by a heartbeat that runs AND succeeds, and the pass checks it AFTER each
write, never before. Two shapes:

(a) A stall before a write. beat() runs at the END of each record iteration
(orgRecords.ts:578 units, :598 contacts). The first record after any stall is written
with no lock check. Interleaving:
1. 12:00 admin Clears housingAuthority "Metro HA". Job J1 is delivered on time; claim()
   (services/orgRewrite.ts:254-282) writes heartbeatAt 12:00; the pass starts with
   lastBeat 12:00 (orgRecords.ts:498).
2. The pass's first page read (contactsRepo.listByType via everyContact,
   orgRecords.ts:367) stalls 16 minutes. The DynamoDB client sets no request timeout
   (lib/dynamo.ts:61-79).
3. 12:15 the lock lapses. OrgNamesService.add("Metro HA") passes
   refuseWhileRewritingName, which tests freshness only (orgNames.ts:178-183) -> 201.
   D5 checkScalar answers ok/"Metro HA", and a VA saves tenant t-new with it.
4. 12:16 the page returns with t-new. matches() -> rewriteOrgFields REMOVEs it
   (orgRecords.ts:588) BEFORE beat() runs. Only then does heartbeat() answer false
   (stale), and the job returns lock_lost.

(b) Every heartbeat throws. heartbeat() throws when its GetItem fails, or (while the lock
is still fresh) when its Put fails. beat() logs WARN and continues with no local bound
(orgRecords.ts:504-512); the stale answer needs a successful read. A pass whose heartbeats
throw through the 15-minute mark writes on past it with every guard off. finish() checks
only id and status, not freshness (orgRewrite.ts:284-305), so it records `done`.

Evidence (zz-review-R3-BE-1.test.ts, fake world, real OrgNames / OrgRewrite /
OrgRecords services and runOrgRewriteJob, fake Date):
- (a) logged `{"outcome":{"outcome":"lock_lost","counts":{"housingAuthority":1,...}},"d5":{"ok":true,"value":"Metro HA"},"tNew":"(removed)","rewrites":["contacts#t-new"]}`.
  `expect(tNew).toBe('Metro HA')` failed: received undefined. The record the pass
  destroyed is exactly the VA's exact-name record, written after the lapse.
- (b) 61 holders at 25 s per record, every heartbeat throwing; at 12:15 "Metro HA" added
  (201) and t-new saved with it. Logged
  `{"outcome":"done","beats":61,"written":61,"added":true,"tNew":"(removed)","lock":{"status":"done","heartbeatAt":"2026-10-06T12:25:25.000Z",...}}`:
  t-new cleared, and the rewrite finished `done` 10 minutes after its lock lapsed.
  `expect(tNew).toBe('Metro HA')` failed.

The cleanup has shape (b) too (clean-org-names.ts:674-679 continues on a thrown beat). It
does not have (a): it beats BEFORE each row (:701, :753), the placement the pass should
copy. Two doc claims are too strong: jobs/orgRewrite.ts:16-17 ("refreshes the heartbeat,
so no record is written under a lapsed lock" - true at pass start only), and the RUNBOOK
cleanup lock paragraph ("either way the apply's next heartbeat sees it" - only when that
heartbeat succeeds).

Why LOW: (a) needs a stall of about 15 minutes inside a running pass. With the SDK's
keep-alive sockets a dead connection is detected in about 11 minutes, so it takes two in
a row. (b) needs 15 minutes of failing settings-table reads while the record tables work.
When it does happen, the outcome is the R1-ADV-BE-1 / R2-BE-1 data loss on the records
reached in the window.

Fix (small; keeps every A6 test valid):
1. In OrgRecordsService.rewrite, call beat() at the TOP of each record iteration, before
   matches() and the write, as the cleanup does.
2. Give the job's heartbeat wrapper (jobs/orgRewrite.ts:112) and the cleanup's beat a
   local lease. Remember when a heartbeat last answered true. Once that is
   ORG_REWRITE_STALE_MS old (less a margin, e.g. 60 s), treat a thrown heartbeat as
   `false`: stop, lock_lost / CleanupLockLostError.

Tests: the two cases above.

---

## R3-BE-2 | LOW | CONFIRMED (list writes) / PLAUSIBLE (record writers) | app/src/repos/orgListRepo.ts:216-219 ; app/src/services/orgRewrite.ts:339-345, :535-555, :565-576 ; app/src/repos/contactsRepo.ts:1732 ; app/src/repos/unitsRepo.ts:994

**A conditional write that LANDED but answered a retryable error is read back as a lost
race.** The AWS SDK retries a DynamoDB 500 / timeout / connection reset on its own. The
retry of an already-applied conditional write fails its own condition and surfaces
ConditionalCheckFailedException. mutate() then re-reads and re-runs the change against
its OWN write.

- start() (rename, merge, every "Not on the list" action) and runAgain(). The Put of
  lastRewrite {J, running} lands, then answers 500, and the SDK retry gets CCF. mutate
  re-reads, and refuseWhileHeld sees J - its own, fresh - and throws 409
  org_rewrite_running carrying its own lastRewrite. enqueueOrFail never runs, so:
  - the admin is told "Another update is still running";
  - Settings polls "Updating records: clearing Metro HA." for 15 minutes;
  - every other rewrite is refused for those 15 minutes;
  - then it shows "stopped responding" and offers Run again (which then works).
  A rename's or merge's list change is already applied while its records wait.
- acquireForCleanup() prints REFUSED for its own lock and blocks Settings for 15 minutes.
- add() answers 409 org_name_taken for the entry it just added; remove() answers 404
  org_not_found for its own delete.
- heartbeat, finish and claim are idempotent here, so these are benign. finish logs
  "ignored", and a refused claim that is retried returns not_current without its WARN line.
- Record writers. rewriteOrgFields / rewriteAcceptedAuthorities answer 'skipped' for a
  write that landed.
  - The pass counts `skipped` and appends NO org_name_rewrite (orgRecords.ts:571-576,
    588-595).
  - The cleanup counts skippedOnCondition and appends NO org_name_cleanup
    (clean-org-names.ts:740-749, 779-788). The RUNBOOK's answer to skippedOnCondition is
    "re-run", which finds the record already clean: A3's permanent audit gap, through
    another door, under a log line saying "nothing written".

Evidence: zz-review-R3-BE-2.test.ts. It runs the REAL orgListRepo over a fake document
client whose first Put is applied and then throws ConditionalCheckFailedException (the
SDK retry's view), calling resolveNotOnList(clear "Metro HA") with newId 'job-mine'. Logged
`{"refusal":{"status":409,"error":"org_rewrite_running","holder":"job-mine"},"stored":{"jobId":"job-mine","status":"running"},"enqueued":[]}`.
`expect(refusal).toBeUndefined()` failed. The record-writer half is traced, not run.

Why LOW: rare (DynamoDB answering 5xx after applying a write), self-healing (15 minutes,
then Run again), no record data lost. Not introduced by wave 2; the claim inherits nothing
bad from it.

Fix:
- The list, in one place: in mutate(), on a lost condition, re-read. If the stored item
  deep-equals the item this attempt wrote (version + 1 included - every mutate write is a
  whole-item Put), the write landed: return its result instead of re-running the change.
- The record writers: ReturnValuesOnConditionCheckFailure 'ALL_OLD' (the
  poolNumbersRepo.ts:564-580 precedent). Answer 'written' when the returned item already
  holds `next` on the written fields.

---

## R3-BE-3 | INFO | CONFIRMED | app/scripts/clean-org-names.ts:288-290, :303-306, :514-522

**The dry run's "Not on the list" preview counts a property once per REPEATED unresolved
member.** planUnit pushes one leftover per member, and tallyLeftovers counts each one. A
unit holding ['Smyrna Housing Office', 'Smyrna Housing Office'] yields two leftovers and
prints `x2` for one property. Settings counts it once (orgRecords.ts:457-463, a Set per
unit), and the apply de-dupes the list anyway (unitDuplicatesRemoved 1).
unitAgencyMembersKept counts 2 for one property the same way. The RUNBOOK presents this
list as the preview of the Settings section, reviewed with Sam in step 2.
Evidence: zz-review-R3-BE-3.test.ts logged
`{"leftovers":[{"field":"accepted_authorities","value":"Smyrna Housing Office","resolution":"unknown"},{...same...}],"write":{"expected":[...two...],"next":["Smyrna Housing Office"]},"changes":{"unitDuplicatesRemoved":1}}`;
`expect(plan.leftovers).toHaveLength(1)` failed (got 2).
Fix: de-dupe a unit's leftovers per (field, value) before tallying (and count a kept
agency once per property).

## R3-BE-4 | INFO | PLAUSIBLE | app/src/services/orgRewrite.ts:265-276 ; dashboard/src/routes/orgs/orgCopy.ts:453-456, :517

**A refused claim leaves Settings offering a Run again that cannot work.** The claim
records `failed` with `error: 'org_rewrite_target_gone: <why>'`. Settings shows
"The last update failed: clearing Metro HA." and offers admins Run again (canRunAgain: any
failed rewrite that is not the cleanup's). runAgain applies the same revalidationProblem to
the same list, so it is certain to answer 409 org_rewrite_target_gone. The stored reason
is never shown, because rewriteStatusText ignores `error` and nothing else reads it.
Consequence: one wasted click, after which the copy says "start a new one from the list".
Fix (either side): show the stored reason for an org_rewrite_target_gone failure, or have
canRunAgain skip a failure whose error starts with org_rewrite_target_gone.

---

## Interleavings walked (charge 1)

Each pair of list writes below is two mutate() calls, so they serialize on the version
condition. "Read v / Put v+1" is one attempt.

1. Two deliveries D1, D2 of one message.
   - Both fresh: D1 read v -> Put hb (v+1); D2 read v+1 -> Put hb (v+2). Both claimed.
     Each record's conditional write lands once; the loser finds the value gone (skipped).
     The first finish(done) wins. The other run's next heartbeat reads `done` -> false ->
     lock_lost, no finish. The stored counts are the finisher's only (known, filed).
   - Both after a lapse, concurrent: D1 read v (stale) -> re-validate -> Put v+1. D2 read
     v -> re-validate -> Put fails its condition -> re-read v+1 (fresh, own id) ->
     claimed. On a refusal, D1 writes failed and D2's re-read answers not_current.
   - D2 after D1 finished, or after D1's refusal: not_current, nothing written.
2. A late delivery vs Run again: whichever list write lands first wins.
   - runAgain first (stale -> re-validated -> J2 fresh): claim(J1) reads J2 -> not_current.
   - claim first (hb fresh): runAgain reads a fresh lock -> 409 org_rewrite_running.
3. A late delivery vs a new rewrite starting:
   - start first (refuseWhileHeld passes the stale lock -> J2): claim(J1) -> not_current.
     J1's definition never runs; it was visibly stalled on Settings.
   - claim first: start answers 409 while the pass heartbeats.
4. The cleanup lock sharing the heartbeat:
   - acquireForCleanup vs claim(J1) of a lapsed J1: serialized. The claim answers
     not_current to the cleanup's action, and the cleanup takes only a stale lock.
   - The cleanup's own lapse (a laptop that slept): its next beat, before the next row,
     reads stale -> false -> CleanupLockLostError, PARTIAL. The lock is left running and
     stale (no counts written; Settings says "stopped responding ... re-run the cleanup"),
     and the next acquire passes.
   - Clocks: the cleanup judges its own heartbeat on its own clock, which is consistent;
     cross-host skew is per A10.
5. A pass whose heartbeat write throws:
   - While the lock is fresh the beat throws -> continue.
   - Once stale, heartbeat() answers false WITHOUT a Put, so the next beat stops the pass.
     The window is at most 20 s plus one record.
   - If the heartbeat's READ throws, the window is unbounded (R3-BE-1(b)).
6. Finish after a lapse:
   - finish() checks id and running, not freshness. It is reachable only when the last
     beats threw (R3-BE-1(b)), and then it records done.
   - With a newer owner it is ignored.
   - Recording done instead of leaving the lock stale changes nothing on the records.
7. A list write answered by its own retried attempt: R3-BE-2. The claim is idempotent
   there; start, runAgain and acquireForCleanup are not.

Cleanup counters on every exit path (charge 1):
- done, exit 0: flatCounts (auditFailed and recordsWithBlankValues now included) plus
  listSource, leftoverValues and contactsMissingTypeOrStatus; logged at WARN when
  auditFailed > 0.
- COMPLETED WITH FAILURES, exit 1: the same fields, at WARN; the lock is released failed
  with flatCounts.
- PARTIAL: flatCounts at ERROR; the lock is released failed with flatCounts. A lost lock
  logs PARTIAL and releases nothing.
- Lock release failure after a completed run: flatCounts on the ERROR line; the summary is
  not printed, because the run throws.
- Refused at acquire: nothing read, no counters (correct).
- recordsWithBlankValues: counted after planning, from the plan's write, or from the
  stored row when planning fails. The dry run equals the apply. A write later skipped on
  its condition is counted as planned; the re-run the RUNBOOK asks for recounts it.

All correct. One note: contactsMissingTypeOrStatus is not in flatCounts, so the PARTIAL
line and the lock's counts omit it. A re-run recounts it from the scan, so nothing is
lost.

## Wave-2 rulings and the two ACCEPTs (charge 3)

- **A6 (challenge, scope only).** Complete for a delivery after a lapse: the reviewer's
  interleaving, R2-BE-1 shape (b) (writes before the first beat) and the deleted-target
  shape are all closed, and tested. It does not cover a lapse DURING a pass: shape (a) of
  R2-BE-1 survives as R3-BE-1. The fix is two small changes inside the same design.
- **A7, A8, A9, A10:** agreed. The issue's refs point at the right lines
  (jobs/orgRewrite.ts:108-115, services/orgRewrite.ts:254), and its safety text is
  accurate.
- **R2-BE-5 ACCEPT (units PATCH blind SET): agreed.** I traced every rewrite action. Under
  D5 the PATCH can only add exact names or re-send held values, so whatever its blind SET
  restores is now off the list - the old name of a rename or merge (now a spelling), a
  used or cleared value (junk, or a remembered spelling), or a padded name variant. Each
  shows again in "Not on the list" with a settling action. No case restores a value that
  is silently ON the list.
- **R2-BE-6 ACCEPT (extraction snapshot): agreed.** Extraction writes only a value its
  snapshot resolved to an exact name. After a rename or merge that name is a spelling (a
  match row, settled by Use). After a delete it is unknown. After a kind change it is
  other_kind (Move to Agency). A Clear or Use of an off-list value cannot be undone,
  because extraction never writes an off-list value: it suggests it, and the accept
  re-resolves against the current list (D8).

## Are the wave-2 fixes real (charge 4)

Each test below fails with its fix reverted (traced against the pre-wave code at c15ae9a7^):
- A6 job, "re-validates first": the old job runs the Clear, t-new loses "Metro HA", and
  the outcome is done. Fails.
- A6 job, "re-validates the target too": the old job writes the deleted "Step Up". Fails.
- A6 job, "writes no record before a FRESH heartbeat": with no claim, heartbeatAt stays
  T_START (frozen clock, no beat), so beatAtWrite is [T_START x3]. Fails. Dropping only
  the claim's heartbeat refresh fails it too.
- A6 service, heartbeat on a lapsed lock: the old heartbeat answers true and writes. Fails.
  The claim cases need the new method.
- The two PINs (a late job that re-validates; an on-time job) pass both ways, as PINs
  should. Partial reverts are covered: dropping re-validation fails the two RED job cases,
  and returning `refused` without the failed write fails their toEqual on lastRewrite and
  the follow-up not_current.
- A7: reverting flatCounts drops auditFailed / recordsWithBlankValues from the PARTIAL
  line and the lock counts. Reverting the WARN branch logs the done line at level 30.
  Both fail.
- A8: the old count-before-planning gives 2, not 1. Fails.
- A9: the old othersRemain drops "Step Up" beside a blank. Fails.
- Sanity: orgRewriteJob.test.ts and orgRewriteService.test.ts run green at HEAD (43
  tests). cleanOrgNames.test.ts was not re-run (it needs DynamoDB Local; the gates were
  reported green).

## Areas checked and found clean

- claim(): the not_current / claimed / refused branches; the cleanup action is excluded;
  `at` is computed inside the retryable change; the refusal writes failed, finishedAt and
  error in the same conditional Put.
- revalidationProblem: identical to the pre-wave runAgain checks (target name and kind,
  split's agency half, from-text vs names of the stored fields' kinds, the toName
  exception); runAgain's behavior is unchanged.
- Staleness boundary (age >= 15 min = lapsed) is the same in heartbeat, claim,
  refuseWhileHeld, refuseWhileRewritingName, refuseWhileRewriteRuns and the dashboard's
  isRewriteStalled.
- Writers of lastRewrite / heartbeatAt: start, runAgain, claim, heartbeat, finish,
  acquireForCleanup, and seeds (dev only). A lapsed lock becomes fresh again only through
  claim (re-validated) or runAgain (re-validated, new id).
- While a job's lock is fresh, every path that creates a list NAME is refused: an add of
  a from-text, rename / merge / resolve, kind change, delete. Spellings never create
  names, and checkNewName refuses a name equal to any existing spelling.
- The job's not_current / refused / claimed handling, the empty-fields path, finish
  failures; it never rethrows.
- Readers of lastRewrite.error: the dashboard never renders it, so the claim's new value
  shape breaks no reader.
- The version bumps from heartbeats and the claim: no dashboard logic keys on `version`.
- e2e: no spec drives a stalled rewrite; the lane runs jobs in-process, deferred
  (e2e/fixtures/orgFixture.ts:117-121).
- SQS consumer (sqsJobConsumer.ts:126-129): no visibility extension, and the consumer
  awaits its batch. A long pass is redelivered only to another worker, where the claim
  turns it into a concurrent run of the same definition (safe).
- Wave-2 cleanup code: flatCounts on every log line and the lock; the WARN done line;
  contactKeepsBlank / unitKeepsBlank on success, failed-plan and abort paths; planUnit's
  othersRemain over non-blank, non-agency members.
- Broadcasts: a stored filter is resolved only in the route's two re-checked branches;
  the sent-share preview keeps its history.
- The extraction prompt block (orgListBlock.ts): one line per name, TRANSCRIPT excluded,
  budgeted, read once per run before the call; missedCallAutoText D15 treats '' and
  whitespace as absent.
- Observation, no finding: the claim re-validates only a LAPSED lock, judged on the
  worker's clock, while the add guard is judged on the API's. Skew between the two hosts
  opens a window as wide as the skew (milliseconds on AWS). Re-validating on EVERY claim
  is free - it passes for every definition a fresh lock has protected - and would remove
  the boundary entirely.
