# R2-BE - adversarial re-review, round 2, BACKEND half (after fix wave FW-A)

Reviewer: R2-BE. Branch feat/clean-org-names (merge base d839494a), app/ only, read
plan-blind per the standing charter. Inputs: R1-ADV-BE.md (and FE-3 of R1-ADV-FE.md),
R1-adjudications.md (A1-A5), the FW-A diff (5 commits, 1575a305..155d5e36) and the
whole branch diff, with the repository swept for other readers and writers.

Covered, in the charge's order:
1. A fresh hunt over the state the branch changes: the org-list item and its D11 lock
   (orgListRepo, OrgNamesService, OrgRewriteService incl. start/runAgain/heartbeat/
   finish/acquireForCleanup), the three record fields and every writer (contacts PATCH,
   units POST/PATCH, extraction apply, suggestion accept + journal guard, importer,
   seeds, dev fixture, cleanup, org.rewrite job + pass), the SQS consumer path, the
   organizations router (auth, routing order, input bounds), broadcasts D5/D7,
   missedCallAutoText D15, the landlord timeline's unit-audit reader.
2. The FW-A diff read cold, line by line (A1 orgNames.ts, A2 contactsRepo + fake, A3/A5
   clean-org-names.ts + RUNBOOK, the new tests, the three filed issues).
3. The adjudications.
4. Whether each fix's test would fail with its fix reverted.

Counts: CRITICAL 0 | HIGH 0 | MEDIUM 1 | LOW 1 | INFO 5.
Reproduced (CONFIRMED) with throwaway tests run alone and deleted by exact name:
R2-BE-1 (zz-review-R2-BE-1.test.ts), R2-BE-2, R2-BE-3, R2-BE-4 (zz-review-R2-BE-2.test.ts,
no database - a fake doc client answered the Scans). The rest are PLAUSIBLE (traced).

---

## R2-BE-1 | MEDIUM | CONFIRMED | app/src/jobs/orgRewrite.ts:85-101 ; app/src/services/orgRewrite.ts:182-191 ; app/src/services/orgRecords.ts:496-516

**A1 closes the add-during-rewrite hole only while the lock is FRESH; an org.rewrite run
that starts (or keeps writing) after its lock lapsed executes its definition without the
re-validation Run again performs, and rewrites away a name that became an exact list name
in the meantime.** The pass's PRECONDITION (orgRecords.ts:35-40) is guaranteed by the
lock: while `lastRewrite` is running with a heartbeat under 15 minutes, rename/merge/
resolve are refused (start), delete and kind change are refused (orgNames.ts:165-168), and
since A1 an add of a from-text is refused (orgNames.ts:178-183). All three tests use
`isOrgRewriteRunning` (orgNames.ts:136-139), i.e. FRESHNESS. But the job checks only
`jobId` and `status === 'running'` at start (jobs/orgRewrite.ts:85-90) - never freshness -
and `heartbeat()` revives a lapsed lock as long as the id matches (orgRewrite.ts:182-191).
Run again, the path the page offers for exactly this state, re-checks that no from-text
has become a listed name (orgRewrite.ts:469-479); the original queued message does not.

Scenario (concrete interleaving):
1. T0: admin Settings > Not on the list > housingAuthority "Metro HA" > Clear. lastRewrite
   {J1, running, heartbeatAt T0, fromTexts ["Metro HA"]}; org.rewrite {J1} queued.
2. The worker does not pick J1 up for 16 minutes (worker down / crash-looping / a backed-up
   single consumer that awaits each batch, sqsJobConsumer.ts:129).
3. T0+16m: the lock has lapsed, so A1 lets VA add housing authority "Metro HA" (201); D5
   then accepts "Metro HA" as an exact name and the VA saves tenant t-new with it.
   (Run again would now be refused 409 org_rewrite_target_gone - and that refusal leaves
   lastRewrite as J1/running, so the queued J1 stays runnable.)
4. J1 is delivered: id matches, status running -> the Clear pass REMOVEs "Metro HA" from
   t-new (an exact list name D5 just accepted), audits it as the admin's clear, finishes done.
