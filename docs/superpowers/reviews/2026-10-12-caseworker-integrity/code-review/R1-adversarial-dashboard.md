# R1 adversarial code review - dashboard + e2e (fix/caseworker-integrity)

Reviewer: adversarial, round 1, the dashboard/ and e2e/ half, PLAN-BLIND
(nothing under docs/superpowers/ was opened; this file is the only thing
written there). Package: `.superpowers/review/r1-dashboard.diff`, base
196076584d3f, head f11e46fb. Wire shapes were read from the worktree's app
routes: `app/src/routes/units.ts`, `contacts.ts`, `tours.ts`, `placements.ts`,
`statusTransition.ts`, `app/src/services/contactTypeGuards.ts`,
`contactHoldings.ts`, `suggestionResolution.ts`, `app/src/lib/rosterResolution.ts`.

Gate context: the orchestrator's p3 battery finished green before any probe ran
(typecheck exit 0, npm test exit 0, smoke exit 0, e2e exit 0 - 345 passed in
22.5m). Probes ran one vitest file at a time from `dashboard/`. Every throwaway
file was deleted and every mutant reverted byte-identically (Probe log below).

Counts: BLOCKER 0, HIGH 0, MEDIUM 1, LOW 5, INFO 5.

---

## Findings

### 1. MEDIUM - CONFIRMED - the ownerless remove-the-primary notice names the wrong remedy

Location: `dashboard/src/routes/listing/ListingDetail.tsx:513-521`
(`promotionNotice`, sentence at :520, doc comment at :506-512); the Add path
`ListingDetail.tsx:528`; mirrored verbatim in `e2e/support/selectors.md:85` and
pinned by `ListingDetail.test.tsx:1728` and `:1749`.

The new copy says an ownerless property's calls and new relay groups "will
reach no one until a contact is added". The server's property-contact rule is
`primary row ?? landlordId` (`app/src/lib/rosterResolution.ts:292-294`, same
rule `app/src/lib/tourContacts.ts:124-129`, `app/src/services/rosterProvision.ts:233,525`).
Adding a contact does not satisfy it: "+ Add contact" always writes
`primaryContact: false` (`ListingDetail.tsx:528`), so unless the new row's role
is Landlord (which claims the vacant slot, `units.ts:1137-1143`,
`unitsRepo.ts:797,847`) nobody becomes reachable. A contact ALREADY on the list
is just as unreachable, yet the copy implies the list is empty.

Scenario: a property restored without a landlord (the new restore path makes
these on purpose) with Alicia (pm, primary) and Dana (pm). Staff remove Alicia;
the confirm reads "...reach no one until a contact is added." Dana is right
there and still unreachable; staff add Renata as PM as told; the POST is
`{ contactId, role: 'pm', primaryContact: false }`; the property still has no
primary and no landlordId, so masked calls and new relay groups for its tours
silently reach no one.

Proof: `listing/zz-review-advd-ownerless.test.tsx` test "says until a contact
is added, though Dana is already on the list..." passed on the branch: the
dialog shows that sentence with Dana on the roster, and the follow-up Add posts
`{ contactId: 'pm9', role: 'pm', primaryContact: false }`.

Rated MEDIUM, not LOW: it is new operational guidance for a routing outage
state this branch makes reachable through a supported UI path, and it points
staff at an action that does not end the outage.

Fix: name the real remedies, e.g. "This property will have no primary contact
and has no landlord of record, so calls and new relay groups for it will reach
no one until someone on its contact list is made the primary contact or a
landlord is added." Update the doc comment, selectors.md:85 and the two pinned
tests. Regression test: the ownerless notice test asserting the new sentence
(fails on the old copy).

### 2. LOW - CONFIRMED - "so they must STAY a landlord" is shown to contacts that are not landlords

Location: `dashboard/src/lib/holdingRefusals.ts:35-36` (TYPE_CHANGE_LANDLORD_SENTENCE),
used by `typeChangeRefusalCopy` (`holdingRefusals.ts:70-79`), rendered by
`TypeChangeRefusalList` at `UnknownFile.tsx:158` and `ContactEditForm.tsx:609`.

