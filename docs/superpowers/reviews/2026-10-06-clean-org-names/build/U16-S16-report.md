# U16 - S16 report (Tasks 16.1-16.5 + RF-5): glossary, issues and the e2e guide

- Implementer: U16 (Opus 5.5), 2026-10-07. Branch `feat/clean-org-names`, worktree `W:/tmp/clean-org-names`.
- Range: plan lines 29737-30220. Stopped after the last S16 commit (79b0d7cb). Start: clean tree at f1520fa4,
  no MERGE_HEAD. End: clean tree, no MERGE_HEAD. Build date 2026-10-07 wherever the plan says `<BUILD-DATE>`.
- Docs only: no TDD, so no RED/GREEN; each task's own checks are listed below.
- Every commit: bare `git status` read first (its own command), MERGE_HEAD absent, explicit paths staged, ASCII
  message ending with the trailer. Sweep over f1520fa4..HEAD: 0 non-ASCII added lines, 0 non-ASCII message
  bytes, 7/7 trailers. New files are LF (0 CR), as `.gitattributes` (`eol=lf`) requires.
- DynamoDB Local not started, stopped or restarted (the RF-2 pins run on the in-memory harness). No other
  worktree touched. `docs/issues/INDEX.md` is gitignored (`.gitignore:62`) and was never staged.

## Task 16.1 - be07af8b docs(glossary): housing authority, agency and accepted authorities are list names; organization list, alternate spelling, not on the list

- Housing authority and agency rewritten; organization list, alternate spelling and not on the list added after
  agency; accepted authorities updated. Plan text verbatim except for RF-6:
  - RF-6 (a): the parenthetical now ends "...; every API writer refuses anything else with 422
    `org_not_on_list`; the AI turns it into a staff suggestion and the importer reports it)". Three lines rewrapped.
  - RF-6 (b): "input/row" -> "picker/row".
- Checks: the added-line ASCII check prints nothing, and no removed line was non-ASCII. The file's non-ASCII
  lines 5-6, 12, 40-90, 105-111, 128 and 167 are unchanged; old 363 is now 417 (+54 = 86 added - 32 removed).
  Only the named entries changed (3 hunks, lines 271-364).

## Task 16.2 - 6211b2ad docs(issues): resolve housing-authority-free-text-drift (clean-org-names)

- Frontmatter: `status: resolved`, plus `updated` and `resolved` set to 2026-10-07. The Resolution paragraph
  sits above the 2026-10-01 Update, verbatim.
- Spot-checked its claims: `app/src/lib/housingAuthority.ts` and `dashboard/src/routes/contact/orgVocabulary.ts`
  are absent, and `git grep` finds no `HOUSING_AUTHORITY_VOCAB` or `CANONICAL_AUTHORITY` in app/src or
  dashboard/src (exit 1).
- Checks: ASCII check prints nothing; `npm run issues` exit 0, summary only.

## Task 16.2 second commit - 1a8dfcac docs(issues): resolve contact-authority-clear-empty-string-500

- Precondition: `cd app; npx vitest run test/contactOrgNames.test.ts test/contactTriage.test.ts` gave 2 files,
  45/45 passed, 0 skipped, exit 0. Both pins are green.
- RF-2 applied: `status: resolved`, `updated` and `resolved` set to 2026-10-07, and the Resolution block above
  `**Problem.**`. d827bab6 confirmed (2026-08-13, "fix(contacts): clearing housingAuthority REMOVEs ...").
- Checks: ASCII check prints nothing; `npm run issues` exit 0, no warnings.
- DIVERGENCE: RF-2's text cites the BASE lines `app/src/routes/contacts.ts:631-635` and
  `app/test/contactTriage.test.ts:470-506`. On the branch they are `:638-642` and `:472-508`, because S6 added
  lines above both. I wrote the branch lines.

## Task 16.3 - 6cd36fcc docs(issues): retire-humanize-authority keeps only the unit PATCH tombstones

- Frontmatter: the plan's title, `severity: low`, `area: app`, `updated: 2026-10-07`; status stays open.
- The new Progress paragraph uses RF-1's wording: "`TOMBSTONED_FIELDS` and `sawTombstone` in
  `app/src/lib/unitFields.ts`, and the retired-fields-only no-op return of the unit PATCH in
  `app/src/routes/units.ts`". Verified at unitFields.ts:123, :149-153 and :214, and at units.ts:1370
  (`res.json({ unit: existing })`).
- Spot-check: no seed writes an authority slug. The only matches are "was `...`" comments at
  app/src/lib/seed/orgList.ts:30-38.
- Checks: ASCII check prints nothing; `npm run issues` exit 0, no warnings.

