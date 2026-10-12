# Primary contact integrity and the intro fallback explanation - design

Date: 2026-10-12. Status: DRAFT rev 1 (design review pending).
Branch: `feat/primary-contact-integrity` (worktree `W:\tmp\primary-contact-integrity`).
Origin: Sam's tracker note "3." (2026-10-12) - tour groups at 470 Bolton open
with "the old version" of the intro.
Sequencing: the PLAN is written after `fix/caseworker-integrity` lands on `main`,
and the build is cut from that `main` (section 11).

## 1. Problem

Opening a relay group from a tour sends one of two intros:

- the TOUR intro (`relay.intro_tour` / `relay.intro_tour_today`, Sam's
  2026-08-24 wording, shipped in 1.3.4): "Hey {tenant}! It's Sam. Putting you
  in a group text with {landlord} to tour {street} on {when}. ..."
- the GENERAL intro (`relay.intro`, the only intro before 1.3.4 - what Sam
  calls "the old version"): "Hey, it's Sam. You're now connected with {names}
  on this number. ..."

`resolveRelayComposeInputs` (`app/src/jobs/relayFanOut.ts:444-578`) picks the
tour intro only when it can resolve a property contact FIRST NAME, a STREET,
and a tour time that has not started. Any miss silently degrades to the general
intro. Preview and send share that resolver (`services/rosterEdits.ts:587`),
so what Sam sees in the confirm dialog is what is sent - but nothing tells her
WHY.

470 Bolton is an imported property: the importer leaves `landlordId` unset when
the landlord name does not match exactly one imported person
(`app/src/lib/import/apply.ts:1506-1520`). Its only contact, Mark Passmore, was
later added as Property Manager, and adding a contact never makes anyone
primary (`ListingDetail.tsx:486` sends `primaryContact: false`;
`unitsRepo.addContact` honors it). So the property has no primary contact and
no landlord of record, the property-contact lookup finds nobody, and every tour
there gets the general intro. New tours also leave Mark off their default
people list, for the same reason.

Two neighbouring gaps share the root cause - the primary contact is not kept
pointing at a usable person:

- Removing the primary from a property with no landlord of record leaves NO
  primary, even when another contact remains (`unitsRepo.ts:906-912`). The
  confirm notice then claims "tours fall back to the landlord of record"
  (`ListingDetail.tsx:478`) - wrong exactly when there is no landlord.
- Deleting a contact (soft delete, `routes/contacts.ts:2228`) touches no
  property. A deleted primary stays primary: it is excluded from sends as a
  removed contact, nobody replaces it, and the intro and reminder copy still
  NAME it, because `contactsRepo.getById` returns soft-deleted contacts and
  `lib/tourContacts.ts` never checks `deleted_at`.

## 2. Goals and non-goals

Goals:

- G1. A property with at least one live contact has a live primary contact,
  kept that way on every write that can take it away.
- G2. Everywhere the app picks "the property's contact", it skips deleted
  contacts, through ONE shared function.
- G3. When an owned group's intro falls back to the general intro, the
  open-group dialog says why, lists every missing piece, and links to the fix.
- G4. The property page warns when it has no usable primary contact and
  offers the fix in place.
- G5. Existing properties in the broken state can be repaired in one
  operator-run pass.

Non-goals (each deliberately left out):

- Composing the intro from the people actually in the group. Cameron chose the
  explanation (G3) over this on 2026-10-12.
- Warning on the property page about a missing first name or street address:
  those surface in the open-group dialog only (section 7).
- Changing the intro copy, the catalog entries, or the variant precedence.
- The importer's landlord matching (`apply.ts:1506`). An imported property
  without a landlord is a legitimate state; G1 and G5 make it usable.
- The unbuilt business-number masked-call path
  (`routes/webhooks/voice.ts:627`, `docs/issues/voice-business-number-roster.md`):
  the `primary_contact` scalar drives no live call routing today. It is kept
  consistent (section 4) so that path inherits correct data when built.

## 3. Definitions

- **live contact**: a contact record that exists and has no `deleted_at`
  (`isDeleted` false). A roster or landlord id that names NO record (the
  importer's `retractImported` hard-deletes contacts without touching units,
  `apply.ts:316-328`, `:769-775`) is treated exactly like a deleted contact.
