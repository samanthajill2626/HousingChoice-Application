# Tour / placement contact rosters - design

- Date: 2026-08-04
- Version: v3 (post two adversarial reviews; v3 adopts the plan/fact
  restructure and the reminder-suppression rule - founder calls 2026-08-04)
- Branch: `feat/contact-rosters` (worktree `w:/tmp/contact-rosters`), cut from main @623ec4e1
- Status: approved design, ready for an implementation plan
- Follows: the contact-comms-pane mission (merged @83f5db0a), whose last fix
  (@8ba1bd20) made the "Group text opened" pin follow the roster actually
  provisioned instead of the two tour parties. That fix exposed the gap this
  spec closes: the roster itself is resolved wrongly.

## 1. Problem

A group text for a tour or placement is composed from exactly two things: the
tenant, and the scalar `unit.landlordId` (`app/src/routes/tours.ts`
`resolveTourMembers`, and the equivalent inline block in
`app/src/routes/placements.ts`). That is the owner of record. When a property
manager runs the property, the group text still goes to the owner, and the
navigator has no way to change it:

- The unit already carries a richer roster - `UnitContact { contactId, role:
  'landlord' | 'pm' | 'owner' | 'other', primaryVoice, name?, company? }`
  (`app/src/repos/unitsRepo.ts`) - and roster resolution ignores it entirely.
- That roster has full server CRUD (`addContact` / `removeContact`, with an
  at-most-one-primary invariant and a protected landlord of record) and a
  READ-ONLY card on the property page. No dashboard code writes it, so in
  practice every property has one roster row: the owner, synthesized from
  `landlordId`.
- `POST /api/tours/:tourId/relay` accepts an explicit `members` array, but the
  dashboard never sends one (`dashboard/src/routes/tours/TourDetail.tsx` calls
  `createTourRelay(tourId)` with no roster).
- `addRelayMember` / `removeRelayMember` exist server-side AND in the dashboard
  API client, and are called from nothing.
- `tourType` ('self_guided' | 'landlord_led' | 'pm_team') has no effect on
  roster resolution at all.
- The tour page's People card already asserts what is not true: it labels the
  row `isPm ? 'Property manager' : 'Landlord'` from the tour type while
  rendering the contact behind `unit.landlordId`. On a PM-team tour it prints
  "Property manager: <owner of record>".

The product goal, in the founder's words: be able to adjudicate who the
contacts on a tour or placement are, so that when a group text is opened the
right people are already on it - and see who will be added before opening, so
a wrong roster can be corrected first.

## 2. Goals

1. The roster is correct BY DEFAULT for a PM-managed property, not correctable
   by hand tour by tour.
2. A tour or placement can deviate from the property default, visibly and
   reversibly.
3. Nothing is texted to real people without the operator having seen who will
   receive it and what it says.
4. One list. The People card, the 1:1 tabs, the live group roster, and masked
   call routing never disagree.

## 3. Non-goals

- Structured tenant-side support contacts. The tenant's `caseworker` field
  stays a free-text name and is surfaced only as a hint (section 6.2). File an
  issue for the structured version.
- Separate voice and text designations on a property. Decided against: one
  `primaryContact` covers both (D2, D10).
- Per-recipient timezones. `resolveQuietHoursTimezone` keeps its org-level
  seam.
- Any change to how `landlordId` itself is assigned.

## 4. Decisions

### D1. PLAN vs FACT: the override is the plan; the thread's participants are the fact

The roster has exactly one source of truth at any moment, and WHICH source is
determined by one question: does a relay thread exist for this owner?

NO THREAD YET (the roster is a PLAN):

- `roster` override absent - the normal state - means "resolve from the
  property": tenant + the unit's primary contact (D3). A property whose
  management changes is immediately correct on every tour that never deviated.
- The override MATERIALIZES on the first human edit (add or remove), via the
  conditional-write discipline in section 7. From then on the override IS the
  plan, and it persists until "Reset to property default" - it never
  auto-clears when its contents happen to match the default again.

A THREAD EXISTS (the roster is a FACT):

- The moment a group thread exists for the owner - in ANY status: open,
  connecting, or closed - `relay.participants` on that conversation is the
  roster. The card, the 1:1 tabs, the customized-note comparison, milestones,
  and call routing ALL read it. Participants already carry `contactId` per
  member (`app/src/repos/conversationsRepo.ts`), so nothing needs to be copied
  to render any surface.
- The override is CONSUMED at provision: the group is provisioned from the
  plan, and the `roster` attribute is deleted in the same flow, after the
  provision succeeds. A failed provision leaves the plan intact. There is no
  path from thread-exists back to no-thread, so the two states never blur.
- Every membership change on a thread-bearing owner goes through the
  add/remove call-through (D5), which edits the participants directly. There
  is NO tour-side copy to keep in sync - the dual write does not exist.
