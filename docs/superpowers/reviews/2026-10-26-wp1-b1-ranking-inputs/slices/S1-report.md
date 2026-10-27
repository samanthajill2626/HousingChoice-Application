# S1 slice report - Tenant matching inputs (WP1 B1)

Slice S1 (plan section 5, tasks S1.1-S1.7; spec rev 10 D1, D2, section 4
"Seeds"). Implementer: Claude Opus 5.5. Branch head at start 0815616e;
main @d0e2c2d8 (unchanged during the slice). Findings only; code cited by
`file:line` at the S1 head.

## Commits

| Task | Commit | Subject |
|---|---|---|
| S1.1 | 8e476f42 | feat(contacts): one list of the tenant matching inputs and its staff value rule (wp1 b1 S1.1) |
| S1.2 | c0c2a448 | feat(contacts): PATCH and create accept the tenant matching inputs (wp1 b1 S1.2) |
| S1.3 | 498b503c | feat(dashboard): tenant matching inputs mirror, drift test, API types and chip labels (wp1 b1 S1.3) |
| S1.4 | cd77833f | feat(dashboard): edit form controls for the tenant matching inputs (wp1 b1 S1.4) |
| S1.5 | 61c406bf | feat(dashboard): Eligibility intake rows and chips for the tenant matching inputs (wp1 b1 S1.5) |
| S1.6 | 45ded355 | feat(seed): the full world's searching tenant records every tenant matching input (wp1 b1 S1.6) |
| S1.7 | (this report) | docs(records): wp1 b1 S1 slice report |

## What the tree held that the plan got wrong

Nothing material. Every quoted "old" anchor matched verbatim and was unique;
no Edit was refused (no G4 event). Line-number hints drifted only by a few
lines and the quoted text was the authority, e.g. the `useContactVocabulary`
import is ContactEditForm.tsx:62 (plan: :68), the EligibilityIntakeCard.test.tsx
BLANK counts sat at :36/:53/:59/:66 (plan: :35/:52/:59/:65). The D1-S1 research
(D1-S1-1..3) held: nothing blocked a step.

## Divergences (each deliberate)

1. WL-1 (E2-readers-2) applied in S1.5, same commit: the `.vProse` rule after
   `.v` (dashboard/src/routes/contact/Card.module.css:120-126, comment and body
   verbatim); `export const proseValueClass = styles.vProse ?? '';`
   (Card.tsx:506) placed right after `responseClass` with a three-line doc
   comment (the correction gave the export line alone); `prose: input.kind ===
   'text'` on each matching row and `prose?: boolean` in the row type
   (EligibilityIntakeCard.tsx:94, :103); the KV render line verbatim (:152).
   The matching-rows comment (:82-85) also says a free-text row renders as
   prose. All THREE text inputs render as prose (by `kind`, as WL-1 says), not
   only the textarea; the portion row does not.
2. WL-1 tests: the three `toHaveClass` assertions are one case in the new
   describe of EligibilityIntakeCard.test.tsx (one render carrying
   `lifEligible: true`, `area_preference: 'Decatur'` and
   `preferences_constraints: 'No apartments\nNeeds a yard'`). The CSS source pin
   is its own describe in the SAME file (WL-1 adds no test file; only the two
   Card files join the commit). It reads `match?.[1] ?? ''` after
   `expect(match).not.toBeNull()` instead of Timeline.styles.test.ts's
   `match![1]!` - same strength, no non-null assertion. The test file gained
   `node:fs` / `node:path` / `node:url` imports for that pin and
   `import styles from './Card.module.css'` (the AppFrame.test.tsx precedent).
3. WL-2 (D1-S1-2) applied: the `suggestions` prop comment replaced verbatim
   (EligibilityIntakeCard.tsx:38).
4. WL-3 (D1-S1-1) applied: the mirror header reads "the APP and E2E typechecks
   compile types.ts (app/test/contactTimeline.test.ts,
   e2e/tests/tour-roster.spec.ts), so this module stays import-free"
   (dashboard/src/routes/contact/tenantMatchingInputs.ts:12-14). The plan's S1
   cross-slice note (plan :646-649) still names the app typecheck only; text in
   the plan, not changed here.
5. S1.5's commit message carries one extra body line naming WL-1 / WL-2.
6. S1.7 Step 3's lint list also carries `dashboard/src/routes/contact/Card.tsx`
   (touched by WL-1). Card.module.css is CSS (not linted by the config).
