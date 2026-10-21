# FW2 (dashboard) - code review fix wave 2, dashboard side: R2D-1 (OR-32), R2D-3, R2D-4 (OR-33), R2D-5, R2D-6, R2D-7, R2D-8, R2D-9, R2D-13

- Unit: FW2, implementer model Claude Opus 5.5.
- Branch `feat/property-requirements`, worktree `W:/tmp/property-requirements`,
  started at `e29ab690` (the round 2 adjudications commit).
- Work list (binding): `code-review/adjudications.md`, Round 2, the rows marked
  FW2, with rulings OR-32 and OR-33 (amending OR-17 and the RD-9 ruling).
  Findings and proofs: `code-review/R2-dashboard.md`.
- STOP items: none. Every edit sits in a file the brief names or in its test /
  CSS module; `e2e/support/selectors.md` is the only e2e file touched (no spec).

## Per finding

| Finding | Result | Commit |
|---|---|---|
| R2D-1 via OR-32 - a row staff unchecked came back checked after a preserving re-read | FIXED (pure helper + dialog carry) | `5dcbaef0` |
| R2D-3 - a later batch's deposit_conflict dropped D8's stop sentence | FIXED (both sentences, one alert) | `696e63fb` |
| R2D-13 - the deposit notice said "press Update again" | FIXED (copy as ruled) | `8fc45f8a` |
| R2D-4 via OR-33 - one landlord, two names (company vs phone) | FIXED (one shared expression with the header) | `63d9562c` |
| R2D-5 - "No application fee" derived from the amount text | FIXED (its own form flag) | `1d357edd` |
| R2D-6 - the New form's D7 lines inserted already filled | FIXED (one always-mounted region) | `f3d5dd31` |
| R2D-7 - Try again replaced what staff typed | FIXED (fills only blank items) | `95b6acea` |
| R2D-8 - "Fits a 8-bedroom voucher" | FIXED ("an" before 8 / 11) | `508f34fa` |
| R2D-9 - three RD-4 resets unpinned | TESTS ADDED (each killed by its mutant) | `b5b97a70` |

### R2D-1 via OR-32 - the rows staff unchecked survive a preserving re-read

- Helper: `dashboard/src/routes/contact/applyRequirementsModel.ts:127`
  `carryHandUnchecks(previous, rows)`. It keeps a hand uncheck (`false`) for a
  row the re-read still lists and that is not "Already matches"; hand checks
  are dropped (the row goes back to its starting state, staff confirm it
  again). `carryCheckedItems`' doc (`:58`) points to it.
- Dialog: `ApplyRequirementsDialog.tsx`.
  - `:100` `ApplyCarry` = the left column AND the row hand choices.
  - `:143` `carryRef` holds it; `:237` the catch builds it once (`goesOn`) for
    the three preserving branches (deposit_conflict, a later batch, a
    first-request non-409 failure). A first-request 409
    requirements_changed still sets null (full reset).
  - `:164`-`:173` the next SUCCESSFUL read computes the re-read rows
    (`listed`, the carried items) and applies `carryHandUnchecks` to them;
    nothing carried = `new Map()` as before.
  - The `hand` captured is the click-time state; every control is disabled
    while sending, so it cannot change mid-run.
  - Header comment (`:24`-`:35`) states OR-17 + OR-32.