- A CLOSED thread still counts. Reopen is a pure status flip
  (`app/src/routes/relayGroups.ts`) - no confirm, no intro, participants
  untouched - so a close-edit-reopen sequence must land its edits on the
  participants, not on a plan that reopen would ignore. Edits to a closed
  thread's participants are silent (nothing sends to a closed group). "Reset
  to property default" is disabled whenever a thread exists, with the reason.

This restructure is what makes goal 4 an invariant rather than a slogan: there
is never a second persisted roster to disagree with the first. Legacy groups
(dev has several, some with bare-phone members) need NO backfill and NO
migration - their participants are already the truth, and every surface reads
them where they live.

The "customized" note is driven by COMPARISON, not by which source is active:
it appears when the current roster (plan or fact) differs from what the
property would resolve to right now. Equality is defined in 5.2.

Rejected: a snapshot copied at tour creation (every property correction has to
be chased across every existing tour); property-level only (no way to handle a
one-off without editing the property); and v2's materialize-on-open (a second
persisted roster after open, which meant a GET-path backfill write, an
unspecified dual-write failure mode on every live edit, and drift the moment
anything edited participants without going through the card).

### D2. `primaryVoice` becomes `primaryContact`, storage keys included

The flag today means "the landlord-side person a masked tenant->landlord CALL
routes to." It becomes "the property's default contact - the person who is put
on the group text and reached by a masked call." The name must change with the
meaning.

- `UnitContact.primaryVoice` -> `UnitContact.primaryContact`
- unit scalar `primary_voice_contact` -> `primary_contact`
- `CannotRemovePrimaryLandlordError` -> `CannotRemoveLandlordOfRecordError`
- `409 cannot_remove_primary_landlord` -> `409 cannot_remove_landlord_of_record`
- message -> "cannot remove the unit's landlord of record; reassign landlordId
  first"

Renaming the persisted keys is safe now and only now: prod is not live (cutover
rides M1.11) and dev is reseedable. No seed file sets the flag (seeded units
carry `landlordId` and get the synthesized single-row roster), so there is no
fixture churn.

The unit ends with two clearly distinct roles: the LANDLORD OF RECORD
(`landlordId` - who owns it, may not be removed from the roster) and the
PRIMARY CONTACT (`primaryContact` - who we put on threads and dial). The rename
removes the collision rather than documenting around it.

`app/src/routes/webhooks/voice.ts` reads this field to route live masked calls.
The rename therefore lands as its own purely mechanical commit with gates green
before any behavior change, so a reviewer can never mistake a rename slip for
an intentional routing change. The same commit updates the STALE comment at
`voice.ts:388` (the future "main-business-number -> landlord-by-unit" note,
which still says `primary_voice_contact`). `documentation/GLOSSARY.md` is
updated in the same commit.

### D3. Resolution: tenant + the property's primary contact

`resolveTourMembers` and the placement equivalent become:

- a thread exists -> the participants are the roster (D1); resolution is only
  consulted when there is no thread
- override present -> the override is the roster, in stored order
- override absent -> `[tour.tenantId, unitContactsOf(unit).find(primaryContact)]`
- FALLBACK: when NO roster row carries `primaryContact` (zero-primary is legal
  and reachable, 5.1), fall back to the LANDLORD OF RECORD (`landlordId`) -
  exactly today's behavior, so no working property regresses to too-thin.

`tourType` never affects ROSTER resolution. It describes who conducts the
showing; if a PM runs the property they are the primary contact regardless of
one tour's type. The People card's existing type-derived label is deleted
(6.2).

CAVEAT, so nobody "simplifies" it away: `tourType` DOES still gate reminder
ROUTING - group-routed rungs are for `landlord_led` / `pm_team`, and
`self_guided` reminders go to the tenant 1:1 (`app/src/routes/relayGroups.ts`,
`app/src/jobs/tourReminders.ts`). That gate is untouched by this spec (but see
D11 for the one new suppression).

