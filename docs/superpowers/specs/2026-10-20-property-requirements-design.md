# Landlord requirements and property fields - design

Status: DRAFT revision 1 (2026-10-20), for design review.
Branch: `feat/property-requirements` (worktree `W:\tmp\property-requirements`, cut from main @1d7a4667)
Tracker: Improvements Tracker items #12 "Property page fields" and #11
"Landlord requirements and qualifications" (Before WP1, item 6), built
together.
Review records: `docs/superpowers/reviews/2026-10-20-property-requirements/`

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
   because the landlord changed after they were copied - so Apply never
   overwrites an exception by accident.
4. A property can accept SEVERAL voucher sizes (Studio through 12), and every
   place that reads a property's voucher size handles the list: the flyer,
   Matching's pre-fill and blast audience, the Properties page, and the
   property page and forms.
5. New property fields: subzone on the forms (staff only), washer/dryer, a
   deposit that can be "one month's rent" and "flexible", and "No
   application fee".
6. Every field on the property and landlord forms says whether tenants see it
   on the public flyer, so staff do not put something damaging in a public
   box by accident.

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
  '' is stored as '', `:168-170`); `voucher_size_accepted` is
  `'clearable_number'`, ONE number >= 0 (not limited to integers), null
  REMOVEs it, an array is a 400 (`:175-185`).
- `acceptedVoucherSizes(unit)` (`unitFields.ts:336-341`, hand-mirrored in
  `dashboard/src/routes/listing/listingFormat.ts:103-109`) already reads a
  number OR a list and falls back to `beds`. The full demo seed already
  stores a list, `voucher_size_accepted: [2, 3]` (`app/src/lib/seed/cast.ts:1358`),
  which the write API rejects today.
- Create: `POST /api/units` (`app/src/routes/units.ts:770-835`) validates,
  checks the landlord is a landlord contact (`:802-810`), creates with status
  `setup`, audits `unit_created` with no field list. Update: `PATCH
  /api/units/:unitId` (`units.ts:2115-2258`) audits `unit_updated` with the
  changed field NAMES only (`:2249-2252`). There is no version check on a
  unit PATCH (`unitsRepo.ts:1139`, `attribute_exists(unitId)` only), and no
  bulk unit route anywhere.
- `unitsRepo.update` SETs non-null, REMOVEs null and always stamps
  `updated_at` (`app/src/repos/unitsRepo.ts:1101-1147`). A stamped
  `updated_at` is the importer's "human-owned" signal: the import then writes
  facts only `if_not_exists` (`app/src/lib/import/apply.ts:1456-1475`).
- The import writes address, beds, baths, accepted authorities, notes and the
  landlord link; it never writes deposit, pets, application fee, tour fields,
  subzone, area or voucher size (`apply.ts:1476-1621`). No seed, dev route or
  form writes `subzone` or `area` (`app/src/routes/dev.ts`,
  `app/src/lib/seed/*`); only the API can.
- The public flyer projection `toUnitFlyer` (`unitFields.ts:343-371`) is an
  allowlist. Public today: beds, baths, area, SUBZONE, `voucher_size` (the
  FIRST of `acceptedVoucherSizes`, `:356`), accepted authorities, listing
  link, rent, address, utilities, video, application fee, same-day RTA, pets,
  accessibility, deposit, lease terms. Never public: notes, tour type, tour
  process, application process, payment standard, `voucher_size_accepted`
  (the key). Served at `GET /public/units/:unitId/flyer`
  (`app/src/routes/public.ts:451-464`).
