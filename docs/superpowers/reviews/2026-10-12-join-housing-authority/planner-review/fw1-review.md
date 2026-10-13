# Planner fix wave 1 - fresh independent review

Branch `feat/join-housing-authority`, worktree `W:/tmp/join-housing-authority`, fix wave
`09acd16b..e16d408b` (units A and B). Reviewer: fresh opus child, cold on the code. Inputs:
`.superpowers/review/fw1-diff.txt`, `adjudications.md` (FW-1..FW-5), `fix-wave-1-decisions.md`,
spec revision 5 (D10, D12), `fw1-unitA-report.md`, `fw1-unitB-report.md`. Code cited at
HEAD `e16d408b`. Nothing in the worktree was edited except this file; no npm test, no e2e,
no backfill run, no git or docker action.

## Verdict

0 CRITICAL, 0 HIGH, 3 MEDIUM, 4 LOW, 5 INFO. FW-2, FW-3, FW-4, FW-5 CONFORM; FW-1 is
PARTIAL (F1); the FW list's "rehearsal expected output updated" item is MISSING (F3).
The tests are strong: 31 of 31 backfill mutants and 16 of 17 dashboard mutants are killed
by the real, unedited test files; the one survivor is a LOW test gap (F7).

## 1. Defects

### F1 [MEDIUM] [CONFIRMED] A --skip lead whose history read fails on --apply records no exclusion, is listed as a TARGET, and the RUNBOOK's own step 4 then writes it

Walk (`app/scripts/backfill-join-housing-authority.ts`):
1. FW-1 made `leftOutReasonFor` read a --skip lead's WHOLE history before it returns
   `skipped` (:593-595), so a --skip lead can now fail the read (it never could before).
2. The run loop's catch (:758-765) handles every read failure the same way: `failed += 1`,
   the lead is pushed to `report.targets` as `read_failed`, and `continue`. No exclusion is
   appended (the append is only reached at :775 for a `skipped` verdict), and the lead is
   NOT in `leftOut`.
3. The apply report therefore prints it under `Leads given "Atlanta Housing Authority"`
   (:346) with `- FAILED: nothing written (an ERROR line names this contactId); re-run`
   (:282) - nothing says it was skipped or that its exclusion is unrecorded.
4. RUNBOOK.md:483 says "fix the cause and re-run"; RUNBOOK.md:480 (step 2) says to keep
   the --skip value only "until the first --apply"; RUNBOOK.md:489 (step 4) says "Re-run the
   dry run (the `--skip` value is no longer needed) ... A lead that shows up again had its
   write SKIPPED or FAILED in step 3: apply again". The step-4 dry run lists the lead as a
   target (no exclusion), and "apply again" without --skip writes Atlanta Housing Authority
   to the lead the operator excluded - exactly the A4 hazard FW-1 exists to close.

Evidence: a throwaway test (scratch, in-memory fakes, REAL unedited module) asserted each
step and PASSED: step 3 apply with `--skip c-skip` and a throttled history Query printed
`  Lead c-skip ... contactId c-skip  - FAILED: nothing written (an ERROR line names this
contactId); re-run` under the "Leads given" header, appended 0
`housing_authority_backfill_excluded` events, `leftOut` empty; step-4 dry run without
--skip: `c-skip` `would_write`; apply without --skip: `c-skip` written with Atlanta Housing
Authority. No test in `app/test/backfillJoinHousingAuthority.test.ts` covers a --skip lead
whose read fails (unit A worry 1 saw the symptom, not the step-4 path).

Fix (small): in the catch at :758, when `opts.skip.has(lead.contactId)` and `opts.apply`,
push the lead to `leftOut` as `skipped` with `exclusionFailed: true` (the existing
"keep it in --skip and re-run the apply" line, :287-288) instead of a target line; in a dry
run push it as `skipped` too (its reason is known without the history). Add a test.
Optionally RUNBOOK step 4: "a lead you named in --skip that shows up as a target: put it
back in --skip and re-run step 3".

### F2 [MEDIUM] [PLAUSIBLE - needs Cameron's ruling] A pending suggestion whose value IS "Atlanta Housing Authority": "accept or dismiss it first" - and dismissing it makes the next run write the value staff dismissed

