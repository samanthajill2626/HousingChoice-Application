# Caseworker integrity - design

Status: APPROVED revision 5 (2026-10-12). Branch `fix/caseworker-integrity`,
worktree `W:\tmp\caseworker-integrity`, cut from `main` @19607658.
Revision 2 folds in design review round 1
(`docs/superpowers/reviews/2026-10-12-caseworker-integrity/design-review/adjudications.md`).
Revision 3 (Cameron's spec gate): restore never dead-ends - it offers a
landlord picker or a restore without a landlord (section 4, Restore);
existing data is not swept or repaired (L2).
Revision 4 (Cameron, during the build): auto-primary - a contact added to a
property with no primary contact and no landlord of record becomes its
primary contact (section 4, Contact list).
Revision 5 (Cameron, after review round 2): auto-primary applies only to
contacts typed `landlord`, and "Restore without a landlord" promotes the one
remaining landlord-typed contact when the cleared landlord was the primary
(section 4, Contact list and Restore).

Closes three filed issues that share one theme: a contact converted to a
caseworker (or re-typed by hand) can still end up holding tenant-only data or
tenant-only records.

- `docs/issues/claimed-suggestion-accept-after-caseworker-conversion.md` (R2-ADV-1, med)
- `docs/issues/contact-retype-skips-caseworker-refusals.md` (low)
- `docs/issues/tours-placements-no-contact-type-check.md` (low)

Context: tracker #19 (caseworkers, `feat/caseworkers`) is merged to `main` but
NOT deployed anywhere. This branch must merge before #19 deploys; it ships in the
same deploy. Background design: the historical spec
`docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
(D16-D22) and the review records in
`docs/superpowers/reviews/2026-10-07-caseworkers/` (R2-ADV-1 schedule in
`code-review-adversarial-r2.md`; the executed reproduction in
`planner-final-review.md` section 4).

All product decisions below were ruled by Cameron on 2026-10-12.

---

## 1. Invariants this branch establishes

- **I1 (tenant-only accepts).** An accepted AI suggestion for a TENANT-ONLY
  field commits only onto a contact typed `tenant` whose classification is
  unchanged since the accept read it. Tenant-only targets: `housingAuthority`,
  `voucherSize`, `pets`, `evictions`, `tenure`, `porting`, `status`. Neutral
  targets (`firstName`, `lastName`, `phone`, `address`) are not affected and
  still commit after a reclassification. (`type` cannot be accepted at all:
  `accept_type_via_triage`, `app/src/services/suggestionResolution.ts:269`.)
- **I2 (tenant records).** A contact that is the tenant of an OPEN tour or an
  OPEN placement is typed `tenant`. Open tour = status in `requested`,
  `scheduled`, `toured`, `no_show` (the conversion's `OPEN_TOUR_STATUSES`,
  `app/src/services/caseworkerConversion.ts:120`). Open placement = stage not
  in `TERMINAL_STAGES` (`moved_in`, `lost`; `app/src/lib/statusModel.ts:118`).
  `unknown` is deliberately NOT allowed (Cameron, 2026-10-12): no flow gives
  an unknown contact a tour or placement today (the pickers load tenants
  only, `ScheduleTourForm.tsx:179`, `PlacementCreateForm.tsx:125`). The
  readers that still accept `unknown_1to1` threads (tour reminders) stay as
  they are for records created before this branch.
- **I3 (landlord of record).** A LIVE unit's `landlordId` names a contact
  typed `landlord` (a property manager is a landlord with a role).
- **I4 (contact list).** No NEW contact-list seat is given to a caseworker
  (`isCaseworker`, `app/src/lib/caseworkers.ts:86`). Other types may sit on a
  contact list, as today.

Where each is enforced:

| Invariant | The write that creates the record or seat | The type change that would invalidate it |
| --- | --- | --- |
| I1 | the accept (section 2) | (the accept is fenced against it, section 2) |
| I2 | tour / placement create, revive, reopen (section 4) | contacts PATCH (section 3); the conversion (unchanged) |
| I3 | unit create, unit PATCH, roster landlord claim, unit restore (section 4) | contacts PATCH (section 3); the conversion (unchanged) |
| I4 | contact-list add (section 4) | the conversion only (unchanged); a seat never blocks a generic type change |

I2-I4 checks are reads before writes, not atomic; see section 6 (L1).

---

## 2. D1 - R2-ADV-1: tenant-only accepts check the type and are fenced on the classification revision

### Today

An accept builds a replay plan from an eventually consistent contact read
(`suggestionResolution.ts:778`), claims the suggestion (creates an active
`resolve#` journal, deletes the `sugg#` row), then commits the contact effect.
Field accepts commit through `commitContactEffect`
(`app/src/repos/suggestionResolutionRepo.ts:770`) in one transaction whose
condition is the plan's attribute guard (`guardForPatch`,
`suggestionResolution.ts:194`; condition built by `contactGuardCondition`).
The real repo consults the guard at THREE sites: the commit condition
(:798), the in-memory re-check on its consistent read that decides `stale`
versus mismatch (:827, `contactMatchesGuard`), and the mismatch
`ConditionCheck` (:831). The test fake
(`app/test/helpers/suggestionResolutionFake.ts:322-336`) checks the same
guard map at one site. A mismatch ends the journal as
`superseded_by_human_edit` and the requester gets 409
`suggestion_field_edited`. A crashed claim is finished later by
`recoverAbandoned` (any ordinary suggestions read) or the daily journal sweep
(`app/src/jobs/journalSweep.ts`). Phone accepts commit through
`commitPhoneEffect`; phone is neutral and is not touched here.