- `FlyerPage.tsx` (`dashboard/src/routes/public/FlyerPage.tsx`) shows
  "subzone, area" as the neighborhood line (`:54-56`), "Fits a
  <strong>N-bedroom</strong> voucher" from the single `voucher_size`
  (`:265-268`), and Deposit / Application fee as "$N" - a $0 fee renders
  "$0" (`:298-331`); pets via `petsLabel` (true "Allowed", false "Not
  allowed", `:110-115`).

Property page and forms (dashboard):

- `ListingDetail.tsx` "Property details" card (`:948-989`) shows Deposit,
  Pets (`unit.pets ?? '-'`: a boolean renders blank, `:966`), Lease terms,
  Application fee, and "Voucher size accepted" only when the stored value is
  a NUMBER (`:973-975`, so a list shows nothing). No Area or Subzone row. A
  "Tour & application process" card (`:1012-1034`) shows tour type, tour
  process and application process. The page already loads the landlord
  contact, best effort (`useListing.ts:129-140`, `state.landlord`).
- `ListingEditForm.tsx` (edit) and `UnitCreateForm.tsx` (new) have no Area
  or Subzone input; Voucher size accepted is one number input
  (`ListingEditForm.tsx:105,532-538`, `UnitCreateForm.tsx:556-562`); a blank
  number input means "untouched" except for the clearable voucher size
  (`ListingEditForm.tsx:127-151,195-206`). The edit form's one hint line says
  "Address, rent, deposit, fees, utilities, pets, accessibility, and lease
  terms are shown on the public flyer." (`ListingEditForm.tsx:279-282`).
- `UnitCreateForm` has two entry points: the landlord page's "+ Add a
  property" with the landlord LOCKED (`ContactDetail.tsx:1412-1420`), and
  the Properties list's "+ New property" with a landlord PICKER
  (`ListingsList.tsx:464-472`). It loads every landlord contact
  (`UnitCreateForm.tsx:136-169`) but keeps only the label.

Landlord record:

- A landlord is a contact (`type: 'landlord'`). Its structured fields today
  are `contract_status`, `registered_landlord`, `rta_within_48h`,
  `pass_inspection_first_try`, `income_includes_voucher`
  (`app/src/routes/contacts.ts:388-400`), shown in the "Landlord onboarding"
  card (`dashboard/src/routes/contact/LandlordOnboardingCard.tsx`) and edited
  in the landlord section of `ContactEditForm.tsx` (`:871-973`). Pets and
  lease terms moved from landlords to properties in July
  (`contacts.ts:402-406`).
- The contacts table already uses top-level `pets` and `evictions` for
  TENANTS (`contactsRepo.ts:327-331`); they are not type-gated, and they are
  AI-provenance fields: a PATCH of `pets` clears `pets_source` and consumes
  pending AI suggestions (`contacts.ts:1760-1792`). Contacts PATCH ignores
  unknown top-level keys (`contacts.ts:402-406`); units return 400.
- A contact has no `updated_at` (`contactsRepo.ts`; only
  `staff_notes_updated_at`).
- The landlord page (`LandlordFile.tsx`) cards, in order: Details, Landlord
  onboarding, Notes (whose empty-state copy says "(Programs, lease terms, and
  pet policy live on each property.)", asserted by
  `e2e/tests/dashboard-next/contact-detail.spec.ts:134-155`), Properties,
  Tours, Placements, group texts, group threads, media. It loads all units
  and keeps those whose `landlordId` is this contact
  (`useContactFile.ts:158`, `buildContactFile.ts:18-20`).

Matching (blasts):

- The audience filter holds ONE voucher size, `bedroomSize?: number`
  (`app/src/repos/broadcastsRepo.ts:95`; validated as an integer 0..12 at
  `app/src/routes/broadcasts.ts:210-217`). The resolver matches it EXACTLY
  (`app/src/services/audienceResolution.ts:186-189`). The "4+ BR" chip sends
  4 (`dashboard/src/routes/broadcasts/broadcastFormat.ts:33-39`), so tenants
  holding a 5- to 12-bedroom voucher never match it.
- The composer pre-fills the FIRST of the property's sizes
  (`BroadcastComposer.tsx:205`), not capped at 4 (`:213`): a 5-bedroom
  property pre-fills 5, which no chip shows as pressed
  (`AudienceFilters.tsx:150-152,175`).
- The stored filter is re-read at preview and send
  (`broadcasts.ts:1042,1285`) and projected by `wireAudienceFilter`, which
  copies `bedroomSize` only when it is a number
  (`app/src/lib/blastAudienceRules.ts:222-234`). Stored drafts and sent
  blasts with a number exist in the full seed (`matrix.ts:1227-1233,
  1264-1270`) and in production.

Tenant voucher size: an integer 0..12 everywhere it is written
(`contacts.ts:581-588,851-857`; `public.ts:146-152`; extraction
`apply.ts:104-108`). The Properties and Tenants page chips bucket 4 and up
as "4+" (`tenantFacets.ts:45-51,128-137`; `unitListFacets.ts:175-196`,
already list-ready).

## 3. Decisions

### D1 The requirement items

