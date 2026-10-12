# Primary contact integrity and the intro fallback explanation - design

Date: 2026-10-12. Status: DRAFT rev 3 (design review rounds 1-2 folded in;
adjudications at
`docs/superpowers/reviews/2026-10-12-primary-contact-integrity/design-review/adjudications.md`).
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
  property. A deleted primary stays primary and nobody replaces it. Worse, a
  soft-deleted primary that still has a phone is put on the default people
  list, PROVISIONED onto the relay group and texted, and the intro and reminder
  copy still NAME it: `contactsRepo.getById` returns soft-deleted contacts,
  `memberFromContact` keeps their phone (`rosterResolution.ts:181-200`, despite
  its docblock at `:174-180`), and `lib/tourContacts.ts` never checks
  `deleted_at`.

## 2. Goals and non-goals

Goals:

- G1. A property with at least one live contact has a live primary contact
  after every write in this app that sets or moves the primary - best effort,
  with the gaps named in P4 and backstopped by G2-G5.
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
- The importer's landlord matching (`apply.ts:1506`) and its contact
  retraction (`apply.ts:316-328`). An imported property without a landlord is a
  legitimate state; G1-G5 make it usable.
- A deleted contact added BY HAND to a tour or placement people list - filed
  separately (section 9.3).
- The unbuilt business-number masked-call path
  (`routes/webhooks/voice.ts:627`, `docs/issues/voice-business-number-roster.md`):
  the `primary_contact` scalar drives no live call routing today. It is kept
  consistent (section 4) so that path inherits correct data when built.

## 3. Definitions

- **live contact**: a contact record that exists and has no `deleted_at`
  (`isDeleted` false). A roster or landlord id that names NO record (the
  importer's `retractImported` hard-deletes contacts without touching units,
  `apply.ts:316-328`, `:769-775`) is treated exactly like a deleted contact.
- **unknown liveness**: a contact whose read THREW or came back unprocessed.
  Never treated as deleted or missing (section 4.2).
- **primary contact**: unchanged meaning (GLOSSARY) - the roster row flagged
  `UnitContact.primaryContact`. The FLAG is the truth. The unit scalar
  `primary_contact` is written only by the roster writes, and only when a
  stored primary exists (`unitsRepo.ts:821-824`); it is ABSENT on every
  landlord-only unit, whose primary is the DERIVED landlord row
  (`unitContacts()`, `unitsRepo.ts:296-303`). Code that needs "who is primary"
  reads `unitContacts(unit)`, never the scalar.
- **landlord of record**: unchanged - `unit.landlordId`. It normally has a
  roster row (`role: 'landlord'`); it can lack one after an API PATCH reassign
  or an importer re-import (section 9.1).
- **property contact** (NEW term): who the app actually uses for a property,
  computed by the shared lookup (P1). It is what the tour and placement default
  people lists, the relay intros, the tour reminders and the "cannot open a
  group" diagnostics use.
- **earliest-added**: roster array order. `addContact` appends, and
  `unitContacts()` derives the legacy landlord row first, so array order is
  add order.
- **heir**: the contact the heir function (4.3) picks to become primary.

## 4. Rules

### 4.1 P1 - one shared property-contact lookup

A single function (new module `app/src/lib/propertyContact.ts`) answers "who is
this property's contact, given this tenant". It walks the candidates in order:

1. the flagged primary row's contact (from `unitContacts(unit)`), if any;
2. the landlord of record, if `landlordId` is non-empty and differs from
   candidate 1.

For each candidate in turn, in this order (the tenant test is an id
comparison made BEFORE any read, as today):

- the candidate IS the given tenant -> STOP: nobody, reason `is_tenant`.
  Today's semantics, kept: a primary who is the tenant yields no property
  contact, with no fall-through to the landlord (`tourContacts.ts:129-139`,
  `rosterResolution.ts:293-301`).
- the read THROWS -> STOP: `{ readFailed: true, candidateId }`. A thrown read
  is not absence: the walk does not fall through. This preserves the
  reminders' fail-closed rule (`jobs/tourReminders.ts:960-963`,
  `ReminderNamesUnavailableError`) and lets the default people list keep
  today's bare `{ contactId }` row for that candidate
  (`rosterResolution.ts:181-190`), so a materialized plan never silently
  loses the property contact (`rosterEdits.ts:271-283`).