Walk: the reason (:275, RUNBOOK.md:461) tells staff to accept or dismiss on the contact page,
and RUNBOOK.md:461 promises "once dismissed, the next run lists the lead as a target again".
A dismissal deletes the `sugg#` row and writes a `dism#<contactId>#housingAuthority#<norm>`
tombstone (`app/src/repos/extractionRepo.ts:722-737`, real flow
`app/src/services/suggestionResolution.ts:255-263`) plus `ai_suggestion_dismissed`
`{ actor, target }` - no value. `touchesHousingAuthority` returns false for it (:176) and the
script never reads tombstones, so the lead becomes a target and gets Atlanta Housing
Authority. For an AHA-valued suggestion, Accept and Dismiss therefore end the same way, and
a dismissal - staff saying "not Atlanta" - is overridden. The extraction suggests (rather
than writes) an exact list match only when the model chose `suggest` or the write was demoted
(`app/src/services/extraction/apply.ts:290-327`), i.e. exactly when it was unsure, so a
staff dismissal there is meaningful. The same gap covers a tombstone dismissed BEFORE the
run (no pending row at all); that half pre-dates FW-2, but FW-2's instruction now routes
staff into it.

Evidence: throwaway test (real module): dry run printed `... contactId c-aha  - has a
pending housing authority suggestion (Atlanta Housing Authority) - accept or dismiss it
first`; after a dismissal-shaped change (row deleted, `ai_suggestion_dismissed` appended) an
apply wrote Atlanta Housing Authority. The test file pins dismissals as non-blocking
(`UNRELATED_EVENTS` "a dismissed housing authority suggestion (writes nothing)", and the DB
test "a dismissed one is not pending"), so this is by design today.

Options for Cameron: (a) leave out a candidate holding a dismissal of Atlanta Housing
Authority's normalized name (`extractionRepo.hasDismissal(contactId, 'housingAuthority',
normalizeSuggestionValue('housingAuthority', 'Atlanta Housing Authority'))`, one GetItem per
would-be target; RG-2's alias spellings would also count); or (b) reword the AHA case:
"accept it, or set the real authority - dismissing it does not stop this script".

### F3 [MEDIUM] [CONFIRMED] FW-list item "the backfill rehearsal's expected output updated to match" is missing; the plan's rehearsal now hits the new refusal

`adjudications.md` (fix wave list, last bullet) requires the rehearsal's expected output
updated. At `e16d408b` the plan is unchanged (`git diff --stat 09acd16b..HEAD -- docs/`
touches no plan file) and no post-fix rehearsal record exists.
`docs/superpowers/plans/2026-10-12-join-housing-authority.md:8491` (Task 6.3a Step 6) runs
`--apply --skip "rehearsal-lead-skipme,rehearsal-no-such-lead"` and expects exit 0 with
`--skip ids that are not candidates (ignored): rehearsal-no-such-lead`; with FW-1 that apply
REFUSES (exit 1, `these --skip ids name no contact ... rehearsal-no-such-lead`, :734-740) and
Step 7's expectations (:8507-8508) are wrong too. Unit A handed this to the orchestrator
(`fw1-unitA-report.md`, "Next step"). The FW-1/FW-2 behavior (exclusion events, the
`ai_extraction` GetItem, the refusal) has not been exercised through the CLI on a lane.

### F4 [LOW] [CONFIRMED] "its exclusion could not be recorded" can be false - the ambiguity FW-3 removed from writes

`recordExclusion` (:672-684) returns false on ANY append error; a timeout after the Put
landed prints `- named in --skip - FAILED: its exclusion could not be recorded ...` (:287-288)
although it was recorded. Throwaway test (append lands, then throws): the FAILED line printed,
1 exclusion event stored, `failed` = 1. The advice (keep it in --skip, re-run the apply) is
safe and a re-run adds no duplicate, so impact is wording only (unit A worry 3). Suggest
"may not have been recorded".

### F5 [LOW] [CONFIRMED] RUNBOOK step 3 overpromises: only CANDIDATES named in --skip are remembered

RUNBOOK.md:481: "For each lead named in `--skip` it REMEMBERS the exclusion". The code
records only for a candidate whose verdict is `skipped` (:775); a --skip id naming an
existing non-candidate (deleted, not a tenant) is reported "not candidates (ignored)" (:745)
and nothing is recorded. If that lead later becomes a candidate - a deleted lead restored
(restore removes `deleted_at`), or a re-typed lead turned back into a tenant (a
`contact_updated` without `housingAuthority` in `fields` is not authority history) - a run
without --skip writes it. Throwaway test: `--apply --skip c-del` on a deleted lead recorded 0
exclusions; after the restore an apply without --skip wrote `c-del`. Fix: say "each
candidate named in --skip" (RUNBOOK.md:481, :457), and note that a non-candidate is not
remembered.

### F6 [LOW] [PLAUSIBLE] "Pending = the sugg# row exists" misses a CLAIMED resolution journal

`claim` (`app/src/repos/suggestionResolutionRepo.ts:638-690`) deletes the `sugg#` row in the
same transaction that writes the `resolve#<contactId>#<target>` journal (phase `claimed`).
Until the domain effect commits - milliseconds normally, but until lazy recovery or the daily
journal sweep if the process died - `getSuggestion` returns undefined and the lead is a
target. The accept's plan guards `housingAuthority: { exists: false }`
(`app/src/services/suggestionResolution.ts:194-206`, :341); after the backfill writes, the
journal's commit is refused as `superseded_by_human_edit` (:578-585), so a staff accept that
crashed mid-flight is silently replaced by Atlanta Housing Authority. Narrow (needs a crash or
an in-flight accept during the run). Fix if wanted: also GetItem
`resolve#<contactId>#housingAuthority` and treat `state: 'active'` as pending; else accept and
note it beside spec D10's accepted edges.

