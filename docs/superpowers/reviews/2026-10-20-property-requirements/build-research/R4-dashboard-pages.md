# R4 - build research: S6 dashboard pages

- Reader: R4 (read-only live-tree drift check, charter
  `.superpowers/sdd/research/CHARTER.md`).
- Slices covered: S6 (Tasks 6.1-6.12) in full; S5 exports (producer side of
  the S5 -> S6 contract); S7 selectors that target S6 surfaces (consumer
  side).
- Plan lines read: 1-913 in full (sections 0-4, AR1-AR48, 4.1, 4.2);
  20019-24829 in full (S6). Also: S5 13566-20018 and S7 24830-26814, by two
  read-only helper readers whose results I spot-checked against the tree.
  Spec D6, D8-D11 and D13 (spec lines 448-756) read in full.
- Tree: worktree `W:/tmp/property-requirements` @
  `b0b07a5a080b5303b74e77d91e02977d503584e0` (main @1d7a4667 plus docs).
  Also read: main @3df43172 for commit b222a4ac.

Totals: 0 BLOCKER, 0 MAJOR, 13 MINOR.

## Findings

R4-F1. Task 6.1 Step 3(a). KIND: FACT. SEVERITY: MINOR.
- Plan (20533-20535) says: "Every value import here is used only INSIDE
  function bodies".
- S5's task code makes that false. S5's `requirements.ts` builds
  `const TOUR_TYPE_SET: ReadonlySet<string> = new Set(Object.keys(TOUR_TYPE_LABELS));`
  at module top level (plan 14941).
- It is harmless. The only top-level dependency is on the api barrel, which
  never imports `requirements.ts` at runtime (`api/types.ts` imports routes
  type-only). It also needs every test that mocks the barrel to keep
  `TOUR_TYPE_LABELS`, and I checked all 92 `vi.mock(... api/index.js ...)`
  sites: 91 spread the real module (`importActual` / `importOriginal`). The one
  that does not, `dashboard/src/app/EnvironmentIdentity.test.tsx:12`, imports
  nothing from `routes/listing`.
- The new `requirements.ts` <-> `listingFormat.ts` cycle (6.1 `formatMoney`,
  6.2 `WASHER_DRYER_LABELS`) has no top-level use in either direction. No
  `import/no-cycle` lint rule exists.
- Instruction:
  - Merge `type Contact, type UnitItem` into S5's existing
    `import { TOUR_TYPE_LABELS, ... } from '../../api/index.js'`. Do not add a
    second import from the same module.
  - Leave `TOUR_TYPE_SET` where S5 put it.
  - Read the sentence as: "every value import from `./listingFormat.js` and
    `../contact/format.js` is used only inside function bodies".

R4-F2. Task 6.11 (and model 6.7). KIND: RULING. SEVERITY: MINOR.
- The dialog's read effect (plan 24220-24221) resets on EVERY read:
  `setCheckedItems(defaultCheckedItems(landlord)); setHand(new Map());`.
  That includes the re-read after a mid-run stop and after a first-request
  failure (`reload()`, 24287).
- So after "Updated N properties before this stopped. Review the rest and
  press Update again.", any item the staff UNCHECKED on the left is checked
  again. Rows without an own value for it then start checked, and a second
  Update copies an item the staff chose not to copy. Own values stay
  protected: those rows start unchecked, and the server returns
  `changed_since_opened`.
- Spec D8 (spec 578-583) does not say whether the left column survives a
  re-read. "Review the rest" reads as continuing the same Apply.
- Instruction: no change is required to match the plan as written. If the
  planner agrees, add a `preserveChoices` flag to the reload in Task 6.11:
  - after a mid-run stop or a first-request non-409 failure, keep
    `checkedItems` (drop hand choices only for rows that now read Already
    matches);
  - on open, Try again, and 409 `requirements_changed`, keep today's reset.

  Otherwise record it as accepted behavior.

R4-F3. Task 6.12. KIND: OTHER. SEVERITY: MINOR.
- `applyingFor` is kept when the page moves to another contact. The guard
  `applyingFor === contact.contactId` (plan 24705) hides the dialog on B, as
  intended. The dialog therefore never posts for B.
- Going back to A (browser Back/Forward) re-mounts the dialog. It re-reads
  and opens again without a click.
- `applyDone` behaves the same way: the done message comes back on A. S6's own
  CI-8 text says it is "kept until the next Apply opens or the page moves to
  another contact".
