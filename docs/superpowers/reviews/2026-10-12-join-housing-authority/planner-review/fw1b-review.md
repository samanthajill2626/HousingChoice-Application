# Planner fix wave 1b (micro wave) - fresh independent review (terminal round)

Branch `feat/join-housing-authority`, worktree `W:/tmp/join-housing-authority`. Reviewed cold:
`.superpowers/review/fw1b-diff.txt` (commits d98f6e9f, 0572828a, 99b14981, 4ede5b03, ae10bd9e;
records excluded), against `fw1-review.md` (F1, F2, F4, F5, F7), `fw1-review-adjudications.md`
and spec revision 5 D10. Code cited at HEAD `83766228` (the micro wave's code is unchanged since
`ae10bd9e`). Nothing in the worktree was edited except this file; no npm test, no e2e, no
session, no backfill run, no git or docker action. Throwaways lived in the session scratch dir
and were deleted.

## Verdict

0 CRITICAL, 0 HIGH, 0 MEDIUM, 1 LOW (pre-existing, not introduced by this wave), 6 INFO.
F1, F4, F5 and F7 are CLOSED; the F2 RUNBOOK wording is true. 10 of 12 backfill mutants and
2 of 2 dashboard mutants are killed by the real, unedited test files; the 2 survivors are INFO
test gaps on paths that were already untested. **Nothing reopens** (closing rule: only a
MEDIUM+ defect introduced by this wave).

## 1. F1 - a --skip lead never depends on a read: CLOSED [CONFIRMED]

Walk (`app/scripts/backfill-join-housing-authority.ts`):

- `leftOutReasonFor` returns `{ reason: 'skipped' }` at `:598`, before its first `await`
  (`:599`). `skip.has` cannot throw, so for a --skip candidate the run loop's try (`:777-787`)
  can never reach its catch - the only place a lead is pushed to `targets` as `read_failed`
  (`:781`). A --skip candidate therefore always takes the `reason !== null` branch (`:789`) and
  lands in `leftOut` (`:804`); it can never appear under the targets header (`:350-355`).
- **Dry run:** `opts.apply` is false, so `recordExclusion` is never called (`:796`). No audit
  Query, no suggestion GetItem, no append for the --skip lead - zero reads. Proven by the test
  at `test:1378` (every read of c-skip throws; the distinct-reads list excludes it) and by
  mutant m05 below.
- **Apply:** `recordExclusion` (`:683-704`) reads the whole history only for the duplicate check
  (`:685-686`, `already_recorded` = no append); a failed read logs WARN (`:688-691`) and falls
  through to the append (`:693-694`); only a throwing APPEND returns `failed` (`:695-700`), which
  the loop turns into `failed += 1` and `exclusionFailed: true` (`:799-802`), printed with the
  F4 suffix (`:292-293`, `:367`) and an ERROR line naming the contactId (`:696-699`) - so the
  suffix's "(an ERROR line names this contactId)" holds. `recordExclusion` never throws (both
  awaits are inside try blocks), so the run cannot abort there.
- **Every other candidate keeps decision-2 precedence:** unchanged path - whole history
  (`:599`), `leftOutReasonFromAudit` order excluded_earlier > signed_up_again >
  authority_history (`:196-205`), then the pending suggestion only when nothing earlier applies
  (`:602-604`). `skipped` stays first because the check precedes everything.
- **Counts / exit codes:** `targets` never holds a --skip lead, so `Would update: N` (`:356`)
  and `Written/Skipped/Failed` stay true. Read-fail + append-ok: `failed` 0, exit 0 (WARN log
  only). Read-fail + append-fail: `failed` 1, exit 1 (`:382`), FAILED left-out line, the done
  line is `COMPLETED WITH FAILURES` (`:832-837`).
- **Anything broken elsewhere:** (a) no reason ever came from a --skip lead's history - before
  the wave the skip check ran right after the read and before `leftOutReasonFromAudit`, so the
  only thing taken from that history was `exclusionRecorded`, now owned by `recordExclusion`
  with the same predicate (`isExclusion`, `:186`); (b) `exclusionsRecorded` (`:798`) still
  counts only appends that succeeded (a read-fail + append-ok counts 1: an event was appended);
  (c) log lines: the new WARN carries `{ err, contactId }` only - no name; the generic
  read-failure ERROR (`:782-785`) can no longer fire for a --skip lead; (d) `CandidateVerdict`
  lost `exclusionRecorded` and has no other user (grep of app, dashboard, e2e, scripts);
  (e) the original fw1 F1 hazard path (apply with throttled c-skip history, step-4 dry run
  without --skip, apply) is closed: the exclusion is appended, and `test:1327` proves a later
  dry run without --skip lists c-skip as `excluded_earlier`.