There are twelve requirement ITEMS. An item is the unit of copying,
comparing and tagging. Every item exists on both the landlord and the
property. Order and grouping are the display order everywhere.

| Group | Item (label) | Key(s) | Kind | Flyer |
|---|---|---|---|---|
| Screening | No evictions while on the program | `no_evictions_on_program` | checkbox | Staff only |
| Screening | Evictions (details) | `evictions_notes` | text | Staff only |
| Screening | Credit score | `credit_requirements` | text | Staff only |
| Screening | Income requirements | `income_requirements` | text | Staff only |
| Screening | Qualifications | `qualifications` | long text | Staff only |
| Pets | No pets | `no_pets` | checkbox | On flyer |
| Pets | Pets (details) | `pets` (existing key) | text | On flyer |
| Pets | Pet fee | `pet_fee` | text | On flyer |
| Move-in costs | Deposit | `deposit_one_month` (checkbox "One month's rent"), `deposit_flexible` (checkbox "Flexible / payment terms available"), `deposit` (existing, fixed amount in dollars), `deposit_notes` (text) | group | On flyer, except the notes (Staff only) |
| Move-in costs | Application fee | `application_fee` (existing, dollars; 0 = "No application fee") | money | On flyer |
| Touring | Tour type | `tour_type` (existing enum) | select | Staff only |
| Touring | Tour process | `tour_process` (existing) | text | Staff only |