- Tests:
  - `applyRequirementsModel.test.ts:185`, 4 cases: an uncheck stays; a hand
    check is dropped; an uncheck is dropped for a row no longer listed or now
    Already matches; nothing chosen carries nothing.
  - `ApplyRequirementsDialog.test.tsx:563`, 5 cases:
    - the R2D-1 scenario after a first request fails: "2 Many St" stays
      unchecked, the button reads "Update 2 properties", the next request's
      units are `['u0', 'u2']`;
    - the same after a 409 deposit_conflict;
    - after a mid-run stop (150 rows): still unchecked, "Update 149
      properties";
    - PIN: a row checked by hand goes back to unchecked;
    - PIN: a first-request 409 requirements_changed re-checks it ("Update 3
      properties").
- RED: 7 failed / 52 (model x4 "carryHandUnchecks is not a function"; dialog
  x3 "Received element is checked" on "2 Many St"). The two PINs were green on
  the old code. GREEN: 52/52; typecheck 0; eslint 0.

### R2D-3 - a later batch keeps the stop sentence

- `ApplyRequirementsDialog.tsx:122`: the notice is a list of sentences
  (`[]` = none). `:240` computes D8's stop sentence for a later batch;
  `:246` the deposit_conflict branch shows it FIRST, then the deposit
  sentence; the first batch shows the deposit sentence alone. Every other
  notice is one sentence, as before.
- Render (`:292`): ONE `<div role="alert">` (the `.notice` box), one `<p>` per
  sentence. CSS `ApplyRequirementsDialog.module.css:17`, `:21` (paragraph
  spacing). Header comment (`:17`-`:21`) updated.
- Tests: `ApplyRequirementsDialog.test.tsx:505` (it pinned the stop
  sentence's absence; now both sentences, the stop sentence first, in the same
  alert); `:480` the first batch shows the deposit sentence alone. The two
  `toHaveAttribute('role', 'alert')` checks became `closest('[role="alert"]')`
  (the role moved to the container).
- RED: 1 failed / 29 (the stop sentence not found). GREEN: dialog + model +
  ContactDetail 197/197.

### R2D-13 - the deposit sentence

- `applyRequirementsModel.ts:238` `DEPOSIT_CONFLICT_NOTICE` is exactly the
  ruled sentence (`This landlord's deposit is set to both one month's rent and
  a fixed amount. Close this, fix it with Edit requirements, then open Apply
  to properties again.`); the doc comment says why.
- Tests: the model's copy test pins the constant; the dialog's
  `DEPOSIT_CONFLICT` constant reads it.
- RED: 4 failed / 52. GREEN: 52/52.
- e2e: `selectors.md` row 136 quoted the old sentence; it now quotes the new
  one and says the notice is one alert block with one paragraph per sentence.

### R2D-4 via OR-33 - one landlord name rule = the header's name

- `dashboard/src/routes/contact/format.ts:156` new `contactHeaderName(contact)`:
  first + last (trimmed), else the default phone (`defaultPhone(contactPhones)`:
  the primary of phones[], else the most recent, else the first, before the
  legacy phone), else "Unknown contact". `:167` `landlordDisplayName` returns
  it - no company step.
- `ContactDetail.tsx:665` the header calls `contactHeaderName(contact)`
  (import `:90`), so the header and the landlord name rule share ONE
  expression. `phones` / `target` stay for their other uses.
- Caller comments updated: `PropertyRequirementsCard.tsx:46`,
  `UnitCreateForm.tsx:85-87`, `:382-383`.
- Tests:
  - `format.test.ts:150` no company step; `:156` equals `contactHeaderName`
    for six contact shapes (incl. a no-primary phones[] list -> the most
    recent); the "Unknown contact" case now includes a company-only,
    phoneless landlord; `:200` `contactHeaderName` itself.
  - `PropertyRequirementsCard.test.tsx:114`: the company-only landlord now
    has a primary phone and reads `(404) 555-0123`.
  - `UnitCreateForm.test.tsx`: `KIM_REALTY` gained a primary phone; the
    loading / note / failure cases read `(404) 555-0123`; `:948` the R2D-4
    picker scenario (owner field and note both `(404) 555-0123`, no
    "Kim Realty").
- RED: 8 failed / 110. GREEN: format + card + New form + ContactDetail +
  contactPhones 262/262; typecheck 0.
- e2e: `selectors.md` row 134 described `<L>` with the company step; it now
  says the header's name. The e2e landlords have a first and last name
  (`property-requirements.spec.ts:89-96`), so no spec changes.

### R2D-5 - "No application fee" is its own form flag

- `dashboard/src/routes/listing/requirementForm.ts`:
  - `:76` `NO_APPLICATION_FEE_FLAG = 'form:no_application_fee'`, a form-only
    key kept in the values. The builders iterate `REQUIREMENT_FIELDS`, so it
    is never sent (not in the create fields, the edit patch or the landlord
    patch).
  - `:82` `noApplicationFeeChecked(values)`: the flag once set, else the
    stored / prefilled value (a recorded 0). The starting values
    (`emptyRequirementFormValues`, `requirementFormValuesFromUnit` /
    `...FromLandlord`) never carry the flag, so their shape and every existing
    test are unchanged; a stored or landlord-prefilled 0 starts checked.
  - `:90` `recordedText`: what a field records - checked = 0, unchecked =
    the typed amount (blank = none). `buildRequirementPatch` compares and
    sends it (`:114`), `buildRequirementCreateFields` sends it (`:141`).
- `RequirementsFields.tsx`: `:56` the checkbox state and the amount's
  `disabled` read `noApplicationFeeChecked`; `:89` the checkbox sets the flag
  (and 0 / blank as before); `:111` an amount edit PINS the flag as it stands,
  so the typed text never decides it.
- Tests:
  - component `RequirementsFields.test.tsx:152` ("0.50" typed: enabled,
    unticked, 0.5, flag false), `:166` (the 4 of 40 deleted: an editable 0,
    unticked, typing goes on), `:181` (only the checkbox sets the flag);
  - pure `requirementForm.test.ts:78` (the helper), the "not a unit key"
    case, `:156` five builder cases (typed 0 = 0, typed 0.50 = 0.5, checked =
    0 whatever the box holds, unchecked stored 0 = null, re-ticked or retyped
    0 = nothing, the New form's three cases, the landlord patch);
  - the three send paths, each body exact (no flag key):
    `ListingEditForm.test.tsx:788` (`{ application_fee: 0 }`), `:801`
    (`{ application_fee: 0.5 }`); `UnitCreateForm.test.tsx:838`
    (`application_fee: 0.5` + the blank snapshot);
    `ContactEditForm.test.tsx:1511` (`{ req_application_fee: 0 }`).
- RED: 10 failed / 331 (the box disabled or ticked mid-typing on the
  component and all three forms; the helpers missing). GREEN: 331/331;
  typecheck 0; eslint 0.
- e2e: the spec's prefilled-0 assertion
  (`property-requirements.spec.ts:255-256`, checked + amount disabled) holds
  unchanged; no e2e text changed.

### R2D-6 - one always-mounted status region for the D7 lines

- `UnitCreateForm.tsx:386` `readStatus` (the bound loading / failure copy,
  '' once the read lands); `:741` a `.sectionHead` wrapper holds the
  Requirements heading and, on the locked path (`:750`), ONE `<p
  role="status">` (`:752`) mounted from the first render whose TEXT changes;
  Try again renders beside it while the read has failed. The fields render
  below once the read is not loading (unchanged).
- CSS `ListingEditForm.module.css:131` `.sectionHead` (column, no gap, so the
  empty region takes no space), `:138` `.sectionStatus` (the line while it has
  text: the old `.loadFailed` row plus the gap it had); `.loadFailed` is
  retired (its only user was this form).
- Test `UnitCreateForm.test.tsx:763`: the loading element IS the failure
  element, then shows loading again on Try again, then stays connected and
  empty after the read lands; Try again is gone.
- RED: 1 failed / 79 (the failure line was a new element). GREEN: 79/79.
- e2e: `selectors.md` row 134 notes the region is always mounted (assert
  text). No spec reads it.

### R2D-7 - Try again fills only what staff left blank

- `requirementForm.ts:178` `fillBlankRequirementItems(current, landlord)`:
  an ITEM is filled from the landlord only when every field of it is blank
  (`:163`: an unticked box, empty / whitespace text, and for the fee "No
  application fee" unticked); every item staff typed into keeps what they
  typed. Filling the fee item also sets the flag from the landlord value.
- `UnitCreateForm.tsx:241` the locked read merges through it. On the first
  read every item is blank, so the section is the landlord's values as
  before; `filled.snapshot` (the landlord's values) is what Create sends
  (D5). The picker path keeps D7's full refill for a DIFFERENT landlord.
- Tests: `requirementForm.test.ts:247` (5 cases); `UnitCreateForm.test.tsx:706`
  (type Credit score and Income requirements after the failure, Try again:
  both keep what was typed, No pets / Pets (details) / No application fee are
  filled, Create sends the typed values with ROSA's snapshot) and `:740` (a
  typed fixed amount keeps One month's rent unticked, Create sends `deposit:
  1400` and no `deposit_one_month`).
- RED: 7 failed / 116 ("650 minimum" became "600+"; the typed 1400 was gone;
  the helper missing). GREEN: 116/116.

### R2D-8 - "an" before 8 and 11 on the flyer

- `dashboard/src/routes/public/FlyerPage.tsx:78` `voucherArticle(phrase)`:
  "an" when the phrase starts with 8 or 11 (not followed by a digit), else
  "a"; `:315` the line reads `Fits <article> <phrase> voucher`.
- Table `FlyerPage.test.tsx:413`: `[8]`, `[11]`, `[8, 9]`, `[11, 12]`,
  `[8, 10, 12]` ("an"); `[1, 8]`, `[0, 11]`, `[10]`, `[12]` ("a", PINs).
- RED: 5 failed / 51. GREEN: 51/51.
- Lint: FlyerPage.tsx carries 2 pre-existing `react-hooks/set-state-in-effect`
  errors; per-rule count now 2 (`:185`, `:203`) = 2 at `1d7a4667` (`:142`,
  `:160`); nothing new.
- e2e: `selectors.md` row 137 notes the "an" case. No spec meets 8 or 11
  (`public-pages.spec.ts` uses beds 2 and 3).

### R2D-9 - the three tenant-page resets pinned (tests only)

- `ContactDetail.test.tsx:3381`, a tenant-to-tenant harness (k1 -> z99 -> k1):
  - it.each over "New placement" and "Schedule a tour": left open on k1, not
    open on z99's page, not re-opened on coming back;
  - k1's Interested on "1450 Joseph Blvd" opens the tour form there; on z99
    (its Properties sent loaded) "Schedule a tour" pre-commits z99's own
    latest send "88 Sycamore St".
- Green on the fixed code by design (3/3). RED by mutation, each reset line
  of `ContactDetail.tsx:366-368` commented out alone, then reverted:
  `setStartingPlacement` -> 1 failed / 3 (the placement row);
  `setSchedulingTour` -> 2 failed / 3 (the tour row and the override case);
  `setTourUnitOverride` -> 1 failed / 3 (received "1450 Joseph Blvd", k1's
  property, on z99). Source diff clean afterwards (`git diff --exit-code`).
- GREEN: ContactDetail 148/148.

## e2e text touched

- Only `e2e/support/selectors.md` (rows 134, 136, 137): the `<L>` rule
  (OR-33) and the New form's always-mounted status region; the new deposit
  sentence (R2D-13) and the one-alert-block notice (R2D-3); the flyer's "an"
  case (R2D-8).
- Grepped `e2e/` for every changed copy and selector: the deposit sentence
  (only selectors.md), the landlord name lines (`Filled in from` only at
  `property-requirements.spec.ts:168`, first + last names), the flyer voucher
  line (`public-pages.spec.ts:221`, `:394`, `:409` with 2 / 3, and
  `property-requirements.spec.ts:387` "2- or 3-"), "No application fee"
  (`contact-detail.spec.ts:180` label count, `property-requirements.spec.ts:255`
  prefilled 0 checked, `:386` flyer text). None asserts the old behavior, so
  no spec or `scenarios/steps.ts` change.

## Commits

| Hash | Subject |
|---|---|
| `5dcbaef0` | fix(dashboard): Apply to properties keeps the rows staff unchecked across a preserving re-read (code review R2D-1, OR-32) |
| `696e63fb` | fix(dashboard): a later batch's deposit_conflict keeps D8's stop sentence before the deposit sentence (code review R2D-3) |
| `8fc45f8a` | fix(dashboard): the deposit_conflict notice says to close the dialog before Edit requirements (code review R2D-13) |
| `63d9562c` | fix(dashboard): the landlord name rule is the contact page header's name - no company step (code review R2D-4, OR-33) |
| `1d357edd` | fix(dashboard): "No application fee" is its own form flag, never read off the amount text (code review R2D-5) |
| `f3d5dd31` | fix(dashboard): the New property form's D7 status lines share one always-mounted live region (code review R2D-6) |
| `95b6acea` | fix(dashboard): Try again on the New property form fills in only what staff left blank (code review R2D-7) |
| `508f34fa` | fix(dashboard): the public flyer's voucher line says "an" before 8 and 11 (code review R2D-8) |
| `b5b97a70` | test(dashboard): pin the three tenant-page resets of the contact-change effect (code review R2D-9) |
| (this file) | docs(records): FW2 dashboard report |

No mutant survived, so there is no follow-up commit.

## GREEN runs

| When | Scope | Result |
|---|---|---|
| Baseline (`e29ab690`) | `src/routes/contact src/routes/listing src/routes/public src/routes/listings src/api` | 120 files, 2663/2663 |
| Per finding | the finding's suites (above) | all green |
| After the nine items | the same five folders | 120 files, 2709/2709 (+46 = exactly the new cases: 9 + 3 + 14 + 1 + 7 + 9 + 3) |
| After the nine items | the WHOLE dashboard suite (`cd dashboard && npx vitest run`) | 263 files, 5336/5336, exit 0, 61.2 s (FW1b's 5290 + 46) |
| After the mutant reverts | the 11 mutated / covering suites | 623/623 |
| Every item + final | root `npm run typecheck` (all workspaces) | exit 0 |
| Final | `npx eslint` on the 20 touched `.ts/.tsx` (`git diff --name-only --diff-filter=d e29ab690...HEAD`) | exit 1 = only FlyerPage.tsx's 2 pre-existing `react-hooks/set-state-in-effect` (same count at `1d7a4667`); every other file clean |

- ASCII: the added lines of the whole wave (`git diff -U0 e29ab690..HEAD`)
  print 0 on the `tr` check; no literal backslash-u added.
- Not run, per the brief: the full `npm test` and any Playwright e2e.

## Mutant table

Ten one-line mutants over items 1-8, applied and reverted with the Edit tool
one at a time; `git diff -U0` showed exactly the one mutant before each run.
Afterwards `git status --short` and `git diff --stat` were empty and
`git diff --exit-code HEAD` on the eight mutated files exited 0.

| # | Mutant | file:line | Test run (failed / total) | Result | Follow-up |
|---|---|---|---|---|---|
| M1 | the "Already matches" release dropped from `carryHandUnchecks` | `applyRequirementsModel.ts:130` | model + dialog 1/52 | KILLED | - |
| M2 | the dialog's read resets the rows even with a carry (`new Map()`) | `ApplyRequirementsDialog.tsx:173` | dialog 3/29 | KILLED | - |
| M3 | later batch: the deposit sentence BEFORE the stop sentence | `ApplyRequirementsDialog.tsx:246` | dialog 1/29 | KILLED | - |
| M4 | `landlordDisplayName` puts a nameless contact's company first again | `format.ts:168` | format + card + New form 7 failed | KILLED | - |
| M5 | an amount edit no longer pins the fee flag | `RequirementsFields.tsx:111` | fields + three forms 5/304 | KILLED | - |
| M6 | `noApplicationFeeChecked` ignores the flag (reads the text) | `requirementForm.ts:84` | requirementForm + fields 7/79 | KILLED | - |
| M7 | `recordedText` sends the typed text while the box is checked | `requirementForm.ts:91` | requirementForm 2/35 | KILLED | - |
| M8 | the New form's status region mounted only while it has text | `UnitCreateForm.tsx:750` | New form 1/81 | KILLED | - |
| M9 | the fill takes an item when ANY field is blank (`every` -> `some`) | `requirementForm.ts:184` | requirementForm + New form 4/116 | KILLED | - |
| M10 | the flyer article drops the 11 case | `FlyerPage.tsx:79` | flyer 2/51 | KILLED | - |

Notes:
- M5: the New form's own "0.50" case does not fail under M5 alone - the
  locked read's fill writes the fee flag explicitly (R2D-7's merge), so the
  pin is redundant there; the component and the Edit and landlord forms kill
  it. The picker path's values carry no flag, so the pin matters there too.
- Considered and not run: dropping the `(?!\d)` lookahead in
  `voucherArticle` is equivalent within D4's 0..12 (no phrase starts with
  80+ or 110+); the requirements_changed branch carrying (`null` ->
  `goesOn`) is pinned by two committed cases (OR-17's left column and the
  OR-32 "still resets every row" case).

## Divergences and interpretations (each deliberate)

1. OR-32: the uncheck carry is computed on the RE-READ rows with the carried
   left column, and drops an uncheck whose row is gone or is now "Already
   matches" (D8's hand rule: an uncheck holds "unless it becomes Already
   matches") - so a released row starts from its starting state if a later
   left-column change gives it changes again.
2. R2D-3: the notice became a list rendered as ONE `role="alert"` block with
   a paragraph per sentence (it was one `<p role="alert">`). Single-sentence
   notices keep their text; their role is now on the container.
3. R2D-5: the flag is "derived until set" rather than written by the value
   builders: the starting values never carry it (so `emptyRequirementFormValues`
   still holds exactly the 15 unit keys and every existing test's values mean
   what they did), it starts checked for a stored / prefilled 0, and after
   that only the checkbox changes it (an amount edit pins it as it stands).
   Checking still shows 0 in the disabled box and unchecking still clears it
   (D10, unchanged). A typed 0 saved as an amount reads back as "No
   application fee" on the next open - D1 stores one 0.
4. R2D-6: the region is mounted on the locked path only (the picker path
   reads nothing, so it has no lines). Both lines use the one `role="status"`
   region (the brief allowed `alert` for the failure; one region keeps the
   text-change semantics).
5. R2D-7: the fill is ITEM-level, not field-level (D1: an item is copied
   whole). A field-level fill would tick the landlord's One month's rent
   beside a typed fixed amount - the amount box then disables and Create drops
   the typed amount silently (`buildRequirementCreateFields` skips the amount
   under One month's rent); pinned by `UnitCreateForm.test.tsx:740`. Blank
   fields inside an item staff typed into stay blank.
6. R2D-8: exactly the brief's rule (a phrase starting with 8 or 11). A legacy
   stored size of 18 (outside D4's 0..12) would still read "a 18-".
7. Test isolation (R2D-6 test): the second `getContact` value is queued only
   right before Try again. `vi.clearAllMocks()` keeps a queued
   `mockReturnValueOnce`, so my first RED run, failing before Try again,
   leaked it into the next test (fixed before any commit).

## CONTRACT (what later work relies on)

- New exports:
  - `carryHandUnchecks(previous: HandChoices, rows: readonly ApplyRow[]): Map<string, boolean>`
    (`applyRequirementsModel.ts:127`);
  - `contactHeaderName(contact: Contact): string` (`format.ts:156`) - the
    contact page header's name; `landlordDisplayName` returns it;
  - `NO_APPLICATION_FEE_FLAG` (`'form:no_application_fee'`,
    `requirementForm.ts:76`), `noApplicationFeeChecked(values): boolean`
    (`:82`), `fillBlankRequirementItems(current, landlord): RequirementFormValues`
    (`:178`).
- Changed copy: `DEPOSIT_CONFLICT_NOTICE` (`applyRequirementsModel.ts:238`) is
  the R2D-13 sentence; the flyer reads `Fits an 8-...` / `Fits an 11-...`.
- Apply dialog: the notice is one `role="alert"` block, one paragraph per
  sentence; a later batch's deposit_conflict shows the stop sentence, then the
  deposit sentence. A preserving re-read keeps the left column (OR-17) AND the
  rows staff unchecked (OR-32).
- `landlordDisplayName` has no company step: a company-only landlord reads as
  its default phone, or "Unknown contact" with no phone (as the header does).
- `RequirementFormValues` may carry the form-only flag key once the fee
  controls were used; it is never sent. Read the checkbox state with
  `noApplicationFeeChecked`, never `isNoApplicationFee`.
- New property form, locked path: one `<p role="status">` under the
  Requirements heading (`UnitCreateForm.tsx:752`) is always mounted - assert
  its text, never its presence; Try again sits beside it while the read has
  failed. A successful read fills only blank items.

## For the orchestrator and Cameron

- Copy for Cameron's eye:
  - R2D-13's deposit sentence (the ruled text);
  - R2D-8's "an" on the PUBLIC flyer (tenant-facing);
  - on a later batch's deposit_conflict the two bound sentences sit
    together: D8's "... Review the rest and press Update again." then
    "Close this, fix it with Edit requirements, then open Apply to properties
    again." The second is the operative one; a merged wording for that case
    would be a copy change (not made).
- OR-33 consequences:
  - a company-only landlord with no phone now reads "Unknown contact has no
    requirements recorded yet." on the property card and "Loading Unknown
    contact's requirements..." in the New form - the same name the landlord
    page header shows. Company-first naming stays the separate product change
    OR-33 names.
  - Residual: the New form's picker (`ContactSearchField.tsx:82-83`, `:213`,
    a shared component) takes the primary phone, else the LEGACY phone; the
    header rule takes the primary, else the most recent / first of phones[],
    before the legacy phone. They differ only for a phones[] list with no
    primary (the dev zero-primary fixture shape). Not changed - outside the
    brief and shared by the placement and tour forms.
- Gates still owed on the final commit (not run here, per the brief): the
  full `npm test`, `npm run smoke`, `npm run e2e`, and gate 5 on the whole
  branch.