- the contact is deleted or missing -> SKIP to the next candidate.
- otherwise -> FOUND: `{ contact, contactId }`.

Walk exhausted: nobody, reason `deleted` if at least one candidate was skipped
as deleted/missing, else `none` (there were no candidates). It never throws.

Every reader of the primary-then-landlord ladder moves onto P1 (section 9.2
lists them). The diagnostics in `services/rosterProvision.ts:232-247` and
`:524-535` keep their codes and their texts for the state each text describes
today, and the API tests that assert those texts verbatim keep passing:
reason `none` -> today's "no landlord" text; reason `deleted` -> today's
"contact not found" text (a deleted contact now reads like a missing one);
reason `is_tenant` -> whatever today's code yields when the candidate is the
tenant; a read failure -> today's thrown-read behavior. The placement
diagnostic has a single unreachable code (`landlord_unreachable`) and keeps it
for every nobody outcome. The plan pins each string against the tests.

Behavior change, stated: a DELETED primary or landlord of record is no longer
put on a default people list (so no longer provisioned and texted), named in an
intro or reminder, or reported by the diagnostics as "the landlord". The walk
resolves past it to the next live candidate.

### 4.2 Liveness reads for writes

Every write that picks an heir (P2, P3, the script, the 7.5 heir field) needs
the liveness of the landlord of record and of every roster contact. Contract:

- ONE batch read of those ids (the roster's contact ids AND `landlordId`) with
  `requireComplete` (`contactsRepo.getManyByIds`, `contactsRepo.ts:940-997`);
  its default is best-effort and silently drops unprocessed keys, which would
  read as "missing" - not allowed here.
- The read happens BEFORE the conditional roster write, and is REFRESHED on
  every retry of that write (the retry re-reads the unit, whose roster may have
  gained rows). Unit reads on these paths are strongly consistent.
- A contact this request has just deleted is NEVER read for liveness: the
  batch read is eventually consistent (`contactsRepo.ts:979`, no
  `ConsistentRead`) and could return it as live. The delete fan-out passes it
  as the heir function's EXCLUDED contact (4.3), which counts as not live.
- A failed or incomplete read means liveness UNKNOWN. Each path says what it
  does then (P2, P3, section 8). An unknown candidate is never skipped as
  deleted.
- Accepted race, stated: a contact deleted between the liveness read and the
  roster write can still be made primary. The deleting request's own fan-out
  (P3) catches it if its Scan reads the unit after that write; otherwise P1
  skips it, the property box shows it, and the script repairs it.

### 4.3 The heir function

ONE pure function (no I/O; inputs: the unit's `unitContacts()` roster, its
`landlordId`, an optional contact to exclude, and the liveness map) used by the
real repo AND by the API-test fake (`app/test/helpers/twilioWebhookHarness.ts`
`addContact` / `removeContact`, `:2940-3017`), so the two cannot drift:

1. the landlord of record, if live and not the excluded contact. If the
   landlord has no roster row, the result says so and the write ADDS their row
   (`role: 'landlord'`) as primary;
2. else the earliest-added LIVE roster contact that is not the excluded one;
3. else no heir.

The excluded contact counts as not live at EVERY step, whatever the liveness
map says - so `heirIfPrimaryRemoved` (7.5) on a unit whose landlord is the
primary never names the landlord, and the delete fan-out never picks the
contact it just deleted.

Liveness unknown for any candidate the function would need to decide on ->
the result is `unknown` (the caller's path rule applies).

### 4.4 P2 - auto-primary on add

When a contact is added to (or upserted on) a property's roster and, after
the write, there is NO LIVE flagged primary - no row is flagged, or the flagged
row's contact is deleted or missing - the write runs the heir function over
the resulting roster (the added row included; a deleted flagged primary is
not live, so it cannot be its own heir). Every add therefore does the 4.2
liveness read. The "deleted flagged primary" case matters because the delete
handoff leaves the flag on a deleted contact when it had no heir (4.6):
"delete Mark, then add his replacement" must promote the replacement, exactly
as "add the replacement, then delete Mark" does.

- heir -> that contact is flagged primary and the scalar set, in the same
  conditional write;
- no heir -> the scalar is REMOVEd if present (today `addContact` can leave a
  stale scalar after a demotion, `unitsRepo.ts:815-824`);
- unknown -> the add still succeeds without a promotion, with a WARN log; the
  property box (7.4) and the script (section 8) are the backstop.

In the 470 Bolton case (no landlord, Mark the only contact) the heir is Mark.
Properties whose landlord-of-record row is flagged primary are untouched. The
re-add of the CURRENT primary without `primaryContact` (an API-only demotion to
zero, `unitsRepo.ts:794,800`) now ends with the heir primary again.

Making a contact primary that is NOT already primary, when that contact is
soft-deleted, is refused with 409 `primary_contact_deleted`. A missing contact
cannot reach this: the route answers 404 `contact_not_found` first
(`routes/units.ts:1097-1100`). Re-sending `primaryContact: true` for a row that
is ALREADY primary (the dashboard's re-role sends the row's current flag,
`ListingDetail.tsx:425-433`) is allowed even if that contact is deleted - it
changes nothing. Order: after the 404 and after caseworker-integrity's type
checks on this route (the plan pins it against the merged code). Adding a
deleted contact as a NON-primary row stays allowed (caseworker-integrity
deliberately dropped a deleted-contact refusal here; not reopened).

### 4.5 P2b - the scalar is no longer client-writable

`primary_contact` is accepted on unit create and PATCH today
(`lib/unitFields.ts:104`) with no check against the roster. No dashboard caller
sends it (`UnitCreateForm.tsx:192,245`, `ListingEditForm.tsx:150-231`). It is
dropped from the writable field set, so a body carrying it is refused like any
other non-writable key. Only the roster writes set it.

### 4.6 P3 - handoff when the primary goes away

Paths (all through the heir function, 4.3):

- **Remove from the property** (Contacts card Remove; `DELETE
  /api/units/:unitId/contacts/:contactId`) of the PRIMARY row: heir (excluding
  the removed contact) -> flagged primary; no heir -> flag cleared on every
  row, scalar REMOVEd (today's behavior); unknown -> the removal is REFUSED
  with 503 `roster_read_failed` and nothing is written (the dashboard shows
  "Couldn't check the other contacts - try again."). Removing a non-primary row
  needs no liveness and is unchanged.
- **Delete the contact** (contact page Delete; `DELETE /api/contacts/:id`):
  after the soft delete persists, ONE strongly consistent Scan of the units
  table (`ConsistentRead`; today's `unitsRepo.list` Scan is eventually
  consistent, `unitsRepo.ts:1026-1043`; live and soft-deleted units; there is
  no roster index - `caseworkerConversion.ts:243` accepts the same Scan; one or
  two pages at today's few hundred units) finds every unit whose
  `unitContacts()` primary is this contact. For each, with the deleted contact
  EXCLUDED (4.3): heir -> the flag (and scalar) MOVES to the heir; no heir ->
  NOTHING changes (the deleted contact stays flagged; P1 skips it, the property
  box says so, and the next add promotes, 4.4); unknown -> that unit is skipped
  with a WARN log. A conditional-write failure (the unit changed since the
  Scan) re-reads that unit consistently and re-decides, with the same bounded
  retries as the roster writes; only exhausting them logs and skips. The
  deleted contact stays on the roster as a row. Best-effort and in-request,
  after the delete is saved -
  the posture of the delete's existing presence fan-out
  (`routes/contacts.ts:2297-2339`): a failure is logged with the unit id and
  never turns a successful delete into a 500.
  Because "no heir" changes nothing, deleting and then restoring a property's
  only contact leaves the property exactly as it was.
- **Restore a contact**: no roster change. A contact whose primary moved to a
  live heir does not get it back (the Delete dialog says so, 7.6).
- **caseworker-integrity's restores** (once on `main`): the landlord-CLEARING
  restore (`restoreWithLandlord` with `next: null`) removes the landlord row;
  if that row was primary it runs the remove rule above (heir / clear; unknown
  -> refuse). The landlord SWAP (`next: <id>`), when the old landlord was
  primary, re-runs the heir function after the swap instead of flagging the
  new landlord unconditionally - so a soft-deleted new landlord is not made
  primary. That branch's tests that assert "no primary after a clear" change
  where an heir exists; the plan updates them.

### 4.7 P4 - what holds afterwards

- At most one primary row (unchanged). Every write that sets or moves the
  primary sets the scalar to it or REMOVEs it; a legacy scalar that disagrees
  with a live flagged primary is aligned by the script (section 8). Nothing
  reads the scalar at runtime.
- After an add, a remove, a landlord-clearing restore, or a landlord swap, a
  unit with at least one live roster contact (or a live landlord of record) has
  a LIVE primary - unless liveness was unknown (add proceeds without promotion;
  remove and restore refuse).
- After a contact delete, every unit whose primary was that contact and that
  has a live heir has moved to it - best effort (a failed unit is logged).
- Known gaps, by design: the importer's hard-delete retraction and the API
  PATCH reassign leave rosters as they are; P1, the property box and the script
  cover what they leave.
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
  | 'no_property_contact'           // P1: nobody, reason none
  | 'property_contact_deleted'      // P1: nobody, reason deleted
  | 'property_contact_is_tenant'    // P1: nobody, reason is_tenant
  | 'property_contact_no_first_name'// P1 found a contact without a first name
  | 'no_street_address'             // formatStreet(unit.address) is empty
  | 'tour_not_scheduled'            // tour only: no scheduledAt
  | 'tour_started'                  // tour only: scheduledAt <= now
  | 'lookup_failed';                // see the rules below
```

Rules:

- When the OWNER read fails (or returns nothing), nothing else can be
  decided: `reasons` is `['lookup_failed']` alone. When the UNIT read fails,
  the tour reasons are still decidable (the tour is read first,
  `relayFanOut.ts:457-503` before `:505-510`): `reasons` is `lookup_failed`
  plus any tour reason that applies.
- Otherwise every check is evaluated - the resolver no longer stops at the
  first miss when building reasons - and `lookup_failed` is ADDED beside the
  decided reasons when P1 reports `readFailed`, the settings read fails, or
  the tour time cannot be formatted. The variant chosen is unchanged: any
  reason means `naked`.
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
  reasons }`). Observability only.

## 6. Unchanged on purpose

- An operator-edited intro (`intro_body`) still sends verbatim (precedence 1).
- The preview resolves at preview time and the send at send time; a
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
`introFallback.street`, else "this property" (sentence-initial: "This
property").

| reason | line | link (opens in a NEW TAB) |
|---|---|---|
| no_property_contact | "<Street> has no primary contact, so the intro can't name the landlord." | "Set a primary contact" -> `/listings/<unitId>` |
| property_contact_deleted | "The contact on file for <street> was deleted, so the intro can't name the landlord." | "Set a primary contact" -> `/listings/<unitId>` |
| property_contact_is_tenant | "The contact on file for <street> is this tenant, so the intro can't name a landlord." | "Set a primary contact" -> `/listings/<unitId>` |
| property_contact_no_first_name | "The contact on file for <street> has no first name saved." | "Add a first name" -> `/contacts/<propertyContactId>` |
| no_street_address | "This property has no street address." | "Add the address" -> `/listings/<unitId>` |
| tour_not_scheduled | "This tour has no date and time yet." | none |
| tour_started | "This tour's start time has passed. The tour intro asks the tenant to say when they're on the way." | none |
| lookup_failed | "Some property details couldn't be loaded." | none |

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
  show, under the message box, "The intro changed." with a "Use the updated
  intro" button that replaces the draft and the seed.
- What is sent is unchanged in principle: a draft that differs from the
  CURRENT preview body posts `introBody`; one equal to it posts nothing.

### 7.3 Removing the primary: the confirm notice

`promotionNotice` (`ListingDetail.tsx:471-479`) reads the heir from the
server's 7.5 block, never a client-side copy of the rule:

- heir present: "<Heir name> becomes the primary contact - new tours and relay
  groups for this property will use them." (the existing shape; "calls and" is
  dropped because the scalar drives no live call routing). The name comes from
  the 7.5 block, which carries it even for an off-roster landlord heir; with no
  name on record: "Another contact on this property becomes the primary
  contact."
- no heir: "This property will have no primary contact. New tours won't
  include a landlord, and tour group texts will use the general intro."
- block absent (liveness unknown): "Another contact on this property may
  become the primary contact."

A 503 `roster_read_failed` on the remove renders "Couldn't check the other
contacts - try again." in the row's existing error slot.

### 7.4 Property page: the no-primary box (layout A, chosen 2026-10-12)

On the Contacts card (`ListingDetail.tsx` around line 854), ABOVE the rows,
when the 7.5 block is PRESENT, its `contactId` is null, and the roster has at
least one row. Amber box, same style as 7.1. Mockup:
`docs/superpowers/reviews/2026-10-12-primary-contact-integrity/mockups/property-warning.html`
(option A).

- Lead (bold): "No primary contact." - or, when the block's reason is
  `deleted`, "This property's contact was deleted." (it may have been the
  primary or the landlord of record) - followed by "New tours won't include
  the landlord, and tour group texts use the general intro."
- Action:
  - exactly ONE live roster contact: button "Make <Name> primary" - the same
    write as the edit-mode "Make primary" (`onMakePrimaryContact`,
    `ListingDetail.tsx:437`).
  - two or more live roster contacts: button "Choose a primary" - enters the
    card's edit mode.
  - no live roster contact: no button; the line reads "Add a contact and make
    them primary."
- Not shown on a soft-deleted property (the card is read-only there), and not
  shown when the block is absent (could not tell).
- Zero roster rows: no box. The existing empty state "No contacts on this
  property yet." gains a second sentence: "Tours need a primary contact."
- Rows whose contact is deleted (`deleted: true`) show "(deleted)" after the
  name in view and edit modes, and get NO "Make primary" button in edit mode
  (`ListingDetail.tsx:918-928`). Their role select and Remove stay.
- The 409 `primary_contact_deleted` maps to its own copy in `runRosterWrite`'s
  conflict map ("That contact was deleted - restore them first or choose
  someone else."), not to the landlord-of-record catch-all
  (`ListingDetail.tsx:115-116,393-412`).
- The facts subline's landlord company (`ListingDetail.tsx:291`) skips deleted
  rows.

### 7.5 Payload additions for the property page

`enrichRoster` (`routes/units.ts:384-411`) reads the roster's contact ids AND
`landlordId` (an off-roster landlord must not read as missing) with
`requireComplete`. If that read is incomplete (`IncompleteBatchReadError`,
which carries no partial map), it falls back to today's best-effort read for
the names, so the rows degrade exactly as they do today. The unit responses
that carry the enriched roster (GET `/api/units/:id`, `units.ts:531`, and the
two roster writes, `:1136`, `:1171`) gain:

- per row: `deleted: true` when the row's contact is soft-deleted or missing
  (absent otherwise) - ONLY when the read was complete;
- on the unit, ONLY when the read was complete (absent = could not tell):

```
propertyContact?: {
  contactId: string | null;               // P1 with no tenant
  reason?: 'none' | 'deleted';            // when contactId is null
  heirIfPrimaryRemoved:                   // heir function excluding the primary
    { contactId: string; name?: string } | null;
}
```

`name` is the heir's display name, present even when the heir is an
off-roster landlord who has no row to take a name from.

When the read is incomplete the rows serve un-enriched exactly as today and
the block is absent; the dashboard then shows no box, no "(deleted)" marks and
the generic 7.3 notice.

The property page reads the rows and the block from the last ROSTER source
(the load-time GET or the latest roster write, `ListingDetail.tsx:285-287`).
Unit replacements that do not change the roster (PATCH from the edit form,
status changes, photo writes) keep those rows and that block. After either
unit restore (plain, and caseworker-integrity's landlord restore) the page
REFETCHES the unit, because a restore can run a handoff, and the refetched
unit BECOMES the roster source - it replaces the last roster-write response
(`rosterUnit`, which the Contacts card otherwise prefers,
`ListingDetail.tsx:285-287`), so a stale pre-restore roster cannot survive.

The tour and placement pages load the unit through the same GET
(`useTour.ts:90`, `PlacementDetail.tsx:185`): their People card suggestions
(`rosterSuggestions`, `dashboard/src/routes/shared/rosterPeople.ts:90-118`,
called at `TourDetail.tsx:230-241`, `PlacementDetail.tsx:260-274`) skip rows
with `deleted: true`, so a deleted contact is never offered for "+ Add" or
labeled "primary contact".

### 7.6 The contact Delete dialog

The Delete confirmation (`ContactDetail.tsx:1358-1362`) says "Nothing is
erased - you can restore them". For a contact whose type is not `tenant` it
gains one sentence: "If they're a property's primary contact, the landlord or
another contact on that property takes over, and restoring them won't change
that back." Known gap, accepted: a tenant-typed contact who is some property's
primary (a degenerate state) gets no sentence - the dialog cannot know without
the Scan.

## 8. Existing data: the one-time script

`app/scripts/assign-primary-contacts.ts`, following the
`app/scripts/clean-org-names.ts` pattern (`--env dev|prod`, dry run by default,
`--apply` to write, documented exit codes, PII-free output) WITHOUT a lock:
every write is conditional, so concurrent runs cannot double-write.

- Reads every unit (live and soft-deleted) with a consistent Scan and the
  contacts its rosters and landlords name (complete reads, 4.2).
- A unit is a TARGET when its flagged primary (`unitContacts()`) is absent OR
  not live, AND the heir function yields an heir. That covers 470 Bolton (no
  primary, one live contact) and a deleted primary next to a live landlord or
  another live contact.
- For each target the script writes with ITS OWN conditional write against
  the roster and `landlordId` it read (the `updateRosterIfCurrent` guard,
  `unitsRepo.ts:522-578`) - never through `addContact`, which re-reads and
  would overwrite a primary set meanwhile. A changed unit is counted
  `skippedOnCondition` and left for a re-run. The write flags the heir (adding
  the landlord row when the heir is an off-roster landlord) and sets the
  scalar.
- Counted, not written: `noHeir` (no live contact and no live landlord),
  `unknown` (a liveness read failed).
- Also aligned, with the same conditional write and no audit event (it is not
  a primary change): a unit whose flagged primary is live but whose scalar is
  absent-when-stored-primary-exists or names someone else (`scalarAligned`).
  Landlord-only units (derived primary, no stored roster) are left alone.
- Each write appends a `unit_primary_contact_assigned` audit event
  `{ contactId, reason: 'backfill' }`. The P2 / P3 writes append the same event
  with `reason: 'auto_on_add' | 'handoff_on_remove' | 'handoff_on_delete' |
  'handoff_on_restore'`, so the property's Activity tab explains every primary
  change nobody clicked. The Activity projection whitelist
  (`routes/units.ts:217-248`) gains `reason`, and the dashboard's unit
  activity renderer gains a line for the event.
- Dry run prints counts (targets, live vs soft-deleted units, `noHeir`,
  `unknown`) and unit ids only - never a person's name.
- Idempotent: a completed apply plans nothing on a re-run.
- RUNBOOK section owed with the deploy: dry run, then `--apply`, on dev and
  then prod, after that environment's deploy.

## 9. Surfaces (mutation and read)

From a whole-repo sweep on `main` @19607658 plus review round 1. Line numbers
drift; the plan re-anchors every row against the post-caseworker `main`
(section 11), and any surface it finds that is not here is added to the plan as
a task or a watch item.

### 9.1 Mutation surfaces of the primary contact / landlord of record / roster

| surface | today | after this spec |
|---|---|---|
| `POST /api/units` (`routes/units.ts:464-514`, repo `create` `unitsRepo.ts:581-609`) | sets `landlordId`; accepts `primary_contact` unchecked | derived landlord primary (unchanged); `primary_contact` refused (P2b) |
| `PATCH /api/units/:id` (`units.ts:1376-1491`, repo `update` `:662-708`) | can reassign `landlordId` and set `primary_contact`, no roster sync | `primary_contact` refused (P2b); `landlordId` reassign UNCHANGED (API-only, no UI; caseworker-integrity owns its type check); the heir function handles the resulting off-roster landlord |
| `POST /api/units/:id/contacts` (`units.ts:1061-1137`, repo `addContact` `:754-863`) | flag from input; can demote to zero; scalar can go stale | P2 (heir function); 409 `primary_contact_deleted` |
| `DELETE /api/units/:id/contacts/:cid` (`units.ts:1143-1172`, repo `removeContact` `:865-941`) | landlord heir or none; off-roster landlord -> flag/scalar disagree | P3 remove rule; 503 `roster_read_failed` |
| `DELETE /api/contacts/:id` (`routes/contacts.ts:2228-2347`) | touches no unit | P3 delete fan-out |
| `POST /api/contacts/:id/restore` (`contacts.ts:2352-2374`) | touches no unit | unchanged |
| `DELETE` / `POST restore` on a unit (`units.ts:1497-1532`) | `deleted_at` only | unchanged on `main`; caseworker-integrity's `restoreWithLandlord` clear and swap follow P3 once merged |
| importer `upsertUnit` (`lib/import/apply.ts:1411-1556`) | `landlordId` on an exact match only, never a roster; on a re-import of a human-touched unit, `if_not_exists(landlordId)` (`:1545-1552`) can attach a landlord with NO roster row | unchanged; the heir function and the script handle the off-roster landlord |
| importer `retractImported` (`apply.ts:316-328`, `:769-775`) | hard-deletes contacts, leaves roster/landlord ids dangling | unchanged; P1 treats a missing contact as deleted |
| API-test fake (`app/test/helpers/twilioWebhookHarness.ts:2940-3017`) | its own copies of `addContact` / `removeContact` | uses the shared heir function (4.3) |
| dashboard callers (`ListingDetail.tsx:425-489`, `endpoints.ts:969-1070`) | re-role sends the current flag; make-primary; add sends `false` | unchanged requests; deleted rows lose "Make primary"; new box, notice and 409 copy (7.3, 7.4) |
| seeds: lean (`lean.ts:206-254`), full (`cast.ts`, `matrix.ts`, `live.ts`) | `landlordId` only, except the PM unit (`cast.ts:1344-1368`, explicit roster, PM primary) | UNCHANGED - lean stays byte-stable |
| performance seed (`performance.ts:582-611`) | primary = landlord, every 7th landlord contact soft-deleted (`:578`) | unchanged; after P1 those units resolve to NO property contact - perf-page behavior on them shifts, by design |
| dev seams (`routes/dev.ts`) | reseed / performance reseed / org fixture | NEW dev-only seam for the e2e zero-primary state (section 10) |

### 9.2 Readers of "the property's contact"

Every reader below moves onto P1 or onto the 7.5 fields unless marked
otherwise.

- The four ladder copies: `lib/tourContacts.ts:124-139` (names for tour
  reminder and relay copy), `lib/rosterResolution.ts:292-301` (default people
  list = membership), `services/rosterProvision.ts:232-247` and `:524-535`
  (diagnostics; codes unchanged, 4.1).
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
- The property page: `enrichRoster` (`routes/units.ts:384-411`) gains the 7.5
  fields; `listingRoster` (`dashboard/src/routes/listing/buildListingFile.ts:49-87`)
  and `ListingDetail.tsx:285-291,471-479,888,918-928,951` render them.
- People card suggestions: `rosterSuggestions`
  (`dashboard/src/routes/shared/rosterPeople.ts:90-118`), called at
  `TourDetail.tsx:230-241` and `PlacementDetail.tsx:260-274`, rendered at
  `PeopleCard.tsx:685-687` - skip deleted rows (7.5).
- The unit Activity projection (`routes/units.ts:217-248`) and its renderer
  (section 8).

UNCHANGED on purpose - these mean the landlord of RECORD (the owner), not the
property contact:

- `jobs/placementNudges.ts:422-444` (landlord-rung nudge recipient) and
  `routes/placementNudges.ts:231-248`;
- `lib/personEvents.ts:99-105,165-178` (dual-party milestones);
- related properties / landlord timelines (`units.ts:1202`,
  `contactTimeline.ts:1222,1428`);
- dashboard landlord tabs and labels (`TourDetail.tsx:201-210,246-256`,
  `useTour.ts:94-98`, `PlacementDetail.tsx:185-237,287-296`,
  `PlacementNowCard.tsx:114-118`).

The `primary_contact` scalar has NO runtime reader (only writes, comments and
a dashboard type, `types.ts:2506`). Comments that claim a masked call dials it
or routes to the primary are corrected in the same change:
`unitsRepo.ts:63,248,402,815-820`, `conversationsRepo.ts:207`,
`routes/units.ts:1055-1056`, `ListingDetail.tsx:359,455`,
`rosterPeople.ts:58`; and the docblock at `rosterResolution.ts:174-180` that
says a deleted member is excluded from every send.

### 9.3 Filed, not fixed here

A soft-deleted contact on a tour or placement people list - added BY HAND, or
left over in a plan - is still provisioned onto the relay thread and texted:
`provisionMembersOf` (`rosterProvision.ts:106-121`) keeps every phone-bearing
member, `memberFromContact` never checks `deleted_at`, `describeRoster` counts
the member reachable (`:550-555`) although it labels it `removed_contact`, and
the fan-out suppression checks only `sms_opt_out` (`relayAnnouncements.ts:64-73`).
P1 removes the property-contact route into this; the rest is filed as
`docs/issues/relay-provision-includes-deleted-contacts.md`.

## 10. Testing

- App unit tests: P1 (each candidate outcome; deleted primary -> landlord;
  deleted landlord; tenant primary STOPS; read failure carries the candidate id
  and does not fall through; reason `none` vs `deleted`); the heir function
  (landlord heir, off-roster landlord heir with row add, earliest live heir,
  deleted skipped, excluded contact, unknown); P2 (no primary -> heir; a
  primary exists -> untouched; derived-landlord unit untouched; no heir ->
  stale scalar removed; unknown -> add succeeds unpromoted; 409 only for a
  deleted contact not already primary); P3 per path (remove: heir / clear /
  503 on unknown; delete: move to heir / no heir unchanged / unknown skipped /
  one unit failing does not fail the delete / delete-then-restore lossless);
  the reasons (each alone, combinations, ordering, owner/unit failure alone,
  placement exclusions, ownerless absence, never-throw).
- Parity: the real repo and the API-test fake give the same results for the
  heir cases (they share the function; a test pins it through both). The fake
  ignores `requireComplete`, so the 503 / unknown paths are tested with an
  injected contacts repo whose batch read throws `IncompleteBatchReadError`.
- App API tests: the 7.5 block (complete read, incomplete read -> absent,
  deleted rows), the preview `introFallback`, the contact DELETE handoff, P2b's
  refusal, the Activity projection's `reason`.
- Dashboard tests: the dialog box (each reason's line and link, new-tab
  target, Check again, the edited-draft rule both ways, absent for
  standalone); the property box (each action variant, the deleted lead, absent
  block -> no box, deleted rows without "Make primary", empty state); the
  notice (heir / no heir / unknown); the 409 copy; suggestions skip deleted
  rows; the Delete dialog sentence (non-tenant only).
- Script tests: target selection (no primary; deleted primary + live landlord;
  off-roster landlord), dry run writes nothing, `skippedOnCondition` when the
  roster changed after the read, idempotent re-apply, counts.
- E2E: the zero-primary state cannot be reached through the UI (property
  create requires a landlord), and the byte-stable lean seed has none on
  purpose (`docs/issues/tour-reminder-zero-primary-e2e-gap.md` item 1). A new
  DEV-ONLY seam (hermetic-only, structurally absent in deployed envs like
  `/__dev/reseed`) CREATES a NEW property and contact of its own in the
  imported shape - no landlord of record, one non-primary contact - and returns
  their ids. It never rewrites a shared lean unit (the suite runs serially with
  one worker, so a rewritten shared unit would leak into every later spec);
  the next reseed removes what it made. Specs: (a) the property box and
  "Make <Name> primary"; (b) a tour on that property: the open-group dialog
  box, and Check again after fixing the property in another tab flips the
  preview to the tour intro; (c) removing a primary with no landlord hands off
  to the remaining contact. This PARTIALLY addresses item 1 (the ownerless
  leg); the zero-primary-with-landlord leg stays open.

## 11. Sequencing with fix/caseworker-integrity

`fix/caseworker-integrity` (slice S4) rewrites the same surfaces: the property
contact-list add route's checks (`routes/units.ts:1061`), unit restore and its
new `restoreWithLandlord` (clear and swap), and `ListingDetail.tsx`'s roster
writes, conflict-copy map and Add contact picker. Decision (Cameron,
2026-10-12): this spec and its review run now; the PLAN is written against
`main` after that branch merges, and the build is cut from that `main`. P2's
409 ordering and P3's restore paths are pinned against the merged code.

## 12. Docs and issues

- GLOSSARY: add **property contact**; update **primary contact** (the flag is
  the truth; the scalar is absent on landlord-only units; the handoff rule;
  zero primary is reachable only with no live heir or for legacy data).
- RUNBOOK: the script section (section 8), owed with the deploy.
- `docs/issues/tour-reminder-zero-primary-e2e-gap.md`: item 1 partially
  addressed (ownerless leg).
- `docs/issues/relay-provision-includes-deleted-contacts.md`: filed (9.3).
- Records: `docs/superpowers/reviews/2026-10-12-primary-contact-integrity/`.

## 13. Post-merge operator actions (known now)

- After each environment's deploy: run `assign-primary-contacts.ts` dry, then
  `--apply` (dev, then prod). Until it runs, existing no-primary properties
  show the property box and Sam can fix them by hand.
- No Terraform, no secrets, no table or index change.
