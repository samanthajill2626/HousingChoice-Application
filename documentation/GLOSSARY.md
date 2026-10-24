# Glossary & Naming Conventions

The shared vocabulary for HousingChoice. When code, UI copy, docs, or (later) AI
prompts name a domain concept, they use the words defined here. The point is that
every party — tenants, landlords, staff, and the engineers/agents building the
system — hears a consistent, accurate term for the same thing.

**Contributors & agents:** if you introduce a new domain noun, add it here in the
same change. If you find drift (a synonym creeping in for an entity that already
has a blessed word), fix it toward this table.

**See also:** [STATUS-MODEL.md](STATUS-MODEL.md) — the living reference for how the
three core entities (tenant, **placement**, property/`unit`) move through the process:
their phases, stages, and how they derive from one another.

---

## The unit / home / property entity

There is **one** entity for "a single dwelling a single household (a family,
couple, or individual) can lease and move into." In code and data it is always
called a **`unit`**. What a *human* is shown depends on who they are:

| Audience | Word they see | Singular / plural | Example copy |
|---|---|---|---|
| **Tenant** (voucher holder) | **home** | home / homes | "3 homes match your voucher" |
| **Landlord** | **property** | property / properties | "Your property is now live" |
| **Staff / navigator** (dashboard) | **property** | property / properties | "Properties", "New property" |
| **Code / data / internal** | **unit** | unit / units | `unitId`, `unitsRepo`, `UnitItem` |

One entity, three labels by audience. Pick the label by **who is reading**, not by
which surface the code lives in.

### Why `unit` is the internal term (and not "apartment-specific")

"Unit" can sound apartment-y in everyday speech, but in the Housing Choice Voucher
(Section 8) program it is the **regulatorily correct, structure-agnostic** word: a
single-family home, townhome, duplex half, or apartment is all a *dwelling unit* on
the Request for Tenancy Approval and the Housing Quality Standards inspection. So a
unit is **not** "an apartment" — it is "the one dwelling a household leases,"
whatever its structure. That is why the code keeps `unit` and the tenant-facing
copy softens it to **home**.

### Why "property" (the blessed landlord/staff word)

Landlords and staff see **property** because it is the most natural, everyday word
for "the place" — a landlord thinks of their **property**, and a navigator scanning
the dashboard reads **Properties**. It carries no Zillow-style "advertisement"
connotation (that sense is reserved for the *external* listing — see below), and it
reads cleanly in copy ("Your property is now live", "Properties", "New property").

This is a deliberate choice, not a hard constraint — if we later decide landlords
should hear "home" (it is, after all, the tenant's future home), this table is the
single place to change it.

> **Reserved for a future parent layer: "building" / "parcel".** In some
> property-management systems (Yardi, AppFolio, Buildium) "property" names the
> *parent* that contains multiple units — a duplex as one property with two units.
> We don't model that parent layer today (each `unit` is a flat record with its own
> address; a duplex is two `unit` records). If we ever introduce a multi-unit parent,
> name it **"building"** or **"parcel"** — *not* "property" — so the leaf-entity word
> ("property" = one `unit` to landlords/staff) and the parent word never collide.
> The old "property = parent of units" worry is handled by reserving a different word
> for the parent, not by avoiding "property" for the leaf.

### What is genuinely a "listing" in code (keep these)

"Listing" is a blessed *human* label, but a few code uses of the word are about the
**external public listing** and are correct as-is — do not rewrite them to `unit`:

- `listing_link` — the field holding the unit's public/external listing URL.
- "public listing" in comments referring to that external URL.
- The shareable flyer is the public face of a unit; "listing" wording there is fine.

Likewise, "property" in its plain programming sense (an object property/attribute)
is unrelated to this entity and stays.

---

## The placement (workflow) entity

The **workflow record** that tracks getting one tenant into one specific unit — the
spine of the process — is a **`placement`** in code, data, and UI: the type is
`PlacementItem`, the repo `placementsRepo`, the DynamoDB table `placements` (PK
`placementId`), the API path `/api/placements`, and the dashboard surface is
"Placements". It was originally named `case`/`cases`; that has been **renamed to
`placement`/`placements` throughout** (no `case` entity term remains in current
code/data — see [STATUS-MODEL.md](STATUS-MODEL.md), the living reference for the
placement lifecycle). Unlike the unit/home/property entity, the placement has **one
label for every audience** ("placement") — there is no audience-specific synonym.

