# S3a slice report - Pool and cards, tasks S3.1-S3.6 (WP1 B2a)

- Implementer: S3a child (Claude Opus 5.5), 2026-10-29.
- Branch `feat/wp1-b2-ranking-engine`, worktree `W:/tmp/wp1-b2-ranking-engine`.
  Range: 667fe48b (the S2 report, the commit before S3.1) .. c03c0f31, plus
  this report's commit.
- Scope: plan section 7 - the slice head (Published shapes, Scope,
  Contradictions, Assembly rulings, plan review fixes, Cross-slice notes;
  plan 10010-10544) and tasks S3.1-S3.6 (plan 10545-13838). S3.7-S3.12 are
  S3b's; the S3 slice report (S3.12 Step 6) is S3b's and links this file.
- Spec: D1, D2.1, D2.3 (the seen set and the attach step), D2.4, D2.5.
  Watch items: WI4 (S3 half), WI8, WI20; WI11 / WI12 where this range
  touches them. WORKLIST: section G, WL-S3-1, WL-S3-2, WL-S3-4.
- Verdict: six tasks, one commit each, each RED for its stated reason and
  then GREEN. Every shipped file is byte-identical to its plan block (checked
  with `diff` against `sed -n` of the plan ranges) except the two sanctioned
  WORKLIST edits in `cardFields.ts`. No one-value test fix. No QUESTION.

## 1. Tasks and commits

All paths under `app/`.

| Task | Commit | Files |
|---|---|---|
| S3.1 the shared types, the two registries, the classification test, the widened reader scan | 1d606409 | `src/services/ranking/types.ts`, `src/services/ranking/cardFields.ts`, `test/rankingCardFields.test.ts` (new), `test/tenantMatchingInputsReaders.test.ts` (replaced whole) |
| S3.2 pair facts and the seen set, the shared fixtures | 0cecf51b | `src/services/ranking/pairHistory.ts`, `src/services/ranking/seenSet.ts`, `test/helpers/rankingFixtures.ts`, `test/rankingSeenSet.test.ts` |
| S3.3 the attach step | 29c04070 | `src/services/ranking/seenFeedback.ts`, `test/rankingSeenFeedback.test.ts` |
| S3.4 the pool's rules | 35d25de4 | `src/services/ranking/pool.ts`, `test/rankingPoolRules.test.ts` |
| S3.5 computePool and the one anchor-exists rule | 2eef7449 | `src/services/ranking/pool.ts` (import swap + append), `test/rankingPool.test.ts` |
| S3.6 cards.ts, the property half | c03c0f31 | `src/services/ranking/cards.ts`, `test/rankingPropertyCard.test.ts` |
| report | this commit | `docs/.../slices/S3a-report.md` |

## 2. Test commands and counts (every run, in order)

Pure suites, run as the plan writes them:
`cd W:/tmp/wp1-b2-ranking-engine/app && ALLOW_SKIP_DYNAMO_TESTS=1 npx vitest run <files>`.
`env | grep '^AWS_'` counted 0, so no `env -u` prefix was needed.

1. S3.1 RED (`rankingCardFields`, `tenantMatchingInputsReaders`): 2 files
   failed, no tests ran - "Failed to load url
   ../src/services/ranking/cardFields.js" and "ENOENT: no such file or
   directory, scandir ...services/ranking" thrown by `readdirSync` at module
   load (reader test line 37). The stated reasons (G4: vitest 3.2.6 wording).
2. S3.1 GREEN: 2 files, 23 passed (20 + 3).
3. S3.2 RED (`rankingSeenSet`): 1 file failed - "Cannot find module
   '../src/services/ranking/pairHistory.js'". Stated reason.
4. S3.2 GREEN (`rankingSeenSet`, reader test): 2 files, 19 passed (16 + 3).
5. S3.3 RED (`rankingSeenFeedback`): 1 file failed - "Cannot find module
   '../src/services/ranking/seenFeedback.js'". Stated reason.
6. S3.3 GREEN (`rankingSeenFeedback`, reader test): 2 files, 10 passed (7 + 3).
7. S3.4 RED (`rankingPoolRules`): 1 file failed - "Cannot find module
   '../src/services/ranking/pool.js'". Stated reason.
8. S3.4 GREEN (`rankingPoolRules`, reader test): 2 files, 25 passed (22 + 3).
9. S3.5 RED (`rankingPool`): 1 file, 17 of 17 failed, each "TypeError:
   (0 , readRankingAnchor) is not a function" or "(0 , computePool) is not
   a function". Stated reason (the plan's "... is not a function").
