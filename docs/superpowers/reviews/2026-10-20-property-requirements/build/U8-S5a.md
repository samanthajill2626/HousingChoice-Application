# U8 (S5a) - wire types and the Apply endpoint, the registry mirror, form plumbing, flyer tags - Tasks 5.1, 5.2, 5.3, 5.4

- Unit: U8, slice S5a (plan Tasks 5.1-5.4), implementer model Claude Opus 5.5.
- Branch `feat/property-requirements`, worktree `W:/tmp/property-requirements`,
  started at `0d0ab8aa` (U7's report commit).
- Rulings carried: AR27 (mirror the READ side only), AR28 (app module a leaf),
  AR33 (wire types in `api/types.ts`, re-exported by the mirror), AR34 (extra
  files, the catalog entry, ASCII copy), AR42 (the catalog entry is Task 5.1's,
  pin 121 -> 122), PR1-3 (tour type read through the dashboard's tour type
  list, exact), PR2-1 (`buildRequirementPatch` ok:false pinned at helper
  level), AR1 / PR1-2 (the 35-row table, Owning landlord first); worklist
  OR-12 (the app suites' mirrored-function cases copied), OR-15 (no import
  added to `types.ts`), OR-6 (no lib widening; the app module compiled clean
  under lib ES2022).
- STOP items: none.

## Per task

| Task | Result | Files |
|---|---|---|
| 5.1 API types and the Apply endpoint (+ the e2e mutation catalog entry) | SHIPPED as written | `dashboard/src/api/types.ts`, `dashboard/src/api/endpoints.ts`, `dashboard/src/api/endpoints.test.ts`, `e2e/performance/mutationCatalog.ts`, `e2e/performance/mutationCatalog.test.ts` |
| 5.2 registry mirror, the D10a table, the drift test | SHIPPED + OR-12 (see Divergences) | `dashboard/src/routes/listing/requirements.ts`, `requirements.test.ts`, `requirementsMirror.test.ts` (new) |
| 5.3 form plumbing | SHIPPED as written | `dashboard/src/routes/listing/requirementForm.ts`, `requirementForm.test.ts` (new) |
| 5.4 FlyerTag, FlyerLegend, tagged field markup | SHIPPED as written | `dashboard/src/routes/listing/FlyerTag.tsx`, `FlyerTag.module.css`, `FlyerTag.test.tsx`, `TaggedField.tsx`, `TaggedField.module.css`, `TaggedField.test.tsx` (new) |

Plan fidelity, checked mechanically. Every new file (and every OR-12 block)
was extracted by line range with `sed`, so it is the source text byte for
byte. A throwaway node script in the session scratchpad then counted each
source block in its target file; every count was exactly 1:
- plan 14717-14894 = `requirementsMirror.test.ts`;
- plan 14913-15215 = `requirements.ts`;
- plan 15268-15503 = `requirementForm.test.ts`;
- plan 15519-15702 = `requirementForm.ts`;
- plan 15751-15798 = `FlyerTag.test.tsx`;
- plan 15804-15876 = `TaggedField.test.tsx`;
- plan 15892-15944 = `FlyerTag.tsx`;
- plan 15950-15979 = `FlyerTag.module.css`;
- plan 15985-16105 = `TaggedField.tsx`;
- plan 16111-16132 = `TaggedField.module.css`;
- plan 14392-14695 sits at the head of `requirements.test.ts` with one
  inserted import line (below).

Task 5.1's edits were made with the Edit tool against the plan's quoted
anchors. All 16 matched the tree text exactly once. None fell in U7's
regions (`AudienceFilter`, the `endpoints.ts:1984` comment), so AR47 never
applied. Edits A, B and endpoints Edit 1 were anchored with one extra
neighboring line for uniqueness; the result is the plan's replacement byte
for byte.

## Commits

| Hash | Subject |
|---|---|
| `c01d962d` | feat(dashboard): property requirements wire types and the landlord Apply endpoint (S5 5.1) |
| `ee562867` | feat(dashboard): requirements registry mirror and the D10a form-field table, with a cross-workspace drift test (S5 5.2) |
| `f205516c` | feat(dashboard): requirement form plumbing - values, edit patch, create fields, snapshot, voucher-size split (S5 5.3) |
| `96ca4e8f` | feat(dashboard): flyer tags, the tag legend and tagged field markup (S5 5.4) |
| (this file) | docs(records): ... U8 S5a report |

## RED runs (each red for the stated reason)

- 5.1:
  - `src/api/endpoints.test.ts`: 1 failed / 55 passed (56), `TypeError:
    applyLandlordRequirements is not a function`. The `createUnit` (PIN)
    and the type fixture passed at runtime.
  - e2e `performance/mutationCatalog.test.ts`: 1 failed / 3 passed (4),
    "expected [ Array(121) ] to have a length of 122 but got 121".
  - Root `npm run typecheck`: exit 2, 7 errors, all in
    `endpoints.test.ts`: TS2305 x2 (no `applyLandlordRequirements`, no
    `ApplyRequirementsBody`); TS2322 x2 (`pets: false` not a string,
    `number[]` not a number); TS2353 (`req_pets` excess on
    `ContactPatch`); TS2339 x2 (`requirement_sources` read as `{}` through
    the index signature, `req_deposit`). These are the plan's predicted
    categories.
- 5.2: both files failed to load, `Failed to resolve import
  "./requirements.js"`. The drift test imports the APP module first and
  failed on the mirror only, so S1's module resolved.
- 5.3: `Failed to resolve import "./requirementForm.js"`.
- 5.4: `Failed to resolve import "./FlyerTag.js"` / `"./TaggedField.js"`.

## GREEN runs

| When | Scope | Result |
|---|---|---|
| 5.1 | `src/api/endpoints.test.ts` | 56/56 |
| 5.1 | `src/api src/routes/listing src/routes/listings src/routes/broadcasts` | 40 files, 883/883 |
| 5.1 | e2e `performance/mutationCatalog.test.ts performance/firewall.test.ts` | 2 files, 23/23 |
| 5.1 | root `npm run typecheck`; `npx eslint` (5 files, baseline before the edits also exit 0) | exit 0; exit 0 |
| 5.2 | `requirements.test.ts` 58 + `requirementsMirror.test.ts` 10 | 68/68 |
| 5.2 | root typecheck (the drift test's app import compiled under `dashboard/tsconfig.json`, lib ES2022 - OR-6 needed no fix); eslint (3 files) | exit 0; exit 0 |
| 5.3 | `requirementForm.test.ts` 23 + `requirements.test.ts` 58 | 81/81 |
| 5.3 | root typecheck; eslint (2 files) | exit 0; exit 0 |
| 5.4 | `FlyerTag.test.tsx` 7 + `TaggedField.test.tsx` 6 | 13/13, no React warnings in the log |
| 5.4 | root typecheck; eslint (4 files) | exit 0; exit 0 |
| Unit end | `src/api src/routes/listing` | 29 files, 627/627 |
| Unit end | the WHOLE dashboard suite (`cd dashboard && npx vitest run`) | 255 files, 4973/4973, exit 0, 61.1 s (U7's 250 / 4866 plus this unit's 5 files and 107 cases exactly) |
| Unit end | e2e `performance/mutationCatalog.test.ts performance/firewall.test.ts` | 2 files, 23/23 |
| Unit end | root `npm run typecheck` (app with its 3 tsconfigs - `tsconfig.test.json` still compiles `dashboard/src/api/types.ts` - dashboard, e2e, fake-twilio, fake-twilio-web) | exit 0 |
| Unit end | `npx eslint $(git diff --name-only --diff-filter=d 0d0ab8aa...HEAD -- '*.ts' '*.tsx')` (14 files) | exit 0 |
| After the mutant reverts | the five suites this unit added | 104/104 |

ASCII: every new file prints 0 on the `tr` check. The added lines of the
five edited files also print 0 (`types.ts` and `endpoints.test.ts` carry
pre-existing non-ASCII). The em dash on the old `types.ts` voucher comment
left with Edit E. No literal backslash-u anywhere. The `\n` and `\'`
escapes in `requirementsMirror.test.ts:25,96` landed literally. All files
are LF. OR-15: `git diff 0d0ab8aa..HEAD -- dashboard/src/api/types.ts`
adds no `import` line.

## Mutant table

Ten mutants, applied and reverted with the Edit tool one at a time.
Before each run, `git diff -U0` showed exactly the one mutant. The six
mirror mutants ran each suite ALONE, so the drift test's own coverage is
visible. Line numbers are in the final tree. Afterwards
`git status --short` and `git diff --stat` were empty, and
`git diff --exit-code HEAD` on the three mutated source files exited 0.

| # | Mutant | file:line | Test run (failed / total) | Result | Follow-up |
|---|---|---|---|---|---|
| M1 | legacy pets read flipped (`false` reads No pets unchecked) | `requirements.ts:179` | requirements 8/58; mirror drift 2/10; requirementForm 1/23 | KILLED | - |
| M2 | money read `>= 0` -> `> 0` (a stored 0 reads blank) | `requirements.ts:164` | 2/58; 2/10; 2/23 | KILLED | - |
| M3 | PR1-3: tour type trimmed before the enum check (`' pm_team '` reads `pm_team`) | `requirements.ts:165` | 1/58; 2/10; requirementForm 0/23 (no off-enum case, not its job) | KILLED | - |
| M4 | `readRequirementSources` keeps unknown ids (the id check dropped) | `requirements.ts:223` | 2/58; 1/10; 0/23 | KILLED | - |
| M5 | `itemValuesEqual` iterates only the first value's keys | `requirements.ts:207` | 1/58 - ONLY the OR-12 copy of U1's case "a key missing on either side is blank, so equality is symmetric"; drift 0/10; 0/23 | KILLED | - (see below) |
| M6 | D10a table drift: Subzone tagged `on_flyer` in the mirror | `requirements.ts:260` | 2/58; drift 1/10 (the table compare); requirementForm 1/23 (`formFieldVisibility`) | KILLED | - |
| M7 | the One-month-rent rule fires only when the box was ALREADY ticked (`!== true` -> `=== true`) | `requirementForm.ts:103` | requirementForm 2/23 (the save that checks it; the save that leaves it) | KILLED | - |
| M8 | create: the one-month guard tests `deposit_one_month` instead of `deposit` (amount sent beside One month's rent) | `requirementForm.ts:122` | 1/23 | KILLED | - |
| M9 | TaggedField: the tag line moved INSIDE the `<label>` (two lines swapped) | `TaggedField.tsx:52-53` | TaggedField 3/6 (the label text becomes "Subzone Staff only"; `getByLabelText('Subzone')` finds nothing) | KILLED | - |
| M10 | TaggedCheckbox: the tag line moved inside the `<label>` | `TaggedField.tsx:98-99` | 2/6 (no checkbox named "Same-day RTA" / "No pets") | KILLED | - |

No mutant survived, so no follow-up test was added.

M5 shows why OR-12 matters. Every reader returns every key of its item, so
the drift test only ever compares values with equal key sets and cannot see
a one-sided equality. The copied app case is the one guard, in the
dashboard just as in the app (U1's M3).

Considered and NOT run, because they are equivalent at the system level or
on every reachable input:
- `buildRequirementPatch` sending `false` instead of `null` for an unticked
  box (`requirementForm.ts:91`). The helper test pins `null` and would kill
  it. But the unit validator and the landlord parser REMOVE on `false` and
  `null` alike (D1), so the server behavior is the same.
- The mirror's `isOwnValue` (`requirements.ts:230-233`, the plan's
  two-clause form) against the app's three-branch form
  (`app/src/lib/requirements.ts:318-323`). They agree on every value of the
  declared `RequirementSources` type, which is all `readRequirementSources`
  can return. See "For later units".

## Divergences from the plan text

- `requirements.test.ts` = the plan's text, plus three additions:
  - one import line, `type ItemValue` (`:23`), which the copied `raw()`
    helper needs;
  - a comment header (`:307-319`);
  - the OR-12 copies, byte-identical to the app ranges (each counted once
    in the target):
    - `app/test/requirements.test.ts:36-39` (`raw`), `:41-57`
      (`UNIT_KEYS`), `:59-133` (REQUIREMENT_ITEMS describe), `:207-260`
      (the D1 read) and `:262-326` (equality, incl. U1's symmetric case
      at its `:270-275`);
    - `app/test/requirementSources.test.ts:59-82` (`readRequirementSources`)
      and `:84-105` (`isOwnValue`);
    - `app/test/propertyFormFlyerParity.test.ts:173-226` and `:236-247`
      (the 35-row table, registry agreement, the Owning landlord row,
      frozen).
  - Same describe names, `it` names, inputs and expected values. Not
    copied are the app's server-only cases (`normalizeRequirementValue`,
    `hasDepositConflict`, `parseLandlordRequirementPatch`,
    `parseRequirementsSnapshot`, `nextRequirementSources`), the parity
    case that runs `validateUnitBody`, and the `toUnitFlyer` walk (AR27).
  - The plan's own cases are kept as written. Several share inputs with
    the copies, which is harmless and keeps the plan text intact.
- The 5.2 commit body adds one sentence naming the OR-12 copies.
- Commits used `git commit -F -` (implementer rules) instead of the plan's
  `-m` flags. Same subjects and trailer.
- None otherwise.

## CONTRACT (what U9-U13 import)

### `dashboard/src/api/types.ts` (type-only, no import added - OR-15)

- `UnitItem`:
  - NEW `washer_dryer?: WasherDryer` (`:2557`).
  - NEW `no_evictions_on_program?: boolean`, `evictions_notes?: string`,
    `credit_requirements?: string`, `income_requirements?: string`,
    `qualifications?: string`, `no_pets?: boolean`, `pet_fee?: string`,
    `deposit_one_month?: boolean`, `deposit_flexible?: boolean`,
    `deposit_notes?: string` (`:2598-2616`).
  - NEW `requirement_sources?: Partial<Record<RequirementItemId, RequirementSource>>`
    (`:2619`).
  - WIDENED `pets?: string | boolean` (`:2577`) and
    `voucher_size_accepted?: number | number[]` (`:2624`).
  - Comments fixed: `subzone` staff only, `deposit` fixed amount,
    `lease_terms` PUBLIC. `application_fee`, `tour_type` and
    `tour_process` are unchanged.
- `Contact`: the 15 `req_` keys (`:2298-2312`). Checkboxes `boolean`,
  `req_deposit` / `req_application_fee` `number`, `req_tour_type`
  `TourType`, the rest `string`; `req_pets` is `string` (never boolean).
- `ContactPatch`: the same 15 keys, each `| null`; `req_tour_type` is
  `TourType | '' | null` (`:2382-2396`).
- New exported types (`:2653-2708`):
  - `RequirementItemId` (the eight ids);
  - `RequirementSource` = `'copied' | 'set_here'`;
  - `WasherDryer` = `'hookups' | 'included' | 'none'`;
  - `RequirementItemWire` = `Record<string, string | number | boolean | null>`;
  - `RequirementsSnapshotWire` = `{ landlordId: string } & Partial<Record<RequirementItemId, RequirementItemWire>>`;
  - `CreateUnitBody` = `{ landlordId: string; requirements_snapshot?: RequirementsSnapshotWire; [key: string]: unknown }`;
  - `ApplySkipReason` (the six reasons);
  - `ApplyRequirementsBody` = `{ units: Array<{ unitId: string; ownItems: RequirementItemId[] }>; items: RequirementItemId[]; expected: Partial<Record<RequirementItemId, RequirementItemWire>> }`;
  - `ApplyRequirementsResult` = `{ updated: string[]; skipped: Array<{ unitId: string; reason: ApplySkipReason }> }`.
- All of these reach components through the api barrel (`api/index.js`).

### `dashboard/src/api/endpoints.ts`

- `applyLandlordRequirements(contactId: string, body: ApplyRequirementsBody, signal?: AbortSignal): Promise<ApplyRequirementsResult>`
  (`:1478`).
  - It POSTs to `/api/contacts/<encoded id>/requirements/apply` with
    `{ method: 'POST', body }`, plus `signal` only when one is given.
  - It returns the 200 body as sent. A non-2xx throws `ApiError`, whose
    `.code` is the server's `error`.
- `createUnit(body: Record<string, unknown>): Promise<UnitItem>` (`:975`)
  is unchanged except for its doc comment: the body may carry
  `requirements_snapshot`, passed through untouched (PIN). Task 5.9
  types it with `CreateUnitBody`.
- e2e: catalog entry `e2e/performance/mutationCatalog.ts:146-148`
  (`request:POST`, `/api/contacts/:contactId/requirements/apply`,
  workflow_only, first_party_api). Count pin
  `e2e/performance/mutationCatalog.test.ts:384` = 122.

### `dashboard/src/routes/listing/requirements.ts` (the mirror; app = source of truth)

- Re-exports (`:26`): `RequirementItemId`, `RequirementSource` from the api
  barrel.
- Types:
  - `RequirementGroup`, `RequirementFieldKind`, `FlyerVisibility` =
    `'on_flyer' | 'staff_only'` (`:31-33`);
  - `RequirementField { key; landlordKey; label; kind; flyer }` (`:35`);
  - `RequirementItem { id; label; group; fields }` (`:46`);
  - `ItemValue` = `Record<string, string | number | true | null>` (`:156`);
  - `RequirementSources` (`:216`);
  - `FormFieldVisibility { label; keys: readonly string[]; flyer }` (`:236`).
- Constants (all frozen at every level, as the app's):
  - `REQUIREMENT_ITEMS` (`:129`);
  - `REQUIREMENT_ITEM_IDS` (`:131`);
  - `REQUIREMENT_UNIT_KEYS` (15, `:133`);
  - `REQUIREMENT_LANDLORD_KEYS` (15, `:137`);
  - `PROPERTY_FORM_FIELDS` (35 rows, Owning landlord first, `:288`);
  - `WASHER_DRYER_VALUES` (`:293`);
  - `WASHER_DRYER_LABELS: Readonly<Record<WasherDryer, string>>` =
    Hookups / Washer and dryer included / No hookups (`:296`, AR39:
    import it, no second copy);
  - `VOUCHER_SIZE_MAX = 12` (`:303`).
- Functions, signatures as plan 2.1:
  - `isRequirementItemId` (`:141`);
  - `itemOfUnitKey` (`:145`);
  - `unitItemValue(unit, id)` (`:172`);
  - `landlordItemValue(contact, id)` (`:187`);
  - `itemValuesEqual(a, b)` (`:206`);
  - `isItemBlank(v)` (`:212`);
  - `readRequirementSources(raw)` (`:219`);
  - `isOwnValue(sources, id, unitValue)` (`:230`).
- A tour type reads only when it is exactly one of `TOUR_TYPE_LABELS`'
  keys (`TOUR_TYPE_SET`, `:29`; PR1-3).
- Internal guard: `itemById` throws
  `unknown requirement item: <id>`. The app's text differs
  (`requirements: unknown item id <id>`); both are reachable only through
  a cast.

### `dashboard/src/routes/listing/requirementForm.ts`

- `RequirementFormValues` = `Record<string, string | boolean>` (`:25`),
  keyed by UNIT key: a checkbox holds a boolean, every other field the
  string its control shows.
- `REQUIREMENT_FIELDS: readonly RequirementField[]` (`:28`, display order,
  not frozen).
- `emptyRequirementFormValues()` (`:34`): all 15 keys; checkboxes
  `false`, the rest `''`.
- `requirementFormValuesFromUnit(unit)` (`:54`): through the D1 read,
  legacy pets included.
- `requirementFormValuesFromLandlord(contact: Record<string, unknown>)`
  (`:60`): `req_` keys only, never a boolean `req_pets`, never the tenant
  keys. A `Contact` passes as-is (index signature).
- `isNoApplicationFee(values)` (`:65`): true for a recorded 0 (`'0'`,
  `'0.00'`).
- `buildRequirementPatch(initial, current)` (`:82`) ->
  `{ ok: true; patch } | { ok: false; error }`.
  - Only changed keys are sent: a checkbox as `true` / `null`; text as
    typed (`''` when cleared); money as a number or `null`; the tour type
    as the select value.
  - The save that CHECKS One month's rent adds `deposit: null`
    (`:103`).
  - The error is `<field label> must be a number 0 or greater.`
    (`Fixed amount ...`, `Application fee ...`).
- `buildRequirementCreateFields(values)` (`:110`) ->
  `{ ok: true; fields } | { ok: false; error }`.
  - It sends only non-blank fields: text trimmed, `true` boxes, numbers
    (0 included).
  - It sends no `deposit` while One month's rent is ticked. The error
    string is the same as above.
- `requirementsSnapshotOf(contact: Contact): RequirementsSnapshotWire`
  (`:136`): `landlordId: contact.contactId` plus all eight items, every
  key, `null` for blank.
- `toLandlordPatch(patch)` (`:143`): prefixes every key with `req_` and
  keeps the values.
- `formFieldVisibility(label)` (`:149`) -> `FlyerVisibility`. It throws
  `"<label>" is not a property-form field in PROPERTY_FORM_FIELDS (D10a)`
  for an unknown label.
- `splitVoucherSizes(raw)` (`:158`) -> `{ sizes: number[]; invalid: unknown[] }`.
  `sizes` holds the integers 0..12, ascending and de-duplicated;
  everything else goes to `invalid`, in order.
- `voucherSizesPatchValue(raw, current)` (`:175`) ->
  `number[] | null | undefined`:
  - `undefined` = send nothing (unchanged, and no off-chip value);
  - `null` = emptied;
  - otherwise the list, ascending.

### `dashboard/src/routes/listing/FlyerTag.tsx`

- `FlyerAudience` = `'property' | 'landlord'` (`:12`).
- `FlyerTagProps { visibility: FlyerVisibility; audience: FlyerAudience; id: string }`
  (`:14`).
- `flyerTagText(visibility, audience)` (`:21`): `On flyer`,
  `Staff only`, or `On property flyers` (landlord + on_flyer).
- `FlyerTag(props)` (`:26`): a `<span id={id}>` with classes `tag` plus
  `onFlyer` or `staffOnly` (`FlyerTag.module.css:5,15,20`). It renders
  the span only; callers keep it outside any `<label>`.
- `FlyerLegend({ audience })` (`:45`): a `<ul>` (class `legend`) of two
  `<li>`, the plan 1.1 lines for the property or the landlord form.

### `dashboard/src/routes/listing/TaggedField.tsx`

- `PUBLIC_FLYER_NOTE` = `Tenants see this on the public flyer.` (`:16`).
- `TaggedControlProps { id: string; 'aria-describedby': string }` (`:19`):
  spread both onto the control.
- `TaggedFieldProps` (`:24`): `{ label; visibility; audience; publicNote?;
  className?; children: (control: TaggedControlProps) => React.ReactNode }`.
  - The root is a div (`className`, default `ListingEditForm.module.css`
    `.field`).
  - Inside it, `.labelRow` holds the `<label htmlFor>` and the
    `FlyerTag`; then the control; then, with `publicNote`, a
    `<p class="publicNote">`.
  - The control's accessible name is the label; its description is the
    tag text, plus ` Tenants see this on the public flyer.` with
    `publicNote`.
- `TaggedCheckboxProps { label; visibility; audience; checked: boolean;
  onChange: (checked: boolean) => void; disabled? }` (`:65`).
  - A wrapping `<label>` (`.field .checkField`) holds the box and its
    label text; the `FlyerTag` sits after the label, in `.checkRow`.
  - The box is named by its label and described by the tag.
- `TaggedGroupLabelProps { label; visibility; audience; tagId }` (`:104`).
  - It renders a visible `<span>` label plus the tag under `tagId`.
  - Every control of the group must put `tagId` in its own
    `aria-describedby` (the Address parts).

## For later units and the orchestrator

- U9 (S5b, Tasks 5.5-5.7):
  - The picker plumbing (`splitVoucherSizes`, `voucherSizesPatchValue`),
    `formFieldVisibility` and `REQUIREMENT_FIELDS` are in
    `requirementForm.ts`.
  - `TaggedField` / `TaggedCheckbox` / `TaggedGroupLabel` /
    `PUBLIC_FLYER_NOTE` are in `TaggedField.tsx`; `FlyerTag` /
    `FlyerLegend` are in `FlyerTag.tsx`.
  - A `<FlyerTag>` is what the picker's `labelAside` (C5) carries.
  - The tag ids come from React 19.2's `useId` and contain no
    whitespace, so concatenated `aria-describedby` lists are safe.
- U10 (S5c, Tasks 5.8-5.9):
  - `createUnit` still takes `Record<string, unknown>`; `CreateUnitBody`
    is already declared (`types.ts:2680`) for Task 5.9 to adopt.
  - The deposit rules are in the helpers, not the forms:
    `buildRequirementPatch` sends `deposit: null` on the save that checks
    One month's rent, and `buildRequirementCreateFields` never sends an
    amount beside it.
  - The ok:false error strings are bound by the 5.3 tests.
- U11 (S6a):
  - Append `requirementDisplay` / `formatItemValue` /
    `landlordHasNoRequirements` to `requirements.ts`. Per OR-16, merge
    `type Contact, type UnitItem` into the EXISTING api import
    (`requirements.ts:20-25`) and leave `TOUR_TYPE_SET` (`:29`) where it
    is.
  - Import `WASHER_DRYER_LABELS` from `./requirements.js` (AR39, and the
    FlyerPage follow-on).
  - Pass a unit's map through `readRequirementSources` before
    `isOwnValue`. The mirror's `isOwnValue` answers `false` for an
    unknown stored value, where the app's falls through to "not blank";
    they agree on everything `readRequirementSources` returns.
  - Iterate `REQUIREMENT_ITEMS` for display order, never the map's keys.
    The mirror's `readRequirementSources` keeps the STORED key order and
    the app's keeps registry order; `toEqual` cannot see the difference.
- U12 (S6b):
  - Call `applyLandlordRequirements(contactId, body)` (no signal, per the
    plan); `ApplyRequirementsBody` / `ApplyRequirementsResult` /
    `ApplySkipReason` are in the barrel.
  - For the landlord form use `requirementFormValuesFromLandlord(contact)`,
    then `buildRequirementPatch(initial, current)`, then
    `toLandlordPatch(r.patch)` (AR36). That already sends
    `req_deposit: null` on the save that checks One month's rent, so it
    avoids U5's landlord 400 `deposit_conflict`.
- U13 (S7): the AR42 / OR-25 check is already satisfied: the catalog
  entry and the 122 pin are both in the tree (lines above), so Task 7.1
  needs no fallback.
- Everyone: `requirements.test.ts` carries the app suites' cases verbatim.
  When an app case for a mirrored function changes, copy the change; the
  drift test alone would not catch every drift (M5).
- Facts re-verified in the tree (AR48), all holding:
  - F12: `createUnit` is a pass-through (the PIN is green).
  - F25: the anchors match. Line hint only: the one `routes/` type import
    in `types.ts` is at `:8`, not R3's `:15`.
  - C13: 121 -> 122; the firewall suite is green, so the `/api/` path is
    intercepted.
  - `Contact` requires only `contactId` and `type` (the 5.3 snapshot
    fixture type-checks).
  - Every CSS token and `formStyles` class the new modules use exists.
- Not run, per the brief: the full `npm test`, any Playwright e2e.