The server refuses EVERY result type other than landlord for a live unit's
landlord of record, whatever the stored type (`app/src/services/contactHoldings.ts:137-141`).
So the refusal reaches contacts that are not landlords now: every Unknown card
triage (unknown -> Tenant / Partner) of a landlord of record, and the edit form
of a landlord of record typed tenant or partner. Those records exist: the
importer bypasses the type rules (`docs/issues/import-bypasses-contact-type-rules.md`),
and RUNBOOK says pre-deploy records that break the rules stay (L2) and sends
staff to the contact page to change types back. For them "must stay a landlord"
is false and confusing (an Unknown contact is told it must remain something it
never was). The branch's own `ContactDetail.test.tsx:595` pins this sentence on
an Unknown contact.

Proof: `contact/zz-review-advd-landlord-copy.test.tsx` - both cases passed on
the branch: the Unknown card of a `type: 'unknown'` contact, and the edit form
of a `type: 'tenant'` contact refused `landlord_of_record`, each show "so they
must stay a landlord".

Fix: a type-neutral sentence, e.g. "This contact is the landlord of record for
a property, so they can only be a landlord. Changing a property's landlord
isn't available in the dashboard yet." (or pass the stored type and choose
"stay" only when it is landlord). Regression test: UnknownFile with a
landlord_of_record refusal must not contain "stay".

### 3. LOW - CONFIRMED - the restore dialog closes as a success when the server ignored the choice

Location: `dashboard/src/routes/listing/RestoreLandlordDialog.tsx:65-66`
(`.then((unit) => onRestored(unit))`), `ListingDetail.tsx:1403-1406`.

The restore route re-decides at click time and honors `{ landlordId }` "ONLY
when the plain restore would refuse (otherwise ignored)" (`app/src/routes/units.ts:1598-1599`,
`:1624-1647`). If the stored landlord became a landlord again (or someone else
restored the property) between the 409 and the click, "Restore without a
landlord" or "Restore with this landlord" (Nora) runs the PLAIN restore and
answers 200 with the OLD landlord of record. The dialog closes; nothing tells
staff their explicit choice was not applied. Related: after a
`unit_roster_conflict` re-read that is still deleted (`ListingDetail.tsx:1407-1421`)
the dialog keeps the original `landlordName` sentence even if the stored
landlord changed.

Proof: `listing/zz-review-advd-ownerless.test.tsx` test "Restore without a
landlord answered WITH the old landlord closes as a success and says nothing"
passed: `restoreUnit` called with `('u1', { landlordId: null })`, answered with
`landlordId: 'll1'`; dialog gone, `setUnit` applied the old owner, no alert,
James Porter still on the Contacts card.

Fix: in `run`, compare the answer with the request (null -> `unit.landlordId`
absent; an id -> equal); on a mismatch close and show a page notice that names
the outcome (e.g. "Restored - James Porter is a landlord again and stays its
landlord."). Regression test: the probe above, asserting that notice.

### 4. LOW - CONFIRMED - any other plain-restore failure is still a dead click

Location: `dashboard/src/routes/listing/ListingDetail.tsx:369-379` (the catch
this diff rewrote; `:378` keeps the swallow); the new W7 pins
(`ListingDetail.test.tsx:1381`) assert only "no dialog".

Pre-existing silence, but the diff rewrote this exact catch and the same
request already has a sentence one file over (`RESTORE_FAILED_COPY`,
`RestoreLandlordDialog.tsx:22`). A 404 or 500 on the banner Restore re-enables
the button with no message - indistinguishable from a click that did nothing.

Proof: `listing/zz-review-advd-ownerless.test.tsx` test "a 500 on the banner
Restore is a dead click" passed: `restoreUnit('u1')` rejected 500, Restore
re-enabled, no `alert`, no dialog.

Fix: show "Couldn't restore - please try again." as a `role="alert"` in the
deleted banner for any failure other than restore_needs_landlord (share the
constant); extend the W7 `it.each` to assert it.

### 5. LOW - CONFIRMED - the restore dialog swallows a failed landlords read

Location: `dashboard/src/routes/listing/RestoreLandlordDialog.tsx:47-58`
(catch with the "Non-fatal" comment at :54-55).

If `getAllContacts({ type: 'landlord' })` fails, the picker is silently empty:
typing a real landlord's name shows no option (the field renders no list for
zero matches) and nothing says the list did not load. "Restore with this
landlord" stays disabled and the only live action is "Restore without a
landlord" - which produces exactly the unreachable-calls state of finding 1.
(UnitCreateForm.tsx:151-153 has the same silent catch, but a locked landlord
still submits there; here there is no fallback.)

