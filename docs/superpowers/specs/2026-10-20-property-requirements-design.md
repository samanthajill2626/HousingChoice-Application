# Landlord requirements and property fields - design

Status: APPROVED revision 6 (2026-10-20, Cameron at the spec gate). Revision
2 folded in review round 1 (two reviewers), revisions 3-5 rounds 2-4 (one
reviewer, continued; round 4 was the cap), revision 6 Cameron's two
decisions at the gate; adjudications in
`docs/superpowers/reviews/2026-10-20-property-requirements/design-review/adjudications.md`.
Branch: `feat/property-requirements` (worktree `W:\tmp\property-requirements`, cut from main @1d7a4667)
Tracker: Improvements Tracker items #12 "Property page fields" and #11
"Landlord requirements and qualifications" (Before WP1, item 6), built
together.
Review records: `docs/superpowers/reviews/2026-10-20-property-requirements/`

Decided at the spec gate (Cameron, 2026-10-20), after review round 4 hit the
cap:

- O1: a checkbox or choice and the free text that details it are ONE item,
  copied, compared and tagged together, whether or not the item is on the
  flyer - so Apply can never leave "No pets (Cats OK)" on a flyer, or the
  internal equivalent (a "No evictions" box beside contradicting details,
  a Self-guided tour type beside a landlord-led tour process) on a property
  page. Hence the eight items in D1.
- O2: a blank landlord value DOES count as differing everywhere (Cameron's
  original call): an own value against a blank landlord item shows purple
  "Set on this property / Landlord: blank". That is wanted as a hint that
  the landlord's record still needs filling in.

Vocabulary: a `unit` in code is a "property" in staff copy and a "home" in
tenant copy (documentation/GLOSSARY.md). This spec says "property" for the
staff-facing behavior and `unit` for code.

## 1. Goal

1. A landlord records its requirements once - evictions, pets, pet fee,
   credit, income, deposit, application fee, tour type and tour process, and
   free-form qualifications - and its properties get them.
2. A property keeps its OWN copy of every requirement ("copy only"). Nothing
   on a property changes because its landlord changed, until staff press
   Apply to properties and choose what to copy where.
3. Staff can always see, on a property, which requirement values were set on
   the property itself (a deliberate exception) and which are out of date
   because the landlord changed after they were copied. In Apply, a property
   holding a value set on the property for an item being copied starts
   UNCHECKED and names that item, so an exception is overwritten only when
   staff check that property on purpose.
4. A property can accept SEVERAL voucher sizes (Studio through 12), and every
   place that reads a property's voucher size handles the list: the flyer,
   Matching's pre-fill and blast audience, the Properties page, and the
   property page and forms.
5. New property fields: subzone on the forms (staff only), washer/dryer, a
   deposit that can be "one month's rent" and "flexible", and "No
   application fee".
6. Every field on the property forms, and every requirement on the
   landlord form, says whether tenants see it on the public flyer, so staff
   do not put something damaging in a public box by accident. A test fails
   if a property-form tag disagrees with what the flyer actually publishes.
   (The landlord's other fields - company, phones, onboarding answers, notes
   - never reach a flyer.)

Why: these are the inputs Work Package 1's AI ranking reads (decided
Oct 18: the AI ranking only, no rule-based scorer), and they are what Sam
checks by hand today when deciding whether a tenant fits a property. Nothing
in this mission filters or ranks on the requirements; it records them.

## 2. Today (verified 2026-10-20 on main @1d7a4667)

Property (unit) record and API:

- Writable unit fields are a strict allowlist, `WRITABLE_FIELDS` in
  `app/src/lib/unitFields.ts:46-117`; an unknown key is a 400
  (`unitFields.ts:162-165`). Relevant kinds today: `deposit` and
  `application_fee` are `'number'` (null is a 400, so they cannot be
  cleared, `:171-174`); `pets` is `'pets'`, a string OR a bare boolean
  (`:192-196`); `tour_type` clears on ''/null (`:197-212`); `tour_process`,
  `subzone`, `area`, `notes`, `lease_terms` are `'string'` (null is a 400,
  '' is stored as '', `:168-170`); `same_day_rta` is `'boolean'`
  (`:186-188`); `voucher_size_accepted` is `'clearable_number'`, ONE number
  >= 0 (not limited to integers), null REMOVEs it, an array is a 400
  (`:175-185`).
- `acceptedVoucherSizes(unit)` (`unitFields.ts:336-341`, hand-mirrored in
  `dashboard/src/routes/listing/listingFormat.ts:103-109`) already reads a
  number OR a list and falls back to `beds`. The full demo seed already
  stores a list, `voucher_size_accepted: [2, 3]` (`app/src/lib/seed/cast.ts:1358`),
  which the write API rejects today.
- Create: `POST /api/units` (`app/src/routes/units.ts:770-835`) validates,
  checks the landlord is a landlord contact (`:802-810`), creates with status
  `setup`, audits `unit_created` with no field list. Update: `PATCH
  /api/units/:unitId` (`units.ts:2115-2258`) reads the stored unit only for
  authorities, landlord or media changes (`:2152-2229`) and audits
  `unit_updated` with the changed field NAMES only (`:2249-2252`). There is
  no version check on a unit PATCH (`unitsRepo.ts:1139`,
  `attribute_exists(unitId)` only), and no bulk unit route anywhere.
- Every unit route answers with the raw stored item
  (`units.ts:762-766,834,854,2257`); there is no JSON replacer, so a stored
  DynamoDB string SET would reach the dashboard as `{}`.
- `landlordId` is written by: create; PATCH (`units.ts:2184-2206`, no
  dashboard form uses it - `dashboard/src/lib/holdingRefusals.ts:29-35`);
  restore-with-landlord (`POST /api/units/:unitId/restore`,
  `unitsRepo.restoreWithLandlord`, `unitsRepo.ts:790-826,1618`, used by
  `RestoreLandlordDialog.tsx:77-81`); a roster claim of the landlord slot on
  an ownerless unit (`unitsRepo.ts:666-668,1324`); and the importer, which
  fills an absent `landlordId` (`app/src/lib/import/apply.ts:1583-1597,
  1615-1619`).
- `unitsRepo.update` SETs non-null, REMOVEs null and always stamps
  `updated_at` (`app/src/repos/unitsRepo.ts:1101-1147`). A stamped
  `updated_at` is the importer's "human-owned" signal: the import then writes
  facts only `if_not_exists` (`apply.ts:1456-1475`).
- The import never writes deposit, pets, application fee, tour fields,
  subzone, area or voucher size (`apply.ts:1476-1621`). No seed, dev route or
  form writes `subzone` or `area`; only the API can.
