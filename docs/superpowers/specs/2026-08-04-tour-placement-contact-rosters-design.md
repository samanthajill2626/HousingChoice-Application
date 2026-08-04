# Tour / placement contact rosters - design

- Date: 2026-08-04
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
  exactly-one-primary invariant and a protected landlord of record) and a
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
4. One list. The People card, the 1:1 tabs, and the live group roster never
   disagree.

## 3. Non-goals

- Structured tenant-side support contacts. The tenant's `caseworker` field
  stays a free-text name and is surfaced only as a hint (section 6.2). File an
  issue for the structured version.
- Bare-phone roster members (a number with no contact record). The relay API
  keeps supporting them; the People card only offers contacts.
- Per-recipient timezones. `resolveQuietHoursTimezone` keeps its org-level
  seam.
- Any change to how `landlordId` itself is assigned.

## 4. Decisions

### D1. The roster lives on the tour/placement as an OVERRIDE, not a copy

A tour or placement stores `contactIds?: string[]`. Absent - the normal state -
means "resolve from the property," so a property whose management changes is
immediately correct on every tour that never deviated. Present means this
tour deviates; the override IS the roster and the card says so.

Rejected: a snapshot copied at creation (every property correction has to be
chased across existing tours); property-level only (no way to handle a one-off
without editing the property).

### D2. `primaryVoice` becomes `primaryContact`, storage keys included

The flag today means "the landlord-side person a masked tenant->landlord CALL
routes to." It becomes "the property-side person we contact" - calls and group
texts both. The name must change with the meaning.

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
PRIMARY CONTACT (`primaryContact` - who we call and text). The rename removes
the collision rather than documenting around it.

`app/src/routes/webhooks/voice.ts` reads this field to route live masked calls.
The rename therefore lands as its own purely mechanical commit with gates green
before any behavior change, so a reviewer can never mistake a rename slip for
an intentional routing change. `documentation/GLOSSARY.md` is updated in the
same commit.

### D3. Resolution: tenant + the property's primary contact

`resolveTourMembers` and the placement equivalent become:

- override present -> the override is the roster, in stored order
- override absent -> `[tour.tenantId, unitContactsOf(unit).find(primaryContact)]`

`tourType` never affects resolution. It describes who conducts the showing; if
a PM runs the property they are the primary contact regardless of one tour's
type. The People card's existing type-derived label is deleted (section 6.2).

Landlord resolution for MILESTONES is unchanged and stays point-in-time, as
`app/src/lib/personEvents.ts` documents.

### D4. A placement inherits the tour's roster at conversion

`app/src/routes/placements.ts` already re-parents the tour's relay thread to
the new placement with its members preserved (`rebindOwner`). If the placement
resolved fresh from the property default it would show the owner while the
inherited thread texts the PM - the card contradicting the conversation on the
first page load. Conversion copies `contactIds` when the tour had an override;
otherwise the placement has none and resolves from the property like any
directly-created placement.

### D5. The People card is the roster editor; every action persists on click

"Edit" flips the card into edit mode. Each add and each remove persists the
moment it is clicked. "Done" is a view toggle and nothing more - navigating
away can never lose a change, because there is never a pending one. This suits
the server side, which is already per-member and idempotent with a
`409 roster_conflict` on a concurrent write.

### D6. One list drives the group, the tabs, and the card

While a group text is open, a roster edit calls through to it
(`addRelayMember` / `removeRelayMember`). The 1:1 tabs are one per roster
member. There is no state in which the People card, the tab rail, and the live
group disagree.

A roster member with no mobile number (an email-only caseworker) is allowed:
they get a 1:1 tab and their row reads "not on the group text - no mobile
number." THE GROUP ROSTER IS THE PHONE-BEARING SUBSET of the People card.

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

### D8. Placement group-open pins the same milestone tours do

Placement group provisioning records no person milestone today. It records
`placement_group_opened` ("Group text opened") through
`recordRosterMilestone`, on the same roster-driven rule as
`tour_group_opened`. Add `placement_group_opened` to `ActivityEventType`.

### D9. The property roster editor is in scope

The default is "the property's primary contact," and there is no UI to set it.
Without the editor the default stays wrong for exactly the properties that
motivated this work, and the tour-level override becomes the primary workflow
rather than the exception. The server endpoints are finished; this is a UI
build against them, and `primaryContact` should become editable in the same
mission where it gains its second meaning.

## 5. Data model

### 5.1 Unit (unchanged except the rename)

```
UnitContact {
  contactId: string
  role: 'landlord' | 'pm' | 'owner' | 'other'
  primaryContact: boolean   // renamed from primaryVoice; exactly one true
  name?: string             // denormalized at write time
  company?: string
}
```