- Instruction (optional, low priority): in Task 6.12, clear both pieces of
  state when they belong to another contact. One option is to set both when
  `applyingFor`/`applyDone.contactId !== contact.contactId` inside the
  existing `onApplyRequirements` / `onDone` handlers. Another is to add a
  `contactId` to the state and ignore stale entries, which is what the plan
  already does. The simplest option is to accept and document.

R4-F4. S6 intro (plan 20035-20038). KIND: FACT. SEVERITY: MINOR.
- Plan says: "S4 edits one comment line in `dashboard/src/api/endpoints.ts`
  (not the region S6 edits)".
- S5 also edits `endpoints.ts`:
  - Task 5.1, plan 14237-14313: the type imports, the `createUnit` doc, and
    `applyLandlordRequirements` after `getContact`;
  - Task 5.9, plan 19068-19076: `CreateUnitBody` and the `createUnit`
    signature.
- None of these touch Task 6.10's anchors. All 6 of those anchors are
  byte-exact and unique today (see Confirmed).
- Instruction: none beyond the plan's re-read-on-top rule. Expect S5 hunks in
  the same file.

R4-F5. Plan section 10 "5. Notes for other slices", second bullet (plan
24783-24788). KIND: RULING. SEVERITY: MINOR.
- The note says S5's money inputs carry "`min={0}` AND `step={1}`".
- PR2-3 rules `step="any"`, and S5's task code has
  `<input type="number" min={0} step="any">` for "Fixed amount" and
  "Application fee".
- The note is stale. No S6 test depends on it.
- Instruction: ignore the note. Do not "fix" S5's `step`.

R4-F6. Plan section 10 "5. Notes for other slices", S7 bullet (plan
24808-24811). KIND: FACT. SEVERITY: MINOR.
- The note says `public-pages.spec.ts:239-247,367-410` has "a $0 fee now
  reads `No application fee` (not `$0`)".
- No spec in that file asserts `$0`. The fees used there are 45 (default,
  `:110`), 30 and 99 (`:362,368`), so AR43 (no edits there) holds against
  S6's flyer code.
- Instruction: none. Task 7.3 runs the file unchanged.

R4-F7. Tasks 6.2 / 6.5 vs S5 picker. KIND: OTHER. SEVERITY: MINOR.
- S6's `recordedVoucherSizes` (plan 20818-20823) keeps any finite number.
- S5's form helper `splitVoucherSizes` (plan 15676-15688) marks non-integers
  and values outside 0..12 as "Not a valid size, removed when you save".
- So a legacy stored 2.5 or 13 reads "2.5 BR, 13 BR" on the property page but
  is flagged in the edit form. Only legacy data is affected, because the D4
  validator accepts integers 0..12 only.
- Instruction (optional): in Task 6.2, filter
  `Number.isInteger(v) && v >= 0 && v <= VOUCHER_SIZE_MAX`, importing it from
  `./requirements.js`, and add a case. Otherwise accept the difference.

R4-F8. S6 -> S7 contract (Task 6.2 / 6.11 vs S7 25829-25837, 25910-25921).
KIND: CONTRACT. SEVERITY: MINOR.
- The Activity row renders label and sub in one element
  (`dashboard/src/routes/listing/ListingDetail.tsx:1050-1054`). So the text
  reads "Requirements applied from the landlordNo pets, Pets, Pet fee".
- The own-value mark renders `" (own value)"` with parentheses (plan 24402),
  while 1.1 writes the mark as `own value`.
- S7's selectors use substring matching, so both pass.
- Instruction: in S7 (Task 7.6 spec), never add `exact: true` to
  `getByText('Requirements applied from the landlord')` or to
  `getByText('own value')`.

R4-F9. Tasks 6.4 / 6.8 / 6.9 vs S5 `RequirementsFields`. KIND: CONTRACT.
SEVERITY: MINOR.
- Both new cards name one `role="group"` per item by the item label (plan
  21259, 23004).
- S5's `RequirementsFields` renders a `<fieldset><legend>` per group, plus
  nested ones for Evictions and Deposit (plan 16918-16936). So "Pets",
  "Touring", "Evictions" and "Deposit" are ALSO group names inside the
  property edit dialog and the landlord edit dialog.
