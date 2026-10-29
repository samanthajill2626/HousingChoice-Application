# S3 slice report - Pool and cards (WP1 B2a), tasks S3.1-S3.12

- Implementers: the S3a child (S3.1-S3.6; its report is
  [`S3a-report.md`](S3a-report.md) in this directory and is part of this
  record) and the S3b child (S3.7-S3.12, this report), both Claude Opus 5.5,
  2026-10-29.
- Branch `feat/wp1-b2-ranking-engine`, worktree `W:/tmp/wp1-b2-ranking-engine`.
  Range: 667fe48b (the S2 report, the commit before S3.1) .. this report's
  commit. S3a: 1d606409..6a84269d (six tasks and its report); S3b:
  f77d55d9..48815350 (five tasks) plus this report.
- Scope: plan section 7 - the slice head (Published shapes, Scope,
  Contradictions, Assembly rulings, plan review fixes, Cross-slice notes; plan
  10010-10544) and tasks S3.1-S3.12 with the S3 coverage table (plan
  10545-16251). Spec D1, D2.1-D2.5, D3, D13, and D9's unverified rule as S3
  implements it. Watch items WI4 (S3 half), WI8, WI11, WI12, WI20. WORKLIST:
  section G and WL-S3-1 .. WL-S3-4.
- Verdict: twelve tasks, one commit each (S3.12 is this report). Every task
  went RED for its stated reason and then GREEN. Every shipped code path is
  byte-identical to its plan block (checked mechanically, section 2) except
  the three sanctioned WORKLIST edits: WL-S3-1 and WL-S3-2 in `cardFields.ts`
  (S3a) and WL-S3-3 in `assemble.ts` `propertyDisplay` with its test (S3b).
  Close gates: root `npm run typecheck` exit 0; eslint on the slice's 23
  files exit 0; ASCII sweep all 0; the app workspace run exit 0, 572 files
  passed, 12197 tests passed, 1 skipped (a diagnostic), no red file.
  No one-value test fix. No QUESTION.

## 1. Tasks and commits

All paths under `app/`.

| Task | Commit | Files |
|---|---|---|
| S3.1 shared types, the two registries, the classification test, the widened reader scan | 1d606409 | `src/services/ranking/types.ts`, `src/services/ranking/cardFields.ts`, `test/rankingCardFields.test.ts`, `test/tenantMatchingInputsReaders.test.ts` |
| S3.2 pair facts, the seen set, the shared fixtures | 0cecf51b | `src/services/ranking/pairHistory.ts`, `src/services/ranking/seenSet.ts`, `test/helpers/rankingFixtures.ts`, `test/rankingSeenSet.test.ts` |
| S3.3 the attach step | 29c04070 | `src/services/ranking/seenFeedback.ts`, `test/rankingSeenFeedback.test.ts` |
| S3.4 the pool's rules | 35d25de4 | `src/services/ranking/pool.ts`, `test/rankingPoolRules.test.ts` |
| S3.5 computePool, the one anchor-exists rule | 2eef7449 | `src/services/ranking/pool.ts`, `test/rankingPool.test.ts` |
| S3.6 cards.ts, the property half | c03c0f31 | `src/services/ranking/cards.ts`, `test/rankingPropertyCard.test.ts` |
| (S3a report) | 6a84269d | `docs/.../slices/S3a-report.md` |
| S3.7 cards.ts, the tenant half: tenantCard, the recency bucket, properties seen with the bound | f77d55d9 | `src/services/ranking/cards.ts` (import swap + append), `test/rankingTenantCard.test.ts` |
| S3.8 the completeness pass | b7257776 | `src/services/ranking/completeness.ts`, `test/rankingCompleteness.test.ts` |
| S3.9 the fingerprints | 94dca430 | `src/services/ranking/fingerprints.ts`, `test/rankingFingerprints.test.ts` |
| S3.10 the two sides, every WI11 invariant a named test | 3f39b15a | `src/services/ranking/assemble.ts`, `test/rankingFingerprintInvariants.test.ts` |
| S3.11 assembleRanking, the deps builder, property facts, the display rule (+ WL-S3-3) | 48815350 | `src/services/ranking/assemble.ts` (import swap + append + WL-S3-3), `test/rankingAssemble.test.ts` |
| S3.12 close and this report | this commit | `docs/.../slices/S3-report.md` |