- The public flyer projection `toUnitFlyer` (`unitFields.ts:343-371`) is an
  allowlist keyed by OUTPUT field. Public today: beds, baths, area, SUBZONE,
  `voucher_size` (the FIRST of `acceptedVoucherSizes`, `:356`, a value
  DERIVED from the never-public key `voucher_size_accepted` and from `beds`),
  accepted authorities, listing link, rent, address, utilities, video,
  application fee, same-day RTA, pets, accessibility, deposit, lease terms.
  Never public: notes, tour type, tour process, application process, payment
  standard. Served at `GET /public/units/:unitId/flyer`
  (`app/src/routes/public.ts:451-464`).
- `FlyerPage.tsx` shows "subzone, area" as the neighborhood line (`:54-56`),
  "Fits a <strong>N-bedroom</strong> voucher" from the single `voucher_size`
  (`:265-268`), and Deposit / Application fee as "$N" - a $0 fee renders
  "$0" (`:298-331`); pets via `petsLabel` (true "Allowed", false "Not
  allowed", `:110-115`).
- The unit Activity feed projects audit rows through `toUnitActivityEvent`
  (`units.ts:311-376`), which lifts `reason` only for
  `unit_primary_contact_assigned`, on purpose: `listing_status_changed`
  stores free text under the same key (`:369-374`). The dashboard labels
  `unit_updated` "Property updated" plus field names
  (`listingFormat.ts:225-228`).
- Route tests use a hand-written in-memory units repo
  (`app/test/helpers/twilioWebhookHarness.ts:2857-2925`).

Property page and forms (dashboard):

- `ListingDetail.tsx` "Property details" card (`:948-989`) shows Deposit,
  Pets (`unit.pets ?? '-'`: a boolean renders blank, `:966`), Lease terms,
  Application fee, Same-day RTA (Yes / No / -, `:969-972`), and "Voucher
  size accepted" only when the stored value is a NUMBER (`:973-975`). No Area
  or Subzone row. A "Tour & application process" card (`:1012-1034`) shows
  tour type, tour process and application process. The page loads the
  landlord contact once from `unit.landlordId`, best effort
  (`useListing.ts:129-143,212`).
- `ListingEditForm.tsx` and `UnitCreateForm.tsx` have no Area or Subzone
  input; Voucher size accepted is one number input; a blank number input
  means "untouched" except for the clearable voucher size
  (`ListingEditForm.tsx:127-151,195-206`). The edit form writes
  `same_day_rta: false` when unticked (`:159`) and turns a legacy boolean
  `pets` into 'Yes'/'No' text (`:87-95,180`). Its one hint line says
  "Address, rent, deposit, fees, utilities, pets, accessibility, and lease
  terms are shown on the public flyer." (`:279-282`).
- `UnitCreateForm` sends only NON-EMPTY fields (`:173-222`). It has two entry
  points: the landlord page's "+ Add a property" with the landlord LOCKED
  (`ContactDetail.tsx:1412-1420`), and the Properties list's "+ New
  property" with a landlord PICKER (`ListingsList.tsx:464-472`). It loads the
  full list of landlord contacts into state (`UnitCreateForm.tsx:62,136-169`);
  the locked-landlord fallback keeps only a label (`:157-166`), and a failed
  load is silent (`:150-153`).
- No current dashboard form writes a boolean `pets`; booleans come from old
  data and raw API calls.

Landlord record:

- A landlord is a contact (`type: 'landlord'`; a property manager is a
  landlord-typed contact with a role, `units.ts:797`). Its structured fields
  today are `contract_status`, `registered_landlord`, `rta_within_48h`,
  `pass_inspection_first_try`, `income_includes_voucher`
  (`app/src/routes/contacts.ts:388-400`), shown in the "Landlord onboarding"
  card and edited in the landlord section of `ContactEditForm.tsx`
  (`:871-973`), which sends only the fields that changed (`:327-350`).
- The contacts table already uses top-level `pets` and `evictions` for
  TENANTS (`contactsRepo.ts:327-331`); they are not type-gated, and they are
  AI-provenance fields: a PATCH of `pets` clears `pets_source` and consumes
  pending AI suggestions (`contacts.ts:1760-1792`). Contacts PATCH ignores
  unknown top-level keys (`contacts.ts:402-406`); units return 400. A contact
  has no `updated_at`.
- The landlord page (`LandlordFile.tsx`) cards, in order: Details, Landlord
  onboarding, Notes (whose empty-state copy says "(Programs, lease terms, and
  pet policy live on each property.)", asserted by
  `e2e/tests/dashboard-next/contact-detail.spec.ts:134-155`), Properties,
  Tours, Placements, group texts, group threads, media. It loads all units
  once and keeps those whose `landlordId` is this contact
  (`useContactFile.ts:149-158`, refetch at `:124-125`;
  `buildContactFile.ts:18-20`).

Matching (blasts):

- The audience filter holds ONE voucher size, `bedroomSize?: number`
  (`app/src/repos/broadcastsRepo.ts:95`; validated as an integer 0..12 at
  `app/src/routes/broadcasts.ts:210-217`). The resolver matches it EXACTLY
  (`app/src/services/audienceResolution.ts:186-189`). The "4+ BR" chip sends
  4 (`dashboard/src/routes/broadcasts/broadcastFormat.ts:33-39`), so tenants
  holding a 5- to 12-bedroom voucher never match it (open issue
  `docs/issues/broadcast-4plus-exact-match-underreach.md`).
- The composer pre-fills the FIRST of the property's sizes
  (`BroadcastComposer.tsx:205`), not capped at 4 (`:213`): a 5-bedroom
  property pre-fills 5, which no chip shows as pressed
  (`AudienceFilters.tsx:150-152,175`). So stored filters of 5..12 can exist.
- The stored filter is re-read at preview and send
  (`broadcasts.ts:1042,1285`) and projected by `wireAudienceFilter`, which
  copies `bedroomSize` only when it is a number
  (`app/src/lib/blastAudienceRules.ts:222-234`). `voucherSizeLabel` already
  labels any size of 4 or more "4+ BR" (`broadcastFormat.ts:44-48`).

Tenant voucher size: an integer 0..12 everywhere it is written
(`contacts.ts:581-588,851-857`; `public.ts:146-152`; extraction
`apply.ts:104-108`). The Properties and Tenants page chips bucket 4 and up
as "4+" (`tenantFacets.ts:45-51,128-137`; `unitListFacets.ts:175-196`,
already list-ready).

## 3. Decisions

### D1 The requirement items

There are eight requirement ITEMS. An item is the unit of copying,
comparing and tagging. Every item exists on both the landlord and the
property. Order and grouping are the display order everywhere. Item ids are
their own namespace (stored in `requirement_sources`, sent in the Apply
API); keys are the stored attribute names on the unit; each key is one
FIELD on the forms.

A checkbox or choice and the free text that details it are ONE item
(Cameron, 2026-10-20), on or off the flyer, so copying one can never leave
the other contradicting it.

