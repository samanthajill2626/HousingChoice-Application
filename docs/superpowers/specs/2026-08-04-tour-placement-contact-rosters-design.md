# Tour / placement contact rosters - design

- Date: 2026-08-04
- Version: v2 (post adversarial review)
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

### D1. The roster is an override that TRACKS the property until a group opens

A tour or placement stores `roster?: RosterEntry[]` (shape in 5.2). Absent -
the normal state - means "resolve from the property," so a property whose
management changes is immediately correct on every tour that never deviated.

The override MATERIALIZES on two events:

1. A human edit (add, remove, or exclude a member).
2. OPENING THE GROUP TEXT.

Materialize-on-open is what makes goal 4 an invariant rather than a slogan.
Before a group exists the roster is a plan, and tracking the property is
right. Once real people have been texted, membership is a FACT: a later
property-roster edit must not silently re-resolve the card and tabs away from
the people actually in the thread. After open, every membership change goes
through the add/remove flow, which notifies (D7).

Two consequences that must be built, not assumed:

- The "customized" note is driven by COMPARISON, not by the presence of an
  override: it appears only when the roster differs from what the property
  would resolve to right now. Otherwise every open-group tour would claim to be
  customized.
- "Reset to property default" is DISABLED while a group is open, with the
  reason ("members are on a live group text - add or remove them
  individually"). A silent bulk re-point would fire notifications nobody
  confirmed.

BACKFILL: a group that predates this feature (dev has several) has an open
thread and no override. On first load of such a tour/placement, the override is
backfilled from the live participant rows. That is why `RosterEntry` must admit
a bare phone (5.2) - legacy and API-added participants can carry no contactId.

Rejected: a snapshot copied at tour creation (every property correction has to
be chased across every existing tour); property-level only (no way to handle a
one-off without editing the property).

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
an intentional routing change. `documentation/GLOSSARY.md` is updated in the
same commit.

### D3. Resolution: tenant + the property's primary contact

`resolveTourMembers` and the placement equivalent become:

- override present -> the override is the roster, in stored order
- override absent -> `[tour.tenantId, unitContactsOf(unit).find(primaryContact)]`

`tourType` never affects ROSTER resolution. It describes who conducts the
showing; if a PM runs the property they are the primary contact regardless of
one tour's type. The People card's existing type-derived label is deleted
(6.2).

CAVEAT, so nobody "simplifies" it away: `tourType` DOES still gate reminder
ROUTING - group-routed rungs are for `landlord_led` / `pm_team`, and
`self_guided` reminders go to the tenant 1:1 (`app/src/routes/relayGroups.ts`,
`app/src/jobs/tourReminders.ts`). That gate is untouched by this spec.

Landlord resolution for MILESTONES is unchanged and stays point-in-time, as
`app/src/lib/personEvents.ts` documents. Milestones are DUAL-PARTY (tenant +
the unit's landlord at event time) regardless of the roster - so a tenant
excluded from a group text still receives every lifecycle pin.

### D4. A placement inherits the tour's roster at conversion

`app/src/routes/placements.ts` already re-parents the tour's relay thread to
the new placement with its members preserved (`rebindOwner`). If the placement
resolved fresh from the property default it would show the owner while the
inherited thread texts the PM - the card contradicting the conversation on the
first page load. Conversion copies the override when the tour has one;
otherwise the placement has none and resolves from the property like any
directly-created placement.

Conversion ALSO migrates any pending roster action (5.3) to the placement,
alongside `rebindOwner`. A deferred "open the group at 8:00 AM" must not die
because the tour converted at 7:00 AM.

### D5. The People card is the roster editor; every action persists on click

"Edit" flips the card into edit mode. Each add, remove, and exclude persists
the moment it is clicked. "Done" is a view toggle and nothing more - navigating
away can never lose a change, because there is never a pending one. This suits
the server side, which is already per-member and idempotent with a
`409 roster_conflict` on a concurrent write.

### D6. ON THE TOUR and ON THE GROUP TEXT are different states

A roster member is on the tour (a row on the card, a 1:1 tab, a party for
calls and milestones). Whether they are on the GROUP TEXT is a separate,
per-member state with four values:

- `on` - a member of the group text
- `off_no_phone` - no mobile number on the contact (derived, not chosen)
- `off_opted_out` - the contact has sent STOP (derived; member-level opt-out
  suppresses that leg at send time, `app/src/routes/relayGroups.ts`)
- `off_excluded` - deliberately excluded by the operator

THE GROUP ROSTER IS THE `on` SUBSET of the People card. All three `off_*`
states render the same way - a muted row with the reason - because to the
operator they are the same fact: this person is on the tour and will not
receive the text.

THE TENANT CANNOT BE REMOVED from a tour/placement roster (they are the subject
of it), but CAN be `off_excluded`. That covers the real case - a caseworker
handling landlord contact on the tenant's behalf - without a tenant-less tour,
without losing the tenant's 1:1 tab, and without making the empty roster
reachable. Everyone else can be removed outright.

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

REMOVAL and EXCLUSION are immediate and never defer: `app/src/routes/
relayGroups.ts` drops a member silently (audit + a `removed_from_group_text`
milestone on that contact), sending nothing to anyone.

A deferred send resolves its roster AT APPLY TIME, not from an 11pm snapshot.
The card is the consent surface while an action is pending, and it shows the
current roster; the latest intent wins.

REMINDER INTERACTION: a tour with a PENDING `open_group` defers its
group-routed reminder rungs until the open applies, rather than falling back to
the tenant 1:1 (`app/src/jobs/tourReminders.ts` `resolveUsableGroup`). Without
this, a `morning_of` rung racing the pending open at quiet-end routes
nondeterministically. If that coupling proves costly during the build, the
fallback position is to accept the nondeterminism and document it - it is not
dangerous, because membership defers with the intro, so nobody can receive a
group text before being introduced.

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

The ONE deviation is the `landlordVoiceOverride` block: on a PLACEMENT-linked
relay, when the caller is the placement's tenant, the landlord leg's dial number
is swapped for the unit's `primary_voice_contact` (roster number as fallback,
leg identified by contactId).

That substitution is a NO-OP whenever the roster came from the property default,
because the roster member already IS the primary contact. It only takes effect
once an operator has overridden the roster - and then it does the one thing this
spec exists to prevent: it overrides the person they deliberately chose. It also
only earns its keep if voice and text can point at different people, which the
one-`primaryContact` decision (D2) rules out.

So: THE SUBSTITUTION IS RETIRED, and nothing else about call routing changes.
The self-bridge guard, the refusal cases (closed thread, non-member caller, no
callee, no pool number), the whisper/press-1 gate, and the never-crash-on-
resolution posture are all preserved verbatim.

Consequence, for free: a tour-level override moves CALLS as well as texts,
because the roster it edits is the same roster the bridge already reads.

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
  removed and there is no `landlordId` to promote.
- Removing the current primary AUTO-PROMOTES the landlord of record when one
  exists, and the unit scalar follows. This silently re-points live call
  routing, so the editor UI must SURFACE it (6.1) rather than merely allow it.
- The landlord of record cannot be removed (reassign `landlordId` first).

### 5.2 Tour / placement override

```
RosterEntry {
  contactId?: string          // preferred; absent only for legacy/bare members
  phone?: string              // E.164; only for a participant with no contact
  groupText?: 'on' | 'off'    // operator choice; absent = 'on'
}

roster?: RosterEntry[]        // absent = resolve from the property
```

`contactId` is preferred and is what the card, the tabs, and milestones key on.
Phones and display names for contact-backed members are resolved AT USE TIME,
so a corrected phone number is picked up everywhere with no migration and no
stale denormalized copy. `phone` exists only to represent a participant with no
contact record - a legacy group backfilled per D1, or a member added through
the relay API directly.

`groupText` records only the OPERATOR'S choice. The derived off-states
(`off_no_phone`, `off_opted_out`) are computed at read time and are never
stored, so a contact who gains a number or revokes STOP needs no roster edit.

Order is preserved; the tenant is first.

Once materialized, the override PERSISTS until "Reset to property default." It
does not auto-clear when its contents happen to match the current default
again: the operator asserted this roster, and a later change to the property
must not silently re-take a tour they had adjudicated.

DANGLING IDS: a contact deleted while on a roster keeps its entry. The row
renders as "removed contact," is excluded from every send and from call
routing, and gets no 1:1 tab. It is removable like any other member.

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
  | 'roster_too_thin'              // lost its second phone-bearing member
  | 'converted'                    // only if migration to the placement failed
```

Applied by the worker at `dueAt`, following the reminder ladder's
claim-and-skip discipline. An action whose world moved underneath it resolves
to a VISIBLE skipped row with its reason, never a silent disappearance (the
precedent set by the quiet-hours arm-time retirements).

At most one `open_group` action per owner. Cancelling is explicit; forcing is
"Add now" / "Send now anyway", which applies immediately with
`automated: false`.

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
- The Property row (and the placement's "converted from tour" provenance row)
  stay below a divider - they are not people.
- The type-derived "Property manager" / "Landlord" key is DELETED. Role comes
  from the roster now, so the card can no longer claim a PM and render an owner.
- When the tenant has a `caseworker` name on file and no roster member matches
  it, an italic hint reads "Caseworker on file: D. Okafor - not a contact
  record." A nudge at the moment of review, not an affordance.
- A member who is not on the group text renders muted with the reason: "not on
  the group text - no mobile number" / "- opted out" / "- excluded".
- When the roster differs from the current property default: "Customized for
  this tour - the property's default is <name>. Reset to property default."
  Reset is DISABLED while a group is open, with the reason.
- When fewer than two members are `on`: "No property-side contact - a group
  text needs at least two people," and [Open group text] is DISABLED with that
  reason rather than failing at click time with today's
  `400 relay_member_unresolvable`. The route keeps its guard regardless.

Edit mode:

- per-row remove, anchored to the NAME line; the TENANT's remove is disabled
  with the reason, and their row instead offers "exclude from group text"
- per-row exclude / include for the group text
- the property's other roster members offered inline: "Also on this property:
  Alicia Grant - PM - primary contact  [+ Add]", so the common swap (remove the
  owner, add the PM) is two clicks and needs no recall of the PM's name
- "Add any contact..." - general contact search
- rows are NOT links while editing
- "Done" returns to read mode

### 6.3 Pre-open confirm

Opening shows: the members who will be added, PER-MEMBER DELIVERABILITY, the
recipient count, and THE INTRO BODY THE GROUP WILL ACTUALLY RECEIVE. The body
is composed SERVER-side from the `relay.intro` catalog entry and returned by a
preview endpoint. It is never rebuilt in the browser - the template is
founder-editable in Settings, and a client-side copy would drift the first time
it is edited.

Per-member deliverability is the point of goal 3: an opted-out member's leg is
suppressed at send time, so a bare "3 recipients" would be a lie. The dialog
lists who receives it and who does not, with the reason.

Outside quiet hours: [Cancel] [Open group text].
Inside quiet hours: the window is named, and the buttons are
[Cancel] [Send now anyway] [Open at 8:00 AM] (default).

### 6.4 Add-to-live-group confirm

Same shape, showing the `relay.member_added` body, per-member deliverability,
and the recipient count. Buttons: [Cancel] [Send now anyway]
[Add and notify at 8:00 AM].

Pre-open (no group yet), adding, removing and excluding are silent and confirm
nothing - nothing has been sent and the roster is only a plan.

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

- `TourPersonKey = 'tenant' | 'landlord'` retires; channels key on `contactId`.
- One 1:1 tab per roster member (including members who are off the group text),
  plus the group tab. Bare-phone and deleted-contact entries get no tab.
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

RESOLUTION

- `resolveTourMembers` (tours) and the placement roster block: override first,
  else tenant + `primaryContact`; the group roster is the `on` subset.
- Conversion copies the override and migrates pending actions.

ROSTER WRITES - per-member, never a whole-array PATCH

Roster edits are PER-MEMBER endpoints on the tour/placement (add one, remove
one, set groupText on/off, reset to default). A concurrent edit must conflict
rather than clobber. The exact sequence, because this is the one place a
whole-array write will sneak in:

1. If no override exists, MATERIALIZE it with a conditional write
   (`attribute_not_exists(roster)`) holding the currently resolved roster.
2. On the condition failing, re-read and continue onto the EXISTING override -
   never overwrite it.
3. Apply the single member change with an optimistic-concurrency guard,
   retrying a bounded number of times, then `409 roster_conflict`.

The same discipline governs materialize-on-open.

CALL-THROUGH TO A LIVE GROUP

- Add: `addRelayMember`.
- Remove: locate the participant row BY `contactId` and delete using THE PHONE
  STORED ON THAT ROW. `DELETE /api/conversations/:id/members/:phone` is
  phone-keyed, so a re-resolved phone silently no-ops when a contact's number
  was corrected after they joined.
- Exclude behaves as remove on the wire; include behaves as add (and therefore
  confirms and defers like any add).

PREVIEW

- New endpoints returning the SERVER-composed `relay.intro` and
  `relay.member_added` bodies for a given owner and prospective roster, plus
  per-member deliverability (`on` / `off_no_phone` / `off_opted_out` /
  `off_excluded`) and the true recipient count.

VOICE (D10)

- `app/src/routes/webhooks/voice.ts`: DELETE the `landlordVoiceOverride` block
  (and the units/placements reads it exists for) so the roster's own number is
  dialed. Everything else in the bridge path is untouched - callee selection,
  simultaneous ring, refusal cases, whisper gate, self-bridge guard.

QUIET HOURS

- Evaluation on the open and add paths, writing a `PendingRosterAction` instead
  of sending; a worker poller applies them with claim-and-skip.
- `resolveUsableGroup` treats a pending open as "wait", not as "no group".

MILESTONES

- `placement_group_opened` added to `ActivityEventType`, recorded via
  `recordRosterMilestone`.

## 8. Slices

Each slice ends green (`npm run typecheck` + `npm test` + targeted e2e) and is
independently reviewable. The mission can stop cleanly between any two, and NO
slice boundary leaves main in a state where the card and the tabs disagree -
which is why the read-only card lands before the editor.

1. RENAME. `primaryVoice` -> `primaryContact`, scalar, error class, 409 code,
   glossary. Purely mechanical, no behavior.
2. PROPERTY ROSTER EDITOR. Edit mode on the property page's Contacts card,
   including the promotion confirm and the 409 settle.
3. ROSTER MODEL + READ-ONLY CARD. `roster` override, materialize-on-open,
   backfill, new resolution, conversion inheritance, derived roles, the
   group-text states, caseworker hint, `placement_group_opened`, and the D10
   substitution removal (it belongs here: the substitution is a no-op until
   overrides exist, and harmful the moment they do). The People card renders
   the roster; no editing yet.
4. ROSTER-DRIVEN TABS. Retire `TourPersonKey`, contactId-keyed channels,
   scrolling rail with edge fade and carried unread dot.
5. CARD EDIT MODE + CONFIRMS. Per-member endpoints with the materialize
   discipline, call-through, preview endpoints, both confirm dialogs, the
   too-thin disabled state.
6. DEFERRED OPEN + ADD. `PendingRosterAction`, the poller, pending rows,
   visible skipped rows, the reminder-wait coupling, "Send now anyway".

## 9. Testing

- Unit: resolution (override present/absent, each group-text off-state, tenant
  === primary contact de-dupe, no primary contact on the roster, shared phone,
  dangling contactId); the rename; derived role labels; the quiet-hours
  evaluation of both actions.
- Voice: the EXISTING masked-bridge tests are the regression net for D10 and
  must keep passing unchanged - callee selection from the roster, simultaneous
  ring of every other member, and all four refusal cases. Add one test proving
  an overridden roster's number is now dialed where the retired substitution
  would have swapped it.
- API: property roster CRUD including the landlord-of-record 409, the
  at-most-one-primary behavior and the auto-promotion; tour/placement roster
  round-trip; the materialize-then-apply race (two concurrent first edits must
  not clobber); materialize-on-open; backfill from a legacy participant list;
  removal by participant row when the contact's phone changed after joining;
  conversion inheritance AND pending-action migration; preview endpoints
  returning catalog-composed bodies with per-member deliverability; pending
  action creation, application, cancellation, and EVERY skip reason. Clocks are
  PINNED - never wall-clock (the `morning_of` 00:00-08:00 flake is the standing
  lesson).
- Component: People card read and edit modes; the comparison-driven customized
  note; reset disabled while open; every off-state row; the disabled Open
  state; both confirms; the tab rail.
- E2E: the swap-the-landlord flow end to end (property has a PM -> tour
  defaults to the PM -> override on one tour -> open the group -> verify the
  roster on the conversation); a tenant excluded from the group text who still
  has a tab and still receives milestones; the quiet-hours deferral including
  "Send now anyway"; assert sent bodies and recipients via `GET /__dev/outbox`;
  a 360px pass over every surface.
- Seed: the FULL profile gains a PM-managed property (owner of record plus a PM
  marked `primaryContact`) so the default-is-the-PM case is exercised.
  `app/src/lib/seed/lean.ts` is byte-stable and is NOT touched.

## 10. Risks

- The rename touches live masked-call routing, and slice 3 deletes the one
  override in that path. Both are small and separately gated for exactly that
  reason, and both want a live dev smoke call after they land - green gates are
  not proof a real bridge still connects.
- Slice 6 is the heaviest and most novel (a new scheduled-action family with a
  poller). It is last so the feature is useful without it; if it is cut,
  opening and adding simply send immediately and the spec's quiet-hours claims
  are not shipped.
- Roster-driven tabs change a component the previous mission just stabilized.
  The mark-read gating is the fragile part and is preserved verbatim, with its
  regression tests carried forward unchanged.
- Materialize-on-open means a property correction no longer reaches tours with
  an open group. That is intended (membership is a fact once texted), but it is
  a behavior operators must understand - the comparison-driven "customized"
  note is what makes it visible.

## 11. Ops (NOT to be applied by the agent)

`PendingRosterAction` is a new persisted family with a due-time poller: it
needs a table or item type plus a GSI, which means a dev Terraform apply and a
post-merge ops line. Per repo discipline the agent never runs Terraform,
`secrets:push`, SSM or deploys - this is flagged here so it is agreed at merge
time rather than discovered.

## 12. Issues to file

- Structured tenant-side support contacts (replace the free-text `caseworker`).
- A group text can be opened on a `self_guided` tour, but reminder routing
  ignores it (`tourType` gates group rungs). Decide whether to hide the control
  or widen the gate.
- The property Contacts card and the tour People card now share an edit
  pattern; extract it if a third caller appears.