- **primary contact**: unchanged meaning (GLOSSARY) - the roster row flagged
  `UnitContact.primaryContact`, mirrored by the unit scalar `primary_contact`.
- **landlord of record**: unchanged - `unit.landlordId`.
- **property contact** (NEW term): who the app actually uses for a property -
  the primary contact if live, else the landlord of record if live, else
  nobody. Computed by the shared lookup (rule P1). It is what the tour and
  placement default people lists, the relay intros, the tour reminders and the
  "cannot open a group" diagnostics use.
- **earliest-added**: roster array order. `addContact` appends, and
  `unitContacts()` derives the legacy landlord row first, so array order is
  add order.
- **handoff**: choosing a new primary when the current one goes away
  (rule P3).

## 4. Rules

### P1. One shared property-contact lookup

A single function (location: `app/src/lib/propertyContact.ts`, new) answers
"who is this property's contact, given this tenant":

1. the primary row's contact, if it is live and is not the given tenant;
2. else the landlord of record, if live and not the given tenant;
3. else nobody.

It returns the contact (when found) and, when nobody, WHY - one of
`none` (no primary and no landlord of record), `deleted` (the primary or the
landlord of record named a deleted or missing contact and nobody live was
left), `is_tenant` (the only candidate is the tenant themselves) - plus a
`readFailed` flag when a contact read threw. It never throws, matching the
resolvers it replaces.

A THROWN read is not absence. When a candidate's read throws, P1 stops there
and reports `readFailed` - it does NOT fall through to the next candidate. That
preserves the reminders' fail-closed rule: a thrown property read blocks a
reminder send rather than composing different copy
(`jobs/tourReminders.ts:960-963`, `ReminderNamesUnavailableError`).

The tenant guard keeps today's de-dupe (`tourContacts.ts:130-139`,
`rosterResolution.ts:298-301`).

Every reader of the primary-then-landlord ladder moves onto P1. The known
copies are `lib/tourContacts.ts:124`, `lib/rosterResolution.ts:292-294`,
`services/rosterProvision.ts:233` and `:525`; section 9 lists every reader.

Behavior change, stated: a DELETED primary or landlord of record is no longer
put on a default people list, named in an intro or reminder, or reported by the
diagnostics as "the landlord". Today a soft-deleted primary that still has a
phone IS put on the default list, provisioned onto the group and texted
(section 9.3); after P1 the default list resolves past it to the next live
candidate instead.

### P2. Auto-primary on add

When a contact is added to a property's roster and, after the write, NO roster
row is flagged primary, the added contact becomes the primary contact (flag and
scalar, in the same conditional write). Properties with a landlord of record
already have a primary (the derived landlord row), so nothing changes for them.

P2 promotes only a LIVE added contact (the add route already reads the
contact, `routes/units.ts:1097`). It reads the FLAG, not the flagged contact's
liveness: a property whose flagged primary is a deleted contact is repaired by
P3-on-delete going forward and by the script (section 8) for existing data, not
by the next add.

P2 also closes an existing API-only hole: `addContact` sets the flag from the
input (`unitsRepo.ts:794,800`), so re-adding the CURRENT primary without
`primaryContact` demotes it to zero primaries and leaves the scalar stale
(`:821-824`). After P2 that write ends with the re-added contact primary again.

Making a DELETED contact primary through the API (`primaryContact: true` on a
soft-deleted or missing contact) is refused with 409 `primary_contact_deleted`.
The dashboard already offers live contacts only (`ListingDetail.tsx:367`); this
makes the API agree. Adding a deleted contact as a NON-primary row stays
allowed (caseworker-integrity deliberately dropped a deleted-contact refusal on
this route; this spec does not reopen that).

### P2b. The scalar is no longer client-writable

`primary_contact` is accepted on unit create and PATCH today
(`lib/unitFields.ts:104`) with no check against the roster, so an API caller can
set a scalar that disagrees with the flags. No dashboard caller sends it
(`UnitCreateForm.tsx:192,245`, `ListingEditForm.tsx:150-231`). It becomes
server-owned: dropped from the writable field set, so a body carrying it is
refused like any other non-writable key. Only the roster writes set it.

### P3. Handoff when the primary goes away

One handoff implementation, used by every path that can take the primary away:

1. the landlord of record, if live AND it has a roster row;
2. else the earliest-added remaining LIVE roster contact;
3. else no primary (flag cleared on every row, scalar REMOVEd - today's
   behavior).

Step 1's "has a roster row" fixes an existing disagreement: after a PATCH
reassigns `landlordId` (API-only; there is no UI for it) the new landlord is not
on the stored roster, and today's `removeContact` then clears every flag but
sets the scalar to the new `landlordId` (`unitsRepo.ts:898-905`) - flag and
scalar disagree. After this change step 1 is skipped for an off-roster landlord
and step 2 decides.

Paths:

- **Remove from the property** (Contacts card Remove; `DELETE
  /api/units/:unitId/contacts/:contactId`): today step 1 or 3 only; step 2 is
  new. The confirm notice names the heir; see section 7.3.
- **Delete the contact** (contact page Delete; `DELETE /api/contacts/:id`):
  after the soft delete persists, every property (live and soft-deleted) whose
  primary is this contact runs the handoff. The deleted contact STAYS on the
  roster (a removed-contact row, as today); only the flag moves. Best-effort,
  in-request, after the delete is saved - the same posture as the delete's
  existing presence fan-out (`routes/contacts.ts:2297-2339`): a failure is
  logged with the unit id and never turns a successful delete into a 500. A
  miss is covered by P1 (the deleted primary is skipped anyway), the property
  warning (section 7.4) and the script (section 8). Finding the properties is
  one Scan of the units table - there is no roster index; the caseworker
  conversion already accepts the same Scan (`caseworkerConversion.ts:243`).
- **Restore a contact**: no roster change. A restored contact who lost the
  primary does not get it back.
- **Caseworker-integrity's landlord-clearing restore** (`restoreWithLandlord`
  with `next: null`, on that branch): it removes the landlord's row and clears
  a `primary_contact` that pointed at them. Once that code is on `main`, it
  runs the handoff instead of leaving no primary. The plan pins the exact call
  site against the merged code.

### P4. Invariants after this change

- At most one primary row; the scalar equals the primary row's contactId or is
  absent (unchanged).
- A property with at least one live roster contact has a primary after any
  add, remove, contact delete or landlord-clearing restore. Zero primary
  remains legal for a property with no live roster contact, and for legacy
  data until the script runs.
- The landlord of record is still immovable and still `role: 'landlord'`.

## 5. The intro fallback reasons (server)

### 5.1 Reasons

`resolveRelayComposeInputs` keeps its signature and its never-throw contract;
its result (`RelayComposeInputs`) gains an `introFallback` field, present
exactly when an OWNED conversation (tour or placement) resolves to the general
intro:

```
introFallback?: {
  reasons: IntroFallbackReason[];   // every reason that applies, in this order
  unitId?: string;                  // the property, when known
  street?: string;                  // formatStreet(unit.address), when non-empty
  propertyContactId?: string;       // set with property_contact_no_first_name
}

type IntroFallbackReason =
  | 'no_property_contact'           // P1 found nobody: no primary, no landlord
  | 'property_contact_deleted'      // P1 found nobody: candidates were deleted
  | 'property_contact_is_tenant'    // P1 found nobody: the candidate is the tenant
  | 'property_contact_no_first_name'// P1 found a contact without a first name
  | 'no_street_address'             // formatStreet(unit.address) is empty
  | 'tour_not_scheduled'            // tour only: no scheduledAt
  | 'tour_started'                  // tour only: scheduledAt <= now
  | 'lookup_failed';                // a read threw / owner or unit missing /
                                    // time unformattable / settings unreadable
```

Rules:

- ALL property-side and time-side checks are evaluated; the resolver no longer
  stops at the first miss when building reasons. The variant chosen is
  unchanged: any reason means `naked`.
- `lookup_failed` stands alone when the owner or unit read fails (the other
  checks have nothing to read). A failed CONTACT or SETTINGS read adds
  `lookup_failed` beside the reasons that could still be decided.
- Placements never carry the two tour reasons.
- An ownerless conversation (`owner.type === null`, the inbox Create group
  path) never carries `introFallback`: the general intro is its only intro.
- The member-added path (`resolveRelayComposeInputs(..., addedContactId)`)
  ignores `introFallback`.

### 5.2 Where it travels