## 2. Test commands and counts

S3a's runs (S3.1-S3.6, 97 tests at its close) are listed in
`S3a-report.md` section 2. S3b's runs, in order. Pure suites as the plan
writes them: `cd W:/tmp/wp1-b2-ranking-engine/app && ALLOW_SKIP_DYNAMO_TESTS=1 npx vitest run <files>`.
`env | grep '^AWS_'` counted 0, so no `env -u` prefix was needed.

1. S3.7 RED (`rankingTenantCard`): 1 file, 10 of 10 failed - 9 "TypeError:
   (0 , tenantCard) is not a function", 1 "(0 , recencyBucket) is not a
   function". The stated reason (G4: vitest 3.2.6 wording).
2. S3.7 GREEN (`rankingTenantCard`, `rankingPropertyCard`, reader test): 3
   files, 25 passed (10 + 12 + 3).
3. S3.8 RED (`rankingCompleteness`): 1 file failed, no tests - "Cannot find
   module '../src/services/ranking/completeness.js'" / "Failed to load url".
   Stated reason.
4. S3.8 GREEN (`rankingCompleteness`, reader test): 2 files, 16 passed (13 + 3).
5. S3.9 RED (`rankingFingerprints`): 1 file failed - "Cannot find module
   '../src/services/ranking/fingerprints.js'". Stated reason.
6. S3.9 GREEN (`rankingFingerprints`, reader test): 2 files, 13 passed (10 + 3).
7. S3.10 RED (`rankingFingerprintInvariants`): 1 file failed - "Cannot find
   module '../src/services/ranking/assemble.js'". Stated reason.
8. S3.10 GREEN (`rankingFingerprintInvariants`, reader test): 2 files, 17
   passed (14 + 3); a `--reporter=verbose` run lists each case (section 3,
   WI11).
9. S3.11 RED, the plan's test file as written: 1 file, 21 of 21 failed - 17
   "(0 , assembleRanking) is not a function", 3 "(0 , loadPropertyFacts)", 1
   "(0 , createAssembleDeps)". Stated reason.
10. S3.11 RED again after the WL-S3-3 test edit (section 7): 22 of 22 failed -
    the same 21 plus 1 "(0 , propertyDisplay) is not a function".
11. S3.11 with the plan's code applied verbatim, before the WL-S3-3 source
    edit: 1 failed, 21 passed (22). The one red case is the WL-S3-3 case:
    "expected 'a property with no address on file' to be '9 Old Rd,
    Atlanta, GA 30310'" - red for WL-S3-3's own reason, so the ruling's test
    is not vacuous.
12. S3.11 GREEN after the WL-S3-3 source edit (`rankingAssemble`,
    `rankingFingerprintInvariants`, reader test): 3 files, 39 passed
    (22 + 14 + 3).
13. S3.12 Step 4, the app workspace once, bare and without
    `ALLOW_SKIP_DYNAMO_TESTS` (DynamoDB Local up):
    `cd W:/tmp/wp1-b2-ranking-engine/app && npx vitest run` (output to a
    scratch log, no pipe) - EXIT 0. Test Files 572 passed (572); Tests 12197
    passed, 1 skipped (12198); duration 136.8 s. The one skip is the
    diagnostic `app/test/staticSmoke.test.ts` "built dashboard identity tags
    (diagnostic: PASS or SKIP, never FAIL)" - this worktree has no built
    `dashboard/dist`. No red file, so no re-run was needed. No
    `[dynamoAdmin]` line in the output (grep count 0). Every S3 file ran green
    inside it (the twelve listed below, 166 tests), and so did the five S2
    `rankingRuns*` suites and the five source-walking suites that read every
    new file (`autoRoutingEligibleSingleSource`, `orgListsRetired`,
    `propertyContactLadderSingleSource`, `tourCopyCallSites`,
    `dynamoKeyLedger`).

Slice totals for the twelve S3 test files at 48815350: rankingCardFields 20,
tenantMatchingInputsReaders 3, rankingSeenSet 16, rankingSeenFeedback 7,
rankingPoolRules 22, rankingPool 17, rankingPropertyCard 12,
rankingTenantCard 10, rankingCompleteness 13, rankingFingerprints 10,
rankingFingerprintInvariants 14, rankingAssemble 22 = 166 tests (the plan's
165 plus the one WL-S3-3 case).