The checkbox label stays exactly "No evictions while on the program".
Credit and income stay notes only: nothing matches on them (fair-housing
question still open, tracker #11). A tenant's eviction history stays the
tenant's existing free-text field; the Work Package 1 AI ranking weighs it
against this checkbox and the details.

ONE registry module defines the items, their keys, kinds, labels, groups and
flyer visibility, shared by validation, copying, comparing and the UI (an
app module plus its hand mirror in the dashboard, the `acceptedVoucherSizes`
pattern, with the same test cases in both suites).

Values, per kind:

- checkbox: `true` or absent. Writing `false` or null REMOVEs the key, so an
  unchecked box has one representation.
- text: a string, trimmed; '' or null REMOVEs the key.
- money (`deposit`, `application_fee`): a finite number >= 0, or null to
  REMOVE. Both become clearable (today they are not).
- `tour_type`: unchanged (`self_guided` / `landlord_led` / `pm_team`, ''/null
  REMOVEs).
- `pets` keeps accepting a bare boolean on WRITE, for a stale cached
  dashboard bundle, but the new forms always write text plus `no_pets`. On
  READ a legacy boolean is interpreted: `false` = No pets checked, details
  blank; `true` = No pets unchecked, details "Allowed". Nothing is
  backfilled; the next save from the form writes the new shape.

Item equality (used by copying, tags and Apply): two values of an item are
EQUAL when every key of the item is equal after the read interpretation
above, where absent, '' and `false` are all "blank", text compares after
trimming (case-sensitive), and numbers compare exactly. The Deposit item is
equal only when all four of its keys are equal.

### D2 Where the requirements are stored

- On the PROPERTY: flat keys on the unit, the names in D1, added to
  `WRITABLE_FIELDS` with the kinds above. Existing keys keep their names, so
  existing values, the flyer projection and every existing reader
  (`TourDetail` guidance card, `ScheduleTourForm` prefill,
  `listingSendOutcome`, `contact/Card.tsx`) keep working.
- On the LANDLORD: ONE map attribute `requirements` on the contact, holding
  the same keys with the same kinds. A map, not top-level keys, because
  `pets` and `evictions` already mean the TENANT's answers on the contacts
  table and carry AI provenance (section 2). Contacts PATCH accepts
  `requirements` only for a contact whose (resulting) type is `landlord`;
  for any other type it is a 400. The body's `requirements` REPLACES the
  stored map as a whole (the form always sends the whole section); each key
  is validated by the registry; an unknown key inside it is a 400. The audit
  `contact_updated` lists `requirements` in its fields. Contact CREATE does
  not take `requirements` (the new-landlord form has Company only today).

### D3 Property-only fields: subzone, washer/dryer

- `subzone`: free text (Sam's codes, for example E8 or SE11), now on the New
  and Edit forms and a row on the property page. STAFF ONLY: it leaves the
  public flyer projection and the flyer's neighborhood line (which becomes
  `area` alone). Nothing holds a subzone today (section 2), so no tenant has
  ever seen one. It keeps feeding the similar-properties score
  (`app/src/lib/similarUnits.ts:52-65`). Where the codes come from is an
  open question for Sam (it does not change the build).
- `area` is NOT added to any form (Cameron, 2026-10-20: not requested, and a
  free-text area per property would have to be renamed property by
  property). It keeps its current readers.
- `washer_dryer`: one of `hookups` ("Hookups"), `included` ("Washer and dryer
  included"), `none` ("No hookups"), or absent ("Not recorded"; '' or null
  REMOVEs). On the flyer. Existing washer/dryer text in Notes stays there.

### D4 Voucher sizes accepted: a list

- `voucher_size_accepted` becomes a list. The write kind accepts: null or
  `[]` (REMOVE - the property falls back to its bedrooms, as today); an
  integer 0..12 (a stale bundle; stored as a one-item list); or an array of
  integers 0..12 (stored de-duplicated, ascending). Anything else is a 400
  (this also stops non-integer sizes, which the tenant side never allowed).
  Stored single numbers are not backfilled; `acceptedVoucherSizes` already
  reads both shapes and stays the ONE reader (GLOSSARY).
- The New and Edit forms use picker B: chips Studio, 1, 2, 3, 4, and a "More
  sizes (5-12)" control that shows chips 5 through 12. The larger chips show
  automatically when the property already records a size of 5 or more; a
  "Fewer sizes" control hides them again only when none of them is
  selected. A line under the chips reads "Accepts: 2 BR, 3 BR" ("none
  recorded" when empty). Emptying the picker sends null (as clearing does
  today). The picker is a group of toggle buttons with `aria-pressed`, under
  the label "Voucher sizes accepted".
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
the current value came from, in two string-set attributes on the unit:

- `requirements_copied`: items whose value was copied from, or matches, the
  landlord.
- `requirements_set_here`: items whose value was set on the property and
  differs from the landlord.

An item in neither set is NEVER TOUCHED (every item on every property that
exists today). The server classifies on EVERY write that touches an item,
by comparing the property's resulting value with the landlord's CURRENT
value (D1 equality):

- POST create, and PATCH (any key of the item in the body): equal -> the
  item goes to `requirements_copied` (and out of `requirements_set_here`);
  different -> into `requirements_set_here` (and out of
  `requirements_copied`). So a field staff change on the New form before
  saving, or edit later, counts as set on this property; editing it back to
  the landlord's value makes it a copy again.
- Apply (D8): every applied item goes to `requirements_copied`.
- A PATCH that CHANGES the property's landlord (`landlordId`) empties both
  sets: every item becomes never touched against the new landlord.
- The landlord's own edits never touch any property.

Classification needs the landlord's current requirements. Create already
reads the landlord contact (`units.ts:802-810`); PATCH reads it when the
body touches an item. A property with no landlord classifies every touched
item as set here.

Client-supplied source sets are not accepted: both attributes are written
only by the server (they are not in `WRITABLE_FIELDS`).

### D6 How a property shows each requirement (layout A)

For each item, comparing the property's value with the landlord's current
value:

| Property vs landlord | Item record | Shows |
|---|---|---|
| equal | any | the value, no tag |
| different | `requirements_copied` | the value + orange tag **Landlord updated** + a small line "Landlord now: <value>" |
| different | `requirements_set_here` | the value + purple tag **Set on this property** + "Landlord: <value>" |
| different, property value not blank | never touched | as `requirements_set_here` (an existing value counts as set on this property - Cameron, 2026-10-20) |
| property blank, landlord not blank | never touched | blank + "Landlord: <value>", no tag |

A blank landlord value prints as "blank". When the property has no landlord,
or the landlord contact fails to load, no tags or landlord lines show. The
two tags differ in lightness as well as hue (accessibility), and each
carries its text, not color alone.

### D7 A new property starts filled in from its landlord

`UnitCreateForm`'s Requirements section starts filled in with the
landlord's requirements as soon as the landlord is known (locked from the
landlord page, or picked), with a note "Filled in from <landlord name>'s
requirements. Change anything that is different for this property." Picking
a DIFFERENT landlord refills the section from the new landlord, replacing
anything typed there. Staff can change any field before saving. The create
body carries the values; the server classifies (D5), so an unchanged field
is a copy and a changed one is set on this property. When the landlord has
no requirements, the section starts blank.

The form keeps the landlord Contact it already loads
(`UnitCreateForm.tsx:136-169`) instead of only its label.