- `RosterPreview` (app `services/rosterEdits.ts:339`, dashboard
  `api/types.ts:1267`) gains `introFallback?` with the shape above. Set by the
  tour and placement OPEN previews (`buildOpenPreview`); never by the
  standalone preview or the add-member preview.
- The relay intro JOB logs one INFO line when it sends the general intro on an
  owned conversation: ids and reason codes only, never names or the street
  (`relay intro: general intro used`, `{ conversationId, ownerType, ownerId,
  reasons }`). This is observability only; no behavior depends on it.

## 6. Unchanged on purpose

- An operator-edited intro (`intro_body`) still sends verbatim (precedence 1).
- The preview still resolves at preview time and the send at send time; a
  quiet-hours deferral can legitimately change the variant between them
  (`rosterEdits.ts:581-586`). The box describes the preview.

## 7. Dashboard

### 7.1 Open-group dialog: the fallback box (layout A, chosen 2026-10-12)

`RosterConfirmDialog` renders an amber box ABOVE the message when
`preview.introFallback` is present. It reuses the existing duplicate-warning
style (`RosterConfirmDialog.module.css` `.duplicateWarning`: `--c-warning`
border, not danger). `role="status"`. Mockup:
`docs/superpowers/reviews/2026-10-12-primary-contact-integrity/mockups/dialog-notice.html`
(option A).

Heading line (bold): "Using the general intro, not the tour intro." for a tour;
"Using the general intro, not the placement intro." for a placement.

Then one line per reason, in reason order. `<Street>` is
`introFallback.street`, else "This property".

| reason | line | link (opens in a NEW TAB) |
|---|---|---|
| no_property_contact | "<Street> has no primary contact, so the intro can't name the landlord." | "Set a primary contact" -> `/listings/<unitId>` |
| property_contact_deleted | "<Street>'s primary contact was deleted, so the intro can't name the landlord." | "Set a primary contact" -> `/listings/<unitId>` |
| property_contact_is_tenant | "<Street>'s primary contact is this tenant, so the intro can't name a landlord." | "Set a primary contact" -> `/listings/<unitId>` |
| property_contact_no_first_name | "The primary contact has no first name saved." | "Add a first name" -> `/contacts/<propertyContactId>` |
| no_street_address | "This property has no street address." | "Add the address" -> `/listings/<unitId>` |
| tour_not_scheduled | "This tour has no date and time yet." | none |
| tour_started | "This tour's start time has passed. The tour intro asks the tenant to say when they're on the way." | none |
| lookup_failed | "The property details couldn't be loaded." | none |

A link is omitted when its id is absent. Links open in a new tab for the same
reason the duplicate warning's does (`RosterConfirmDialog.tsx:257-259`):
navigating away would discard the half-built group.

Last line: a **Check again** button (secondary, small). It re-fetches the
preview through the caller (new optional prop `onCheckAgain: () =>
Promise<void>`; the tour and placement callers re-run their preview fetch and
replace the preview they pass in). While it runs the button is disabled; a
failure renders in the dialog's existing error line. A 409
`relay_already_provisioned` on the re-fetch closes the dialog and refetches the
roster, exactly as the first fetch does (`TourDetail.tsx:451-452`).

### 7.2 The edited-draft rule

Today the dialog re-seeds its editable draft whenever `preview.body` changes
(`RosterConfirmDialog.tsx:111-114`), which would overwrite Sam's edits on a
Check again that changes the intro. New rule:

- The dialog remembers the body the draft was seeded from.
- On a new preview: if the draft still equals that seed (unedited), replace the
  draft and the seed with the new body. If it was edited, KEEP the draft and
  show, under the message box, "The intro changed. Use the updated intro"
  where "Use the updated intro" is a button that replaces the draft and seed.
- What is sent is unchanged in principle: an edited draft (different from the
  CURRENT preview body) posts `introBody`; an unedited one posts nothing.

### 7.3 Removing the primary: the confirm notice

`promotionNotice` (`ListingDetail.tsx:471-479`) names the heir that P3 will
pick, from a server-computed field (section 7.5), never a client-side copy of
the rule:

- heir present: "<Heir name> becomes the primary contact - new tours and relay
  groups for this property will use them." (the existing sentence's shape,
  with "calls and" dropped because the scalar drives no live call routing -
  see 2 Non-goals; the plan confirms the wording against the tree).
