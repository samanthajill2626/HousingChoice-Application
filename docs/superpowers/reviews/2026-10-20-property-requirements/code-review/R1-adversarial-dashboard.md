# R1 adversarial code review - DASHBOARD + E2E (reviewer RD)

- Branch: `feat/property-requirements`, HEAD `738a2b4e` (merge of main), merge-base `3df43172`.
- Input: `.superpowers/review/pkg-dashboard-e2e.txt` (all 83 files read), plus read access to the
  repo (dashboard/, e2e/, and the app/ routes the dashboard calls). Nothing else under
  `docs/superpowers/` or `.superpowers/` was opened.
- Gates observed before any test ran: `.superpowers/gates/final/summary.txt` reached
  `end 2026-10-21T01:51:29-04:00` with typecheck 0, test 0, smoke 0, e2e 0 (367 tests), lint 1
  (see RD-14).
- Proofs: throwaway vitest files named `zz-review-rd-*` under `dashboard/src/`, run with
  `cd W:/tmp/property-requirements/dashboard && npx vitest run src/<path>`, then deleted by exact
  name. `git diff --exit-code -- dashboard e2e app` was clean afterwards (no tracked file touched;
  the untracked `app/test/zz-review-ra-*` files belong to another reviewer and were left alone).
  The load-bearing assertions of each proof are quoted below so it can be rebuilt.

## Counts

| Severity | Count | Ids |
|---|---|---|
| BLOCKER | 0 | - |
| HIGH | 0 | - |
| MEDIUM | 1 | RD-1 |
| LOW | 8 | RD-2 .. RD-9 |
| INFO | 5 | RD-10 .. RD-14 |

## Findings

### RD-1 - MEDIUM - Apply to properties dead-ends on 409 `deposit_conflict`

- Confidence: CONFIRMED.
- Where: `dashboard/src/routes/contact/ApplyRequirementsDialog.tsx:205-222` (only
  `409 requirements_changed` is special-cased, line 214; every other first-request failure takes
  `APPLY_FAILED_NOTICE` and the OR-17 carry); `dashboard/src/routes/listing/requirements.ts:361-364`
  (`formatItemValue('deposit', ...)` prints "One month's rent" and drops the fixed amount when both
  are present). Server contract: `app/src/routes/contactRequirementsApply.ts:16-17` - "409
  deposit_conflict; 409 requirements_changed. The dashboard owns every sentence; it shows only the
  two 409s" - and `:158-162` returns 409 `deposit_conflict` whenever the LANDLORD record holds both
  `req_deposit_one_month` and `req_deposit`.
- Scenario: the landlord record holds both deposit forms. This is reachable today: the landlord
  PATCH decides `deposit_conflict` on a consistent read (`app/src/routes/contacts.ts:1592-1667`) but
  its write (`:1882-1892`) is guarded only by the classification / staff-notes guards, so two staff
  saving at once - A ticks "One month's rent" (sends `req_deposit_one_month: true, req_deposit:
  null`), B types a Fixed amount (`req_deposit: 1400`) - both pass the check and the record ends
  with both. Staff then open Apply to properties: the left column describes Deposit as "One
  month's rent" (the $1,400 never shows, here or on the landlord's Requirements card), Update
  answers 409 `deposit_conflict`, the dialog says "Couldn't update the properties. Review the list
  and press Update again.", re-reads, and every further Update gets the same 409 and the same
  sentence. Nothing on any dashboard surface reveals the cause or the remedy (untick One month's
  rent on the landlord form). On a LATER batch the same 409 reads "Updated N properties before
  this stopped..." - equally wrong.
- Proof: `src/routes/contact/zz-review-rd-apply.test.tsx`, test "RD-1: ... reads as the generic
  failure, the conflicted deposit is invisible, and every retry hits it again" - PASSED on HEAD
  (`Test Files 1 passed, Tests 3 passed`). Load-bearing lines:
  `getContact -> { contactId: 'L1', type: 'landlord', req_deposit_one_month: true, req_deposit: 1400 }`;
  `applyLandlordRequirements.mockRejectedValue(new ApiError(409, 'deposit_conflict', 'deposit_conflict', { error: 'deposit_conflict' }))`;
  `expect(within(copy).getByRole('checkbox', { name: 'Deposit' })).toHaveAccessibleDescription("One month's rent")`;
  after Update: `findByText("Couldn't update the properties. Review the list and press Update again.")`;
  second Update: `applyLandlordRequirements` called twice, same sentence.