`buildPlan` (`suggestionResolution.ts:246-377`) reads no contact type for the
six fact targets (only `status` is type-scoped, via `statusAllowlistFor`), and
the guard names only the fields the plan writes. The caseworker conversion
REMOVES `housingAuthority` and `housingAuthority_source`, so an accept whose
guard expected both absent still matches after the conversion and writes the
authority onto the caseworker. Reproduced on FakeWorld routes and on the real
repos (planner-final-review.md section 4). Separately, an accept made AFTER a
generic re-type (whose PATCH leaves unrelated pending chips in place) passes
any revision guard and also writes tenant facts onto a non-tenant.

### Change

1. **Consistent plan read.** The contact read that feeds `buildPlan` becomes a
   consistent read (it drives both rules below; a stale read would refuse
   spuriously and, for the fence, consume the chip).
2. **Plan-time type rule.** An ACCEPT of a tenant-only target on a contact not
   typed `tenant` is refused BEFORE the claim with 409
   `suggestion_contact_not_tenant`; the chip is NOT consumed (staff can
   dismiss it). This matches extraction's own rule: tenant facts are only
   proposed for tenants (`app/src/services/extraction/apply.ts:137-142`,
   `fieldApplies`). Dismissals are never refused. For `status`, this check
   runs before the existing allowlist check.
3. **Fence.** For a tenant-only ACCEPT, the plan's guard also carries
   `classification_revision` from the same read: `{ exists: false }` when
   absent, else `{ exists: true, value: <number> }`. The conversion and every
   contacts-PATCH type/role change bump it atomically with their write
   (`app/src/repos/contactsRepo.ts:1501`), so the guard transaction refuses an
   accept that spans any reclassification. No new transaction; the real repo
   and the fake already enforce whatever keys the guard holds.
4. **Pre-deploy journals (legacy fallback).** An active journal claimed by
   the old code has no `classification_revision` key. For a tenant-only target
   with no such key, the guard is EFFECTIVELY extended with
   `caseworker_conversion: { exists: false }` (the conversion writes that
   attribute atomically with the type change). Implement this as ONE exported
   pure function `effectiveGuard(journal)` used at all three real-repo sites
   (:798, :827, :831) and in the fake, so parity is by construction and a
   legacy journal on a converted contact ends as a mismatch, never as a
   `stale` loop. Known limit: a legacy journal is not fenced against a
   GENERIC re-type (window = crash recovery of a claim made before the deploy).
5. **Answer.** `commitContactEffect`'s result union (real and fake) gains
   `superseded_by_reclassification`, returned when the mismatch is in the
   classification keys (`classification_revision`, or the legacy
   `caseworker_conversion` key) - classification wins when the field ALSO
   mismatched. The stored journal outcome and the run-log verdict are the same
   as for `superseded_by_human_edit`. The service carries the reason to
   `resolve()`, which answers 409 `suggestion_contact_reclassified`. This
   specific answer is for the request that drives its own claim to the
   refusal; a request that only helps or replays a journal keeps today's
   answers (pre-existing, unchanged).