Invariants stay as built: exactly one `primaryContact` across the roster; the
unit scalar `primary_contact` agrees with it; the landlord of record cannot be
removed (reassign `landlordId` first).

### 5.2 Tour / placement override

```
contactIds?: string[]   // absent = resolve from the property
```

Contact ids ONLY. Phones and display names are resolved at use time, so a
corrected phone number is picked up everywhere with no migration and no stale
denormalized copy. Order is preserved; the tenant is first when present.

Once materialized, the override PERSISTS until "Reset to property default" is
clicked. It does not auto-clear when its contents happen to match the current
default again: the operator asserted this roster, and a later change to the
property must not silently re-take a tour they had adjudicated.

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
  skippedReason?: string
}
```

Applied by the worker at `dueAt`, following the reminder ladder's
claim-and-skip discipline. An action whose world moved underneath it - group
closed, tour canceled, member already present, contact deleted - resolves to a
VISIBLE skipped row with a reason, never a silent disappearance (the precedent
set by the quiet-hours arm-time retirements).

At most one `open_group` action per owner. Cancelling is explicit; forcing is
"Add now" / "Send now anyway", which applies immediately with
`automated: false`.

## 6. Surfaces

### 6.1 Property page - Contacts card becomes editable

Read mode is unchanged: name, role, company, the primary marker, rows link to
the contact. "Edit" flips it:

- per-row remove (the landlord of record's remove is disabled, with the reason)
- per-row "make primary contact"
- role selector per row
- "+ Add contact" - contact search, then role
- "Done" returns to read mode

Every action persists on click, against the existing endpoints. A
`409 roster_conflict` refetches and re-renders rather than surfacing an error.

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
- The Property row (and the placement's "converted from tour" provenance row)
  stay below a divider - they are not people.
- The type-derived "Property manager" / "Landlord" key is DELETED. Role comes
  from the roster now, so the card can no longer claim a PM and render an owner.
- When the tenant has a `caseworker` name on file and no roster member matches
  it, an italic hint reads "Caseworker on file: D. Okafor - not a contact
  record." A nudge at the moment of review, not an affordance.
- A phone-less member's row reads "not on the group text - no mobile number."
- When an override exists: "Customized for this tour - the property's default
  is <name>. Reset to property default."
- When the roster has fewer than two phone-bearing members: "No property-side
  contact - a group text needs at least two people," and [Open group text] is
  DISABLED with that reason rather than failing at click time with today's
  `400 relay_member_unresolvable`. The route keeps its guard regardless.

Edit mode:

- per-row remove, anchored to the NAME line
- the property's other roster members offered inline: "Also on this property:
  Alicia Grant - PM - primary contact  [+ Add]", so the common swap (remove the
  owner, add the PM) is two clicks and needs no recall of the PM's name
- "Add any contact..." - general contact search
- rows are NOT links while editing
- "Done" returns to read mode

### 6.3 Pre-open confirm

Opening shows: the roster that will be added, the recipient count, and THE
INTRO BODY THE GROUP WILL ACTUALLY RECEIVE. The body is composed SERVER-side
from the `relay.intro` catalog entry and returned by a preview endpoint. It is
never rebuilt in the browser - the template is founder-editable in Settings,
and a client-side copy would drift the first time it is edited.

Outside quiet hours: [Cancel] [Open group text].
Inside quiet hours: the window is named, and the buttons are
[Cancel] [Send now anyway] [Open at 8:00 AM] (default).

### 6.4 Add-to-live-group confirm

Same shape, showing the `relay.member_added` body and the recipient count.
Buttons: [Cancel] [Send now anyway] [Add and notify at 8:00 AM].

Pre-open (no group yet), adding and removing are silent and confirm nothing -
nothing has been sent and the roster is only a plan.

### 6.5 Pending state on the card

```
Alicia Grant                                     PM
  Joins at 8:00 AM - quiet hours
  Add now - Cancel