- Why it matters: a permanent, unexplained dead end on the feature's main write, with copy that
  instructs the one action that can never work; the server explicitly delegates this sentence to
  the dashboard and the dashboard does not provide it.
- Fix: in `onUpdate`'s catch, branch on `err.status === 409 && err.code === 'deposit_conflict'`
  (first request AND later batches): a dedicated notice, e.g. "This landlord's deposit is set to
  both one month's rent and a fixed amount. Fix it in Edit requirements, then press Update again."
  - and do not imply that pressing Update again alone helps. Make the state visible: in
  `formatItemValue('deposit')` render both when both are present (e.g. "One month's rent; $1,400")
  so the card shows what the server refuses. Separately (app scope, for the app reviewer): fence
  the landlord PATCH write on the deposit keys it read, as the unit PATCH does.
- Proposed regression test (fails on HEAD): in `ApplyRequirementsDialog.test.tsx`, "a first
  request answering 409 deposit_conflict names the conflict" - reject with the ApiError above and
  `expect(await screen.findByRole('alert')).toHaveTextContent(/one month's rent and a fixed amount/i)`;
  plus a `requirements.display.test.ts` case for `formatItemValue('deposit', { deposit_one_month:
  true, deposit: 1400, ... })` showing both.

### RD-2 - LOW - Requirement money compares exactly but displays rounded to whole dollars

- Confidence: CONFIRMED.
- Where: `dashboard/src/routes/listing/requirements.ts:341` (`money()` uses `formatMoney`) ->
  `dashboard/src/routes/listing/listingFormat.ts:16-19` (`Math.round(amount)`); equality is exact
  (`itemValuesEqual`, `requirements.ts` norm/compare). The forms deliberately take cents
  (`RequirementsFields.tsx` `step="any"`, planner ruling PR2-3).
- Scenario: landlord deposit 1250.40, property deposit 1250. The property Requirements card shows
  "$1,250" with the tag "Set on this property" and the line "Landlord: $1,250"; the Apply dialog
  lists "Deposit" as a change on that row; a $35.75 fee shows as "$36" on every staff surface while
  the public flyer prints "$35.75" (`FlyerPage.tsx` `applicationFeeLabel`) and a $1,250.50 deposit
  shows "$1,251" to staff and "$1250.5" to tenants.
- Proof: `src/routes/listing/zz-review-rd-money.test.ts` - PASSED on HEAD (2 tests):
  `formatItemValue('deposit', unitItemValue(unit({ deposit: 1250 }), 'deposit')) === '$1,250'`;
  `requirementDisplay(unit({ deposit: 1250 }), landlord({ req_deposit: 1250.4 }), 'deposit')`
  `=== { tag: 'set_here', landlordLine: 'Landlord: $1,250' }`;
  `applyRows([u], l, new Set(['deposit']))[0].changes === ['deposit']`;
  `formatItemValue('application_fee', ... 35.75) === '$36'`.
- Why it matters: the tags and the Apply rows exist to explain differences; here they flag a
  difference the reader cannot see, and staff and tenants read different amounts.
- Fix: a requirement money formatter that keeps cents when present (e.g.
  `toLocaleString('en-US', { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })`)
  used by `formatItemValue`, and the same formatter on the flyer's deposit / fee rows.
- Proposed regression test: `requirements.display.test.ts` -
  `formatItemValue('deposit', { deposit_one_month: null, deposit: 1250.4, ... })` is `'$1,250.40'`
  (fails on HEAD: `'$1,250'`).

### RD-3 - LOW - A stopped Apply run drops the skips of the batches that landed