10. S3.5 GREEN (`rankingPool`, `rankingPoolRules`, reader test): 3 files,
    42 passed (17 + 22 + 3).
11. S3.6 RED (`rankingPropertyCard`): 1 file failed - "Cannot find module
    '../src/services/ranking/cards.js'". Stated reason.
12. S3.6 GREEN (`rankingPropertyCard`, reader test): 2 files, 15 passed
    (12 + 3).
13. Range close, the seven S3a test files together: 7 files, 97 passed
    (rankingCardFields 20, tenantMatchingInputsReaders 3, rankingSeenSet 16,
    rankingSeenFeedback 7, rankingPoolRules 22, rankingPool 17,
    rankingPropertyCard 12).
14. Extra (beyond the plan): the five app suites that WALK `app/src` (one
    also `test/` and `scripts/`) and so read every new file -
    `autoRoutingEligibleSingleSource`, `orgListsRetired`,
    `propertyContactLadderSingleSource`, `tourCopyCallSites`,
    `dynamoKeyLedger` - run WITHOUT `ALLOW_SKIP_DYNAMO_TESTS` (DynamoDB Local
    up): 5 files, 14 passed. No `[dynamoAdmin]` line.

Typecheck: after S3.1, S3.2, S3.5 and S3.6, app `npx tsc -p tsconfig.json
--noEmit` and `npx tsc -p tsconfig.test.json` (the test project includes
`src`) both exit 0; after S3.3 and S3.4 the test project, exit 0. At the
range close the root `npm run typecheck` (bare, all five workspaces) exit 0.

