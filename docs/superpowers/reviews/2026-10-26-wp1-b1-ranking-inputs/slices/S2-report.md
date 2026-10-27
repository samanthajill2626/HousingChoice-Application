# S2 slice report - Priority on/off (WP1 B1)

Slice S2 (plan section 6, tasks S2.1-S2.4; spec rev 10 D6). Implementer:
Claude Opus 5.5. Branch head at start 7f692aa8 (S1 closed); main @d0e2c2d8
(unchanged during the slice). Findings only; code cited by `file:line` at the
S2 head.

## Commits

| Task | Commit | Subject |
|---|---|---|
| S2.1 | 17901c04 | feat(units): priority is an on/off switch, never on the flyer (wp1 b1 S2.1) |
| S2.2 | 4463ed5d | feat(properties): Priority checkbox on the New and Edit property forms, 36-row form table (wp1 b1 S2.2) |
| S2.3 | cdd28482 | feat(properties): Priority row and header pill on the property record (wp1 b1 S2.3) |
| S2.4 | (this report) | docs(records): wp1 b1 S2 slice report |

## What the tree held that the plan got wrong

- WL-4 / D2-S2-1 (BLOCKER, applied): `dashboard/src/routes/listing/requirements.test.ts`
  pins `PROPERTY_FORM_FIELDS` TWICE - the two-element `[label, flyer]` table
  (describe 'PROPERTY_FORM_FIELDS (the D10a tag table)', now :223-264) and the
  three-element `[label, keys, flyer]` table (now :598-645). The plan's Step 1b
  edited only the second. Both now carry the Priority row (:244, :625) and the
  three-element case reads `- 36 rows` / `toHaveLength(36)` (:601-602).
- Red-line wording: with WL-4 (a) applied, the two-element table is RED at
  Step 2 already (its expected list carries Priority; the table held 35), not
  only after Step 3b as D2-S2-1 described for the uncorrected plan. That is
  WL-4's own red line ("the app table and both dashboard tables hold 35 rows
  (expected 36, with Priority)") - observed exactly.
- Line hints drifted only by S1's edits and the usual few lines: dashboard
  `UnitItem` is types.ts:2652 (plan :2635), `same_day_rta?: boolean;` :2723
  (plan :2706); ListingDetail header anchor :887 (plan :886); parity SAMPLE
  :48 (plan :47). Every quoted anchor matched verbatim and uniquely; no Edit
  was refused (no G4 event).

## Divergences (each deliberate)

1. WL-4 replaced S2.2 Step 1b with D2-S2-1's edits (a), (b), (c), verbatim,
   including the one-line comment above each new row.
2. WL-5 / D2-S2-2 (applied in S2.3): `.priorityBadge` uses
   `background: var(--c-pill-unknown-bg);` (#b45309, about 5.0:1 with white
   per D2-S2-2) instead of `var(--c-warning)` (4.28:1, below AA - code review
   RD-8), with D2-S2-2's comment verbatim
   (dashboard/src/routes/listing/ListingDetail.module.css:77-88).
3. The S2.2 and S2.3 commit messages carry one extra body line naming WL-4 /
   WL-5.
4. App vitest runs were prefixed `env -u ANTHROPIC_API_KEY -u
   AI_EXTRACTION_MODEL` (G1; belt and braces - S2 touches nothing that imports
   the probe, and no such variable is exported here).
5. The MERGE_HEAD check used the brief's
   `test -e "$(git -C ... rev-parse --git-path MERGE_HEAD)"` form (printed
   `none` before every commit) instead of the plan's `ls` of the absolute
   path - equivalent.
6. S2.2 Step 7 was followed by one extra verbose run of the two form test files
   to see the Priority tag case and the D10-order case by name on BOTH forms
   (the plain run reports counts only).

## Contradictions C1-C4 (plan section 6), resolved

- C1: the dashboard type is `UnitItem` (dashboard/src/api/types.ts:2652);
  `priority?: boolean` sits right after `same_day_rta` (:2724-2727).
