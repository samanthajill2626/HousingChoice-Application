# FW1b (dashboard) - code review fix wave 1, dashboard side: RD-1 (OR-31), RD-2, RD-4, RD-5, RD-6, RD-7, RD-8, RD-9, RD-10, RD-12, RC-11, O-1

- Unit: FW1b, implementer model Claude Opus 5.5.
- Branch `feat/property-requirements`, worktree `W:/tmp/property-requirements`,
  started at `2aa30812` (the FW1a report commit).
- Work list (binding): `code-review/adjudications.md`, the rows marked FW1b.
  Findings and proofs: `code-review/R1-adversarial-dashboard.md` (RD-*) and
  `code-review/R1-conformance.md` (RC-11); O-1 is the orchestrator's row.
- STOP items: none. One support edit sits outside the files the brief names:
  `contactPhones.ts`'s type-only import path (RD-9 below). It changes no
  runtime code and was needed to keep the e2e typecheck green.

## Per finding

| Finding | Result | Commit |
|---|---|---|
| RD-1 via OR-31 - Apply dead-ended on 409 deposit_conflict; the deposit value hid the amount | FIXED (dialog + formatItemValue) | `5da7a721`, follow-up `a0ca6ff2` |
| RD-2 + RD-6 - requirement money rounded to whole dollars; requirements.ts <-> listingFormat.ts cycle | FIXED | `bcdf8e58` |
| RD-4 - New property / Edit (and the other per-contact dialogs) survived a contact change | FIXED | `b1430f24`, follow-up `a0ca6ff2` |
| RD-5 - tour card empty state said no process is recorded | FIXED (copy) | `c3f6d323` |
| RD-7 - Apply result in a live region mounted already filled | FIXED | `9f6e5db7` |
| RD-8 - "Clears" under AA contrast | FIXED | `468649a8` |
| RD-9 - company-only / phones[]-only landlord read "Unknown contact" | FIXED (one shared rule) | `b41ff078` |
| RD-10 - Apply keeps posting after unmount | COMMENT (ruled as intended) | `9298e206` |
| RD-12 - stale `UnitActivityEvent.reason` doc | COMMENT | `24d0e53b` |
| RC-11 - no flyer case with a studio inside three sizes | TEST ADDED (PIN) | `88251c90` |
| O-1 - Deposit it.each titles printed `reads "undefined"` | FIXED (titles) | `58aa89d8` |
| e2e selector doc for the changed surfaces | CLARIFIED | `64722b16` |

### RD-1 via OR-31 - the both-forms deposit