### F7 [LOW] [CONFIRMED by mutation] Test gap: "No other settle adds an entry" is untested

`dashboard/src/routes/settings/NotOnListSection.tsx:335`
`publicNote = settle.action === 'add' && addKind === 'housing_authority'`. Mutant S1 (drop
`settle.action === 'add' &&`) SURVIVES all 42 tests of `NotOnListSection.test.tsx`. The
negative test "a settle that adds no entry shows nothing new (Move to Housing authority ...)"
uses an AGENCY row, whose `addKind` already starts as `agency` (:263), so it cannot see the
clause. Under S1, Use / Clear / Split / Move to Agency on a housing authority or property
value would show the note. Add a negative on a `housingAuthority` row (Clear or Use).

### INFO

- I1. KindDialog: while usage is loading `blocked` is false, so the note shows and then
  disappears once usage says blocked (`OrgEntryDialogs.tsx:471`; unit B worry 1).
- I2. Suggestion mode: the note is the description of "Yes, add it" only
  (`NewOrgDialog.tsx:151-157`), which is disabled while checking or on a name problem. The
  `<p>` (:262-266) stays visible text in the dialog body, so this is not a disabled-only
  path in practice. Every `aria-describedby` id exists exactly when referenced (same
  `publicNote` condition renders the `<p>`; `useId` per instance - no duplicate ids).
- I3. `auditRepo.listByEntity` is an eventually consistent Query
  (`app/src/repos/auditRepo.ts:122-141`): an apply seconds after another may miss a
  just-appended exclusion and append a duplicate. Benign.
- I4. Spec D10 rev 5 literally says every later run prints "excluded on an earlier run";
  passing the value again prints "named in --skip" (decision 2 precedence). Documented at
  RUNBOOK.md:489. Not a defect.
- I5. A dry run with a typo'd --skip id exits 0 and logs `done` at info level; only the
  report line (:366) flags it. Spec-conformant.

## 2. Backfill paths walked (no defect beyond the above)

- Precedence: skipped > excluded_earlier > signed_up_again > authority_history >
  pending_suggestion (:195-200, :593-600); the suggestion is read only for a lead nothing
  earlier leaves out (:596-598). Several reasons at once print one.
- Exclusion record: one per run per lead (Set-parsed --skip, :837-841; one verdict per lead);
  no append when the history already holds one (:775); dry run appends nothing (:775);
  failed append = left-out FAILED line + `failed` (:776-781); payload `{ field }`, no actor
  (:674); not authority history (:161-179).
- --skip refusal: after the Scan, before any history read or write (:734-740); pointer rows
  excluded from `contactIds` (:530-535) so a pointer id is refused; a deleted contact is an
  existing contact (:535) - reported, not refused; ids split exactly between `missingSkips`
  and `unknownSkips` (:734, :745).
- Pending read: `getSuggestion(contactId, 'housingAuthority', { consistentRead: true })`
  (:598) on the stage's own prefix (`extractionRepo.ts:317-320` honors `deps.env`); any row
  leaves the lead out whatever its value (F2, F6 above for the edges); value escaped (:275).
- Failure wordings: read failure "nothing written ... re-run" (:282) is true (no write was
  attempted); write failure "may or may not have landed" (:283-284, log :648). Exit 1 on any
  `failed` (:376-378); refusal exit 1 via `BackfillRefusedError` (:901-903).
- Report lines: all true except the F1 header placement and the F4 wording.

