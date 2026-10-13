# Final review - adversarial, plan-blind (fix/caseworker-integrity)

Reviewer: plan-blind adversarial code reviewer (Claude Opus 5.5).
Scope: `git diff main...HEAD` source and tests only (app/, dashboard/, e2e/).
I did not read docs/superpowers/, docs/issues/, RUNBOOK.md, or commit bodies.
I ran nothing. No tests, no servers, no DynamoDB. I used git read commands and
grep only. Line numbers are from the branch tip as checked out in
W:\tmp\caseworker-integrity.

Ranked by consequence if shipped. No BLOCKING or HIGH findings: the core
conditional writes (addContact per-attempt rules, restoreWithLandlord's
landlordId + contacts[] + deleted_at condition, the effectiveGuard fence)
hold up under the interleavings I walked. They are listed under "Checked and
held" at the end.

---

## 1. [MEDIUM] Re-running the importer puts back the landlord that "Restore without a landlord" removed

Evidence:
- `app/src/repos/unitsRepo.ts:1315`: restoreWithLandlord with `next: null`
  REMOVEs `landlordId`, so a live, ownerless property is now an intended
  state that this branch creates on purpose.
- `app/src/lib/import/apply.ts:1513-1519`: upsertUnit matches the landlord
  by the IMPORT PLAN's `p.suggestedType === 'landlord'` and by name. It never
  reads the contact's stored type.
- `app/src/lib/import/apply.ts:1542-1552`: any unit carrying `updated_at`
  takes the human-owned branch. A restored unit always carries it. That
  branch writes `landlordId = if_not_exists(landlordId, :landlordId)`.
- `package.json` defines `import:apply:dev` and `import:apply:prod`, so this
  is a re-runnable production script.

Failure scenario: L is the imported landlord of property U. Staff retype L to
tenant (stamped `type_source: manual`; the importer keeps that type). To do
it they soft-delete U, retype L, then restore U with "Restore without a
landlord". The next import run finds U has no `landlordId` attribute and
`if_not_exists` writes L back. U is now LIVE with a landlord of record typed
tenant, which is exactly the state I3 and the restore fence exist to prevent.
The contact list is not updated either: L has no row, and the auto-primary
and sole-landlord rules never run. placementNudges routes landlord rungs to
`unit.landlordId` (`app/src/jobs/placementNudges.ts:436-443`), so L, now a
tenant, starts receiving landlord nudges for U.

This may overlap a filed importer issue. I can see only its filename in the
diff stat (import-bypasses-contact-type-rules); I did not read it. The
specific interaction (the importer undoing a deliberate ownerless restore)
is new with this branch.

Suggested fix: in the human-owned branch, drop `landlordId` from the
`if_not_exists` facts entirely. A unit a human has touched never gets its
owner from the import. If that is too strong, at least require the matched
contact's STORED type to be `landlord`, using a consistent read before the
write.

## 2. [MEDIUM] The restore dialog's explicit landlord choice is silently dropped, and the request answers 200

Evidence:
- `app/src/routes/units.ts:1723-1764`: `landlordId` in the body is honored
  only when `needsLandlord` is true. Otherwise the route does a plain
  `units.restore(unitId)` (`:1750`), appends a `unit_restored` audit
  (`:1758`), and answers 200.
- `app/src/routes/units.ts:1738-1744`: `needsLandlord` is computed only when
  the unit is STILL soft-deleted and its stored landlord is not typed
  landlord.
- `app/src/repos/unitsRepo.ts:862-876`: `restore` is unconditional
  (`attribute_exists(unitId)` only).
- `dashboard/src/routes/listing/RestoreLandlordDialog.tsx:74-75`: any 200 is
  `onRestored`, and the dialog closes (`ListingDetail.tsx`, onRestored
  handler).
- The repo's "not soft-deleted -> conflict" guard
  (`unitsRepo.ts:1268`, plus `requireSoftDeleted`) is reachable only in the
  milliseconds between the route's read and the repo's read. The common race
  never reaches it.