- Dialog: `dashboard/src/routes/contact/ApplyRequirementsDialog.tsx:220-225`.
  - The catch's FIRST branch tests `ApiError` 409 `deposit_conflict`, before
    the `index > 0` branch, so it fires on ANY batch, first or later.
  - It sets `DEPOSIT_CONFLICT_NOTICE` and carries the left column
    (`carryRef = checkedItems`, OR-17's rule for failures, unchanged).
  - It then takes the existing `reload()` + `return`, so no further batch is
    sent.
  - The notice renders in the dialog's existing `<p role="alert">`. The header
    comment (`:15-21`) says the same.
- Copy: `applyRequirementsModel.ts:217` `DEPOSIT_CONFLICT_NOTICE`, the ruled
  sentence byte for byte, beside the other copy constants.
- Value: `dashboard/src/routes/listing/requirements.ts:380`.
  `formatItemValue('deposit')` lost its `else`. A record holding both forms
  reads `One month's rent; $1,400`, then `flexible`, then the notes. A single
  form reads as before. The doc comment (`:333-341`) says so.
- Tests:
  - `ApplyRequirementsDialog.test.tsx:478`, a first request (150 rows):
    - the left column's Deposit description is `One month's rent; $1,400`;
    - the sentence is shown with role alert, and the generic sentence is not;
    - getContact and getAllUnits each ran twice (the re-read);
    - one apply call (no second batch), and no onDone.
  - `:498`, a later batch (250 rows; batch 1 lands, batch 2 answers 409):
    - the sentence, and no "before this stopped" notice;
    - 2 apply calls, the re-read, and no onDone;
    - the re-read landlord's Deposit shows both forms.
  - `:524`, the mutant M1 follow-up: the carry survives a deposit_conflict.
  - `requirements.display.test.ts:202`: formatItemValue with both forms, with
    and without flexible and notes.
- RED and GREEN runs:
  - RED: 3 failed / 40. formatItemValue returned `"One month's rent"`; the
    first dialog case failed on the description; the later-batch case could
    not find the sentence.
  - With only the display half applied, both dialog cases failed on the
    missing sentence alone (2 failed / 40).
  - GREEN: 5 files, 69/69 (dialog 22, display 18, model 19, landlord card 5,
    property card 5).
- For Cameron: on a LATER batch the notice is exactly the ruled sentence, so
  the landed count ("Updated N properties before this stopped") is not shown.
  The re-read shows the true state; this is the same trade as RD-3 (filed).

### RD-2 + RD-6 - requirement money keeps cents; no listingFormat import

- `requirements.ts:328` adds `formatRequirementMoney(amount)`:
  - `$` plus en-US grouping;
  - no fraction digits for a whole amount (`$1,400`), exactly 2 otherwise
    (`$1,250.40`, `$35.75`).
- `formatItemValue`'s `money()` (`:353`) uses it. That covers the deposit
  amount and the application fee, the only requirement money the module
  formats (the pet fee is text).
- `requirements.ts:27-28`: the `./listingFormat.js` import is gone, with a
  comment saying why.
  - The cycle is broken. `listingFormat.ts:13` still imports
    `WASHER_DRYER_LABELS` (AR39).
  - U11's "keep cross-module uses inside function bodies" caveat no longer
    applies.
- The flyer's formatter is untouched (`FlyerPage.tsx` not edited, plan 1.1).
- Tests:
  - `requirements.display.test.ts:215`, 3 cases:
    - whole and cents amounts;
    - formatItemValue with deposit 1250.4, fee 35.75, and a whole
      `$1,400; flexible`;
    - the RD-2 proof inverted: `requirementDisplay` reads
      `Landlord: $1,250.40`.
  - `:247`, the RD-6 guard: reads `requirements.ts` beside the test and finds
    no quoted `./listingFormat` specifier.
- RED: 4 failed / 22 (`formatRequirementMoney is not a function`; `$1,250`;
  the tagged line; the import found).
- GREEN: listing, public and two contact suites, 33 files, 795/795.

### RD-4 - every per-contact dialog closes on a contact change

- `ContactDetail.tsx:359-371`: the existing contactId reset effect now also
  clears these flags. The OR-18 reset already covered `converting`,
  `haReview` and `applyingFor` / `applyDone`; together that is every
  per-contact dialog flag the page holds.
  - `editing`, `managingPhones`, `creatingRelayGroup`;
  - `startingPlacement`, `schedulingTour` and its `tourUnitOverride`;
  - `addingProperty`, `confirmingDelete` and its `deleteError`.
- The in-flight flags (`optOutBusy`, `voiceOptOutBusy`, `triaging`,
  `deleteBusy`) are request state, not dialogs, and were left alone.
- The existing `react-hooks/set-state-in-effect` disable (`:326`) still covers
  the effect; lint is clean.
- Tests, `ContactDetail.test.tsx:3278` (its own nav harness, OR-18's pattern):
  - it.each `:3328` over `New property`, `Edit contact`, `Manage numbers`,
    `Create a relay group` (follow-up M7) and `Delete contact?`:
    - each is opened on L1;
    - after NAV-TO-OTHER it is not open on z99's page;
    - after NAV-TO-LANDLORD it is not open;
    - `deleteContact` was never called.
  - `:3353` (follow-up M6): a failed Delete's error never shows in the next
    contact's Delete dialog.
- RED: 4 of 4 failed on the "not open on the other contact's page"
  assertion (`:3333` then, `:3341` in the final tree): each dialog re-mounted
  bound to z99.
- GREEN: ContactDetail 143/143; the contact folder 78 files, 1715/1715.

### RD-5 - the tour card's empty state

- `ListingDetail.tsx:1053` reads `No application process recorded yet.`. The
  title and the Edit label are unchanged (spec D10). Retitling the card is
  still open for Cameron.
- `ListingDetail.test.tsx:343` was the branch's own pin. It now asserts the
  new sentence and that the old one is absent.
- RED: 1 failed ("Unable to find"). GREEN: 134/134.
- e2e: neither sentence appears anywhere in `e2e/` (grep), which confirms R5.

### RD-7 - an always-mounted status region

- `LandlordRequirementsCard.tsx:67` keeps one `<div role="status">` always
  mounted.
  - The result block (class `notice`) renders inside it only when there is a
    result.
  - The empty region has no class, so it draws no box and takes no space.
- `LandlordRequirementsCard.test.tsx:93`:
  - the region is empty before a result;
  - the result lands in the SAME element;
  - after clearing, the same element is empty again.
- Every existing role and text assertion is unchanged and green, with one
  adaptation. The OR-18 case "a finished Apply result does not show again"
  asserted `queryByRole('status')` null; it now asserts that region is empty,
  because the region always exists by design.
- RED: 1 failed / 6 (no status role). GREEN: card 6 + ContactDetail 143 +
  files 55 = 204/204.
- Residual, PLAUSIBLE and AT-specific: the Modal is `aria-modal`, and the
  result arrives in the same commit that closes it.

### RD-8 - "Clears" contrast

- `ApplyRequirementsDialog.module.css:105-108`: `.clears` uses
  `var(--c-evt-amber-text)`. The shared `--c-warning` token is untouched.
- `ApplyRequirementsDialog.test.tsx:157` is a source-text check of the
  `.clears` rule (the PeopleCard.test.tsx precedent; jsdom computes no CSS).
- RED: 1 failed. GREEN: 23/23.

### RD-9 - one landlord name rule

- No existing helper did name, then company, then phone. The contact page
  header calls `contactDisplayName(first, last, defaultPhone(contactPhones(contact))?.phone)`
  (`ContactDetail.tsx:660-662`), which has no company step.
- New `landlordDisplayName(contact)` at `dashboard/src/routes/contact/format.ts:158`,
  in this order:
  1. the trimmed first + last name;
  2. else the trimmed company;
  3. else the default phone, picked exactly as the header picks it (the
     primary of phones[], then the most recent, then the first, then the
     legacy phone), formatted;
  4. else `Unknown contact`.
- Callers:
  - `PropertyRequirementsCard.tsx:48`: the note.
  - `UnitCreateForm.tsx:98`: the "Filled in from" name.
  - `UnitCreateForm.tsx:212`: the locked label. It feeds the locked box and
    the loading and failure lines through `statusName` (`:375`).
  - The form's private `landlordLabel` is gone. It differed from the header
    rule only for a phones[] list with no primary.
- Support edit: `contactPhones.ts:7` now type-imports `Contact` and
  `ContactPhone` from `../../api/types.js` instead of the api barrel.
  - Why: format.ts now imports contactPhones.ts. The e2e workspace compiles
    dashboard's format.ts
    (`e2e/tests/dashboard-next/relay-inbound-caller-identity.spec.ts:12`)
    with no `--jsx`.
  - Through the barrel, tsc reached `api/EventStreamProvider.tsx`, giving
    TS6142 x3 and e2e typecheck exit 2.
  - The import is type-only, so there is no runtime change. format.ts already
    imports `api/types.js`.
- Tests:
  - `format.test.ts:142`: 3 cases (order, phone choice, whitespace).
  - `PropertyRequirementsCard.test.tsx:109`: it.each over a company-only and a
    phones[]-only landlord.
  - `UnitCreateForm.test.tsx:832` (loading line and note) and `:849` (failure
    line), each for both landlords.
- RED: 7 failed / 107 (the helper missing x3; the card x2; the New form's
  company-only cases x2).
  - The New form's phones[]-only cases passed on the old code: they are PINs,
    because its `landlordLabel` already took the primary of phones[]. They
    now help kill M10.
- GREEN: 114/114 (with contactPhones.test).
- For Cameron: the contact page HEADER still shows the phone (or
  `Unknown contact`) for a company-only landlord. Its `contactDisplayName`
  call serves every contact type and was out of scope.

### RD-10, RD-12, RC-11, O-1

- RD-10: the comment at `ApplyRequirementsDialog.tsx:208-213` says an Update,
  once sent, is not cancelled by leaving the page:
  - Cancel is disabled while sending;
  - `liveRef` stops only the UI updates;
  - the requests carry no AbortSignal on purpose.
- RD-12: `dashboard/src/api/types.ts:3390-3400` names both event types the
  projection serves `reason` on:
  - `unit_primary_contact_assigned`;
  - `unit_updated`, only when it is exactly `requirements_applied`.
  - It adds that listing_status_changed's free-text reason is never served.
- RC-11: `FlyerPage.test.tsx:412` adds `[0, 2, 3]` ->
  `Fits a studio, 2-, or 3-bedroom voucher`.
  - It is a PIN (green on unchanged code; the behavior conformed, probe P-C).
  - The verbose reporter prints its title as intended.
- O-1: `FlyerPage.test.tsx:450-465`.
  - Cause: vitest 3.2.6 `formatTitle`
    (`node_modules/@vitest/runner/dist/chunk-hooks.js:952`) runs
    `/\$([$\w.]+)/` over the title AFTER the printf pass. `$1800` reads as an
    array index, which gives `undefined`. No escape survives that pass.
  - Fix: the Deposit table is a for...of loop of plain its with
    template-literal titles (the `TourDetail.test.tsx:917` precedent). The
    cases, inputs and assertions are the same.
  - The verbose reporter shows `Deposit {"deposit":1800} reads "$1800"` and
    `... reads "$1800, flexible / payment plan available"`. No title in the
    file prints `undefined`.

## e2e text touched

- No spec changed. I grepped `e2e/` for everything this wave changed:
  - the tour card sentences: no hit;
  - `has no requirements recorded yet`, `Loading ...requirements`,
    `Couldn't load ...requirements`: no hit;
  - `Filled in from`: only `property-requirements.spec.ts:168`, whose
    landlords have a first and last name, so `<L>` is unchanged;
  - requirement money with cents: none. `steps.ts:114` `formatMoneyLabel`
    mirrors the placement RENT format (formatMoney, unchanged);
    `public-pages.spec.ts:391` reads the flyer's own `$N`;
  - bare `getByRole('status')` on a landlord page: none (every e2e use is
    scoped, filtered by text, or on another page).
- `e2e/support/selectors.md` (`64722b16`): rows 134 and 136 stayed true but
  were incomplete, so they gained:
  - the landlord card's status region is always mounted (assert its text,
    never its presence);
  - the dialog's deposit_conflict notice;
  - `<L>` follows `landlordDisplayName`.