## 3. RUNBOOK section vs the code, claim by claim

| RUNBOOK.md | Claim | Holds? |
|---|---|---|
| 456-461 | five reasons, ONE printed, first that applies, in this order | HOLDS |
| 457 | `named in --skip` - an --apply also records the exclusion | BREAKS for a --skip lead whose history read fails (F1) |
| 458 | an earlier exclusion leaves the lead out on every later run, with or without --skip | HOLDS once recorded (I3 window aside) |
| 461 | "once dismissed, the next run lists the lead as a target again" | HOLDS literally; harmful for an AHA value (F2) |
| 470 | --apply refuses a --skip id naming no contact; exit 1, nothing written, contacts read; non-candidate (deleted) ids not refused | HOLDS |
| 474-479 | dry-run lines incl. read failure covers the suggestion read, the two --skip id lines | HOLDS |
| 480 | keep --skip "until the first --apply ... From then on every run leaves it out" | BREAKS on F1 |
| 481 | "For each lead named in --skip it REMEMBERS the exclusion" | candidates only (F5) |
| 483 | read failure: no write attempted; exits 1; "fix the cause and re-run" | HOLDS; silent on --skip (F1) |
| 484 | write failure may or may not have landed; dry run tells | HOLDS |
| 485 | exclusion could not be recorded; keep it in --skip | HOLDS as advice; can be false (F4) |
| 489 | step 4: --skip no longer needed; a lead that shows up again: apply again | BREAKS on F1 |
| 492 | cost and exit codes | HOLDS |

## 4. Dashboard D12 surfaces (every caller enumerated)

Callers found by grep of `dashboard/src`: `addOrg` - only `NewOrgDialog.tsx:172`;
`patchOrg({ name })` - `OrgEntryDialogs.tsx:304` (RenameDialog); `patchOrg({ kind })` -
`OrgEntryDialogs.tsx:480` (KindDialog); `resolveNotOnList` - `NotOnListSection.tsx:401`
(SettleConfirm, `add` at :383). `NewOrgDialog` hosts: `OrgListSection.tsx:392`,
`ContactEditForm.tsx:1020`, `ListingEditForm.tsx:597`, `UnitCreateForm.tsx:611`,
`CaseworkerDialog.tsx:414`, `ContactDetail.tsx:1241`. No raw `/api/organizations` call
elsewhere. Server: Add-as-new creates the entry with the row's kind
(`app/src/services/orgRewrite.ts:475`, :525-546); merge/split/move/use add no entry; the
public list publishes names only (`app/src/services/publicOrgList.ts:40-50`). Every add,
rename and kind-into-HA surface carries the line; no agency surface shows it (mutants
N6, R1, K2, S2 killed). Copy is one constant (`orgCopy.ts:96`), ASCII.

## 5. Conformance (FW list, spec revision 5)

| Item | Status | Where |
|---|---|---|
| FW-1 persist --skip (event, later runs leave out, no dup) | PARTIAL | `backfill-...ts:110, 182, 195, 593-595, 672-684, 775-782`; RUNBOOK.md:457-458, 480-481, 489. Gap: F1 (and F5 wording) |
| FW-1 refuse a --skip id naming no contact on --apply | CONFORMS | `:517-535, 734-740, 745`; RUNBOOK.md:470 |
| FW-2 pending suggestion left out, value shown | CONFORMS | `:404-405, 430, 588-601, 273-276`; RUNBOOK.md:461. Edges: F2, F6 |
| FW-3 "may or may not have landed" | CONFORMS | `:228, 282-285, 641-649, 758-764`; RUNBOOK.md:483-484 |
| FW-4 D12 help line | CONFORMS | `NewOrgDialog.tsx:151-157, 248, 262-266`; `OrgEntryDialogs.tsx:291-292, 342, 348-352, 467-471, 503, 518-522`; `NotOnListSection.tsx:266, 335, 462, 470-474`; `orgCopy.ts:96`; e2e `org-lists.spec.ts:85, 641` |
| FW-5 delete `join-repeat-signup-answer-unreachable` + live refs | CONFORMS | file gone; `git grep` outside `docs/superpowers/reviews/` finds no reference (only records and gitignored `.superpowers/` mention it) |
| FW-5 resolve `join-backfill-ignores-pending-authority-suggestion` | CONFORMS | `status: resolved`, `resolved: 2026-10-12`, Resolution paragraph naming `37d02e42` - per `docs/issues/README.md:85-87` |
| RUNBOOK updated | CONFORMS (with F1/F5 wording) | RUNBOOK.md:456-492 |
| Rehearsal expected output updated | MISSING | F3 |
| Tests for each | CONFORMS (gaps: F1 path, F4, F5, F7) | section 6 |

