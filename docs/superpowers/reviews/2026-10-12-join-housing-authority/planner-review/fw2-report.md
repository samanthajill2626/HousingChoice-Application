# Planner fix wave 2 - implementer report (FW2-1..FW2-4 + RUNBOOK)

Branch feat/join-housing-authority (W:/tmp/join-housing-authority), started at 71663942.
Inputs: implementer-rules.md, fix-wave-2-decisions.md (binding), adjudications.md (round 2 +
Cameron's 2026-10-13 ruling), adversarial-r2.md findings 1-3, spec revision 6 D10. Scope held:
only `app/scripts/backfill-join-housing-authority.ts`, `app/test/backfillJoinHousingAuthority.test.ts`
and RUNBOOK.md's "/join leads: the housing authority backfill" section. No app/src change was
needed. The script was never run against any environment.

## 1. Per item

| Item | Commit | RED seen (reason) | GREEN |
|---|---|---|---|
| FW2-1 exclusions first | 394fb757 | 7 failed / 90 passed (97): the spy order showed `history contacts#c-skip ... update c-skip ...` with c-new's exclusion appended last (interleaved), a failing append still wrote 3 targets, no `stopped` report | 97 / 97 |
| FW2-3 resolution in progress | 172d3c33 | 8 failed / 93 passed (101): `{ reason: null }` instead of `resolution_in_progress` (the record was never read); the in-flight lead c-busy listed as a target; no `resolve#` GetItem; old read-failure log text | 101 / 101 |
| FW2-2 dismissed Atlanta | a2d86929 | 12 failed / 96 passed (108): `atlantaDismissalKeys is not a function`; `{ reason: null }` instead of `dismissed_atlanta`; the dismissed lead c-turned-down written; no `dism#` GetItem | 108 / 108 |
| FW2-4 wording | 2c78df7f | 1 failed (the warning still said "could not be written") | 108 / 108 |
| RUNBOOK (decision 5) | d0ea19d1 | docs | - |

Final runs (bare, real exit codes, real DynamoDB Local - the shared `hc-dynamodb-local`, never
started/stopped; no AWS_* exported; logs in `.superpowers/sdd/fw2-final-*.log`):
- `npx vitest run test/backfillJoinHousingAuthority.test.ts`: exit 0, Test Files 1 passed, Tests
  108 passed (108), none skipped (no "SKIPPED - no DynamoDB Local" line).
- `npx vitest run test/cleanOrgNames.test.ts test/setup/dynamoAccessKeyGuard.test.ts test/orgListsRetired.test.ts`:
  exit 0, Test Files 3 passed, Tests 58 passed (58).
- `npm run typecheck` (root): exit 0.
- `npx eslint app/scripts/backfill-join-housing-authority.ts app/test/backfillJoinHousingAuthority.test.ts`: exit 0, no output.
- ASCII: 0 non-ASCII characters on added lines in all three files; no backslash-u typed.
- `git diff --name-only 0eb44652 HEAD`:
  ```
  RUNBOOK.md
  app/scripts/backfill-join-housing-authority.ts
  app/test/backfillJoinHousingAuthority.test.ts
  docs/issues/e2e-blank-document-after-contact-navigation.md
  docs/superpowers/reviews/2026-10-12-join-housing-authority/planner-review/adjudications.md
  docs/superpowers/reviews/2026-10-12-join-housing-authority/planner-review/adversarial-r2.md
  docs/superpowers/reviews/2026-10-12-join-housing-authority/planner-review/conformance-r2.md
  docs/superpowers/reviews/2026-10-12-join-housing-authority/planner-review/fix-wave-1.md
  docs/superpowers/reviews/2026-10-12-join-housing-authority/planner-review/fix-wave-2-decisions.md
  docs/superpowers/reviews/2026-10-12-join-housing-authority/planner-review/planner-gates-r2.md
  docs/superpowers/specs/2026-10-12-join-housing-authority-design.md
  ```
  (the docs/ entries are the orchestrator's earlier record commits; this wave touched only the first three).

## 2. What changed, where

- FW2-1: `runJoinAuthorityBackfill` first pass, script :905-933 - after the Scan and the typo
  refusal, every --skip candidate (oldest first) goes through the unchanged `recordExclusion`
  (no-duplicate history read, append-anyway on a failed read); ALL are tried; if any append
  failed the run sets `report.stopped`, `leftOut` = only the unrecorded leads (`exclusionFailed`),
  `failed` = their count, logs the STOPPED warn line, prints the stop report and returns - no
  other lead read, no write. The main loop no longer appends exclusions. New optional
  `BackfillReport.stopped?: true` (:332); stop format in `formatBackfillReport` (:411, :424).
  Exit 1 comes from `failed > 0` (backfillExitCode unchanged).
- FW2-3: new dep `resolutions: Pick<SuggestionResolutionRepo, 'get'>` (:500), built with
  `createSuggestionResolutionRepo` on the stage doc/env; `leftOutReasonFor` reads
  `get(contactId, 'housingAuthority')` (consistent GetItem on `resolve#<id>#housingAuthority`)
  right after the audit reasons; `state === 'active'` -> `resolution_in_progress` (:723).
- FW2-2: new pure `atlantaDismissalKeys(entries)` (:245) - calls `resolveOrgText` +
  `KINDS_FOR_FIELD.housingAuthority` (repeats only apply.ts's unexported own-spelling filter) and
  `normalizeSuggestionValue`; name first, de-duplicated. `checkBackfillList` now resolves to the
  item it read (:576), and the run computes the keys from it once (:877). New dep
  `dismissals: Pick<ExtractionRepo, 'hasDismissal'>` (:506, the same extraction repo instance as
  `suggestions`). `leftOutReasonFor` takes a 4th argument `dismissalKeys` and, after the pending
  read, calls `hasDismissal(contactId, 'housingAuthority', key)` per key, stopping at the first hit
  (:726). On the starting list the keys are: `atlanta housing authority`, `atlanta housing`,
  `housing authority of the city of atlanta`, `atlanta (aha)`, `atlanta, aha, atlanta housing`
  ("aha" is shared with Augusta -> excluded).
- Precedence (one reason printed): skipped, excluded_earlier, signed_up_again,
  authority_history, resolution_in_progress, pending_suggestion, dismissed_atlanta. Reads 5-7
  only for a candidate nothing earlier leaves out, in that order, stopping at the first hit; a
  failed read of any of them -> `read_failed` "FAILED: nothing written ...".
- FW2-4: warning and its log line (:786 and the warn after it).

Tests added (test file lines): formatter stop report :388, formatter new reasons :353,
atlantaDismissalKeys :848 (starting list; staff-added spelling counts, one shared with another
housing authority does not, a spelling normalizing to the name is not repeated), pure order of
the dismissal read :937, pure resolution read :964, store resolution (active accept, active
dismiss, completed, history-vs-in-progress, in-progress-vs-newer-pending) :1179, store dismissal
(name, own spelling "Atlanta Housing", shared "AHA" alone NOT, DeKalb NOT, pending-vs-dismissed,
history-vs-dismissed, GetItems only for would-be targets) :1212, exclusions-first order with a
YOUNGER --skip lead (c-new) vs older targets + re-apply no duplicate :1603, failing append stops
:1657, every --skip lead tried :1693, landed-then-errored append stops :1714, run-level in-progress
:1928, run-level dismissed (keys from the list the run read: a staff-added "ATL Housing Auth"
dismissal leaves its lead out; an "aha"-only lead is written) :1965, failed dismissal read :2009,
failed resolution read :2038, CLI exit 1 with the stop report :2681.

## 3. Changed expectations (and why)

1. Formatter test (old "apply: a lead named in --skip whose exclusion append failed is a FAILED
   left-out line") -> now the STOPPED format (:388): a failed append can no longer sit in a normal
   report (FW2-1).
2. Run test "an exclusion that cannot be recorded ..." (old: written 3, failed 1, run goes on) ->
   stopped: written 0, `stopped: true`, exact stop report, only c-skip touched, contacts and audit
   tables unchanged, STOPPED log line; the re-run now writes 3 (:1657). FW2-1.
3. Run test "an exclusion append that lands and THEN errors" (old: written 3) -> stopped, written
   0, the event landed, re-run writes 3 with no second event (:1714). FW2-1.
4. Run test "history read fails AND append fails" (old: targets written 3) -> stopped, no target,
   nothing written (:1798). FW2-1.
5. Read-failure ERROR log line: "could not read the audit history or the pending suggestion;
   nothing written for this contact" -> "could not read the audit history, the suggestion
   resolution record, the pending suggestion or a dismissal; nothing written for this contact"
   (constant READ_FAILED_LOG). The old text would name the wrong read for the new reads.
6. Dry-run test GetItem assertion on ai_extraction: was "every GetItem"; now filtered by itemId
   prefix (`getsOn` gained an optional prefix): the `sugg#` list is identical to before, plus new
   `resolve#` (one consistent read per would-be target) and `dism#` (5 per would-be target)
   assertions - this documents the cost line.
7. PENDING store test: its `getsOn` filtered to `sugg#` (values unchanged).
8. Pure test "a lead named in --skip is left out with NO read": deps gain `resolutions` and
   `dismissals` fakes that record; the expected reads for c-other gain `resolution c-other` and
   the five dismissal reads (and c-skip still gets none).
9. "a dry run makes NO read for a --skip lead": now also records resolution and dismissal reads;
   expected list gains `resolution <id>` and `dismissal <id>` per target (c-skip still none).
10. Every `leftOutReasonFor(...)` call (27) gains the 4th argument `ATLANTA_KEYS`; pure-seam deps
    gain `resolutions` / `dismissals` fakes (no expected value changed by that).
11. AUDIT_WARNING constant: "could not be written" -> "may not have been written"; that test now
    also checks the warn log line (FW2-4).

No other existing expectation changed; all 94 pre-wave tests still run (108 now).

## 4. The exact new strings (for the lane rehearsal)

Left-out reason texts (each printed after `  - ` on a lead line):
- `a suggestion accept or dismiss is in progress - re-run after it finishes`
- `staff dismissed an Atlanta Housing Authority suggestion`

The exclusions-first stop's printed report (stdout, through deps.print; nothing on stderr; exit 1):
```
STOPPED - no housing authority was written for any lead: the exclusion of each lead below, named in --skip, may not have been recorded (oldest sign-up first; dates are UTC):
  <First Last>  signed up <YYYY-MM-DD>  status <status>  contactId <id>  - named in --skip - FAILED: its exclusion may not have been recorded (an ERROR line names this contactId) - keep it in --skip and re-run the apply
The run stopped before reading any lead not named in --skip. Keep the same --skip value and re-run the apply (an exclusion already recorded is not recorded twice). Failed: <N>.
```
followed by `--skip ids that are not candidates (ignored): <ids>` only when there are any.
Log lines of a stop: per lead (ERROR, unchanged) `backfill-join-housing-authority - the exclusion
append FAILED; it may not have been recorded (named in --skip; its housing authority was not
written) - keep it in --skip and re-run the apply`; done line (WARN, new)
`backfill-join-housing-authority - STOPPED before any housing authority write: <N> exclusion(s)
may not have been recorded (see the ERROR lines naming them) - keep the same --skip value and
re-run the apply` (fields: candidates, unrecorded, exclusionsRecorded, apply).

FW2-4: `WARNING: the housing_authority_backfill audit event for contactId <id> may not have been
written (its housing authority was set).`; log `backfill-join-housing-authority - audit event may
not have been written (the write landed); continuing`.

Read failure ERROR log (new text): `backfill-join-housing-authority - could not read the audit
history, the suggestion resolution record, the pending suggestion or a dismissal; nothing written
for this contact`.

How to provoke them on a lane: an in-progress lead needs an ACTIVE `resolve#<id>#housingAuthority`
row in the lane's ai_extraction table (the test makes it with extractionRepo.putSuggestion then
suggestionResolutionRepo.claim; any row with `state: 'active'` at that key works); a dismissed
lead needs a `dism#<id>#housingAuthority#atlanta housing authority` row (or one of the other keys);
the stop needs a failing audit append, which a lane cannot easily produce - the test and the CLI
test (:2681) cover it.

## 5. RUNBOOK (d0ea19d1), what changed

"Five kinds" -> "Seven kinds"; the in-progress reason inserted before the pending one (with what to
do: re-run in a minute; if still listed, open the lead's contact page once - its suggestions read
runs `recoverAbandoned`, verified at app/src/routes/suggestions.ts:116-129 and the dashboard's
useSuggestions - then re-run); the pending reason's tail rewritten (it said dismissing an Atlanta
value does NOT keep the backfill away - now false); the dismissed reason added last. Step 2: keep
the same --skip value for EVERY run on that environment, always. Step 3: exclusions FIRST and the
STOPPED report (replacing the per-lead exclusion-failed bullet); "apply again" now says with the
same --skip value; FW2-4 wording. Step 4: dry run WITH the same --skip, "no longer needed" gone,
the idempotence list gains the two new reasons. Cost line and exit-1 list updated.

## 6. Divergences and things that worried me

- DIVERGENCE (deliberate, within the rulings): the stop report says "no housing authority was
  written for any lead", not a bare "nothing was written". In a stop, OTHER --skip leads'
  exclusion events may have been recorded, and the failed append itself may have landed, so a
  bare "nothing was written" could be false; the housing-authority wording is exactly true.
- DIVERGENCE: the first pass tries EVERY --skip candidate before stopping (decision 4 says "if ANY
  append failed" after the pass and "lists the leads"): more exclusions get recorded and every
  failure is listed. Test :1693 pins it.
- DIVERGENCE: `leftOutReasonFor` gained a required 4th parameter (the keys) instead of hiding them
  in deps - explicit, and a forgotten argument is a type error rather than a silently skipped
  check. `checkBackfillList` now returns the item (was void).
- KEPT EXACTLY per the brief, but now incomplete: RUNBOOK step 1 (`Would update` bullet) and step 3
  (`FAILED: nothing written` bullet) still say "its audit history or pending suggestion could not
  be read"; a failed resolution or dismissal read gives the same line. The action ("fix the cause
  and re-run") is still right and the ERROR log names all four reads. Suggest "its audit history,
  suggestion resolution record, pending suggestion or a dismissal could not be read" if you want
  it exact.
- `extractionRepo.hasDismissal` is NOT a consistent read (app/src/repos/extractionRepo.ts:739-744,
  no ConsistentRead). Reused as ruled (the AI path's own check), so a dismissal made within the
  last second or so could be missed by a run that starts at that moment. Negligible for a
  one-off script; noting it because the other two new reads are consistent.
- Cost: up to 1 + 1 + 5 GetItems per would-be target on the starting list (more if staff add
  Atlanta spellings), on top of the history Query - still seconds at today's volume.
- The `resolution_in_progress` reason also catches a lead whose journal is active for an abandoned
  accept that will, on recovery, set an authority - the lead then stops being a candidate; and an
  abandoned DISMISS of an Atlanta value will, on recovery, become `dismissed_atlanta`. Both
  directions are covered by re-running, which the reason text says.
- `atlantaDismissalKeys` falls back to the name key alone if no exact entry exists; unreachable in
  a run (checkBackfillList refuses first) but keeps the function total.

## 7. Next step

Orchestrator: rehearse the new strings on a hermetic lane (section 4), commit this report, and run
the five gates. Nothing is left uncommitted in the three scoped files.
