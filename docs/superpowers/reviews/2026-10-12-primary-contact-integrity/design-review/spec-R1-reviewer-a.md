# Spec R1 - adversarial reviewer A

Spec: `docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md` (rev 1, commit 47a0796e).
Tree read: `W:\tmp\primary-contact-integrity` @ 47a0796e (= main 19607658 + the spec), plus the
`fix/caseworker-integrity` branch's spec and plan read from git objects (that branch is docs-only
today). Read-only review; nothing was run.

Severity is consequence-if-shipped. Every claim about current behavior cites a line I read.

---

## F1. [HIGH] The new 409 `primary_contact_deleted` is reachable from today's dashboard, renders as "landlord of record" copy, and 7.4 routes Sam straight into it

What is wrong. P2 says the dashboard "already offers live contacts only (`ListingDetail.tsx:367`)"
and therefore only the API can make a deleted contact primary. Line 367 is the ADD picker's
candidate list (`addContactCandidates = contactsList.filter(...)`). The per-row edit controls are a
different surface, and they act on EVERY roster row, deleted or not:

- "Make primary" renders on every non-primary row (`ListingDetail.tsx:918-928`) and posts
  `primaryContact: true` (`:437-445`). On a deleted contact's row that is exactly the request P2
  refuses.
- The role select re-posts the row's CURRENT flag (`:425-433`). On a property whose flagged primary
  is a deleted contact - the very state 7.4 names ("The primary contact was deleted") - changing
  that row's role posts `primaryContact: true` for a deleted contact and is refused too.
- `runRosterWrite` maps any 409 it does not recognize to `ROSTER_CONFLICT_COPY`
  (`:402-412`), which reads "That contact is the landlord of record now - reassign the property's
  landlord first." (`:115-116`). The caseworker-integrity spec already calls this catch-all out as a
  trap and requires new codes to be mapped before it (branch spec, "Dashboard copy for section 4").

7.4's "Choose a primary" action "enters the card's edit mode, where each row already has 'Make
primary'" - including the "(deleted)" rows 7.4 itself adds. Nothing in 7.4/7.5 hides "Make primary"
on a deleted row, disables the role select on a deleted primary, or gives
`primary_contact_deleted` copy.

Implies. Shipped as written, the feature's own repair flow produces a refusal with a sentence that
is false and points Sam at the wrong fix. The spec must (a) hide/disable Make primary on rows marked
`deleted`, (b) decide whether re-roling a deleted primary is "making it primary" (if not, P2's
refusal must key on a flag CHANGE, not on `primaryContact: true`), and (c) give the new code its own
copy ahead of the catch-all.

## F2. [HIGH] The script's "conditional on the roster being unchanged since the read" is not delivered by the write path it names - it can silently overwrite a primary Sam just set

What is wrong. Section 8: the script "makes it primary through the same write path as 'Make
primary' (conditional on the roster being unchanged since the read; a changed unit is counted
`skippedOnCondition`)". "Make primary" is `POST /api/units/:id/contacts` -> `units.addContact`
(`ListingDetail.tsx:437-445`, `routes/units.ts:1107`). `addContact` does its OWN read
(`unitsRepo.ts:758`) and, on a lost condition, re-reads and re-runs from the CURRENT item up to three
times (`:826-850`). It never reports "changed since the caller's read"; the caller's read is never
the condition. So:

- `skippedOnCondition` can never be produced by that path (and section 10's "conditional skip"
  script test cannot be written against it);
