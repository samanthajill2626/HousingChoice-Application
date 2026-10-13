# Planner fix wave 2 - fresh review (FW2-1..FW2-4)

Reviewer: a FRESH reviewer, cold on this wave. Branch feat/join-housing-authority,
worktree W:/tmp/join-housing-authority, HEAD c7e23d64. Reviewed: the fix diff
(.superpowers/review/fw2-diff.txt, 71663942..HEAD, records excluded) against
adjudications.md (round 2, Cameron's 2026-10-13 ruling, the FW2 list),
adversarial-r2.md sections 1-3, fix-wave-2-decisions.md (binding), spec revision 6
D10 and fw2-report.md. Line numbers are the tree at c7e23d64. Nothing in the
worktree was edited; the script was never run against anything; no npm test, e2e,
session, docker or git-state command was run.

Result: 0 CRITICAL, 0 HIGH, 0 MEDIUM, 2 LOW, 8 INFO. Every FW2 item CONFORMS. Every
mutant of the four rules was killed by the real, unedited test file. Scope holds.
Closing rule: nothing here reopens the wave; one LOW (L2) is a one-line wording fix
the orchestrator may take or leave.

---

## 1. Defects

### (a) Exclusions first - can any write happen while an owed exclusion is unrecorded?

No. Walked in full (script :874-931):

- Order: checkBackfillList (:876, refusals, no contact read) -> keys (:877, pure) ->
  Scan (:878) -> typo refusal (:886-892) -> FIRST PASS (:910-931) -> main loop
  (:933). The first pass touches only --skip CANDIDATES (:913-914), oldest first,
  through the unchanged recordExclusion (:810-831: no-duplicate history read; a
  failed read appends anyway; never throws - the `paging did not advance` throw of
  readWholeHistory is inside its try). The only writes in the pass are exclusion
  appends. If any append failed, :919-930 set leftOut = the unrecorded leads only,
  failed = their count, stopped = true, log the STOPPED warn, print the stop report
  and return - before any other per-lead read and before writeOne is reachable.
- Killed process at every point: during the pass - some exclusions recorded, NO
  housing authority written (writes only exist in the main loop); after the pass -
  every owed exclusion is recorded (an append that returned recorded or
  already_recorded), so any later kill leaves no written target beside an
  unrecorded exclusion. A kill after an append landed but before its response is
  still recorded. The spec D10 rev 6 guarantee holds.
- A --skip lead also left out for another reason: `skipped` has top precedence, so
  it is "left out because of --skip" and its exclusion is owed and appended (spec
  wording); an earlier exclusion is found by the no-duplicate read
  (already_recorded, no second event; test :1603 re-apply, :2099).
- No-duplicate check: holds when the history read succeeds; a failed read appends a
  second (harmless, documented RUNBOOK step 3). auditRepo.listByEntity is not a
  consistent Query (auditRepo.ts:122-140) - a re-apply within a second of an
  append could add a second event; harmless.
- Exit code: failed = unrecorded.length > 0 -> backfillExitCode 1 (:465-467);
  main returns it (:1070). CLI test :2681 pins exit 1 + the printed stop report.
- Every STOPPED line: header (:411-413) - true for this run (no housing authority
  write is reachable before the stop) and deliberately not "nothing was written"
  (other --skip leads' exclusion events may have landed) - correct. Each lead line
  (:427, EXCLUSION_FAILED_SUFFIX :360-361) - true ("may not", an ERROR line does
  name the contactId, :823-826). Footer (:428-429) - see INFO I1 for two loose
  phrases. The unknown-skips line - true. missingSkips cannot appear (an apply
  refuses on them first).

### (b) Dismissed Atlanta - reuse or a drifting copy?

Reuse, with one repeated four-line filter. atlantaDismissalKeys (:245-258) vs the AI
path (apply.ts:279-288 alsoDismissedAs; :825-850 putSuggestionSafe):

- Name key: the AI path's first key is normalizeSuggestionValue(target,
  suggestedValue) where suggestedValue = String(matched.name) (apply.ts:281, :329);
  the backfill's first key is normalizeSuggestionValue(FIELD, BACKFILL_AUTHORITY)
  and the entry it picks has exactly that name (:247). Identical. A staff dismiss
  writes the tombstone under normalizeSuggestionValue(target,
  suggestion.suggestedValue) (suggestionResolution.ts:255-262 plan; repo
  dismissalItemId suggestionResolutionRepo.ts:263-264) - the same key space
  hasDismissal reads (extractionRepo.ts:739-744, `dism#<id>#<target>#<key>`).
- Own spellings: same filter text as apply.ts:282-285 (resolveOrgText over the
  entries with KINDS_FOR_FIELD.housingAuthority, match with the same orgId), same
  de-dup, same order. Shared "AHA" (Atlanta and Augusta, orgStartingList.ts:18,
  :63) resolves `ambiguous` and is excluded in both. A staff-added spelling counts
  (test :864, run test :1965); a spelling normalizing to an existing key is not
  repeated.
- Renamed / missing entry: checkBackfillList refuses before the keys matter
  (:560-566); the name-only fallback is unreachable in a run (m6 below shows the
  run uses the list it read).
- Not reproducible by design: the AI path's model-text key (apply.ts:288
  String(coerced.value)) - see INFO I4.