### D8 Apply to properties (dialog B)

The landlord's Requirements card has an **Apply to properties** button
(disabled, with a reason, when the landlord has no properties). It opens one
dialog, two columns:

Left, "What to copy": every item, with the landlord's value. Items with a
value start CHECKED; blank items start UNCHECKED and are marked "Clears";
checking a blank item copies the blank, clearing that item on the chosen
properties (Cameron, 2026-10-20).

Right, "Which properties": the landlord's properties (landlord of record,
not deleted, any status), each with its address and status. Each row lists,
live, the checked items that would CHANGE on it. A row:

- with no changes reads "Already matches" and cannot be checked;
- starts UNCHECKED, marked "Has its own value", when any changing item is
  set on this property on that row (the D6 purple cases, including existing
  values never touched);
- otherwise starts CHECKED.

A "Select all" box heads the column (it checks every row that has a
change). The button reads "Update N properties" (N = checked rows; disabled
at 0). Changing the left column recomputes every row's changes, starts and
"Already matches" states; it does not re-check a row staff unchecked by
hand unless that row's state changes.

Server: `POST /api/contacts/:contactId/requirements/apply` with
`{ unitIds: string[], items: string[], expected: { <item>: <landlord value
the dialog showed> } }`.

- 404 when the contact does not exist; 400 when it is not a landlord, when
  `items` is empty or names an unknown item, or when `unitIds` is empty or
  over 200.
- 409 `requirements_changed` when the landlord's current value of any listed
  item is not EQUAL (D1) to `expected`; the dialog says "This landlord's
  requirements changed since you opened this. Close and try again." and
  applies nothing.
- For each unit id, in order, one conditional write: the unit exists, is not
  deleted, and its `landlordId` is still this contact; it SETs or REMOVEs the
  item's keys to the landlord's values, adds the items to
  `requirements_copied` and removes them from `requirements_set_here`, and
  stamps `updated_at` (through the repo, like any staff edit). A unit that
  fails the condition is skipped with a reason (`not_found`, `deleted`,
  `landlord_changed`); the rest still apply. Per updated unit, one audit
  `unit_updated` with the changed field names plus `reason:
  'requirements_applied'` and the `landlordId`.
- Response: `{ updated: string[], skipped: [{ unitId, reason }] }`. The
  dialog closes on success and the landlord page shows "Updated N
  properties" (plus "M skipped: <addresses and reasons>" when any were
  skipped).

The writes are not one transaction (no unit write is today); a failure part
way leaves earlier units applied, and the response says which. A property
edited between opening the dialog and pressing Update is overwritten for the
checked items: pressing Update on that row is the staff decision.

### D9 Landlord page and landlord edit form

- A new card **Requirements / Qualifications** sits right after "Landlord
  onboarding" on the landlord page: the twelve items in their groups, blank
  ones as "-", with **Apply to properties** and **Edit** actions. Edit opens
  the existing landlord edit form.
- `ContactEditForm` gets a "Requirements / Qualifications" fieldset for
  landlords, after the Landlord onboarding fieldset, using the same shared
  Requirements fields component as the property forms. Its tags read **On
  property flyers** / **Staff only**, because these values reach flyers only
  through properties.
- The existing "Voucher counts as income" checkbox stays in Landlord
  onboarding, unchanged.
- The Notes empty state changes to "No notes yet - use + Add." (programs and
  lease terms still live on each property, but pets now also live here); the
  e2e assertion moves with it.

### D10 Property page and property forms

Property page (`ListingDetail`):

- "Property details" keeps beds/baths, rent, payment standard, housing
  authorities, utilities, accessibility, lease terms, same-day RTA, video,
  and gains **Subzone**, **Washer / dryer** and **Voucher sizes accepted**
  (D4). Deposit, Pets and Application fee move out to Requirements.
- A new **Requirements** card (D6, layout A) shows the twelve items in their
  groups. Its Edit opens the existing property edit form.
- "Tour & application process" keeps Application process; tour type and tour
  process move to Requirements.

New and Edit property forms:

- Order: Property details (housing authorities, beds, baths, voucher sizes,
  rent min / max, payment standard, address, subzone, washer/dryer,
  utilities, accessibility, lease terms, listing link, video URL, same-day
  RTA), then Requirements (the shared component), then Application process
  and Notes.