Failure scenarios (two staff):
- (a) Staff A gets 409 restore_needs_landlord and the dialog opens. Staff B
  restores the same property with landlord Y, or without one. A picks X and
  clicks "Restore with this landlord". The route sees a live unit, runs a
  no-op plain restore, writes a second `unit_restored` audit row naming A
  for a restore A did not perform, and answers 200. A's dialog closes as if
  X were applied. The property's landlord is B's Y.
- (b) While A's dialog is open, L (the stored landlord) is retyped back to
  landlord. A picks X. The route does a plain restore with L and answers 200.
  A explicitly asked for X and got L, with no message.

The pinned test (`app/test/unitsRestoreLandlord.test.ts:196`, "a body is
ignored when the stored landlord is still valid") makes this the intended
contract. From the UI it reads as success with a different outcome than the
one requested.

Suggested fix: when the body carries `landlordId` and the plain path would
apply, answer 409 instead (unit_roster_conflict, or a dedicated
restore_not_needed). The dialog's existing `onConflict` then re-reads and
shows the real state. Also skip the `unit_restored` audit when the stored
unit was not deleted.

## 3. [LOW] Typed contact-list refusals skip the re-read, in exactly the race where the card is stale

Evidence:
- `dashboard/src/routes/listing/ListingDetail.tsx:443-447`: a
  `contact_list_caseworker` or `landlord_not_landlord` answer sets the row
  message and returns. Only the generic 409 path re-reads the unit
  (`:459-464`).
- `app/src/routes/units.ts:1237-1252` and
  `app/src/repos/unitsRepo.ts:924-925`: the roster-write versions of these
  same two codes fire only when the property changed AFTER the route's
  consistent read (a seat removed, or the landlord cleared).

Failure scenario: Staff A edits caseworker C's existing seat (L2 allows it)
just as staff B removes that seat. The repo refuses with
contact_list_caseworker. A sees "Caseworkers can't be on a property's
contact list." on a row that no longer exists. The card keeps showing C and
the stale landlord until a manual reload. The comment says "Nothing was
written, so nothing to settle". That is true of this request, but false of
the property.

Suggested fix: after a typed refusal, run the same best-effort
`getUnit` + `applyRosterUnit` settle that the 409 path does.

## 4. [LOW] The two automatic primary-contact rules decide eligibility differently

Evidence:
- Sole-landlord promotion on a restore excludes soft-deleted contacts
  (`app/src/routes/units.ts:452-462`). Its own comment says why: "an
  automatic routing choice, where a deleted contact is unusable everywhere
  else".
- Auto-primary on add uses `landlordTyped: contact.type === 'landlord'`
  only (`app/src/routes/units.ts:1230`, decided in
  `app/src/repos/unitsRepo.ts:945-949`). The route reads the contact
  consistently but never checks `isContactDeleted`.
- The restore's plain-path check (`units.ts:1741-1742`) and
  `requireLandlordContact` (`app/src/services/contactTypeGuards.ts:86-96`)
  also let a soft-deleted landlord through.

Failure scenario: a landlord-typed contact is soft-deleted after the Add
contact picker loaded. The same happens if it is added through the API. It
is then added to an ownerless property with no primary, becomes that
property's primary contact automatically, and relay groups and tour copy
resolve to a deleted contact. The same contact would never be chosen by the
restore promotion.

Suggested fix: one shared eligibility predicate for automatic routing. It
should cover pointer rows, soft-deleted contacts and type, used by both
`soleLandlordToPromote` and the facts passed to addContact (for example, a
third fact `autoPrimaryEligible`).

## 5. [LOW] The housing-authority "close name" path still writes a tenant fact onto a non-tenant, unfenced

Evidence:
- `dashboard/src/routes/contact/ContactDetail.tsx:820-833`:
  `editHousingAuthorityTo` writes with a plain `updateContact(contact.contactId,
  { housingAuthority })`. The contacts PATCH accepts `housingAuthority` for
  any type (`app/src/routes/contacts.ts:654-659`) and applies the
  classification fence only when the PATCH itself classifies
  (`contacts.ts:1523-1542`).
- The branch's protection is a client-side gate on the page's local
  `contact.type` (`ContactDetail.tsx:844`).
- `haReview` resets only when the contact id changes
  (`ContactDetail.tsx:285-295`), never when the type changes. The dialog's
  `onUse` keeps routing non-resolution picks to that plain PATCH
  (`ContactDetail.tsx:1273-1275`).

Failure scenario: Staff A opens the "Is this really new?" review on tenant
T. Staff B converts T to a caseworker, and the conversion deliberately
removes the authority. A picks a close name. The plain PATCH writes
housingAuthority onto the caseworker. That is the same "tenant facts onto a
converted caseworker" outcome the new accept fence (`withClassificationFence`
/ `effectiveGuard`) closes for accepts, reached by the sibling path, with a
window as long as the dialog stays open (minutes, not milliseconds).
Audience resolution filters to tenants
(`app/src/services/audienceResolution.ts:148`), so this is wrong data, not
a misrouted send.