Same root cause, two more shapes (PLAUSIBLE, traced): (a) a pass whose heartbeat writes
fail for 15 minutes keeps writing (orgRecords.ts:505-510 continues on a failed beat) while
every guard above is off, and its next successful beat revives the lock; (b) a late job
writes for up to 20 s before its first heartbeat (lastBeat starts at pass start,
orgRecords.ts:496), during which even a NEW rewrite can start and both passes write. The
lapsed-lock window also admits delete/kind change, so a late 'use'/'move' can write a
toName that was deleted meanwhile (Run again's check (1) would have refused it).

Evidence: zz-review-R2-BE-1.test.ts (fake world, real OrgNames/OrgRewrite/OrgRecords
services and real runOrgRewriteJob, fake Date). Logged:
`{"freshRefused":true,"d5":{"ok":true,"value":"Metro HA"},"runAgainRefusal":{"error":"org_rewrite_target_gone"},"outcome":"done","counts":{"housingAuthority":2,...},"listed":true,"tNew":"(removed)","lockAfter":{"status":"done",...}}`
Assertion `expect(tNew?.['housingAuthority']).toBe('Metro HA')` failed: received undefined.
Corroboration in the suite itself: orgRewriteJob.test.ts runs every case with a lock whose
heartbeat is ORG_T0 (2026-10-06T00:00Z) on the real clock - a lapsed lock - and the job
runs to `done`; nothing tests the job against a stale lock.

Fix (small, keeps A1's PINs valid): give the job an atomic claim before its passes - one
list mutate that (a) answers not_current unless lastRewrite is this id and running, (b)
when the heartbeat is STALE, applies runAgain's checks (1) and (2) (extract them into one
helper) and, on a refusal, finishes the rewrite failed so the queued message can never
run it, and (c) writes a fresh heartbeat. Make `heartbeat()` answer false when the stored
heartbeat is already stale (a lapsed lock is no longer the caller's; the pass stops,
Settings offers Run again, which re-validates). Start the pass's beat clock at 0 so the
first record refreshes the lock. Alternatively R1's original suggestion - a self-guarding
pass that refreshes the field's listed names at every heartbeat and skips exact names -
closes this and the cleanup residual at once.

---

## R2-BE-2 | LOW | CONFIRMED | app/scripts/clean-org-names.ts:463-474 (flatCounts), :553-557, :568-573, :781-782, :882

**The fix wave's new counters do not reach the abort path or the lock.** `auditFailed`
(A3) and `recordsWithBlankValues` (A5) live on the result and in reportCleanupRun's
`fields` (the done / COMPLETED WITH FAILURES lines) and formatSummary, but `flatCounts`
was not extended, so (1) the PARTIAL ERROR line - the only summary an ABORTED apply prints,
because the CLI prints formatSummary only on success (:882) - omits both; (2) the lock's
stored `counts` (lastRewrite.counts on the org-list item, the Settings status) omit both;
(3) the "COMPLETED but the lock could not be released" ERROR line omits both. An abort is
exactly when the RUNBOOK sends the operator to re-run, and a re-run can never write the
missing events (the records are already clean) - the very gap A3 exists to surface. The
RUNBOOK (step 4) says the count is "on the done line and in the printed summary"; an
aborted run has neither. Also: with auditFailed > 0 the run still logs its done line at
INFO (:781) and exits 0, so a level-filtered log view does not show the gap.

Scenario: apply; contact c-1's write lands and its org_name_cleanup append throws (counted,
WARN); contact c-2's write throws ProvisionedThroughputExceededException -> abort.
Evidence: zz-review-R2-BE-2.test.ts test 1. Logged
`{"aborted":"ProvisionedThroughputExceededException","warnGap":1,"partialHasAuditFailed":false,"partialRecordsWritten":1,"lockCounts":{...no auditFailed...}}`;
`expect(partial).toHaveProperty('auditFailed', 1)` failed.

