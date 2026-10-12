# Spec review R1 - reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md` (DRAFT rev 1)
Tree: `W:\tmp\primary-contact-integrity` @ 47a0796e (main @19607658 + the spec).
Also read (git objects only, not the checkout): `fix/caseworker-integrity` spec and plan, for
the section 11 overlap.

Method: every claim below about current behavior cites a file:line that was read. Anything
not verifiable is marked UNVERIFIED. Severity is consequence-if-shipped.

Summary list:

1. HIGH - Delete-then-restore of a property's sole contact now LOSES the primary (a regression the spec's own P3 step 3 creates)
2. HIGH - P3 (the write-side handoff) has no read-failure contract; "a thrown read is not absence" stops at P1
3. MEDIUM - 7.5 `deleted` / `propertyContactId` sit on enrichRoster's best-effort BatchGet: an unread batch reads as "every contact deleted"
4. MEDIUM - "Make primary" and re-role on DELETED rows now 409 with the wrong copy; the "dashboard already offers live contacts only" claim is false
5. MEDIUM - Unenumerated reader: the People card's property-contact suggestions offer deleted contacts and label a deleted one "primary contact"
6. MEDIUM - 7.5 fields ride only the enrichRoster responses; the page replaces `unit` from PATCH / restore / delete / photo responses that lack them
7. MEDIUM - P1's `readFailed` result carries no candidate id; moving resolveRoster onto it drops the property contact from a materialized plan on a transient read
8. MEDIUM - P2 promotes the TOUCHED row, not the P3 heir: contradicts its own "landlord properties unchanged" claim and the earliest-added rule
9. MEDIUM - The backfill script's "same write path as Make primary" cannot deliver its "conditional on unchanged since the read / skippedOnCondition" guarantee
10. MEDIUM - The script's target rule leaves deleted contacts flagged primary wherever a live landlord exists - unlike the delete fan-out going forward
11. LOW - G1 and P4 state guarantees the mechanisms do not deliver
12. LOW - P1's tenant guard now falls through to the landlord; today it does not, and the spec says it "keeps today's de-dupe"
13. LOW - Section 1 says a deleted primary is "excluded from sends"; the code and the spec's own P1 / 9.3 say it is texted
14. LOW - "This closes item 1" of tour-reminder-zero-primary-e2e-gap is an overclaim
15. LOW - 409 `primary_contact_deleted` for a MISSING contact is unreachable (the route 404s first)
16. LOW - 7.3 no-heir copy is false when the landlord of record is live but off-roster; the importer is an unnamed landlordId mutation surface
17. LOW - Reason copy says "primary contact" when P1 resolved or skipped the landlord of record; `deleted` vs `is_tenant` precedence undefined
18. LOW - The delete fan-out must identify primaries via unitContacts(), not the scalar; the spec calls the scalar a "mirror" but it is absent on every landlord-only unit
19. LOW - caseworker-integrity's restoreWithLandlord SWAP variant is not enumerated; it can make a deleted contact primary around the new 409
20. LOW - Stale "masked call" comments exist beyond the two the spec names

---

## 1. HIGH - Delete-then-restore of a sole contact now loses the primary

What is wrong. P3 step 3 says that with no live heir the handoff clears the flag on every row
and REMOVEs the scalar (spec section 4, P3, step 3). The Delete path runs that handoff, and the
deleted contact stays on the roster with the flag moved off it (P3 "Delete the contact"). The
Restore path is explicitly "no roster change. A restored contact who lost the primary does not
get it back" (P3 "Restore a contact").

Trace the target population - an imported ownerless property with one contact (the 470 Bolton
shape, after the script or P2 has made that contact primary):
- Delete the contact: no landlord, no other live row, so step 3 clears the flag.
- Restore the contact: no roster change. The property now has one LIVE contact and ZERO
  primary - exactly the broken state section 1 is about, re-created by this spec.

Today the same delete + restore is a no-op on the unit: the contact DELETE route touches no
unit (`app/src/routes/contacts.ts:2228-2347`) and restore touches no unit
(`app/src/routes/contacts.ts:2352-2374`), so the flag survives. This is a regression the spec's
own mechanism introduces, not a pre-existing gap.

