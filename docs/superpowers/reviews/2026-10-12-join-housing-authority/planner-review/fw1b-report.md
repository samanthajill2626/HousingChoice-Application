# Planner fix wave 1b (micro wave) - implementer report

Branch `feat/join-housing-authority`, worktree `W:/tmp/join-housing-authority`. Work list:
the FIX rows of `fw1-review-adjudications.md` (F1, F4, F7) and the RUNBOOK wording (F5, F2, F1).
Base `51970b91`; four commits, tip `4ede5b03`. Nothing was run against any environment; no
backfill run, no e2e, no full `npm test`.

## Commits

| Item | Commit | Files |
|---|---|---|
| F4 | `d98f6e9f` | `app/scripts/backfill-join-housing-authority.ts`, `app/test/backfillJoinHousingAuthority.test.ts` |
| F1 | `0572828a` | the same two files |
| F7 | `99b14981` | `dashboard/src/routes/settings/NotOnListSection.test.tsx` |
| RUNBOOK (F2, F5, F1) | `4ede5b03` | `RUNBOOK.md` (3 lines, all in the "/join leads: the housing authority backfill" section) |

F4 went first so F1's new tests could assert the final wording.

## F4 - "may not have been recorded"

- Code: `EXCLUSION_FAILED_SUFFIX` (`backfill-join-housing-authority.ts:292-293`) and the ERROR log
  line in `recordExclusion` (`:698`).
- RED: 3 failed / 88 passed (91) - the two pinned report strings still said "could not be
  recorded", and the new land-then-throw test found no matching line.
- GREEN: 91/91, no SKIPPED line.
- Tests: the two existing expectations updated (`test:372`, and the failed-exclusion run test now
  also pins the ERROR log message); one NEW test `test:1276` - the append LANDS and then throws:
  the FAILED line prints, the event IS stored, exit 1, and a re-run with the same --skip adds no
  second event (the reviewer's untested path).
- Exact new strings:
  - report suffix: ` - FAILED: its exclusion may not have been recorded (an ERROR line names this contactId) - keep it in --skip and re-run the apply`
  - full left-out line: `  <name>  signed up <date>  status <status>  contactId <id>  - named in --skip - FAILED: its exclusion may not have been recorded (an ERROR line names this contactId) - keep it in --skip and re-run the apply`
  - ERROR log msg: `backfill-join-housing-authority - the exclusion append FAILED; it may not have been recorded (named in --skip; its housing authority was not written) - keep it in --skip and re-run the apply`

## F1 - a --skip lead never depends on a read

- Code:
  - `leftOutReasonFor` returns `{ reason: 'skipped' }` BEFORE any read (`:598`), so it cannot
    throw for a --skip lead and the run loop's read-failure catch can never list it as a target.
  - `recordExclusion` (`:669-705`) now owns the duplicate check: it reads the whole history only
    to find an existing exclusion (`already_recorded`); a failed read logs a WARN and the append
    is attempted anyway; only a failed APPEND returns `failed`. The run loop (`:796-803`) counts
    `recorded` and marks `failed` + `exclusionFailed`.
  - A dry run never calls `recordExclusion`, so it reads nothing of a --skip lead.
  - `CandidateVerdict` (`:574`) drops `exclusionRecorded`: for any lead not named in --skip it
    always equalled `reason === 'excluded_earlier'`, and for a --skip lead it is no longer known
    there. Header comment and the `runJoinAuthorityBackfill` docstring updated to the new read
    order.
- RED: 8 failed / 86 passed (94). The three new run tests failed for the stated reason - c-skip
  came back in `targets` as `read_failed` with `failed: 1`; the other five failed on the dropped
  `exclusionRecorded` field and the seam's "no read" assertion.
- GREEN: 94/94, no SKIPPED line.
- Tests (new, against DynamoDB Local):
  - `test:1327` --apply, c-skip's history Query throws: report equals the clean one (LEFT_OUT
    unchanged, 3 written, failed 0), printed `... contactId c-skip  - named in --skip`, no
    `c-skip  - FAILED` line, ONE exclusion event `{ field }` no actor, no ERROR line, ONE WARN line,
    exit 0; a later dry run WITHOUT --skip leaves c-skip out as `excluded_earlier`.
  - `test:1359` the same plus a failing exclusion append: c-skip left out with
    `exclusionFailed: true`, never a target, failed 1, the FAILED left-out line, no
    `FAILED: nothing written` line for it, no event, ERROR log = the F4 message, exit 1.
  - `test:1378` dry run where every read of c-skip (history AND suggestion) would throw: report
    equals the clean dry run; the distinct reads are exactly the other five candidates' (c-skip
    not once); exit 0.
  - Seam test `test:757` rewritten: a --skip id makes no read even with throwing fakes.