6. **Every reader of the refusal codes** handles both new codes:
   - the suggestions route's `suggestion.updated` emit
     (`app/src/routes/suggestions.ts:224-226`) fires for
     `suggestion_contact_reclassified` exactly as for
     `suggestion_field_edited` (the chip is gone);
     `suggestion_contact_not_tenant` consumes nothing and emits nothing;
   - the dashboard copy map `SUGGESTION_RESOLUTION_ERROR_COPY`
     (`dashboard/src/api/types.ts:1655-1700`) gains
     `suggestion_contact_reclassified`: "This contact's type or role changed
     after the AI suggested it, so nothing was applied." and
     `suggestion_contact_not_tenant`: "This contact isn't a tenant, so this
     can't be applied. Dismiss it instead.";
   - the dashboard refetch list (`ContactDetail.tsx:720-725`) adds
     `suggestion_contact_reclassified`.
7. **No repair step.** #19 is not live anywhere; `make` again stays
   follow-on only.

---

## 3. D2 - The generic type change refuses what would break I2 / I3

Surfaces: the contacts PATCH (`app/src/routes/contacts.ts`, type handling
around :1500-1650), reached from the edit form's kind picker
(`dashboard/src/routes/contact/ContactEditForm.tsx`) and the Unknown card's
Mark as Tenant / Landlord / Partner / Property Manager
(`dashboard/src/routes/contact/UnknownFile.tsx` via `onTriage`,
`ContactDetail.tsx:667-676`). The API also accepts `team_member` and
`unknown` as targets; the rule applies to every target type.

### Rule

When a PATCH changes `type` (resulting type differs from the stored type):

- resulting type is not `tenant` -> refuse while the contact is the tenant of
  any open placement or open tour (I2);
- resulting type is not `landlord` -> refuse while the contact is the landlord
  of record of any LIVE unit (I3). Soft-deleted units do not count here (they
  are fenced at restore instead, section 4), unlike the conversion, which
  keeps counting them (unchanged);
- contact-list seats never refuse a type change.

Order: after the existing 409 `caseworker_use_conversion` check and before
any write. Role-only changes (no type change) are not checked.

Response: 409 `{ error: 'type_change_refused', refusals: [...] }`, each
refusal one of `{ code: 'open_placement', placementId }`,
`{ code: 'open_tour', tourId }`, `{ code: 'landlord_of_record', unitId }`,
ordered by kind (placement, tour, landlord), then id ascending.

### Shared reads

Extract the conversion's private `collectRefusals`
(`caseworkerConversion.ts:217-266`) into a shared module that returns the
four kinds separately, with a per-call choice of live-only or any-deleted
units for the landlord read. The conversion keeps its exact current
behavior, codes (`caseworker_*`), order and deleted-unit counting; the PATCH
asks only for the kinds its rule needs (never the roster Scan).

### Dashboard

- Move `refusalCopy` out of `CaseworkerDialog.tsx` (:62-89) into a shared
  module keyed by refusal KIND; the dialog maps its `caseworker_*` codes onto
  it and its four sentences and View links stay byte-identical.
- The generic type change uses the same sentences and links for open
  placement and open tour. For landlord of record it uses its own sentence,
  because no dashboard UI can reassign a property's landlord: "This contact
  is the landlord of record for a property, so they must stay a landlord.
  Changing a property's landlord isn't available in the dashboard yet."
  (View property link.) Filed: `landlord-of-record-no-reassign-ui`.
- Edit form: on 409 `type_change_refused`, keep the draft and show each
  refusal's sentence with its View link beside the kind picker. (It already
  shows its own copy for 409 `caseworker_use_conversion`,
  `ContactEditForm.tsx:517-519`; other failures show "Couldn't save - please
  try again.")
- Unknown card: Mark as ... stops swallowing errors (`.catch(() => {})`,
  `ContactDetail.tsx:672`). `type_change_refused` shows the sentences with
  links on the card; any other failure shows "Couldn't save - please try
  again." on the card.

---

## 4. D3 - Tours, placements and properties check the contact's type

All new contact reads in this section are CONSISTENT reads. "Exists" keeps
today's meaning (`getById` returns soft-deleted contacts; this branch does
not add a deleted-contact refusal).