Second shape: a landlord-only property (no stored `contacts`, the derived landlord row is
primary, `app/src/repos/unitsRepo.ts:296-303`). Delete the landlord: step 1 is skipped (not
live), step 2 finds nobody, step 3 "flag cleared on every row" must MATERIALIZE the derived row
as a stored `{ landlord, primaryContact: false }`. Restore the landlord: P1 still resolves the
landlord via its step 2, but the Contacts card now shows no "(primary)" star
(`dashboard/src/routes/listing/buildListingFile.ts:49-61` renders the stored flag), 7.5's
`primaryHeirContactId` is null ("no primary"), no 7.4 box appears (P1 found the landlord), and the
next Add contact triggers P2 and makes the newly added PM the primary - displacing a live landlord
of record that today would have stayed primary.

What it implies. On the DELETE path, step 3 should leave the flag where it is (P1 already skips
a deleted primary, the box already warns) so a restore revives it; only REMOVE needs step 3.
Or restore must re-run the rule. As written, P4's "has a primary after any ... contact delete" is
bought by a write that makes delete+restore lossy.

## 2. HIGH - P3 has no read-failure contract

What is wrong. P1 states its failure semantics precisely: "A THROWN read is not absence ... P1
stops there and reports readFailed" (spec P1). P3 - the rule that WRITES the persisted primary -
says only "if live" (steps 1-2) and never says what a liveness read that throws or comes back
unprocessed means. Every P3 path needs liveness of the landlord and of every remaining roster
contact:
- Remove: `unitsRepo.removeContact` (`app/src/repos/unitsRepo.ts:865-941`) has no contacts repo
  today; the liveness reads have to be added somewhere inside or around its optimistic retry
  loop (re-read at `:921-930`), so a roster that changes mid-retry needs fresh liveness too.
- Delete fan-out: in-request, best-effort, across every matching unit.
- Script and the 7.5 `primaryHeirContactId`.

The obvious implementation is one batched read of the roster's contacts. The repo's batched read
is BEST-EFFORT by default: unprocessed keys and a thrown chunk are DROPPED and the caller gets a
short map (`app/src/repos/contactsRepo.ts:940-997`; only `requireComplete` throws). A dropped key
is indistinguishable from a missing contact, and spec section 3 defines "missing" as "treated
exactly like a deleted contact". So a throttled read skips a live landlord at step 1, persists a
PM (step 2) or no primary at all (step 3), and appends an audit event claiming a handoff. Nothing
re-runs it.

What it implies. The spec must give P3 the same rule P1 has: an unread candidate is not
"not live"; the write aborts (remove -> retryable error; delete fan-out -> logged skip, left to
the box and the script) rather than choosing past it. And it should say where the reads happen
relative to the conditional write.

## 3. MEDIUM - 7.5 display fields inherit the batch-absence ambiguity

What is wrong. 7.5 adds per-row `deleted: true` "when the row's contact is soft-deleted or
missing", plus `propertyContactId` / `primaryHeirContactId`, to "the unit responses that carry the
enriched roster". `enrichRoster` reads contacts with `getManyByIds` default (best-effort) and, on a
throw, CATCHES and proceeds with an EMPTY map (`app/src/routes/units.ts:384-396`;
`app/src/repos/contactsRepo.ts:1288-1290`). Today that degradation is harmless - rows render
without names. Under 7.5, the same degraded read marks EVERY row `deleted: true`, makes P1 report
nobody with reason `deleted`, and the 7.4 box renders "The primary contact was deleted ... Add a
contact and make them primary" on a perfectly healthy property.

What it implies. 7.5 needs a third state (unknown) or must compute these fields from a read that
distinguishes failure from absence, and the box must not render on unknown. The payload type
`propertyContactId: string | null` has nowhere to say "could not tell".

## 4. MEDIUM - Make primary / re-role on deleted rows now 409, with the wrong copy