Suggested fix: on the server, refuse a non-null `housingAuthority` (and the
other tenant-only fields) in the contacts PATCH when the stored or resulting
type is not tenant. Alternatively, fence that write on the
classification_revision the page read. On the client, close `haReview` when
`contact.type` stops being tenant.

## 6. [LOW] PATCH landlordId is now the sanctioned landlord swap, but it leaves the contact list inconsistent

Evidence:
- `app/src/routes/units.ts:1599-1621` adds the I3 check to a CHANGED
  `landlordId`. The write is then an unconditional `units.update`
  (`:1648`) that never touches `contacts[]` or `primary_contact`.
- Compare `restoreWithLandlord` (`app/src/repos/unitsRepo.ts:1286-1338`),
  which drops the old landlord's row, seats the new one with role landlord
  and moves the primary.

Failure scenario (API only; no dashboard sender): PATCH a live property's
landlordId from L to X. L's row keeps `role: 'landlord'` and, typically,
`primaryContact: true`, and X has no row. L is no longer anyone's landlord
of record, so `typeChangeRefusals` (`app/src/services/contactHoldings.ts:139-143`)
lets L be retyped to tenant. The roster resolvers take the PRIMARY ROW
first (`app/src/lib/rosterResolution.ts:294`), so relay groups and tour copy
for X's property keep resolving to L, a tenant. The behavior predates this
branch. The branch's new check makes this path look validated.

Suggested fix: route a landlordId change through a roster-aware repo write
(the restoreWithLandlord shape, without the restore). Or refuse
`landlordId` in PATCH and point callers at that write.

## 7. [LOW] Rules and fakes are written out by hand in several places that can drift apart

Evidence:
- The seat and claim definitions for the contact list exist twice: in the
  route (`app/src/routes/units.ts:1203-1215`) and per attempt in the repo
  (`app/src/repos/unitsRepo.ts:904-925`).
- "The cleared landlord was the primary" exists twice: in the route
  (`units.ts:443-446`) and in the repo (`unitsRepo.ts:1292-1294`).
- The routing-pointer test (`phone_ref === true || email_ref === true`) is
  repeated in contactTypeGuards.ts (`:70`, `:90`), units.ts (`:455-456`,
  `:1182`) and contacts.ts (`:1532`).
- FakeWorld's `restoreWithLandlord` and `addContact`
  (`app/test/helpers/twilioWebhookHarness.ts`, the restoreWithLandlord block
  added near 3115-3183) are line-for-line hand copies of the real repo.
  Their getById returns the LIVE object (`:2839-2841`), so a route test that
  simulates a concurrent change by mutating `unit.contacts` in place would
  pass the `isDeepStrictEqual` guard vacuously (same reference).
- Related: addContact's per-attempt refusals (`unitsRepo.ts:924-925`) are
  thrown on an eventually consistent read (`:894`, no `consistentRead`), so
  no conditional write ever confirms them. A lagging replica can answer a
  409 for a state the route's consistent read already saw as allowed. The
  window is narrow, and a consistent read there costs nothing.

Suggested fix: export one pure `contactListDecision(unit, contactId, role,
facts)` from unitsRepo and call it from the route's pre-check and the
repo's loop. Do the same for an `oldLandlordWasPrimary(unit, id)` helper and
an `isRoutingPointer(contact)` helper. Have the fake's getById return a
structuredClone. Read consistently in addContact's attempt.

## 8. [LOW] Automatic routing changes are not named before the write