- C2: the tag (`it.each` over the table) and DOM-order cases iterate
  `PROPERTY_FORM_FIELDS` on both forms; the mirror row and both checkboxes
  landed in the one S2.2 commit and those cases are green ("Priority carries
  its staff_only tag, outside its accessible name"; "the fields run in the D10
  order ..." on UnitCreateForm.test.tsx and ListingEditForm.test.tsx).
- C3 (PR28): off is stored `false`, never removed - the Edit form sends
  `priority: false` when a stored true is unchecked
  (ListingEditForm.tsx:193; ListingEditForm.test.tsx case 'unchecking a stored
  true sends false'); the validator refuses `null`
  (app/test/unitFields.test.ts:853-860).
- C4: unitsRepo.ts:464 (the line holding the em dash) was replaced whole; the
  new comment is ASCII (unitsRepo.ts:464-466).

## Watch item WI12 (owned by S2)

- Never on the flyer: the PIN 'toUnitFlyer never carries priority, on or off'
  (app/test/unitFields.test.ts:863) is green; the `fullUnit` fixture carries
  `priority: true` (:647) and the allowlist wall still lists `priority`; the
  parity walk with SAMPLE `priority: true`
  (app/test/propertyFormFlyerParity.test.ts:51) and base `priority: false`
  (:108) is green - Priority is Staff only on every base.
- A legacy string reads off: green in ListingEditForm.test.tsx ('a legacy
  stored string reads as off and is never sent untouched') and
  ListingDetail.test.tsx ('a legacy stored string: the row reads No and there
  is no pill'). Every reader added is `=== true` (ListingEditForm.tsx:121,
  :193; ListingDetail.tsx:890, :1006).
- 36 rows in DOM order: THREE tables at 36 rows, all green -
  app/test/propertyFormFlyerParity.test.ts:178-202,
  dashboard/src/routes/listing/requirements.test.ts:223-264 (two-element) and
  :598-645 (three-element); requirementsMirror.test.ts (app table equals the
  mirror) green; the D10-order cases green on both forms.

## PR3

`app/test/seedPriority.test.ts` (PIN) green: no lean or full seed unit holds a
`priority` key.

## S2.4 Step 1 (no new reader)

- `git diff --stat d0e2c2d8 -- app/src/lib/import app/src/services/extraction
  app/src/jobs/extraction.ts app/src/routes/public.ts app/src/lib/seed` prints
  only `app/src/lib/seed/cast.ts | 7 +++++++` (S1.6).
- `git grep -n "priority" -- app/src/services/extraction
  app/src/jobs/extraction.ts app/src/lib/import/apply.ts` prints only
  orgListBlock.ts:98 and :136 (the org-list ordering sense).
- Wider sweep (`git grep -n -w priority` over app/src, app/scripts,
  dashboard/src, e2e, scripts; non-test): the unit-priority readers are only
  the S2 lines above; `AirtableProperty.priority` (airtableSource.ts:58, :156)
  is its own interface, parsed and never written (spec D6: importer
  unchanged); the rest are the ordinary word.

## Risks and notes

- The new ListingEditForm tag case for the Priority row prints the same React
  "not wrapped in act(...)" stderr warning every synchronous-render case in
  that file already prints (e.g. 'prefills current values'); pre-existing
  pattern, no failure.
- No seed carries Priority (PR3), so the full world shows no pill; S7's e2e
  must set it through a form (its cross-slice note already says so). S7 may
  add 'Priority' to the flyer "Gone" list in
  e2e/tests/dashboard-next/flyer-leads.spec.ts (plan cross-slice note) - not
  done here (S7 owns new e2e).
- The pill sits in the dark header next to the status; its own text contrast
  is the type-pill amber's (about 5.0:1). Not checked in a browser here (no
  e2e in S2).
- Untrimmed input paths: none (a checkbox).

## Commands run (exit codes, counts)

App runs from `W:/tmp/wp1-b1-ranking-inputs/app`, dashboard runs from
`W:/tmp/wp1-b1-ranking-inputs/dashboard`, typecheck and lint from the worktree
root; nothing piped (output redirected to `.superpowers/sdd/s2-*.log`).
DynamoDB Local was already running (G3).

| Step | Command | Result |
|---|---|---|
| S2.1 RED | `npx vitest run test/unitFields.test.ts test/seedPriority.test.ts` | exit 1, 2 failed / 83 passed: `priority must be a string` for true/false; `'high'` accepted (stated reason); the flyer PIN and seed PIN passed |
| S2.1 GREEN | `npx vitest run test/unitFields.test.ts test/seedPriority.test.ts test/propertyFormFlyerParity.test.ts` | exit 0, 3 files / 95 tests |
| S2.1 | `npm run typecheck` | exit 0 |
| S2.2 RED app | `npx vitest run test/propertyFormFlyerParity.test.ts` | exit 1, 1 failed / 9 passed: length 35, expected 36 (stated reason) |
| S2.2 RED dash | `npx vitest run src/routes/listing/requirements.test.ts src/routes/listing/UnitCreateForm.test.tsx src/routes/listing/ListingEditForm.test.tsx` | exit 1, 6 failed / 233 passed: both requirements.test.ts tables (35 vs 36 with Priority); no checkbox named Priority on either form (1 New, 3 Edit cases); the New-form PIN passed |
| S2.2 GREEN app | `npx vitest run test/propertyFormFlyerParity.test.ts test/unitFields.test.ts` | exit 0, 2 files / 94 tests |
| S2.2 GREEN dash | `npx vitest run src/routes/listing/requirements.test.ts src/routes/listing/requirementsMirror.test.ts src/routes/listing/requirementForm.test.ts src/routes/listing/UnitCreateForm.test.tsx src/routes/listing/ListingEditForm.test.tsx` | exit 0, 5 files / 286 tests |
| S2.2 extra | the two form files with `--reporter=verbose` | exit 0; Priority tag case and D10-order case green on both forms |
| S2.2 | `npm run typecheck` | exit 0 |
| S2.3 RED | `npx vitest run src/routes/listing/ListingDetail.test.tsx` | exit 1, the 4 new cases failed: "Unable to find an element with the text: Priority" in Property details (stated reason) |
| S2.3 GREEN | same | exit 0, 1 file / 140 tests |
| S2.3 | `npm run typecheck` | exit 0 |
| S2.4 Step 1 | diff stat + grep above | as recorded above |
| S2.4 Step 2 | `npm run typecheck` | exit 0 |
| S2.4 Step 3 | `npx eslint <the plan's 15 files>` | exit 0, no output - no errors, none pre-existing in these files; the list equals S2's `.ts`/`.tsx` changes (the CSS module is not linted by the config) |
| S2.4 Step 4 app | `env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL npx vitest run` | exit 0, 538 files / 11440 passed, 1 skipped (S1 close 537 / 11436 + 1 skipped; +1 file, +4 tests); 0 `[dynamoAdmin]` lines |
| S2.4 Step 4 dashboard | `npx vitest run` | exit 0, 272 files / 5618 passed (S1 close 272 / 5607; +11 tests: 3 New form, 4 Edit form, 4 ListingDetail) |
| S2.4 Step 5 | `git diff -U0 d0e2c2d8 -- app dashboard`, added lines through `tr -d '\11\12\15\40-\176' \| wc -c` | 0 |

Per-commit ASCII checks (the new test file whole, pre-existing files added
lines only) all printed 0; the `\u` escape count of every touched file is
unchanged (0 before, 0 after). No red file in either workspace; nothing
re-run.

## WORKLIST items applied

WL-4 (S2.2), WL-5 (S2.3); G1 (app runs), G2 (absolute paths), G3 (no
db:start), G4 (no event).
