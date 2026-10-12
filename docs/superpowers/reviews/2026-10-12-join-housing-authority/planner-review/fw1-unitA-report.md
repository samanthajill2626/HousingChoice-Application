# Fix wave 1 - unit A report (backfill FW-1, FW-2, FW-3; RUNBOOK; FW-5)

Implementer FW-A, branch feat/join-housing-authority, worktree W:/tmp/join-housing-authority.
Baseline before the unit: HEAD 5f9fb91c, `app/test/backfillJoinHousingAuthority.test.ts`
76/76 green on DynamoDB Local. Every run below used the shared `hc-dynamodb-local`
container (never started/stopped), no `ALLOW_SKIP_DYNAMO_TESTS`, no exported `AWS_*`
variable, and no "SKIPPED" line in any log. The backfill was never run against any
environment.

## Commits (in order)

| # | Commit | Rule | RED seen (reason) | GREEN (backfill test file) |
|---|---|---|---|---|
| 1 | 738964fc | FW-3 failure wording | 4 failed: outcome still `failed`, line still "nothing written" | 77/77 |
| 2 | 2d65fa58 | FW-1 `--skip` id that names no contact | 7 failed: `scan.contactIds` not iterable, `missingSkips` absent, apply ran instead of refusing | 81/81 |
| 3 | d87ac6b7 | FW-1 remembered exclusion | 10 failed: constant undefined, `excluded_earlier` never returned, verdict still a bare string, no event appended | 86/86 |
| 4 | 37d02e42 | FW-2 pending suggestion | 6 failed: suggestion never read (`reason: null` where `pending_suggestion` expected; 0 GetItems on ai_extraction) | 90/90 |
| 5 | c7fa093a | RUNBOOK section | docs | - |
| 6 | 9bb30403 | FW-5 issues | docs | - |