- With an edit dialog open, an unscoped `getByRole('group', { name: 'Pets' })`
  matches two elements. S6's tests never do this, and S7's selectors are
  scoped.
- Also, S6 CI-3 and the 6.9 note ("renders no section heading and no legend")
  mean the SECTION legend only. The group legends do exist.
- Instruction: scope every group-by-item-name selector to the card
  (`cardTitled(...)` / the `section`) or to the dialog. This applies to new
  tests in any slice.

R4-F10. Invariant sweep, property page. KIND: INVARIANT. SEVERITY: MINOR.
- `listingRoster(unit, landlord)` pairs `unit.landlordId` with `state.landlord`
  without checking `landlord.contactId === unit.landlordId`
  (`dashboard/src/routes/listing/buildListingFile.ts:78-95`, called at
  `ListingDetail.tsx:369`). It is used only when the unit carries no
  `contacts[]`.
- Inside 6.3's re-read window, that fallback row can name the PREVIOUS
  landlord. This predates S6, and before 6.3 it lasted until a reload.
- Task 6.3's new doc comment (plan 20975-20979) tells readers to compare
  `contactId`. Task 6.5 does this for the Requirements card; the roster does
  not.
- Plan 3.1 does not list this reader.
- Instruction: none required (pre-existing, transient, rare). Optionally, in
  6.5, pass `requirementsLandlord ?? null` to the `listingRoster(contactsUnit,
  ...)` call at `:369` as well. This is a one-line change, and the existing
  roster tests use the of-record landlord.

R4-F11. Main sync (AGENTS.md: the single main sync at Task 7.8). KIND:
OTHER. SEVERITY: MINOR.
- An in-flight branch, `fix/contact-file-double-fetch` (worktree
  `W:/tmp/contact-file-double-fetch`), has 0 commits and an uncommitted edit
  to `dashboard/src/routes/contact/useContactFile.test.tsx`. Its target is
  the hook whose `refetch()` Task 6.12 relies on (`useContactFile.ts:125`,
  units read `:149-158`).
- If it reaches main before 7.8, the sync brings a behavior change into a
  file S6 does not edit, so there is no textual conflict.
- Instruction: after the 7.8 sync, re-run
  `src/routes/contact/ContactDetail.test.tsx` (6.12's two new cases count
  `getAllUnits` calls) and `src/routes/contact/useContactFile.test.tsx`.

R4-F12. Existing test comment (not a failing assertion). KIND: BREAKS-TEST.
SEVERITY: MINOR.
- `dashboard/src/routes/contact/ContactEditForm.test.tsx:517-525` still
  passes after 6.9. Its title reads 'no landlord preference / expected-rent
  inputs <EM-DASH> those fields moved to the property'. Its `^...$` label
  regexes do not match the new labels.
- Its premise is now partly stale: D9 puts pets requirements on the landlord
  form. The same is true of the comments at `files.test.tsx:502-504` and
  `LandlordFile.tsx:114-116`.