> Note: plain-English "case" (a `switch`/`case` keyword, "in this case", "edge
> case", "test case") and the unrelated tenant field `caseworker` are **not** this
> entity and are left as-is.

### Placement signals: deadline, flag, nudge (do not conflate)

Three distinct "this placement needs attention" signals. They were once tangled
(a stuck placement rode the single deadline slot and mis-used the word "nudge");
the placement-deadline-model refactor separated them
([spec](../docs/superpowers/specs/2026-07-03-placement-deadline-model-design.md)):

| Term | Audience | Means | Mechanism |
|---|---|---|---|
| **Deadline** | — | A real due-date: something must be done by an instant. | First-class `placementDeadlines` items (one per `(placement, type)`: `rta_window`, `voucher_expiration`, `follow_up`); the soonest is surfaced. Due deadlines land in Today's `needs_you_now` (hard clocks) or `follow_ups` (`follow_up`). |
| **Flag** | **Staff (internal)** | "This placement has gone quiet — *we* should check on it." | **DERIVED** from time-in-stage (`stage_entered_at` vs `STAGE_STUCK_THRESHOLDS`); no stored artifact. Folds a "Stuck — needs a check" row into Today's `follow_ups`. Fires **independently** of any deadline (a placement can be flagged AND on a hard clock at once). |
| **Nudge** | **External (tenant/landlord)** | An outbound SMS to get *them* to act (submit the RTA, complete the application). | The `placementNudges` ladder (`armStageNudge` / `NUDGE_RUNGS` / `jobs/placementNudges.ts`) — a wholly separate system, **correctly** keeps the word "nudge". |

**Naming rule:** the internal "we should look at this" signal is a **flag**, never a
"nudge". "Nudge" is reserved for the *external* SMS ladder. (Historically the internal
path mis-named itself `scheduleStuckNudge` / "stuck nudge" — that is gone.)

---

## Feature & label notes

- **"Matching"** - the staff dashboard section for sending properties to tenants
  and partners, one-to-one or one-to-many (nav item, list page). One item is a "send" or
  "property send"; the primary action is "Send a property"; a property page
  offers "Send this property". Replaces the earlier on-screen label "Broadcasts"
  (and the still-earlier "Share Properties" note that had drifted from the UI).
  Internal identifiers are unchanged: the `broadcast` entity, `/broadcasts`
  routes, jobs, tables, and log fields all keep their names - only displayed
  copy follows the audience rule.
  **Who a blast reaches** (tracker #6, 2026-10-14): the filters reach only
  tenants in Onboarding or Searching; the housing authority filter is a LIST
  prefilled from the property's **accepted authorities** - a tenant matches ANY
  of them, and while it holds a name a tenant whose housing authority is
  missing or not one of them is left out; and a tenant with an unresolved tour
  for ANY property (an upcoming tour, a past tour not marked, a toured tour
  waiting on an outcome or a placement, a no-show, or a tour request under 14
  days old) is a **tour hold**: listed on Review recipients with a label such
  as "Tour Oct 20", but left unchecked. Tenants left out by status or housing
  authority are not listed at all. A tenant picked by hand skips these rules
  (a held one keeps its label but starts checked), and caseworkers are never
  added by the filters. "Reaches N recipients" counts the recipients that will
  start checked, and the property picker offers Available properties only.
  If tours or Not interested replies cannot be read, a filter blast's review
  waits with Try again (and the API's no-body filter send answers 503
  `audience_rules_unavailable`), while a direct send from a contact's page
  goes ahead with a notice that the labels could not be loaded.
  **Voucher sizes** (property requirements, 2026-10-20): the voucher-size
  filter is a LIST of chips (Studio, 1-BR, 2-BR, 3-BR, 4+ BR; stored
  `bedroomSizes`, values 0..4). A tenant matches ANY chosen size, and 4+ BR
  means 4 or more, so a 6-bedroom voucher matches it. A property pre-fills
  one chip per voucher size it takes; a stored legacy `bedroomSize` reads as
  one chip (`bedroomSizesOfFilter`).
  Design: `docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md`.

- **`utilities` = TENANT-PAID utilities** (2026-07-08). The unit's `utilities`
  field records **which utilities the tenant must pay** (free-form, e.g.
  "Electric and gas") — that is the fact the program cares about. Human labels:
  staff/landlord surfaces say **"Tenant-paid utilities"**; the tenant-facing
  flyer reveal row says **"Tenant pays"**. The storage key stays `utilities`
  (no data migration; values written before the relabel may still read like an
  arrangement, e.g. "Tenant-paid").

- **suggestion (AI)** - a pending-review record the conversation-fact-extraction
  layer writes when an extracted fact conflicts with, or would advance, existing
  contact data; it sits in the `ai_extraction` table awaiting a staff **Accept** or
  **Dismiss** (unlike a directly-written empty-field value, which is applied at once
  with `<field>_source` provenance). Not a "flag" or "nudge" (those are placement
  signals - see above).

- **Staff notes** (contact `staff_notes`, 2026-09-26, Sam's item 22) - the
  tenant file's hand-written box, kept apart from contact `notes`. Contact
  `notes` is the "Preferences & notes" card, which the AI appends dated
  `[Auto - <date>]` lines to and reads as its profile; `staff_notes` is
  human-only - never machine-written or machine-read (not the import, the
  seeds, the public sign-up, the transition service, or extraction). Human
  label: "Staff notes" (staff only; no tenant-facing surface). Companion
  `staff_notes_updated_at` is server-stamped on every write and renders as
  "Last edited <date>" while the box holds text.

- **Unit `notes`** - free-form INTERNAL notes on a property (the
  counterpart of contact `notes`, the Preferences & notes field - not of the
  contact's Staff notes): amenity/quirk facts that are neither utilities nor
  accessibility, e.g. "No dishwasher" (washer/dryer has its own field,
  `washer_dryer`, since 2026-10-20; older notes that mention it keep their
  text). Never on the
  public flyer projections (`unitFields.ts` allowlists exclude it by
  construction).

- **Landlord preferences + expected rent live on the UNIT; requirements live
  on BOTH** (2026-07-10, reversing the 2026-07-02 contact-level-defaults
  design; amended 2026-10-20 by property requirements, tracker #11/#12).
  Accepted authorities (`accepted_programs` until 2026-08-10 - see **accepted
  authorities** below), lease terms and expected rent are PER-PROPERTY facts:
  `accepted_authorities` / `lease_terms` / `rent_min`-`rent_max` on
  `UnitItem`, and the landlord CONTACT does not model them
  (`accepts_programs` / `lease_terms` / `pet_policy` / `expected_rent` were
  removed from `ContactItem` and the contact parsers ignore them). Pets and
  the other **requirements** (below) live on the property AND on the
  landlord: the landlord's `req_` keys are copy-only defaults that reach a
  property only when staff copy them (the New property form's pre-fill, or
  Apply to properties). The onboarding call still CAPTURES the expected
  rent, on the property created from the intake (the New property form's
  Rent fields), not on the person. `lease_terms` is STAFF ONLY since
  flyer-leads (2026-10-21; the flyer showed it as "Lease terms" before), and
  so are `rent_min` / `rent_max` and `accessibility`: Sam talks rent and
  lease terms through with each tenant. They stay on the forms and the
  property page. Rent still reaches tenants in one place: the `[Rent]` merge
  field, which the Matching blast's default text carries
  (`DEFAULT_SEND_TEMPLATE`, `dashboard/src/routes/broadcasts/resolveTemplate.ts`;
  left as it was by Cameron's decision). `subzone` (Sam's area codes, e.g.
  E8) is STAFF ONLY too: it is on the New and Edit forms and the property
  page, never on the flyer. The flyer's neighborhood line is `area` alone,
  and since flyer-leads it is the line directly under the flyer's
  address heading (the address is the heading and links to Google Maps; the
  area is the heading only when no address is recorded).

- **requirements (landlord and property)** (property requirements,
  2026-10-20, tracker #11/#12) - what a landlord asks of a tenant and a
  tenancy, as EIGHT items in four groups: Screening (Evictions, Credit
  score, Income requirements, Qualifications), Pets (Pets), Move-in costs
  (Deposit, Application fee) and Touring (Touring). An ITEM is the unit of
  copying, comparing and tagging: a checkbox or choice and the free text
  that details it are ONE item (Evictions, Pets, Deposit and Touring have
  several fields), so a copy can never leave "No pets" beside contradicting
  details. A property holds each item under its own keys (`no_pets`,
  `pets`, `pet_fee`, `deposit_one_month`, ...); a landlord holds the same
  keys with a `req_` prefix (`req_no_pets`, ...), because bare `pets` and
  `evictions` on a contact are the TENANT's answers, with AI provenance.
  Staff labels: "Requirements" on the property page and forms,
  "Requirements / Qualifications" on the landlord page and form. The
  registry is `app/src/lib/requirements.ts` (dashboard hand mirror
  `dashboard/src/routes/listing/requirements.ts`, same test cases). Only
  the application fee ("No application fee" for 0) reaches the public
  flyer. Screening, touring and qualifications are staff only (Cameron,
  2026-10-20), and so are the whole Pets item (No pets, Pets (details), Pet
  fee) and the whole Deposit item since flyer-leads (2026-10-21; Sam talks
  them through with each tenant). Nothing filters or ranks on them yet (Work Package
  1's AI ranking reads them); credit and income are notes only.

- **copy only** (property requirements, 2026-10-20) - the rule that a
  property NEVER reads its landlord's requirements to fill its own: it
  shows and serves only its own stored values, and nothing on a property
  changes because its landlord changed until staff press "Apply to
  properties" and choose what to copy where. Where each value came from is
  recorded per item in the server-written map `unit.requirement_sources`
  (`{ <item id>: 'copied' | 'set_here' }`; an item absent from it is "never
  touched"), and a change of the property's landlord of record clears the
  map.

- **"Set on this property" / "Landlord updated"** (property requirements,
  2026-10-20) - the two tags a property's Requirements card puts on an item
  whose value differs from its landlord's current value. Purple "Set on
  this property" + "Landlord: <value>" is a deliberate exception (recorded
  `set_here`, or never touched with a value of its own); orange "Landlord
  updated" + "Landlord now: <value>" is an out-of-date copy (recorded
  `copied`, and the landlord changed since). A blank landlord value prints
  "blank" and counts as differing. An exception is an "own value": Apply
  starts a property UNCHECKED when an own value is among its changes and
  names the item, so an exception is overwritten only on purpose.

- **"Relay group"** (RENAMED 2026-08-10, group-texting S1) = the STAFF-FACING
  label for the MASKED relay thread: tenant and landlord talk through a shared
  **pool number** and never see each other's real number. It used to be called
  "Group text" everywhere in staff copy; that vocabulary now belongs to the
  NATIVE type below, so the relay product took the unambiguous name. Code and
  data are UNCHANGED - the conversation type is still `relay_group`, the repos
  are still `relayGroupsRepo` / `poolNumbersRepo`, the persisted activity-event
  types are still `added_to_group_text` / `removed_from_group_text`, and the
  contact-file component is still `GroupTextsCard.tsx`. Only display copy moved.
  MEMBER-facing outbound copy says **"group chat"**, never either staff label
  (`relay.group_closed`, the fan-out `joined` fragment). Tenants and landlords
  never see the words "relay group".

- **"Relay group number"** = the STAFF-FACING name a navigator sees for a relay
  **pool number** (the shared number the relay multiplexes relay groups onto).
  Code and data stay `pool_number` / `poolNumber` (`poolNumbersRepo`,
  `PoolNumberItem`, `lifecycle_state`, `burned_phones`); the Settings tab at
  `/settings/numbers` is titled **"Phone numbers"** and its pool inventory block
  is headed **"Relay group numbers"** (admin-only, read-only - the tab
  itself is visible to every authenticated user, since its other block shows OUR
  one business number). A number is provisioned with the first relay group and
  can outlive many groups (burn-as-claim multiplexing), so the accurate noun is
  "relay group number", never "the group's number". Tenants and landlords never
  see this term.

- **"Group text"** (native group texting, 2026-08-10) = a REAL carrier group
  text: one thread on OUR one business number where EVERYONE SEES EVERYONE's
  real number. Nothing is masked and no pool number is involved - the exact
  opposite of a **relay group**, which is why the two could not keep sharing a
  label. Code and data: the conversation type `group_text`, thread id
  `conversationIdForGroup(<sorted outside-participant set>)` with the business
  number, every pool number, and `GROUP_IDENTITY_EXCLUDED_NUMBERS` subtracted
  from the envelope's participants. A group text arises from exactly two paths -
  the Quo import/migration seam and inbound detection - and is NEVER created by
  staff from the dashboard. Tenants and landlords experience it as an ordinary
  group text from the number on the flyer; members see it as a "group chat" in
  any copy we send into it.

- **"Our number"** / **the business number** (2026-08-06) = the ONE number an
  environment texts and calls FROM, configured as the env var
  `BUSINESS_PHONE_NUMBER` and read as `config.businessPhoneNumber` (a scalar; it
  replaced the positional `OUR_PHONE_NUMBERS` list whose `[0]` was silently
  special). Staff see it read-only as "Our number" in **Settings > Phone
  numbers** and as the "Sending from" pill on **Settings > System status**;
  tenants and landlords know it as the number on the flyer. It is NEVER a relay
  pool number ("relay group number", above): dev and prod each have their own,
  and there is no in-app edit path. It IS the number every native **group text**
  (above) runs on.

- **`partner`** (email-channel v1, 2026-07-21) - a FIRST-CLASS `ContactType` (the
  code/data value `partner`, a union member beside `tenant` / `landlord` /
  `unknown`), shown to staff as **"Partner"** (the KindPicker segment + the
  contact-type pill). A partner is an outside collaborator we email/text 1:1 - a
  caseworker, an agency contact - who is neither a tenant nor a landlord. It is
  deliberately HEAVIER than the property-manager precedent, which is a CUSTOM-KIND
  (a role layered on the landlord base), NOT its own union member: `partner` is a
  real type end to end (a `partner_1to1` conversation, author `'partner'`). Tenants
  and landlords never see the word - it is a staff/internal label only. A
  partner whose role is "Caseworker" is a **caseworker** (below, beside the
  organization entries) - still typed `partner`.

- **unmatched email** (email-channel v1, 2026-07-21) - an inbound email from a sender
  we do NOT recognize (no matching contact, no reply token). It NEVER auto-creates a
  contact or a conversation (spec Decision 4): it lands in the side-door
  `unmatched_email` store behind the **Email** nav item (`/email`, Unmatched tab),
  where staff link it to a contact, start a new contact, report it as spam, or
  dismiss it. An unmatched email is NEVER a `ConversationSummary` and NEVER appears
  in the general inbox or in Today - it is a triage queue, not a thread. Code/data:
  the `unmatched_email` table + `UnmatchedEmailItem`.

- **quarantine** (email-channel v1, 2026-07-21) - the sub-bucket of the unmatched
  surface for inbound mail from unknown senders whose SES spam/virus verdict FAILED
  (or is GRAY). It is held ONE CLICK deeper on the Email page (the Quarantine tab,
  `/email/quarantine`), not in the main Unmatched list, so suspected-spam/virus mail
  never clutters triage. Staff **Release** a quarantined item back to Unmatched or
  **Delete** it. Distinct from `unmatched` (a clean unknown-sender email): same
  store, a different `status`. The Email nav badge counts UNMATCHED unread only,
  never quarantine.

- **primary contact** (contact-rosters, 2026-08-04; kept usable by
  primary-contact-integrity, 2026-10-13) - the property-side person the app puts
  on a tour's or placement's default people list and names in the relay intro and
  the tour reminders: the unit's DEFAULT contact (read through the **property
  contact** lookup, below). Code and data: the roster-row flag
  `UnitContact.primaryContact` - THE FLAG IS THE TRUTH. The unit scalar
  `primary_contact` mirrors it, is written only by the roster writes (and the
  one-time `app/scripts/assign-primary-contacts.ts`), never by a unit create or
  PATCH, and is ABSENT on a landlord-only unit, whose primary is the DERIVED
  landlord row (`unitContacts()`); nothing reads the scalar at runtime, so code
  that needs "who is primary" reads `unitContacts(unit)`. AT MOST ONE per unit.
  The HANDOFF rule (spec
  `docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md`,
  section 4): when the primary is removed from the property, deleted, or cleared
  by "Restore without a landlord", the HEIR takes over - the landlord of record
  when live, else the earliest-added contact eligible for automatic routing
  (typed landlord, live, not a phone or email routing pointer: never a tenant or
  a caseworker) - and an add or an edit of an eligible contact on a property
  with no live primary and no live landlord of record makes THAT contact
  primary. So zero primary is reachable when nobody can take over (no live
  landlord of record and no eligible live contact), when only NON-eligible
  contacts were added (a tenant or partner is never promoted automatically),
  when such a contact is classified as a landlord or property manager on its
  contact page AFTER it joined (a type change is not a contact-list write, so
  it promotes nobody - the 470 Bolton shape again), after an explicit API
  write that sends `primaryContact: false` for the current primary's own row,
  or for legacy data the script has not repaired;
  the property's Contacts card then shows a "No primary contact." box (with a
  live landlord of record the lookup still uses the landlord). A DELETED contact can stay flagged when nobody could
  take over; the property contact lookup skips it. Staff see the primary as
  "(primary)" on the property's Contacts card. RENAMED 2026-08-04 from
  `primaryVoice` / `primary_voice_contact`: the old names meant only "the
  landlord-side person a masked tenant call routes to", and the concept widened
  to cover relay groups as well as calls (persisted keys were renamed too - safe
  only because prod is not live yet and dev reseeds).

- **landlord of record** (contact-rosters, 2026-08-04) - `unit.landlordId`: who
  OWNS the unit. Deliberately distinct from the **primary contact** (who new
  tours and placements put on their people list and the relay intro names; the
  **property contact** lookup falls back to the landlord of record when no live
  primary is flagged): the landlord of record is IMMOVABLE from the roster -
  `unitsRepo.removeContact` refuses with `CannotRemoveLandlordOfRecordError`,
  which the route maps to 409 `cannot_remove_landlord_of_record` ("cannot remove
  the unit's landlord of record; reassign landlordId first"). Their roster row's
  role is also structural (always `landlord`). RENAMED 2026-08-04 from
  `CannotRemovePrimaryLandlordError` / `cannot_remove_primary_landlord`: the old
  "primary landlord" wording collided with the primary contact, which is exactly
  the ambiguity this pair of names removes.

- **property contact** (primary-contact-integrity, 2026-10-13) - who the app
  actually USES for a property, given a tenant: the answer of the ONE shared
  lookup in `app/src/lib/propertyContact.ts` (`resolvePropertyContact` /
  `decidePropertyContact`). It walks the flagged **primary contact**, then the
  **landlord of record** when set and different; a deleted or missing contact
  is skipped, a candidate who IS the tenant stops the walk (nobody), and a read
  that fails stops it too (never read as "deleted"). It is what the tour and
  placement default people lists, the relay intros, the tour reminders and the
  "cannot open a group" diagnostics use. Distinct from the primary contact (a
  stored flag, which can name a deleted contact) and from the landlord of
  record (the owner). When it finds nobody, an owned group opens with the
  general intro and the open-group dialog says why; the property page reads it
  as the unit's `propertyContact` block. Staff copy keeps saying "primary
  contact" - that is what they set.

- **housing authority** (tenant-list-visibility, 2026-08-10; rewritten by
  clean-org-names, 2026-10-06) - the organization that RUNS a tenant's voucher:
  it receives the RTA (or the program's unit request), approves and inspects the
  unit, and pays the landlord. Usually a public housing authority; the Georgia
  Housing Voucher Program (DBHDD) is the one listed entry that is a state program
  rather than a housing authority. For a tenant who ports, it is the authority
  that administers the voucher where they lease - **porting** is that voucher
  moving between authorities (the informational `contact.porting` flag). A tenant
  has EXACTLY ONE (`contact.housingAuthority`, the `byHousingAuthority` GSI
  hash - the GSI is kept, but since tracker #6 (2026-10-14) a Matching blast no
  longer reads it: the blast reads Searching and Onboarding tenants and compares
  this value with the filter's names in memory); a property lists the ones it
  accepts (**accepted authorities**, below).
  Values are NAMES from the housing authority list (**organization list**,
  below): a record stores the entry's exact name text, never an id, and every
  writer checks a changed value against the list (a unique **alternate
  spelling** is stored as its entry's name; every API writer refuses anything
  else with 422 `org_not_on_list`; the AI turns it into a staff suggestion and
  the importer reports it). Staff see the label "Housing authority" with the
  help text "The organization that runs the voucher". "Voucher program" is NOT
  a separate dimension - it dissolved into this term on 2026-08-10. Distinct
  from an **agency** (below), which the old data shoehorned into this field. Design:
  `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`.

- **agency** (tenant-list-visibility, 2026-08-10; rewritten by clean-org-names,
  2026-10-06) - a government or nonprofit organization that HELPS a tenant but
  does not hold the voucher or process the RTA: a caseworker's employer, a
  community service board, or the VA for HUD-VASH (HOPE Atlanta, Step Up,
  Claratel Behavioral Health and HUD-Veterans Affairs Supportive Housing
  (HUD-VASH) are on the starting list). NOT a housing authority, and the two
  COEXIST - a tenant can hold one of each - so it is its own optional field
  (`contact.agency`, no GSI and no facet; staff see it as the "Agency" row on a
  tenant's Details card). Values are names from the agency list (**organization
  list**, below), checked like the housing authority. A property is never tied
  to an agency, and an agency name is never stored as a housing authority: the
  AI drops one it returns for that field (drop reason `agency_not_authority`,
  shown as "Agency, not a housing authority").

- **organization list** (clean-org-names, 2026-10-06) - the two stored lists,
  housing authorities and agencies, with each entry's alternate spellings and
  notes: ONE item (`settingId: 'org-list'`) in the `settings` table, read fresh
  by every use (no cache). An environment creates it once from the starting
  list (`app/src/lib/orgStartingList.ts`) and from then on changes it only
  through the app (the dev seeds write it whole for test worlds).
  Managed on Settings > Housing authorities & agencies: everyone can view it,
  add a name (through "Is this really new?") and edit notes; admins edit
  spellings, rename, merge, delete and change an entry's kind. A rename, a merge
  or a "Not on the list" action rewrites the records that hold the text (the
  `org.rewrite` job). Names are unique across both kinds. Code:
  `app/src/lib/orgNames.ts` (the rules), `app/src/repos/orgListRepo.ts` (the
  stored item).

- **alternate spelling** (clean-org-names, 2026-10-06) - an abbreviation or
  other spelling that finds a listed name: AHA, HADC, DBHDD. Typing one in a
  picker shows its name, and a writer given one stores the name. A spelling may
  belong to more than one name of the SAME kind (AHA is Atlanta's and
  Augusta's); such a shared spelling is never applied automatically - staff
  pick. A spelling never equals a name and is never shared across kinds.
  Spellings are curated - the starting list, admin edits, renamed and merged
  names, and "Use <name>" with "Remember this spelling" - never learned from
  form clicks. Code/data: `OrgEntry.spellings`.

- **not on the list** (clean-org-names, 2026-10-06) - a stored value that is
  not exactly a listed name of the kind its field takes: an old spelling,
  unknown text, an agency name in a housing authority field, or a value the
  one-time cleanup (`app/scripts/clean-org-names.ts`) left. Shown on Settings >
  Housing authorities & agencies, in the "Not on the list" section, with its
  record count and how it resolves, until staff settle it (Use <name>, Move to
  Agency or Housing authority, Split, Add as new or Clear - admin actions that
  rewrite the records). On a form it is a removable chip marked "Not on the
  list", and an unrelated save never fails because of it. A caseworker's
  **organization** (below) is listed too, as an organization row: Use (a name
  of EITHER kind), Add as new (staff pick the kind) or Clear - never Move or
  Split, since the field takes both kinds.

- **caseworker** (caseworkers, 2026-10-08) - a `partner` contact whose `role`
  is "Caseworker": the role normalizes (spec D4) to "caseworker" or "case
  worker" (`isCaseworkerRole`, `app/src/lib/caseworkers.ts`; the preset value
  is `CASEWORKER_ROLE`). NOT a `ContactType` - the code/data type stays
  `partner`, the way Property Manager stays `landlord`. Staff meet it as the
  KindPicker's "Caseworker" choice and the Contacts > Caseworkers tab (with
  an Organization filter). A NEW contact saved as Caseworker is stored
  `{ type: 'partner', role: 'Caseworker' }`; an EXISTING contact becomes one
  only through the **caseworker conversion** ("Make caseworker" - the contact
  page's More actions, the Unknown card's "Mark as Caseworker", or a Possible
  caseworkers row; `POST /api/contacts/:contactId/caseworker-review`), which
  refuses a contact with an open placement, an open tour as the tenant, a
  property it is landlord of record for, or a seat on a property's contact
  list; removes the tenant's housing authority and agency (keeping them, with
  the old type, in `caseworker_conversion`); and re-types the contact's own
  one-to-one threads to `partner_1to1`. The contacts PATCH refuses to make a
  caseworker any other way (409 `caseworker_use_conversion`). "Possible
  caseworkers" are the contacts the tab offers for review: a role that
  MENTIONS caseworker, case worker or case manager, the AI's
  "[Auto - <date>] Identified as a caseworker" notes line, a caseworker
  relationship pointing at a tenant, or a partner with no role; "Not a
  caseworker" hides one for good (`caseworker_review: 'dismissed'`).
  DIFFERENT from the tenant's free-text `contact.caseworker` (the NAME of a
  tenant's own caseworker, e.g. "D. Okafor", shown on placements), which the
  caseworkers feature neither reads nor writes. Design:
  `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
  D16-D22.

- **organization (of a caseworker)** (caseworkers, 2026-10-08) - the housing
  authority or agency a caseworker works for: `contact.organization`, a NAME
  from EITHER list of the **organization list** (above), checked like the
  housing authority (422 `org_not_on_list`; `''` removes it). Shown on a
  partner's page and in its header, and as the Caseworkers tab's
  Organization filter; counted in Settings' use counts (an entry's list row
  and its panel's "Used by") and rewritten by a rename or merge of either
  kind. The conversion fills it from the
  contact's agency, else its housing authority - the list name when the text
  matches one, else the text as written (then it waits under "Not on the
  list"). Not the **organization list** itself, and not the generic word.

- **accepted authorities** (tenant-list-visibility, 2026-08-10; updated by
  clean-org-names, 2026-10-06) - the authorities whose vouchers a property takes:
  `unit.accepted_authorities`, a string LIST with at least one entry, chosen by
  the landlord. Its members are NAMES from the housing authority list
  (**organization list**, above): the unit POST and PATCH check every new member
  against it (a unique **alternate spelling** is stored as its entry's name;
  members the unit already holds pass unchanged), and staff pick them with the
  "Housing authorities" multi-picker, where a held member that is not on the
  list shows as a "Not on the list" chip. It REPLACED both `unit.jurisdiction`
  (a single string that could not hold the plural) and `unit.accepted_programs`
  (old-vocabulary program labels - `HCV`, `Section 8`, `VASH` - retired with the
  field, never folded in). Staff and landlords see ONE "Housing authorities"
  picker/row; tenants see it as the flyer's "Accepts:" line. Jurisdiction ("is the
  unit in authority X's area?") and acceptance ("does this landlord take X's
  vouchers?") are two distinct QUESTIONS but explicitly ONE field (Cameron,
  2026-08-10): the two-question framing is how staff reason about FILLING the list,
  not two things to store, so there is deliberately no jurisdiction field beside it.
  Legacy documents are read through `authoritiesOf(unit)`, which synthesizes
  `[jurisdiction]` when the list is absent. The one-time cleanup
  (`app/scripts/clean-org-names.ts`) BACKFILLS the stored list from that legacy
  value - its list name when it resolves to one entry, else the raw value, which
  then shows as **not on the list** (above) - so once it has run in an environment no
  stored unit depends on the synthesis. The two retired keys are accept-and-ignore
  tombstones on the unit PATCH until `docs/issues/retire-humanize-authority.md`
  closes.

- **"Coming soon"** (tracker #1, 2026-10-01) - the staff-facing name, on the
  Properties page's by-housing-authority summary ONLY, for properties in the
  existing `setup` status: the column reads "Coming soon (Setup)". It is NOT a
  status of its own (decided 2026-09-30) - the status dropdown, row badges and
  property page keep "Setup", which also covers brand-new properties still being
  set up. Its partner column is "Available" (`available`). Code: the
  `COMING_SOON_STATUS` constant in `dashboard/src/routes/listings/unitListFacets.ts`.

- **voucher size of a property** (accepted voucher sizes; Cameron, 2026-10-04;
  a list since property requirements, 2026-10-20) - the voucher (bedroom)
  sizes a property takes: its RECORDED `voucher_size_accepted` when there is
  one (a LIST of integers 0..12, Studio being 0, stored de-duplicated and
  ascending; an older stored single number still reads as one size),
  otherwise its bedroom count (`beds`); "Not recorded" only when both are
  missing. Read ONLY through `acceptedVoucherSizes(unit)` - never re-derived
  at a call site. The source of truth is in `app/src/lib/unitFields.ts` (the
  public flyer reads it, 2026-10-12); the dashboard copy in
  `dashboard/src/routes/listing/listingFormat.ts` is its hand mirror, like
  `authoritiesOf`, with the same test cases in both suites. The flyer states
  every size ("Fits a 2- or 3-bedroom voucher"), and Matching pre-fills one
  voucher chip per size (a size of 4 or more is the "4+ BR" chip).
  Distinct from a tenant's `voucherSize` (the voucher the tenant holds) and
  from the stored field itself, which the property page and the New/Edit
  forms show and edit as entered: the forms use picker B (chips Studio and
  1-4, "More sizes (5-12)" for the rest, an "Accepts: 2 BR, 3 BR" line under
  them), and the page's "Voucher sizes accepted" row lists the recorded
  sizes and stays EMPTY when nothing is recorded (never the bedrooms
  fallback - Cameron, 2026-10-12); emptying the picker removes the field.
  
- **Tour auto-close / "No outcome recorded" / Reopen** (tour auto-close,
  2026-10-01, Sam's item 18) - a tour still undecided two weeks after its
  clock start is closed by the worker, silently (nothing is sent), with
  outcome `no_outcome`, shown to staff as "No outcome recorded". The clock
  start is the LATEST of the tour's time, its creation and its mark:
  `lastMarkedAt` (the last time a person marked, rescheduled or reopened it)
  or, for a tour nobody has marked yet, its last change of any kind
  (`updatedAt`). Only scheduled (date passed), toured-without-outcome and
  no-show tours close; requested, canceled, "Needs placement" and converted
  tours never do. Staff never record `no_outcome` - the Record outcome dialog
  keeps its two choices. The tour page's Outcome card reads "Closed
  automatically on <date>" (`autoClosedAt`) in place of "Moving forward", and
  the Closed tab badges the row "No outcome recorded". "Reopen tour" (tour
  page only; `POST /api/tours/:tourId/reopen`) returns a closed tour that did
  not become a placement to the state it closed from - `autoClosedFrom` for an
  auto-closed tour, toured for a decided one ("Not a fit") - clears the
  outcome, sends nothing and restarts the two weeks. Code/data:
  `autoClosedAt`, `autoClosedFrom`, `lastMarkedAt`, `jobs/tourAutoClose.ts`
  (the worker's 15-minute poll), `POST /api/tours/:tourId/reopen`.

- **Requested tour / "Needs booking" / "Undated"** (tour list, 2026-10-06,
  Sam's item 18) - a `requested` tour is a tour request with no time yet - it
  never carries a date (booking it makes it `scheduled`). Its STATUS reads
  "Requested" (the badge on rows and the tour header, `TOUR_STATUS_LABELS`);
  everything that names the WORK says "Needs booking": the Active tab's
  section (its list is named "Unbooked tour requests"), the All tab's status
  chip (value `requested`), and its missing date on every surface. Any OTHER
  tour without a date - toured with the date left blank, a request canceled
  before booking, or one of those closed - reads "Undated": dateless history,
  not work, so the property page's "Tours on this property" card lists it
  after the dated tours, never among the requests (`sortToursForPanel`). One
  helper, `undatedTourLabel` (`dashboard/src/api/types.ts`), is the one
  implementation of that wording rule; every surface that shows a tour's
  missing date reads it. These two labels retire "Not booked", which the tour
  page and the tenant and landlord files' tour lists and the property page showed for
  every undated tour (the Past tab and Today already said "Undated"; the
  Closed tab showed a blank date) - its record:
  `docs/issues/undated-tour-wording.md`. Also: the All tab (`/tours/all`,
  listed first; `/tours` stays Active) is a server-filtered, server-paged
  list of every tour (`GET /api/tours/list`); its Upcoming / Past are pure
  date splits across every status, unlike the Active tab's Upcoming section
  and the Past tab (curated work lists).

- **last heard from** (last-heard-from, 2026-10-12) - the most recent inbound
  text, call or email FROM a contact, in any thread (one-to-one, relay group,
  native group text). Staff copy: "Last heard from <date>" (the Tenants tab,
  the contact header, Matching's Review recipients, the Sent to cards, the
  Follow up tab); "Never" when there is none. Stored as `last_heard_from_at`
  on the contact: forward-only, written ONLY by
  `contactsRepo.touchLastHeardFrom` (refused from clients), and attributed by
  ONE rule, `attributeInbound` (`app/src/lib/heardFrom.ts`), shared by every
  live path, the importer, the seed and the backfill. A call counts at ring
  time whatever its outcome; a STOP counts (it is not a consent signal); an
  email from an address on no contact does not count until staff link the
  address. Outbound and automated traffic never move it. Not a conversation's
  `last_activity_at` (any direction) and not a phone's `lastSeenAt`.

- **send outcome** (last-heard-from, 2026-10-12) - per property sent to a
  contact: No reply yet / Replied / Interested / Not interested, plus Signed
  up since flyer-leads (2026-10-21; see **signed up** below). Interested =
  a qualifying tour exists for that tenant and property (tenants only - a
  partner row never reads a tour); Not interested = a recorded decline not
  superseded by a later send or later tour activity (a tour CREATED after the
  decline, by any path - even if that tour is later canceled - or a qualifying
  tour rescheduled / reopened after it; never a cancel or no-show mark); Replied = heard from
  after the send; otherwise Signed up when the pair's latest counted share
  entry is the flyer entry, else No reply yet. Precedence: Not interested >
  Interested > Replied > Signed up / No reply yet. DERIVED, never stored, except the
  decline record (`listing_sends.declined`). "(auto)" marks an engine decline
  on the cards only. Code: `ListingSendOutcome` in
  `app/src/lib/listingSendOutcome.ts` - never `SendOutcome`, which is the
  Twilio send-failure vocabulary.

- **waiting on a reply** (last-heard-from, 2026-10-12; updated 2026-10-23) - a
  send at No reply yet or Replied whose recipient can be texted (not deleted,
  not opted out, not unreachable, has a phone, not **Inactive** - any contact
  type since 2026-10-23, tenants only before - and not a placed tenant) and has
  been quiet for 24 hours since the later of the send and their last heard
  from, within 14 days of the send (`FOLLOW_UP_QUIET_MS`,
  `FOLLOW_UP_LOOKBACK_MS`). Listed on Matching's "Follow up" tab, grouped by
  property, and counted as "<n> waiting" on the Properties list. A Signed
  up pair never waits: the person reached out, and the sign-up already
  marked their thread unread.

- **flyer share entry** (flyer-leads, 2026-10-21) - what a flyer sign-up
  writes to a contact's properties-sent list: ONE entry with share key
  `flyer` in the (property, contact) pair's `listing_sends.shares` map,
  counted at the sign-up instant (attempt key `<sign-up ISO>#flyer`, by
  `acceptance`), through the same ledger path every share uses. It is a
  share ENTRY, not a new row kind, and not a send: no text goes out, it has
  no broadcast, and no "Property sent" pin is written. It is written only
  for a shareable property and a `tenant` or `unknown` contact, and never
  while the pair holds a current decline (a sign-up never clears a
  decline). Code: `FLYER_SHARE_KEY` in `app/src/lib/shareLedgerKeys.ts`.

- **signed up** (the pin and the outcome; flyer-leads, 2026-10-21) - a
  sign-up on the flyer or on /join from a live contact records an activity
  event of type `signed_up`, shown as a pin in the contact's thread:
  "Signed up from the flyer for `<address>` as `<First Last>`" (linked to
  the property), "Signed up from a flyer as `<First Last>`" (the property
  is not shareable) or "Signed up on the join page as `<First Last>`".
  When texts to the number are off, each form ends with a note worded by
  its cause (Cameron, 2026-10-22). When a 1:1 thread of the signed-up
  number carries `sms_opt_out` (a STOP from that number), it ends with
  " (this number opted out of texts - they need to text START from it to get texts again)":
  a sign-up cannot opt a number back in, since Twilio's opt-out block
  lifts only when the person texts START, YES or UNSTOP from it. Else, when
  only the contact's own `sms_opt_out` is set, it ends with
  " (marked Do-Not-Contact - texts stay off unless staff choose Allow SMS)".
  Four causes leave only that flag: a staff Do-Not-Contact, a STOP from the
  contact's other number, a 21610 receipt, and an imported STOP. "Allow SMS
  (clear opt-out)" on the contact's menu is the remedy only for the staff
  mark (`docs/issues/opt-out-writers-skip-number-thread.md`).
  Either way the pin tells staff and the public page says nothing different.
  `<First Last>` is the name typed on the form: a sign-up never changes an
  existing contact (no name, type, status, voucher size, housing authority
  or consent), and only a contact the sign-up CREATED gets the welcome
  text. The sign-up also bumps the contact's 1:1 thread to the top of the
  inbox and marks it unread - one pin and one bump per contact per property
  (or per the shared "no property" source) per 24 hours for sign-ups that do
  not overlap. The repeat check is a read, not a claim, so two overlapping
  requests from the same source can each pin and bump; a burst is bounded by
  the public form's per-IP rate limit instead
  (`docs/issues/public-signup-abuse-hardening.md`). The send
  outcome `signed_up` - staff copy "Signed up", the row reading "Signed up
  from the flyer <date>" in place of "Sent <date>" - is a pair whose latest
  counted share entry is the flyer entry (see **send outcome**). A sign-up
  does not move **last heard from**; a later inbound from the person does,
  so the pair then reads Replied and is back on Follow up once quiet
  (unknown contacts included; never an **Inactive** contact, see **waiting
  on a reply**). The unread thread also shows on Today: a
  tenant's, landlord's or partner's under Unreplied as "<name> -
  Unreplied", an existing unknown contact's under Needs you now as a "New
  unknown contact" (not when that contact is **Inactive**: its unknown thread
  shows only in the inbox). When the contact had no thread on that phone, the
  sign-up creates one with no message, so its inbox row is bold with a
  blank preview and, as the contact's newest conversation, heads that
  contact's row.

- **Inactive** (contact status; unknown-inactive, 2026-10-23) - the status
  that sets a contact aside WITHOUT deleting it, on every contact type that
  has it: tenant, partner (a caseworker or other partner), team member and
  unknown (code `inactive`, label "Inactive"). It means the same thing on
  each (Cameron, 2026-10-23): the contact is not chased (no **waiting on a
  reply** row, not eligible for follow-up on a property's listing sends -
  `isEligibleRecipient`, `app/src/lib/listingSendOutcome.ts`; automatic
  texts and hand-picked shares still reach it, by decision - STATUS-MODEL.md
  section 5b) but stays on the Contacts lists, in
  search and in the inbox, where its texts and calls still show unread and
  its row carries a small muted "Inactive" tag and no "Needs triage" chip.
  An inbound text or call never moves it back to Needs review. An unknown
  contact's or team member's unknown threads leave Today's Needs you now
  when it is marked Inactive (a team member's 1:1 threads are unknown
  threads too; those unread texts show only in the inbox, while a typed
  thread it kept from an earlier type - a re-type to unknown or team
  member, through the API or an import, re-types none of its threads -
  still feeds Unreplied), and an Inactive unknown contact sorts below the
  Needs review ones on the inbox Unknown tab and on Contacts > Unknown; an
  Inactive tenant's or partner's unread text still shows on Today where it
  would otherwise (under Unreplied, or as a "New unknown contact" row when
  its thread is still an unknown thread: the importer mints every imported
  one-to-one thread as one, whatever the contact's type -
  `docs/issues/imported-unknown-threads-surface-as-unknown-on-today.md` -
  and a second number's can stay one after the contact is typed).
  Staff set it from the contact page header dropdown or the Edit contact
  details Status field, which offer the same choices for every type; an
  unknown contact has no "Active" (Needs review or Inactive only). NOT a
  landlord's "Parked" (the landlord's own retired status, which needs a
  reason), which none of these rules touch. Full rules:
  [STATUS-MODEL.md](STATUS-MODEL.md) section 5b.

---

## For the future AI layer

When AI augmentation/automation talks to a party, it must use that party's word
from the table above: **home** to tenants, **property** to landlords and staff,
and reason internally in terms of **units**. This document is the source of truth
for that mapping. (We are keeping it docs-only for now; if a runtime constant is
ever wanted so prompt-builders import one definition, mirror this table — do not
fork it.)
