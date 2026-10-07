# U5 report - S6 (Tasks 6.1-6.5)

- Implementer: U5 (Claude Opus 5.5), 2026-10-06.
- Worktree `W:/tmp/clean-org-names`, branch `feat/clean-org-names`.
- Range: after dffe7bea (U4 report) through 9b46159f - 5 commits, one per
  task. Worktree clean after the last commit. Nothing left running.
- Next: S7 Task 7.1.

## Per task

| task | commit | RED (one line) | GREEN | fast gates (exit) |
|---|---|---|---|---|
| 6.1 | fba9b92f feat(org-names): contacts PATCH checks housingAuthority and agency against the list (D5) | 8 failed / 49 passed: the four 422 cases "expected 200 to be 422"; the spelling case stored `GA DCA` / `hope atlanta` raw; the three updated pins saw raw `dekalb_housing`, `Hope Atlanta`, `atlanta_housing`; every (PIN) green | contactOrgNames + contactTriage + contactIntakeFields + trimStrings 57/57 | typecheck 0 |
| 6.2 | bb4c1be9 feat(org-names): units POST resolves every accepted authority against the list (D5) | 4 failed / 29 passed: the three refusals "expected 201 to be 422"; `Georgia DCA` stored raw (3 members, no de-dupe); unitsApi green on the new `Atlanta Housing Authority` body | unitsApiOrgNames + unitsApi 33/33 | typecheck 0 |
| 6.3 | 0a2eb5e6 feat(org-names): units PATCH checks new accepted authorities against the stored unit (D5) | 4 failed / 10 passed: `GA DCA` stored raw; the off-list member and the R1-F1 `Fulton` "expected 200 to be 422"; consistent read "Number of calls: 0" | unitsApiOrgNames 14 + unitsApi 27 + unitsRepo.integration 10 = 51/51 | typecheck 0 |
| 6.4 | 77896363 feat(org-names): broadcast draft create resolves the housing authority filter (D5) | `-t "organization names"`: 4 failed / 1 passed: the 201 has no `audience_filter` ("expected undefined to deeply equal ..." and "Cannot read properties of undefined (reading 'housing_authority')"); `AHA` / `Step Up` "expected 201 to be 422"; the (PIN) green | broadcastApi (whole file) 84/84 | typecheck 0; neighbours contactsBatchReads + contactsBatchIncomplete + rateLimit 32/32 (0) |
| 6.5 | 9b46159f feat(org-names): re-check a draft's stored filter at preview and filter send (D7) | `-t "organization names"`: 3 failed / 9 passed: the two DRAFT previews and the no-body send of the `atlanta_housing` draft "expected 200 to be 422"; the four (PIN)s green | broadcastApi (whole file) 91/91 | typecheck 0; same neighbours 32/32 (0) |

Typecheck = root `npm run typecheck`, run bare, output to
`.superpowers/sdd/u5-6-<n>-typecheck.txt`. Test logs:
`.superpowers/sdd/u5-6-<n>-red.txt` / `-green.txt`.

Extra checks (not required gates here):
- The plan's "unchanged and still green" unit neighbours: unitsApiSimilar +
  unitFields + publicIntake 62/62 (0).
- Lint preview: `npx eslint` on the 12 files this unit touched
  (`dffe7bea..HEAD`), exit 0, no messages.
- Unnamed-fallout sweep (grep): no other app test PATCHes a contact's
  housingAuthority / agency through the route (aiRunVerdicts' `Metro HA` rides
  the suggestion accept path - S7's), POSTs or PATCHes units with
  `accepted_authorities`, or creates a draft with a `housing_authority`.

Checks on every commit: bare `git status` read first as its own command, no
`.git/worktrees/clean-org-names/MERGE_HEAD`, explicit paths only, ASCII
subject + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer
(verified with `git log --format=%(trailers)`). New files
(`contactOrgNames.test.ts`, `unitsApiOrgNames.test.ts`): `tr -d` count 0;
edited files: 0 non-ASCII added `git diff` lines (the pre-existing non-ASCII
header lines of `broadcasts.ts`, `api.ts`, `contacts.ts` untouched).
DynamoDB Local was up throughout (never started, stopped or restarted).

## Worklist items applied

- RB-2: Task 6.1 Step 0 item 4's grep printed the harness line
  (`orgListRepo: world.orgListRepo,` at `twilioWebhookHarness.ts:5201`, inside
  `makeWebhookHarness`'s `api:` block). The fallback edit was SKIPPED and the
  harness was not staged. Step 0 items 1-3 verified: `createOrgNamesService`
  deps all optional; ONE `createOrgNamesService(` line in `api.ts` (`:723`,
  local `orgNames`); `ApiRouterDeps.orgListRepo` at `api.ts:344`;
  `world.orgListRepo` is the in-memory fake serving the starting list.
- RB-1: Task 6.4 RED - old_string = the four lines at plan 9674-9677,
  new_string = plan 9684-9788 verbatim (nothing added); `diff` of the file's
  last 105 lines against that block: identical.

## Divergences from the plan

None. Both created test files and every inserted test block are
byte-identical to the plan's fenced blocks (checked with `diff`); every source
edit is the plan's text, each anchor matched exactly once as TEXT. Line drift
only: the `api.ts` mounts sit at `:880`, `:974`, `:1093` (S5 shifted them);
the units PATCH anchor at `units.ts:1369-1373` after Task 6.2;
`unitsRepo.getById` impl at `:575` (S3 shifted it); every `contacts.ts` anchor
was at its base line.

## Watch items honored (server side)

- `housingAuthority` stays REMOVE-on-clear: a clear (`''`, mapped to null by
  the parser) skips the check; a whitespace-only value cannot reach the
  parser (trimJsonBody trims JSON bodies app-wide), so nothing SETs `''`.
- An UNCHANGED value skips the check and the list read (contacts PATCH; units
  PATCH members already held). The dashboard rule (never send an unchanged
  housingAuthority) is S11's.

## Out of scope, noticed (no change made - for the reviewers)

1. `app/src/routes/units.ts` PATCH: a body carrying BOTH `media` and
   `accepted_authorities` now reads the unit twice - the new consistent D5
   pre-read (`:1386`), then the existing eventually consistent media pre-read
   (`hasMediaPatch` block, `:1428-1435`). Efficiency only (plan text); the media
   snapshot could reuse the consistent read.
2. RB-4 (worklist accepted residual) is visible in all three routers as
   designed: the list check and the record write are separate steps.