```

and for a deferred open, the same treatment on the [Open group text] control:
"Opens at 8:00 AM - quiet hours. Send now - Cancel."

### 6.6 Tabs

- `TourPersonKey = 'tenant' | 'landlord'` retires; channels key on `contactId`.
- One 1:1 tab per roster member, plus the group tab.
- The rail is ONE ROW and scrolls horizontally when it overflows, with an edge
  fade marking the overflow. If an off-screen tab has unread, THE FADE CARRIES
  THE UNREAD DOT, so a reply never hides past the edge.
- Removing a member drops their tab; the conversation itself survives on their
  contact page.
- The mark-read gating built last mission (`commsVisible`,
  `timeline.status === 'ready'`, foreground visibility, loaded contact) is
  preserved verbatim per tab. Do not weaken it.

### 6.7 Narrow viewport (REQUIRED, not a nicety)

Below the 860px `twoPaneShell` breakpoint:

- role wraps UNDER the name whenever the pair does not fit on one line
- the remove control anchors to the name line so it does not move when the role
  wraps; the touch target is the full row (min 44px), not the glyph
- confirm dialog buttons stack full-width, default on top, same order as
  desktop
- the tab rail scrolls on one row (never wraps to two)

Every surface in this spec is verified at 360px in the Playwright harness
before the branch is done.

## 7. Server changes

- `resolveTourMembers` (tours) and the placement roster block: override first,
  else tenant + `primaryContact`.
- Roster edits are PER-MEMBER endpoints on the tour/placement (add one, remove
  one, reset to default), never a whole-array PATCH: a concurrent edit must
  conflict rather than clobber, matching the relay roster's optimistic
  concurrency. The first per-member edit on a tour with no override
  MATERIALIZES the override from the currently resolved roster, then applies
  the change.
- While a group is open, a roster edit calls `addRelayMember` /
  `removeRelayMember` on the linked conversation.
- New preview endpoints returning the SERVER-composed `relay.intro` and
  `relay.member_added` bodies plus the recipient count for a given owner and
  prospective roster.
- Quiet-hours evaluation on the open and add paths, writing a
  `PendingRosterAction` instead of sending; a worker poller applies them.
- `placement_group_opened` added to `ActivityEventType`, recorded via
  `recordRosterMilestone`.
- Conversion copies `contactIds` onto the placement.

## 8. Slices

Each slice ends green (`npm run typecheck` + `npm test` + targeted e2e) and is
independently reviewable. The mission can stop cleanly between any two.

1. RENAME. `primaryVoice` -> `primaryContact`, scalar, error class, 409 code,
   glossary. Purely mechanical, no behavior.
2. PROPERTY ROSTER EDITOR. Edit mode on the property page's Contacts card
   against the existing endpoints.
3. ROSTER MODEL. `contactIds` override, new resolution, conversion
   inheritance, People card as roster editor (read + edit), derived roles,
   caseworker hint, phone-less member handling, `placement_group_opened`.
4. PRE-OPEN CONFIRM. Preview endpoints, both confirm dialogs, the too-thin
   disabled state.
5. ROSTER-DRIVEN TABS. Retire `TourPersonKey`, contactId-keyed channels,
   scrolling rail with edge fade and carried unread dot.
6. DEFERRED OPEN + ADD. `PendingRosterAction`, the poller, pending rows,
   visible skipped rows, "Send now anyway".

## 9. Testing

- Unit: resolution (override present/absent, phone-less member, tenant ===
  primary contact de-dupe, no primary contact on the roster); the rename;
  derived role labels; the quiet-hours evaluation of both actions.
- API: property roster CRUD including the landlord-of-record 409 and the
  exactly-one-primary invariant; tour/placement `contactIds` round-trip;
  conversion inheritance; preview endpoints returning catalog-composed bodies;
  pending action creation, application, cancellation, and every skip path.
  Clocks are PINNED - never wall-clock (the `morning_of` 00:00-08:00 flake is
  the standing lesson).
- Component: People card read and edit modes; the customized note and reset;
  the disabled Open state; both confirms; the tab rail.
- E2E: the swap-the-landlord flow end to end (property has a PM -> tour
  defaults to the PM -> override on one tour -> open the group -> verify the
  roster on the conversation); the quiet-hours deferral including "Send now
  anyway"; assert sent bodies via `GET /__dev/outbox`; a 360px pass over every
  surface.
- Seed: the FULL profile gains a PM-managed property (owner of record plus a
  PM marked `primaryContact`) so the default-is-the-PM case is exercised.
  `app/src/lib/seed/lean.ts` is byte-stable and is NOT touched.

## 10. Risks

- The rename touches live masked-call routing (`webhooks/voice.ts`). Mitigated
  by slice 1 being mechanical and separately gated.
- Slice 6 is the heaviest and the most novel (a new scheduled-action family).
  It is last so the feature is useful without it; if it is cut, opening and
  adding simply send immediately and the spec's quiet-hours claims are not
  shipped.
- Roster-driven tabs change a component the previous mission just stabilized.
  The mark-read gating is the fragile part and is preserved verbatim, with its
  regression tests carried forward unchanged.

## 11. Issues to file

- Structured tenant-side support contacts (replace the free-text `caseworker`).
- Bare-phone roster members in the People card.
- The property page's Contacts card and the tour People card now share an edit
  pattern; extract it if a third caller appears.