## Task 16.4 - 15fec231 docs(issues): file four clean-org-names follow-ups and the Settings notice gap

- The four plan files are verbatim (created 2026-10-07): property-authorities-from-address,
  ai-extraction-fills-agency, ai-adds-new-org-names and reimport-reverts-unknown-triage. Every refs path and cited
  symbol exists (closeNames at orgNames.ts:187, upsertContact at import/apply.ts:1050, agency_not_authority at
  extraction/apply.ts:275).
- The dispatch's extra issue, org-settings-notice-stale-after-add (bug, low, open, area dashboard/settings), was
  filed. The dispatch's check `git grep -n "setNotice(null)" -- dashboard/src/routes/settings/OrgListSection.tsx`
  printed only :170 (closeAndReload) and :177 (runAgain). `onAdded` (:307-310) is only
  `setAdding(null); admin.reload();`.
- Checks: the `tr` ASCII check gives 0 for all five files (and 0 CR). `npm run issues` exit 0 with only the
  summary ("368 open, 196 closed, 564 total") and no warning. RF-3 grep of INDEX.md: five rows at :153-157, all
  in `## Open` (:6), above `## Closed` (:379).
- DIVERGENCE (subject): the plan's subject says "four", but this commit files five issues. The subject keeps
  the plan's words as a prefix and adds "and the Settings notice gap"; the body names all five.
- DIVERGENCE (title form): the fifth issue's title contains ": ", so it is double-quoted. All 8 existing titles
  with a colon are quoted. The dispatch's parenthetical (onAdded does not clear it; RE2-3 covered only
  closeAndReload and onRenamed) is in the Problem paragraph, not the title.

## RF-5 step - 9679c90e docs(issues): unit-accepted-authorities-edge-cases - case 2 closed for new writes by clean-org-names

- Added `updated: 2026-10-07` (status stays open) and the Update paragraph above `**Problem.**`. The commit
  subject is mine; the worklist gives none.
- Verified the case 2 claim: `checkListWrite` drops blank members (app/src/lib/orgNames.ts:297), and the unit
  POST (units.ts:457-470) and PATCH (units.ts:1385-1411) store `check.value`.
- Checks: ASCII check prints nothing; `npm run issues` exit 0, no warnings.
- DIVERGENCE - PLEASE ADJUDICATE: RF-5's last sentence, "Case 1 stands (the importer still SETs the list on
  import-owned units).", is written as "This branch does not change case 1 (the importer still SETs the list on
  import-owned units)." Reason: case 1 (a re-import flattens a HAND-CURATED list) looks already fixed by the
  2026-08-17 importer ownership rule, which predates this branch:
  - The importer SETs unit facts only under `attribute_not_exists(updated_at)`. Otherwise it writes them through
    `if_not_exists` (app/src/lib/import/apply.ts:1375-1390 and :1519-1533; the comment names exactly this
    collapse of a curated three-authority list).
  - Every dashboard write stamps `updated_at`: `unitsRepo.update` at :594-616, and create at :554.
  - A curated list can only come from a dashboard write, so the importer no longer overwrites one.

  The neutral wording is true either way; "Case 1 stands" is not. Suggestion: decide whether to mark case 1
  fixed. If so, the issue could resolve, since the only remainder is an already-stored `['']` until it is
  edited.

## Task 16.5 - 79b0d7cb docs(e2e-guide): the example unit body uses an organization-list name

- documentation/sequence-diagram-to-test.md:165: `['atlanta_housing']` -> `['Atlanta Housing Authority']`.
- Checks: the added-line ASCII check prints nothing; `git grep -n "atlanta_housing" --
  documentation/sequence-diagram-to-test.md` prints nothing (exit 1).

## Divergences (summary)

1. 1a8dfcac: the Resolution's line refs use the branch lines (contacts.ts:638-642, contactTriage.test.ts:472-508).
   RF-2 quoted base lines.
2. 15fec231: the subject is extended to cover the fifth (dispatch-added) issue.
3. 15fec231: the fifth issue's title is quoted (YAML colon convention); the parenthetical is in the body.
4. 9679c90e: "Case 1 stands" became "This branch does not change case 1". Needs adjudication; see above.

## Out of scope noticed

- docs/issues/unit-accepted-authorities-edge-cases.md: case 1 appears fixed since 2026-08-17 (above). The issue's
  title and its refs `app/src/lib/import/apply.ts:763,:797` are stale (the writer is now upsertUnit,
  apply.ts:1392-1533).
- S17 (Task 17.1 main sync): this slice's GLOSSARY hunks are lines 271-364 (housing authority through accepted
  authorities). feat/tour-list also edits GLOSSARY, so check those entries if the sync conflicts there.