Fix: add `auditFailed` and `recordsWithBlankValues` to flatCounts (then every log line and
the lock's counts carry them), and log the done line at WARN when auditFailed > 0. One
test on the abort path.

---

## R2-BE-3 | INFO | CONFIRMED | app/scripts/clean-org-names.ts:685 vs :196

**`recordsWithBlankValues` counts a whitespace-only agency that the same run overwrites.**
The count is taken before planning (:685); planContact treats a whitespace agency as FREE
for a move (:196 `nextAgency.trim() === ''`), so a contact { housingAuthority: "VASH",
agency: "  " } is moved and its agency SET to the VASH name - yet it is counted as a record
"holding a whitespace-only ... value", which the summary and RUNBOOK say "the cleanup leaves
as it is". The operator is sent to investigate a record that is already clean.
Evidence: zz-review-R2-BE-2.test.ts test 2: written `{"housingAuthority":null,"agency":"HUD-Veterans Affairs Supportive Housing (HUD-VASH)"}`,
`recordsWithBlankValues: 1`; `expect(...).toBe(0)` failed.
Fix: count blanks from the plan's outcome (a blank field the write does not replace), or
count after the write. (The rewrite job, by contrast, treats a whitespace agency as a
conflict for Move/Split - orgRecords.ts:287,328 - a harmless inconsistency, expected 0.)

## R2-BE-4 | INFO | CONFIRMED | app/scripts/clean-org-names.ts:264,277-283

**A blank member defeats "drop an agency unless that would empty the list".** planUnit
keeps a '' / whitespace member as a non-agency step (:264), so `othersRemain` (:277) is
true and the agency is dropped: `['Step Up', '']` becomes `['']` - a list whose only
member is blank (no authority on the property, and nothing left for "Not on the list",
which skips blanks). Evidence: zz-review-R2-BE-2.test.ts test 3: `{"next":[""],"changes":{"unitAgencyMembersDropped":1},"leftovers":[]}`.
Fix: compute othersRemain over non-blank, non-agency members. Expected 0 such units
(A5 counts them), so INFO.

## R2-BE-5 | INFO | PLAUSIBLE | app/src/routes/units.ts:1386-1411 then :1438 ; app/src/services/orgRecords.ts:569

**A property edit can silently undo a concurrent rewrite of its list.** The units PATCH
reads the stored list (consistent), passes members it "already holds" unchecked, and then
writes the WHOLE list with a blind SET (units.update, only attribute_exists). The pass's
write is conditional, but the human write is not. Interleaving: (1) PATCH pre-read of P =
["AHA"]; the request carries ["AHA", "Jonesboro Housing Authority"] ("AHA" passes as held);
(2) admin's "Use Atlanta Housing Authority" pass writes P = ["Atlanta Housing Authority"]
(its condition holds); (3) the PATCH writes ["AHA", "Jonesboro Housing Authority"]. The
rewrite reports done, P holds "AHA" again and reappears in "Not on the list". Millisecond
window; the codebase accepts the same read-modify-write class for media (units.ts:1412-1427).
May already be among the residual races ruled earlier (U1/U2/I1, not visible to this
reviewer). Fix if wanted: condition the PATCH's list write on the list it checked.

## R2-BE-6 | INFO | PLAUSIBLE | app/src/jobs/extraction.ts:565,586,618 ; app/src/services/extraction/apply.ts:281-283,500

**An extraction run resolves against a list snapshot taken before its model call (seconds
to tens of seconds) and writes unconditionally**, so a rename / merge / delete that starts
and finishes inside that window is followed by a write of the OLD name (now a spelling, or
gone). The record then shows in "Not on the list" (resolution match - one Use settles it)
and a blast on the new name misses it until then. The importer (one snapshot per run) has
the same shape over a longer window. Possibly a ruled residual; a cheap guard is to re-read
the list (one GetItem) just before apply and re-resolve the housingAuthority op.

## R2-BE-7 | INFO | PLAUSIBLE | app/scripts/clean-org-names.ts:418-425 ; app/src/services/orgRewrite.ts:171,176-179,492-505

**The D11 lock compares timestamps written by three hosts' clocks; the cleanup's is the
operator's machine.** buildCleanupDeps builds the lock service with the default wall clock,
so the cleanup's acquire / heartbeat stamps and its staleness test use the laptop clock,
while the API and worker use the servers'. A laptop clock more than 15 minutes BEHIND makes
its fresh lock look stale to the API (renames/merges start mid-apply; the apply then stops
PARTIAL at its next beat); more than 15 minutes AHEAD makes a running job's fresh lock look
stale to acquireForCleanup, which takes it over - the job stops lock_lost without
finishing, its rewrite is left partial and is no longer re-runnable (lastRewrite is the
cleanup's; a rename's leftovers are then healed by the cleanup's own spelling mapping, a
Clear's or Move's are not). The dashboard half fixed the same trust problem for the
browser (B3). Fix: the
cleanup refuses to start when the local clock differs from the AWS response Date (the STS
call the account guard already makes) by more than a minute.

---

## Adjudications challenged

- **A1, narrow form** (refuse an add of a running rewrite's from-text): agreed as far as it
  goes, but the lock it relies on can lapse while a run is still pending or writing -
  R2-BE-1 reproduces the same data loss R1-ADV-BE-1 reported through the lapsed-lock
  window, and shows Run again's refusal does not stop the queued message. Extend the fix
  to the job start and heartbeat (R2-BE-1 fix), or take R1's self-guarding pass.
- **A3, exit path unchanged**: acceptable, but then the gap must reach every summary the
  operator sees, including the abort path and the lock (R2-BE-2); log the done line at WARN
  when auditFailed > 0.
- **Filed issue org-rewrite-single-message-pass**: its "safe by design" claim holds for a
  visibility-timeout redelivery (the first run still heartbeats), not for a delivery after
  the lock lapsed - note R2-BE-1 there or fix it.
- A2 (unconditional REMOVE of the stamp in the one repo point), A5 count-only, the A4 FILE
  rulings (R1-ADV-BE-3, -5, FE-10) and the R1-ADV-BE-6 ACCEPT: agreed.

## Are the five fixes real?

- A1: real. orgNamesService RED cases reject 409 only through refuseWhileRewritingName
  (without it `add` resolves); organizationsApi case asserts 409 then 201. Normalization is
  the pass's (`normalizeOrgText`); a from-text normalizing to '' (the pass's exact path)
  cannot collide because checkNewName refuses a name normalizing to '' first. Clock:
  wall clock (Date.now) against heartbeats written with the services' wall clock - right in
  production; but the check is only as good as the lock's freshness (R2-BE-1). The PIN
  "add goes ahead once the lock is stale" is compatible with the R2-BE-1 fix.
- A2: real. Parity test runs the fake and DynamoDB Local; with the REMOVE reverted the
  stamp survives and `toEqual` fails in each half. Blast radius checked: the only readers
  are the dashboard badge (TenantFile/suggestionTargets/AutoBadge), the contacts PATCH
  provenance clear and the suggestion-accept attribute guard (guardForPatch puts the stamp
  in the guard, but the stamp is now removed only together with housingAuthority, whose own
  guard already fails - no new failure mode); '#ha_source' is used in the UpdateExpression
  (no unused-name ValidationException); REMOVE of an absent attribute is a no-op (existing
  move cases with no stamp still pass). No e2e asserts on the badge after a rewrite.
- A3: real. With the try/catch reverted the it.each run throws 'Rate exceeded' and the
  result assertion never runs. Gap: no test of the abort path (R2-BE-2).
- A5: real (`recordsWithBlankValues: 5` and the summary line fail without it). Corner:
  R2-BE-3.
- A4: three issues filed with the template's frontmatter; no code.

## Areas checked and found clean

- Every other path that creates a list NAME during a fresh-lock rewrite: rename, merge,
  resolve add are rewrites (refused while held); changeKind/remove refuse; spellings never
  create names; seeds/dev fixture are dev-only.
- A1 placement inside list.mutate: the check and the write see one item; a concurrent
  start() loses or wins by version, never both.
- rewriteOrgFields after A2: condition only on #ha/#ag; all three callers' REMOVEs are
  machine value removals (Clear, Move to Agency both branches, cleanup move).
- Suggestion accept (D8): value allowed only as the text's resolution or a candidate, checked
  before the claim; the dashboard keeps the AI text fixed in suggestion mode, so an added
  name always resolves; valueKey compare on completed rows and claim races.
- Importer: fill-only housingAuthority/agency via if_not_exists; units only get resolved names;
  machine writes never stamp updated_at, so re-imports cannot revert a settle with junk.
- Broadcast audience: resolved only in routes/broadcasts.ts (D7 re-check before resolve);
  the loop drops non-tenants, so a Move to housing authority on a partner cannot reach a blast.
- Organizations router: Express 5 forwards async errors; route order has no shadowing;
  admin gates on spellings/name/kind/merge/delete/resolve/run-again; /check bounded to 200
  chars; names/spellings bounded before compound/edit-distance work.
- Writers of housingAuthority/agency/accepted_authorities outside the diff: none (triage
  parser, public intake, unit routes beyond POST/PATCH, contact create checked).
- Audit SK collision-safe (`ts#rand`); the landlord timeline's unit-audit reader filters to
  LANDLORD_FEED_TYPES, so the new event types never render there (they only occupy the
  per-unit read budget, as unit_updated already does).
- missedCallAutoText D15 and its operator hint (TemplatesSection) changed together.

Other observations (no finding): routes/contacts.ts:644-647 still says nothing
machine-writes `agency` (the job, cleanup and importer now do; no behavior depends on it).
The job never rethrows, so a transient read failure at job start leaves the rewrite
"running" until it goes stale and someone clicks Run again (15 minutes), by design.