ASCII: no non-ASCII byte on any added line of `09acd16b..HEAD`.

## 6. Tests - mutation proof

Method: each mutant is a COPY of the module in the session scratch dir (its relative imports
rewritten to absolute worktree paths), injected into the REAL, unedited test file through a
throwaway vitest config (the worktree's own config spread, `resolve.alias` on the test's
import specifier, `resolve.dedupe` for the bare packages). Controls (unmutated copies) and
a sanity mutant prove the alias bites. All throwaways deleted afterwards.

Baseline, real config: `app` `test/backfillJoinHousingAuthority.test.ts` 90/90, no SKIPPED
line (DynamoDB Local reachable). Controls: app 90/90; dashboard NewOrgDialog+OrgListSection
85/85, OrgListSection 61/61, NotOnListSection 42/42.

Backfill (31 mutants, all KILLED):

| Mutant | Killed by (count) |
|---|---|
| M00 sanity: authority name changed | 32 tests |
| M01 no --skip refusal | apply-REFUSES test, CLI missing-id test (2) |
| M02 refusal moved after the writes | same 2 |
| M03 pointer row counted as a contact | scanCandidates, apply-REFUSES (2) |
| M04 deleted contact not "existing" | scanCandidates, non-candidate ids test (2) |
| M05 exclusion never recorded | apply, failed-exclusion, pending-suggestion run (3) |
| M06 duplicate exclusion (guard removed) | apply re-run, not-recorded-twice (2) |
| M07 dry run records exclusions | dry-run run, CLI missing-id (2) |
| M08 failed append not counted / M08b not flagged | failed-exclusion test (1 each) |
| M09 exclusion ranked after signed-up-again | pure precedence, DB precedence (2) |
| M10 excluded_earlier removed | 6 |
| M11 history checked before --skip | 4 |
| M12 exclusion counted as authority history | pure "not itself authority history" (1) |
| M13 no suggestion read | 6 |
| M14 suggestion read not consistent | 3 |
| M15 suggestion read for every lead | 4 |
| M15b suggestion ranked over history | 3 |
| M16 wrong suggestion target | 4 |
| M17 suggested value printed raw | escaped-value run test (1) |
| M18 write error as read_failed / M18b write log says "nothing written" | 2 / 1 |
| M19 read failure as write_failed | 2 |
| M20 --skip short-circuits the history read (old behavior) | 4 |
| M21 unknownSkips includes missing ids | dry-run run (1) |
| M22 missing-id report line removed | 3 |
| M23 dry run refuses too | 2 |
| M24 exclusion payload `{}` / M28 payload with actor | apply test (1 each) |
| M25 exclusion for every left-out lead | 4 |
| M26 exclusion-failed suffix removed | 2 |
| M27 missing ids judged against candidates, not contacts | 3 |
| M29 any `housing_authority_backfill*` event is an exclusion | 2 |

Dashboard (17 mutants, 16 KILLED, 1 SURVIVED):

| Mutant | Result |
|---|---|
| N1 NewOrgDialog never / N6 always | killed (4 / 3) |
| N2 note by the `kind` prop instead of the chosen kind | killed (organization-mode test) |
| N3 no button description (suggestion mode) / N4 no Name description | killed (1 / 3) |
| N5 button also described in field mode | killed (2 pre-existing exact-description tests) |
| R1 rename always / R2 never / R3 no description | killed (1 each) |
| K1 ignores blocked / K2 any direction / K3 never / K4 no description | killed (1 each) |
| S1 NotOnList ignores `settle.action === 'add'` | SURVIVED - F7 |
| S2 any kind / S3 never / S4 no description | killed (2 each) |

Untested new paths: F1 (a --skip lead whose read fails), F4 (an exclusion append that
lands then errors), F5 (a --skip non-candidate later becoming a candidate).

## 7. Recommended disposition

- F1: fix in this branch (small, closes a residual A4 path) with a test.
- F2: Cameron's ruling (option a or b), then a micro-fix or a wording change.
- F3: orchestrator updates Task 6.3a's expected output and re-runs the lane rehearsal.
- F4, F5: one-line wording fixes (report text / RUNBOOK) when F1 lands.
- F6: accept and note, or one extra GetItem - Cameron's call.
- F7: add the negative test.