- no heir: "This property will have no primary contact. New tours won't
  include a landlord, and tour group texts will use the general intro."

### 7.4 Property page: the no-primary box (layout A, chosen 2026-10-12)

On the Contacts card (`ListingDetail.tsx` around line 854), ABOVE the rows,
when the property contact (P1, tenant-less) is nobody AND the roster has at
least one row. Amber box, same style as 7.1. Mockup:
`docs/superpowers/reviews/2026-10-12-primary-contact-integrity/mockups/property-warning.html`
(option A).

- Line 1 (bold lead): "No primary contact." followed by "New tours won't
  include the landlord, and tour group texts use the general intro."
  When the reason is `deleted`: "The primary contact was deleted." with the
  same follow-on.
- Action:
  - exactly ONE live roster contact: button "Make <Name> primary" - the same
    write as the edit-mode "Make primary" (`onMakePrimaryContact`,
    `ListingDetail.tsx:437`).
  - two or more live roster contacts: button "Choose a primary" - enters the
    card's edit mode, where each row already has "Make primary".
  - zero live roster contacts (every row is a deleted contact): no button;
    the line reads "Add a contact and make them primary."
- Not shown on a soft-deleted property (the card is read-only there).
- Zero roster rows: no box. The existing empty state "No contacts on this
  property yet." gains a second sentence: "Tours need a primary contact."
- Each roster row whose contact is deleted shows "(deleted)" after the name in
  both view and edit modes.

### 7.5 Payload additions for the property page

The unit responses that carry the enriched roster (`enrichRoster`,
`routes/units.ts:384`) gain:

- per row: `deleted: true` when the row's contact is soft-deleted or missing
  (absent otherwise);
- on the unit: `propertyContactId: string | null` (P1, no tenant) and
  `primaryHeirContactId: string | null` (who P3 would pick if the current
  primary were removed; null when there is no primary or no heir).

Both are computed by the same server functions as P1 and P3, so the dashboard
never re-derives either rule.

## 8. Existing data: the one-time script

`app/scripts/assign-primary-contacts.ts`, following the
`app/scripts/clean-org-names.ts` pattern (`--env dev|prod`, dry run by default,
`--apply` to write, lock, conditional writes, audit, documented exit codes,
PII-free output).

- Reads every unit (live and soft-deleted) and the contacts its rosters name.
- A unit is a TARGET when its property contact (P1, no tenant) is nobody AND it
  has at least one live roster contact.
- For each target it picks the heir by P3 steps 1-2 and makes it primary
  through the same write path as "Make primary" (conditional on the roster
  being unchanged since the read; a changed unit is counted
  `skippedOnCondition` and left for a re-run).
- Each write appends a `unit_primary_contact_assigned` audit event
  `{ contactId, reason: 'backfill' }`; P2 and P3 writes append the same event
  with `reason: 'auto_on_add' | 'handoff_on_remove' | 'handoff_on_delete' |
  'handoff_on_restore'` so the property's Activity tab explains every primary
  change nobody clicked. (The plan confirms the Activity rendering seam.)
- Dry run prints: target count, live vs soft-deleted units, per-reason counts
  (`none` / `deleted`), and unit ids only - never a person's name.
- Idempotent: a completed apply plans nothing on a re-run.
- RUNBOOK section owed with the deploy: run dry, then `--apply`, on dev and
  then prod, after that environment's deploy.

## 9. Surfaces (mutation and read)

From a whole-repo sweep on `main` @19607658. Line numbers drift; the plan
re-anchors every row against the post-caseworker `main` (section 11), and any
surface it finds that is not here is added to the plan as a task or a watch
item.

### 9.1 Mutation surfaces of the primary contact / landlord of record / roster