- EVERY field carries a tag beside its label: **On flyer** (tenants see it on
  the public flyer) or **Staff only** (never leaves the dashboard). A legend
  under the form title explains both, replacing today's single hint line.
  Public free-text boxes (pets details, pet fee, utilities, accessibility,
  lease terms) also show "Tenants see this on the public flyer." under the
  box. The tag for each field comes from the same allowlist as the flyer
  projection, so the form cannot claim "Staff only" for a field the flyer
  publishes. (This applies to the property's own fields and to the twelve
  items.)
- "No application fee" is a checkbox above the amount; checked, it records
  0 and disables the amount; unchecked, the amount is editable and blank
  means no fee recorded. "One month's rent" disables the fixed deposit
  amount the same way (they are alternatives; the stored fixed amount is
  kept, not cleared, so unchecking restores it).
- Booleans become recordable as "No": every checkbox writes `true` or
  REMOVE (D1), so there is no "unanswered" versus "No" ambiguity on these.

### D11 Public flyer

- Voucher size: "Fits a 2- or 3-bedroom voucher"; one size "Fits a
  2-bedroom voucher"; studio "Fits a studio voucher"; mixed "Fits a studio or
  1-bedroom voucher"; three or more "Fits a 1-, 2-, or 3-bedroom voucher".
  The projection adds `voucher_sizes: number[]` (all of
  `acceptedVoucherSizes`, ascending) and keeps `voucher_size` (the first) for
  a cached older flyer bundle.
- Pets: "No pets" when checked, followed by the details in parentheses when
  there are any ("No pets (service animals only)"); otherwise the details;
  a legacy boolean reads as in D1. The pet fee is its own row.
- Deposit: "One month's rent" when checked, else the fixed amount "$N";
  then ", flexible / payment plan available" when flexible is checked.
  Deposit notes never appear.
- Application fee: "No application fee" for 0, "$N" otherwise, no row when
  absent.
- Washer / dryer: a row with its label, only when recorded.
- Subzone: removed (D3); the neighborhood line is `area` only.
- Staff-only items (screening, deposit notes, tour type, tour process) are
  never in the projection. The projection stays an allowlist.

### D12 Matching: several voucher sizes

