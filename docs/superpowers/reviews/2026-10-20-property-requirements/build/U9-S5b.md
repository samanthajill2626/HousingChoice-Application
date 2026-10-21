# U9 (S5b) - voucher size picker B, the shared Requirements section, tag room on OrgPicker / ContactSearchField - Tasks 5.5, 5.6, 5.7

- Unit: U9, slice S5b (plan Tasks 5.5-5.7), implementer model Claude Opus 5.5.
- Branch `feat/property-requirements`, worktree `W:/tmp/property-requirements`,
  started at `737cefe4` (U8's report commit).
- Rulings carried: AR29 (optional `labelAside` / `describedBy` on OrgPicker
  and VoucherSizePicker, optional `describedBy` on ContactSearchField), AR37
  (the host renders the section heading and FlyerLegend; RequirementsFields
  renders groups and fields), AR39 (`acceptsSummary` lives in
  `VoucherSizePicker.tsx`), PR2-3 (both money inputs `step="any"` with
  `min={0}`), plan 3.2 (tags outside the `<label>` element, tied by
  aria-describedby); worklist OR-13 (Task 5.7 GREEN adds placements, shared,
  tours), OR-21 (no group-by-name selector in my tests needed scoping: the
  harnesses render one component each).
- STOP items: none.

## Per task

| Task | Result | Files |
|---|---|---|
| 5.5 VoucherSizePicker (picker B) | SHIPPED as written | `dashboard/src/routes/listing/VoucherSizePicker.tsx`, `.module.css`, `.test.tsx` (new) |
| 5.6 RequirementsFields | SHIPPED as written | `dashboard/src/routes/listing/RequirementsFields.tsx`, `.module.css`, `.test.tsx` (new) |
| 5.7 OrgPicker / ContactSearchField optional props | SHIPPED as written (+ OR-13 in the GREEN run) | `dashboard/src/routes/orgs/OrgPicker.tsx`, `OrgPicker.module.css`, `OrgPicker.test.tsx`, `dashboard/src/routes/contact/ContactSearchField.tsx`, `ContactSearchField.test.tsx` |
| mutant follow-ups (implementer rules) | 3 tests added | `VoucherSizePicker.test.tsx`, `RequirementsFields.test.tsx` |

Plan fidelity, checked mechanically. Every new file was extracted from the
plan by line range with `sed`. After the commits, `git show <commit>:<file>`
was diffed against the same plan range; all six were IDENTICAL:
- plan 16178-16300 = `VoucherSizePicker.test.tsx` (at baa0ebce);
- plan 16316-16428 = `VoucherSizePicker.tsx`;
- plan 16434-16522 = `VoucherSizePicker.module.css`;
- plan 16568-16735 = `RequirementsFields.test.tsx` (at 9f7f3945);
- plan 16751-16939 = `RequirementsFields.tsx`;
- plan 16945-16988 = `RequirementsFields.module.css`.

Task 5.7:
- The two appended test blocks equal plan 17037-17061 and 17069-17095,
  byte for byte (tail diff at c00563b7).
- Edits 1-7 used the Edit tool on the R3 anchors. All 8 matched exactly
  once: `OrgPicker.tsx` hint prop, destructure, describedBy list, label;
  `OrgPicker.module.css` `.label`; `ContactSearchField.tsx` props end,
  destructure, aria-label.
- None of those five files had changed since 1d7a4667, so AR47 never
  applied.
- The non-ASCII placeholder line (`ContactSearchField.tsx:265`, `:260`
  before the edits) was not touched.

## Commits

| Hash | Subject |
|---|---|
| `baa0ebce` | feat(dashboard): voucher size picker B - Studio to 12, toggle chips with aria-pressed (S5 5.5) |
| `9f7f3945` | feat(dashboard): the shared Requirements section for the property and landlord forms (S5 5.6) |
| `c00563b7` | feat(dashboard): OrgPicker labelAside/describedBy and ContactSearchField describedBy, so the property forms can tag those fields (S5 5.7) |
| `a88a9e48` | test(dashboard): mutant follow-ups for picker B and the Requirements section (S5 5.5, 5.6) |
| (this file) | docs(records): ... U9 S5b report |

## RED runs (each red for the stated reason)

- 5.5: `Failed to resolve import "./VoucherSizePicker.js"`.
- 5.6: `Failed to resolve import "./RequirementsFields.js"`.
- 5.7 (`OrgPicker.test.tsx` + `ContactSearchField.test.tsx`): 2 failed /
  53 passed (55), exactly as predicted:
  - OrgPicker description "Pick every authority" (no "On flyer");
  - ContactSearchField description ''.
  - Both (PIN)s were green.
- 5.7, dashboard `tsc`: exit 2 with the two predicted TS2322 errors,
  unknown `describedBy` at `ContactSearchField.test.tsx:405` and unknown
  `labelAside` / `describedBy` at `OrgPicker.test.tsx:494`.

## GREEN runs

| When | Scope | Result |
|---|---|---|
| 5.5 | `VoucherSizePicker.test.tsx` | 9/9 |
| 5.5 | root `npm run typecheck`; `npx eslint` (2 files) | exit 0; exit 0 |
| 5.6 | `RequirementsFields.test.tsx` 40 + `TaggedField.test.tsx` 6 | 46/46, no stderr |
| 5.6 | root typecheck; eslint (2 files) | exit 0; exit 0 |
| 5.7 | `src/routes/orgs contact broadcasts settings listing email conversation` + OR-13 `placements shared tours` | 191 files, 4094/4094, exit 0 |
| 5.7 | root typecheck; eslint (4 files) | exit 0; exit 0 (the same four files at the base, unchanged since 1d7a4667, also exit 0) |
| Unit end | the WHOLE dashboard suite (`cd dashboard && npx vitest run`) | 257 files, 5026/5026, exit 0, 61.8 s |
| Unit end | `npx eslint $(git diff --name-only --diff-filter=d 737cefe4...HEAD -- '*.ts' '*.tsx')` (8 files) | exit 0 |
| After the mutant reverts | `VoucherSizePicker` 11, `RequirementsFields` 41, `OrgPicker` 30, `ContactSearchField` 25 | 107/107 |
| After the mutant reverts | root typecheck; eslint on the 2 test files | exit 0; exit 0 |

Notes on the counts:
- The whole-suite total is U8's 255 / 4973 plus this unit's two new files
  and 53 cases (9 + 40 + 2 + 2).
- The follow-up commit then adds 3 cases (2 + 1). Those were run in their
  own suites, not in a second whole-suite run, so the expected whole-suite
  total is now 5029.
- Vitest path filters are substrings, so the 5.7 run's `src/routes/listing`
  and `src/routes/contact` also ran `listings` and `contacts`.

Stderr in the host and whole-suite runs:
- act() warnings in untouched suites (ContactDetail, ContactEditForm,
  RemindersPanel, ListingEditForm, ...).
- One duplicate-key warning in `RelationshipsEditor.test.tsx` "Remove works
  correctly when there are multiple rows".
- Both are unrelated by construction. This unit adds only an
  `aria-describedby` that is undefined for every existing host, and no new
  prop is passed by any existing host. They were not re-run at the base.
- None of the four suites this unit touched writes anything to stderr.

ASCII:
- Every new file prints 0 on the `tr` check.
- The added lines of the five 5.7 files print 0.
- No literal backslash-u anywhere.
- All files are LF.

## Mutant table

Ten mutants, applied and reverted with the Edit tool one at a time. Before
each run, `git diff -U0` showed exactly the one mutant. Line numbers are in
the final tree. Afterwards:
- `git status --short` and `git diff --stat` showed only the two follow-up
  test files (since committed);
- `git diff --exit-code HEAD` on all seven source / CSS files exited 0.

| # | Mutant | file:line | Test run (failed / total) | Result | Follow-up |
|---|---|---|---|---|---|
| M1 | auto-open lost: `expanded` starts `false` instead of "any stored size >= 5" | `VoucherSizePicker.tsx:54` | VoucherSizePicker 0/9 | SURVIVED | new case "unselecting the stored 5+ size keeps the larger chips open, with Fewer sizes to hide them": mutant 1 failed / 10 (chip "7" vanished), clean 10/10 |
| M2 | "Fewer sizes" shown while a 5+ is selected (`!largeSelected` -> `true`) | `VoucherSizePicker.tsx:97` | 2/10 | KILLED | - |
| M3 | aria-pressed toggling: a pressed chip is never removed (`next` always appends) | `VoucherSizePicker.tsx:63` | 4/10 | KILLED | - |
| M4 | summary order: `acceptsSummary` drops its ascending sort | `VoucherSizePicker.tsx:38` | 1/10 (the `acceptsSummary` case) | KILLED | - |
| M5 | an emptied picker never reports `[]` (`onChange` guarded by `next.length > 0`) | `VoucherSizePicker.tsx:64` | 2/10 | KILLED | - |
| M6 | off-chip line needs two or more values (`invalid.length > 1`) | `VoucherSizePicker.tsx:106` | 0/10 | SURVIVED | new case "lists a single stored value it has no chip for, beside the recorded sizes": mutant 1 failed / 11, clean 11/11 |
| M7 | money inputs `step="any"` -> `step={1}` (both amounts share the one input element) | `RequirementsFields.tsx:97` | RequirementsFields 0/40 | SURVIVED | new case "the two amounts take any amount of 0 or more, cents included" (min 0, step any, valid with 1250.5 / 35.75): mutant 1 failed / 41 (received `step="1"`), clean 41/41 |
| M8 | "No application fee" no longer disables the amount (`isFee ? false : oneMonth`) | `RequirementsFields.tsx:99` | 2/41 | KILLED | - |
| M9 | "One month's rent" no longer disables the fixed amount (`isFee ? noFee : false`) | `RequirementsFields.tsx:99` | 1/41 | KILLED | - |
| M10 | OrgPicker drops the host's describedBy ids (`extraDescribedBy ?? ''` -> `''`) | `OrgPicker.tsx:315` | OrgPicker 1/30 | KILLED | - |

Why the three survivors were real bugs:
- M1: D4 says only "Fewer sizes" hides the larger chips. Under the mutant,
  unselecting a STORED 7 collapsed them by itself, and the chip just
  pressed vanished under the pointer. The plan's auto-open case checks the
  first render only, where `largeSelected` alone opens the chips.
- M6: the likeliest legacy off-chip shape is ONE stored number. The old
  write kind stored a single number, and D4's own example is "2.5". Under
  the mutant that value would be dropped on save with no warning. The
  plan's case used two values.
- M7: PR2-3. The plan pins `step="any"` only in the form tasks (5.8, 5.9),
  so the shared component itself had no pin until now.

Considered and NOT run (the ten-mutant cap, or equivalent):
- "No application fee" recording 0, and "One month's rent" clearing the
  amount: both pinned by value and spy assertions in the plan's cases.
- `min={0}` removed: the M7 follow-up asserts `min="0"` on both amounts,
  but no separate mutant was run.
- ContactSearchField's `aria-describedby={describedBy}` line: the 5.7 RED
  run already shows its case failing without it.
- The `null` half of "empty -> [] / null": the conversion is U8's
  `voucherSizesPatchValue` (`requirementForm.ts:183`), outside this unit and
  pinned by `requirementForm.test.ts`.
- `publicNote` narrowed to `field.flyer === 'on_flyer'`
  (`RequirementsFields.tsx:136`): EQUIVALENT on today's registry. Only
  `text` and `long_text` fields reach that branch, and the one `long_text`
  (Qualifications) is staff only. The opposite narrowing
  (`field.kind === 'text'`) would be killed by the tag `it.each`.

## Divergences from the plan text

- None in shipped code. Every new file is the plan text byte for byte at
  its task commit. Task 5.7 is the plan's seven replacements plus its two
  test blocks verbatim.
- One extra commit, `a88a9e48`: the three mutant follow-up tests above.
  The implementer rules require it.
- Task 5.7's GREEN run adds `src/routes/placements src/routes/shared
  src/routes/tours` (OR-13).
- Commits used `git commit -F -` (implementer rules) instead of the plan's
  `-m` flags, with the same subjects, bodies and trailer. MERGE_HEAD was
  checked with `git rev-parse -q --verify MERGE_HEAD` (empty every time).

## CONTRACT (what U10-U13 rely on)

### `dashboard/src/routes/listing/VoucherSizePicker.tsx` (new)

- `VoucherSizePickerProps` (`:14-26`):
  - `value: number[]`: the selected sizes; the host passes
    `splitVoucherSizes(raw).sizes`;
  - `invalid: readonly unknown[]`: the host passes `.invalid`;
  - `onChange(next: number[])`: always ascending and de-duplicated; `[]`
    when emptied, and the host maps that to `null` through
    `voucherSizesPatchValue`;
  - `disabled?`;
  - `labelAside?: React.ReactNode`: the host's `<FlyerTag>`, rendered
    beside the label;
  - `describedBy?: string`: the tag's id.
- `acceptsSummary(sizes: readonly number[]): string` (`:36`, AR39):
  `Accepts: none recorded`, or `Accepts: ` + ascending `Studio` /
  `<n> BR` joined by `, `.
- `VoucherSizePicker(props)` (`:42`). Fully controlled: it keeps no copy of
  the selection; its only state is whether the large chips are open.
- Markup and names:
  - A visible `<span>` "Voucher sizes accepted" (no `<label>` element).
  - The GROUP (`:76`) is `role="group"`, named by `aria-labelledby` (that
    span). It holds ONLY the chips: `<button type="button" aria-pressed>`
    named `Studio`, `1`..`4`, then `5`..`12` when open.
  - The group's aria-describedby is the host's `describedBy`, then the
    summary `<p>`, then (when `invalid` is non-empty) the off-chip `<p>`
    `Not a valid size, removed when you save: <values joined by ', '>`.
  - The `More sizes (5-12)` / `Fewer sizes` button sits OUTSIDE the group.
  - Ids come from `useId`, so they are not stable. Select by role and
    name.
- Expand rule:
  - Open when the large chips were opened (by More, or at mount because
    `value` held a 5+), OR any 5+ is selected now.
  - `More` shows while closed. `Fewer` shows while open and no 5+ is
    selected.
  - The mount-time open is decided ONCE, from the first `value`. A host
    that mounts the picker before its value is known still opens the
    chips while a 5+ is selected (`largeSelected`).

### `dashboard/src/routes/listing/RequirementsFields.tsx` (new)

- `RequirementsFieldsProps` (`:23-28`): `values: RequirementFormValues`
  (keyed by UNIT key), `onChange(next: RequirementFormValues)` (the WHOLE
  next value on every change), `audience: FlyerAudience`, `disabled?`.
  `RequirementFormValues` is re-exported (`:21`).
- It renders no section heading and no FlyerLegend (AR37: the host does).
- Structure:
  - A root div with four `<fieldset>`s (role group, named by their
    `<legend>`): `Screening`, `Pets`, `Move-in costs`, `Touring` (`:182`).
  - Nested `<fieldset>`s `Evictions` (in Screening) and `Deposit` (in
    Move-in costs) (`:170`).
  - Pets and Touring are not nested: same name as their group.
- Controls, by accessible name (= the label text, exact). Each control's
  description is its tag: `On flyer` / `Staff only`, or `On property
  flyers` on the landlord audience.

  | Label | Element | Notes |
  |---|---|---|
  | `No evictions while on the program` | checkbox | |
  | `Evictions (details)` | text input | |
  | `Credit score` | text input | |
  | `Income requirements` | text input | |
  | `Qualifications` | textarea | rows 3 |
  | `No pets` | checkbox | |
  | `Pets (details)` | text input | placeholder `e.g. Cats only`; also described by `Tenants see this on the public flyer.` |
  | `Pet fee` | text input | same public note |
  | `One month's rent` | checkbox | |
  | `Fixed amount` | number input | min 0, step any |
  | `Flexible / payment terms available` | checkbox | |
  | `Deposit notes` | text input | |
  | `No application fee` | checkbox | tagged as the fee |
  | `Application fee` | number input | min 0, step any |
  | `Tour type` | select | options `Not set` (''), then Self-guided / Landlord-led / PM team (values `self_guided`, `landlord_led`, `pm_team`) |
  | `Tour process` | textarea | rows 2 |

- Roles: checkbox; textbox (inputs and textareas); spinbutton (the
  amounts); combobox (the select).
- Coupling (D1, D10):
  - Checking `One month's rent` reports `deposit_one_month: true` and
    `deposit: ''` in ONE change. `Fixed amount` is disabled while it is
    checked. Unchecking reports `deposit_one_month: false` and leaves the
    amount blank.
  - `No application fee` is derived from the value (`isNoApplicationFee`).
    Checking it reports `application_fee: '0'` and disables the amount;
    unchecking reports `''`.
  - `disabled` disables every control.

### `dashboard/src/routes/orgs/OrgPicker.tsx` (optional props, AR29)

- `labelAside?: React.ReactNode` (`:78`): when given, the `<label>` and the
  aside sit in `div.labelRow` (`OrgPicker.module.css:20`), the aside
  OUTSIDE the label (`:368-379`).
- `describedBy?: string` (`:81`): appended LAST to the combobox's
  aria-describedby, after the hint, pending-note and error ids (`:314-317`).
- Without either prop, the markup is unchanged.

### `dashboard/src/routes/contact/ContactSearchField.tsx` (optional prop, C8)

- `describedBy?: string` (`:71`) -> the input's `aria-describedby`
  (`:254`).
- The accessible name stays `inputLabel` (aria-label). Without the prop
  the attribute is absent.

## For later units and the orchestrator

- U10 (Tasks 5.8, 5.9):
  - Pass the picker `splitVoucherSizes(unit.voucher_size_accepted)` and PATCH
    `voucherSizesPatchValue(raw, current)`, both from `requirementForm.ts`.
  - The Housing authorities description becomes `<hint> On flyer`, because
    the tag id comes after OrgPicker's own ids (AR29; the two exact pins in
    5.8 and 5.9).
  - The money inputs already carry `step="any"` / `min={0}`, pinned at the
    component level (M7 follow-up); 5.8 and 5.9 still add their own
    form-level cents cases (PR2-3).
  - RequirementsFields' group legends (`Pets`, `Deposit`, `Touring`, ...)
    do NOT match `getByLabelText`, but they ARE `getByRole('group', { name })`
    targets.
- U11, U12 (S6):
  - The landlord form passes `audience="landlord"`. The public note under
    Pets (details) / Pet fee shows on both audiences, as plan 1.1 wants.
  - OR-21: the edit dialogs now hold groups named `Screening`, `Pets`,
    `Move-in costs`, `Touring`, `Evictions`, `Deposit`. Scope any
    `getByRole('group', { name })` to its card or dialog.
  - The property page's "Voucher sizes accepted" row uses its own format
    without the `Accepts: ` prefix; `acceptsSummary` is the picker's
    (AR39).
- U13 (S7):
  - In Playwright, `getByRole` names are SUBSTRING matches by default. A
    chip selector like `group.getByRole('button', { name: '2' })` would
    also hit `12` once the large chips are open, and `'1'` hits
    `10`/`11`/`12`. Use `{ exact: true }`.
  - `getByLabel('Voucher sizes accepted')` resolves to the group div
    (aria-labelledby), which cannot be filled. Click chips in
    `getByRole('group', { name: 'Voucher sizes accepted' })`.
  - `More sizes (5-12)` sits outside that group.
- Not run, per the brief: the full `npm test`, any Playwright e2e.