What is wrong. P2 refuses `primaryContact: true` on a soft-deleted contact with 409
`primary_contact_deleted`, justified by "The dashboard already offers live contacts only
(`ListingDetail.tsx:367`)". Line 367 is only the ADD picker's candidate filter. In edit mode
every non-primary row - deleted or not - renders "Make primary"
(`dashboard/src/routes/listing/ListingDetail.tsx:918-928`), and re-role sends the row's CURRENT
flag (`:425-433`), so re-roling a still-flagged deleted primary (legacy data until the script
runs) sends `primaryContact: true` and is now refused.

`runRosterWrite` maps every 409 code it does not know to `ROSTER_CONFLICT_COPY`
(`ListingDetail.tsx:393-400`), which reads "That contact is the landlord of record now -
reassign the property's landlord first." (`:115-116`). That is the sentence Sam will see.

7.4's "Choose a primary" action sends her straight into that edit mode on a property that, by
construction, has deleted rows (the box exists because of them).

What it implies. The spec must hide or disable "Make primary" on rows with `deleted: true`,
decide what re-role on a deleted primary row sends, and add the new code to the 409 copy map
(caseworker-integrity S4 also rewrites that mapping - section 11 sequencing applies).

## 5. MEDIUM - Unenumerated reader: People card property-contact suggestions

What is wrong. Section 9.2 lists `TourDetail.tsx:201-256` under "UNCHANGED on purpose - these mean
the landlord of RECORD". That range contains `rosterSuggestions`
(`dashboard/src/routes/tours/TourDetail.tsx:230-241`; twin at
`dashboard/src/routes/placements/PlacementDetail.tsx:260-273`), which is NOT a landlord-of-record
reader: it walks the PROPERTY ROSTER (`unit.contacts`) and offers every member not on the tour as
"Also on this property: <name> - <role>", appending " - primary contact" when the row is flagged
(`dashboard/src/routes/shared/rosterPeople.ts:106-115`, rendered at
`dashboard/src/routes/shared/PeopleCard.tsx:685-687`).

After this spec, a deleted contact stays on the property roster (P3 Delete keeps the row). The
suggestion list will keep offering that deleted contact for one-click "+ Add", and for legacy data
label it "primary contact". "+ Add" puts them on the tour plan, which is the provision-and-text
path section 9.3 itself identifies. G2 says "Everywhere the app picks 'the property's contact', it
skips deleted contacts" - this site picks property contacts and does not.

What it implies. Add it to 9.2 and decide: filter `deleted: true` rows (7.5 now provides the flag
on the same `unit.contacts` these pages already load) or render them as deleted and non-addable.

## 6. MEDIUM - 7.5 fields only exist on 3 of the unit responses the page applies

What is wrong. `propertyContactId` / `primaryHeirContactId` / per-row `deleted` are added only to
responses that call `enrichRoster`: GET (`app/src/routes/units.ts:531`) and the two roster writes
(`:1136`, `:1171`). The property page REPLACES its unit from many other responses that do not
carry them: restore (`ListingDetail.tsx:349-350`, route `units.ts:1531`), the edit form's PATCH
(`ListingDetail.tsx:1286-1287`, route `units.ts:1398,1490`), photo writes
(`ListingDetail.tsx:255,584,622,632`, routes `units.ts:848,891,947,982`), and delete
(`units.ts:1512`). The roster card reads `contactsUnit` only after a roster write
(`ListingDetail.tsx:285-287`); otherwise the hook's load-time roster.

The one path the spec explicitly adds a handoff to - caseworker-integrity's landlord-clearing
restore (P3) - answers with a bare `{ unit }`, so the page will show the pre-restore card and no
box until reload.

What it implies. The spec must say which object the box and notice read, and either make every
unit response carry the 7.5 fields or make the page refetch after restore (and say the other
replacements do not clobber the fields).

## 7. MEDIUM - P1 `readFailed` vs resolveRoster's default list