- The audience filter's voucher size becomes a list, `bedroomSizes:
  number[]`, of CHIP values 0..4 where 4 means "4 or more" (the chip already
  reads "4+ BR"). A tenant matches when its voucher size equals a chosen
  value below 4, or is 4 or more when 4 is chosen. This fixes the 4+ chip.
- Old shape: a stored or posted `bedroomSize: n` reads as `bedroomSizes:
  [min(n, 4)]`, through ONE normalizer used by validation, preview, send and
  the projections (the `authoritiesOfFilter` pattern,
  `blastAudienceRules.ts:182-204`). New drafts store `bedroomSizes`; stored
  records are not rewritten. POST accepts either key (a stale bundle);
  `bedroomSizes` wins when both are sent. Values must be integers 0..12 (as
  today) and are clamped to 4, de-duplicated, ascending; an empty list is no
  size filter.
- The projection (`wireAudienceFilter`) returns `bedroomSizes` for every
  record, old or new, so the list, results and summary show the sizes.
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
  "Property updated: Pets, Pet fee").
- An Apply writes `unit_updated` with `reason: 'requirements_applied'`; the
  Activity feed shows "Requirements applied from the landlord" with the
  field names.
- A landlord edit writes `contact_updated` with `requirements` in its
  fields.

## 4. Consequences to know

- Copying TOUR TYPE onto properties changes behavior: a property's tour type
  decides how a share's "interested" reply routes (`units.ts:1466-1470`,
  `listingSendOutcome.ts:111-112`) and pre-fills Schedule tour
  (`ScheduleTourForm.tsx:247-253`). Applying a landlord's tour type to a
  property with none makes those paths work for it; applying a blank tour
  type removes it (409 `tour_type_required` comes back for that property).
- Apply stamps `updated_at` on each property, which makes an import-owned
  property human-owned for the importer, exactly as any staff edit does.
- Existing deposit, pets, application fee, tour type and tour process values
  count as set on this property, so the first Apply on a landlord starts
  most rows UNCHECKED where those differ; Select all is the shortcut.
- The flyer stops showing subzone; no flyer has shown one, since nothing
  ever recorded it.
- The 4+ fix widens existing filters: a stored blast with `bedroomSize: 4`
  now also reaches 5- to 12-bedroom holders if previewed or sent again.

## 5. Out of scope

- The Work Package 1 AI ranking, and any AI prompt change (#32 is its own
  item). Blasts do not filter on No pets or No evictions.
- Matching on credit or income.
- The #13 flyer changes (heading, rent, same-day tour) and the #26 printable
  flyer.
- Area on the forms; a subzone-to-area name list.
- Requirements on the NEW-landlord form; requirements for property managers
  or owners on a property's roster (only the landlord of record).
- Any backfill or migration; the importer.
- The tenant's eviction history (stays free text).

## 6. Testing

App (vitest):

- Registry and validation: each kind (checkbox REMOVE on false/null; text
  trim and REMOVE on ''; money clearable; legacy `pets` boolean accepted on
  write and interpreted on read); `voucher_size_accepted` accepts null, [],
  an integer, an integer list (de-duplicated, sorted) and rejects 13, -1,
  2.5, strings, mixed lists; item equality including the Deposit group.
- Contacts PATCH `requirements`: landlord only (400 for other types),
  whole-map replace, unknown key 400, and a landlord `pets` key inside the
  map does NOT touch a tenant-style `pets_source` or AI suggestions.
- Classification on create, PATCH and landlord change (D5), against a
  landlord with and without requirements and with no landlord.
- Apply route: 404/400/409 cases; per-unit skip reasons
  (deleted, landlord changed); keys SET and REMOVEd (a blank item clears);
  source sets updated; audit per unit; unitIds cap.
- Flyer projection: `voucher_sizes`, `voucher_size` kept, subzone gone,
  new public keys present, staff-only keys absent.
- Audience: the normalizer (old number, list, clamp, both keys), any-of
  matching with 4 = 4 or more, projection of old records.

Dashboard (vitest + testing-library): the shared Requirements component
(tags, disabling, "Clears"), picker B (expand rules, aria-pressed, summary,
empty sends null), D6 tag computation table, the Apply dialog defaults and
live recompute, the create-form prefill and refill-on-landlord-change,
composer multi-select pre-fill and the 4+ mapping, flyer wording cases.

E2E (Playwright, new spec): a landlord with requirements; "+ Add a
property" pre-fills them; edit one field on the property -> "Set on this
property"; change the landlord's pets -> another property shows "Landlord
updated"; Apply dialog starts the exception row unchecked and the
out-of-date row checked; Update; the property pages show the new values and
the Activity line; the flyer shows the public items and none of the staff
ones; a Matching blast from a two-size property pre-fills two chips, and a
6-bedroom tenant matches 4+.

## 7. Places the build must also update

App:

- `app/src/lib/unitFields.ts` (`WRITABLE_FIELDS`, kinds, `UnitFlyer`,
  `toUnitFlyer`, the never-public comment) and the new registry module;
  `app/src/repos/unitsRepo.ts` (`UnitItem`, the stale `lease_terms` comment at
  `:443-446`, string-set ADD/DELETE support in `update`);
  `app/src/routes/units.ts` (create and PATCH classification; landlord
  change); `app/src/routes/contacts.ts` (PATCH `requirements`; the apply
  route); `app/src/repos/contactsRepo.ts` (type).
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

- `api/types.ts` (`UnitItem`, `Contact`, `ContactPatch`, `AudienceFilter`,
  the stale `lease_terms` comment `:2527`), `api/endpoints.ts` (apply call).
- `routes/listing/`: `ListingDetail.tsx`, `ListingEditForm.tsx`,
  `UnitCreateForm.tsx`, `listingFormat.ts` (mirror, sizes formatting,
  Activity label), the shared Requirements component and picker.
- `routes/contact/`: `LandlordFile.tsx`, the new Requirements card and Apply
  dialog, `ContactEditForm.tsx`, `ContactDetail.tsx` (wiring).
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
`matching-blast-rules.spec.ts:269`.

Docs: `documentation/GLOSSARY.md` - add "requirements (landlord and
property)", "Set on this property" / "Landlord updated", "copy only"; update
"voucher size of a property" (a list, 0..12, picker B); note subzone is
staff only. Close `docs/issues/unit-voucher-size-readers-diverge.md` and the
voucher/W-D/qualifications parts of `docs/issues/unit-onboarding-fields.md`
(king-bed fit and square footage stay open there).
