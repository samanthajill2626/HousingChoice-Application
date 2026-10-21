# U6 (S4a) - Matching, app side: several voucher sizes - Tasks 4.1, 4.2, 4.3, 4.4

- Unit: U6, slice S4 app part (plan Tasks 4.1-4.4), implementer model Claude Opus 5.5.
- Branch `feat/property-requirements`, worktree `W:/tmp/property-requirements`,
  started at `a8aca813` (U5's report commit).
- Rulings carried: plan 2.5 (the binding Matching interface), AR22 (integers
  >= 0 only in BOTH reader arms, then min(n, 4), de-duplicated, ascending),
  AR25 ("bedroomSizes wins": while a non-null list is present the legacy key
  is neither read nor validated; an empty list wins; `bedroomSizes: null` is
  absent); worklist OR-8 (Task 4.2's "empty list, or none" case is a de-facto
  PIN) and OR-9 (Task 4.4 runs the lean byte-stability diff).
- STOP items: none.

## Per task

| Task | Result | Files |
|---|---|---|
| 4.1 the voucher size list reader and the 4-or-more match rule | SHIPPED as written | `app/src/lib/blastAudienceRules.ts`, `app/src/repos/broadcastsRepo.ts`, `app/test/blastAudienceRules.test.ts` |
| 4.2 the resolver matches any listed size, 4 meaning 4 or more | SHIPPED as written | `app/src/services/audienceResolution.ts`, `app/test/audienceResolution.test.ts` |
| 4.3 POST stores the list; every projection answers it | SHIPPED as written | `app/src/routes/broadcasts.ts`, `app/src/lib/blastAudienceRules.ts`, `app/test/blastAudienceRules.test.ts`, `app/test/broadcastApi.test.ts` |
| 4.4 one matrix broadcast on each shape | SHIPPED as written + OR-9 | `app/src/lib/seed/matrix.ts`, `app/test/seedMatrix.test.ts` |

Plan fidelity, checked mechanically: a throwaway node script in the session
scratchpad counts a plan line range, as one block, in the target file. Before
each task every quoted anchor counted exactly 1 in its target (the Task 4.3
`replace_all` line exactly 2, at `broadcastApi.test.ts` 2260 and 2465); after
each edit every replacement block counted exactly 1. That covers all 28 code
blocks of Tasks 4.1-4.4, the 230-line D12 describe of Task 4.3 Step 1c
included (plan 11649-11878, now `broadcastApi.test.ts:2848`). Task 4.1's
SIZE_CASES table is byte-identical to plan 10892-10911
(`blastAudienceRules.test.ts:110-129`), which R2 found byte-identical to the
dashboard copy the next unit adds. Task 4.3 Step 1b anchors were found by their
quoted text (R2-F3: they start at 2767, 2791, 2798 and 2804, not the plan's
hints). No earlier unit touched any of the nine files (`git diff --stat
1d7a4667` on them was empty at the start), so AR47 never applied.

## Commits

| Hash | Subject |
|---|---|
| `ab3fb405` | feat(matching): voucher size list reader and the 4-or-more match rule (D12) |
| `989d42d2` | fix(matching): the audience resolver matches any listed voucher size, 4 meaning 4 or more (D12) |
| `26ff4a57` | feat(matching): POST stores bedroomSizes and every projection answers the list (D12) |
| `63ceb8b8` | chore(seed): one matrix broadcast keeps the legacy bedroomSize, the draft holds bedroomSizes (D12) |
| (this file) | docs(records): ... U6 S4a report |

## RED runs (each red for the stated reason)

- 4.1 `test/blastAudienceRules.test.ts`: 31 failed / 49 passed (80). The 16
  reader cases (14 SIZE_CASES, the top-chip case, the stored-AudienceFilter
  case) and the 15 match cases failed on "bedroomSizesOfFilter is not a
  function" / "voucherSizeMatches is not a function" / "expected undefined to
  be 4". Every pre-existing case green.
- 4.2 `test/audienceResolution.test.ts`: 9 failed / 23 passed (32). Green on
  unchanged code: the "LEGACY stored bedroomSize below 4" PIN and, per OR-8,
  "an empty list, or none, is no size filter". Failures as predicted: the
  list cases returned every tenant, legacy 4 reached only v4 and legacy 6 only
  v6, "list wins" returned v2, the combined test returned a2, a3, b2, and both
  log cases failed on the field name.
- 4.3 `test/blastAudienceRules.test.ts test/broadcastApi.test.ts`: 20 failed /
  230 passed (250). 5 wire cases (3 edited, 2 new) and the 7 tests holding the
  edited response assertions failed on the missing `bedroomSizes`; 8 of the 12
  new D12 route cases failed as predicted (the 400 table answered 201, the
  both-keys case 400'd on `'not a size'`, the legacy body stored `bedroomSize`
  as given, the estimate counted 8 not 4, the projections lacked the list).
  Green as the plan's NOTE predicts: the three stored-row preview/send cases
  (Task 4.2 already reads the list) and the `(PIN)` legacy 400.
- 4.4 `test/seedMatrix.test.ts`: 1 failed / 51 passed (52) - `draft?.bedroomSizes`
  undefined ("expected undefined to deeply equal [ 2 ]").

DynamoDB Local answered on every run (globalSetup/teardown created and dropped
the per-file tables). No `AWS_*` variable exported.

## GREEN runs

| When | Scope | Result |
|---|---|---|
| 4.1 | `blastAudienceRules` | 80/80 |
| 4.1 | `audienceResolution` 24, `broadcastApi` 156 | 180/180 |
| 4.1 | root `npm run typecheck`; `npx eslint` (3 files) | exit 0; exit 0 |
| 4.2 | `audienceResolution` | 32/32 |
| 4.2 | `broadcastApi` 156, `blastAudienceRules` 80 | 236/236 |
| 4.2 | root typecheck; eslint (2 files) | exit 0; exit 0 |
| 4.3 | `blastAudienceRules` 82, `broadcastApi` 168 | 250/250 |
| 4.3 | neighbours `audienceResolution` 32, `contactsBatchReads` 10, `seedOrgNames` 10, `unitsApiActivity` 17 | 69/69 |
| 4.3 | root typecheck; eslint (4 files) | exit 0; exit 0 |
| 4.4 | `seedMatrix` 52, `seedOrgNames` 10, `seedMatrixCoherence` 40 | 102/102 |
| 4.4 | root typecheck; eslint (2 files); OR-9 `git diff --exit-code 1d7a4667 -- app/src/lib/seed/lean.ts` | exit 0; exit 0; exit 0 |
| Unit end | every broadcast / share / filter-reading app suite (27 files, below) | 1136/1136, 0 `[dynamoAdmin]` lines |
| Unit end | `npx eslint` on the 9 touched files (`git diff --name-only --diff-filter=d a8aca813...HEAD`) | exit 0 |
| After the mutant reverts | `blastAudienceRules` 82, `audienceResolution` 32, `broadcastApi` 168, `seedMatrix` 52 | 334/334 |
| After the mutant reverts | root `npm run typecheck` (app incl. scripts and test configs, dashboard, e2e, fake-twilio, fake-twilio-web) | exit 0 |

The 27 unit-end files and counts: `audienceResolution` 32, `blastAudienceRules`
82, `broadcastApi` 168, `broadcastFanOut` 114, `broadcastsRepo.integration` 36,
`broadcastsRepoAttemptOutcome.integration` 10, `deriveBroadcastStats` 10,
`listingSendsRepoShares.integration` 6, `repairShareOutcomes` 23, `seedMatrix`
52, `seedMatrixCoherence` 40, `seedOrgNames` 10, `seedProfile.integration` 6
(ran, not skipped: the full-profile Put wrote the matrix draft's list into
DynamoDB Local), `sendReconcile.integration` 4, `sendReconcile` 167,
`shareAttemptOrder` 5, `shareAttemptOutcome` 27, `shareLedger` 16,
`shareRecipientState` 19, `twilioStatusWebhook` 95,
`twilioWebhookHarnessRepoAdditions.integration` 25, `contactTimeline` 65,
`contactsBatchIncomplete` 9, `contactsBatchReads` 10, `orgNames` 40,
`retrySendAttempt` 48, `unitsApiActivity` 17. (Every app test file that names
`audience_filter`, `AudienceFilter` or `bedroomSize`, plus every
broadcast/share-named suite.)

ASCII: `blastAudienceRules.ts`, `audienceResolution.ts` and both their tests
stay pure ASCII as whole files; the added lines of `broadcastsRepo.ts`,
`broadcasts.ts`, `broadcastApi.test.ts`, `matrix.ts` and `seedMatrix.test.ts`
(all with pre-existing non-ASCII) print 0 on the `tr` check. No literal
backslash-u added. All files LF.

## Mutant table

Ten one-line mutants, applied and reverted with the Edit tool, one at a time;
before each run `git diff -U0` showed exactly the one mutant line. Baselines:
`blastAudienceRules` 82/82, `audienceResolution` 32/32, `broadcastApi` 168/168.
Line numbers are in the final tree. Afterwards `git status --short` and
`git diff --stat` were empty and `git diff --exit-code HEAD` on the five source
files exited 0.

| # | Area | Mutant | file:line | Test run | Result | Follow-up |
|---|---|---|---|---|---|---|
| M1 | the clamp to 4 | the list arm adds the raw size (no min with the 4 chip) | `blastAudienceRules.ts:227` | `blastAudienceRules` | KILLED (2 of 82: clamp-once case, the wire [3, 2, 6] case) | - |
| M2 | AR22, list arm | the list arm keeps any number (`isSize` bypassed: integer and >= 0 both dropped there) | `blastAudienceRules.ts:227` | `blastAudienceRules` | KILLED (1 of 82: 2.5, NaN, Infinity (as 4) and -1 all leaked) | - |
| M3 | AR22, legacy arm | the legacy arm keeps any number | `blastAudienceRules.ts:232` | `blastAudienceRules` | KILLED (2 of 82: LEGACY negative, LEGACY non-integer) | - |
| M4 | de-duplication | the list arm filters, clamps and sorts but no longer de-duplicates | `blastAudienceRules.ts:229` | `blastAudienceRules` | KILLED (2 of 82: de-duplicated-and-ascending, clamp-once) | - |
| M5 | AR25 "bedroomSizes wins" | the `else` dropped, so the legacy key is read and validated beside a list | `broadcasts.ts:234` | `broadcastApi` | KILLED (1 of 168: the both-keys case) | - |
| M6 | 4 or more | a tenant of 4+ matches only its exact size | `blastAudienceRules.ts:241` | `blastAudienceRules` + `audienceResolution` | KILLED (6 of 114: three match cases, three resolver D12 cases incl. legacy 4 and legacy 6) | - |
| M7 | empty list = no filter | an empty list drops a tenant with no voucher size | `blastAudienceRules.ts:239` | `blastAudienceRules` + `audienceResolution` | KILLED (24 of 114) | - |
| M8 | the POST 400 | the per-element integer 0..12 check dropped (only "is an array" kept) | `broadcasts.ts:230` | `broadcastApi` | KILLED (1 of 168: the 400 table) | - |
| M9 | wire compat `bedroomSize` | the LAST size instead of the first | `blastAudienceRules.ts:272` | `blastAudienceRules` + `broadcastApi` | KILLED (3 of 250: wire [3, 2, 6] case, POST echo, GET results/list) | - |
| M10 | the stored shape | `bedroomSizes` stored even when empty | `broadcasts.ts:243` | `broadcastApi` | KILLED (4 of 168: the D12 no-size and both-keys cases, and two pre-existing D2 cases whose `expect(stored).toEqual(wire)` now also pins the omitted key) | - |

No mutant survived, so no follow-up test was added.

Pinned but not mutant-run (the 10-mutant cap), each failing by construction:
- AR25 null-as-absent (`broadcasts.ts:229`, the `!== null` arm): "a null list
  reads as absent" (`broadcastApi.test.ts`, D12 describe) asserts 201 and
  stored `[3]`; without the null check, null reaches the "is an array" test and
  answers 400.
- the sort (`blastAudienceRules.ts:229`): exact ascending lists are asserted by
  the reader cases ([3, 2, 2, 0] -> [0, 2, 3]; [5, 12, 4, 1] -> [1, 4], which
  in Set insertion order would be [4, 1]), the wire [3, 2, 6] -> [2, 3, 4], the
  POST [3, 6, 2, 3, 5] -> [2, 3, 4] and the resolver log [4, 2] -> [2, 4].
- the resolver's log field and normalizer (`audienceResolution.ts:161,258`):
  the log case asserts `[[2, 4], [4]]` for a list [4, 2] and a legacy 7; the
  legacy 4 / 6 resolver cases need the normalizer.

Considered and NOT run, because it is equivalent: `tenantSize >= 4` -> `> 4`
at `blastAudienceRules.ts:241` - a tenant of exactly 4 then falls through to
`sizes.includes(tenantSize)`, which is `sizes.includes(4)`: the same answer.

## Divergences from the plan text

- None in code or tests: every block is the plan's text byte for byte.
- Commits were made with `git commit -F -` (implementer rules) instead of the
  plan's three `-m` flags: same subject, body and trailer.
- OR-8 applied: Task 4.2's "an empty list, or none" case was green at Step 2
  (a de-facto PIN); the real RED came from the other D12 cases, 1b and 1d.
- OR-9 applied: the lean diff ran at Task 4.4 Step 4 (exit 0).
- F15's "some anchors contain an em dash or arrow in the OLD text" is not true
  of the app anchors (R2-F4 already said so); nothing depended on it.

## CONTRACT (what later units rely on)

### `app/src/lib/blastAudienceRules.ts` exports (new or changed)

- `VOUCHER_CHIP_MAX` (`:210`): the constant 4, the top chip, meaning "4 or
  more".
- `bedroomSizesOfFilter(filter: { bedroomSizes?: unknown; bedroomSize?: unknown } | undefined): number[]`
  (`:218-233`), the ONLY reader of a filter's sizes. undefined -> `[]`. When
  `bedroomSizes` is an array (an empty one included): keep the members that
  are numbers with `Number.isInteger` true and >= 0 (so NaN, Infinity,
  non-integers, negatives and non-numbers drop), each `min(n, 4)`,
  de-duplicated, ascending - the legacy key is not read. Otherwise (absent,
  null, or any non-array) a legacy `bedroomSize` that is an integer >= 0 reads
  as `[min(n, 4)]`; anything else is `[]`. A stored `AudienceFilter` of either
  shape is assignable to the parameter. Pure, no I/O, ES2022 only.
- `voucherSizeMatches(sizes: readonly number[], tenantSize: number | undefined): boolean`
  (`:238-243`). `[]` -> true (no size filter, a tenant with no size included);
  otherwise an undefined tenant size -> false; a tenant size >= 4 -> `sizes`
  holds 4; else `sizes` holds the exact size. `sizes` must come from
  `bedroomSizesOfFilter`.
- `WireAudienceFilter` (`:250-257`), in key order: `contact_type: 'tenant'`;
  `housing_authorities?: string[]` (only when non-empty, unchanged);
  `bedroomSizes: number[]` (ALWAYS - `bedroomSizesOfFilter` of the stored row,
  `[]` = no size filter); `bedroomSize?: number` (the compat key: the FIRST of
  `bedroomSizes`, only when non-empty); `excludeOptedOut: boolean`;
  `excludeUnreachable: boolean`. `wireAudienceFilter` overloads unchanged
  (`:266-268`); a row with no stored filter still answers undefined, so the
  response omits the field.

### Stored type (`app/src/repos/broadcastsRepo.ts`)

`AudienceFilter` gains `bedroomSizes?: number[]` (`:101`: chip values 0..4,
4 = 4 or more, absent = no size filter, never stored empty) and keeps
`bedroomSize?: number` marked `@deprecated` (`:102-105`: the legacy one-number
shape, read only through `bedroomSizesOfFilter`, never written by new code,
stored rows never rewritten).

### POST /api/broadcasts `audience_filter` (`app/src/routes/broadcasts.ts`, `parseAudienceFilter` `:185-247`)

- Checked after the existing housing authority checks, before any org-list
  read. A present, non-null `bedroomSizes` must be an array whose EVERY member
  is a number, an integer, 0..12 - else 400
  `{ error: 'audience_filter.bedroomSizes must be an array of integers 0..12' }`
  (`:231`). While such a list is present the legacy `bedroomSize` is neither
  read nor validated, and an empty list wins (no size filter).
- `bedroomSizes: null` (or absent) is no list: a present, non-null legacy
  `bedroomSize` must then be an integer 0..12, else the unchanged 400
  `{ error: 'audience_filter.bedroomSize must be an integer 0..12' }` (`:236`).
- Stored (`:240-246`): `bedroomSizes` = `bedroomSizesOfFilter` of what was
  sent (each min(n, 4), de-duplicated, ascending), ONLY when non-empty; never
  `bedroomSize`. Key order: contact_type, housing_authorities?, bedroomSizes?,
  excludeOptedOut, excludeUnreachable.
- Examples pinned by the route tests: `[3, 6, 2, 3, 5]` stores `[2, 3, 4]`;
  legacy 2 / 0 / 7 store `[2]` / `[0]` / `[4]`; `{ bedroomSizes: [3], bedroomSize: 'not a size' }`
  stores `[3]` (201); `{ bedroomSizes: [], bedroomSize: 2 }` stores no size;
  `{ bedroomSizes: null, bedroomSize: 3 }` stores `[3]`; `3`, `'2'`, `{0: 2}`,
  `[2.5]`, `[13]`, `[-1]`, `['2']`, `[null]`, `[2, 'x']` are the 400.

### Resolution and projections

- The resolver (`app/src/services/audienceResolution.ts:161,202`) matches
  `voucherSizeMatches(bedroomSizesOfFilter(filter), voucherSizeOf(contact))`
  behind the draft-create estimate, the preview and the no-body send (no edit
  at those call sites; they pass the stored filter). A stored legacy 4 now
  reaches every holder of 4 or more, a stored 5..12 reads as the 4 chip, and
  the stored row is never rewritten. The info log `broadcast audience resolved`
  carries `bedroomSizesFilter: number[]` (normalized, `[]` when none, `:258`);
  `bedroomSizeFilter` is gone (R2: no runbook, infra query or script reads it).
- Every projection goes through `wireAudienceFilter`: the 201 create echo
  (`broadcasts.ts:1009`), GET `/api/broadcasts/:id/results` (`:472`) and the
  GET `/api/broadcasts` rows (`:502`). Each answers `bedroomSizes` for every
  row, legacy or new, and the compat `bedroomSize` when there is a size.

### Matrix seed (full profile only, `app/src/lib/seed/matrix.ts`)

- `broadcast-mx-sent-01` (sent, `:1218`) keeps the LEGACY `bedroomSize: 1`
  (`:1232`, beside its legacy one-string `housing_authority`): reads `[1]`,
  answers `bedroomSizes: [1]`, `bedroomSize: 1`.
- `broadcast-mx-draft-01` (draft, `:1253`) holds `bedroomSizes: [2]` (`:1271`,
  beside its `housing_authorities` list) and no `bedroomSize`: reads `[2]`.
- Lean is untouched (OR-9 diff exit 0; lean has no broadcasts table).

## For later units and the orchestrator

- U7 (S4b, dashboard): from now until U7 lands the server stores
  `bedroomSizes` and the dashboard keeps reading the wire's compat
  `bedroomSize` (plan section 3); the root typecheck is green. The dashboard
  `AudienceFilter` has no `bedroomSizes` yet (Task 4.5 adds it). Keep the
  dashboard SIZE_CASES byte-identical to `app/test/blastAudienceRules.test.ts:110-129`
  and the mirrored reader body to `blastAudienceRules.ts:218-233`. The
  composer may POST `bedroomSizes` (chip values 0..4); a legacy `bedroomSize`
  POST still works and is stored as `bedroomSizes: [min(n, 4)]`.
- U13 (S7): close `docs/issues/broadcast-4plus-exact-match-underreach.md`
  citing `989d42d2` (resolver) and `26ff4a57` (route pins); the behavior is
  live. The e2e API bodies that POST a legacy `bedroomSize: 2` now store
  `bedroomSizes: [2]`; no e2e asserts a response's `audience_filter` shape
  (plan S4 note), so no repair is required by this unit.
- Watch grep (`grep -rn "bedroomSize\b" app/src app/scripts scripts`): code
  sites are only the deprecated type field (`broadcastsRepo.ts:105`), the
  reader's legacy arm (`blastAudienceRules.ts:219,231`), the wire compat key
  (`blastAudienceRules.ts:254,277`), the legacy POST branch
  (`broadcasts.ts:226-238`) and the legacy matrix row (`matrix.ts:1232`); the
  rest are comments. No script or dev route writes either key.
- Unchanged on purpose: the send route's over-cap 400 copy that mentions a
  "bedroom-size filter" (R2: still accurate); the performance seed's
  broadcasts carry no size key.
- Not run, per the brief: the full `npm test`, any e2e.