- Spec D10 rev 5 conforms: every --apply appends the exclusion to each --skip candidate unless
  one is held; "both audit rules read a candidate's WHOLE history" still holds for every lead
  whose reason depends on it.

## 2. RUNBOOK section "/join leads: the housing authority backfill" - new/changed sentences

| RUNBOOK.md | Claim | Holds? |
|---|---|---|
| 461 | dismissing an Atlanta-valued pending suggestion does NOT keep the backfill away; next run lists it as a target and an apply writes it | HOLDS: dismissal deletes the `sugg#` row and appends `ai_suggestion_dismissed { actor, target }` (`app/src/services/suggestionResolution.ts:255-263`), which `touchesHousingAuthority` ignores (`:180-181`); pending is the last reason, so nothing else applied before |
| 461 | set the real authority on the contact page -> no longer a candidate; or name it in `--skip` on the next apply | HOLDS: `isCandidate` requires `housingAuthority === undefined` (`:147`); --skip wins over every reason (`:598`) and an apply records the exclusion |
| 481 | each CANDIDATE named in --skip is remembered, unless an earlier apply already recorded one | HOLDS (`:796-797`, `:686`) |
| 481 | its history is read only for that check; a failed read still appends; a second event is harmless | HOLDS (`:684-694`). "Harmless": no consumer of the event type outside the script (grep of `app/src`, `dashboard/src`, `e2e`); the script reads any number as one exclusion (`:199`) |
| 481 | a --skip id naming a non-candidate (e.g. deleted) is reported and NOT remembered; name it again if it becomes a candidate (restored) | HOLDS: `unknownSkips` (`:766`) printed on dry run and apply (`:373-375`); the loop only visits candidates; restore removes `deleted_at`, and delete/restore events are not authority history |
| 485 | FAILED left-out line text; nothing written to the lead; keep it in --skip and apply again; exits 1; a second event harmless | HOLDS word for word against `:293` + `:367`; INFO I5 on "an error that does not say whether it landed" |
| 492 | Cost: a --skip candidate's history is read only on an apply; Query per 100 events plus one empty; consistent GetItem per would-be target; on apply one conditional write + one audit event per target + one exclusion event per --skip lead not yet excluded | HOLDS (one Query per `listByEntity` call, `app/src/repos/auditRepo.ts:122-141`; unique `ts` so `before` advances; `contactsRepo.update` sends one UpdateItem; `append` one PutItem). INFO I4 on two imprecisions |

Unchanged sentences re-read for anything the wave made false: step 1's read-failure bullet,
step 3's read-failure bullet and step 2 still hold (they now simply never apply to a --skip
lead). Step 4 is LOW L1 below (pre-existing).

## 3. Findings

### L1 [LOW] [CONFIRMED] Pre-existing, NOT introduced: RUNBOOK step 4 still mis-explains a --skip lead whose exclusion append failed

RUNBOOK.md:489: "(the `--skip` value is no longer needed) ... A lead that shows up again had its
write SKIPPED or FAILED in step 3: apply again". A --skip lead whose exclusion append failed and
did not land has no exclusion event (`test:1244` and `test:1359` both assert
`excludedEvents() == []`), so the step-4 dry run without --skip lists it as a target, and
"apply again" with the step-4 premise (no --skip) writes Atlanta Housing Authority to it. The
step-3 FAILED left-out line and its RUNBOOK bullet (:485) already say "keep it in --skip and
re-run the apply", and the run exits 1, so this needs an append failure AND an operator who
skips that instruction. The path existed at `51970b91` (the append-failure bullet pre-dates
this wave); the wave only adds a second way in (read-fail + append-fail) while making the
read-fail-alone case safe. The fw1 review's optional step-4 note ("a lead you named in --skip
that shows up as a target: put it back in --skip and re-run step 3") would close it; noted,
not reopened.

### INFO

- I1 (mutant m07 survives): the `exclusionsRecorded` count on the done log line (`:798`, `:824`)
  is asserted by no test. Log-only; the code is correct by reading.