| surface | today | after this spec |
|---|---|---|
| `POST /api/units` (`routes/units.ts:464-514`, repo `create` `unitsRepo.ts:581-609`) | sets `landlordId`; accepts `primary_contact` unchecked | landlord row derived primary (unchanged); `primary_contact` refused (P2b) |
| `PATCH /api/units/:id` (`units.ts:1376-1491`, repo `update` `:662-708`) | can reassign `landlordId` and set `primary_contact`, no roster sync | `primary_contact` refused (P2b); `landlordId` reassign UNCHANGED (API-only, no UI; caseworker-integrity owns its type check) - P3 step 1 tolerates the off-roster landlord |
| `POST /api/units/:id/contacts` (`units.ts:1061-1137`, repo `addContact` `:754-863`) | flag from input; can demote to zero; scalar can go stale | P2 auto-primary; 409 `primary_contact_deleted` |
| `DELETE /api/units/:id/contacts/:cid` (`units.ts:1143-1172`, repo `removeContact` `:865-941`) | landlord heir or none | P3 |
| `DELETE /api/contacts/:id` (`routes/contacts.ts:2228-2347`) | touches no unit | P3 fan-out (section 4) |
| `POST /api/contacts/:id/restore` (`contacts.ts:2352-2374`) | touches no unit | unchanged (stated in P3) |
| `DELETE` / `POST restore` on a unit (`units.ts:1497-1532`) | `deleted_at` only | unchanged on `main`; caseworker-integrity's `restoreWithLandlord(next: null)` runs P3 once merged |
| importer `upsertUnit` (`lib/import/apply.ts:1411-1556`) | `landlordId` on an exact match only, never a roster | unchanged (non-goal); the script (section 8) repairs its output |
| importer `retractImported` (`apply.ts:316-328`, `:769-775`) | hard-deletes contacts, leaves roster/landlord ids dangling | unchanged; P1 treats a missing contact as deleted |
| dashboard callers (`ListingDetail.tsx:425-489`, `endpoints.ts:969-1070`) | re-role sends the current flag; make-primary; add sends `false` | unchanged requests; new box and notice (7.3, 7.4) |
| seeds: lean (`lean.ts:206-254`), full (`cast.ts`, `matrix.ts`, `live.ts`) | `landlordId` only, except the PM unit (`cast.ts:1344-1368`, explicit roster, PM primary) | UNCHANGED - lean stays byte-stable |
| performance seed (`performance.ts:582-611`) | primary = landlord, and every 7th landlord contact is soft-deleted (`:578`) | unchanged; after P1 those units resolve to NO property contact - perf-page behavior on them shifts, by design |
| dev seams (`routes/dev.ts`) | reseed / performance reseed / org fixture | NEW dev-only seam for the e2e zero-primary state (section 10) |

### 9.2 Readers of "the property's contact"

Every reader below moves onto P1 unless marked otherwise.

- The four ladder copies: `lib/tourContacts.ts:124-139` (names for tour
  reminder and relay copy), `lib/rosterResolution.ts:292-301` (default people
  list = membership), `services/rosterProvision.ts:232-247` and `:524-535`
  (the "cannot open a group" diagnostics - their text keeps its codes; the
  plan decides whether "landlord" in `unresolvable` strings changes, which is
  operator-facing only).
- Through `resolveTourContactNames`: `jobs/tourReminders.ts:943`
  (reminder bodies, all three send paths), `routes/tourReminders.ts:264`
  (reminder previews, PATCH, send-now, GET), `routes/relayGroups.ts:253`
  (scheduled previews), `routes/contactTimeline.ts:1077` (timeline scheduled
  bodies), `jobs/relayFanOut.ts:524` (intro + member-added copy, job and
  preview).
- Through `resolveRoster`'s default: `describeRoster` (People card, the
  `customized` flag and `defaultPrimaryName`, `rosterResolution.ts:477-610`),
  `applyRosterPlanEdit` materializing the default into a plan
  (`rosterEdits.ts:273`), the open and add previews (`rosterEdits.ts:554,728`),
  provisioning (`rosterProvision.ts:202,576,618`), deferred actions
  (`jobs/rosterActions.ts:321`), the reminder/nudge tenant gates
  (`tourReminders.ts:1006`, `placementNudges.ts:487`).
- The property page: `enrichRoster` (`routes/units.ts:384-411`) gains the
  section 7.5 fields; `listingRoster` (`dashboard/.../buildListingFile.ts:49-87`)
  and `ListingDetail.tsx:285-291,471-479,888,951` render them.

UNCHANGED on purpose - these mean the landlord of RECORD (the owner), not the
property contact:

- `jobs/placementNudges.ts:422-444` (landlord-rung nudge recipient) and
  `routes/placementNudges.ts:231-248`;