- Drift: the four filter lines are a copy (apply.ts does not export them; decision
  1 accepts this). Tests pin the derived keys as literal strings (ATLANTA_KEYS, test
  :552-558) rather than against apply.ts behavior - INFO I5.

### (c) In-flight resolution

- Key and read: deps.resolutions.get(contactId, FIELD) (:722) = getJournal,
  consistent GetItem of `resolve#<contactId>#housingAuthority` in ai_extraction
  (suggestionResolutionRepo.ts:257-258, :522-529, :582). Built on the stage doc/env
  (:533).
- States: only `active` and `completed` exist (repo :94-137). `active` covers every
  phase from claimed through domain_applied / activity_* / verdict_attempted (effect
  committed but not completed), a superseded accept still finishing, and an
  abandoned journal (lease expired, still active until recoverAbandoned or the daily
  sweep completes it). A released claim deletes the journal (suggestion restored ->
  pending_suggestion); released_unsafe is `completed`. So `state === 'active'` is
  exactly "in flight or abandoned".
- Test rows: made through the REAL repos - extractionRepo.putSuggestion then
  suggestionResolutionRepo.claim (and .complete for `completed`) (test :725-755), so
  the item shape is the real one; the pure seam uses a minimal cast, which is fine
  because only `state` is read.
- Residual race - LOW L1 below.

### (d) Precedence, reads, failures, exit codes, operator text

- Precedence (decision 3): skipped (no read, :718) -> excluded_earlier ->
  signed_up_again -> authority_history (:719-721) -> resolution_in_progress (:722-723)
  -> pending_suggestion (:724-725) -> dismissed_atlanta (:726-728). Reads 5-7 only
  for a candidate nothing earlier leaves out, in that order, stopping at the first
  hit. CONFORMS (pinned by tests :964, :1179 c-both, :1212 c-pending/c-hist; m4a,
  m4b killed).
- Failures: any throw from the history, resolution, pending or dismissal read lands
  in the main loop's catch (:935-945): read_failed, failed += 1, ERROR line names
  the contactId with all four reads (:942), nothing written, run goes on, exit 1.
  Tests :2009, :2038, :2067.
- Exit codes: 0 clean (warnings included), 1 refused / failed lead / stopped /
  thrown list-or-Scan read / unresolved target, 2 usage - matches spec and RUNBOOK
  :494.
- FW2-4 wording (:785-788): "may not have been written (its housing authority was
  set)" and the log line - true (the write landed before the append).