| Group | Item id | Item label | Fields (unit keys) | Flyer |
|---|---|---|---|---|
| Screening | `evictions` | Evictions | checkbox "No evictions while on the program" (`no_evictions_on_program`); text "Evictions (details)" (`evictions_notes`) | Staff only |
| Screening | `credit_requirements` | Credit score | text (`credit_requirements`) | Staff only |
| Screening | `income_requirements` | Income requirements | text (`income_requirements`) | Staff only |
| Screening | `qualifications` | Qualifications | long text (`qualifications`) | Staff only |
| Pets | `pets` | Pets | checkbox "No pets" (`no_pets`); text "Pets (details)" (`pets`, existing); text "Pet fee" (`pet_fee`) | On flyer |
| Move-in costs | `deposit` | Deposit | checkbox "One month's rent" (`deposit_one_month`); money "Fixed amount" (`deposit`, existing, dollars); checkbox "Flexible / payment terms available" (`deposit_flexible`); text "Deposit notes" (`deposit_notes`) | On flyer, except the notes (Staff only) |
| Move-in costs | `application_fee` | Application fee | money (`application_fee`, existing, dollars; 0 = "No application fee") | On flyer |
| Touring | `touring` | Touring | select "Tour type" (`tour_type`, existing enum); text "Tour process" (`tour_process`, existing) | Staff only |

Credit score, income requirements and qualifications are free text with no
checkbox, so they stand alone.