### Tours and placements (I2)

| Surface | Today | Change |
| --- | --- | --- |
| `POST /api/tours` (`app/src/routes/tours.ts:310-406`) | never reads the contact | 404 `tenant_not_found` when missing; 409 `contact_not_tenant` when not typed `tenant` |
| tour PATCH (`tours.ts:1145`, guard :1210-1265) moving a tour whose CURRENT status is `canceled` to any OPEN status (`scheduled` via reschedule, and `toured` / `no_show`, which the PATCH also allows) | no contact read | 409 `contact_not_tenant` (404 `tenant_not_found` when missing); a move between open statuses, or to a closed one, is not checked |
| `POST /api/tours/:id/reopen` (`tours.ts:1641-1684`, `closed` -> an open status) | no contact read | same |
| `POST /api/placements` (`app/src/routes/placements.ts:566-627`) | 404 `tenant_not_found` when missing | adds 409 `contact_not_tenant` |
| `POST /api/placements/from-tour` (`placements.ts:635-905`) | existence only | adds 409 `contact_not_tenant`, before any write |
| placement transition from a terminal stage (`moved_in`, `lost`) to a non-terminal stage (`transitionPlacement`, `app/src/services/statusTransition.ts:390`; route `app/src/routes/statusTransition.ts:102`) | no check | same check, in the service so every caller is covered |

409 body: `{ error: 'contact_not_tenant', contactKind }`, where
`contactKind` is `caseworker` when `isCaseworker` holds, else the stored type.
The transition service raises a dedicated error class for this, which
`handleTransitionError` (`routes/statusTransition.ts:330-342`, today 400
`{ error }` for refusals) maps to 409 with that body; a missing tenant there
maps to 404 `tenant_not_found`.

Moving a placement between non-terminal stages, or into a terminal stage, is
not checked. WHETHER a placement may leave `lost` / `moved_in` at all is a
separate question, filed (section 7), not decided here.

### Derived tenant status

`deriveTenantStatus` (`statusTransition.ts:335-355`) writes nothing (no
status, no audit, no milestone) when the contact is not typed `tenant`, and
logs at info. Listing-status derivation is unchanged.

### Team members

`TenantFile` also renders for `team_member` contacts
(`ContactDetail.tsx:574-584`) and offers "+ Schedule" and "+ Start placement"
(`TenantFile.tsx:320,348`; `ContactDetail.tsx:1203-1204`) there. Hide both for
a team member (Cameron, 2026-10-12: tours are never booked on team members).
The server refuses a team member under I2 like every other non-tenant.

### Landlord of record (I3)

| Surface | Change |
| --- | --- |
| `POST /api/units` (`app/src/routes/units.ts:464-514`; `landlordId` required) | 404 `landlord_not_found` when the contact is missing; 409 `landlord_not_landlord` when not typed `landlord` |
| `PATCH /api/units/:id` with a CHANGED `landlordId` (`units.ts:1376-1491`; writable per `app/src/lib/unitFields.ts:46`) | same |
| `POST /api/units/:id/contacts` with role `landlord` that CLAIMS a vacant landlord slot (`app/src/repos/unitsRepo.ts:773-823`, `claimsVacantLandlord`) | 409 `landlord_not_landlord` when the contact is not typed `landlord`. Re-asserting the unit's existing owner (Make primary on the owner's row) is not checked. |
| `POST /api/units/:id/restore` (`units.ts:1517`; repo `restore`, `unitsRepo.ts:726`) | see "Restore" below - restore never dead-ends on this rule |

### Restore (I3, Cameron 2026-10-12)

A property with no landlord of record is already a supported state (legacy
"ownerless" units: `unitsRepo.ts:396,766`; placement nudges report
`no_landlord`, `jobs/placementNudges.ts:439`), and adding a contact with role
`landlord` to an ownerless property's contact list already claims the slot.
Restore builds on that instead of refusing:

- **Plain restore** (no body, today's call): when the unit is ownerless or its
  `landlordId` names a contact typed `landlord`, restore exactly as today.
  Otherwise (the contact is missing, or no longer typed `landlord`) refuse
  with 409 `restore_needs_landlord` and `{ landlordName? }` (the stored
  contact's display name when it exists). Nothing is written.
- **Restore with a landlord**: body `{ landlordId: <id> }`. The contact must
  exist and be typed `landlord` (404 `landlord_not_found` / 409
  `landlord_not_landlord`). Restores the unit and makes that contact its
  landlord of record in ONE conditional write on the unit: `landlordId` set,
  the old landlord's contact-list row removed, a `landlord` row for the new
  one (kept if already seated, role pinned to `landlord`), and
  `primary_contact` kept consistent the way the roster writes already do.
- **Restore without a landlord**: body `{ landlordId: null }`. Restores the
  unit and REMOVES `landlordId` in the same single write, removing the old
  landlord's contact-list row and clearing a `primary_contact` that pointed
  at them (the existing "no landlord remains" handling,
  `unitsRepo.ts:665,907`). Staff can add a landlord later from the contact
  list (Add contact, role Landlord), which already claims an empty slot.
  **Sole-landlord promotion (Cameron, 2026-10-12, revision 5):** when the
  cleared landlord was the property's primary contact and exactly ONE
  remaining contact-list row belongs to a contact typed `landlord` (any roster
  role), that contact becomes the primary contact in the SAME conditional
  write (`primary_contact` consistent); with zero or two-plus such rows,
  nobody is promoted. The remaining rows' contact types are read
  consistently before the write, and the write is conditioned on the roster
  that was read, so a concurrent contact-list change answers 409
  `unit_roster_conflict`.
- A body is honored only when the plain restore would have refused; when the
  stored landlord is still valid, a body is ignored and the restore is plain.
  Each write conditions on the `landlordId` it read, so a concurrent change
  answers 409 `unit_roster_conflict` (the roster's existing code) and the
  dashboard re-reads.
- Audit: the existing `unit_restored` entry gains `landlordReplaced`
  (`{ from, to }`) or `landlordCleared` (`{ from }`) when one applied, and
  `primaryPromoted` (`{ to }`) when the sole-landlord promotion applied.

Dashboard (`ListingDetail.tsx:349`, the only Restore button): on 409
`restore_needs_landlord`, open a dialog:

> <landlordName or "This property's landlord"> is no longer a landlord, so
> they can't stay this property's landlord. Choose its landlord:
> [landlord picker - landlords only, the same source as Add property's]
> **Restore with this landlord** (disabled until one is picked) -
> **Restore without a landlord** - Cancel

In the normal case (the landlord is still a landlord) Restore behaves exactly
as today, with no dialog.

### Contact list (I4)

`POST /api/units/:id/contacts` (`units.ts:1061-1137`) refuses a caseworker
taking a NEW seat with 409 `contact_list_caseworker` (any role). Editing or
removing a seat the contact already holds is not refused. Check order on this
route: `contact_list_caseworker`, then `landlord_not_landlord`, both before
the repo call; the repo's own 409 `landlord_reassignment_required` follows.
The property Add contact picker (`dashboard/src/routes/listing/ListingDetail.tsx:194,367,967-986`,
fed by `useContacts('all')`) hides caseworkers.

**Auto-primary (Cameron, 2026-10-12; revision 5 narrows it).** When
`POST /api/units/:id/contacts` adds a contact typed `landlord` (landlords,
property managers, owners - any roster role) as a new seat (editing a contact
already on the list is not an add) to a property that has no primary contact
(no contact-list row marked primary) and no landlord of record (`landlordId`
absent), the added contact becomes the property's primary contact - a
Landlord-role add that claims the vacant slot included. A contact of any other
type (tenant, unknown, partner, team member) joins such a list NON-primary, as
before; making them primary takes a deliberate Make primary. It is decided
inside the repository's conditional roster write from the unit each attempt
read, with the contact's type read consistently by the route, so two
concurrent adds cannot both become primary; every other add behaves as before
(primary only when the request asks for it).

### Dashboard copy for section 4

One shared dashboard helper maps the new codes to sentences, used at every
site below (several show raw codes or fixed copy today):

- `contact_not_tenant`: "Tours and placements are for tenants. This contact
  is a <kind label>." (kind label from `contactKind`, e.g. Caseworker,
  Landlord, Partner, Team member, Unknown);
- `tenant_not_found`: "That contact no longer exists.";
- `landlord_not_landlord`: "Only a landlord can be a property's landlord of
  record." (restore's own refusal opens the dialog above instead);
- `landlord_not_found`: "That landlord no longer exists.";
- `contact_list_caseworker`: "Caseworkers can't be on a property's contact
  list."

Sites: `TourDetail.tsx` (status changes :382, Start placement / from-tour
:514, outcome then from-tour :589 - all show `err.message` today);
`ScheduleTourForm.tsx:326` and `PlacementCreateForm.tsx:248` (bare catch,
fixed copy); `PlacementsPage.tsx:96` and `PlacementDetail.tsx:402` (stage
moves, fixed copy); `UnitCreateForm`; `ListingDetail.tsx` `runRosterWrite`
(:388-412 - map the new codes BEFORE its catch-all 409, whose copy
`ROSTER_CONFLICT_COPY` at :115-116 would otherwise claim "landlord of
record"); the restore action (`ListingDetail.tsx:349`). Any other failure
keeps each site's current copy.

---

## 5. Surface inventory (planner sweep, for the plan's invariant rule)

Writers of the protected state and how each is handled:

- **Contact classification:** contacts PATCH (D2); `POST /api/contacts` can
  create a contact of any type, caseworkers included (a new contact holds no
  tours, placements or seats, so it cannot break I2-I4); the caseworker
  conversion (unchanged; already refuses all four kinds); the Airtable
  importer's re-type (`app/src/lib/import/apply.ts:883-1110`), which also
  never bumps `classification_revision` - OUT OF SCOPE, filed (section 7);
  AI extraction only suggests a type.
- **Tenant-only accept effects:** `resolve` and both recovery paths
  (`recoverAbandoned`, the journal sweep) all commit field effects through
  `commitContactEffect` (D1).
- **Tour/placement creation, revive and reopen:** the six surfaces in
  section 4. `tenantId` is immutable after create on both (tours
  `PATCH_ALLOWED`, `tours.ts:157`; placements PATCH). No job or dev seam
  creates or reopens them (`jobs/tourAutoClose.ts` only closes).
- **landlordId:** unit create, unit PATCH, roster landlord claim, unit
  restore (section 4); the importer's `landlordId` fact (`apply.ts:1519`) -
  OUT OF SCOPE, filed.
- **Contact-list seats:** `POST /api/units/:id/contacts` only.
  (`app/src/services/rosterEdits.ts` edits tour/placement RELAY rosters, not
  property contact lists - the filed issue named it in error.)
- **Seeds** (`app/src/lib/seed/*`: lean, full/cast, live, matrix,
  performance) write tours, placements, units and rosters directly. They
  must satisfy I2-I4; the plan adds a seed-invariant test over every profile.
- **e2e fixtures** that create tours, placements, units or roster seats
  through the API must use correctly typed contacts; the build must find and
  fix any that do not (they will now be refused).

Readers that depend on these invariants (unchanged, listed so nothing
contradicts them): tour reminders (`jobs/tourReminders.ts:1093`,
`routes/tourReminders.ts:1027`), placement nudges, relay fan-out, the contact
timeline, UnknownFile's placements list (`UnknownFile.tsx:85`), the Possible
caseworkers list.

---

## 6. Known limits (documented, not fixed)

- **L1 - read-then-write window.** The I2-I4 checks are reads before writes.
  The open tour / placement / landlord reads are index (GSI) queries, which
  are never strongly consistent, so the window is index propagation lag
  (normally well under a second): two staff acting on the same contact at
  about the same time, or one person scheduling and re-typing in quick
  succession, can both pass. No cross-record lock is built (Cameron,
  2026-10-12). Contrast D1, whose window is durable (crash recovery can run
  hours later) and is therefore fenced atomically.
- **L2 - existing data.** No backfill, sweep or audit of existing data
  (Cameron, 2026-10-12: not worth it). Records created before this branch
  that violate I2-I4 stay as they are. Caseworkers can already exist without
  the conversion (created directly as a partner with the Caseworker role);
  whether production holds any such contact on a contact list or with a tour
  is unverified. Existing seats and existing owners remain editable (section
  4).
- **L3 - extraction in flight.** Unchanged and out of scope:
  `extraction-in-flight-writes-onto-converted-caseworker` (deferral approved).

---

## 7. Docs owed in this branch

- RUNBOOK "What the conversion does not fence" paragraph (RUNBOOK.md:473):
  state that a staff accept of a tenant-only suggestion is now refused on a
  non-tenant and fenced across a conversion (D1), so the hand-clear applies to
  the extraction writer (and the importer) only; add L1.
- Resolve `claimed-suggestion-accept-after-caseworker-conversion`,
  `contact-retype-skips-caseworker-refusals`, `tours-placements-no-contact-type-check`
  (status, resolved date, Resolution paragraph). In the last one, correct the
  record: the property contact-list add is in `units.ts`, not `rosterEdits.ts`,
  and note that a placement can leave `lost` / `moved_in` with no guard; record
  the tenant-only ruling (not `unknown`).
- File `placement-terminal-stage-exit-unguarded` (a placement can move out of
  `lost` or `moved_in` to any stage; whether that is allowed is undecided).
- File `import-bypasses-contact-type-rules` (the importer's re-type and
  `landlordId` writes do not apply I2 / I3, and its re-type does not bump
  `classification_revision`, so I1's fence does not see it).
- File `landlord-of-record-no-reassign-ui` (no dashboard path changes a
  property's landlord of record after create).
- GLOSSARY: no new domain noun expected; update only if one appears.

---

## 8. Tests the build must add

- **D1, real AND fake:** the R2-ADV-1 schedule as a deterministic test -
  (A) claim paused at the `claimed` boundary, convert, resume -> 409
  `suggestion_contact_reclassified`, no authority, `suggestion.updated`
  emitted, journal completed; (B) crash after claim, convert, recover via an
  ordinary suggestions read and via the journal sweep -> no authority. Run on
  FakeWorld routes and on the real repos (DynamoDB Local). Plus:
  - an address and a phone accept claimed before the conversion still commit;
  - a `voucherSize` accept spanning a generic tenant -> landlord re-type is
    refused as reclassified;
  - an accept of each tenant-only target on a non-tenant is refused with
    `suggestion_contact_not_tenant` and the chip survives; a dismiss is not
    refused;
  - a status accept and a prior-authority accept spanning a conversion
    answer `suggestion_contact_reclassified` (classification wins the tie);
  - a legacy journal (guard without the revision key) recovered onto a
    converted contact ends superseded (not `stale`) ON THE REAL REPO, and onto
    an unconverted contact commits;
  - `effectiveGuard` is the one function the three real-repo sites and the
    fake call.
- **D1 dashboard:** both new copy entries; the refetch on
  `suggestion_contact_reclassified`.
- **D2:** PATCH refusal matrix (to/from tenant, landlord, partner, unknown,
  team_member) with open placement, open tour, landlord of record of a live
  unit (refused) and of only a soft-deleted unit (allowed), roster seat
  (never refuses); the conversion's behavior is unchanged (its existing
  tests stay green); dashboard tests for the edit form and the Unknown card.
- **D3:** each surface in section 4 refuses as specified and still accepts the
  valid case, including tour PATCH `canceled` -> `toured` / `no_show` /
  `scheduled`, and roster re-assert / existing-seat edits staying allowed;
  restore: plain (valid landlord, ownerless), 409 `restore_needs_landlord`
  (non-landlord, missing contact), with a landlord (row swap, primary kept
  consistent), without a landlord (ownerless after, row removed), a body
  ignored when not needed, and the restore dialog's three actions;
  `deriveTenantStatus` skips a non-tenant;
  TenantFile hides both buttons for a team member; the Add contact picker
  hides caseworkers; each dashboard copy site in section 4 shows its sentence.
- **Seeds:** the invariant test in section 5.
- **e2e:** extend existing specs for one refusal per area (type change from
  the edit form; Add contact hides a caseworker; a refused tour action shows
  its sentence). Reuse fixtures.

## 9. Gates

The five AGENTS.md gates, bare, from the worktree: `npm run typecheck`,
`npm test`, `npm run smoke`, `npm run e2e`, and
`npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`
(skip only if that list is empty). Do not restart the shared DynamoDB Local
container without Cameron's go.

## 10. Non-goals

- Tracker #14 (the /join form) - a separate branch and agent.
- Whether a placement may leave a terminal stage at all (filed).
- The importer (filed).
- A dashboard path to reassign a property's landlord (filed).
- A deleted-contact refusal on create paths.
- Making I2-I4 atomic across records (L1).
- Any change to the conversion's behavior, codes or copy.