- RUNBOOK "/join leads: the housing authority backfill" (RUNBOOK.md:450-498),
  checked line by line against the code: the seven reasons and their order (:456-
  463) match REASON_TEXT and precedence; the in-progress recovery advice is true
  (routes/suggestions.ts:116-129 runs recoverAbandoned on the contact page's
  suggestions read; dashboard ContactDetail uses useSuggestions); "keep --skip on
  every run" is stated in step 2 (:482) and every apply/re-run instruction now
  carries "the same --skip value" (:483, :486, :490, :491); "no longer needed" is
  gone; the STOPPED report quoted in step 3 (:490) matches STOPPED_HEADER,
  EXCLUSION_FAILED_SUFFIX and the footer character for character; the FAILED-read
  bullets name all four reads (:478, :485). Cost line (:494): Scan; per candidate
  (a --skip one on an apply only) one history Query per 100 events plus one empty;
  per would-be target, in order and stopping at the first hit, one consistent
  resolution GetItem, one consistent pending GetItem, one GetItem per dismissal key
  ("five on the starting list" - true, test :860 ATLANTA_KEYS has five); on an
  apply one exclusion event per --skip lead not yet excluded, one conditional write
  and one audit event per target - all true. The dismissal GetItem is correctly not
  called "consistent". Exceptions: L2 (exit-code phrase), I1, I6.

---

## 2. Findings

### L1 [LOW, PLAUSIBLE] Reading the resolution record BEFORE the pending suggestion leaves a claim-between-reads window that pending-first would close

- Evidence: script :722-725 read resolve# then sugg#. The claim is ONE transaction
  that puts the active journal and deletes the sugg# row
  (suggestionResolutionRepo.ts:668-692). An accept whose guard finds the field
  changed finalizes superseded_by_human_edit (suggestionResolution.ts:579-584);
  a dismiss writes its tombstone only at domain_applied.
- Scenario: the run reads resolve#<c>#housingAuthority (absent); staff click Accept
  (or Dismiss of an Atlanta value) on that lead's pending housing authority
  suggestion and the claim commits; the run reads sugg# (now deleted, absent), the
  dismissal keys (no tombstone yet) and writes Atlanta Housing Authority. The
  accept then finds the field changed and is refused (staff's choice discarded), or
  the dismiss lands after Atlanta was already written. With the reads in the other
  order the claim cannot slip between them: a claim before the sugg# read leaves an
  active journal for the resolve# read; a claim after it means the suggestion was
  still there, so the lead was already left out.
- Weight: the window is one GetItem round trip, the requester of a live accept is
  told it was refused (refusedByHumanEdit, suggestionResolution.ts:460-467), and
  the ABANDONED case - the substance of adversarial-r2 #3 - is fully covered. The
  order is decision 3's binding read order (precedence 5 before 6, "in that
  order"), and fixing it is not one line (the printed precedence would have to be
  kept apart from the read order). Note, do not fix; if ever touched, read sugg#
  first and resolve# second.

### L2 [LOW, CONFIRMED] RUNBOOK exit-code list says the apply "STOPPED on an exclusion it could not record"

- Evidence: RUNBOOK.md:494 ("1 it was refused, a lead FAILED, the apply STOPPED on
  an exclusion it could not record"). The script's own rule (:359, :806-808) and
  every other line of this section say "may not have been recorded" - an append can
  land and then error (test :1714 proves it does).
- Scenario: an operator reading only the exit-code list believes the exclusion is
  definitely absent; harmless in effect (the action, keep --skip and re-apply, is
  the same) but it is the exact "could not" wording FW2-4 and the earlier waves
  removed.
- Fix (one line, optional under the closing rule): "the apply STOPPED on an
  exclusion that may not have been recorded".

### INFO

- I1. STOPPED footer and RUNBOOK step 3, loose phrases. "The run stopped before
  reading any lead not named in --skip" (:428) and "before it reads any other lead
  or writes anything" (RUNBOOK :483): the contacts Scan has already read every lead;
  what did not happen is any per-lead read (history, resolution, suggestion,
  dismissal). "(an exclusion already recorded is not recorded twice)" (:429) holds
  only when that lead's history read succeeds (a failed read appends a second,
  harmless event - RUNBOOK step 3 says so). "the apply STOPS there" (:483) - it
  first tries every other --skip lead (deliberate, decision 4, test :1693). RUNBOOK
  :490 "The append failed with an error that does not say whether it landed, so the
  apply read no target" - the "so" is the stop, not the ambiguity. No action owed.