## Commits

| Hash | Subject |
|---|---|
| `5da7a721` | fix(dashboard): Apply to properties names a both-forms deposit on any batch, and the deposit value shows both forms (code review RD-1, OR-31) |
| `bcdf8e58` | fix(dashboard): requirement money keeps its cents, and requirements.ts no longer imports listingFormat (code review RD-2, RD-6) |
| `b1430f24` | fix(dashboard): a contact change closes every per-contact dialog on the contact page, not only Apply (code review RD-4) |
| `c3f6d323` | fix(dashboard): the property page's tour card empty state names the application process only (code review RD-5) |
| `9f6e5db7` | fix(dashboard): the landlord Requirements card's Apply result fills an always-mounted live region (code review RD-7) |
| `468649a8` | fix(dashboard): the Apply dialog's "Clears" mark meets AA text contrast (code review RD-8) |
| `b41ff078` | fix(dashboard): one landlord name rule for the property Requirements card and the New property form lines (code review RD-9) |
| `9298e206` | docs(dashboard): the Apply batching loop says an Update is not cancelled by leaving the page (code review RD-10) |
| `24d0e53b` | docs(dashboard): UnitActivityEvent.reason documents both event types it is served on (code review RD-12) |
| `88251c90` | test(dashboard): flyer wording case for a studio inside three sizes (code review RC-11) |
| `58aa89d8` | test(dashboard): the flyer Deposit cases' titles print their text, not "undefined" (orchestrator note O-1) |
| `a0ca6ff2` | test(dashboard): mutant follow-ups - the deposit_conflict re-read carries the left column; a contact change clears the Delete error and closes Create a relay group (FW1b M1, M6, M7) |
| `64722b16` | docs(e2e): selectors - the landlord card's status region is always mounted, the deposit_conflict notice, and <L> follows the landlord name rule (FW1b RD-1, RD-7, RD-9) |
| (this file) | docs(records): ... FW1b dashboard report |