- Kept: every other precedence rule and test (the precedence-through-the-store test still proves
  --skip over an earlier exclusion; the re-run-adds-no-duplicate test still passes).
- Exact new string (WARN log only; the report adds no line for it):
  `backfill-join-housing-authority - could not read the audit history of a lead named in --skip; recording its exclusion anyway (a second exclusion event is harmless)`

## F7 - negative test on a housing authority row

- Test `NotOnListSection.test.tsx:632`: on `Merln Housng` (field housingAuthority), pick Use
  Merlin Housing Authority, then Clear; each time the confirm button is present and the public
  note is absent.
- Real component: 43/43.
- Mutation proof (classifier-safe: no source edited in place). Copies of `NotOnListSection.tsx`
  in the session scratch dir with relative imports rewritten to absolute worktree paths; a
  throwaway vitest config that spreads `dashboard/vite.config.ts`, aliases the test's
  `./NotOnListSection.js` import to the copy (`resolve.alias`, regex on the exact specifier) and
  dedupes the bare packages; the REAL, unedited test file run from `dashboard/`:
  - control (unmutated copy): 43 passed (43);
  - mutant (`settle.action === 'add' && ` removed): 1 failed | 42 passed (43) - the ONLY failure
    is the new test, at its note assertion (`:640`, the Use pick). This also proves the alias
    bit (the control and mutant runs differ).
  - All throwaways (copies, config, run logs) deleted afterwards.

## RUNBOOK (section "/join leads: the housing authority backfill" only)

Three lines changed (461, 481, 485); every other line untouched. ASCII.
- F2 (line 461), appended to the pending-suggestion bullet: if the pending value IS "Atlanta
  Housing Authority" and staff judge it wrong, dismissing it does NOT keep the backfill away (the
  next run lists the lead as a target and an apply gives it Atlanta Housing Authority): set the
  lead's real housing authority on its contact page (no longer a candidate), or name it in
  `--skip` on the next apply. The report's reason string is unchanged.
- F5 (line 481): "For each CANDIDATE named in `--skip` it REMEMBERS the exclusion"; a `--skip`
  id naming a non-candidate (for example a deleted lead) is reported and NOT remembered - name it
  again if it ever becomes a candidate (for example a restored lead). Also on this line (F1):
  the history is read only for the duplicate check, and a failed read still appends.
- F1/F4 (line 485): the left-out FAILED line quoted with "may not have been recorded", explained
  as an append error that does not say whether it landed; a second exclusion event is harmless.

## Gates (this unit)

- `cd app && npx vitest run test/backfillJoinHousingAuthority.test.ts`: exit 0, 94 passed (94),
  no `SKIPPED - no DynamoDB` line (DynamoDB Local reached).
- `cd dashboard && npx vitest run src/routes/settings/NotOnListSection.test.tsx`: exit 0, 43
  passed (43).
- `npm run typecheck` (worktree root): exit 0.
- `npx eslint app/scripts/backfill-join-housing-authority.ts app/test/backfillJoinHousingAuthority.test.ts dashboard/src/routes/settings/NotOnListSection.test.tsx`: exit 0, no output.

## Divergences and remarks

- Divergence (good, I think): `CandidateVerdict.exclusionRecorded` removed rather than kept as a
  derived field; 12 test assertions dropped that field (the reasons they assert are unchanged).
- Remark: RUNBOOK.md:492 (Cost) still says "per candidate (those named in `--skip` included) one
  audit-history Query"; a DRY run no longer reads --skip candidates (an apply still does). It now
  overstates a dry run's reads slightly - harmless, left as is because the brief said to keep
  every other line exactly. One-word fix if wanted: "(on an apply, those named in `--skip`
  included)".
- Remark: RUNBOOK.md:483 (the `FAILED: nothing written` read-failure line) is still true but no
  longer applies to a --skip lead; left untouched for the same reason.
- Remark: the F3 lane rehearsal (`backfill-rehearsal-2.md`, the orchestrator's step) does not
  exist yet; it should run on this tip (`4ede5b03`). The clean-path report lines are unchanged by
  this wave; only failure wording and the dry run's read set changed.

## Next step

Orchestrator: commit this report, run the F3 lane rehearsal on `4ede5b03`, and the completion
gates.