- worse, if Sam makes X primary between the script's read and its write, `addContact(heir,
  primaryContact: true)` re-reads (X primary), sets the heir primary and demotes X
  (`:811-813`) - her explicit choice is reverted with no trace except an audit row.

Section 13 says Sam is expected to be fixing these same properties by hand around the deploy
("Sam can fix them by hand"), so the race is the expected operating condition, not a corner case.

Implies. The script needs a write conditioned on the script's own read of `contacts` (and
`landlordId`) - e.g. `updateRosterIfCurrent`-style with the read item, no internal retry - and
must not be described as "the same write path as Make primary".

## F3. [MEDIUM] P1's read-failure contract drops today's "keep the row" rule in the default people list; a blip during a People-card edit can permanently remove the property contact from a tour's plan

What is wrong. P1 "returns the contact (when found) and, when nobody, WHY ... plus a `readFailed`
flag", and on a throw "stops there". It does not return the CANDIDATE id on a failed read. Today the
default list keeps a bare `{ contactId }` row when the property contact's read throws
(`rosterResolution.ts:181-200`, docblock `:174-180`; called from `:299-300`). The spec moves
`resolveRoster`'s default onto P1 (9.2) but never says what the default list does on `readFailed`.

That matters because the default is MATERIALIZED and persisted on the first People-card edit:
`applyRosterPlanEdit` calls `resolveRoster` and stores `entriesOf(resolved.members)` as the plan
(`rosterEdits.ts:272-283`), and a present plan wins forever until "Reset to property default"
(`rosterResolution.ts:251-270`). If P1-on-readFailed yields "nobody", one transient contacts read
during an edit writes a plan without the property contact - the landlord is silently and permanently
off that tour's group. Today the id survives the blip.

The same gap exists for the "cannot open a group" diagnostics: today those reads THROW
(`rosterProvision.ts:220,238`, `:515,528` - no try), and the spec never maps P1's
`none`/`deleted`/`is_tenant`/`readFailed` onto the six verbatim tour detail strings
(`:196-247`, "asserted verbatim by the API tests") or the placement codes (`:501-544`). A
`readFailed` read as "nobody" would report "unit has no landlord".

Implies. P1 must return the candidate id alongside `readFailed`, and the spec must state per-reader
behavior on `readFailed` (default list: keep the bare row as today; diagnostics: which code).

## F4. [MEDIUM] P3-on-delete materializes a non-primary landlord row on landlord-only properties; with "restore does not give it back" and P2's add rule, a delete+restore of a landlord hands their properties to the next person added

What is wrong. For a property with no stored roster, `unitContacts()` derives
`[{ landlordId, role: 'landlord', primaryContact: true }]` (`unitsRepo.ts:296-304`). Deleting that
landlord: the fan-out finds "every property whose primary is this contact" (all of their
landlord-only units), P3 step 1 fails (the landlord is the deleted one), step 2 finds nobody, step 3
"flag cleared on every row, scalar REMOVEd". On a derived roster, clearing the flag can only be
persisted by WRITING `contacts: [{ L, landlord, primaryContact: false }]`. Today no path reaches
step 3 with a landlord present (`removeContact` refuses the landlord, `:878-880`, and promotes them
otherwise, `:899-905`), so this is a new state.

Then the landlord is restored ("no roster change", P3). Result: a LIVE landlord of record on the
roster with no primary flag. P1 still finds them via the landlord fallback, so the 7.4 box does not
show and the script does not target the unit (target = P1 is nobody). But P2 fires on the next add
("after the write, NO roster row is flagged primary") and makes the ADDED contact primary - the
property contact silently moves from the owner to, say, a PM. P3 ranks the landlord first; P2 ranks
the newcomer first; the spec never reconciles them.

This also falsifies three statements:

- P2: "Properties with a landlord of record already have a primary (the derived landlord row), so
  nothing changes for them." Only true while `contacts[]` is absent. Any stored roster can carry a
  non-primary landlord row (this path; an API re-add with `primaryContact: false`, `:800`; a
  `landlordId` set by PATCH or by the importer's `if_not_exists` on a human-owned unit,
  `lib/import/apply.ts:1543-1554`, leaves the landlord off the stored roster).
- P4: "Zero primary remains legal for a property with no live roster contact, and for legacy data
  until the script runs." This state is neither, and the script never fixes it.
- G1/P4 are about a live primary; the script's target rule is about P1, which the landlord fallback
  satisfies. The script does not bring legacy zero-flag-with-live-landlord units into P4.

Implies. Either step 3 must be a no-op on a derived roster (the landlord is skipped by P1 anyway), or
P2 must use P3's ladder (live landlord with a row first) rather than "the added contact", and the
script target must include "zero flags with a live landlord row".

## F5. [MEDIUM] The contact Delete dialog promises full reversibility; after P3 a delete permanently moves primaries and restore does not move them back - unenumerated surface

What is wrong. `ContactDetail.tsx:1358-1362` tells Sam the contact "will be hidden from the contact
lists, inbox, and today ... Nothing is erased - you can restore them". After P3-on-delete, deleting a
landlord or PM who is primary re-points every one of their properties (and, per F4, strips the flag on
landlord-only ones), and P3 says "A restored contact who lost the primary does not get it back." An
accidental delete followed by an immediate restore now changes who new tours put on the group and
whom the intro names, on every affected property, with the dialog having said it would not.

The spec enumerates no dashboard surface on the contact page (9.1 lists only `ListingDetail.tsx`
and `endpoints.ts`).

Implies. Either the delete confirm states the consequence (names the properties whose primary will
move, or at least says so), or restore reverses handoffs that the same contact's delete caused
(the audit `handoff_on_delete` rows carry what is needed). The spec must pick one.

## F6. [MEDIUM] 7.5's fields ride only on enriched-roster responses, but the property page overwrites its unit with responses that do not carry them

What is wrong. Only three unit responses carry `enrichRoster`: GET (`routes/units.ts:531`), POST
contacts (`:1136`), DELETE contacts (`:1171`). The listing-status change, edit-form PATCH, restore,
cover and photo routes return the bare unit (`:848, :891, :947, :982, :1398, :1490, :1531`), and
`ListingDetail.tsx` applies every one of them with `setUnit` (`:255, :350, :584, :622, :632, :1287`),
which replaces `state.unit` wholesale (`useListing.ts:143-164`). The page already needed a
special-case to survive exactly this for `mediaDisplay` (`useListing.ts:146-162`).

So after a status change or an edit-form save, `propertyContactId` / `primaryHeirContactId` become
`undefined` on the page's unit. Depending on how the box tests "nobody" (`=== null` vs falsy) the
7.4 box either vanishes from a broken property or appears on a healthy one, and 7.3's notice loses its
heir, until a reload.

Implies. The spec must either put the 7.5 fields on every unit response the page applies, or say
where the dashboard reads them from and how they survive a non-enriched `setUnit` (the mediaDisplay
precedent).

## F7. [MEDIUM] 7.5 has no "could not tell" state: a best-effort batch miss renders as "(deleted)" rows and a false "No primary contact" box

What is wrong. `enrichRoster` reads the roster's contacts with the DEFAULT, best-effort
`getManyByIds` (`routes/units.ts:386-396`), which drops unread keys and whole failed chunks into a
short map (`contactsRepo.ts:940-998`; "A key we FAILED TO READ is not the same fact as a contact that
DOES NOT EXIST", `:939-941`). 7.5 defines per-row `deleted: true` as "soft-deleted OR MISSING". If
computed from that map, every row of a failed batch reads `deleted: true`. And `propertyContactId:
string | null` has no value for P1's `readFailed`, so a thrown read surfaces as `null` = "nobody".

7.4's action variants are derived from those flags ("exactly ONE live", "two or more", "zero live:
Add a contact and make them primary"), so a transient read failure shows Sam a warning box and
instructions to repair a property that is fine.

Implies. Either compute `deleted` with `requireComplete` and fail the field (not the page) on an
incomplete read, or add an explicit unknown state (`propertyContactId` absent, rows without
`deleted`) and specify that the box does not render on unknown.

## F8. [MEDIUM] P3 needs contact liveness inside repo write loops that read no contacts today; the spec gives no source, no read-failure rule, and no rule for rows that appear between the read and the write

What is wrong. P3 steps 1-2 are defined on LIVENESS ("landlord of record, if live", "earliest-added
remaining LIVE roster contact"). The paths that must run it - `removeContact`
(`unitsRepo.ts:865-941`), the new delete fan-out, and caseworker-integrity's
`restoreWithLandlord` (branch plan, Task 4.5) - are repo read-modify-write loops that re-read the
UNIT on every retry (`:869`, `:920-927`) and read no contacts. P1 has an explicit thrown-read rule;
P3 has none. Unstated:

- what happens when a liveness read throws (skip that candidate as dead? abort the remove? For the
  user-initiated Remove, "skip" can silently clear the primary - step 3 - on a blip);
- whether liveness is re-read on each retry, given a retry can see rows the first read never
  checked;
- how `primaryHeirContactId` (7.5, "computed by the same server functions as P3") and the actual
  remove can be guaranteed to agree when they read liveness at different times (7.3's notice is
  shown from the former, the write does the latter).

Implies. The spec must say where liveness comes from (route-supplied oracle vs repo dependency), the
thrown-read rule (recommend: abort with a retryable error, mirroring P1's "a thrown read is not
absence"), and that the notice is advisory if the two can disagree.

## F9. [MEDIUM] The API-test fake duplicates addContact/removeContact and is not enumerated; "One handoff implementation" is contradicted by a second copy

What is wrong. `app/test/helpers/twilioWebhookHarness.ts:2940-3017` re-implements `addContact` and
`removeContact` (seeding, exactly-one-primary, the scalar, FIX B) "in lockstep with the real repo".
Section 10's "App API tests" (unit payload fields, contact DELETE handoff, P2) run on
`makeWebhookHarness`, i.e. on this fake. 9.1 lists no test fake, and P3 claims "One handoff
implementation". Left alone, the API tests pass against the old rules; updated by hand, there are two
P2/P3 implementations that can drift. (The caseworker-integrity plan does enumerate its fake: branch
plan Task 4.5 "(real repo + FakeWorld fake)".)

Implies. Put P2/P3 (and the heir function behind 7.5) in pure functions both the repo and the fake
call, and list the fake in 9.1.

## F10. [LOW] caseworker-integrity's restore-WITH-a-landlord also moves the primary and is not routed through P3

What is wrong. P3/P4 cover only `restoreWithLandlord(next: null)`. The branch's `next: <id>` arm
removes the old landlord's row and, when the old landlord was primary, makes the NEW landlord primary
unconditionally (branch plan, `restoreWithLandlord` implementation, `oldWasPrimary` branch; test
"swaps the landlord: ... made primary in its place"). That spec keeps "exists" as `getById`, which
returns soft-deleted contacts (`contactsRepo.ts:924-931`; branch spec section 4 "this branch does not
add a deleted-contact refusal"), so an API restore naming a soft-deleted landlord makes a deleted
contact primary - the outcome P3 step 1 forbids. Low because the dialog's picker likely lists live
landlords only.

Implies. P3's "every path that can take the primary away" must name both arms.

## F11. [LOW] P1's tenant guard is not "today's de-dupe" - it falls through to the landlord where today does not

What is wrong. Today both ladders pick `primary ?? landlord` FIRST and only then drop it if it is the
tenant, with no fall-through (`tourContacts.ts:124-139`; `rosterResolution.ts:293-301`). P1 skips a
tenant primary and tries the landlord. That changes the default people list, intro and reminder copy
whenever the primary is the tour's tenant and a different landlord exists. P1 says "The tenant guard
keeps today's de-dupe" and the "Behavior change, stated" paragraph omits it. Also unstated: which
reason wins when the candidates fail differently (primary deleted, landlord is the tenant:
`deleted` or `is_tenant`?). Narrow reach, but the claim is false.

## F12. [LOW] Section 1 contradicts section 9.3 (and the code) about deleted primaries being excluded from sends

Section 1: a deleted primary "is excluded from sends as a removed contact". P1's behavior-change
paragraph and 9.3 say the opposite, and 9.3 is right: `memberFromContact` never checks `deleted_at`
(`rosterResolution.ts:181-200`), `describeRoster` labels it `removed_contact` but counts its phone
reachable (`:541-555`), and provisioning keeps every phone-bearing member
(`rosterProvision.ts:106-121`). Section 1 repeats the false docblock (`rosterResolution.ts:174-180`).

## F13. [LOW] "This closes item 1" of `tour-reminder-zero-primary-e2e-gap` is false

Item 1 (`docs/issues/tour-reminder-zero-primary-e2e-gap.md`) is the zero-primary FALLBACK TO THE
LANDLORD OF RECORD having no e2e path. Section 10's seam builds "no landlord of record, one
non-primary contact" - P1 leg 2 (fallback to a live landlord) is never exercised. Either add a
landlord-bearing zero-flag shape to the seam or do not close item 1.

## F14. [LOW] The 409 for a "missing" contact cannot happen, and its order on the route is unstated

P2: `primaryContact: true` "on a soft-deleted or missing contact is refused with 409". The add route
already answers 404 `contact_not_found` for a missing contact before anything else
(`routes/units.ts:1097-1100`). Caseworker-integrity also fixes a check order on this route
(`contact_list_caseworker`, then `landlord_not_landlord`, branch spec "Contact list (I4)"); where
`primary_contact_deleted` falls in that order is not stated.

## F15. [LOW] 7.3's no-heir notice and the `property_contact_no_first_name` line can both be false

- No heir: "New tours won't include a landlord". `primaryHeirContactId` is null when P3 skips an
  OFF-roster live landlord (P3 step 1 "AND it has a roster row"), yet P1 after the removal still
  resolves that landlord (P1 leg 2 has no roster-row condition). The notice should be driven by "P1
  after removal", not by "heir is null".
- `property_contact_no_first_name`: "The primary contact has no first name saved." P1 may have
  resolved to the landlord of record via the fallback, who is not the primary.

## F16. [LOW] Unenumerated dashboard readers of the primary flag re-derive the rule 7.5 says the dashboard never re-derives

- People card suggestions offer every property roster row, deleted ones included, and label the
  flagged row "- primary contact" (`rosterPeople.ts:105-115`, `PeopleCard.tsx:685-687`). After this
  change rows carry `deleted`; the suggestion list is the one-click UI route into the 9.3 defect
  (a deleted contact added to a tour plan is provisioned and texted).
- The property facts subline picks "the primary row's company" (`ListingDetail.tsx:291`).

Neither is in 9.2. G2 ("everywhere ... through ONE shared function") and 7.5 ("the dashboard never
re-derives either rule") are not true while these stand.

## F17. [LOW] P4's scalar invariant is "(unchanged)" but does not hold today and is not restored

P4: "the scalar equals the primary row's contactId or is absent (unchanged)". `addContact` never
removes the scalar when its write leaves no primary (`unitsRepo.ts:815-824`, "never blank it
here") - the hole P2 itself describes. P2 only re-promotes a LIVE re-added contact, so an API re-add
of a deleted current primary with `primaryContact: false` still leaves zero flags and a stale scalar.
No runtime reader (9.2, confirmed), hence LOW; but the invariant as written is false.

## F18. [LOW] Minor contradictions and gaps

- 5.1: "ALL property-side and time-side checks are evaluated" vs "`lookup_failed` stands alone when
  the owner or unit read fails (the other checks have nothing to read)". On a unit failure the tour
  reasons (`tour_not_scheduled`, `tour_started`) are still decidable from the tour.
- Section 8 "lock" is undefined. The `clean-org-names.ts` lock is the organization-list rewrite
  lock (`app/scripts/clean-org-names.ts:37-45`), which has nothing to do with unit rosters.
- Section 8 audit `{ contactId, reason }`: the unit Activity projection is a fixed-key whitelist
  with no `reason` key (`routes/units.ts:217-248`), so "the Activity tab explains every primary
  change" needs that projection widened; the spec defers it to the plan without saying so.
- The delete fan-out adds a full units-table Scan to EVERY contact delete, tenants and unknowns
  included, synchronously in the request. The cited precedent (`caseworkerConversion.ts:243-256`) is
  a rare admin action. A one-line note on cost, or skipping the Scan for contacts that cannot be on
  a roster, belongs in the spec.