## GREEN runs

| When | Scope | Result |
|---|---|---|
| Baseline (2aa30812) | `src/routes/contact src/routes/listing src/routes/public src/routes/listings src/api` | 120 files, 2637/2637 |
| Per finding | the finding's suites (above) | all green |
| After the eleven items | the same five folders | 120 files, 2660/2660 (+23 = exactly the new cases) |
| After the eleven items | the WHOLE dashboard suite (`cd dashboard && npx vitest run`) | 263 files, 5287/5287, exit 0, 61.2 s |
| After the mutant follow-ups | dialog + ContactDetail | 169/169 |
| Final | the WHOLE dashboard suite | 263 files, 5290/5290, exit 0, 61.4 s |
| Per finding and final | root `npm run typecheck` (all workspaces) | exit 0 (RD-9's first attempt exited 2 in e2e, fixed above) |
| Final | `npx eslint` on all 20 touched `.ts/.tsx` (`git diff --name-only --diff-filter=d 2aa30812...HEAD`), then the two follow-up files | exit 0, no errors |

Notes on the counts and checks:
- Lint: eslint reports no errors at all, so there is nothing new against
  `1d7a4667`. `FlyerPage.tsx`, with its 2 pre-existing react-hooks errors,
  was not touched (only its test was).
- ASCII: the added lines of every touched file print 0 on the `tr` check,
  including the CSS module and selectors.md. No literal backslash-u was
  written.
- Not run, per the brief: the full `npm test` and any Playwright e2e.

## Mutant table

Ten one-line mutants, applied and reverted with the Edit tool one at a time.
They cover items 1-7 of the brief. Item 9 (RD-12) is a doc comment with no
executable line, and item 4 (RD-5) is one copy string pinned by an exact
`getByText`, so it is killed by construction.

Before each run, `git diff -U0` showed exactly the one mutant. Afterwards
`git status --short` and `git diff --stat` were empty, and
`git diff --exit-code HEAD` on the six mutated files exited 0.

| # | Mutant | file:line | Test run (failed / total) | Result | Follow-up |
|---|---|---|---|---|---|
| M1 | deposit_conflict drops the OR-17 carry (`carryRef = null`) | `ApplyRequirementsDialog.tsx:225` | dialog 0/23 | SURVIVED | `:524` case: 1 failed / 24 with the mutant (Credit score re-checked), 24/24 clean; `a0ca6ff2` |
| M2 | the amount hidden beside One month's rent (the old `else`) | `requirements.ts:380` | display + dialog 3/45 | KILLED | - |
| M3 | money never pads cents (`digits = 0`) | `requirements.ts:329` | display 3/22 | KILLED | - |
| M4 | `import './listingFormat.js'` re-added (side-effect only, no TDZ at runtime) | `requirements.ts:28` | display 1/22 (only the RD-6 source guard sees it) | KILLED | - |
| M5 | `setAddingProperty(false)` dropped | `ContactDetail.tsx:369` | ContactDetail 1/143 | KILLED | - |
| M6 | `setDeleteError(null)` dropped | `ContactDetail.tsx:371` | ContactDetail 0/143 | SURVIVED | `:3353` case: 1 failed / 145 with the mutant (the landlord's "Couldn't delete" alert in z99's dialog), 145/145 clean; `a0ca6ff2` |
| M7 | `setCreatingRelayGroup(false)` dropped | `ContactDetail.tsx:365` | ContactDetail 0/143 | SURVIVED | new it.each row `Create a relay group`: 1 failed / 145 with the mutant, 145/145 clean; `a0ca6ff2` |
| M8 | the status role only when a result exists | `LandlordRequirementsCard.tsx:67` | card 1/6 | KILLED | - |
| M9 | `.clears` back on `var(--c-warning)` | `ApplyRequirementsDialog.module.css:107` | dialog 1/23 | KILLED | - |
| M10 | the name rule takes the legacy `contact.phone` | `format.ts:163` | format + card + New form 4/107 | KILLED | - |

The three survivors were real bugs had they shipped:
- M1 would let a deposit_conflict re-read re-check an item staff left out.
- M6 would show the landlord's failed-delete error in another contact's
  Delete dialog.
- M7 would re-open a relay group dialog seeded with the previous contact as
  its locked member.

Considered and not run:
- `setStartingPlacement` / `setSchedulingTour` / `setTourUnitOverride`
  dropped. These are tenant-page dialogs of the same reset, same class as
  M5-M7.
  - No case pins them. A tenant harness with a Properties-sent row would be
    needed for the override.
  - Left as a known gap; the reset lines are there.
- `formatRequirementMoney` `maximumFractionDigits: 2` -> `3`. Equivalent on
  every 2-decimal input.

## Divergences from the brief (each deliberate)

- `contactPhones.ts` type-import path: outside the named files, needed for
  the e2e typecheck (RD-9 above). No runtime change.
- RD-4 reset covers seven dialog flags plus two companions, not only
  `addingProperty` and `editing`, as the brief's "any other ... flag" asks.
  The tests cover five dialogs; the brief named two.
- RD-7: one existing OR-18 assertion moved from "no status region" to "the
  region is empty". The old form contradicts an always-mounted region.
- RD-8 got a test (a CSS source-text check) although the brief named none. It
  makes the fix mutation-visible (M9).
- O-1: the Deposit `it.each` became a for...of loop of `it`s. No it.each
  title can print a literal `$<digits>`.
- `e2e/support/selectors.md` clarified (two rows). No spec text changed.

## CONTRACT (what later work relies on)

- New exports:
  - `DEPOSIT_CONFLICT_NOTICE` (`dashboard/src/routes/contact/applyRequirementsModel.ts:217`);
  - `formatRequirementMoney(amount: number): string` (`dashboard/src/routes/listing/requirements.ts:328`);
  - `landlordDisplayName(contact: Contact): string` (`dashboard/src/routes/contact/format.ts:158`).
- Changed output:
  - `formatItemValue('deposit')` shows both forms when both are recorded.
  - Requirement money keeps cents (`$1,250.40`); whole amounts are unchanged.
    This reaches the property Requirements card, the landlord card, the
    Apply dialog and the D6 landlord lines.
- Apply dialog: a 409 `deposit_conflict` on any batch stops the run,
  re-reads, carries the left column, and shows the notice as `role="alert"`.
- Landlord Requirements card: one `role="status"` region is always mounted,
  empty until a result. Assert its text, never its presence.
- Property page: the tour card's empty state is
  `No application process recorded yet.`.
- Contact page: a contactId change closes every per-contact dialog and
  clears the Delete error.
- `requirements.ts` imports nothing from `listingFormat.ts`. A source-text
  test guards it; keep it that way.

## For the orchestrator and Cameron

- New copy for Cameron's eye:
  - the OR-31 sentence;
  - RD-5's `No application process recorded yet.` (the "Tour & application
    process" title still stands; retitle?);
  - the landlord name fallback (company, then phone) on the property card
    and the New form;
  - the later-batch deposit_conflict notice drops the landed count (RD-3's
    trade).
- The contact page header's name rule is unchanged: a company-only landlord's
  header still shows the phone.
- Gates still owed on the final commit (not run here, per the brief): the
  full `npm test`, `npm run smoke`, `npm run e2e`, and gate 5 on the whole
  branch.