- Instruction (optional): in Task 6.9 / 6.8, add one comment line ("the
  landlord's copy-only requirement defaults, pets included, are the
  Requirements / Qualifications fieldset, D9"). Do not change the
  assertions.

R4-F13. b222a4ac on main (requested check). KIND: OTHER. SEVERITY: MINOR
(informational - no S6 change needed).
- What the commit does: `requestWithStatus` now waits one microtask before a
  SIGNALLED fetch, and throws `signal.reason` (an AbortError) when the signal
  aborted in that tick (main `dashboard/src/api/client.ts:117-131`).
  Unsignalled requests still dispatch synchronously.
- No S6 task depends on dispatch timing. Each signalled read already treats an
  abort as a no-op:
  - Task 6.3 re-read: `loadLandlord` rethrows only AbortError
    (`useListing.ts:139`), and the new `.catch(() => {})` swallows it.
  - Task 6.11 dialog: `getContact(id, signal)` + `getAllUnits({ landlordId },
    signal)`. Its catch returns on `controller.signal.aborted ||
    AbortError`, and `fetchAllPages` propagates rejections unchanged
    (`dashboard/src/api/paging.ts:50-51`).
  - Task 6.12 `useContactFile.refetch()`: bumps a nonce. The new request's
    signal is not aborted in its own tick.
- The writes are unaffected. `applyLandlordRequirements(contactId, body)` is
  unsignalled (2 args, plan 24279), so it dispatches synchronously as before.
- Every S6 test mocks the api barrel or `request` (`lists.test.ts:8-12`).
  None mocks `fetch`, so the microtask does not reach them.
- Under StrictMode (`dashboard/src/main.tsx:15`), the first-mount reads of
  the dialog (and of 6.3's effect, which returns early on mount anyway) are
  now dropped before they reach the network. That is the commit's purpose and
  helps e2e.
- S6 edits neither `client.ts` nor `client.abort.test.ts`, so the 7.8 sync
  has no textual conflict there.
- Instruction: none.

## Confirmed

Anchors (check 1). All 75 multi-line and single-line ASCII anchors that S6
quotes are byte-exact and occur once. I checked them mechanically with a
throwaway Python `str.count == 1` script over the LF files; the R4 ref
section 1 holds the em-dash regions:
- 6.2: 6/6.
- 6.3: 5/5, plus the test anchor at `useListing.test.tsx:357`; `landlord,`
  after `unit,` is unique (`useListing.ts:243-244`).
- 6.5: 7/7 source, 3/3 test (`ListingDetail.test.tsx:6,177-178,207-211`).
- 6.6: 7 in `FlyerPage.tsx`, 2 in `publicApi.ts`, 5 in the test.
- 6.8: 7/7 source, 4/4 test. The `units={[UNIT, PLACED_UNIT]}` and `media`
  anchors are unique (`files.test.tsx:475,481-483`).
- 6.9: 7/7, including CSS `.fieldset` (`ContactEditForm.module.css:71-75`).
- 6.10: 6 in `endpoints.ts`, 2 in `Modal.tsx`, 1 in `Modal.module.css`, 2 in
  `Modal.test.tsx`, 1 in `lists.test.ts`.
- 6.12: 4/4 source, 2/2 test (`ContactDetail.test.tsx:65,144`).

The three em-dash anchors exist as described, holding U+2014 at the stated
spots:
- the Property details grid, `ListingDetail.tsx:958-988`;
- the Tour card, `:1012-1034` (Tour type KV at `:1025`);
- the Notes line, `LandlordFile.tsx:171`.

S6 facts (check 2): all true.
- `useListing.ts:129-142` (`loadLandlord` rethrows only AbortError);
  `:149-152` (state); `:161-185` (`setUnit` keeps the rest of the state);
  `:211-212` (landlord read once); `:262` (deps `[unitId]`).
- Roster writes and restores apply via `setUnit`
  (`ListingDetail.tsx:547-550` `applyRosterUnit`; `:485,493`).
- `listingFormat.ts:225-228` and `:15-18`. `UnitActivityEvent.reason`
  (`types.ts:3256`). `TOUR_TYPE_LABELS` (`types.ts:907-911`: Self-guided,
  Landlord-led, PM team).
- `contactDisplayName` (`format.ts:138-147`). `formatAddress`
  (`format.ts:102`). `humanize` (`:118-122`).
- `FlyerPage.tsx`: `:54-57`, `:106-108` (`textOrNull`), `:110-115`,
  `:247` (h1 = neighborhood), `:264-268`, `:298-309`, `:310-321`.
- `publicApi.ts:28-53`. Its only readers are `FlyerPage` and its test; no
  other workspace types it.
- `LandlordFile.tsx`: props `:44-75` (`onEdit` exists), `myUnits :109`,
  `unitRowLabel :83-88`. `formatAddress` is still used at `:210,235`.
- `Card.tsx`: `:20-31` (section > h3 holding the aside), `CardAction :32-54`
  (the plan says `:34-56`; immaterial), `BLANK :130` (an escape of U+2014),
  KV `:136-158` (k/v spans in one div, so 6.5's `.parentElement` works).
- `ContactDetail.tsx`: `:292` (setContact), `:349` (`useContactFile`),
  `:1185-1203`, `:1412-1421`. `useContact.setContact` is bound to the
  contactId (`useContact.ts:51-53`). `useContactFile.refetch :125`.
- `ContactEditForm.tsx`: `:185` (`isLandlord` = live kind), `:224`,
  `:333-350`, `:479-483` (`{ error }` return), `:525-534`, `:871-973`,
  `:1030` (`<p role="alert">`). The tenant Pets field is gated on `isTenant`
  (`:757-770`).
- `Modal.tsx :12-25,161-172`. Every other variant branch tests
  `=== 'media'`, so 'wide' falls back to the default behavior.
- CSS tokens: all 22 tokens S6's CSS uses exist in
  `dashboard/src/ui/tokens.css` (for example `--c-pill-partner-bg #6d28d9
  :99`, `--c-evt-amber-bg/-text :114,116`).
- The `toHaveClass(styles.x!)` precedent exists
  (`BroadcastResults.test.tsx:301`; `vite.config.ts:139 css: false`).
- The server answers `GET /api/units?landlordId=` with
  limit/cursor/deleted (`app/src/routes/units.ts:750-765`).
  `PAGE_LIMIT = '100'` (`paging.ts:40`).
- Single-version serving holds: `/public/*` uses CachingDisabled
  (`infra/modules/cloudfront/main.tf:158-167`), the app runs on one EC2
  module, and the dashboard is served by the app (`Dockerfile:30-31`,
  `app/src/app.ts:304`). So the new FlyerPage never meets an older
  projection, and its unguarded reads of `voucher_sizes`, `washer_dryer` and
  string `pets` are safe.
- No `exactOptionalPropertyTypes` (`tsconfig.base.json`). So
  `application_process: undefined` (6.5) and
  `onApplyRequirements={opts.onApplyRequirements}` (6.8) typecheck.
  `UnitItem` / `Contact` have `[key: string]: unknown` (`types.ts:2569,2319`),
  so the test spreads `({ ..., ...over })` typecheck.

Existing tests that pin S6 behavior (check 4). Every row of S6's table is
true and is updated by the stated task:
- `ListingDetail.test.tsx:211` (6.5c), `:253-285` (6.5d), `:298-313` (6.5e),
  `:341-346` (6.5f);
- `FlyerPage.test.tsx:34-36,46-48,88,236,241,246` (6.6);
- `files.test.tsx:517-521` (6.8);
- `listingFormat.test.ts:195-202` (PIN);
- `useListing.test.tsx` (all PIN, including the FW2-5 cases `:357-470`: no
  getContact count, setUnit for A is a no-op);
- `ContactEditForm.test.tsx` landlord cases (PIN; none of its regex/role
  selectors match the new labels: `:83-90,278-287,333-482,517-536`);
- `ContactDetail.test.tsx:519-529` (PIN).

Extra hunts with no hit:
- no other ListingDetail test queries text that the new card duplicates. Its
  unscoped regexes are `:241,248,336,651,657,669,1033,1040,2817`; the one
  `/James Porter/` query is a link role (`:357`), and the others are scoped.
- no heading regex collides with 'Requirements...' or the h4s
  (`/Tours on this property/`, `/^Contacts/`, `/^Sent to\b/` ...).
- no test asserts h3 order/counts or `'No process recorded yet.'` elsewhere.
- no test mocks `listingFormat` / `format` / `Card`.
- `'Not allowed'`, `'$0'` and 'Fits a' are pinned by no dashboard test.
- the landlord-file tests in `files.test.tsx` and `ContactDetail.test.tsx`
  use exact names ('Landlord', 'Porter Properties', 'Available',
  'Occupied', 'Tours on their properties'), and the new card does not repeat
  them.

Native constraint validation (hunt 2): no PR2-1-class trap in S6's UI tests.
- 6.9's Save cases use valid amounts ('1400'; `min={0} step="any"`), and the
  disabled Fixed amount is barred from validation.
- No case types a bad amount.
- The Apply dialog has no `<form>`: Update and Cancel are `type="button"`
  (plan 24305-24316).
- 6.5's Edit case only opens the dialog.

Importers (check 5). Every widened surface is additive:
- `CardAction` `disabled` / `describedBy`;
- `Modal` `variant` 'wide';
- `getUnits` / `getAllUnits` `landlordId`;
- `LandlordFileProps` new optional props;
- `ListingState` internal `landlordForId` (not on the public type).

`PublicFlyer` changes (`subzone` removed, `pets: string | null`, 6 new
required keys) reach only `FlyerPage.tsx` and `FlyerPage.test.tsx`, and 6.6
updates both. `e2e/performance/mutationCatalog.ts` only lists the
`publicApi` `request()` call sites, which do not change.

S5 -> S6 contract (check 7, AR33/AR36/AR37/AR39/AR40/PR1-7). Every name S6
imports exists in S5's task code with the arity and param order S6 uses:
- `requirements.ts`: REQUIREMENT_ITEMS, isItemBlank,
  isOwnValue(sources, id, unitValue), itemValuesEqual, landlordItemValue,
  readRequirementSources, unitItemValue, WASHER_DRYER_LABELS
  (`Readonly<Record<WasherDryer,string>>`), types ItemValue,
  RequirementItemId, RequirementGroup, RequirementItem;
- `requirementForm.ts`: requirementFormValuesFromLandlord,
  buildRequirementPatch(initial, current) -> ok/patch | ok:false/error,
  toLandlordPatch, RequirementFormValues;
- `FlyerTag.tsx`: FlyerLegend({ audience });
- `RequirementsFields.tsx`: { values, onChange, audience, disabled? };
- api barrel: ApplyRequirementsBody, ApplyRequirementsResult,
  applyLandlordRequirements(contactId, body, signal?).

S5's param types are `Record<string, unknown>`; `UnitItem` and `Contact`
are assignable. `ApplyRequirementsBody.expected` is
`Partial<Record<RequirementItemId, Record<string, string|number|boolean|null>>>`,
and S6's `ItemValue` values (`true` subset of `boolean`) are assignable.

6.9's selectors resolve to S5's controls:
- checkbox 'No pets', 'No evictions while on the program', "One month's
  rent";
- 'Pet fee' text;
- 'Fixed amount' number shows '1400';
- combobox 'Tour type' with value self_guided.

`buildRequirementPatch` adds `deposit: null` on the save that checks One
month's rent, with or without a stored amount (S5 plan 15621). S5 rewrites
none of the 12 files S6 edits. `ListingEditForm` keeps the Modal title "Edit
property", so 6.5's `/Edit property/i` matches.

S6 -> S7 contract (check 7, AR41). Every S7 selector on an S6 surface
resolves to exactly one S6 element with the ruled role, name and text:
- landlord card 'Apply to properties' / 'Edit requirements';
- property card 'Edit property requirements';
- the h3 names start with the titles; the dialog 'Apply to properties';
- list 'Which properties' with one checkbox per li named by
  `propertyRowLabel`;
- 'Update 1 property' / 'Update N properties';
- the tags and lines;
- 'Voucher sizes accepted' with '2 BR' / '3 BR, 5 BR';
- the flyer rows;
- 'No notes yet - use + Add.'.

S7's mutant M3 anchor `return row.own.length === 0;` equals plan 22517.
S7's tenant-form `getByLabel('Pets')` (`e2e/scenarios/steps.ts:907-908`)
relies on the fieldset rendering for landlords only, and 6.9 gates it on
`isLandlord` (plan 23462) with a pinning test (23239-23243).

Apply dialog vs D8 / AR38 / AR40 (hunt 4):
- re-read on open, with loading and error + Try again;
- left column checked/unchecked + "Clears";
- right column landlord of record, not deleted
  (`deleted_at` non-empty = deleted, matching PR1-8 `isDeleted`), address +
  status;
- live changes, own-value marks (`isOwnValue`, the D6 definition), Already
  matches disabled;
- starting state and both hand rules; no Select all;
- N = checked rows, disabled at 0;
- sequential batches of 100 merged, using the server cap of 100;
- the first-request 409 `requirements_changed` re-reads and shows the bound
  copy; any other first-request failure re-reads and shows the AR38 copy;
- a later 409 or failure stops, re-reads and shows the stopped notice, with
  the AR38 singular;
- done -> `onDone(summary)`, page refetch + last-read contact + the
  role=status block until the next Apply opens;
- Cancel after any Update -> `onClose(true)` -> refetch.

All the 1.1 copy strings S6 renders match byte for byte. See R4-F2 for the
one behavior choice the spec leaves open.

Commands (check 8): every RED/GREEN command is runnable as written.
- Dashboard vitest runs from `dashboard/` with `src/...` paths.
- `requirements.test.ts`, `requirementForm.test.ts` and
  `RequirementsFields.test.tsx` are created by S5; the rest exist
  (`LandlordOnboardingCard.test.tsx`, `publicApi.test.ts`,
  `api/endpoints.test.ts`, `useContactFile.test.tsx`, `useContact.test.tsx`,
  `e2e/performance/mutationCatalog.test.ts`).
- Typecheck and eslint run from the root.

## Invariant sweep

State (a): unit requirement keys - dashboard readers/renderers.

| Surface (file:line) | Reads | Status |
|---|---|---|
| `routes/listing/ListingDetail.tsx:962,966,968` (Deposit, Pets, App fee KVs) | deposit, pets (raw), application_fee | IN-PLAN 6.5 (moved to the card, read through `unitItemValue`) |
| `routes/listing/ListingDetail.tsx:1025-1028` (Tour type KV, tour_process) | tour_type, tour_process | IN-PLAN 6.5 (Touring item) |
| `routes/listing/PropertyRequirementsCard.tsx` (new) | all 15 keys + requirement_sources | IN-PLAN 6.4 |
| `routes/public/FlyerPage.tsx:110-115,264-319` | pets, voucher_size, deposit, application_fee (+ new keys) | IN-PLAN 6.6 |
| `routes/listing/ListingEditForm.tsx:82-200`, `UnitCreateForm.tsx:206-219` | deposit, pets (boolean-aware), tour_type, tour_process, application_fee | IN-PLAN S5 |
| `routes/contact/applyRequirementsModel.ts` / `ApplyRequirementsDialog.tsx` (new) | all keys via `unitItemValue`, requirement_sources | IN-PLAN 6.7 / 6.11 |
| `routes/tours/TourDetail.tsx:716` (guidance card) | tour_process | WATCH (in 3.1). `typeof === 'string'`, so a REMOVEd '' reads as absent. Unchanged. |
| `routes/tours/ScheduleTourForm.tsx:247-292` (prefill) | tour_type, tour_process | WATCH (in 3.1). Truthy / trim checks, so absent is fine. Unchanged. |
| `routes/contact/Card.tsx:221` (`interestedModeOf`) | tour_type | WATCH (in 3.1). Non-empty string check. Unchanged. |
| `routes/broadcasts/resolveTemplate.ts` (share text) | beds, address, rent, flyer link only | not a reader. Merge fields hold no requirement key. |
| `routes/contact/ContactEditForm.tsx:247,404`, `EligibilityIntakeCard.tsx:75` | TENANT contact `pets` / `evictions` | not a unit reader (tenant answers). 6.9 leaves them alone; the tenant field is gated on `isTenant` (`:757`). |

State (b): unit.landlordId and the landlord contact on the property page.

| Surface (file:line) | Status |
|---|---|
| `useListing.ts:131-142,212` (load-time read) | IN-PLAN 6.3 (adds a re-read on change, `landlordForId`) |
| `ListingDetail.tsx` Requirements card (new `requirementsLandlord` guard) | IN-PLAN 6.5 |
| `ListingDetail.tsx:369` -> `buildListingFile.ts:78-95` (`listingRoster` fallback row: name/company from `state.landlord`) | NOT-IN-PLAN (R4-F10, MINOR, pre-existing; no contactId check) |
| `ListingDetail.tsx:381` (`landlordOfRecord` for the roster remove-guard) | unchanged, reads the unit only |
| `ListingDetail.tsx:485,493,549,1582` (restore, roster write, edit save -> `setUnit`) | IN-PLAN 6.3 trigger (the landlordId change is noticed) |
| `buildListingFile.ts:111-114` (Related fallback by landlordId) | unchanged, no requirement semantics |
| `PlacementDetail.tsx`, `TourDetail.tsx`, `useTour.ts`, `useContactFile.ts`, `buildContactFile.ts` (landlordId reads) | outside the property page. They show no requirements. Unchanged. |

State (c): contact `req_` keys (new) - dashboard readers and writers.

| Surface | Kind | Status |
|---|---|---|
| `ContactEditForm.tsx` fieldset (`requirementFormValuesFromLandlord` -> `buildRequirementPatch` -> `toLandlordPatch`) | writer + reader | IN-PLAN 6.9 (the only dashboard writer; landlords only) |
| `LandlordRequirementsCard.tsx` | reader | IN-PLAN 6.8 |
| `requirements.ts` `requirementDisplay` / `landlordHasNoRequirements` | reader | IN-PLAN 6.1 |
| `applyRequirementsModel.ts` / `ApplyRequirementsDialog.tsx` (`expected`, defaults) | reader | IN-PLAN 6.7 / 6.11 |
| `UnitCreateForm` prefill / snapshot (`requirementsSnapshotOf`) | reader | IN-PLAN S5 |
| Any generic contact-key iteration (CSV, facts, custom fields) | - | none found (no `Object.keys/entries(contact)` in dashboard source) |