- Confidence: CONFIRMED.
- Where: `dashboard/src/routes/contact/ApplyRequirementsDialog.tsx:211-213` - on a later-batch
  failure only `summarizeApply(results, units).updated` reaches the notice; the earlier batches'
  `skipped` entries are discarded.
- Scenario: 150 rows; batch 1 answers `updated` 99, `skipped [{ u0, landlord_changed }]`; batch 2
  fails. The dialog says "Updated 99 properties before this stopped. Review the rest and press
  Update again." and re-reads. A property skipped as `landlord_changed`, `deleted` or `not_found`
  is no longer in the re-read list at all, so staff never learn it was skipped or why (the
  done-path card would have listed it).
- Proof: `zz-review-rd-apply.test.tsx`, "RD-3: batch 1 skipped a property; batch 2 failed: the
  notice names the count only" - PASSED: the stopped notice above is shown,
  `queryByText(/has a different landlord now/)` and `queryByText(/skipped/)` are null.
- Fix: carry the merged skips into the stopped state (e.g. a second line "N skipped" with the
  same list the Requirements card renders), or hand them to the page via a new callback.
- Proposed regression test: the scenario above expecting
  `'1 Many St - has a different landlord now'` on screen (fails on HEAD).

### RD-4 - LOW - The New property dialog (and Edit) survive a contact change; only Apply was reset

- Confidence: CONFIRMED.
- Where: `dashboard/src/routes/contact/ContactDetail.tsx:325-359` (the contactId reset effect now
  clears `applyingFor` / `applyDone`, worklist OR-18) vs `:214` / `:1434` (`addingProperty`, and
  `editing` at `:203` / `:1325`, are never reset). The page early-returns while the next contact
  loads (`:608`), so the dialog unmounts and then RE-MOUNTS for the next contact.
- Scenario: open "+ Add a property" on landlord James Porter, then Back/Forward (or any route
  change) to tenant Bob Other: the "New property" dialog re-opens on Bob's page, locked to Bob as
  owning landlord, and the new D7 read reads Bob's record as the landlord to fill from (Create then
  fails server-side for a tenant; for another LANDLORD it would create a property under the wrong
  owner with that owner's requirements). The OR-18 comment states the rule ("a dialog opened on
  landlord A must never post for landlord B") but the branch applied it to Apply only, while
  giving this dialog a new read of the next contact.
- Proof: `src/routes/contact/zz-review-rd-contactdetail.test.tsx` (harness copied from
  `ContactDetail.test.tsx`), "opened on landlord L1, it re-opens on TENANT z99 after navigation and
  reads z99 as its landlord" - PASSED: after `NAV-TO-OTHER`, `findByRole('dialog', { name: 'New
  property' })` resolves again, `within(again).getByText('Bob Other')`, and `getContact` was called
  for `z99` at least twice (page + D7 read).
- Fix: add `setAddingProperty(false)` (and `setEditing(false)`, `setManagingPhones(false)`, etc.)
  to the same contactId reset effect; extend the OR-18 tests with the New property dialog.
- Root cause predates the branch; the D7 read is what makes the carry-over fetch and prefill.

### RD-5 - LOW - "Tour & application process" card says "No process recorded yet." while a tour process is recorded

- Confidence: CONFIRMED.
- Where: `dashboard/src/routes/listing/ListingDetail.tsx:1034-1052` - title and Edit label still
  say "Tour & application process", but D10 moved tour type / tour process to the Requirements
  card, so the body shows only `application_process` and its empty state is "No process recorded
  yet."
- Scenario / proof: the branch's own test `ListingDetail.test.tsx:343-347` ("the tour card shows
  its empty state when no application process is recorded") renders `READY.unit`, whose
  `tour_process` is 'Text the landlord to arrange access.' (`ListingDetail.test.tsx:114`), and
  asserts the card reads "No process recorded yet." - re-run:
  `npx vitest run src/routes/listing/ListingDetail.test.tsx -t "the tour card shows its empty state"`
  -> `1 passed | 133 skipped`.
- Why it matters: staff reading the card that is named for the tour process are told none is
  recorded.