ESLint (`npx eslint <files>` from the worktree root, the task's own files):
S3.1 4 files exit 0; S3.2 4 files exit 0; S3.3 2 files exit 0; S3.4 2 files
exit 1 with exactly ONE error, `pool.ts:22:32 'voucherSizeMatches' is
defined but never used` (`@typescript-eslint/no-unused-vars`) - WL-S3-4,
expected; S3.5 2 files exit 0 (that message gone: `computePool` uses the
import); S3.6 2 files exit 0. Range close: all 15 S3a files, exit 0.

ASCII: `tr -d '\11\12\15\40-\176' < FILE | wc -c` printed 0 for all 15
files (the 7 sources, the fixture helper, the 7 test files), after each
write and again at the close.

Not run (the orchestrator's gates, or S3.12's): the root `npm test`,
`npm run smoke`, `npm run e2e`, the app workspace's whole vitest run.

## 3. Watch items

- WI4 (S3 half) - PASS. `TENANT_CARD_FIELDS.notes_updated_at` is
  `exclude(REASON.timestamp)` (`app/src/services/ranking/cardFields.ts:189`),
  reaching the registry type through `KnownKeys<ContactItem>` now that
  WL-S3-2 dropped it from `UntypedTenantKey` (the `satisfies
  Record<TenantBaseKey, CardFieldUse>` at :224 compiles, so the key is
  required and classified). Pinned by `rankingCardFields.test.ts:180`
  ("excludes every tenant attribute spec D2.1 names (WI4: notes_updated_at
  among them)"), green. The tenant card's own pin
  (`not.toHaveProperty('notes_updated_at')`) is S3.7's
  `rankingTenantCard.test.ts` (S3b).
- WI8 - PASS. `app/test/tenantMatchingInputsReaders.test.ts:34-46` lists
  `services/ranking/*.ts` at run time (`readdirSync`), exempts only
  `examples.ts`, and adds `adapters/ranking.ts` / `adapters/rankingFake.ts`
  through `existsSync`. At c03c0f31 the scan reads B1's ten readers plus
  `cardFields.ts`, `cards.ts`, `pairHistory.ts`, `pool.ts`,
  `seenFeedback.ts`, `seenSet.ts`, `types.ts`; neither adapter exists yet
  (S4), so the driver list is empty - S4's driver test should assert both
  files exist (plan cross-slice note). Green (3 tests, the third pins
  `cardFields.ts` and `types.ts` in the list and `examples.ts` out). The
  plan's check `grep -c -E
  "area_preference|max_tenant_portion|accessibility_need|preferences_constraints"`
  prints 0 for all seven ranking files. B1's ten READERS are byte-identical
  to the replaced file's.
- WI20 - PASS. `pool.ts:370-375`: the tenant pool asks
  `hasActivePlacementForOtherTenant(unit.unitId, anchor.contactId)` for each
  unit that passed the size and authority rules, and drops only a unit held
  for a DIFFERENT tenant. `rankingPool.test.ts:202` ("the anchor own
  placement never excludes (WI20)"), green: with placements u-other ->
  t-someone-else and u-mine -> t1, the pool is `['u-a', 'u-mine']`, and
  `placementChecks` is `['u-a:t1', 'u-mine:t1', 'u-other:t1']` - every
  check carries the anchor's id; the occupied and the soft-deleted unit are
  never checked.
- WI11 - not in this range (the fingerprint invariants are S3.9 / S3.10).
  The facts it rests on shipped here: `tourProjection`
  (`pairHistory.ts:60`, status / outcome / scheduledAt only; the roster,
  rosterVersion, currentLadderId, lastMarkedAt, groupThreadId and updatedAt
  of a tour never reach it - `rankingSeenSet.test.ts` "keeps status, outcome
  and the scheduled time"), and the unbounded seen set (`seenSet.ts:72`).
- WI12 (S3a half) - `grep -n '^export function [A-Za-z]*Card(' app/src/services/ranking/`
  at c03c0f31 prints exactly `cards.ts:143:export function
  propertyCard(...)`; `tenantCard` is S3.7's. No caller of
  `propertyCard(` / `tenantCard(` exists outside `cards.ts` yet.

## 4. WORKLIST items

- G1 - no `npm ci` / `npm install` / `npm run db:start` run; DynamoDB Local
  used as found; no `AWS_*` exported.
- G2 - every plan code block was written with `sed -n '<first>,<last>p'
  <plan> > <target>` (S3.5's append with `>>`), never a heredoc; the
  backslash lines (17 in `rankingCardFields.test.ts`, 1 in the reader test,
  4 in `rankingSeenFeedback.test.ts`, 1 in `cards.ts`) were checked after
  the copy (e.g. `in b\\b`, the `[\x20-\x7e]` class, the CR LF literals,
  the `\d{4}` date pattern). The only Edit-tool edits (S3.5's import block,
  the two WORKLIST edits) contain no backslash.
- G3 - applied through WL-S3-1 (the one S3a comment that stated a withdrawn
  ruling). No other S3a comment speaks about `failedBatches`, unwritten
  matches, `promptFingerprint` or unlawful-flag grouping.
- G4 - every RED was for its stated reason (section 2); the wording is
  vitest 3.2.6's.
- G5 - nothing in this range re-spells a shared constant (S3.7 defines
  `PROPERTIES_SEEN_KEY`).
- G6 - no `ANTHROPIC_*` value read, printed or used; nothing here builds a
  client.
- G7 - every command ran in the foreground with a timeout and finished
  before the next step; no e2e run.
- WL-S3-1 - DONE (S3.1). `requirementItemOfField`'s doc comment
  (`cardFields.ts:352-361`) now says the item grouping is how capOf matches
  an ACCOMMODATION flag on any key of the item (PR29 as amended by PR40,
  PR45) and that an unlawful flag is never grouped - it matches only its own
  field, `landlord:<key>` read as `<key>` (PR40). Comment only.
- WL-S3-2 - DONE (S3.1). `| 'notes_updated_at'` removed from
  `UntypedTenantKey` (`cardFields.ts:69-107`); its `TENANT_BASE_FIELDS`
  entry stays (`:189`, exclude). Typecheck exit 0.
- WL-S3-3 - not in this range (S3.11's `propertyDisplay`); untouched.
- WL-S3-4 - as expected: the S3.4 commit carries the `voucherSizeMatches`
  import S3.5 first uses (one lint error at S3.4, none from S3.5 on); the
  import was NOT trimmed, so S3.5's quoted old import block matched S3.4's
  byte-exact (`diff` against plan 13083-13089, empty).

## 5. Spec D2.4 - the three sources (evidence, not proof)

- Source 1 (type level): the two `satisfies Record<...>` clauses
  (`cardFields.ts:224` tenant base, `:317` property) - a new declared
  `ContactItem` / `UnitItem` key fails `npm run typecheck` there (D3's
  probe at research time; nothing declared since is unclassified: typecheck
  exit 0).
- Source 2 (writer keys), the test's own patterns re-run in scratch at
  c03c0f31 (same code as the test): contacts parsers 40 keys (S1 added
  `notes_expected_updated_at`, `contacts.ts:688`, a guard never stored - in
  `NOT_ATTRIBUTES`, `rankingCardFields.test.ts:101`); importer contact 18
  (S1 added `notes_updated_at`, classified exclude); importer unit 13; public
  sign-up 15; `WRITABLE_FIELDS` + tombstones 42. Every key classified or a
  named non-attribute; every minimum set found.
- Source 3 (seed worlds, lean and full at a fixed instant): every tenant and
  unit attribute classified; the only unclassified-at-B2a key is
  `move_in_date`.
- FB18: sources 2 and 3 are EVIDENCE, NOT PROOF - the scans see only the
  shapes their patterns name (`'x' in b`, `for (const key of [...])`, SET
  strings, `#alias` maps, `fact(...)`, the sign-up literal); a key read as
  `b.newKey`, or written by an unscanned writer, slips past them. Nothing
  leaks either way (the card is an allowlist at runtime; S3.6's
  `zz_unclassified` unit attribute is absent from the exact card), but such
  an attribute is dropped silently instead of listed.

## 6. Head contradictions and rulings applied in this range

- C1 (authority compare cite) - no code change; the pool folds case and
  spacing through `normalizeOrgText` on both sides (`pool.ts:75-81`), the
  deliberate widening spec D1 names.
- C2 (`WRITABLE_FIELDS` not exported) - read by source scan with its
  tombstones (`rankingCardFields.test.ts`, "the units PATCH WRITABLE_FIELDS
  and its tombstones").
- C3 (no writer exports its keys) - five scans with minimum sets (section
  5).
- C4 (seed attributes no list names) - `move_in_date` excluded as
  "unclassified at B2a" (`cardFields.ts:223`), pinned by
  `rankingCardFields.test.ts:360-365`. Wording (D3-5): spec D2.1 does name
  `caseworker` (excluded, other people); `move_in_date` is the one unnamed
  attribute.
- C5 / PR23 (seen-set half) - a unit whose address gives no label reads
  `NO_ADDRESS_LABEL` and `attachLabel: undefined` (`seenSet.ts:94-95`);
  `attachFeedback` matches only a defined label (`seenFeedback.ts:45`);
  tests "a unit with no usable address reads the no-address label and
  attaches nothing (C5)" and "a home with no real label attaches nothing".
- C6 / PR21 - ONE rule: `readRankingAnchor` (`pool.ts:253`; a tenant anchor
  is a live contact typed `tenant`, a unit anchor a live unit of any
  status), `rankingAnchorExists` (`:265`) for S5's claim, `computePool`
  (`:397`) calls `readRankingAnchor`. `rankingPool.test.ts:32` (missing,
  soft-deleted, landlord-typed, wrong-kind ids all false).
- C7 / PR23 (S3.6 half) - `landlordDefaults` (`cards.ts:125`) gives the
  landlord's values only for items the property records nothing for; the
  pets completeness gap is S3.8's.
- C8 (unverified candidates), C9 (`home`) - S3.10 / S3.11 / S3.7; nothing
  here.
- C10 - pool order is ascending `contactId` / `unitId` (`pool.ts`
  `compareIds`); "reads every page, in ascending id order".
- FB3 - `matchingInputCardFields` includes only `source: 'field'` inputs
  (test with a `notes`-sourced input).
- FB4 - a `pool_too_large` failure carries `size`, `anchorRecord`, `anchor`,
  `anchorNotes`, `orgEntries` (both anchors tested); `poolTooLargeMissing`
  is S3.11's.
- FB19 / IR8 - `poolRecencyAt` (`pool.ts:100`, the window's rule, import
  exception) and `sortRecencyAt` (`:114`, spec D9, no import exception).
- FB20 (pool and card half) - `unitVoucherSizes` / `recordedVoucherSizes`
  (`pool.ts:59`, `:64`) are the one normalizer; the card's `voucherSizes`
  and `voucherSizesInferredFromBeds` use them (beds 5 -> `[4]`; a stored
  `[2.5]` is no size).
- PR33 - `cardFields.ts` exports `PROPERTY_FREE_TEXT_FIELDS`,
  `RANKED_REQUIREMENT_KEYS`, `EXCLUDED_REQUIREMENT_KEYS`,
  `LANDLORD_FIELD_PREFIX`, `landlordTwin`, `LANDLORD_DEFAULT_KEYS`,
  `requirementItemOfField`; `cards.ts` imports them.
- Untrimmed input: none new. `mapAuthorities` trims each recorded name; the
  tenant authority compare folds case and spacing; the property card trims
  every text value; the attach step trims each line and folds labels through
  `labelMatches`.

## 7. Deviations from the plan text

- The two WORKLIST edits in `cardFields.ts` (WL-S3-1 comment, WL-S3-2
  union member) - the only bytes that differ from the plan's blocks.
- Commit bodies: S3.1 and S3.4 add one "WORKLIST: ..." line each; every
  subject is the plan's.
- The MERGE_HEAD check used the brief's `test -e "$(git rev-parse
  --git-path MERGE_HEAD)"` form (printed ok before every commit) instead of
  the plan's `ls` of the worktree git dir; equivalent.
- Extra verification beyond the plan: the five source-walking suites, the
  per-file `diff` against the plan blocks, the writer-scan replica, and a
  `tsc` run after every task.
- No one-value test fix; every hand-worked expected value held as written.

## 8. QUESTIONS

None.

## 9. For the handback (Cameron)

- Spec D2.1 / PR28: attributes classified exclude as "unclassified at B2a" -
  `move_in_date` on tenants (placed matrix tenants,
  `app/src/lib/seed/matrix.ts:542` and `:568`). None on units
  (`unclassifiedKeys(PROPERTY_CARD_FIELDS)` is empty). Pinned by
  `rankingCardFields.test.ts:363-364`.

## 10. For S3b (S3.7-S3.12) - what S3a shipped

- Exports match the Published shapes (plan 10018-10259) for `types.ts`,
  `cardFields.ts`, `pairHistory.ts`, `seenSet.ts`, `seenFeedback.ts` and
  `pool.ts`, plus three exported names the block does not list:
  `TenantCardKey` and `PropertyCardKey` (types, `cardFields.ts:110`,
  `:114`) and `SeenSetInput` (`seenSet.ts:42`). `cards.ts` holds the
  PROPERTY half only: `PropertyCardCtx`, `PropertyFacts`,
  `LANDLORD_DEFAULTS_KEY`, `landlordDefaults`, `propertyCard`,
  `propertyFacts`. S3.7 adds `TenantCardCtx`, `PropertiesSeenEntry`,
  `RecencyBucket`, `TENANT_NOTES_KEY`, `LAST_HEARD_FROM_KEY`,
  `PROPERTIES_SEEN_KEY`, `tenantCard`, `recencyBucket`, `listedHomeIds`.
- `cards.ts` is byte-identical to plan 13645-13818, so S3.7's two anchors
  are there once each: the import block ending
  `import { mapAuthorities, recordedVoucherSizes, unitVoucherSizes } from './pool.js';`
  / `import type { Card } from './types.js';`, and the file's last lines
  `  return { recordedRequirementKeys, freeTextByField };` / `}`.
- `pool.ts` (401 lines) is the plan's S3.4 block with S3.5's import swap
  and append, byte-exact. Its imports alias the two repos' `isDeleted` as
  `isContactDeleted` / `isUnitDeleted`. `pairHistory.ts` imports `SeenHome`
  from `seenSet.ts` as a TYPE only (no runtime cycle).
- `app/test/helpers/rankingFixtures.ts` (plan 11514-11789, byte-exact):
  `NOW` (2026-10-28T12:00:00.000Z), `DAY_MS`, `ORG_ENTRIES` (ATLANTA,
  AUGUSTA, DCA, VASH, STEP_UP), `daysAgo`, `tenant`, `unit`, `sendRow`,
  `legacySendRow`, `tourRow`, `RankingTestConfig`, `DEFAULT_TEST_CONFIG`
  (window 90, maxPool 300, readConcurrency 4, seenMax 8, landlordCard
  false), `WorldSeed`, `rankingWorld(seed)` -> `{ state, calls, deps }`
  (state: `incompleteIds`, `failingSendReads`, `failingTourReads`,
  `orgListFails`, `leakDeletedInLists`, `sendReadDelayMs`; calls:
  `placementChecks`, `listByContact`, `unitBatchReads`, `contactBatchReads`,
  `inFlightSendReads`, `maxInFlightSendReads`). The fakes page two rows at
  a time.
- The reader scan reads every new `services/ranking/*.ts` the moment it
  exists: `completeness.ts`, `fingerprints.ts` and `assemble.ts` must not
  spell `area_preference`, `max_tenant_portion`, `accessibility_need` or
  `preferences_constraints` (D3 found none in the plan's blocks).
- S3.12 Step 1: `S3_FIRST` resolves to 1d606409 and `"$S3_FIRST^"` to
  667fe48b. The diff will ALSO list this report
  (`docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/slices/S3a-report.md`),
  which Step 1's expected list does not name - it is the sanctioned S3a
  report, not a defect. At c03c0f31 the code paths are 15 (7 sources, the
  helper, 6 `ranking*.test.ts`, the reader test); S3b adds 3 sources and 5
  tests for Step 1's 23.
- WL-S3-3 (`propertyDisplay` shows a trimmed stored string address before
  the placeholder; display only; `SeenHome.label` and `attachLabel`
  unchanged) is S3b's, at S3.11.
- Baselines at c03c0f31: root `npm run typecheck` exit 0; the seven S3a test
  files 97 passed; eslint clean on all 15 S3a files (S3.12 Step 3's list
  needs nothing for them).