- `lib/personEvents.ts:99-105,165-178` (dual-party milestones);
- related properties / landlord timelines (`units.ts:1202`,
  `contactTimeline.ts:1222,1428`);
- dashboard landlord tabs and labels (`TourDetail.tsx:201-256`,
  `useTour.ts:94-98`, `PlacementDetail.tsx:185-296`,
  `PlacementNowCard.tsx:114-118`).

The `primary_contact` scalar has NO runtime reader (only writes, comments and
a dashboard type, `types.ts:2506`). Its stale comments that claim the masked
call dials it (`unitsRepo.ts:815-820`, `conversationsRepo.ts:207`) are
corrected in the same change.

### 9.3 Filed, not fixed here

The sweep found that a soft-deleted contact on a tour or placement people list
is still PROVISIONED onto the relay thread and texted:
`provisionMembersOf` (`rosterProvision.ts:106-121`) keeps every phone-bearing
member, `memberFromContact` (`rosterResolution.ts:181-200`) never checks
`deleted_at`, `describeRoster` counts the member reachable
(`:550-555`) although it labels it `removed_contact`, and the fan-out
suppression checks only `sms_opt_out` (`relayAnnouncements.ts:64-73`). The
docblock at `rosterResolution.ts:174-180` claims the opposite. P1 removes the
property-contact route into this; a member added by hand and deleted later is
a separate defect, filed as
`docs/issues/relay-provision-includes-deleted-contacts.md`.

## 10. Testing

- App unit tests: P1 (every ladder leg, deleted primary, deleted landlord,
  tenant de-dupe, read failure); P2 (no primary -> added becomes primary; a
  primary exists -> untouched; landlord-of-record property untouched); P3 for
  each path (landlord heir, earliest live heir, deleted contacts skipped, no
  heir); the delete fan-out (primary on two properties, one write failing does
  not fail the delete); the reasons (each reason alone, combinations, the
  all-reasons ordering, placement exclusions, ownerless absence, never-throw).
- App API tests: the unit payload fields (7.5); the preview `introFallback`;
  the contact DELETE handoff.
- Dashboard tests: the dialog box (each reason's line and link, new-tab
  target, Check again, the edited-draft rule both ways, absent for
  standalone), the property box (each action variant, deleted rows, empty
  state), the confirm notice (heir / no heir).
- Script tests: target selection, dry run writes nothing, apply idempotence,
  conditional skip.
- E2E: the zero-primary state cannot be reached through the UI (property
  create requires a landlord), and the byte-stable lean seed has none on
  purpose (`docs/issues/tour-reminder-zero-primary-e2e-gap.md` item 1). A new
  DEV-ONLY seam (hermetic-only, structurally absent in deployed envs like
  `/__dev/reseed`) puts one property into the imported shape - no landlord of
  record, one non-primary contact - for a spec. Specs: (a) the property box and
  "Make <Name> primary"; (b) a tour on that property: the open-group dialog box,
  Check again after fixing the property in another tab flips the preview to
  the tour intro; (c) removing a primary with no landlord hands off to the
  remaining contact. This closes item 1 of that issue.

## 11. Sequencing with fix/caseworker-integrity

`fix/caseworker-integrity` (slice S4) rewrites the same surfaces: the property
contact-list add route's checks (`routes/units.ts:1061`), unit restore and its
new `restoreWithLandlord`, and `ListingDetail.tsx`'s roster writes and Add
contact picker. Decision (Cameron, 2026-10-12): this spec and its review run
now; the PLAN is written against `main` after that branch merges, and the build
is cut from that `main`. P3's restore path (section 4) depends on it.

## 12. Docs and issues

- GLOSSARY: add **property contact**; update **primary contact** (zero primary
  is now self-healing except for legacy data; the handoff rule).
- RUNBOOK: the script section (section 8), owed with the deploy.
- `docs/issues/tour-reminder-zero-primary-e2e-gap.md`: item 1 resolved.
- Records: `docs/superpowers/reviews/2026-10-12-primary-contact-integrity/`.

## 13. Post-merge operator actions (known now)

- After each environment's deploy: run `assign-primary-contacts.ts` dry, then
  `--apply` (dev, then prod). Until it runs, existing no-primary properties
  show the property box and Sam can fix them by hand.
- No Terraform, no secrets, no table or index change.