Typecheck: after each of S3.7-S3.11, app `npx tsc -p tsconfig.test.json
--noEmit` exit 0 (the test project includes `src`); after S3.11 also
`npx tsc -p tsconfig.json --noEmit` exit 0. S3.12 Step 2, the root
`npm run typecheck` (bare, all five workspaces): exit 0. This is source 1
of the classification test (the two `satisfies Record<...>` clauses in
`cardFields.ts`; FB17).

ESLint (`npx eslint <files>` from the worktree root): each of S3.7-S3.11 on
its own two files, exit 0. S3.12 Step 3, the slice's 23 files (the plan's
list): exit 0.

ASCII: `tr -d '\11\12\15\40-\176' < FILE | wc -c` printed 0 for every file
after each write. S3.12 Step 5: all 0 for the ten sources, the helper and
the sixteen `app/test/ranking*.test.ts` the glob matches (it also sweeps S2's
five `rankingRuns*` tests), and 0 for the reader test's added lines against
404e039d.

Byte-exactness (beyond the plan): every plan block was written with
`sed -n '<first>,<last>p' <plan>` (appends with `>>`; G2), and each result
was compared with a scratch script that rebuilds the expected bytes from the
plan's line ranges, applying the task's own replace and append steps. All
IDENTICAL: `cards.ts` (the S3.6 block 13645-13818, S3.7's import swap
14095-14104 -> 14110-14123, the append 14136-14268), `rankingTenantCard.test.ts`
(13856-14079), `completeness.ts` (14459-14578), `rankingCompleteness.test.ts`
(14302-14444), `fingerprints.ts` (14744-14831), `rankingFingerprints.test.ts`
(14616-14729), `rankingFingerprintInvariants.test.ts` (14869-15042),
`assemble.ts` before the WL-S3-3 edit (15061-15164, the import swap
15618-15627 -> 15633-15662, the append 15675-16066), and
`rankingAssemble.test.ts` before the WL-S3-3 edit (15200-15601). Each S3.7 and
S3.11 anchor matched exactly once.

