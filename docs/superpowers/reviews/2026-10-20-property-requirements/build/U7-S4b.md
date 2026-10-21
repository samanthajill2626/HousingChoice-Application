# U7 (S4b) - Matching, dashboard side: several voucher sizes - Tasks 4.5, 4.6

- Unit: U7, slice S4 dashboard part (plan Tasks 4.5-4.6), implementer model Claude Opus 5.5.
- Branch `feat/property-requirements`, worktree `W:/tmp/property-requirements`,
  started at `140f8013` (U6's report commit).
- Rulings carried: plan 1.1 "Matching (D12)" copy (the pre-fill note and the
  summary join), plan 2.6 `AudienceFilter`, AR22 (integers >= 0 in both reader
  arms), AR23 (a recorded size no chip can hold is left out of the pre-fill;
  nothing left = no size filter and no note), AR24 (the composer tests use the
  local `withSizes()` cast), AR26 (the note keeps the bound plural text and
  names CHIPS: two sizes on the 4+ chip are named once), worklist OR-11 (the
  whole AudienceFilters voucher describe is replaced FIRST, then the two
  single-line edits).
- STOP items: none.

## Per task

| Task | Result | Files |
|---|---|---|
| 4.5 the size reader mirror and the audience summary | SHIPPED as written | `dashboard/src/api/types.ts` (AudienceFilter only), `dashboard/src/api/endpoints.ts` (one comment line), `dashboard/src/routes/broadcasts/broadcastFormat.ts`, `broadcastFormat.test.ts`, `BroadcastsList.test.tsx`, `BroadcastResults.test.tsx` |
| 4.6 multi-select chips, the pre-fill and the draft key | SHIPPED as written (OR-11 order) | `dashboard/src/routes/broadcasts/AudienceFilters.tsx`, `BroadcastComposer.tsx`, `useComposerDraft.ts`, `broadcastFormat.ts` (`bedroomPhrase` removed), `AudienceFilters.test.tsx`, `BroadcastComposer.test.tsx` |

Plan fidelity, checked mechanically: a throwaway node script in the session
scratchpad counts a plan line range, as one block, in the target file.

- Task 4.5: before editing, all 12 quoted anchors counted exactly 1; after,
  all 12 replacement / insertion blocks counted exactly 1 (one recount after I
  first typed a range one line off - plan 12533-12535, not 12532-12534).
- Task 4.6: before editing, all 25 multi-line anchors counted exactly 1 (the
  handler block in two halves around the plan's placeholder for the
  non-ASCII line `AudienceFilters.tsx:137`, whose U+2192 arrow I copied from
  the file), the 8 single-line anchors were where R3 put them (the
  `bedroomSize: 2 })` line at :122 AND :207 until the describe was replaced,
  OR-11), and the replace_all site counts were exactly the plan's: the Oak
  site first, then `bedroomSize: 3,` x2, `bedroomSize: 2,` x8,
  `{ contact_type: 'tenant', bedroomSize: 2 }` x2 (13 in all). After editing,
  every one of the 4 test blocks and 18 implementation blocks counted exactly 1.
- Mirror identity, checked by text comparison: the dashboard SIZE_CASES
  (`broadcastFormat.test.ts:34-53`) is byte-identical to the app's
  (`app/test/blastAudienceRules.test.ts:110-129`); the dashboard
  `bedroomSizesOfFilter` (`broadcastFormat.ts:59-74`) is byte-identical to the
  app's (`app/src/lib/blastAudienceRules.ts:218-233`); the `VOUCHER_CHIP_MAX`
  line is identical (`broadcastFormat.ts:51` = `blastAudienceRules.ts:210`).
- No earlier unit had touched any of the eleven files (`git diff --stat
  1d7a4667` on them was empty at the start), so AR47 never applied. Facts
  F8-F16 held against the tree.

## Commits

| Hash | Subject |
|---|---|
| `fa3c864a` | feat(dashboard): the Matching audience summary lists every voucher size (D12) |
| `d31345ff` | feat(dashboard): the composer's voucher sizes become multi-select, pre-filled one chip per size (D12) |
| (this file) | docs(records): ... U7 S4b report |

## RED runs (each red for the stated reason)

- 4.5 `broadcastFormat.test.ts BroadcastsList.test.tsx BroadcastResults.test.tsx`:
  22 failed / 81 passed (103). The 14 SIZE_CASES and the top-chip case
  ("bedroomSizesOfFilter is not a function" / "expected undefined to be 4"),
  2 `prefillVoucherChips` and 1 `voucherSizesLabel` cases ("is not a
  function"); the two D12 `audienceSummary` cases read "Tenants - Atlanta
  Housing Authority" and "Tenants - 2-BR"; the list row rendered "Tenants -
  2-BR - Atlanta Housing Authority"; the results h1 rendered "Tenants -
  Studio". Green on unchanged code, as the plan says: the old-shape summary
  (`bedroomSize: 6` -> "Tenants - 4+ BR") and the results `(PIN)`.
- 4.6 `AudienceFilters.test.tsx BroadcastComposer.test.tsx`: 29 failed / 91
  passed (120). AudienceFilters 9 (8 of the 9 new D12 cases - no tag, the old
  note, only `filter.bedroomSize` pressed, `bedroomSize` emitted - plus the
  edited "a list that fails to load" case); composer 20 (3 in the voucher
  pre-fill describe, 2 D3b, 6 of the 7 new D12 cases, 9 D3 prefill cases).
  The diffs received `bedroomSize: 2` / `bedroomSize: 3` everywhere a list was
  expected, and `bedroomSize: 2.5` in the CI-2 `[2.5]` case (the value today's
  server answers 400). Green on unchanged code: the composer's resumed-draft
  `(PIN)` (planned) and AudienceFilters "no property: no tag and no pre-fill
  note" (a de-facto pin: with no property prop there was no old tag or note
  either).

## GREEN runs

| When | Scope | Result |
|---|---|---|
| 4.5 | `tenantFacets` 48, `broadcastFormat` 49, `useBroadcastResults` 6, `BroadcastResults` 27, `AudienceFilters` 29, `BroadcastsList` 27, `BroadcastComposer` 79 | 265/265 (7 files) |
| 4.5 | root `npm run typecheck` (app, dashboard, e2e, fake-twilio, fake-twilio-web); `npx eslint` on the 6 files | exit 0; exit 0 |
| 4.6 | `AudienceFilters` 34, `BroadcastComposer` 86 | 120/120 |
| 4.6 | neighbours `broadcastFormat` 49, `tenantFacets` 48, `BroadcastResults` 27, `BroadcastComposer.prefill` 2, `RecipientPreview` 57, `BroadcastsList` 27 | 210/210 (6 files) |
| 4.6 | root typecheck; `npx eslint` on the 6 files | exit 0; exit 1 with exactly the 3 pre-existing errors (below) |
| Unit end | `src/routes/broadcasts` (all 26 files) + `src/routes/contacts/tenantFacets.test.ts` + `src/api` | 564/564 (27 files) |
| Unit end | the WHOLE dashboard suite (`cd dashboard && npx vitest run`) | 4866/4866 (250 files), exit 0, 61.4 s |
| After the mutant reverts | the same 27 files | 564/564 |
| After the mutant reverts | root typecheck; `npx eslint` on the 11 touched files (`git diff --name-only --diff-filter=d 140f8013...HEAD -- '*.ts' '*.tsx'`) | exit 0; exit 1, the same 3 pre-existing errors only |

Lint attribution by baseline (AGENTS.md gate 5): per-rule error counts of all
11 touched files, now vs `git show 1d7a4667:<path> | npx eslint --stdin`,
are equal. The 3 errors are F14's, pre-existing and not this unit's:
`BroadcastComposer.tsx:426:5` and `:445:5` (`react-hooks/set-state-in-effect`,
the two `setMessage` effects) and `useComposerDraft.ts:155:3`
(`react-hooks/refs`, the `disposableRef` write). Every other file: 0 errors.

ASCII: the added lines of all 11 files print 0 on the `tr` check;
`AudienceFilters.test.tsx` stays pure ASCII as a whole file; no literal
backslash-u added; all files LF. The replaced `AudienceFilters.tsx:137` (an
arrow) and the composer test's old note lines left the tree with the edits.

## Mutant table

Ten one-line mutants, applied and reverted with the Edit tool, one at a time;
before each run `git diff -U0` showed exactly the one mutant line. Baselines:
`broadcastFormat` 49/49, `AudienceFilters` 34/34, `BroadcastComposer` 86/86,
`BroadcastsList` 27/27, `BroadcastResults` 27/27. Line numbers are in the
final tree. Afterwards `git status --short` and `git diff --stat` were empty
and `git diff --exit-code HEAD` on the four source files exited 0.

| # | Area | Mutant | file:line | Test run | Result | Follow-up |
|---|---|---|---|---|---|---|
| M1 | mirror clamp | the list arm adds the raw size (no min with the 4 chip) | `broadcastFormat.ts:68` | `broadcastFormat` | KILLED (2 of 49: clamp-once case, `prefillVoucherChips` [5] / [3, 6, 12]) | - |
| M2 | mirror filter: the non-integer exclusion (AR23) | `isSize` drops `Number.isInteger` | `broadcastFormat.ts:63` | `broadcastFormat` + `BroadcastComposer` | KILLED (5 of 135: two reader cases, the CI-2 prefill helper case, both composer CI-2 cases) | - |
| M3 | mirror de-dup | the list arm filters, clamps and sorts but bypasses the Set | `broadcastFormat.ts:70` | `broadcastFormat` + `BroadcastComposer` | KILLED (4 of 135: de-duplicated case, clamp-once case, the helper's 4+-once case, the composer "3, 6 and 12 - the 4+ chip once" note) | - |
| M4 | chip toggle add vs remove | the add / remove arms swapped (`!sizes.includes`) | `AudienceFilters.tsx:146` | `AudienceFilters` | KILLED (4 of 34) | - |
| M5 | the list stays ascending | the add arm no longer sorts | `AudienceFilters.tsx:148` | `AudienceFilters` | KILLED (1 of 34: the ADDS case, [3, 1] for [1, 3]) | - |
| M6 | the 4+ mapping of sizes 5..12 | the composer pre-fills the raw accepted sizes (no `prefillVoucherChips`) | `BroadcastComposer.tsx:208` | `BroadcastComposer` | KILLED (4 of 86: 5-only, 3/6/12, both CI-2 cases) | - |
| M7 | the note names a chip once (AR26) | the composer passes the raw accepted sizes as `propertyVoucherSizes` while still pre-filling chips | `BroadcastComposer.tsx:775` | `BroadcastComposer` | KILLED (4 of 86; the [3, 6, 12] note rendered "3-BR, 4+ BR, 4+ BR") | - |
| M8 | the summary lists every size | `audienceSummary` keeps only the first size (`.slice(0, 1)`) | `broadcastFormat.ts:103` | `broadcastFormat` + `BroadcastsList` + `BroadcastResults` | KILLED (4 of 103: both D12 summary cases, the list row, the results h1) | - |
| M9 | the draft key holds the size list | the key's `s` is `null` | `useComposerDraft.ts:111` | `BroadcastComposer` | KILLED (4 of 86: the no-orphan recreate, D3b next draft, the D12 unpress case, the 503 alert case) | - |
| M10 | the composer never sends `bedroomSize` | the filter also carries `bedroomSize: chosen[0]` | `BroadcastComposer.tsx:230` | `BroadcastComposer` | KILLED (16 of 86) | - |

No mutant survived, so no follow-up test was added.

Pinned but not mutant-run (the 10-mutant cap), each failing by construction:
- the pressed state reads through the one reader (`AudienceFilters.tsx:185`):
  "an old-shape filter (a legacy bedroomSize) presses its chip - 6 on the 4+
  chip" (`AudienceFilters.test.tsx`, D12 describe) fails if `active` reads
  `filter.bedroomSizes` raw.
- the tag follows the PROPERTY, not the pressed state (`:186`): "a pre-filled
  chip can be unpressed by hand and keeps its tag".
- a housing authority pick keeps the sizes (`:160`): "a housing authority pick
  keeps the voucher sizes as they are".
- AudienceFilters never emits the legacy key (`:151`, `:160`): the
  `not.toHaveProperty('bedroomSize')` loop over every emission in the ADDS case.
- the empty-key guard in the composer memo (`BroadcastComposer.tsx:225`):
  `''.split(',')` is `['']` and `Number('')` is 0, so dropping the guard would
  send `bedroomSizes: [0]` (Studio) for "no size"; the CI-2 no-chip case and
  the D12 unpress case assert `{ contact_type: 'tenant' }` exactly.
- the summary separator `', '` (`broadcastFormat.ts:87`): exact strings in the
  `voucherSizesLabel`, summary, list-row and results-h1 cases.

## Divergences from the plan text

- None in code or tests: every block is the plan's text byte for byte.
- Commits were made with `git commit -F -` (implementer rules) instead of the
  plan's three `-m` flags: same subject, body and trailer.
- OR-11 applied: the AudienceFilters voucher describe was replaced as one Edit
  first; the two single-line edits followed (then unique, at
  `AudienceFilters.test.tsx:258` and `:298`).
- Plan claim, Task 4.6 Step 1b: after the edits
  `grep -n "bedroomSize\b" BroadcastComposer.test.tsx` lists the new
  `not.toHaveProperty('bedroomSize')` line (`:858`) AND the new case title at
  `:844` (the plan's own title ends "never bedroomSize"). No impact.
- RED had one extra de-facto pin (AudienceFilters "no property: no tag and no
  pre-fill note"), noted above; every task still had real RED cases.

## CONTRACT (what later units rely on)

### `dashboard/src/api/types.ts` `AudienceFilter` (`:3271-3290`)

- `contact_type: 'tenant'`; `housing_authorities?: string[]` (unchanged);
  `bedroomSizes?: number[]` (`:3284`) - chip values 0..4, 4 = "4 or more",
  any-of; the ONLY size key the client sends; every server response carries
  it normalized; `bedroomSize?: number` (`:3289`) - `@deprecated` read-only
  compat (the server's first size), never sent by this client.
- Both are read ONLY through `bedroomSizesOfFilter`. No import was added to
  `types.ts` (OR-15). The edit sits below line 3268, so no line above it moved
  (S5's `UnitItem` / `Contact` / `ContactPatch` anchors keep their numbers);
  `endpoints.ts` changed one comment line in place (`:1984`).

### `dashboard/src/routes/broadcasts/broadcastFormat.ts`

- `VOUCHER_CHIP_MAX = 4` (`:51`).
- `bedroomSizesOfFilter(filter: { bedroomSizes?: unknown; bedroomSize?: unknown } | undefined): number[]`
  (`:59-74`) - the hand mirror of the app reader, same body, same SIZE_CASES:
  an array `bedroomSizes` (even empty) wins - members that are integers >= 0,
  each min(n, 4), de-duplicated, ascending; else a legacy integer
  `bedroomSize` >= 0 as `[min(n, 4)]`; else `[]`.
- `prefillVoucherChips(sizes: readonly number[]): number[]` (`:80-82`) - the
  chips a property's `acceptedVoucherSizes` press: the reader over the list,
  so 5..12 land on the 4+ chip once and a non-integer is left out (AR23).
- `voucherSizesLabel(sizes: readonly number[]): string` (`:86-88`) - each
  `voucherSizeLabel` joined with `, `; `''` for none. Chip labels: `Studio`,
  `1-BR`, `2-BR`, `3-BR`, `4+ BR` (any n >= 4).
- `audienceSummary(filter)` (`:98`) - `Tenants`, then ` - ` + the sizes label
  when any, then ` - ` + the authorities joined `, ` when any. Shown on the
  Matching list rows (`BroadcastsList.tsx`) and the results h1
  (`BroadcastResults.tsx`); neither file changed.
- REMOVED: `bedroomPhrase` (no importer left). Unchanged:
  `VOUCHER_SIZE_CHOICES`, `voucherSizeLabel`.

### `AudienceFilters` (`AudienceFilters.tsx`)

- Prop `propertyVoucherSize?: number` is REPLACED by
  `propertyVoucherSizes?: readonly number[]` (`:75`, default `[]` at `:113`):
  CHIP values (pass `prefillVoucherChips` output).
- The chips: `role="group"` named `Voucher size` (`:183`, the singular label
  is kept); five `<button type="button">` with `aria-pressed="true"` exactly
  for each value in `bedroomSizesOfFilter(filter)` and `"false"` otherwise
  (`:185`, `:192`); all disabled while `disabled`.
- Accessible names: `Studio`, `1-BR`, `2-BR`, `3-BR`, `4+ BR`. A chip whose
  value is in `propertyVoucherSizes` renders the tag span ` - matches property`
  INSIDE the button (`:197`), so its name becomes e.g.
  `2-BR - matches property`: select chips with an anchored regex (`/^2-BR/`,
  `/^4\+ BR/`); an exact name matches an untagged chip only. The tag stays on
  a pre-filled chip staff unpress (it describes the property).
- A click toggles that chip's value in or out of the list (kept ascending);
  `onChange` gets `{ contact_type: 'tenant', housing_authorities?, bedroomSizes? }`
  with `bedroomSizes` omitted when empty and NEVER `bedroomSize`; a housing
  authority pick or chip removal re-emits the current sizes (an old-shape
  filter's one size comes back as `bedroomSizes`).
- The note (`:202-204`): a `<p>` (class `matchNote`) holding ONE text node,
  `Pre-filled to the voucher sizes this property takes: ` +
  `voucherSizesLabel(propertyVoucherSizes)`, rendered only when
  `propertyVoucherSizes` is non-empty (the old "- change it to reach other
  sizes." sentence is gone, CI-5 / AR26).

### Composer and draft key

- `BroadcastComposer.tsx:208` pre-fills `prefillVoucherChips(acceptedVoucherSizes(unit))`
  (bedrooms fallback included); `FilterEdits.sizes?: number[]` (`:98`)
  replaces `size?: number | null` (`[]` = staff unpressed every chip); staff
  edits for the same property win, a DIFFERENT property drops them
  (`pickProperty`, unchanged); the derived filter is keyed on `sizesKey`
  (`:216-232`) and carries `bedroomSizes` only when non-empty;
  `onFilterChange` normalizes through the reader (`:305-307`). A resumed draft
  (`?draftId=`) presses no chip and shows no note (F12, `(PIN)` at
  `BroadcastComposer.test.tsx:921`).
- `useComposerDraft.ts:111`: the material key's `f.s` is
  `bedroomSizesOfFilter(input.filter)` (an array, `[]` for none), so pressing
  or unpressing any chip recreates the draft (and deletes the previous
  throwaway).

### Exact strings (S7's e2e selects by them)

- Note: `Pre-filled to the voucher sizes this property takes: 2-BR, 3-BR`
  (sizes [2, 3]); `...: 3-BR` (one size - the plural stays, AR26);
  `...: 4+ BR` (a 5-only property); `...: 3-BR, 4+ BR` (sizes 3, 6, 12).
- Tag (inside the chip): ` - matches property`.
- Summary: `Tenants - 2-BR, 3-BR - Atlanta Housing Authority`;
  `Tenants - Studio, 2-BR, 4+ BR`; an old-shape row `Tenants - 2-BR`.

## For later units and the orchestrator

- U8 (S5): after `UnitItem.voucher_size_accepted` widens to
  `number | number[]`, the `withSizes()` cast at
  `BroadcastComposer.test.tsx:60-62` still compiles and may be dropped
  (optional, AR24).
- U11 (S6): the property page row "Voucher sizes accepted" uses its own format
  (`Studio`, `<n> BR`), not `voucherSizesLabel` (plan S4 note).
- U13 (S7):
  - BREAKS now: `e2e/tests/dashboard-next/broadcasts.spec.ts:320` asserts
    `'Pre-filled to the 3-bedroom voucher this property takes'`; the text is
    now `'Pre-filled to the voucher sizes this property takes: 3-BR'`.
  - Still valid: `broadcasts.spec.ts:170-173` (`getByText(/matches property/i)`
    - one tag for a one-size property) and `:316-319`. For the NEW two-size
    spec, a bare `getByText(/matches property/i)` matches TWO tag spans
    (strict-mode violation): scope each assertion to its chip
    (`getByRole('group', { name: 'Voucher size' })`, then
    `getByRole('button', { name: /^2-BR/ })` with `aria-pressed` and
    `toContainText(/matches property/i)`).
  - The seven e2e API bodies posting the legacy `bedroomSize: 2` stay valid
    (the server stores `bedroomSizes: [2]`, U6).
  - `docs/issues/broadcast-4plus-exact-match-underreach.md`: the dashboard
    half is in `d31345ff` (5..12 pre-fill the 4+ chip; the resolver half is
    U6's `989d42d2`).
- Watch grep (`grep -rnE "bedroomSize\b" dashboard/src`, non-test files):
  code sites are only the deprecated type field (`types.ts:3289`) and the
  reader's legacy arm (`broadcastFormat.ts:60,72`); the rest are
  `voucherSizeLabel`'s own parameter name (`:44-47`) and comments. No
  dashboard code writes the legacy key.
- Not run, per the brief: the full `npm test`, any e2e. UI verification of
  this user-facing change belongs to S7's e2e runs (plan section 3).