Landlord resolution for MILESTONES is unchanged and stays point-in-time, as
`app/src/lib/personEvents.ts` documents. Milestones are DUAL-PARTY (tenant +
the unit's landlord at event time) regardless of the roster - so a tenant
REMOVED from the roster still receives every lifecycle pin (D6).

### D4. A placement inherits the tour's roster at conversion

`app/src/routes/placements.ts` already re-parents the tour's relay thread to
the new placement with its members preserved (`rebindOwner`). Under D1 that IS
the inheritance for every thread-bearing tour: the participants ride the
rebind, and the placement reads them like any other thread-bearing owner.
Nothing is copied, so a legacy tour that was never loaded before converting is
handled identically - there is no backfill step for conversion to dodge.

When the tour has NO thread but HAS a plan override, conversion copies the
override onto the placement. No thread and no override -> the placement
resolves from the property like any directly-created placement.

Conversion ALSO migrates any pending roster action (5.3) to the placement,
alongside `rebindOwner`. A deferred "open the group at 8:00 AM" must not die
because the tour converted at 7:00 AM.

### D5. The People card is the roster editor; every action persists on click

"Edit" flips the card into edit mode. Each add and each remove persists the
moment it is clicked. "Done" is a view toggle and nothing more - navigating
away can never lose a change, because there is never a pending one.

Where the write lands follows D1:

- no thread -> the edit writes the PLAN (materialize-on-first-edit, then the
  per-member change; section 7)
- a thread exists (any status) -> the edit IS a relay participants edit
  (call-through; section 7). There is no second write.

### D6. ONE membership. Anyone can be removed, including the tenant

There is exactly one question about a person: are they on this roster or not.
Being on it means a row on the card, a 1:1 tab, a seat on the group text, and
a leg on a masked call. There is no second "on the tour but not on the text"
state - two overlapping membership concepts is precisely the drift this spec
exists to remove.

THE TENANT CAN BE REMOVED like anyone else. A caseworker handling all landlord
contact on the tenant's behalf is a real arrangement, and the roster should be
able to say so plainly.

What removal does NOT change:

- `tour.tenantId` still records WHOSE tour it is. The roster answers a
  different question - who we communicate with about it.
- MILESTONES ARE UNAFFECTED. They are dual-party by rule (tenant + the unit's
  landlord at event time, `app/src/lib/personEvents.ts`), independent of the
  roster, so a removed tenant's timeline still receives every lifecycle pin.
- Their 1:1 conversation survives in full on their contact page.

What removal DOES change, deliberately: reminders stop (D11), their 1:1 tab on
the hub page drops, and a masked call from their number is refused as a
non-member (existing behavior, `app/src/routes/webhooks/voice.ts` refusal
cases). What is lost, knowingly: the tenant can no longer be off the group
text while keeping a 1:1 tab on the tour page. If that arrangement turns out
to matter, the answer is to add them back, not to reintroduce two states.

The only floor: THE LAST MEMBER CANNOT BE REMOVED (an empty roster is
unreachable, `[]` is never stored, and a thread's participants never go
empty). A single-member roster is legal but cannot open a group text - see the
too-thin rule in 6.2.

DELIVERABILITY IS NOT MEMBERSHIP. A member with no mobile number, or one who
has sent STOP (member-level opt-out suppresses that leg at send time,
`app/src/routes/relayGroups.ts`), is fully on the roster and keeps their tab -
their row is muted with the reason, and they are excluded from the SMS fan-out
and from the confirm dialog's recipient count. These states are DERIVED at
read time and never stored, so a contact who gains a number or revokes STOP
needs no roster edit.

### D7. Quiet hours defer membership AND message together

The existing rule is unchanged and is not being carved out: a message a human
WROTE sends now; a message the system writes on their behalf waits. Pressing
"Send now" on a specific message is what flips `automated: false`
(`app/src/jobs/tourReminders.ts`); editing a roster is not that.

Both system-authored sends in this feature defer to quiet-end:

- opening a group text (fires `relay.intro` to everyone)
- adding a member to an open group (fires `relay.member_added` to everyone)

and in both cases the MEMBERSHIP defers with the message, so nobody receives a
group text before being introduced and no surface has to pretend. The pending
state is visible on the card with an explicit human override.

REMOVAL is immediate and never defers: `app/src/routes/relayGroups.ts` drops a
member silently (audit + a `removed_from_group_text` milestone on that
contact), sending nothing to anyone.

A deferred action resolves AT APPLY TIME, not from an 11pm snapshot: a
deferred open provisions from the plan as it stands at apply (which is also
when the plan is consumed, D1), and a deferred add applies against the
participants as they stand. The card is the consent surface while an action is
pending, and it shows the current roster; the latest intent wins.

REMINDER INTERACTION - the cheap position is ACCEPTABLE, decide in the plan:
ideally a tour with a PENDING `open_group` defers its group-routed reminder
rungs until the open applies rather than falling back to the tenant 1:1
(`app/src/jobs/tourReminders.ts` `resolveUsableGroup`). But "wait" is a NEW
ladder state - the ladder is claim-and-skip, so waiting needs a re-trigger
when the open applies, prompt fallback when the pending open is canceled, and
a staleness bound so a `morning_of` rung cannot fire after the tour started.
If that machinery does not fall out cheaply, ACCEPT the nondeterminism and
document it - it is not dangerous, because membership defers with the intro,
so nobody can receive a group text before being introduced. Slice 6 must not
burn its budget here. Either way, note: while an open is pending, the Upcoming
mirrors (contact timeline `upcoming[]`, the relay scheduled bucket) will show
group-eligible rungs as tenant-1:1-bound - accept the cosmetic inaccuracy.

### D8. Placement group-open pins the same milestone tours do

Placement group provisioning records no person milestone today. It records
`placement_group_opened` ("Group text opened") through
`recordRosterMilestone`, on the same roster-driven rule as
`tour_group_opened`. Add `placement_group_opened` to `ActivityEventType`.

DELIBERATE, do not "fix" in the build: a member who is unreachable at open (no
phone, opted out) is not in the provisioned fan-out and gets NO
`added_to_group_text` / group-open pin. Pins are facts about texts; a pin
claiming someone joined a conversation they cannot receive is false (the same
rule `routes/relayGroups.ts` already applies to bare-phone members).

### D9. The property roster editor is in scope

The default is "the property's primary contact," and there is no UI to set it.
Without the editor the default stays wrong for exactly the properties that
motivated this work, and the tour-level override becomes the primary workflow
rather than the exception. The server endpoints are finished; this is a UI
build against them, and `primaryContact` should become editable in the same
mission where it gains its second meaning.

SEQUENCING CONSTRAINT (section 8): the editor makes `primaryContact` settable,
and until the D10 substitution is deleted, that flag live-re-points placement
masked calls at call time while texts still follow `landlordId`. The editor
therefore lands AFTER the substitution removal and the resolution switch -
never before - or the mission itself ships a voice/text split.

### D10. Masked calls ALREADY follow the thread's roster - retire the one override

Masked-call bridging is not being re-pointed. It already resolves from the
thread's own roster (`app/src/routes/webhooks/voice.ts`):

```
const roster  = relay.participants ?? [];
const caller  = roster.find((m) => m.phone === From);
const callees = roster.filter((m) => m.phone !== From);
...
for (const callee of callees) { dial.number({ ... }) }
```

The call arrives on the relay group's OWN pool number, so the tour or placement
is unambiguous - the number IS the thread - and every other member is dialed
simultaneously. DO NOT "improve" this into a single side-based counterpart:
ringing all other members is deliberate and must be preserved.

The ONE deviation is the `landlordVoiceOverride` block (voice.ts:850-891,
920): on a PLACEMENT-linked relay, when the caller is the placement's tenant,
the leg whose `contactId === unit.landlordId` has its dial number swapped for
the unit's `primary_voice_contact` (roster number as fallback).

Precisely because the leg is identified by the LANDLORD's contactId, the harm
case is narrow but real: on the motivating override (owner removed, PM added)
the substitution already no-ops - no participant carries the landlord's
contactId. It bites when the owner is KEPT on the roster: their leg is
silently re-pointed at the primary contact's phone, dialing someone the
operator did not put in that slot (and double-dialing the PM when the PM is
also a member). It also only earns its keep if voice and text can point at
different people, which the one-`primaryContact` decision (D2) rules out.

So: THE SUBSTITUTION IS RETIRED, and nothing else about call routing changes.
The self-bridge guard, the refusal cases (closed thread, non-member caller, no
callee, no pool number), the whisper/press-1 gate, and the never-crash-on-
resolution posture are all preserved verbatim.

Consequence, for free: a roster edit moves CALLS as well as texts, because the
participants the card edits are the same participants the bridge already
reads.

### D11. Reminders respect the roster: a removed tenant is not texted

Tour reminder rungs are keyed to `tour.tenantId`, not the roster: `self_guided`
rungs route to the tenant 1:1, and group-routed rungs FALL BACK to the tenant
1:1 when no usable group exists (`app/src/jobs/tourReminders.ts`). Without a
rule, the caseworker-to-PM arrangement - tenant deliberately removed - still
texts the removed tenant "your tour is tomorrow," which contradicts what
removal means (D6).

New rule: WHEN `tour.tenantId` IS NOT ON THE CURRENT ROSTER (fact if a thread
exists, else plan/default), EVERY TENANT-1:1-ROUTED RUNG IS SUPPRESSED with a
visible skipped row, reason `tenant_not_on_roster` - following the
arm/claim-time retirement pattern the quiet-hours work established (skips are
visible, never silent). Group-routed rungs are unaffected (they go to the
group, which is exactly the people the operator chose). Placement nudges get
the same rule for their tenant-1:1-routed rungs.

Re-adding the tenant lifts the suppression for rungs not yet claimed - the
check runs at claim time, so no re-arm step is needed.

## 5. Data model

### 5.1 Unit (unchanged except the rename)

```
UnitContact {
  contactId: string
  role: 'landlord' | 'pm' | 'owner' | 'other'
  primaryContact: boolean   // renamed from primaryVoice
  name?: string             // denormalized at write time
  company?: string
}
```

Invariants stay EXACTLY as built - do not "restore" one that never held:

- AT MOST ONE `primaryContact` across the roster. Zero is legal and reachable:
  `unitsRepo.removeContact` clears the flag entirely when the primary is
  removed and there is no `landlordId` to promote. (Resolution's fallback for
  the zero case is D3.)
- Removing the current primary AUTO-PROMOTES the landlord of record when one
  exists, and the unit scalar follows. This silently re-points live call
  routing, so the editor UI must SURFACE it (6.1) rather than merely allow it.
- The landlord of record cannot be removed (reassign `landlordId` first).

### 5.2 Tour / placement plan override

```
RosterEntry {
  contactId?: string          // preferred
  phone?: string              // E.164; only for a member with no contact
}

roster?: RosterEntry[]        // absent = resolve from the property
```

VALIDATION: exactly ONE of `contactId` / `phone` per entry - `{}` is rejected,
and an entry carrying both is rejected (the contact's current phone is always
resolved at use time; a pinned copy would go stale).

SCOPE: the override exists only while NO thread exists (D1). It is consumed
(deleted) when the group is provisioned. There is no per-member membership
flag: presence IS membership (D6). Deliverability (`no_phone`, `opted_out`) is
derived at read time and never stored.

`contactId` is preferred and is what the card, the tabs, and milestones key
on. Phones and display names for contact-backed members are resolved AT USE
TIME, so a corrected phone number is picked up everywhere with no migration
and no stale denormalized copy.

Order is preserved; the tenant is first when present.

CUSTOMIZED-NOTE EQUALITY (used for plan AND fact comparisons): order-
insensitive set comparison; contact-backed entries compare by `contactId`,
bare-phone entries by E.164 phone. A legacy thread with bare-phone
participants will therefore read "Customized" indefinitely (nothing in the
property default matches a bare phone) - accurate, and expected in dev.

DANGLING IDS: a contact deleted while on a roster (plan entry or thread
participant) keeps its row. The row renders as "removed contact," is excluded
from every send and from call routing, and gets no 1:1 tab. It is removable
like any other member.

SHARED NUMBERS: two roster members can resolve to the same phone (relay
resolution already de-dupes by phone). The card marks the second "shares a
number with <name> - one message" rather than hiding the collapse, so the
recipient count never silently disagrees with the row count.

Role labels in the card are derived, never stored:

- `contactId === tour.tenantId` -> "tenant"
- on the unit roster -> that roster row's role ("PM", "landlord of record", ...)
- otherwise -> "added"

### 5.3 Pending roster action

```
PendingRosterAction {
  ownerType: 'tour' | 'placement'
  ownerId: string
  action: 'open_group' | 'add_member'
  contactId?: string        // add_member only
  dueAt: string             // ISO; quiet-end
  reason: 'quiet_hours'
  status: 'pending' | 'applied' | 'skipped' | 'canceled'
  skippedReason?: SkipReason
}

SkipReason =
  | 'group_closed'
  | 'owner_canceled'          // tour canceled / placement closed
  | 'already_member'
  | 'contact_deleted'
  | 'member_no_longer_on_roster'   // removed while the add was pending
  | 'roster_too_thin'              // lost its second reachable member
  | 'converted'                    // only if migration to the placement failed
```

Applied by the worker at `dueAt`, following the reminder ladder's
claim-and-skip discipline. An action whose world moved underneath it resolves
to a VISIBLE skipped row with its reason, never a silent disappearance (the
precedent set by the quiet-hours arm-time retirements).

DEDUPE, enforced by conditional create: at most one PENDING `open_group` per
(ownerType, ownerId), and at most one PENDING `add_member` per (ownerType,
ownerId, contactId). A duplicate confirm SUPERSEDES the earlier pending action
(new dueAt), never queues a second - otherwise the second apply would resolve
to a spurious `already_member` skipped row.

Cancelling is explicit; forcing is "Add now" / "Send now anyway", which
applies immediately with `automated: false`.

This is a NEW PERSISTED FAMILY with a due-time poller - a new table (or item
type plus GSI) following `tourRemindersRepo`'s pattern. See section 11 for the
ops it implies.

## 6. Surfaces

### 6.1 Property page - Contacts card becomes editable

Read mode is unchanged: name, role, company, the primary marker, rows link to
the contact. "Edit" flips it:

- per-row remove (the landlord of record's remove is disabled, with the reason)
- per-row "make primary contact"
- role selector per row
- "+ Add contact" - contact search, then role
- "Done" returns to read mode

Removing the current primary contact confirms first and NAMES THE PROMOTION:
"Marcus Webb becomes the primary contact - calls and new group texts for this
property will go to him." Silently re-pointing live call routing is not
acceptable.

Every action persists on click, against the existing endpoints. A
`409 roster_conflict` refetches and re-renders - and THE ROW THE OPERATOR JUST
TOGGLED VISIBLY SETTLES into its true state, so a lost race never reads as a
dead click.

### 6.2 Tour / placement page - People card becomes the roster

Read mode:

```
People                          on this tour - Edit
Tasha Nguyen                                 tenant
Alicia Grant                                     PM
D. Okafor                          caseworker - added
-------------------------------------------------
Property        1428 Oak St SE   [2 BR] [$1,450/mo]
```

- People are a list; role is subtle on the right. NO phone numbers.
- The rows come from the CURRENT source per D1: thread participants when a
  thread exists (any status), else the plan override, else the property
  default.
- The Property row (and the placement's "converted from tour" provenance row)
  stay below a divider - they are not people.
- The type-derived "Property manager" / "Landlord" key is DELETED. Role comes
  from the roster now, so the card can no longer claim a PM and render an
  owner.
- When the tenant has a non-empty `caseworker` name on file, an italic hint
  reads "Caseworker on file: D. Okafor - not a contact record." Always shown
  when the field is set (matching a free-text name against contact records is
  guesswork; the hint is a nudge at the moment of review, not an affordance).
- A member the group text cannot reach renders muted with the reason: "not on
  the group text - no mobile number" / "- opted out". They are still on the
  roster and still have a tab (D6).
- When the roster differs from the current property default (equality per
  5.2): "Customized for this tour - the property's default is <name>. Reset
  to property default." Reset is DISABLED whenever a thread exists (any
  status), with the reason.
- When the tenant is not on the roster: a muted note "Tenant is not on this
  roster - tour reminders are paused" (D11), with the one-click restore in
  edit mode.
- When fewer than two members are reachable by SMS: "Not enough people to open
  a group text - two reachable members are needed," and [Open group text] is
  DISABLED with that reason rather than failing at click time with today's
  `400 relay_member_unresolvable`. The route keeps its guard regardless.

Edit mode:

- per-row remove, anchored to the NAME line. ANY member is removable, the
  tenant included (D6); only the LAST remaining member's remove is disabled,
  with the reason.
- inline suggestions for the people who belong here but are not on the roster -
  the property's other roster members AND any missing structural party:
  "Also on this property: Alicia Grant - PM - primary contact  [+ Add]",
  "On this tour: Tasha Nguyen - tenant  [+ Add]". This is what makes the
  common swap two clicks, and what makes a removed tenant one click to
  restore.
- "Add any contact..." - general contact search
- rows are NOT links while editing
- "Done" returns to read mode

### 6.3 Pre-open confirm

Opening shows: the members who will be added, PER-MEMBER DELIVERABILITY, the
recipient count, and THE INTRO BODY THE GROUP WILL ACTUALLY RECEIVE. The body
is composed SERVER-side from the `relay.intro` catalog entry and returned by a
preview endpoint. It is never rebuilt in the browser - the template is
founder-editable in Settings, and a client-side copy would drift the first
time it is edited.

Per-member deliverability is the point of goal 3: an opted-out member's leg is
suppressed at send time, so a bare "3 recipients" would be a lie. The dialog
lists who receives it and who does not, with the reason.

The preview response also carries the QUIET-END INSTANT when the send would
defer - the server owns the DST-safe window math (`lib/quietHours.ts
instantAtLocalTime`); the client never re-derives it.

Outside quiet hours: [Cancel] [Open group text].
Inside quiet hours: the window is named, and the buttons are
[Cancel] [Send now anyway] [Open at 8:00 AM] (default).

### 6.4 Add-to-live-group confirm

Same shape, showing the `relay.member_added` body, per-member deliverability,
and the recipient count. Buttons: [Cancel] [Send now anyway]
[Add and notify at 8:00 AM].

Pre-open (no thread yet), adding and removing are silent and confirm nothing -
nothing has been sent and the roster is only a plan.

### 6.5 Pending state on the card

```
Alicia Grant                                     PM
  Joins at 8:00 AM - quiet hours
  Add now - Cancel
```

and for a deferred open, the same treatment on the [Open group text] control:
"Opens at 8:00 AM - quiet hours. Send now - Cancel."

A skipped action leaves a visible row with its reason until dismissed.

### 6.6 Tabs

- `TourPersonKey = 'tenant' | 'landlord'` retires; channels key on
  `contactId`, one 1:1 tab per contact-backed roster member (current source
  per D1), plus the group tab. Bare-phone and deleted-contact entries get no
  tab.
- The rail is ONE ROW and scrolls horizontally when it overflows, with an edge
  fade marking the overflow. If an off-screen tab has unread, THE FADE CARRIES
  THE UNREAD DOT, so a reply never hides past the edge.
- Removing a member drops their tab; SELECTION LANDS ON THE GROUP TAB when the
  removed member's tab was active (and on the first tab when there is no
  group). The conversation itself survives on their contact page.
- The mark-read gating built last mission (`commsVisible`,
  `timeline.status === 'ready'`, foreground visibility, loaded contact) is
  preserved verbatim per tab. Do not weaken it.

### 6.7 Narrow viewport (REQUIRED, not a nicety)

Below the 860px `twoPaneShell` breakpoint:

- role wraps UNDER the name whenever the pair does not fit on one line
- the remove control anchors to the name line so it does not move when the
  role wraps; the touch target is the full row (min 44px), not the glyph
- confirm dialog buttons stack full-width, default on top, same order as
  desktop
- the tab rail scrolls on one row (never wraps to two)

Every surface in this spec is verified at 360px in the Playwright harness
before the branch is done.

## 7. Server changes

RESOLUTION

- One shared resolver: thread participants when a thread exists (any status),
  else the plan override, else tenant + `primaryContact` with the
  landlord-of-record fallback (D3). The group fan-out set is the reachable
  subset (phone present, not opted out).
- Conversion: thread-bearing tours need nothing beyond the existing
  `rebindOwner`; plan-only tours copy the override; pending actions migrate
  (D4).

PLAN WRITES - per-member, never a whole-array PATCH

Plan edits are PER-MEMBER endpoints on the tour/placement (add one, remove
one, reset to default). Remove refuses the LAST member (409). The exact
sequence, because this is the one place a whole-array write will sneak in:

1. If no override exists, MATERIALIZE it with a conditional write
   (`attribute_not_exists(roster)`) holding the currently resolved roster.
2. On the condition failing, re-read and continue onto the EXISTING override -
   never overwrite it.
3. Apply the single member change with an optimistic-concurrency guard,
   retrying a bounded number of times, then `409 roster_conflict`.

These endpoints REFUSE (409) when a thread exists - thread-bearing owners are
edited through the call-through below, and the dashboard routes accordingly.

CALL-THROUGH (a thread exists, any status)

- Add: `addRelayMember` (deferring per D7 when the thread is open and quiet
  hours hold; a closed thread's add is silent and immediate).
- Remove: locate the participant row BY `contactId` and delete using THE PHONE
  STORED ON THAT ROW. `DELETE /api/conversations/:id/members/:phone` is
  phone-keyed, so a re-resolved phone silently no-ops when a contact's number
  was corrected after they joined.

PROVISION (open)

- Provision from the plan; on success, delete the `roster` attribute in the
  same flow (the plan is consumed, D1). On failure the plan is untouched.

PREVIEW

- New endpoints returning the SERVER-composed `relay.intro` and
  `relay.member_added` bodies for a given owner and prospective roster, plus
  per-member deliverability (`reachable` / `no_phone` / `opted_out`), the true
  recipient count, and the quiet-end instant when the send would defer.

VOICE (D10)

- `app/src/routes/webhooks/voice.ts`: DELETE the `landlordVoiceOverride` block
  (and the units/placements reads it exists for) so the roster's own number is
  dialed. Everything else in the bridge path is untouched - callee selection,
  simultaneous ring, refusal cases, whisper gate, self-bridge guard.

QUIET HOURS

- Evaluation on the open and add paths, writing a `PendingRosterAction`
  instead of sending; a worker poller applies them with claim-and-skip.
- The reminder coupling per D7: attempt "pending open -> wait" only if it falls
  out cheaply; the accept-and-document position is pre-approved.

REMINDERS (D11)

- A claim-time check in `tourReminders` (and placement nudges): tenant-1:1-
  routed rung + tenant not on the current roster -> visible skipped row,
  reason `tenant_not_on_roster`. No re-arm step; re-adding the tenant lifts
  the suppression for unclaimed rungs automatically.

MILESTONES

- `placement_group_opened` added to `ActivityEventType`, recorded via
  `recordRosterMilestone` over the PROVISIONED (reachable) members only (D8).

## 8. Slices

Each slice ends green (`npm run typecheck` + `npm test` + targeted e2e) and is
independently reviewable. The mission can stop cleanly between any two. The
ordering rule: ROUTING UNIFIES BEFORE ANYTHING CAN SPLIT IT - the tabs
refactor lands before resolution changes (so card and tabs move together), and
the property editor lands after the D10 removal (so `primaryContact` cannot
re-point calls while texts still follow `landlordId`).

1. RENAME. `primaryVoice` -> `primaryContact`, scalar, error class, 409 code,
   the stale `voice.ts:388` comment, glossary. Purely mechanical, no behavior.
2. TABS REFACTOR (mechanical). Retire `TourPersonKey`; key the rail and
   channels on the CURRENT resolution output (today: the same two people, so
   no visible change); scrolling rail with edge fade and carried unread dot;
   selection-on-remove rule. Pure re-plumbing ahead of the semantic switch.
3. ROSTER MODEL. Plan override + validation, the shared resolver (participants
   / plan / default + fallback), provision-consumes-plan, conversion
   inheritance + pending-action migration hooks, derived roles, deliverability
   states, caseworker hint, the read-only People card on both hubs, D11
   reminder suppression, `placement_group_opened`, AND the D10 substitution
   removal. Card and tabs switch source together here.
4. PROPERTY ROSTER EDITOR. Edit mode on the property page's Contacts card,
   including the promotion confirm and the 409 settle. Safe now: routing is
   unified, so making a PM primary moves card, tabs, texts, and calls as one.
5. CARD EDIT MODE + CONFIRMS. Per-member plan endpoints with the materialize
   discipline, call-through, preview endpoints (bodies, deliverability,
   quiet-end), both confirm dialogs, the too-thin disabled state.
6. DEFERRED OPEN + ADD. `PendingRosterAction` + dedupe, the poller, pending
   rows, visible skipped rows, "Send now anyway", and the reminder-wait
   coupling ONLY if cheap (D7).

## 9. Testing

- Unit: the shared resolver (thread present / plan / default, zero-primary
  fallback to landlord of record, tenant === primary de-dupe, shared phone,
  dangling contactId, deliverability derivation); the rename; derived role
  labels; customized-note equality (order-insensitive, bare phones); the
  quiet-hours evaluation of both actions.
- Voice: the EXISTING masked-bridge tests are the regression net for D10 and
  must keep passing unchanged - callee selection from the roster, simultaneous
  ring of every other member, and all four refusal cases. Add: (a) an
  owner-kept-on-roster case proving their own number is now dialed where the
  retired substitution would have re-pointed it; (b) a REMOVED tenant's call
  is refused as `non_member` (API tier, `twilioWebhookHarness` - voice is not
  exercisable from the Playwright lane).
- API: property roster CRUD including the landlord-of-record 409, the
  at-most-one-primary behavior and the auto-promotion; plan round-trip +
  entry validation (exactly one of contactId/phone); the materialize-then-
  apply race (two concurrent first edits must not clobber); plan endpoints
  refuse when a thread exists; provision consumes the plan (and does NOT on a
  failed provision); closed-thread edits land on participants and reopen
  reflects them; conversion for thread-bearing AND plan-only tours; pending-
  action migration; removal by participant row when the contact's phone
  changed after joining; preview endpoints (catalog-composed bodies, per-
  member deliverability, quiet-end instant); pending-action dedupe/supersede
  and EVERY skip reason; D11 suppression (skip row appears; re-adding the
  tenant lifts it for unclaimed rungs). Clocks are PINNED - never wall-clock
  (the `morning_of` 00:00-08:00 flake is the standing lesson).
- Component: People card read and edit modes across all three sources
  (participants / plan / default); the comparison-driven customized note;
  reset disabled whenever a thread exists; muted deliverability rows; the
  tenant-not-on-roster note; the disabled Open state; both confirms; the tab
  rail incl. selection-on-remove.
- E2E: the swap-the-landlord flow end to end (property has a PM -> tour
  defaults to the PM -> override on one tour -> open the group -> verify the
  participants on the conversation); a tour whose TENANT has been removed -
  the caseworker-to-PM arrangement - proving reminders show the visible
  paused/skip state, lifecycle milestones still pin to the tenant's timeline,
  and one click restores them; the quiet-hours deferral including "Send now
  anyway"; assert sent bodies and recipients via `GET /__dev/outbox`; a 360px
  pass over every surface.
- Seed: the FULL profile gains a PM-managed property (owner of record plus a
  PM marked `primaryContact`) so the default-is-the-PM case is exercised.
  `app/src/lib/seed/lean.ts` is byte-stable and is NOT touched.

## 10. Risks

- The rename touches live masked-call routing, and slice 3 deletes the one
  override in that path. Both are small and separately gated, and both want a
  live dev smoke call after they land - green gates are not proof a real
  bridge still connects.
- Slice 6 is the heaviest and most novel (a new scheduled-action family with a
  poller). It is last so the feature is useful without it; if it is cut,
  opening and adding simply send immediately and the spec's quiet-hours
  claims are not shipped.
- Slices 2 and 3 change a component the previous mission just stabilized. The
  mark-read gating is the fragile part and is preserved verbatim, with its
  regression tests carried forward unchanged.
- Plan/fact means a property correction no longer reaches tours whose thread
  already exists. That is intended (membership is a fact once texted), but it
  is a behavior operators must understand - the comparison-driven
  "customized" note is what makes it visible.

## 11. Ops (NOT to be applied by the agent)

`PendingRosterAction` is a new persisted family with a due-time poller: it
needs a table or item type plus a GSI, which means a dev Terraform apply and a
post-merge ops line. Per repo discipline the agent never runs Terraform,
`secrets:push`, SSM or deploys - this is flagged here so it is agreed at merge
time rather than discovered.

## 12. Issues to file

- Structured tenant-side support contacts (replace the free-text `caseworker`).
- A group text can be opened on a `self_guided` tour, but reminder routing
  ignores it (`tourType` gates group rungs). Decide whether to hide the
  control or widen the gate.
- Reopening a closed group is a pure status flip today - no confirm, no
  notice. Now that the card edits closed threads' participants, decide whether
  reopen deserves its own confirm/preview.
- The future "main-business-number -> landlord-by-unit" voice path (stale
  comment at `voice.ts:388`) must consult the THREAD roster when built, or
  goal 4 silently regresses on business-number calls.
- The property Contacts card and the tour People card now share an edit
  pattern; extract it if a third caller appears.