- I2 (mutant m10 survives): no test pins that a --skip lead whose history holds another
  left-out reason (signed up again, authority history) still gets its exclusion event - a
  mutant treating any such history as `already_recorded` passes 94/94. Consequence would be
  cosmetic (those reasons are permanent; a later run prints that reason instead of "excluded
  on an earlier run"). Pre-existing shape (the old `exclusionRecorded` had the same exposure).
- I3: an apply where a --skip lead's history read fails but the append lands ends exit 0 with
  "done" at info level; the only trace is one WARN JSON line, no report line. Matches the
  adjudication (the record is the safety; a duplicate is harmless).
- I4: the Cost line (:492) says "one exclusion event per `--skip` lead not yet excluded"; strictly
  per --skip CANDIDATE, and a failed history read appends even when one is held (step 3 says
  both). It also omits the org-list GetItem before the run and the re-read after an apply that
  wrote (a pre-existing omission carried on the edited line).
- I5: RUNBOOK:485 "failed with an error that does not say whether it landed" generalizes over
  every append error (a validation or access error clearly did not land); the report says
  "may not", which is true for all of them, and the advice is right either way - the same
  generalization FW-3 accepted for writes (:484).
- I6: module header `:56` "Each candidate's history is read right before its write" reads as
  covering --skip candidates; the header's own `:20-24` and `:29-32` state the --skip rule
  correctly. Comment-only.

## 4. Mutation proof

Method: each mutant is a COPY in the session scratch dir (relative imports rewritten to absolute
worktree `.ts` paths), injected into the REAL, unedited test file by a throwaway vitest config
(the worktree's config merged, `root` set to the workspace, `resolve.alias` on the test's exact
import specifier, `resolve.dedupe` for the bare packages). Controls prove the copies are
faithful; sanity mutants (m08, m12, S1) prove the alias bites. All throwaways deleted.

Baselines (real config): `app` `test/backfillJoinHousingAuthority.test.ts` 94/94, no SKIPPED
(DynamoDB Local reached); `dashboard` `src/routes/settings/NotOnListSection.test.tsx` 43/43.
Controls: app 94/94, dashboard 43/43.

F7 (dashboard, `NotOnListSection.tsx:335`):

| Mutant | Result |
|---|---|
| S1 drop `settle.action === 'add' &&` (the fw1 survivor) | KILLED - 1 failed / 42 passed; the only failure is the new test, at its note assertion `NotOnListSection.test.tsx:640` |
| S2 `(add OR clear) && addKind === HA` (proves the Clear iteration bites, not only Use) | KILLED - same test, `:640` |

Backfill:

| Mutant | Result (failed / 94) and killers |
|---|---|
| m01 read the history before the --skip check (the old order) | KILLED 4: seam "--skip ... NO read", dry run "NO read", both apply read-fail tests |
| m02 failed history read -> `failed`, no append | KILLED 2: both apply read-fail tests |
| m03 failed history read -> `already_recorded` (silent, no append) | KILLED 2: same |
| m04 no duplicate check (always append) | KILLED 3: apply re-run, land-then-throw re-run, not-recorded-twice |
| m05 a dry run reads the --skip lead's history (error swallowed) | KILLED 1: dry run "NO read" |
| m06 failed history read logged at ERROR, not WARN | KILLED 2: both apply read-fail tests |
| m07 `exclusionsRecorded` also counts `already_recorded` | SURVIVED - I1 |
| m08 old suffix "could not be recorded" (F4) | KILLED 4 |
| m09 old ERROR log text (F4) | KILLED 2 |
| m10 any left-out history counts as already recorded | SURVIVED - I2 |
| m11 failed history read rethrows | KILLED 2 |
| m12 sanity: --skip ignored | KILLED 23 |

## 5. ASCII and escapes

All 260 added lines of `51970b91..ae10bd9e` (RUNBOOK, app, dashboard): no non-ASCII byte, no
literal backslash-u. The records added through HEAD (`docs/`): none either.

## 6. Other checks

- `tsc -p tsconfig.scripts.json` and `tsc -p tsconfig.test.json` (app), `tsc -p tsconfig.json
  --noEmit` (dashboard): exit 0.
- `npx eslint` on the three touched code files: exit 0, no output.
- `git status --short` clean before this report was written.