- I2. extractionRepo.hasDismissal is an eventually consistent GetItem
  (extractionRepo.ts:739-744); a dismissal committed within about a second of the
  read can be missed. Reused as ruled (the AI path's own check); the implementer
  flagged it too.
- I3. Comments: runJoinAuthorityBackfill's docblock (:870-872) still says "only the
  list read and the contacts Scan abort it" although the exclusion stop (described
  earlier in the same docblock) also ends the run; main's docblock (:1034-1036)
  calls the exclusion stop "stopped before any write" though other --skip leads'
  exclusion events may have been written. Comment-only.
- I4. The AI path also checks the MODEL'S OWN TEXT as a key (apply.ts:288). The
  backfill has no model text (decision 1), so a pre-list dismissal stored under a
  text that resolves to Atlanta only through normalizeOrgText's punctuation folding
  (for example "Atlanta Housing Authority." or "Atlanta-Housing Authority") but is
  neither the name nor a spelling under normalizeSuggestionValue is not seen. The
  AI path itself would not consult it when re-suggesting from the plain name, so
  the backfill matches the AI path's behavior for the value it writes. Accepted.
- I5. Test coupling: the keys are pinned as literals (ATLANTA_KEYS, test :552-558,
  :860) and tombstones are written with hand-normalized keys (test :721-724); no
  test drives apply.ts's putSuggestionSafe to prove the two rules agree, so a
  future change to apply.ts's filter would not fail this file. Acceptable for a
  one-off script.
- I6. RUNBOOK step 4 (:491) lists why a lead "shows up again": it omits a lead that
  was left out for a pending suggestion staff dismissed since (a non-Atlanta value
  - the pending bullet :462 says it then becomes a target), and a SKIPPED lead
  normally cannot reappear (it now holds an authority, is not a tenant or is
  deleted). The instruction given (apply again with the same --skip) is right in
  every case.
- I7. Dead branch: formatBackfillReport's normal path still renders
  `exclusionFailed` (:451), now reachable only through a stopped report, which
  returns at :424-432; its old formatter test was replaced by the stop test (:388).
  Harmless.
- I8. Spec D10's "Safe to re-run" bullet still lists the revision-5 set (a pending
  suggestion, no in-progress or dismissed-Atlanta); the RUNBOOK idempotence list
  (:491) has all of them. Spec text only.

---

## 3. Conformance (spec revision 6 D10, the FW2 list, decisions 1-6)

| Item | Verdict | Where |
|---|---|---|
| FW2-1 exclusions first, stop on a failed append, exit 1 | CONFORMS | script :905-931 (pass + stop), :332 (stopped), :410-432 (stop report), :465-467 (exit); RUNBOOK :482 (keep --skip always), :483 + :490 (first pass, STOPPED report), :491 (step 4 with --skip). Divergence (decision-4 compatible): every --skip lead is tried before the stop; the header says "no housing authority was written" rather than "nothing was written" - both more accurate. |
| FW2-2 dismissed Atlanta, AI path's rule | CONFORMS | :245-258 (keys: normalizeSuggestionValue + resolveOrgText/KINDS_FOR_FIELD, own spellings only), :576-577 + :877 (keys from the list the run read), :726-728 (hasDismissal per key, first hit), :341 (reason text = spec). Repeats apply.ts:282-285 only (decision 1). |
| FW2-3 in-flight / abandoned resolution | CONFORMS | :500 + :533 (dep on the stage), :722-723 (`active` only), :340 (reason text = spec). See L1 (read order, per decision 3). |
| FW2-4 "may not have been written" | CONFORMS | :785-788. |
| Decision 3 precedence and read order | CONFORMS | :718-729. |
| Decision 5 RUNBOOK | CONFORMS (L2, I1, I6 wording) | RUNBOOK.md:456-494. |

---

## 4. Tests - mutation proof