What is wrong. P1 returns "the contact (when found) and, when nobody, WHY ... plus a readFailed
flag". It does not say the candidate's ID survives a read failure. Today the default-list code
keeps a candidate whose read THROWS as a bare `{ contactId }` row
(`app/src/lib/rosterResolution.ts:181-190`, called at `:298-301`), and that row is what
`applyRosterPlanEdit` persists when it materializes the default into a plan
(`app/src/services/rosterEdits.ts:271-283`). Moved onto P1 as specified ("Every reader ... moves
onto P1", 9.2 lists `rosterResolution.ts:292-301`), a transient contact read failure during the
first People-card edit would materialize a plan WITHOUT the property contact - permanently, since
a present plan wins over the default (`rosterResolution.ts:254-272`).

Note the unit-read-failure leg already has this hazard today (`rosterResolution.ts:281-288`
omits the property contact); this spec would extend it to contact reads.

What it implies. P1's contract must return the candidate id alongside `readFailed`, and the spec
must say resolveRoster keeps today's bare-row behavior on that branch.

## 8. MEDIUM - P2 promotes the touched row, not the P3 heir

What is wrong. P2: "after the write, NO roster row is flagged primary, the added contact becomes
the primary contact ... Properties with a landlord of record already have a primary (the derived
landlord row), so nothing changes for them."

The second sentence is false in states the code and this spec produce:
- PATCH reassigns `landlordId`, then removing the primary clears every flag
  (`app/src/repos/unitsRepo.ts:898-905`, which the spec itself quotes);
- an API re-add with `primaryContact` omitted demotes to zero flags (`unitsRepo.ts:794,800`);
- this spec's own Delete handoff step 3 on a landlord-only property materializes an unflagged
  landlord row (finding 1).
In each, a live landlord of record exists and P1 resolves to them; the next add makes the added
PM primary, so a routine add silently changes who goes on new tours and is named in intros.

P2 also fires on any upsert, and the dashboard's re-role IS an upsert (`ListingDetail.tsx:425-433`).
On a legacy zero-primary property, changing a contact's ROLE makes that contact primary. With two
live contacts, which one becomes primary depends on which row Sam happened to touch, while the
script (section 8) would have chosen the earliest-added. 470 Bolton itself: if Sam adds a second
contact before the script runs, the NEW contact becomes primary, not Mark.

What it implies. P2 should apply the P3 heir rule (landlord-first, then earliest live) when zero
rows are flagged after the write, not "the added contact". That also makes P2, P3, the script and
`primaryHeirContactId` one rule instead of two.

## 9. MEDIUM - Script write path cannot deliver its condition

What is wrong. Section 8: the script "makes it primary through the same write path as 'Make
primary' (conditional on the roster being unchanged since the read; a changed unit is counted
`skippedOnCondition`)". The Make primary path is `addContact(..., primaryContact: true)`
(`ListingDetail.tsx:435-445`), which re-reads the unit ITSELF, conditions on ITS OWN read, and on a
condition failure re-runs from the fresh item up to the retry cap (`unitsRepo.ts:754-863`, retry at
`:828-848`). It never reports "changed since the caller's read". If Sam sets a primary (or P2 fires
on her add) between the script's read and its write, the script's call re-reads, sees her
primary, and demotes it in favor of the script's heir (`unitsRepo.ts:811-813`).

What it implies. Either the script uses its own conditional write against the roster IT read
(the clean-org-names pattern the spec cites), or the spec drops the skippedOnCondition claim. As
written the two sentences contradict and the mechanism can overwrite a human's choice.

## 10. MEDIUM - Script targets leave deleted primaries flagged where a live landlord exists

What is wrong. Target = "property contact (P1, no tenant) is nobody AND at least one live roster
contact". A property whose flagged primary is a DELETED PM and whose landlord of record is live
resolves through P1 to the landlord, so it is not a target. Going forward, the Delete fan-out
handles the identical state by moving the flag to the landlord (P3 step 1). So existing data and
new data diverge:
- the Contacts card keeps rendering the deleted contact first, with "(primary)"
  (`buildListingFile.ts:52`, `ListingDetail.tsx:888-890,951`), next to the new "(deleted)" label,
  while tours use the landlord - and no 7.4 box prompts a fix (P1 is not nobody);