The checkbox label stays exactly "No evictions while on the program".
Credit and income stay notes only: nothing matches on them (fair-housing
question still open, tracker #11). A tenant's eviction history stays the
tenant's existing free-text field; the Work Package 1 AI ranking weighs it
against this checkbox and the details. Qualifications are staff only
(Cameron, 2026-10-20), which reverses the older intent in
`docs/issues/unit-onboarding-fields.md` and
`documentation/landlord-onboarding-sequence.mermaid:82` that qualifications
go on the shareable listing; both are updated (section 7).

ONE registry module defines the items: id, label, group, keys, kinds and
flyer visibility, shared by validation, copying, comparing and the UI (an
app module plus its hand mirror in the dashboard, the `acceptedVoucherSizes`
pattern, with the same test cases in both suites).

Values, per kind (these rules apply to the requirement keys; existing
non-requirement fields such as `same_day_rta` keep their kinds):

- checkbox: `true` or absent. Writing `false` or null REMOVEs the key: for a
  requirement checkbox, unchecked means "not a rule", and "No" and "not
  recorded" are deliberately the same value.
- text: a string, trimmed; '' or null REMOVEs the key.
- money (`deposit`, `application_fee`): a finite number >= 0, or null to
  REMOVE. Both become clearable (today they are not).
- `tour_type`: unchanged (`self_guided` / `landlord_led` / `pm_team`, ''/null
  REMOVEs).
- Deposit: "One month's rent" and a fixed amount are ALTERNATIVES. A write
  whose resulting property (or landlord) would hold both
  `deposit_one_month` and `deposit` is a 400 `deposit_conflict`, checked
  against a CONSISTENT read of the stored record whenever the body carries a
  deposit key. Both forms, on the save that CHECKS "One month's rent", send
  the amount as null in the same save (even when the amount looked
  unchanged), so a form opened before a colleague set an amount does not
  dead-end; saves that leave the box as it was do not send the amount. No
  property holds `deposit_one_month` today, so no stored record conflicts.

Legacy `pets` booleans (old data and raw API callers only):

- READ interpretation: `pets: false` = No pets checked and details blank;
  `pets: true` = No pets unchecked and details "Allowed". Free text such as
  "No pets" is NOT parsed: it stays details text (so the seeds' and most live
  properties' "No pets" text differs from a landlord's No pets checkbox, and
  those properties show as set on this property - expected).
- WRITE of a boolean: the unit `pets` key still accepts a boolean (raw API
  callers). A written boolean MEANS what the read interpretation says
  (`false` = No pets checked and details blank; `true` = No pets unchecked
  and details "Allowed") and is stored in the new shape at once (the Pets
  item is classified, D5). The landlord side never accepts a boolean.
- A STORED legacy boolean met by a write that changes only some keys of
  the Pets item (for example a PATCH of `pet_fee` alone): the write also
  stores `no_pets` and `pets` in the new shape with their interpreted
  values, so nothing else in the item changes.

Item equality (used by copying, tags and Apply): two values of an item are
EQUAL when every key of the item is equal after the read interpretation
above, where absent, '' and `false` are all "blank", text compares after
trimming (case-sensitive), and numbers compare exactly. A multi-field item
(Evictions, Pets, Deposit, Touring) is equal only when all its keys are
equal.

### D2 Where the requirements are stored

- On the PROPERTY: flat keys on the unit, the names in D1, added to
  `WRITABLE_FIELDS` with the kinds above. Existing keys keep their names, so
  existing values, the flyer projection and every existing reader
  (`TourDetail` guidance card, `ScheduleTourForm` prefill,
  `listingSendOutcome`, `contact/Card.tsx`) keep working.
- On the LANDLORD: flat keys on the contact with a `req_` prefix
  (`req_no_evictions_on_program`, `req_evictions_notes`,
  `req_credit_requirements`, `req_income_requirements`, `req_qualifications`,
  `req_no_pets`, `req_pets`, `req_pet_fee`, `req_deposit_one_month`,
  `req_deposit`, `req_deposit_flexible`, `req_deposit_notes`,
  `req_application_fee`, `req_tour_type`, `req_tour_process`), with the D1
  kinds (no boolean `req_pets`). Prefixed, not bare, because `pets` and
  `evictions` already mean the TENANT's answers on the contacts table and
  carry AI provenance (section 2). Contacts PATCH accepts them one by one,
  like every other contact field (the edit form keeps sending only what
  changed, so two staff editing different items do not overwrite each
  other); each is a 400 on a contact whose resulting type is not
  `landlord`. The audit `contact_updated` lists the changed `req_` keys.
  Contact CREATE does not take them (the new-landlord form has Company only).
- Every landlord-typed contact can hold requirements, property managers
  included; requirements reach a property only from its landlord of record
  (`landlordId`).

### D3 Property-only fields: subzone, washer/dryer

- `subzone`: free text (Sam's codes, for example E8 or SE11), now on the New
  and Edit forms and a row on the property page. STAFF ONLY: it leaves the
  public flyer projection and the flyer's neighborhood line (which becomes
  `area` alone). Nothing holds a subzone today (section 2), so no tenant has
  ever seen one. It keeps feeding the similar-properties score
  (`app/src/lib/similarUnits.ts:52-65`). Where the codes come from is an
  open question for Sam (it does not change the build). Its kind becomes
  clearable text ('' or null REMOVEs).
- `area` is NOT added to any form (Cameron, 2026-10-20: not requested, and a
  free-text area per property would have to be renamed property by
  property). It keeps its current readers.
- `washer_dryer`: one of `hookups` ("Hookups"), `included` ("Washer and dryer
  included"), `none` ("No hookups"), or absent ("Not recorded"; '' or null
  REMOVEs). On the flyer. Existing washer/dryer text in Notes stays there.

### D4 Voucher sizes accepted: a list

- `voucher_size_accepted` becomes a list. The write kind accepts: null or
  `[]` (REMOVE - the property falls back to its bedrooms, as today); an
  integer 0..12 (a raw caller or an older bundle; stored as a one-item list);
  or an array of integers 0..12 (stored de-duplicated, ascending). Anything
  else is a 400 (this also stops non-integer sizes, which the tenant side
  never allowed). Stored single numbers are not backfilled;
  `acceptedVoucherSizes` already reads both shapes and stays the ONE reader
  (GLOSSARY).
- The New and Edit forms use picker B: chips Studio, 1, 2, 3, 4, and a "More
  sizes (5-12)" control that shows chips 5 through 12. The larger chips show
  automatically when the property already records a size of 5 or more; a
  "Fewer sizes" control hides them again only when none of them is
  selected. A line under the chips reads "Accepts: 2 BR, 3 BR" ("none
  recorded" when empty). Emptying the picker sends null (as clearing does
  today). The picker is a group of toggle buttons with `aria-pressed`, under
  the label "Voucher sizes accepted".
- A stored value the picker has no chip for (a non-integer or a size above
  12, possible under today's rule) is listed under the chips as "Not a
  valid size, removed when you save: 2.5"; saving sends the list without
  it.
- The property page row "Voucher sizes accepted" lists the RECORDED sizes
  ("Studio, 2 BR, 3 BR") and stays empty when none is recorded (Cameron's
  2026-10-12 decision stands: never the bedrooms fallback on that row).
- The Properties page chips and By housing authority counts already handle a
  list (a property counts under each size, `unitListFacets.ts:175-196`): no
  change.

### D5 Copy only, and where each value came from

A property never reads its landlord's requirements at render time to fill
its own: it shows and serves only its own stored values. To tell an
exception from an out-of-date copy, each property records, per item, where
its current value came from, in ONE map attribute on the unit,
`requirement_sources: { <item id>: 'copied' | 'set_here' }`, a plain map
(JSON-safe; a DynamoDB string set would reach the dashboard as `{}`,
section 2). An item absent from the map is NEVER TOUCHED (every item on
every property that exists today). The map is written only by the server
(it is not in `WRITABLE_FIELDS`), always WHOLE, as part of the same update
that writes the item keys; an empty map REMOVEs the attribute. Every route
that returns a unit returns it as stored, so the dashboard reads it
directly.

The server classifies every item whose INTERPRETED value (D1) a write
actually changes - after the D1 normalizations, so a cleared deposit amount
counts, while a legacy pets key rewritten into the new shape with the same
meaning does not - by comparing the property's RESULTING value of the item
with the landlord's value (D1 equality): equal -> `copied`; different ->
`set_here`. "The landlord's value" is:

- POST create FROM THE FORM: the body carries `requirements_snapshot`, the
  landlord's values the form pre-filled (`{ <item id>: { <unit key>: <value
  or null> } }`, every item). The server classifies ALL eight items, a key
  left out of the body counting as blank, against that SNAPSHOT: a field
  staff left as pre-filled is `copied` (it WAS copied from the landlord,
  even if the landlord changed while the form was open - the property then
  shows Landlord updated, which is the truth), and a field staff changed or
  cleared is `set_here`. The snapshot's values are TRUSTED, not verified
  (the New form is their only producer and it is a staff tool), but the
  snapshot names the landlord it was taken from (`requirements_snapshot.
  landlordId`), and a create whose snapshot names a different landlord than
  the body's `landlordId` is a 400. An item the snapshot does not name (a form
  open across a later registry change) is classified as if there were no
  snapshot (next bullet); a key it does not name counts as blank; unknown
  items are ignored.
- POST create WITHOUT a snapshot (API callers, e2e setup, scripts, a form
  open from before the deploy): the general rule - only items whose stored
  keys the create actually writes (a non-blank value) are classified,
  against the landlord's CURRENT values; everything else stays never
  touched.
- PATCH: the landlord's CURRENT values. So an edit that makes a value differ
  makes it set on this property, and editing it back to the landlord's value
  makes it a copy again.
- Apply (D8): every item whose keys the Apply wrote becomes `copied`.
- Whenever a property's landlord of record CHANGES - PATCH `landlordId`,
  restore with a different landlord (`restoreWithLandlord`), or a roster
  claim of the landlord slot (`addContact`) - the map is REMOVEd in the same
  write: every item becomes never touched against the new landlord. A PATCH
  that changes `landlordId` AND touches items first resets, then classifies
  the touched items against the NEW landlord.
- The importer's fill of an absent `landlordId` does not touch the map. A
  property with no landlord classifies every touched item as `set_here`, so
  after the importer gives it a landlord, those items read as set on this
  property - which is what they were. Accepted.
- The landlord's own edits never touch any property.

Reads and the fence: create already reads the landlord contact
(`units.ts:802-810`). PATCH, when the body touches an item or changes the
landlord, reads the stored unit (consistent read: its landlord, the other
keys of a multi-key item, a legacy `pets` boolean, the current map) and the
landlord contact, computes the new keys and the whole new map, and writes
them CONDITIONED on the unit's `requirement_sources` and `landlordId` still
being what it read (absent included). Because the map is rewritten whole,
this is a read-modify-write of shared state, so it follows the repo's
optimistic pattern (`updateRosterIfCurrent`, `unitsRepo.ts:948-1017`): on a
condition failure it re-reads and recomputes, up to 3 attempts, then
answers 409 `property_changed`; the edit form stays open with what staff
typed and says "This property changed while you were saving. Save again."
(saving again is safe: the patch carries only the changed fields and the
server recomputes). This also stops a slow PATCH from writing
an old map back after a restore or roster claim REMOVEd it. A concurrent
change of the LANDLORD's values between the landlord read and the write is
not fenced (it can leave one item classified against the landlord's
previous value until the item's next write); accepted.

### D6 How a property shows each requirement (layout A)

For each item, comparing the property's value with the landlord's current
value:

| Property vs landlord | `requirement_sources[item]` | Shows |
|---|---|---|
| equal | any | the value, no tag |
| different | `copied` | the value + orange tag **Landlord updated** + a small line "Landlord now: <value>" |
| different | `set_here` | the value + purple tag **Set on this property** + "Landlord: <value>" |
| different, property value not blank | absent (never touched) | as `set_here` (an existing value counts as set on this property - Cameron, 2026-10-20) |
| property blank, landlord not blank | absent (never touched) | blank + "Landlord: <value>", no tag |

A blank landlord value prints as "blank", and it COUNTS as differing
(Cameron, 2026-10-20): an own value against a blank landlord item shows
purple "Set on this property / Landlord: blank". On the day this ships every
existing value shows that, because no landlord has requirements yet; that is
intended - it points staff at landlords whose records still need filling
in. When the landlord of record has no requirement recorded at all, the card
also says "<Landlord name> has no requirements recorded yet." When the
property has no landlord, or the landlord contact fails to load, no tags or
landlord lines show.

A multi-field item (Evictions, Pets, Deposit, Touring) shows its fields
together and carries ONE tag and ONE landlord line for the item, giving the
landlord's whole item value (for example "Landlord: No pets; pet fee $300").

OWN VALUE (used by Apply, D8) is defined by this table, never by what the
card happens to display: an item is an own value on a property when its
record is `set_here`, or it is never touched and the property's value is not
blank - whatever the landlord holds. The two tags differ in lightness as
well as hue (accessibility), and each carries its text, not color alone. The property page re-reads the landlord
contact whenever the unit's `landlordId` changes (a roster claim or restore
without a reload).

### D7 A new property starts filled in from its landlord

`UnitCreateForm`'s Requirements section starts filled in with the
landlord's requirements as soon as the landlord is known (locked from the
landlord page, or picked), with a note "Filled in from <landlord name>'s
requirements. Change anything that is different for this property." Picking
a DIFFERENT landlord refills the section from the new landlord, replacing
anything typed there. Staff can change any field before saving. The form sends the landlord's
values it filled in as `requirements_snapshot` (D5), so an unchanged field
is a copy and a changed or cleared one is set on this property. When the
landlord has no requirements, the section starts blank (and the snapshot is
all blank).

The form keeps the chosen landlord's full Contact (the picker list already
holds them; the locked path loads the contact itself instead of only its
label). While the landlord's record is loading, the Requirements section shows
"Loading <landlord>'s requirements..." and Save waits. If it fails to load,
the section shows "Couldn't load <landlord>'s requirements, so this property
starts without them. You can apply them from the landlord page later." with
Try again; Save is allowed, and the form sends NO snapshot, so only what
staff typed is recorded and nothing is mistaken for an exception (D5).

### D8 Apply to properties (dialog B)

The landlord's Requirements card has an **Apply to properties** button
(disabled, with a reason, when the landlord has no properties). It opens one
dialog, two columns. Opening the dialog RE-READS the landlord contact and
its properties (the landlord page may have been open for hours); the
dialog shows a loading state until both reads land, and an error with Try
again if either fails.

Left, "What to copy": every item, with the landlord's value (a multi-field
item is one row showing all its fields, so Pets copies No pets, the details
and the pet fee together). Items with a value start CHECKED; blank items start UNCHECKED and are marked "Clears";
checking a blank item copies the blank, clearing that item on the chosen
properties (Cameron, 2026-10-20).

Right, "Which properties": the landlord's properties (landlord of record,
not deleted, any status), each with its address and status. Each row lists,
live, the checked items that would CHANGE on it, and marks each of those
that is an OWN VALUE on that row (D6 definition) as "own value". A row:

- with no changes reads "Already matches" and cannot be checked;
- starts UNCHECKED when any changing item is an own value;
- otherwise starts CHECKED.

There is no Select all. To copy some items while keeping properties' own
values for others, staff uncheck those items on the left: every row
recomputes, and a row whose only own-value changes were in the unchecked
items starts checked. A row with its own values is updated only when staff
check it. Changing the left column recomputes every row's changes, starting
state and "Already matches". A row staff UNCHECKED by hand stays unchecked
(unless it becomes "Already matches"). A row staff CHECKED by hand resets to
unchecked when a left-column change ADDS an own-value item to its changes
(staff confirm it again); removing items never resets it. The button reads
"Update N properties" (N = checked rows; disabled at 0).

Server: `POST /api/contacts/:contactId/requirements/apply` with
`{ units: [{ unitId, ownItems: string[] }], items: string[], expected: { <item id>: { <unit key>: <value or null>, ... } } }`
- `expected` holds, for every listed item, every one of its keys as the
dialog showed the landlord's value (null for blank); `ownItems` lists, per
unit, the changing items the dialog showed as that row's own values (the
ones staff accepted by checking the row; empty for a row with none).

- 404 when the contact does not exist; 400 when it is not a landlord, when
  `items` is empty or names an unknown item, when `expected` does not cover
  exactly the listed items and their keys, when `units` is empty, repeats a
  unit, or is over 100, or when an `ownItems` entry is not a listed item.
- 409 `requirements_changed` when the landlord's current value of any listed
  item is not EQUAL (D1) to `expected`, or 409 `deposit_conflict` when the
  landlord holds both a one-month deposit and an amount; nothing is applied.
  On `requirements_changed` the dialog re-reads the landlord and its
  properties itself and shows "This landlord's requirements changed. Review
  the updated list and press Update again."
- For each unit, in order: a consistent read; skip it with a reason when it
  does not exist (`not_found`), is deleted (`deleted`), or its `landlordId`
  is not this contact (`landlord_changed`); compute its changing items (by
  INTERPRETED value, D1: a legacy pets key the write merely rewrites into
  the new shape is not a changing item and keeps its record) and,
  from its own `requirement_sources` and values, which of those are own
  values (the D6 definition); skip it as `changed_since_opened` when one is an own value the
  request did not list in that unit's `ownItems` (an exception set after the
  dialog loaded is never overwritten unseen); skip it as `already_matches`
  when nothing changes. Otherwise write the changing keys (SET, or REMOVE for
  blank, the pets pair normalized per D1) and the whole new
  `requirement_sources` map - the items whose keys this write changed become
  `copied`; a listed item that already equaled the landlord keeps its record
  (D5's rule) - in ONE conditional update
  through a new repo method (`unitsRepo.applyRequirements`), conditioned on
  the unit still existing, not deleted, with this `landlordId` and the
  `requirement_sources` value it read. A condition failure is skipped as
  `changed_during_apply`. Each written unit gets `updated_at` (like any staff
  edit) and one audit `unit_updated` with the changed item keys, `reason:
  'requirements_applied'` and the `landlordId`.
- Response: `{ updated: string[], skipped: [{ unitId, reason }] }`. The
  dialog sends the checked properties in requests of at most 100, one after
  another, and merges the responses. If a later request answers 409 or
  fails, the dialog sends no more, re-reads the landlord and its
  properties, and says "Updated N properties before this stopped. Review
  the rest and press Update again." (N from the responses that landed; the
  re-read shows the true state). Otherwise it closes; the landlord page re-reads its properties (the
  existing refetch) and takes the landlord contact the dialog last read, so
  its Requirements card matches what was applied, and shows "Updated N properties" plus, when any were
  skipped, "M skipped" with each address and a plain reason ("changed since
  you opened this - review it again" for `changed_since_opened` and
  `changed_during_apply`).

The writes are not one transaction (no unit write is today); a failure part
way leaves earlier units applied, and the response says which. A property
edited after the dialog loaded is still written for the checked items
UNLESS the edit created an own value the dialog did not show
(`changed_since_opened`) or raced the write (`changed_during_apply`).

### D9 Landlord page and landlord edit form

- A new card **Requirements / Qualifications** sits right after "Landlord
  onboarding" on the landlord page: the eight items in their groups, blank
  ones as "-", with **Apply to properties** and **Edit** actions. Edit opens
  the existing landlord edit form.
- `ContactEditForm` gets a "Requirements / Qualifications" fieldset for
  landlords, after the Landlord onboarding fieldset, using the same shared
  Requirements fields component as the property forms. Its tags read **On
  property flyers** / **Staff only**, because these values reach flyers only
  through properties. It sends only the `req_` keys that changed.
- The existing "Voucher counts as income" checkbox stays in Landlord
  onboarding, unchanged.
- The Notes empty state changes to "No notes yet - use + Add." (pets now
  also live on the landlord's requirements); the e2e assertion moves with
  it, and the assertion that the landlord edit form has no pet fields
  (`contact-detail.spec.ts:134-155`) is replaced by one for the new
  fieldset.

### D10 Property page and property forms

Property page (`ListingDetail`):

- "Property details" keeps beds/baths, rent, payment standard, housing
  authorities, utilities, accessibility, lease terms, same-day RTA, video,
  and gains **Subzone**, **Washer / dryer** and **Voucher sizes accepted**
  (D4). Deposit, Pets and Application fee move out to Requirements.
- A new **Requirements** card (D6, layout A) shows the eight items in their
  groups. Its Edit opens the existing property edit form.
- "Tour & application process" keeps Application process; tour type and tour
  process move to Requirements.

New and Edit property forms:

- Order: Property details (housing authorities, beds, baths, voucher sizes,
  rent min / max, payment standard, address, subzone, washer/dryer,
  utilities, accessibility, lease terms, listing link, video URL, same-day
  RTA), then Requirements (the shared component), then Application process
  and Notes.
- EVERY field carries a tag beside its label, from the D10a table: **On
  flyer** (tenants see it on the public flyer) or **Staff only** (never
  leaves the dashboard). The tag is NOT part of the field's accessible name:
  it renders outside the `<label>` text and is tied to the input with
  `aria-describedby`, so field names (and every existing `getByLabel` /
  `getByLabelText` selector) stay as they are. A legend under the form
  title explains both, replacing today's single hint line. Public free-text boxes (pets details,
  pet fee, utilities, accessibility, lease terms) also show "Tenants see
  this on the public flyer." under the box.
- "No application fee" is a checkbox above the amount; checked, it records 0
  and disables the amount; unchecked, the amount is editable and blank means
  no fee recorded. "One month's rent" likewise clears and disables the fixed
  deposit amount (D1: they are alternatives).
- Same-day RTA keeps its kind and its Yes / No / - display.

### D10a Which fields are public (the tag table)

| Form field | Tag | Reaches the flyer as |
|---|---|---|
| Housing authorities | On flyer | `accepted_authorities` ("Accepts:") |
| Beds, Baths | On flyer | `beds`, `baths` (beds also feeds the voucher-size fallback) |
| Voucher sizes accepted | On flyer | `voucher_sizes` / `voucher_size` (derived) |
| Rent min, Rent max | On flyer | `rent_min`, `rent_max` |
| Payment standard | Staff only | - |
| Address (every part) | On flyer | `address` |
| Subzone | Staff only | - |
| Washer / dryer | On flyer | `washer_dryer` |
| Tenant-paid utilities | On flyer | `utilities` |
| Accessibility | On flyer | `accessibility` |
| Lease terms | On flyer | `lease_terms` |
| Public listing link | On flyer | `listing_link` |
| Video URL | On flyer | `video_url` |
| Same-day RTA | On flyer | `same_day_rta` |
| The fields of the eight items | per D1 | per D11 |
| Application process | Staff only | - |
| Notes | Staff only | - |

The table lives in the registry module (app and dashboard mirror). An
app-side test walks it: for each field, two units differing only in that
field must produce DIFFERENT `toUnitFlyer` output when the field is On
flyer and IDENTICAL output when it is Staff only. The dashboard mirror
carries the same table with a parity test of the same cases.

### D11 Public flyer

- Voucher size: "Fits a 2- or 3-bedroom voucher"; one size "Fits a
  2-bedroom voucher"; studio "Fits a studio voucher"; mixed "Fits a studio or
  1-bedroom voucher"; three or more "Fits a 1-, 2-, or 3-bedroom voucher".
  The projection adds `voucher_sizes: number[]` (all of
  `acceptedVoucherSizes`, ascending).
- Pets: "No pets" when checked, followed by the details in parentheses when
  there are any ("No pets (service animals only)"); otherwise the details;
  a legacy boolean reads as in D1. The pet fee is its own row.
- Deposit: a row appears when "One month's rent", a fixed amount or
  "flexible" is recorded (never for the staff-only notes alone). It reads
  "One month's rent" or "$N", followed by ", flexible / payment plan
  available" when flexible is checked; flexible alone reads "Flexible /
  payment plan available". (The tenant-facing wording Cameron approved; the
  form checkbox keeps Sam's label "Flexible / payment terms available".)
  Deposit notes never appear.
- Application fee: "No application fee" for 0, "$N" otherwise, no row when
  absent.
- Washer / dryer: a row with its label, only when recorded.
- Subzone: removed (D3); the neighborhood line is `area` only.
- Staff-only items (screening, deposit notes, tour type, tour process) are
  never in the projection. The projection stays an allowlist.

Older bundles: a flyer page already open in a browser keeps reading the old
fields until it reloads. The projection keeps every existing key it can
fill (`voucher_size` = the first size, `deposit`, `application_fee`, `pets`)
and only ADDS keys; an old page may show "$0" for no fee or omit the No
pets flag until reloaded. Accepted (the page reloads on the next visit).

### D12 Matching: several voucher sizes

- The audience filter's voucher size becomes a list, `bedroomSizes:
  number[]`, of CHIP values 0..4 where 4 means "4 or more" (the chip already
  reads "4+ BR"). A tenant matches when its voucher size equals a chosen
  value below 4, or is 4 or more when 4 is chosen. This fixes the 4+ chip and
  closes `broadcast-4plus-exact-match-underreach`.
- Old shape: a stored or posted `bedroomSize: n` reads as `bedroomSizes:
  [min(n, 4)]`, through ONE normalizer used by validation, preview, send and
  the projections (the `authoritiesOfFilter` pattern,
  `blastAudienceRules.ts:182-204`). New drafts store `bedroomSizes`; stored
  records are not rewritten. POST accepts either key; `bedroomSizes` wins
  when both are sent. Values must be integers 0..12 (as today) and are
  clamped to 4, de-duplicated, ascending; an empty list is no size filter.
- The projection (`wireAudienceFilter`) returns `bedroomSizes` for every
  record, old or new, and also `bedroomSize` (the first size) when there is
  one, so a dashboard page open from before the deploy still shows a size.
  Such a page shows a multi-size draft as its first size only, and a filter
  edit made there re-creates the draft with that one size; this lasts until
  the page reloads and is accepted.
- The composer's voucher-size chips become multi-select toggles. With a
  property, the filter pre-fills one chip per accepted size
  (`acceptedVoucherSizes`, so a property with no recorded size still
  pre-fills its bedrooms as today), each size of 4 or more mapping to the 4+
  chip, and each pre-filled chip carries the "matches property" tag. The
  pre-fill note names the sizes ("Pre-filled to the voucher sizes this
  property takes: 2-BR, 3-BR"). All the D3 ownership and hold rules from the
  blast-rules design (2026-10-14) stay as they are; the sizes are one more
  filter they cover.
- The audience summary lists the sizes ("2-BR, 3-BR"). The draft key the
  composer uses to decide whether a draft is stale includes the size list.
- A property that takes only 5-bedroom vouchers pre-fills 4+, which also
  reaches 4-bedroom holders; staff uncheck by hand (Cameron, 2026-10-20:
  acceptable, no real data at those sizes).

### D13 History

- A staff edit keeps `unit_updated` with field names (the Activity feed shows
  "Property updated: Pets, Pet fee"). The names are the unit keys the write
  actually changed, including keys the server changed itself (the pets
  partner key, a cleared deposit amount); `requirement_sources` is never
  listed.
- An Apply writes `unit_updated` with `reason: 'requirements_applied'`. The
  Activity projection (`toUnitActivityEvent`) lifts `reason` for
  `unit_updated` ONLY when it is exactly `requirements_applied` (the
  free-text `listing_status_changed` guard stays); the feed shows
  "Requirements applied from the landlord" with the field names.
- A landlord edit writes `contact_updated` with the changed `req_` keys.

## 4. Consequences to know

- Copying TOUR TYPE onto properties changes behavior: a property's tour type
  decides how a share's "interested" reply routes (`units.ts:1466-1470`,
  `listingSendOutcome.ts:111-112`) and pre-fills Schedule tour
  (`ScheduleTourForm.tsx:247-253`). Applying a landlord's tour type to a
  property with none makes those paths work for it; applying a blank tour
  type removes it (409 `tour_type_required` comes back for that property).
- Apply stamps `updated_at` on each property it writes, which makes an
  import-owned property human-owned for the importer, exactly as any staff
  edit does.
- Existing deposit, pets, application fee, tour type and tour process values
  count as set on this property, and on the day this ships every one of them
  shows purple "Set on this property / Landlord: blank" until its landlord
  is filled in (intended, D6). On a landlord's first Apply, rows with
  those values start unchecked for those items; staff either uncheck those
  items on the left (to fill only the new items, such as credit and
  qualifications) or check each property whose values should be replaced.
- The flyer stops showing subzone; no flyer has shown one, since nothing
  ever recorded it.
- The 4+ fix widens stored filters: a stored `bedroomSize` of 4 now also
  reaches 5- to 12-bedroom holders, and a stored 5 to 12 (possible from the
  uncapped pre-fill) now reaches every holder of 4 or more, if that draft is
  previewed or sent. Sent blasts already display any size of 4 or more as
  "4+ BR" (`voucherSizeLabel`), so their history reads the same.

## 5. Out of scope

- The Work Package 1 AI ranking, and any AI prompt change (#32 is its own
  item). Blasts do not filter on No pets or No evictions.
- Matching on credit or income.
- The #13 flyer changes (heading, rent, same-day tour) and the #26 printable
  flyer.
- Area on the forms; a subzone-to-area name list.
- Requirements on the NEW-landlord form; copying from roster members other
  than the landlord of record.
- Per-property, per-item choices in Apply (one item list applies to every
  checked property; Cameron chose dialog B over the grid).
- Any backfill or migration; changes to the importer.
- The tenant's eviction history (stays free text).

## 6. Testing

App (vitest):

- Registry and validation: each kind (checkbox REMOVE on false/null; text
  trim and REMOVE on ''; money clearable; `deposit_conflict`; legacy `pets`
  boolean accepted on the unit write and stored in the new shape; no boolean
  on `req_pets`); `voucher_size_accepted` accepts null, [], an integer, an
  integer list (de-duplicated, sorted) and rejects 13, -1, 2.5, strings,
  mixed lists; item equality including the Deposit group and legacy pets.
- Contacts PATCH `req_` keys: landlord only (400 for other types), one key
  at a time, unknown `req_` key ignored like any unknown key, and a landlord
  `req_pets` does NOT touch `pets_source` or AI suggestions.
- Classification (D5): create with a snapshot and a cleared pre-filled item
  -> `set_here`; create with a snapshot and untouched values -> all `copied`,
  also when the landlord changed after the snapshot; create without a
  snapshot -> only body items classified, against the current landlord; a
  malformed snapshot -> 400; PATCH to differ, PATCH back to equal; PATCH of
  one Deposit key (the whole Deposit item is classified); a raw boolean
  `pets` write classifies the Pets item; a PATCH of `pet_fee` alone on a
  legacy boolean property keeps No pets and the details as they read;
  landlord change by PATCH, restore-with-landlord and roster claim REMOVEs
  the map; no landlord; the PATCH map write retries on a changed map and
  answers 409 `property_changed` after 3 attempts, and cannot write a map
  back over a landlord-change REMOVE. Assert `requirement_sources` on the
  HTTP response, not only the repo return value.
- Apply route: 404/400/409 cases (incl. `deposit_conflict`); skip reasons
  (`not_found`, `deleted`, `landlord_changed`, `already_matches`,
  `changed_since_opened` for an own value set after the dialog loaded,
  `changed_during_apply`); keys SET and REMOVEd (a blank item clears); the
  pets pair normalized; the sources map (a listed item that already equaled
  the landlord keeps its `set_here` record); an all-blank landlord whose
  "Clears" item meets existing values (own values, skipped only when not in
  `ownItems`); audit per written unit with the changed keys and never
  `requirement_sources`; the 100 cap.
- Flyer projection: the D10a parity walk over more than one base unit (a
  base whose recorded sizes equal its beds would hide the voucher-size
  field); `voucher_sizes`; `voucher_size` kept; subzone gone; staff-only keys
  absent; the deposit row cases (flexible alone, notes alone gives no
  row).
- Activity projection: `reason` lifted for `unit_updated` /
  `requirements_applied` only; `listing_status_changed` reason still not
  served.
- Audience: the normalizer (old number, list, clamp, both keys), any-of
  matching with 4 = 4 or more, projection of old records (`bedroomSizes` and
  `bedroomSize`).

Dashboard (vitest + testing-library): the shared Requirements component
(tags from the table, disabling, "Clears"), picker B (expand rules,
aria-pressed, summary, empty sends null, off-chip stored values), the D6 tag
table (incl. an own value against a blank landlord item: purple with
"Landlord: blank"; one tag and one landlord line per multi-field item)
and the no-requirements note, the Apply dialog (re-read on open, defaults,
own-value marks from the D6 definition also for an all-blank landlord, live
recompute, a hand-checked row resetting only when it gains an own value,
`ownItems` sent, batching and a mid-run 409 or failure, the 409 re-read),
the tags kept out of every field's accessible name, the `property_changed`
message keeping the form open, the
create-form prefill, snapshot, refill on landlord change and the load /
failure states, the One-month-rent save sending the amount as null,
composer multi-select pre-fill and the 4+ mapping, flyer wording cases, the
D10a mirror parity.

E2E (Playwright, new spec): a landlord with requirements; "+ Add a
property" pre-fills them; clear one item before saving -> the property shows
"Set on this property"; change the landlord's pets -> another property
shows "Landlord updated"; Apply dialog starts the exception row unchecked
(own value marked) and the out-of-date row checked; Update; the property
pages show the new values and the Activity line; the flyer shows the public
items and none of the staff ones; a Matching blast from a two-size property
pre-fills two chips, and a 6-bedroom tenant matches 4+. A landlord with "No
pets" and blank details applied onto a property whose details say "Cats OK"
marks that row's Pets as an own value and starts it unchecked; checked and
updated, the flyer reads "No pets", never "No pets (Cats OK)".

## 7. Places the build must also update

App:

- `app/src/lib/unitFields.ts` (`WRITABLE_FIELDS`, kinds, `UnitFlyer`,
  `toUnitFlyer`, the never-public comment) and the new registry module;
  `app/src/repos/unitsRepo.ts` (`UnitItem`; the stale `lease_terms` comment
  at `:443-446`; the map written with the item keys under a condition on
  the map and `landlordId` it read; the new conditional
  `applyRequirements`; `restoreWithLandlord` and the `addContact` landlord
  claim REMOVE the map when the landlord changes);
  `app/src/routes/units.ts` (create snapshot and PATCH classification,
  reads, retry; landlord change; audit field names;
  `toUnitActivityEvent` `:311-376`);
  `app/src/routes/contacts.ts` (PATCH `req_` keys; the apply route);
  `app/src/repos/contactsRepo.ts` (type).
- The in-memory units repo in `app/test/helpers/twilioWebhookHarness.ts:2857-2925`
  mirrors the map write, the landlord-change REMOVE and the Apply condition.
- Matching: `broadcastsRepo.ts` (type), `broadcasts.ts`
  (`parseAudienceFilter`, preview, send, projections, router header
  comment), `blastAudienceRules.ts` (normalizer, `wireAudienceFilter`),
  `audienceResolution.ts` (match rule, log field).
- Seeds: full profile - give one demo landlord requirements and its
  properties one copied, one set-here and one landlord-updated item; the
  `[2, 3]` unit stays; keep ONE matrix broadcast on the legacy `bedroomSize`
  and move the other to `bedroomSizes`. Lean stays byte-stable (its units'
  existing `pets` and `deposit` become set-on-this-property values, which
  is the D6 rule, not a seed change).

Dashboard:

- `api/types.ts` (`UnitItem` incl. `requirement_sources`, `Contact`,
  `ContactPatch`, `AudienceFilter`, the stale `lease_terms` comment `:2527`,
  the "Internal (not on the public flyer)" comment on
  `voucher_size_accepted` `:2545-2548`), `api/endpoints.ts` (apply call).
- `routes/listing/`: `ListingDetail.tsx`, `useListing.ts` (re-read the
  landlord on a `landlordId` change), `ListingEditForm.tsx`,
  `UnitCreateForm.tsx`, `listingFormat.ts` (mirror, sizes formatting,
  Activity label), the shared Requirements component and picker.
- `routes/contact/`: `LandlordFile.tsx`, the new Requirements card and Apply
  dialog, `ContactEditForm.tsx`, `ContactDetail.tsx` (wiring),
  `useContactFile.ts` (refetch after Apply).
- `routes/public/FlyerPage.tsx`, `publicApi.ts`.
- `routes/broadcasts/`: `AudienceFilters.tsx`, `BroadcastComposer.tsx`,
  `broadcastFormat.ts`, `useComposerDraft.ts`, `BroadcastsList.tsx`,
  `BroadcastResults.tsx`.

E2E specs and steps that assert the old shapes: `e2e/scenarios/steps.ts`
(`:1640-1760`, the number input and number assertions),
`tests/scenarios/landlord-onboarding.spec.ts`,
`tests/dashboard-next/broadcasts.spec.ts:305-320` (chip and pre-fill copy),
`public-pages.spec.ts:239-268,367-426` (flyer text, $0 fee),
`properties-available-view.spec.ts:58-70` (still valid: a number is
accepted), `contact-detail.spec.ts:134-155` (landlord edit form, Notes copy),
`matching-blast-rules.spec.ts:269`. Two existing selectors
`getByLabel('Notes')` would also match the new "Deposit notes" field
(Playwright matches substrings): `e2e/scenarios/steps.ts:1515` (the landlord
edit dialog, driven by `landlord-onboarding.spec.ts`) and
`tests/dashboard-next/listing-activity.spec.ts:293` (the property edit
dialog); both become `{ exact: true }`. API setup that creates properties
without a snapshot (for example `tours-page.spec.ts:317`) is unaffected
(D5).

Docs:

- `documentation/GLOSSARY.md`: add "requirements (landlord and property)",
  "Set on this property" / "Landlord updated", "copy only"; update "voucher
  size of a property" (a list, 0..12, picker B); rewrite "Landlord
  preferences + expected rent live on the UNIT" (`:176-187`): pets and the
  other requirements now ALSO live on the landlord as copy-only defaults,
  and `lease_terms` is public (the entry wrongly says internal-only); note
  subzone is staff only.
- `documentation/landlord-onboarding-sequence.mermaid:82`: qualifications
  are staff only, not in the shareable listing.
- Close `docs/issues/unit-voucher-size-readers-diverge.md` and
  `docs/issues/broadcast-4plus-exact-match-underreach.md`; close the
  voucher, washer/dryer and qualifications parts of
  `docs/issues/unit-onboarding-fields.md` (king-bed fit and square footage
  stay open there).