One test did NOT go RED before its rule: "an exclusion recorded by an earlier --apply is
not recorded twice when the lead is named in --skip again" passed vacuously before commit
3 (nothing was appended at all then). After commit 3 I checked it bites: removing the
`!verdict.exclusionRecorded` guard at `app/scripts/backfill-join-housing-authority.ts`
(the `if (opts.apply && reason === 'skipped' ...)` in the run loop) failed 2 tests (that
one and the apply test's re-run assertion); guard restored, tree clean, 90/90 again.

## Final results

- `cd app && npx vitest run test/backfillJoinHousingAuthority.test.ts`: exit 0, 1 file,
  **90 passed (90)**, none skipped.
- Neighbours: `npx vitest run test/cleanOrgNames.test.ts test/setup/dynamoAccessKeyGuard.test.ts test/orgListsRetired.test.ts`:
  exit 0, 3 files, 58 passed. NOTE: the brief's path `test/orgListRetired.test.ts` does
  not exist; vitest silently treated it as a non-matching filter and ran only 2 files
  (55 tests). The real file is `test/orgListsRetired.test.ts` (with an `s`) - fix that
  path in any gate command that copied it.
- `npm run typecheck` (root, bare): exit 0.
- `npx eslint app/scripts/backfill-join-housing-authority.ts app/test/backfillJoinHousingAuthority.test.ts`: exit 0, no output.
- `npm run issues`: exit 0 ("402 open, 200 closed, 602 total"); INDEX.md is gitignored
  (checked with `git check-ignore`), not committed; the resolved issue lists as
  `resolved`, the deleted one is absent.
- ASCII: every added line in every commit checked (0 non-ASCII bytes); no literal
  backslash-u typed (test characters are built with `String.fromCharCode`).

## What changed, per rule (code cited by file:line at HEAD 9bb30403)

FW-3 (`app/scripts/backfill-join-housing-authority.ts`):
- `TargetOutcome` is now `'would_write' | 'written' | 'skipped' | 'read_failed' | 'write_failed'` (:228).
  `read_failed` = a history or suggestion read threw (no write attempted);
  `write_failed` = the write threw anything but a lost condition (:283 suffix, :648 log).
- The run's done line (COMPLETED WITH FAILURES) no longer says "left as they were".

FW-1 refusal:
- `CandidateScan.contactIds` (:518) collects every contact id from the same Scan
  (deleted rows included, pointer rows excluded). `BackfillReport.missingSkips` (:250).
- Refusal thrown right after the Scan, before any history read or write (:736). An id
  naming an existing non-candidate stays in `unknownSkips` (reported, ignored).

FW-1 exclusion:
- `BACKFILL_EXCLUDED_AUDIT_TYPE = 'housing_authority_backfill_excluded'` (:110);
  `isExclusion` (:182) is checked first in `leftOutReasonFromAudit`;
  `touchesHousingAuthority` is unchanged (false for it - tested).
- `leftOutReasonFor` now reads EVERY candidate's whole history (--skip ones included)
  and returns `CandidateVerdict { reason, exclusionRecorded, suggestedValue? }` (:569, :588).
- `recordExclusion` (:672) appends `{ field: 'housingAuthority' }` with no actor on
  --apply for a `skipped` lead whose history holds no exclusion; a failed append sets
  `LeftOutLead.exclusionFailed` and counts the lead in `failed` (exit 1). A dry run
  appends nothing. `exclusionsRecorded` and `missingSkips` join the done log's counts.
- USAGE gained one line: "an --apply records each exclusion, so later runs leave those
  leads out too."

FW-2:
- `BackfillDeps.suggestions: Pick<ExtractionRepo, 'getSuggestion'>` (:405), built with
  `createExtractionRepo({ doc, env, logger })` in `buildBackfillDeps` (:430) - the
  stage's client and env, never the ambient prefix.
- Read only when no earlier reason applies: `getSuggestion(contactId, 'housingAuthority',
  { consistentRead: true })` (:598). Any returned row = `pending_suggestion`, its
  `suggestedValue` printed through the existing `visibleName` escaping (`reasonText`, :273).
- Precedence exactly as decision 2: skipped, excluded_earlier, signed_up_again,
  authority_history, pending_suggestion (`LeftOutReason` order documented at :119).

## Every changed expectation of an existing test, and why

1. `formatBackfillReport` "apply: each outcome..." - c-6 outcome `failed` -> `write_failed`,
   its line now the may-or-may-not-have-landed wording (FW-3: an apply failure is a write).
2. `formatBackfillReport` "a dry run counts only..." - c-6 `failed` -> `read_failed` (same
   printed text; a dry-run failure can only be a read).
3. `formatBackfillReport` "dry run: each target..." - `DRY_REPORT` gained a fourth
   left-out lead (c-7, `excluded_earlier`), so the expected list shows "Left out (4
   lead(s)..." and the new reason line. Added coverage; no other test using `DRY_REPORT`
   changed its expectation.
4. `DRY_REPORT` and `CLEAN_REPORT` gained `missingSkips: []` (the new required field).
5. Run "a lead whose history read or write fails..." (renamed) - c-mid `failed` ->
   `write_failed`, c-new `failed` -> `read_failed`; added exact-line and log assertions
   (the c-mid ERROR line and the done line never say "nothing written").
6. Pure seam "a lead named in --skip is left out before its history is read" - REWRITTEN:
   decision 2 requires the history of a --skip lead to be read; the test now asserts the
   reads (including the empty terminating page) and the verdict objects, and that the
   suggestion is read only for the lead nothing else leaves out.
7. DB "leftOutReasonFor reads every recorded shape..." and the paging test - assertions
   read `.reason` from the new verdict object; the paging test passes the world's
   `suggestions` too (c-clean now reaches the suggestion read).
8. Run "dry run: the targets..." - `unknownSkips: ['c-flyer', 'c-nobody']` became
   `unknownSkips: ['c-flyer']` + `missingSkips: ['c-nobody']` (FW-1 split); the "list read
   once" check now counts GetItems on the settings table only, and a new assertion
   requires exactly 3 consistent suggestion GetItems (c-old, c-mid, c-new).
9. Run "apply: one guarded write..." - `missingSkips: []`; the "two list reads" check
   counts settings GetItems only (suggestion GetItems are GetCommands too); the tail that
   asserted "a run WITHOUT the --skip would write c-skip" now asserts the opposite (the
   ruling's purpose): one exclusion event on c-skip, no duplicate on a re-apply, and a
   later dry run AND apply without --skip leave c-skip out as `excluded_earlier`.
10. Test helpers: `recordingClient` also records each command's input; `newWorld` creates
    the `ai_extraction` table (the file's own `ensureTable` loop) and gains `suggest`,
    `dismiss` (real `extractionRepo` calls) and `excludedEvents`.

New tests (14; 76 -> 90; the constants test was extended, the skip seam rewritten):
exclusion precedence + not-authority-history (pure);
failed-exclusion format line; missing-id format lines;
pending-suggestion seam (consistent read, target, skip wins); DB precedence
skip>excluded>history; DB pending suggestion vs history / signed-up-again / excluded /
skip / dismissed (only 2 GetItems, both consistent); ambiguous write that landed; apply
refusal on missing ids incl. a pointer-row id (only GetCommand + ScanCommand sent,
nothing printed, all tables unchanged - no exclusion events either); non-candidate ids
incl. a deleted contact not refused; failed exclusion append (exit 1, recorded on the
next apply); no duplicate exclusion; pending-suggestion run with an escaped value
(dry run and apply, nothing written); failed suggestion read; CLI dry run vs apply
with a missing id.

## The exact new report lines (for the lane rehearsal)

`<lead>` is the unchanged lead line
(`  <first> <last>  signed up <YYYY-MM-DD>  status <status>  contactId <id>`).

Left-out reasons (the line is `<lead>  - <reason>`):
- `named in --skip` (unchanged)
- `excluded on an earlier run` (new)
- `signed up again after the change` (unchanged)
- `its housing authority was set or removed before - left empty on purpose` (unchanged)
- `has a pending housing authority suggestion (<value>) - accept or dismiss it first` (new; `<value>` escaped like names)

A --skip lead whose exclusion append failed (apply only):
- `<lead>  - named in --skip - FAILED: its exclusion could not be recorded (an ERROR line names this contactId) - keep it in --skip and re-run the apply`

Target outcomes:
- read failure (unchanged text): `<lead>  - FAILED: nothing written (an ERROR line names this contactId); re-run`
- write failure (new): `<lead>  - FAILED: the write may or may not have landed (an ERROR line names this contactId) - re-run the dry run to see`

--skip ids (printed after the left-out list, missing ids first, one line each):
- `--skip id that names no contact (a typo?) - an --apply refuses to run with it: <id>` (new)
- `--skip ids that are not candidates (ignored): <id>, <id>` (unchanged text; now only ids naming an existing non-candidate)

Refusal (printed to stderr by the CLI, exit 1, no report printed):
- `backfill-join-housing-authority: REFUSED - these --skip ids name no contact on this environment (a typo?): <ids sorted, ", "-joined>. Correct or remove each one (a lead's contactId is the last item on its dry-run line), then re-run. Nothing was written.`

Structured log lines (msg):
- ERROR `backfill-join-housing-authority - the write FAILED; it may or may not have landed - re-run the dry run to see`
- ERROR `backfill-join-housing-authority - could not read the audit history or the pending suggestion; nothing written for this contact`
- ERROR `backfill-join-housing-authority - the exclusion could NOT be recorded (named in --skip; its housing authority was not written) - keep it in --skip and re-run the apply`
- INFO `backfill-join-housing-authority - exclusion recorded (named in --skip): later runs leave it out`
- WARN `backfill-join-housing-authority - COMPLETED WITH FAILURES<suffix>: N lead(s) FAILED (see the ERROR lines naming them and the report's FAILED lines). Re-run the dry run to see where they stand, then re-run (idempotent).`
- the done line's counts gain `missingSkips` and `exclusionsRecorded`.

Rehearsal consequences: after the rehearsal's --apply with --skip, a later dry run
WITHOUT --skip must list those leads as `excluded on an earlier run` (the old rehearsal
expectation that they reappear as targets is now wrong); an audit row
`housing_authority_backfill_excluded` per skipped lead appears on the lane. A lead
seeded with a pending suggestion (an `ai_extraction` row `sugg#<id>#housingAuthority`)
shows the new reason.

## RUNBOOK (c7fa093a)

Only the "/join leads: the housing authority backfill" section changed (18+, 11-): the
five reasons with precedence; the issue reference removed from the "signed up again"
bullet (sentence otherwise kept); a new paragraph for the missing-id refusal placed
AFTER the existing refusals list (that list's header says "no contact read", which is
false for this refusal, so the header line stays exact and true); step 1 gains the
missing-id line and the read-failure text covers the suggestion read; step 2 now "keep
that --skip value until the first --apply" and "set it on its contact page"; step 3
documents the exclusion event and the two new FAILED lines; step 4 no longer needs the
--skip value and lists the two new never-touched cases; the cost line counts --skip
leads' history reads, the extra GetItem per would-be target and the exclusion events.
Every other line is byte-identical.

## FW-5 (9bb30403)

- `git rm docs/issues/join-repeat-signup-answer-unreachable.md`. `git grep` outside
  `docs/superpowers/reviews/` found exactly one live reference (RUNBOOK, removed in
  c7fa093a); none in code, specs or plans. Gitignored run state (`.superpowers/`) still
  mentions it - history, untouched.
- `docs/issues/join-backfill-ignores-pending-authority-suggestion.md`: `status: resolved`,
  `resolved: 2026-10-12`, a Resolution paragraph naming 37d02e42.

## Things that worry me (findings, not blockers)

1. A --skip lead whose history read FAILS now becomes a `read_failed` TARGET line (under
   "Leads given / that WOULD get ...") with "FAILED: nothing written ... re-run", and the
   run exits 1 - before this wave a --skip lead was never read, so a dry run could not
   fail on it. The verdict (including whether its exclusion exists) is unknown when the
   read fails, so this is honest, but the operator sees a lead they skipped in the
   target list. Rare (a throttled Query); the RUNBOOK's read-failure text covers it.
2. The pending-suggestion rule is "any row", including a pending suggestion whose value
   is "Atlanta Housing Authority" itself (decision 1 and the spec say any pending
   suggestion; the issue file's suggested variant exempted exact-Atlanta). Such a lead
   waits for staff to accept it on its contact page. Stated in the issue's Resolution.
3. The exclusion append has the same ambiguity FW-3 fixed for writes: a timeout after the
   Put landed reads "its exclusion could not be recorded". Benign - the advice (keep it
   in --skip, re-run the apply) is right either way, and a re-run finds the event and adds
   none - so I kept decision 3's wording rather than inventing a third phrasing.
4. `CandidateScan.contactIds` holds every contact id in memory for the run - trivial at
   today's volume, worth knowing if the table grows by orders of magnitude.
5. No app screen shows the new audit event; an exclusion is irreversible through the
   script by design (decision 3 / RUNBOOK: set the authority on the contact page).
6. `leftOutReasonFor` changed its return type (bare reason -> verdict object). Only this
   script and its test import it (checked by the typecheck of all three tsconfigs).

## Next step

Orchestrator: commit this report; update the lane rehearsal's expected output with the
lines above (notably the post-apply dry run without --skip); fix the neighbour-suite path
(`orgListsRetired`) in any gate command that copied the brief's spelling.