- the `primary_contact` scalar stays pointed at a deleted contact, contradicting the non-goal
  "It is kept consistent ... so that path inherits correct data when built".
G5 ("Existing properties in the broken state can be repaired") does not repair this state.

What it implies. Target should be "flagged primary absent or not live, AND a P3 heir exists"
(same P3 rule as the fan-out), with P1-nobody as a separate count.

## 11. LOW - G1 / P4 overclaim

G1: "kept that way on every write that can take it away". P4: "has a primary after any add,
remove, contact delete or landlord-clearing restore". Not delivered:
- the importer's `retractImported` hard-deletes contacts and leaves rosters untouched
  (`app/src/lib/import/apply.ts:316-328`, `:765-780`), declared unchanged in 9.1;
- the Delete fan-out is best-effort (P3 says so);
- P2 never promotes a DELETED added contact, so an API re-add of a deleted current primary without
  the flag (`unitsRepo.ts:800`) leaves zero primary even with live rows;
- contact restore re-creates a live-contact-no-primary property (finding 1).
Tests written from P4 as an invariant will be wrong. State it as "best effort, backstopped by P1,
the box and the script".

## 12. LOW - P1's tenant guard is a behavior change

Today a primary that IS the tenant yields NO property contact - there is no fall-through to the
landlord (`app/src/lib/tourContacts.ts:129-139`; `app/src/lib/rosterResolution.ts:293-301`
likewise never tries the landlord). P1 step 1 skips a tenant primary and step 2 tries the
landlord. That changes intros, reminders and default lists for that case. The spec says "The
tenant guard keeps today's de-dupe" and lists only the deleted-contact change under "Behavior
change, stated". Either state it or keep today's semantics.

## 13. LOW - Section 1 contradicts 9.3 on whether a deleted primary is texted

Section 1: a deleted primary "is excluded from sends as a removed contact". P1 "Behavior change"
and 9.3: it "IS put on the default list, provisioned onto the group and texted". The code agrees
with 9.3: `memberFromContact` keeps the phone of a soft-deleted contact
(`rosterResolution.ts:181-200`), `provisionMembersOf` keeps every phone-bearing member
(`app/src/services/rosterProvision.ts:106-121`), and the relay suppression checks only opt-out
(`app/src/services/relayAnnouncements.ts:64-73`). Section 1 repeats the false docblock at
`rosterResolution.ts:174-180`. Fix section 1 so a builder does not trust it.

## 14. LOW - "This closes item 1" is an overclaim

`docs/issues/tour-reminder-zero-primary-e2e-gap.md` item 1 is the ZERO-PRIMARY fallback to the
LANDLORD OF RECORD in tour-reminder name resolution. The new seam builds an OWNERLESS property (no
landlord), so P1 resolves to nobody - the landlord-fallback leg is never exercised - and specs
(a)-(c) cover the property box, the open-group dialog and removal, not reminders. Zero-primary
with a landlord remains reachable (finding 8 states). Say "partially addresses" or add a spec for
the landlord leg.

## 15. LOW - 409 for a missing contact is unreachable

P2 refuses `primaryContact: true` "on a soft-deleted or missing contact" with 409
`primary_contact_deleted`. The add route answers 404 `contact_not_found` for a missing contact
before any write (`app/src/routes/units.ts:1094-1100`). Only the soft-deleted case can reach the
409. Say so, so tests do not chase an unreachable branch.

## 16. LOW - 7.3 no-heir copy vs an off-roster live landlord; importer surface

`primaryHeirContactId` is null when the landlord of record has no roster row (P3 step 1) and no
other live row exists. After that removal P1 still resolves the off-roster landlord (P1 step 2),
so "New tours won't include a landlord, and tour group texts will use the general intro" is
false. The spec calls the off-roster landlord "API-only; there is no UI for it" (PATCH). It is
also produced by the importer on a re-import: once a unit has `updated_at` (any roster write), the
importer writes `landlordId = if_not_exists(landlordId, :landlordId)` on an exact name match
(`app/src/lib/import/apply.ts:1510-1520`, `:1545-1552`), attaching a landlord of record with no
roster row to a unit that already has a stored roster. 9.1's importer row describes it only as
"never a roster".

