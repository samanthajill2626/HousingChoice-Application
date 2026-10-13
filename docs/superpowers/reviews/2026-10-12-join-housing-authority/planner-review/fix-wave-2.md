# Planner fix wave 2 - handback (orchestrator)

Input: `planner-review/adjudications.md` (round 2, Cameron's 2026-10-13 ruling, the fix wave 2
list), `adversarial-r2.md` findings 1-3, spec revision 6 (@b40ee312) D10. AUTO mode; every
child a fresh foreground opus agent. Decisions: `fix-wave-2-decisions.md` (71663942).

STATE: code complete and freshly reviewed (0 MEDIUM+). GATES: DEFERRED to the planner's
post-merge run (the planner's instruction: Cameron merged fix/caseworker-integrity and
fix/public-rate-limit-key into main, 154 commits ahead; the planner merges main into this
branch, adjudicates conflicts and runs all five gates on the merged tip). This orchestrator
ran no gate, did not merge main and started no e2e session for this wave. UNMERGED.

Scope: `git diff --name-only 0eb44652 HEAD` lists, outside docs/, ONLY
`RUNBOOK.md`, `app/scripts/backfill-join-housing-authority.ts` and
`app/test/backfillJoinHousingAuthority.test.ts`; everything else in that diff is under docs/
(records, the spec, one issue note). No app/src, dashboard or e2e change.

## 1. The list, item by item

| Item | Result | Commits |
|---|---|---|
| FW2-1 exclusions first | SHIPPED. On `--apply`, after the Scan and the typo refusal and BEFORE any other per-lead read or any write, a first pass records the `housing_authority_backfill_excluded` event for every candidate named in `--skip` (no duplicates; a failed history read still appends). If ANY append fails, the run STOPS: no target read or written, report header `STOPPED - no housing authority was written for any lead: the exclusion of each lead below, named in --skip, may not have been recorded (oldest sign-up first; dates are UTC):`, the leads listed, exit 1. Every `--skip` lead is tried before the stop, so the report lists every failure at once. | 394fb757 |
| FW2-2 dismissed Atlanta | SHIPPED, Cameron's ruling. Keys exactly as the AI suggest path builds them (`putSuggestionSafe`, apply.ts): `normalizeSuggestionValue` over "Atlanta Housing Authority" and over each of its spellings that `resolveOrgText` resolves to that entry ALONE (from the org-list item the run reads - five on the starting list; the shared "AHA" does not count), each checked with the extraction repo's `hasDismissal`. The functions are called, not copied; only apply.ts's four-line spelling filter is repeated (it is not exported, and exporting it would touch app/src). Reason: `staff dismissed an Atlanta Housing Authority suggestion`. | a2d86929 |
| FW2-3 in-flight resolution | SHIPPED. `suggestionResolutionRepo.get(contactId, 'housingAuthority')` (consistent read of `resolve#<contactId>#housingAuthority`); `state === 'active'` - claimed, effect committed but not completed, or abandoned - leaves the lead out: `a suggestion accept or dismiss is in progress - re-run after it finishes`. A completed journal does not. Test rows are made through the real claim/complete repo calls. | 172d3c33 |
| FW2-4 wording | SHIPPED. The post-write warning and its log line say the `housing_authority_backfill` event "may not have been written" (the authority WAS set). | 2c78df7f |
| RUNBOOK | UPDATED: keep the same `--skip` value for EVERY run on that environment, always (dry runs, applies, re-runs, retries); "no longer needed" removed and every "apply again" carries it; the two new reasons in precedence order; the exclusions-first stop and its report; FW2-4's wording; the cost line; the FAILED-read line names all four reads (orchestrator, b652ea6e); the exit-code list says a stopped apply's exclusion MAY not have been recorded (review L2, 263b396b). | d0ea19d1 b652ea6e 263b396b |

Reason precedence (decision 3; one reason printed, every reason leaves the lead out): named in
--skip on this run > excluded on an earlier run > signed up again > authority history >
**suggestion accept or dismiss in progress (NEW)** > pending suggestion > **staff dismissed an
Atlanta Housing Authority suggestion (NEW)**. Reads 5-7 run only for a would-be target, in that
order, stopping at the first hit; a failed read of any of them is `read_failed` ("nothing
written", exit 1).

Implementer: 5 commits, RED->GREEN each (7/90 -> 97, 8/93 -> 101, 12/96 -> 108, 1 -> 108); the
backfill test file 108/108 on real DynamoDB Local, none skipped; cleanOrgNames,
dynamoAccessKeyGuard, orgListsRetired 58/58; `npm run typecheck` and the scoped eslint exit 0
(implementer's own checks, `fw2-report.md` - NOT the completion gates).

## 2. Review

`fw2-review.md` (fresh opus reviewer, fix diff 71663942..c7e23d64): 0 CRITICAL, 0 HIGH,
0 MEDIUM, 2 LOW, 8 INFO; FW2-1..FW2-4 all CONFORM to spec revision 6 and decisions 1-6;
17 mutants against the real, unedited test file (alias config, control 108/108), all killed.
No write can happen while an owed exclusion is unrecorded - stopped, failed or killed at any
point. Dispositions:
- L1 [LOW, PLAUSIBLE] - the in-progress read (`resolve#`) runs before the pending read
  (`sugg#`); a staff claim that commits between the two GetItems (the claim deletes `sugg#`
  and creates `resolve#` atomically) is missed. Reading `sugg#` first would close it. NOTED,
  not fixed (closing rule: not a one-line change - the order and its tests are pinned by
  decision 3); the window is the time between two consecutive GetItems. A candidate for the
  planner if wanted: swap reads 5 and 6.
- L2 [LOW] - RUNBOOK exit-code phrase "could not record". FIXED (263b396b).
- I1-I8 [INFO] - NOTED: loose phrases in the STOPPED footer and RUNBOOK step 3 (the Scan has
  read every lead; "not recorded twice" holds when the history read succeeds); `hasDismissal`
  is an eventually consistent GetItem (a dismissal within about a second of the read can be
  missed; reused as ruled); two stale docblock sentences; no model-text key (the backfill has
  none - matches the AI path for the value it writes); keys pinned as literals in the test;
  RUNBOOK step 4's cause list is incomplete (its instruction is right in every case); one
  dead formatter branch; **spec D10's "Safe to re-run" bullet still lists the revision-5 set**
  (spec text - the planner's).

## 3. Deferred to the planner (by the planner's instruction)

- All five completion gates, on the post-merge tip.
- The lane rehearsal of the two new reasons and the exclusions-first order
  (`backfill-rehearsal-3.md`, from the fix wave 2 list): it needs an `npm run e2e:session`,
  which the planner's change of plan rules out for this orchestrator. The seed script with the
  guards is ready at `.superpowers/sdd/rehearsal/seed-pre-change-leads-v2.ts` (gitignored); a
  dismissed-Atlanta lead needs `extraction.putDismissal(contactId, 'housingAuthority',
  normalizeSuggestionValue('housingAuthority', 'Atlanta Housing Authority'))`, and the
  exclusions-first order shows in the apply's JSON log lines (the `exclusion recorded` lines
  precede every `housing authority set` line even when a target signed up before the skipped
  lead).

## 4. Commits (71663942..this file)

71663942 decisions; 394fb757 172d3c33 a2d86929 2c78df7f (code + tests); d0ea19d1 b652ea6e
263b396b (RUNBOOK); c7e23d64 (implementer report); 6665f398 (review); plus the commit carrying
this file.