Method: copies of the script in the reviewer's scratch dir (relative imports
rewritten to absolute worktree paths), each run by the REAL, unedited
app/test/backfillJoinHousingAuthority.test.ts through a throwaway vitest config
(the app's own config spread in, plus resolve.alias of
`../scripts/backfill-join-housing-authority.js` to the copy and resolve.dedupe of
the two @aws-sdk packages), one file at a time from W:/tmp/join-housing-authority/app,
against the shared DynamoDB Local (no self-skip line in any run). Throwaways deleted
afterwards.

CONTROL (an unmutated copy through the same alias config): exit 0, 108 passed
(108), no "SKIPPED - no DynamoDB Local" line. Every mutant below exited 1.

| Mutant (script line) | Rule removed | Result | Killed by (examples) |
|---|---|---|---|
| m1a (:919) | the stop: a failed exclusion append is ignored and the run writes | 5 failed / 103 | stop test :1657, tries-every :1693, lands-then-errors :1714, history+append fail :1798, CLI exit 1 :2681 |
| m1b (:911 + main loop) | no first pass; exclusion appended in the oldest-first loop (the pre-wave interleaving) | 6 failed / 102 | exclusions-FIRST order test :1603 (younger --skip lead) plus the five above |
| m1c (:921) | the stop counts no failure (exit 0) | 5 failed / 103 | :1657, :1693, :1714, :1798, CLI :2681 |
| m1d (:911) | a dry run records exclusions too | 3 failed / 105 | dry run writes nothing :1425, dry run no --skip read :1818, CLI typo dry run :2654 |
| m1e (:917) | stop at the FIRST failed append | 1 failed / 107 | tries-every :1693 |
| m2a (:723) | resolution record never consulted | 3 failed / 105 | pure :964, store :1179, run :1928 |
| m2b (:723) | ANY record (completed too) leaves the lead out | 3 failed / 105 | pure :964, store :1179, run :1928 (the completed lead) |
| m2c (:722) | wrong target key | 4 failed / 104 | :964, :1179, :1928, dry run :1425 (resolve# key) |
| m3a (:726-728) | no dismissal check | 7 failed / 101 | pure :937, store :1212, run :1965, read-failure :2009, ... |
| m3b (:248-251) | every spelling counts (shared "AHA" too) | 4 failed / 104 | keys :860, :864, run :1965 (c-aha-only), dry run :1425 |
| m3c (:253) | name only, no spellings | 5 failed / 103 | keys :860, :864, run :1965, :2009, :1425 |
| m3d (:254) | keys not normalized | 5 failed / 103 | keys :860, :864, run :1965, :2009, :1425 |
| m3e (:726-728) | only the first key checked | 6 failed / 102 | pure :937, store :1212, run :1965, :2009, ... |
| m4a (:722-725) | pending read before the resolution read (decision 3 order) | 4 failed / 104 | pure :882, :964, store :1179 (c-both), dry run :1818 |
| m4b (:724-728) | dismissal read before the pending read | 3 failed / 105 | pure :882, store :1212 (c-pending), dry run :1818 |
| m5 (:786) | FW2-4 wording reverted to "could not be written" | 1 failed / 107 | :2252 |
| m6 (:877) | keys not taken from the list the run read | 3 failed / 105 | run :1965 (staff-added spelling), :2009, :1425 |

(A first m3b attempt was a syntax error - "no tests"; the corrected mutant m3b2 is
the row above.) Note m4a: the tests pin decision 3's read order, so the L1
reordering would need its expectations changed by decision, not by a fix child
alone.

Not covered by any test (not required): a journal in a later active phase
(domain_applied etc.; only `state` is read, so equivalent), and equivalence with
apply.ts's own key derivation (I5).

---

## 5. Scope

`git -C W:/tmp/join-housing-authority diff --name-only 0eb44652 HEAD` lists exactly:
RUNBOOK.md, app/scripts/backfill-join-housing-authority.ts,
app/test/backfillJoinHousingAuthority.test.ts, and nine docs/ files
(docs/issues/e2e-blank-document-after-contact-navigation.md, seven
planner-review/*.md records, the spec). This wave alone (71663942..HEAD) touched
the three scoped files plus planner-review/fw2-report.md. No app/src change.
CONFIRMED. Added lines in the three files: 0 non-ASCII characters.