Proof: `listing/zz-review-advd-restore-dialog.test.tsx` passed:
`getAllContacts` rejected 500, typing "Nora" showed no `option`, no `alert`,
"Restore with this landlord" disabled, "Restore without a landlord" enabled.

Fix: keep a load-error state and render "The landlord list did not load -
close and try again." as `role="alert"` (or a Retry). Regression test: the probe
with the assertion inverted.

### 6. LOW - CONFIRMED (mutants) - the Unknown card's two contact-isolation guards are unpinned

Location: `dashboard/src/routes/contact/ContactDetail.tsx:686` (onTriage's
`if (generation !== reviewGenerationRef.current) return;`) and `:292` (the
contactId effect's `setTriageError(null)`).

Both behaviors are correct on the branch, but no test fails without them:
- M1, drop :686 -> `ContactDetail.test.tsx` 125/125 pass (survives). With M1,
  contact A's refusal that lands after navigating to contact B renders on B's
  Needs triage card.
- M2, drop :292 -> 125/125 pass (survives). With M2, A's refusal stays on the
  card after navigating to B.

Proof: `contact/zz-review-advd-triage-nav.test.tsx` (the existing
`renderWithNavToOther` pattern, `ContactDetail.test.tsx:2391`, with an Unknown
second contact): both cases pass on the branch; M1 fails case 1 ("expected
<div role=alert> to be null"); M2 fails case 2. Fix: add those two cases.

### 7. INFO - CONFIRMED (mutant) - the edit form's per-save refusal reset is unpinned

Location: `dashboard/src/routes/contact/ContactEditForm.tsx:498`
(`setTypeRefusals(null)` at submit start). M3 (drop it) -> `ContactEditForm.test.tsx`
75/75 pass. Without it a retry that fails for another reason shows the old
refusal list beside "Couldn't save - please try again.". Proof:
`contact/zz-review-advd-editform-retry.test.tsx` passed on the branch, failed on
M3 (the stale `<li>` stayed). Fix: add that case.

### 8. INFO - CONFIRMED (mechanism) - the restore dialog is not bound to the property it opened for

Location: `dashboard/src/routes/listing/ListingDetail.tsx:218` (`restoreNeeds`);
ListingDetail has no unitId reset and the route element is not keyed
(`dashboard/src/App.tsx:271`), so the instance survives an in-place
`/listings/A -> /listings/B` move.

Proof: `listing/zz-review-advd-restore-nav.test.tsx` passed: the dialog opened
on deleted u1 (James) stayed open after navigating to live u2, still read
"James Porter is no longer a landlord", and "Restore without a landlord" posted
`restoreUnit('u2', { landlordId: null })`. Reachable only by a history move
(browser Back/Forward) while the modal is open; on a live B the server ignores
it (`units.ts:1602-1604`), on a deleted B that needs a landlord it would
restore B ownerless from A's dialog. The pre-existing sibling `confirmingDelete`
(`ListingDetail.tsx:214`) has the same shape with worse stakes (a "Delete
property?" opened on A deletes B) - not introduced here. Fix: reset
per-property dialog state on a unitId change (or key the element by unitId).

### 9. INFO - two new unit tests drive a refusal down a path the server never refuses

- `TourDetail.test.tsx:2351` (Mark toured refused contact_not_tenant): runDirect's
  only callers, markToured and markNoShow, run only on SCHEDULED tours
  (`TourDetail.tsx:334`, `:644-649`); the server checks the tenant only when
  reviving a CANCELED tour (`app/src/routes/tours.ts:1404`). The mapping at
  `TourDetail.tsx:383` is defensive and this test pins an impossible wire.
- `PlacementsPage.test.tsx:186` moves collect_rta -> Review RTA (open to open),
  which is never refused. The reachable path is a Closed-view row (the
  StageMenu is on every row, `PlacementsPage.tsx:206-213`) moved out of Lost.
Neither test is ineffective (each still fails if its call site drops the
mapping). Fix: drive the PlacementsPage case from a lost row (`?view=closed`);
label or drop the TourDetail runDirect case.

### 10. INFO - CONFIRMED (existing test) - restore copy for a stored landlord that no longer exists

Location: `RestoreLandlordDialog.tsx:83,113`; server `units.ts:1625-1628`
(`current === undefined` -> needsLandlord, no name). A missing contact gets
"This property's landlord is no longer a landlord, so they can't stay..." -
it is gone, not re-typed. Pinned by `RestoreLandlordDialog.test.tsx:63`. Rare
(contacts soft-delete and getById still returns them). Fix: neutral copy
("This property's landlord can't stay its landlord. Choose its landlord:").

### 11. INFO - CONFIRMED (existing test) - a non-tenant's tenant-fact chip offers an Accept that can only be refused

Location: `ContactDetail.tsx:844` routes a non-tenant's housing authority chip
to the plain accept; every TENANT_ONLY target (`app/src/services/extraction/runTypes.ts:28-30`)
on a team member's TenantFile now answers 409 suggestion_contact_not_tenant.
The branch's test `ContactDetail.test.tsx:2598` shows Accept pressed and
refused. Such chips predate a re-type (open issue
`stale-suggestions-survive-contact-retype`). Optional: hide Accept for
TENANT_ONLY targets on a non-tenant and keep Dismiss.

---

## Swept and clean

- `UnitItem.landlordId` made optional - every consumer guards absence:
  `useListing.ts:118-124,180`, `buildListingFile.ts:64-65,97-100`,
  `useTour.ts:96-97`, `TourDetail.tsx:202`, `PlacementDetail.tsx:188,228`,
  `buildContactFile.ts:19`, `useContactFile.ts:168`, `ListingDetail.tsx:308`.
  Grepped for the forms the typecheck cannot see (template literals,
  `encodeURIComponent(unit.landlordId)`, Link targets): none.
- `restoreUnit(unitId, opts?)` - one caller (ListingDetail: banner, header
  button and kebab "Restore property" all go through `onRestore`); the body
  matches `units.ts:1605-1613`; endpoints.test pins no-body vs `{ landlordId }`.
- `contactTypeErrorMessage` at its 9 call sites - each endpoint returns those
  codes only with the contact-type meaning (`units.ts:1132-1143,1496-1507,1658-1666`,
  `tours.ts:352-357,1404-1411,1691-1699`, `placements.ts:578,674`,
  `statusTransition.ts:334`); no pre-existing code at those sites collides;
  every site keeps its own fallback (PlacementDetail's rethrow chain still
  reaches "That move was rejected"); `runRosterWrite` maps before its 409
  catch-all and correctly skips the settle re-read.
- `failureCopy` (TourModals) - all six dialogs consult it; only Reschedule
  (revive) and Reopen can receive these codes; every other 409 still reads
  TOUR_CHANGED_COPY. `confirmOutcome` move-forward: the from-tour refusal lands
  in the header alert after the outcome saved and the modal still closes.
- Suggestions - `suggestionResolutionErrorMessage` has one consumer
  (ContactDetail); the refetch set matches the server's emit set
  (`suggestions.ts:219-228`); the tenant-only check runs before the D8
  housing-authority check (`suggestionResolution.ts:820-833`), so a team
  member's plain accept gets suggestion_contact_not_tenant, not org_not_on_list;
  `types.test.ts` SERVER_CODES covers both new codes.
- `CaseworkerDialog.refusalCopy` refactor - output byte-identical (pinned by
  `holdingRefusals.test.ts`); `isRefusal` untouched. `ROSTER_RETRY_COPY` move -
  no other importer.
- Add contact caseworker filter - `isCaseworkerContact` mirrors the app's
  `isCaseworker` (pinned by `caseworkerRoleMirror.test.ts`); useContacts rows
  carry `role` (proved live by the property-roster e2e positive control); a
  caseworker already seated keeps its role select (server allows, `units.ts:1131`).
- Type writes - only ContactEditForm and ContactDetail.onTriage PATCH a type
  (`updateContact` / `patchForSuggestedContactKind` grep; KindPicker only
  computes); both now render type_change_refused.
- Creation pickers are type-filtered (`ScheduleTourForm.tsx:180`,
  `PlacementCreateForm.tsx:126` tenants; `UnitCreateForm.tsx:144` and the
  restore dialog landlords, deleted excluded by default, `endpoints.ts:1326-1343`);
  no other createTour / createPlacement / transitionPlacement / reopenTour
  caller; `ToursPage.tsx:478` marks scheduled tours only (never a revive).
- TenantFile is the only contact-page entry to Schedule / Start placement
  (LandlordFile, PartnerFile, UnknownFile and the header kebab have none).
- Security - every new URL is a fixed prefix plus `encodeURIComponent(id)`
  (`holdingRefusals.ts`); `landlordName` and all server strings render as React
  text; no `dangerouslySetInnerHTML`, no data-built hrefs.
- e2e - each new spec asserts the server's own answer (status and body) beside
  the UI assertion, so none passes if the server stops refusing; the caseworker
  absence check has a positive control; selectors are scoped to dialogs and
  the deleted banner; the 4 changed specs passed in the full p3 run.
- A11y - both new dialogs reuse Modal (role=dialog, aria-modal, labelled by the
  title); every new error is `role="alert"`; the disabled "Restore with this
  landlord" sits under its "Choose its landlord:" prompt.
- StrictMode / double submit - the dialog's read aborts on cleanup; `run` and
  `onRestore` guard on busy and disable their buttons.

---

## Probe log

sha256 (dashboard/src/routes/contact):
- ContactDetail.tsx baseline 35d9a13fd0abebbf005584f2e1bba1b7f1a068c11a04f0c395d7c8868db12d8f;
  M1 (drop :686) c28dc292...; reverted 35d9a13f... ; M2 (drop :292) 0e9cd547...;
  reverted 35d9a13f... .
- ContactEditForm.tsx baseline e1350aaa489ba4956143b8e58fce5b01a2778c6cc9ec391ec4926e3b98634b70;
  M3 (drop :498) e0dac209...; reverted e1350aaa... .
- `git diff` empty after every revert.

Throwaways (all deleted by exact name; none committed):
- contact/zz-review-advd-landlord-copy.test.tsx - 2/2 pass (finding 2).
- contact/zz-review-advd-triage-nav.test.tsx - 2/2 pass; M1 fails case 1, M2
  fails case 2 (finding 6).
- contact/zz-review-advd-editform-retry.test.tsx - 1/1 pass; M3 fails (finding 7).
- listing/zz-review-advd-ownerless.test.tsx - 3/3 pass (findings 1, 3, 4).
- listing/zz-review-advd-restore-dialog.test.tsx - 1/1 pass (finding 5).
- listing/zz-review-advd-restore-nav.test.tsx - 1/1 pass (finding 8).

Existing suites run against mutants: ContactDetail.test.tsx (125/125 under M1
and under M2), ContactEditForm.test.tsx (75/75 under M3).