- Fix: retitle the card "Application process" (and its CardAction label "Edit application
  process"), or keep the title and replace the empty state with a pointer ("Tour type and process
  are under Requirements > Touring").

### RD-6 - LOW - Circular import between the requirements mirror and listingFormat

- Confidence: CONFIRMED (static): `dashboard/src/routes/listing/requirements.ts:28` imports
  `formatMoney` from `./listingFormat.js`; `dashboard/src/routes/listing/listingFormat.ts:13`
  imports `WASHER_DRYER_LABELS` from `./requirements.js`.
- Scenario: it works today only because neither module uses the other's export at module
  evaluation time. Any future top-level use (a label map in listingFormat built from
  `WASHER_DRYER_LABELS`, a constant in requirements built with `formatMoney`) throws a TDZ
  ReferenceError for whichever importer evaluates second - and the public `/p/:unitId` page
  (`FlyerPage.tsx:28` imports `requirements.ts`) is one of the entry points. It also contradicts the
  module's header: `requirements.ts` is "the dashboard's HAND MIRROR of app/src/lib/requirements.ts",
  yet now carries the dashboard-only D6 display section and depends on page formatting.
- Fix: move the D6 display half (`formatItemValue`, `requirementDisplay`, `landlordHasNoRequirements`,
  `requirementItemsByGroup`, `WASHER_DRYER_LABELS`) into e.g. `requirementsDisplay.ts`, or move
  `formatMoney` to a leaf module, so the mirror stays a leaf like its app counterpart.

### RD-7 - LOW - The Apply result is a live region mounted with its text already in it

- Confidence: PLAUSIBLE (assistive-technology behavior, not unit-testable).
- Where: `dashboard/src/routes/contact/LandlordRequirementsCard.tsx:65` - `<div role="status">` is
  created together with "Updated N properties" when the dialog closes.
- Scenario: a screen-reader user presses Update; the dialog closes and focus returns to "Apply to
  properties". A live region announces CHANGES to its content; one inserted already populated is
  not announced by several screen-reader / browser pairs (VoiceOver, JAWS), so the outcome -
  including "N skipped" - may go unspoken.
- Fix: keep an always-mounted (initially empty) `role="status"` container in the card and fill it,
  or move focus to the result block (`tabIndex={-1}`) after onDone.

### RD-8 - LOW - "Clears" marker fails AA text contrast

- Confidence: CONFIRMED (computed): `dashboard/src/routes/contact/ApplyRequirementsDialog.module.css:103-106`
  `.clears { color: var(--c-warning) }` = #b06a00 on the dialog's #ffffff, 13px (`--fs-sm`)
  semibold: relative luminance 0.195, contrast 4.28:1 < 4.5:1 required for text under 18.66px bold.
- Why it matters: "Clears" is the only visible warning that checking that item ERASES values on
  the checked properties.
- Fix: use a darker text color for small warning text - the existing `--c-evt-amber-text`
  (#92400e) is 7.1:1 on white - or render "Clears" at body color beside an icon. `--c-warning` is
  shared with other small-text uses (AudienceFilters, RecipientPreview), so a token-level fix
  covers them too.

### RD-9 - LOW - Name copy for a nameless or company-only landlord

- Confidence: CONFIRMED.
- Where: `dashboard/src/routes/listing/PropertyRequirementsCard.tsx:47` builds the name with
  `contactDisplayName(firstName, lastName, landlord.phone)` - the legacy single `phone`, never the
  primary of `phones[]` (which `UnitCreateForm.tsx` `landlordLabel` uses) and never `company`.
- Proof: `src/routes/listing/zz-review-rd-name.test.tsx` - PASSED: a landlord
  `{ company: 'Kim Realty', phones: [{ phone: '+14045550100', primary: true }] }` renders
  "Unknown contact has no requirements recorded yet." The New form's note reads the same way
  ("Filled in from <phone>'s requirements." for a phone-only landlord).
- Fix: one landlord display-name helper (name, else company, else primary phone) shared by the
  card, the New form note and the loading / failure lines.

### RD-10 - INFO - An Apply run keeps POSTing after its dialog unmounts

- Confidence: CONFIRMED.
- Where: `ApplyRequirementsDialog.tsx:205-207` - `liveRef` is checked only in the catch and after
  the loop; nothing stops the loop between batches and the requests carry no signal.
- Proof: `zz-review-rd-apply.test.tsx`, "RD-4: unmount during a multi-batch run ... keeps POSTing
  the remaining batches after the dialog is gone" - PASSED: 250 rows, first batch held, `unmount()`,
  release -> `applyLandlordRequirements` called 3 times, `onDone` never.
- Note: Cancel is disabled while sending, so continuing may be intended ("an Update cannot be
  interrupted"); if so, say it in the comment at `:126`. Either way nothing reports what the
  remaining batches did (the page that would show "Updated N" is gone). Reachable through
  browser Back/Forward during a long run.

### RD-11 - INFO - Create now waits on an untimed read

- `dashboard/src/routes/listing/UnitCreateForm.tsx:201` - `canCreate` requires `landlordRead !==
  'loading'`; the read has no timeout and no Try again while loading (Try again appears only after
  a failure). A stalled `getContact` leaves the locked New property form unable to create until it
  is closed and reopened. Before the branch Create never waited on this read. Consider a timeout
  that falls into the existing 'failed' state.

### RD-12 - INFO - Stale doc on `UnitActivityEvent.reason`

- `dashboard/src/api/types.ts:3390-3394` still documents `reason` as "unit_primary_contact_assigned
  only"; `listingFormat.ts:261` now reads it on `unit_updated` (`requirements_applied`, D13), as the
  server projection does (`app/src/routes/units.ts:383-390`).

### RD-13 - INFO - A deleted landlord's page still offers Apply to properties

- `ContactDetail.tsx:1217-1220` passes `onApplyRequirements` regardless of `deleted` (`:675`), while
  the relay create action is withheld on deleted files as "a restore-first page" (`:676-685`); the
  Apply route does not refuse a soft-deleted landlord either (`contactRequirementsApply.ts:146-152`
  checks existence, pointers and type only). Add a property and Edit behave the same way today, so
  this is a product decision to confirm, not a regression.

### RD-14 - INFO - Gate 5 (lint) exit 1 is pre-existing

- `.superpowers/gates/final/5-lint.log`: 5 `react-hooks/*` errors at `BroadcastComposer.tsx:426`,
  `:445`, `useComposerDraft.ts:155`, `FlyerPage.tsx:177`, `:195` - all on lines this diff does not
  change; the first three match `docs/issues/lint-backlog-repo-wide.md` (2026-10-19 status). RD did
  not re-run the merge-base baseline comparison AGENTS.md asks for; whoever signs gate 5 should.

## Checked and found sound (no finding)

- Composer D12: `AudienceFilters.toggleSize` / `setAuthorities`, the derived `filter` memo keyed by
  `sizesKey`, `onFilterChange` edit detection, `useComposerDraft.materialKey` (sizes list), and
  every reader of a filter (`audienceSummary` -> list rows and results header) go through
  `bedroomSizesOfFilter`; the client never sends legacy `bedroomSize`; the server accepts both
  (`app/src/routes/broadcasts.ts:221-243`), so the e2e specs that still POST `bedroomSize: 2`
  directly keep working.
- StrictMode: the Apply dialog read, the New form D7 read (pinned by its own test) and the new
  `useListing` landlord re-read all abort on cleanup and ignore the dropped first-mount request.
- `useListing` re-read: `landlordForId` + the `prev.unit?.landlordId === wanted` guard handles
  A -> B -> A, a cleared landlord and a failed read without loops; `ListingDetail` compares only
  with the landlord of record (`requirementsLandlord`, `:373`).
- Apply request body vs server: `ownItems` (own values among CHANGES only) matches
  `planUnitApply`'s own-value check (`app/src/lib/requirements.ts:456-462`); `getAllUnits({
  landlordId })` hits the existing byLandlord GSI, whose projection is ALL
  (`infra/modules/dynamodb/main.tf:57`), so the dialog compares full records.
- Public flyer: renders only projected keys via text nodes (no HTML sinks); subzone is gone from
  the neighborhood line and the `?cta=text` SMS body; `washer_dryer` is enum-guarded server-side
  (`app/src/lib/unitFields.ts:511`). The page now hard-depends on `voucher_sizes` / `pet_fee` being
  present (`textOrNull(undefined)` would throw), which is safe because the dashboard ships inside
  the app image (`Dockerfile:66`), so a new page never meets an old API; an old page meeting the new
  API still reads `voucher_size` / string `pets`.
- Labels and names: every tagged field keeps its label as the accessible name with the tag as the
  description (`TaggedField`, `TaggedCheckbox`, `OrgPicker labelAside`, `ContactSearchField
  describedBy`, `VoucherSizePicker` group); the More / Fewer sizes toggle keeps focus (same element);
  added lines in dashboard/ and e2e/ are ASCII-only (`git diff 3df43172 HEAD -- dashboard e2e`).
- e2e: the new spec is run-unique (no seeded landlord is ever Applied), asserts absences only after
  a positive load assertion, and the gate ran it green (`property-requirements.spec.ts:195`, `:454`).

## Consumer / mutator sweep

Whole-tree greps of `dashboard/src` and `e2e/` (non-test and test files) for every state, field,
route, prop and helper the diff touches.

| Touched thing | Writers found (file:line) | Readers found (file:line) | Verdict |
|---|---|---|---|
| `AudienceFilter.bedroomSizes` / legacy `bedroomSize` | `AudienceFilters.tsx:145` toggleSize, `:157` setAuthorities; `BroadcastComposer.tsx:223` filter memo, `:302` onFilterChange; e2e direct POSTs with legacy `bedroomSize`: `broadcasts.spec.ts:152`, `:360`, `a2p-compliance.spec.ts:530`, `landlord-activity.spec.ts:85`, `listing-activity.spec.ts:105`, `:186`, `send-outcome-cards.spec.ts:117` | `broadcastFormat.ts:59` bedroomSizesOfFilter -> `audienceSummary` -> `BroadcastsList.tsx:48`, `BroadcastResults.tsx:209`; `AudienceFilters.tsx:141`; `useComposerDraft.ts:111`; server `broadcasts.ts:221-243` | OK - one reader, both shapes |
| `propertyVoucherSize` -> `propertyVoucherSizes` prop, `bedroomPhrase` (removed) | `BroadcastComposer.tsx:208` | `AudienceFilters.tsx` only; no remaining `bedroomPhrase` reference | OK |
| `UnitItem.voucher_size_accepted` (number or list) | `ListingEditForm.tsx:206-207`, `UnitCreateForm.tsx:312`; e2e `steps.ts:1743-1748` (API, a number), `property-requirements.spec.ts` createC (list) | `listingFormat.ts:106` acceptedVoucherSizes (composer prefill `BroadcastComposer.tsx:208`, Properties list via `useListings`), `:124` recordedVoucherSizes (`ListingDetail.tsx:975`), `requirementForm.ts` splitVoucherSizes (`ListingEditForm.tsx:106`) | OK |
| `UnitItem.pets` (string or legacy boolean), `no_pets`, `pet_fee` | `ListingEditForm.tsx:211` / `UnitCreateForm.tsx:315` via requirementForm; server Apply | `requirements.ts:178-187` unitItemValue (all unit readers); `ContactEditForm.tsx:268/435` and `EligibilityIntakeCard.tsx:75` read the TENANT contact's `pets` (different record) | OK |
| `deposit`, `deposit_one_month`, `deposit_flexible`, `deposit_notes`, `application_fee` | forms via `buildRequirementPatch` / `buildRequirementCreateFields`; landlord form `ContactEditForm.tsx:376-380` | `requirements.ts:341`, `:361-369` formatItemValue (card, landlord card, Apply dialog); `FlyerPage.tsx` depositLabel / applicationFeeLabel | RD-1 (both-forms state hidden), RD-2 (rounding) |
| `tour_type`, `tour_process` (now the Touring item) | forms (RequirementsFields), server Apply (can copy or clear) | `ScheduleTourForm.tsx:247-253`, `:291` (prefill), `Card.tsx:228` interestedModeOf, `TourDetail.tsx:716`, `PropertyRequirementsCard` | OK - an Apply that clears Touring flips Interested to the form path, by design; RD-5 for the old card |
| `subzone` | `ListingEditForm.tsx:179`, `UnitCreateForm.tsx:294` | `ListingDetail.tsx:403`, `:980`; no public reader left (`FlyerPage` neighborhood is area-only); server `similarUnits.ts:52-57` | OK |
| `washer_dryer` | forms | `ListingDetail.tsx:981` (guarded washerDryerLabel), `FlyerPage.tsx:270` (server-guarded enum) | OK |
| `requirement_sources` | server only (no dashboard writer - grep) | `requirements.ts` readRequirementSources (card, applyRows) | OK |
| `Contact.req_*` | `ContactEditForm.tsx:376-380` (toLandlordPatch); e2e API PATCH in `property-requirements.spec.ts` | `landlordItemValue`: `LandlordRequirementsCard`, `PropertyRequirementsCard` (requirementDisplay), `ApplyRequirementsDialog`, `UnitCreateForm` prefill + snapshot, `ContactEditForm` baseline | OK - except RD-1 |
| `getUnits` / `getAllUnits` `landlordId` param | - | only `ApplyRequirementsDialog.tsx:141`; other callers (`BroadcastComposer.tsx:374`, `useContactFile.ts:158`, `useListing.ts:226`, `useListings.ts:35`, `PlacementCreateForm.tsx:143`, `usePlacements.ts:79`, `ScheduleTourForm.tsx:197`) unchanged; server `units.ts:855-860` | OK |
| `createUnit(body: CreateUnitBody)` | `UnitCreateForm.tsx:352` (only caller) | server `units.ts` POST (snapshot split, landlordId match check `:892`) | OK |
| `Modal variant='wide'` | `ApplyRequirementsDialog.tsx:235` | `Modal.tsx` special-cases only 'media'; `data-modal-variant` read only by `Modal.test.tsx` | OK |
| `CardAction disabled / describedBy` | `LandlordRequirementsCard.tsx:45` | `Card.tsx`; `.asideBtn:disabled` style | OK |
| `ContactSearchField describedBy`, `OrgPicker labelAside / describedBy` | `UnitCreateForm.tsx:422`, `:452-459`, `:496-503`; `ListingEditForm.tsx:332-339`, `:376-383` | other OrgPicker / ContactSearchField callers pass neither (pinned by the two PIN tests) | OK |
| `unitRowLabel` -> `propertyRowLabel` | - | `LandlordFile.tsx:211`, `ApplyRequirementsDialog.tsx:326`; same output as before (formatAddress includes line2) | OK |
| `useListing().landlord` (+ `landlordForId`) | `useListing.ts` load and the new re-read effect | `ListingDetail.tsx:373-380` (guarded), PropertyRequirementsCard, Contacts fallback row | OK |
| `ContactDetail` `applyingFor` / `applyDone` | `:1217-1220`, `:1449-1460`, reset `:357-358` | `:1222`, `:1449` | OK; RD-4 for the dialogs it did not reset |
| `UnitActivityEvent.reason` | server projection `units.ts:383-390` | `listingFormat.ts:261` | RD-12 (doc) |
| `PublicFlyer` shape (subzone out; voucher_sizes, no_pets, pet_fee, deposit_one_month, deposit_flexible, washer_dryer in) | server `unitFields.ts:420-511` | `FlyerPage.tsx` only (`HousingFairIntake.tsx:48` imports its CSS module, not the type) | OK |
| e2e labels changed by the forms (`Voucher size accepted`, bare `Notes` / `Pets` / `Deposit` / `Application fee`, `Tour type`) | - | `steps.ts:930`, `:1184`, `contact-detail.spec.ts:63`, `:77` are TENANT forms (no requirements fieldset); `tours-page.spec.ts:329`, `send-outcome-cards.spec.ts:266` `getByLabel('Tour type')` still unique; `public-pages.spec.ts:239-245` flyer rows still match | OK - the full gate run is green |