Evidence:
- `dashboard/src/routes/listing/RestoreLandlordDialog.tsx:122` and its
  buttons say nothing about the sole-landlord promotion. Yet "Restore
  without a landlord" can re-point the property's primary contact to another
  person in the same write (`app/src/routes/units.ts:1800-1801`,
  `unitsRepo.ts:1325-1331`).
- "+ Add contact" always posts `primaryContact: false`
  (`ListingDetail.tsx:550`), yet a landlord-typed add on an ownerless,
  primary-less property becomes the primary with no notice.
- The page's own stated rule for removing the primary is "Removing the
  primary contact re-points live routing, so it NAMES the promotion before
  it writes - silently moving calls is not acceptable".

Failure scenario: staff restore without a landlord. Calls and new relay
groups now go to another contact on the list, and nothing on screen said
so. The Contacts card does show the new primary afterward, but only if
someone looks.

Suggested fix: when the cleared landlord is the primary, have the dialog
name who will become primary (or "no one"). Show a one-line notice after an
add that came back primary although the request said false.

## 9. [LOW] Re-sending an accept refused by reclassification answers 200 (inherited)

Evidence:
- `app/src/repos/suggestionResolutionRepo.ts:303-318`:
  `makeCompletedResolution` keeps no outcome. A superseded journal completes
  like an applied one.
- `app/src/services/suggestionResolution.ts:787-801`: an identity-matching
  completed row returns `{ completedNow: false }` (200) unless
  `released_unsafe`.

Failure scenario: an accept is refused with 409
suggestion_contact_reclassified, but the HTTP response is lost (proxy reset,
or a client-side retry). The identical re-send answers 200, which tells the
operator the fact was applied when nothing was written. The same holds for
the existing suggestion_field_edited. This branch adds a second refusal kind
to an already lossy completed row. The dashboard does not auto-retry today,
hence LOW.

Suggested fix: store a `disposition: 'superseded'` (or the outcome) on the
completed row and answer the same 409 for an identity match.

---

## Checked and held (no finding)

- addContact: the I4 and I3 refusals and auto-primary are decided per
  attempt, and the write is conditioned on that attempt's landlordId and
  contacts[] (`unitsRepo.ts:653-714`, `:890-1035`). Two racing adds cannot
  both become primary, and a seat removed or a landlord cleared after the
  route's read cannot be re-created or claimed.
- restoreWithLandlord: the write is conditioned on landlordId, contacts[]
  and `attribute_exists(deleted_at)`. A `next: null` restore refuses any
  contacts change instead of retrying, so a stale promotion is never
  applied. A vanished unit gives a 404. The route decides from one
  `listRead` taken before its awaits (`units.ts:1800`).
- Restore never reassigns a live property: the route's plain path covers a
  non-deleted unit, and the repo throws if the unit became live.
- Contacts PATCH type change: the refusal runs before any write, side
  effect or type-suggestion drain (`contacts.ts:1644-1654` versus the write
  at `:1781` and the drain at `:1843`). Soft-deleted units are left to the
  restore fence.
- The I2 checks sit at every tour and placement birth or revival site I
  found: `tours.create` has a single call site (`tours.ts:367`), placements
  are created at `placements.ts:595` and `:736`, canceled-to-open revival is
  `tours.ts:1404`, reopen is `tours.ts:1691`, and leaving a terminal
  placement stage is `services/statusTransition.ts:420`, whose only caller
  is the transition route. PATCH can change neither the placement's
  `tenantId` nor its `stage` (`placements.ts:283-286`, `:357`).
- The suggestion fence: the real repository and the fake evaluate the same
  `effectiveGuard` and `guardMismatchIsClassification`. A pre-deploy
  journal gets `caseworker_conversion` absent added to its guard. Old code
  running during a rolling deploy would enforce the new
  `classification_revision` key as an ordinary guard attribute.
- Dashboard copy maps: every new server code has a sentence, and an unknown
  `contactKind` falls back to "not a tenant". The restore dialog and the
  roster's typed refusals are mapped before the catch-alls.
  `useListing.setUnit` and the contactsUnit guard prevent a cross-property
  stamp after a history move.