7. S1.7 Step 4's app run was prefixed `env -u ANTHROPIC_API_KEY -u
   AI_EXTRACTION_MODEL` (G1). No app test or source imports
   `app/scripts/extraction-prompt-probe.ts` today
   (`git grep -n extraction-prompt-probe -- app/test app/src` prints nothing),
   and no ANTHROPIC_API_KEY / AWS_* variable is exported here; belt and braces.
8. S1.6: besides the plan's five files, all 18 `app/test/seed*` files were run
   once (extra coverage for WI7; see Commands).

## Contradictions C1-C5 (plan section 5), resolved

- C1: the card is EligibilityIntakeCard.tsx; TenantFile.tsx is untouched (S1.7
  Step 1 diff empty) and still renders it with `contact={contact}`
  (TenantFile.tsx:269). `Contact` now carries the four values and their
  `_source` keys, so no TenantFile change was needed.
- C2 (PR24): `Contact extends TenantMatchingInputValues,
  TenantMatchingInputSources` (dashboard/src/api/types.ts:2330, the sources
  type at :2245); `ContactPatch extends TenantMatchingInputPatch` (:2476, each
  key `| null`); `ContactCreate extends TenantMatchingInputValues` (:2304).
  Neither write type has a `_source` key.
- C3 (PR26): the portion control is `type="number"` with `step="any"` and no
  `min` / `max` (ContactEditForm.tsx:938-950, `step="any"` at :945); the three
  `it.each` cases (12.5, 20001, -5) prove the server's copy reaches
  `role="alert"`.
- C4 (PR23): the S1.1 additions (`TenantMatchingInputValues`,
  `parseTenantMatchingInputs`, the three copy helpers) and the mirror's
  additions (`TenantMatchingInputPatch`, `formatTenantMatchingValue`,
  `tenantMatchingFormValues`, `buildTenantMatchingPatch`) are built as named in
  the plan's cross-slice notes; nothing PR8 lists changed.
- C5 (PR25): persona 4, Monique Everett (`contact-cast-searching-tenant`)
  holds the four (app/src/lib/seed/cast.ts:454-460).
- Fallback in S1.2 Step 5 NOT needed: `ContactItem extends
  TenantMatchingInputValues` (app/src/repos/contactsRepo.ts:122) typechecks.

## Watch items owned by S1

- WI7 (lean seed byte-stable): S1.7 Step 1's diff of
  `app/src/lib/seed/lean.ts` (and the other untouched surfaces) printed NOTHING;
  the lean PIN in app/test/seedTenantMatchingInputs.test.ts is green; all 18
  seed suites green (284 tests). The full world has exactly one holder (the
  first full-profile case).
- WI11 (labels): the label case in app/test/tenantMatchingInputs.test.ts is
  green (case-insensitive: no new label or chip noun contains, or sits inside,
  an existing one). e2e `dialog.getByLabel('Pets')` (e2e/scenarios/steps.ts:930)
  and `dialog.getByLabel('Notes')` (steps.ts:1184;
  contact-detail.spec.ts:63, :77) still match one control each: no new label
  contains "pets" or "notes". The only `getByLabel('Tenant')`
  (e2e/tests/dashboard-next/placement-create.spec.ts:132) is in the placement
  dialog; no contact-page spec uses a bare `Tenant` label. The four edit-form
  labels are exact accessible names (ContactEditForm.test.tsx
  `toHaveAccessibleName` case).

## Risks and notes

- D1-S1-3 (recorded, no code): TenantFile also serves team_member contacts, so
  the four rows render BLANK there as the existing intake rows do; the edit
  form gates the controls on `isTenant` (the ContactEditForm.tsx:871 block).
- The new synchronous-render ContactEditForm cases print the same React "not
  wrapped in act(...)" stderr warning that every pre-existing synchronous-render
  case in that file prints (e.g. "shows tenant fields (voucher) and hides
  company for a tenant"); a pre-existing pattern, cause not investigated here,
  no failure.
- Untrimmed input paths: none new. Both server parsers trim through
  `parseTenantMatchingInputs` (contacts.ts:790, :997); the edit form trims
  before diffing (`buildTenantMatchingPatch`).
- A text suggestion's chip value is now shown trimmed
  (`formatSuggested` -> `formatTenantMatchingValue`); a portion suggestion that
  is not digits-only shows raw (S3 stores bare integers per PR27).

## Commands run (exit codes, counts)

App runs from `W:/tmp/wp1-b1-ranking-inputs/app`, dashboard runs from
`W:/tmp/wp1-b1-ranking-inputs/dashboard`, typecheck from the worktree root;
nothing piped (output redirected to `.superpowers/sdd/s1-*.log`). DynamoDB
Local was already running (G3).

| Step | Command | Result |
|---|---|---|
| S1.1 RED | `npx vitest run test/tenantMatchingInputs.test.ts` | exit 1: module `../src/lib/tenantMatchingInputs.js` not found (stated reason) |
| S1.1 GREEN | same | exit 0, 1 file / 12 tests |
| S1.1 | `npm run typecheck` | exit 0 |
| S1.2 RED | `npx vitest run test/contactTenantMatchingInputs.test.ts` | exit 1, 8/8 failed: 400 `no updatable fields supplied`, POST stored none (stated reason) |
| S1.2 GREEN | `npx vitest run test/contactTenantMatchingInputs.test.ts test/contactIntakeFields.test.ts test/contactTriage.test.ts` | exit 0, 3 files / 116 tests |
| S1.2 | `npm run typecheck` | exit 0 (no fallback) |
| S1.3 RED | `npx vitest run src/routes/contact/tenantMatchingInputsMirror.test.ts src/routes/contact/tenantMatchingInputs.test.ts` | exit 1: `./tenantMatchingInputs.js` does not resolve (stated reason) |
| S1.3 GREEN | same | exit 0, 2 files / 14 tests |
| S1.3 | `npm run typecheck` | exit 0 (app, dashboard and e2e programs) |
| S1.4 RED | `npx vitest run src/routes/contact/ContactEditForm.test.tsx src/routes/contact/ContactCreateForm.test.tsx` | exit 1, 9 failed (no `Area preference` / `Maximum tenant portion` control), 136 passed incl. the PIN |
| S1.4 GREEN | same | exit 0, 2 files / 145 tests |
| S1.4 | `npm run typecheck` | exit 0 |
| S1.5 RED | `npx vitest run src/routes/contact/EligibilityIntakeCard.test.tsx src/routes/contact/SuggestionChip.test.tsx` | exit 1, 11 failed (BLANK 5/4 vs 9/8; no matching rows; chip shows the raw value; no `.vProse` rule), 10 passed incl. the chip PIN |
| S1.5 GREEN | `npx vitest run src/routes/contact/EligibilityIntakeCard.test.tsx src/routes/contact/SuggestionChip.test.tsx src/routes/contact/TenantFile.test.tsx src/routes/contact/files.test.tsx` | exit 0, 4 files / 81 tests |
| S1.5 | `npm run typecheck` | exit 0 |
| S1.6 RED | `npx vitest run test/seedTenantMatchingInputs.test.ts` | exit 1: holders `[]` (stated reason); lean PIN passed |
| S1.6 GREEN | `npx vitest run test/seedTenantMatchingInputs.test.ts test/seedRequirements.test.ts test/seedMatrix.test.ts test/seedData.test.ts test/seedContactTypeInvariants.test.ts` | exit 0, 5 files / 87 tests |
| S1.6 extra | `npx vitest run test/seed` | exit 0, 18 files / 284 tests |
| S1.6 | `npm run typecheck` | exit 0 |
| S1.7 Step 1 | `git diff --stat d0e2c2d8 -- <public.ts, lib/import, today.ts, seed/lean.ts, services/extraction, jobs/extraction.ts, ContactCreateForm.tsx, TenantFile.tsx, settings/aiRuns>` | no output |
| S1.7 Step 2 | `npm run typecheck` | exit 0 |
| S1.7 Step 3 | `npx eslint <the plan's 19 files + dashboard/src/routes/contact/Card.tsx>` | exit 0, no output - no errors, no pre-existing errors in these files; the list equals `git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs'` (20 files) |
| S1.7 Step 4 app | `env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL npx vitest run` | exit 0, 537 files passed / 11436 tests passed, 1 skipped (baseline 534 / 11413 + 1 skipped; +3 files, +23 tests); 0 `[dynamoAdmin]` lines |
| S1.7 Step 4 dashboard | `npx vitest run` | exit 0, 272 files / 5607 tests passed (baseline 270 / 5575; +2 files, +32 tests) |
| S1.7 Step 5 | `git diff -U0 d0e2c2d8 -- app dashboard`, added lines through `tr -d '\11\12\15\40-\176' \| wc -c` | 0 |

Per-commit ASCII checks (new files whole, pre-existing files added lines
only) all printed 0. The `\u2014` escape in Card.tsx:138 survived the WL-1
edit (`grep -nF '\u'`). No red file in either workspace; nothing re-run.