Not run (the orchestrator's gates): the root `npm test`, `npm run smoke`,
`npm run e2e`.

## 3. Watch items

- WI4 (S3 half) - PASS. `TENANT_CARD_FIELDS.notes_updated_at` is
  `exclude(REASON.timestamp)` (`app/src/services/ranking/cardFields.ts:189`).
  Pinned by `app/test/rankingCardFields.test.ts:180` ("excludes every tenant
  attribute spec D2.1 names (WI4: notes_updated_at among them)", the
  assertion at :199) and by `app/test/rankingTenantCard.test.ts:106`
  (`expect(card).not.toHaveProperty('notes_updated_at')`, inside the exact
  card case at :102, whose contact carries `notes_updated_at` at :55). Both
  green.
- WI8 - PASS. `app/test/tenantMatchingInputsReaders.test.ts:34-46` lists
  `services/ranking/*.ts` at run time, exempts only `examples.ts`, and adds
  `adapters/ranking.ts` / `adapters/rankingFake.ts` through `existsSync`. At
  48815350 the scan read B1's ten readers plus all ten ranking files -
  `assemble.ts`, `cardFields.ts`, `cards.ts`, `completeness.ts`,
  `fingerprints.ts`, `pairHistory.ts`, `pool.ts`, `seenFeedback.ts`,
  `seenSet.ts`, `types.ts`; neither adapter exists yet (S4), so the driver
  list is empty. Green in every S3b run (3 tests). `grep -c -E
  "area_preference|max_tenant_portion|accessibility_need|preferences_constraints"`
  prints 0 for each of the ten ranking files.
- WI11 - PASS. Every invariant is a named case in
  `app/test/rankingFingerprintInvariants.test.ts`, run through the REAL
  pipeline (`buildTenantSide`: the seen set, the attach step, the bound,
  `tenantCard`, `propertyCard` for each seen home, the fingerprint) from raw
  send and tour rows; all green (verbose run, 14 of 14):
  - No change (six): `:78` a bare send (tenant fingerprint and the pair
    fingerprints of u1-u4 unchanged); `:85` a re-send that re-orders the
    listed entries (listed order `u3,u2,u5,u1` -> `u3,u2,u1,u5`, nothing
    changes); `:96` a ninth send that pushes u1 off the eight listed entries;
    `:106` the first send of a home a Notes line already names (the line
    moves out of the card's notes, the fingerprint and the pair fingerprint
    stay); `:117` a tour reminder or roster change (`roster`, `rosterVersion`,
    `currentLadderId`, `groupThreadId`, `lastMarkedAt`, `updatedAt` changed;
    tenant and pair fingerprints unchanged); `:132` an edit to a home with
    feedback only (its unit card fingerprint changes, the tenant fingerprint
    does not).
  - Change (four): `:148` a decline (the tenant fingerprint and that pair's
    fingerprint change, another pair's does not); `:155` a tour; `:161` a
    feedback line on any property; `:166` an edit to any card field of a seen
    home with a decline (u2 `notes`) or a tour (u3 `rent_max`).
  - Supporting (unnamed): `:139` recency enters only as its bucket (5 days ago
    vs 3 days ago: same; 10 days: changes); `:171` a change to the tenant's
    own card changes it.
  - What each fingerprint covers is pinned at the unit level in
    `app/test/rankingFingerprints.test.ts` (S3.9: `:75` ignores the arranged
    notes and propertiesSeen, `:85` only outcome homes and only their card
    fingerprints are consulted, `:109` sends and activity of an outcome home
    are ignored). The out-of-date REASONS on read are S6's.
- WI12 - PASS. `grep -nE "^export function [A-Za-z]*Card\(" app/src/services/ranking/*.ts`
  at 48815350 prints exactly:
  `app/src/services/ranking/cards.ts:147:export function propertyCard(unit: UnitItem, ctx: PropertyCardCtx): Card {`
  and
  `app/src/services/ranking/cards.ts:290:export function tenantCard(contact: ContactItem, ctx: TenantCardCtx): Card {`
  (the fingerprint functions end in `Fingerprint(` and do not match). The
  only callers of `tenantCard(` / `propertyCard(` in `app/src` are the two
  sides in `assemble.ts` (`:85` buildPropertySide, `:101` each seen home in
  buildTenantSide, `:108` the tenant card); `grep` outside
  `services/ranking/` finds none. Equality pins: `rankingFingerprintInvariants.test.ts:57`
  (buildPropertySide = propertyCard, propertyMissing, propertyFacts and the
  card fingerprint), `:68` (buildTenantSide = tenantCard over the seen set,
  the tenant gaps, each LISTED home with its full card),
  `rankingAssemble.test.ts:83` (property anchor: anchor and every candidate
  card equal the sides') and `:237` (tenant anchor).
- WI20 - PASS (S3a, S3.5). `pool.ts:373` asks
  `hasActivePlacementForOtherTenant(unit.unitId, anchor.contactId)`; pinned by
  `app/test/rankingPool.test.ts:202` ("available, not deleted, no active
  placement for ANOTHER tenant; the anchor own placement never excludes
  (WI20)"): with u-other placed for another tenant and u-mine placed for t1,
  the pool is `['u-a', 'u-mine']` and the recorded `placementChecks` are
  `['u-a:t1', 'u-mine:t1', 'u-other:t1']` (`:218`) - every check carries the
  anchor's id; the occupied and the soft-deleted unit are never checked.
- PR17 (D9's unverified rule as S3 implements it) - PASS. In
  `assembleRanking` every candidate read is wrapped in `settle`
  (`assemble.ts:373` a tenant candidate's sends, tours, units batch and,
  switch on, landlords; `:444` a property candidate's landlord) and becomes
  an `UnverifiedCandidate` in place, logged at warn, never a throw; only the
  anchor's own reads return `anchor_unreadable` (`:359-361` a property
  anchor's landlord read, switch on; `:430-432` a tenant anchor's seen-set
  reads), each carrying the pool's ids (PR38 / PR43). Pins:
  `rankingAssemble.test.ts:137` (an incomplete units read: only that
  candidate unverified, its exact object, never "not on file"), `:160` (a
  failed tours read), `:199` (a failed sends read), `:404` (a tenant anchor's
  property candidate whose landlord cannot be read: unverified, facts null),
  `:273` and `:284` (the tenant anchor's own reads fail the whole result with
  the pool's unit ids), `:392` (PR43, the property anchor's landlord read).
  No flag record is read in S3.

## 4. WORKLIST items

- G1 - no `npm ci` / `npm install` / `npm run db:start`; DynamoDB Local used as
  found (`hc-dynamodb-local` up); no `AWS_*` exported.
- G2 - every plan block containing a backslash was written with `sed -n` (the
  S3.7 test's six escape lines, the `general.join('\n')` line of the S3.7
  append, `completeness.ts`'s `/\s+/g`, the S3.10 test's four `\n` lines) and
  checked after the copy (`grep -F` for the backslash lines, the IDENTICAL
  compare, the ASCII count). The Edit-tool edits (the S3.7 and S3.11 import
  swaps, the WL-S3-3 source and test edits) contain no backslash.
- G3 - no S3b comment speaks about `failedBatches`, unwritten matches,
  `promptFingerprint` or unlawful-flag grouping. (S3a applied WL-S3-1.)
- G4 - every RED was for its stated reason (section 2); the wording is
  vitest 3.2.6's.
- G5 - `PROPERTIES_SEEN_KEY` (with `TENANT_NOTES_KEY` and
  `LAST_HEARD_FROM_KEY`) is defined once, `cards.ts:205-207`;
  `fingerprints.ts:22` imports it. S4's prompt.ts must import it from
  `./cards.js` (WL-S4-1).
- G6 - no `ANTHROPIC_*` value read, printed or used; nothing here builds a
  client.
- G7 - every command ran in the foreground with a timeout, except the app
  workspace run (S3.12 Step 4), which ran in the background writing to a
  scratch log and an exit marker and was waited for inside this turn; no
  source was edited while it ran; no e2e run.
- WL-S3-1 - DONE by S3a (`cardFields.ts:352-361`, comment only).
- WL-S3-2 - DONE by S3a (`notes_updated_at` dropped from `UntypedTenantKey`;
  still classified exclude at `cardFields.ts:189`).
- WL-S3-3 - DONE (S3.11, 48815350). First the model-facing check the ruling
  requires: `propertyDisplay` feeds NO model-facing text. In S3 it sets only
  `AssembledAnchor.display` (a property anchor) and the `display` of a
  property candidate (a tenant anchor). In the plan's later slices `display`
  reaches only staff surfaces: S4's `buildRankingBatch` builds the user text
  from the cards, the `homes` labels (`SeenHomeCard.label` =
  `SeenHome.label`), the missing labels and the pair history, and never reads
  `display` (plan ~19961-20025); `buildRankingPrompt` copies `display` only
  into `RankingPromptHandle` (plan ~20094-20102), which S5 stores on the run
  results (the admin run detail); S6 uses it for the read's rows, the
  pool-too-large anchor block and the tenant-anchor tie sort (plan ~27516,
  ~27582, ~27609); S7 renders it; S8 does not use it. Applied:
  `propertyDisplay` (`app/src/services/ranking/assemble.ts:254-266`) returns
  the label; else the trimmed stored address when `address` is a non-empty
  string (read as `unknown`: `UnitItem` types `address` as structured); else
  `NO_ADDRESS_LABEL`. `SeenHome.label`, `attachLabel` and the attach step are
  unchanged. Test: `app/test/rankingAssemble.test.ts:183` ("WL-S3-3: a legacy
  string address displays as stored, trimmed; the label the model sees and
  the attach step are unchanged") - `propertyDisplay` of a padded string and
  of a blank string; the property anchor's display and a property
  candidate's display read the stored string; the seen home's `label` in
  `homes` is still `NO_ADDRESS_LABEL` from both anchors; a Notes line naming
  the string address stays in the tenant card's notes (nothing attaches).
  Red against the plan's verbatim code (section 2 item 11), green after.
- WL-S3-4 - as expected (S3a): one lint error at S3.4, none from S3.5 on;
  S3.12's lint is clean.

## 5. Spec D2.4 - the classification test's three sources (FB18)

- Source 1, type level: the two `satisfies Record<...>` clauses in
  `cardFields.ts` (`:224` tenant base, `:317` property) - a new declared
  `ContactItem` / `UnitItem` key fails `npm run typecheck` there. Exit 0 at
  S3.12 Step 2, so every declared key is classified. No test file can see
  this guard (FB17).
- Sources 2 (writer keys) and 3 (seed worlds) are EVIDENCE, NOT PROOF. The
  writer scans in `rankingCardFields.test.ts` see only the code shapes their
  patterns name (`'x' in b`, `for (const key of [...])`, SET strings,
  `#alias` maps, `fact(...)`, the sign-up literal); a key read as `b.newKey`,
  or written by an unscanned writer, slips past them, and the seed scan sees
  only what the lean and full worlds carry. Nothing leaks either way - the
  card is an allowlist at runtime (pinned: `zz_unclassified` is absent from
  the exact tenant card, `rankingTenantCard.test.ts:102`, and from the exact
  property card in `rankingPropertyCard.test.ts`) - but such an attribute is
  then dropped silently instead of listed for classification. Each scan's
  minimum known set guards against a scan that silently finds nothing.
  Per-writer counts: `S3a-report.md` section 5.

## 6. Contradictions C1-C10 and the rulings applied

- C1 (the authority compare cite) - no code change; `pool.ts` folds case and
  spacing through `normalizeOrgText` on both sides (`pool.ts:75-81`), the
  widening spec D1 names; the parity block in `rankingPoolRules.test.ts`.
- C2 (`WRITABLE_FIELDS` not exported) - read by source scan with its
  tombstones (`rankingCardFields.test.ts`, "the units PATCH WRITABLE_FIELDS
  and its tombstones").
- C3 (no writer exports its keys) - five scans with minimum sets (section 5).
- C4 (seed attributes no list names) - `move_in_date` excluded as
  "unclassified at B2a" (`cardFields.ts:223`), pinned
  (`rankingCardFields.test.ts:361-363`, `unclassifiedKeys(TENANT)` =
  `['move_in_date']`). Spec D2.1 does name `caseworker` (excluded, other
  people); `move_in_date` is the one unnamed attribute (D3-5).
- C5 / PR23 (F2) - a home whose address gives no label reads
  `NO_ADDRESS_LABEL` with `attachLabel: undefined` (`seenSet.ts:94-95`); the
  attach step matches only a defined label (`seenFeedback.ts:45-55`); pinned in
  `rankingSeenSet.test.ts` / `rankingSeenFeedback.test.ts` and, for the
  string-address case, `rankingAssemble.test.ts:183`.
- C6 / PR21 (F1) - ONE rule: `readRankingAnchor` (`pool.ts:253`; a tenant
  anchor is a live contact typed `tenant`, a unit anchor a live unit of any
  status), `rankingAnchorExists` (`:265`) for S5's claim, `computePool` calls
  it; `rankingPool.test.ts:32`; `assembleRanking` passes the 404 through
  (`rankingAssemble.test.ts:220`, `u-nope`).
- C7 / PR23 (F3) - with the switch on, a landlord-default Pets item closes the
  property's `pets` gap (`completeness.ts:59-61`, `landlordDefaults`);
  `rankingCompleteness.test.ts:60` (off: still missing; on: closed).
- C8 - `AssembledCandidate` is a union on `unverified`
  (`assemble.ts:171-192`): the unverified arm carries `null` card, missing,
  pairHistory and fingerprints, and `propertyFacts` = the anchor's facts
  (property anchor) or `null` (tenant anchor); `rankingAssemble.test.ts:137`
  (exact object) and `:404` (facts null).
- C9 / PR20 / IR17 - each properties-seen entry names its home's `unitId`
  under the key `home` (`cards.ts:191-201`, `PropertiesSeenEntry`); S4
  replaces it before anything is sent. The tenant fingerprint drops
  `notes` and `propertiesSeen` (`fingerprints.ts:65-88`), so `home` never
  affects a fingerprint (`rankingFingerprints.test.ts:75`).
- C10 - pool order is ascending `contactId` / `unitId` (`pool.ts`
  `compareIds`); `assembleRanking` keeps it, an unverified candidate in its
  place (`rankingAssemble.test.ts:137`, `[false, true, false]`).
- IR7 - `display` is always a string: `tenantDisplay` (a name, else the
  contactId) and `propertyDisplay` (a label, else - WL-S3-3 - a stored
  address string, trimmed, else `NO_ADDRESS_LABEL`), `assemble.ts:249-266`;
  `rankingAssemble.test.ts:172`, `:183`.
- IR8 / FB19 - `poolRecencyAt` (`pool.ts:100`, the window's rule, the import
  exception) and `sortRecencyAt` (`:114`, spec D9, no import exception).
- IR9 - `createAssembleDeps` (`assemble.ts:280`) builds the contacts, units,
  placements, listing sends and tours repos and the organization names
  service on the given env / doc, config and logger passed through
  (`rankingAssemble.test.ts:350`: every gatherer method a function, the two
  table names prefixed); `loadPropertyFacts` (`assemble.ts:512`) - distinct
  ids, one complete units read, landlords only with the switch on, throws on
  an incomplete read, reads nothing for no ids (`:324`, `:332`, `:339`).
- PR17 - section 3.
- PR38 / PR43 - `AnchorUnreadable.candidateIds` is set on both anchor paths
  when the anchor's own reads fail after the pool was computed
  (`assemble.ts:361`, `:432`); pinned `rankingAssemble.test.ts:273`, `:284`,
  `:392`.
- FB4 / PR16 - `poolTooLargeMissing` (`assemble.ts:493`): a tenant anchor's
  `tenantMissing`; a property anchor's `propertyMissing` with the pool's
  organization list and, switch on, its landlord read here (THROWS
  `IncompleteBatchReadError` when that read cannot finish - the read's 503);
  `[]` for any other failure (`rankingAssemble.test.ts:293`, `:303`, `:314`).
- R2F10 - `tenantMissing` reads only `source: 'field'` inputs marked for
  completeness (`completeness.ts:76-95`; `rankingCompleteness.test.ts:101`).
- FB20 - the completeness `voucher_sizes` gap reads `recordedVoucherSizes`, the
  pool's normalizer (`completeness.ts:57`; a stored `[2.5]` is no size,
  `rankingCompleteness.test.ts:44`).
- FB21 - unmoved Notes text stays as stored, trimmed, line breaks and blank
  lines kept; only a box that lost lines to a listed home is rebuilt
  (`cards.ts` `arrangePropertiesSeen`; `rankingTenantCard.test.ts:113`).
- D2.3 reads - one `listByContact`, one `listByTenant` and ONE units batch read
  per tenant card (`assemble.ts:314-326` `readTenantInputs`;
  `rankingAssemble.test.ts:130`), at most `rankingReadConcurrency` candidate
  reads in flight (`mapWithConcurrency`; `:211`, max in flight 2 of 6).

## 7. Deviations from the plan text

- WL-S3-3 (binding WORKLIST ruling; the worklist wins over slice text):
  - Source: `propertyDisplay` (`assemble.ts:254-266`) gains the
    stored-string step and a doc comment saying it is display only. The rest
    of `assemble.ts` is byte-identical to the plan.
  - Test: the plan's IR7 case built its placeholder anchor from a legacy
    STRING address, which under WL-S3-3 now displays as stored. The case
    (`rankingAssemble.test.ts:172`) now builds that anchor from a unit with no
    address (`unit('u-noaddress', { address: undefined })`, no cast) and still
    asserts `NO_ADDRESS_LABEL`, and its title names the middle step ("a label,
    else a stored address string (WL-S3-3), else the no-address
    placeholder"). Every other assertion of the case is unchanged. One case
    added (`:183`, section 4). The rest of the file is byte-identical to the
    plan.
  - The S3.11 commit body carries one "WORKLIST WL-S3-3: ..." line; the
    subject is the plan's.
- The MERGE_HEAD check used the brief's `test -e "$(git rev-parse
  --git-path MERGE_HEAD)"` form (it resolves to the worktree's own git dir,
  `.git/worktrees/wp1-b2-ranking-engine/MERGE_HEAD`; printed `ok` before every
  commit) instead of the plan's `ls`; equivalent.
- Extra verification beyond the plan: the IDENTICAL compare of every block, a
  `tsc` run after every task, the runtime-import map (no cycle; section 10),
  and the model-facing trace for WL-S3-3.
- No one-value test fix; every hand-worked expected value held as written.

## 8. QUESTIONS

None.

## 9. For the handback (Cameron)

- Spec D2.1 / PR28: attributes classified exclude as "unclassified at B2a" -
  `move_in_date` on tenants (placed matrix tenants,
  `app/src/lib/seed/matrix.ts:542` and `:568`); none on units
  (`unclassifiedKeys(PROPERTY_CARD_FIELDS)` is empty). Pinned by
  `rankingCardFields.test.ts:361-363`. Cameron classifies it.
- WL-S3-3 (orchestrator ruling, display only): on the Rankings page a
  property whose stored address is a plain string (57 of 60 full-world seed
  units; legacy dev data) is named by that string, trimmed, as every other
  staff page names it. The model still sees such a seen home as "a property
  with no address on file" (its card carries the address as stored), and a
  Notes line never attaches to it - unchanged from PR23.
- FB18: the classification test's writer and seed scans are evidence, not
  proof (section 5).

## 10. For S4, S5, S6 (what S3 shipped)

- Exports match the Published shapes (plan 10018-10259) name for name.
  Beyond the block: `TenantCardKey` / `PropertyCardKey` (`cardFields.ts:110`,
  `:114`) and `SeenSetInput` (`seenSet.ts:42`) (S3a). `CandidateBase` is not
  exported, as the block writes it.
- `cards.ts`: `TENANT_NOTES_KEY` 'notes', `LAST_HEARD_FROM_KEY`
  'lastHeardFrom', `PROPERTIES_SEEN_KEY` 'propertiesSeen' (`:205-207`) - S4
  imports `PROPERTIES_SEEN_KEY` from `./cards.js` (G5, WL-S4-1). A tenant
  card is: the included attributes in registry order (the four matching
  inputs keyed by their list LABELS), then `lastHeardFrom` (a
  `RecencyBucket`), then `propertiesSeen` (always present, possibly `[]`).
  Each entry: `{ home, label, sends, daysSinceLastSend, declined, tours,
  feedback }`, `home` = the seen home's unitId (S4 replaces it, PR20).
  `listedHomeIds(card)` gives the listed unitIds in card order.
- `assemble.ts`: `assembleRanking(anchor, { includeOlder, now }, deps)`
  returns `AssembledRanking | PoolFailure | AnchorUnreadable` and never
  throws for a candidate (PR17); errors from the pool's own list reads
  propagate. `homes` holds every LISTED seen home of every tenant card (label
  + full property card), first reference in pool order; for a property
  anchor it includes the anchor unit when a tenant card lists it (S4 writes
  that one as `anchor`). A listed home a complete read did not find has
  `card: {}` and label `MISSING_UNIT_LABEL`. `unverifiedCount` counts the
  unverified candidates (S5's "N could not be read" message); unverified
  candidates go into no batch.
- `mergeMissing([...anchor.missing, ...candidate.missing], unknowns)` is the
  match row's `missing[]` (S5).
- `createAssembleDeps({ config, logger, env?, doc? })` is the one production
  deps builder (S5 `jobWiring.ts`, S6 routes, the WI18 test);
  `loadPropertyFacts(unitIds, deps)` for the run detail (S6);
  `poolTooLargeMissing(failure, deps)` for the over-ceiling anchor block -
  it THROWS when the property anchor's landlord read cannot finish (503).
- `propertyDisplay` (WL-S3-3): label, else the trimmed stored string
  address, else `NO_ADDRESS_LABEL`. Display only - S6's tie sort and rows
  use it; nothing model-facing may.
- Runtime import graph of `services/ranking/` (no cycle): assemble -> cards,
  completeness, fingerprints, pairHistory, pool, seenSet; cards ->
  cardFields, pairHistory, pool, seenFeedback; completeness -> cards, pool;
  fingerprints -> cards; pool -> pairHistory; seenSet -> pairHistory;
  pairHistory -> seenSet is TYPE-only. S4 files that import `assemble.js`
  must not be imported by it.
- The reader scan (WI8) reads every new `services/ranking/*.ts` the moment it
  exists: S4-S6 sources must not spell `area_preference`,
  `max_tenant_portion`, `accessibility_need` or `preferences_constraints`
  (only `examples.ts` is exempt); S4's driver test should assert both
  adapter files exist so the adapter half of the scan is never vacuous.
- Fixtures: `app/test/helpers/rankingFixtures.ts` `rankingWorld(seed)` (S3a
  report section 10) serves every repo method the gatherer reads; S5 / S6
  tests can reuse it.

## 11. Untrimmed input

None new. The cards trim every text value (`cleanValue`); the attach step
trims each line and folds labels through `labelMatches`; the tenant authority
compare folds case and spacing; `mergeMissing` trims each unknown and folds
case and spacing; `tenantMissing` / `propertyMissing` treat whitespace-only
text as missing; `propertyDisplay` trims a stored string address.