## 17. LOW - Reason copy and precedence

- `property_contact_no_first_name` reads "The primary contact has no first name saved." but P1 may
  have resolved the LANDLORD OF RECORD (no primary flagged); the line names the wrong thing.
- `property_contact_deleted` reads "<Street>'s primary contact was deleted" when it was the
  landlord of record (no primary) that was deleted.
- P1's `deleted` and `is_tenant` are not exclusive: primary deleted + landlord is the tenant, or
  primary is the tenant + landlord deleted. No precedence is given, so preview and tests can
  disagree.

## 18. LOW - Finding the primaries for the Delete fan-out

The spec defines the scalar as "mirrored" (section 3), but unit create never sets it
(`app/src/repos/unitsRepo.ts:581-609` stores only the input; the dashboard never sends it) and the
roster writes set it only when a stored primary exists (`unitsRepo.ts:821-824`). Every
landlord-only unit has a derived primary (`unitsRepo.ts:300-301`) and NO scalar. A Scan that
filters on `primary_contact = :id` misses them all. The spec should say the fan-out matches on
`unitContacts(u)` primary (as `app/src/services/caseworkerConversion.ts:243-257` does for roster
membership), not the scalar - and correct "mirrored" in section 3.

## 19. LOW - restoreWithLandlord SWAP variant not enumerated

P3 / P4 name only the landlord-CLEARING restore (`next: null`). The caseworker-integrity plan's
SWAP (`next: <id>`) also removes the old landlord row and makes the new landlord primary when the
old one was (caseworker plan, Task 4.5, test "swaps the landlord ... made primary in its place").
Its contact check is "exists and typed landlord", and "exists" there keeps getById semantics that
include soft-deleted contacts (caseworker spec section 4 preamble). So the API can install a
soft-deleted contact as landlord AND primary, the exact thing P2's new 409 exists to stop. Also:
that plan's real-repo tests assert `primaryContact: false` and no scalar after a clear; the
handoff flips them. Enumerate the swap in 9.1 and P3 and say which rule it follows.
(Read from git object `fix/caseworker-integrity`; the code is unbuilt, so behavior is per its plan.)

## 20. LOW - More stale "masked call" text than the spec names

9.2 corrects `unitsRepo.ts:815-820` and `conversationsRepo.ts:207`. The same false claim also
sits at `app/src/repos/unitsRepo.ts:63,248,402`, `app/src/routes/units.ts:1055-1056`,
`dashboard/src/routes/listing/ListingDetail.tsx:359,455`, and
`dashboard/src/routes/shared/rosterPeople.ts:58` ("it is who calls route to"). Comment-only, but
the spec's stated scope is "corrected in the same change".

---

Verified-as-accurate claims (no finding): `resolveRelayComposeInputs` range and degrade rules
(`app/src/jobs/relayFanOut.ts:444-578`); preview shares the resolver (`rosterEdits.ts:587`);
importer leaves `landlordId` unset on no unique match (`apply.ts:1506-1520`); add sends
`primaryContact: false` (`ListingDetail.tsx:486`); removeContact no-landlord branch
(`unitsRepo.ts:906-912`) and off-roster-landlord flag/scalar disagreement (`:898-905`);
`getById` returns soft-deleted contacts (`contactsRepo.ts:924-931`); the reminder fail-closed
seam (`tourReminders.ts:960-963`); `primary_contact` writable (`unitFields.ts:104`) with no
dashboard sender; voice path unbuilt (`routes/webhooks/voice.ts:620-632`); the two OPEN preview
callers (`TourDetail.tsx:443-460`, `PlacementDetail.tsx:311-325`); placement nudge landlord rung
reads `landlordId` (`jobs/placementNudges.ts:422-444`); one contact soft-delete path in the app
(`routes/contacts.ts:2235`).
