# Tour reminder ladder - founder rewrite (names, retiming, skip rules)

**Date:** 2026-08-26
**Status:** Approved (Cameron, 2026-08-26). Reviewed by two independent passes.
**Branch:** `feat/tour-reminder-ladder` (worktree `W:/tmp/tour-reminder-ladder`)
**Author:** Claude (designed with Cameron over the 2026-08-26 template review)

---

## 1. Problem

The founder (Sam) rewrote the tour reminder copy. Every new message is built
around the tenant's first name and, on landlord-led tours, the name of the
person showing the property. Neither token exists on the tour path today, so
none of the new copy can ship as a text-only edit. The rewrite also retimes two
rungs, turns one off, and adds two booking-time skip rules.

This is the third pass over this copy. The first two shipped wording the founder
then revised, largely because wording and plumbing were addressed separately.
This pass does both together so the ladder lands once.

## 2. The ladder is paused, and STAYS paused in this phase

`MANUAL_ONLY_REMINDER_KINDS` (`app/src/jobs/tourReminders.ts:163`) contains
`confirmation`, `day_before`, `morning_of` and `en_route` - every auto-armed
rung. Under a founder decision of 2026-08-20 the poll sends NOTHING
automatically. Rows still arm, still show on the tour page with their copy, and
a human presses "Send now".

Nothing below changes that. As written, this entire spec changes what the
Reminders panel DISPLAYS and what a human force-send COMPOSES. It does not
change when a tenant receives a text, because no automatic send happens at all.

The founder's document is written as "send this at this time", and her stated
urgency is that she needs to start scheduling tours. That reads like an unpause
request. The 2026-08-20 rationale was that "automated sends are going out under a
founder who does not yet have a settled model of when the system speaks for her"
- and this rewrite is arguably that settled model arriving.

**RULED (Cameron, 2026-08-26): the pause HOLDS for this phase.**

- **Phase A - this branch.** Copy, tokens, timing, skip rules and the entry
  restructure. `MANUAL_ONLY_REMINDER_KINDS` is NOT touched. The observable
  effect is what the Reminders panel displays and what a human force-send
  composes. Do not empty that set here, and do not "helpfully" flip it as part
  of getting a test green.
- **Phase B - a later branch.** Flip the ladder to automatic once the founder's
  outstanding answers are in and the copy has been confirmed correct in the
  panel. That is one line, but it takes on real scope: in-flight rows armed
  under the OLD timing begin firing automatically (section 9.3), and the blast
  radius is live texts to tenants and landlords. It gets its own branch, its own
  review, and its own deploy.

Sequencing this way is what makes the copy reviewable before it can reach
anyone. Phase A is the safe place to be wrong.

A HARNESS TRAP applies either way, and must be stated in the handback: the dev
tick route passes an empty manual-only set, so the e2e suite exercises the
automatic send path that production does not have. A green e2e proves the
machinery, NOT that anything sends in production.

## 3. Source of truth

`HousingChoiceMessageTemplates_Sam_edits.docx` ("Sam's edits", Aug 24) governs.

A second file, `HousingChoice_Templates_Relay_and_Tours_Sam (1).docx`, arrived in
the same message but is an EARLIER draft the Aug 24 file supersedes. DISCARDED
(Cameron, 2026-08-26). Where they disagree, the Aug 24 file wins: two tour types
with three reminders each rather than four flows; no new "3 hours before" rung;
the address KEPT on reminder 2.

The Aug 24 file also carries a voice-prompt section with PRE-2026-08-18 wording.
That section is stale - the founder states she edited only tours and relay.
Voice prompts are OUT OF SCOPE and must not be touched.

## 4. Scope

IN: tour reminder copy, tokens, timing, skip rules, entry restructure, and
resolving the two names on every path that composes a reminder body - including
the read-only preview paths.

OUT (each its own piece of work): the relay intro tour/placement split;
`relay.member_added`; a Settings UI for tour copy (explicitly deferred, Cameron
2026-08-26); legacy plain-string address cleanup; `welcome.sms`; voice prompts;
compliance-locked entries.

IN BY CONSEQUENCE, though it reads like a scope leak: the new skip rules need a
`ReminderSkipReason` token that does not exist, which drags in the dashboard's
wire union and operator label map (section 8.2).

## 5. Copy

Placeholders are the FINAL token names (section 6).

| Rung | Entry id | Copy |
| --- | --- | --- |
| Day before | `tour.day_before` | `Hey {tenantFirstName}, confirming your tour tomorrow at {time}. Does that still work for you?` |
| 4h before | `tour.morning_of` | `Hey {tenantFirstName}, looking forward to having you tour at {time} today. Does that still work for you? Address is {where}.` |
| 4h before, no address | `tour.morning_of_no_address` | `Hey {tenantFirstName}, looking forward to having you tour at {time} today. Does that still work for you?` |
| 1h before, self-guided | `tour.en_route_self_guided` | `Hey {tenantFirstName}, can you please text me when you're on the way?` |
| 1h before, landlord-led | `tour.en_route_landlord_led` | `Hey {tenantFirstName}, {propertyContactFirstName} will be headed that way shortly. Can you please text here when you're on the way?` |
| No-show check-in | `tour.no_show_checkin` | `Hi {tenantFirstName}! Do you need to reschedule?` |

`tour.confirmation` / `tour.confirmation_no_address` are TURNED OFF: no
confirmation text in any flow. Section 9.1 explains why the entries stay.

SEGMENT BUDGET: `tour.morning_of` is the longest and the highest-volume rung.
With a first name, a formatted time and a street line it can cross 160
characters into a second segment. Measure with `analyzeSms`; state the accepted
segment count per rung in the handback rather than discovering it on the bill.

## 6. Token contract

Four name tokens, all DECLARED and all PASSED on every tour entry, including the
two the current copy does not use. Declaring without passing is the trap: a
declared token present in the copy with no value THROWS for a code default
(`resolve.ts:36`). Passing all four makes a future wording change a pure string
edit.

- `{tenantFirstName}` / `{tenantName}` - tenant, first and full
- `{propertyContactFirstName}` / `{propertyContactName}` - the unit's primary
  contact, first and full (full names declared but unused today)

Plus existing `{when}` (date and time), `{time}` (time alone), `{where}` (street
line only). Entries whose copy no longer uses `{when}` still DECLARE it; a
declared token absent from a template is skipped (`resolve.ts:33`), and keeping
the declaration is what lets copy change without plumbing.

Declaring unused tokens is legal ONLY because every `tour.*` entry is
`editable: true`: `catalog.test.ts:43` enforces "no dead tokens" for
NON-editable entries only. Do not flip these entries to `editable: false`.

`welcome.sms` keeps its `{firstName}` and is NOT renamed - an override may
already be configured against that name, and an undeclared token ships literally
to the tenant.

### 6.1 Resolving the property contact - REUSE, do not reimplement

There is an established resolver. Use it:

```
unitContacts(unit).find((c) => c.primaryContact === true)?.contactId
  ?? unit.landlordId
```

as in `lib/rosterResolution.ts:274` and `services/rosterProvision.ts:233`.

Do NOT read the `unit.primary_contact` scalar (`unitsRepo.ts:253`). Nothing else
in the codebase resolves from it, and it is nullable. Writing a second resolver
here is the exact drift this spec warns about for `seedLive`'s `computeDueAt`
twin (section 10).

The `landlordId` fallback covers TWO cases, not one: (a) no `contacts[]` at all,
handled inside `unitContacts` (`unitsRepo.ts:296`); and (b) a roster that exists
with ZERO primaries flagged, which is legal and reachable
(`rosterResolution.ts:269`). Both must degrade per 6.3.

Read the LIVE contact for the name. Roster entries carry a denormalized `name`
(`unitsRepo.ts:63`) that goes stale.

### 6.2 First names come from ONE helper

`firstName` is not a declared field on `ContactItem`; it rides the index
signature. There are already at least six local re-implementations of "trim
firstName else split name". Use the shared helper in `app/src/lib/contactName.ts`
and add no seventh copy.

### 6.3 Fallbacks - absence and failure are DIFFERENT

Absence (no such contact, or no name on it):

- No tenant first name: pass `there`, giving `Hey there, confirming your tour...`.
- No property-contact first name on a landlord-led tour: compose the
  SELF-GUIDED entry instead. Do not invent a filler noun - "your contact will be
  headed that way shortly" reads badly and asserts what we cannot back.

Read FAILURE (the contacts read threw) is not absence and must not silently
degrade into a wrong-but-valid message:

- READ paths (the three preview surfaces) degrade to the absence fallbacks and
  MUST NOT throw. Each catches only `UncomposableReminderError`
  (`routes/tourReminders.ts:245`, `routes/contactTimeline.ts:727`,
  `routes/relayGroups.ts:262`), so an escaping repo error 500s the whole bucket.
- SEND paths leave the rung UNCLAIMED on a read failure - the existing
  `roster_unavailable` idiom - and use fallbacks only on genuine absence.

### 6.4 DO NOT declare `{where}` on `tour.morning_of_no_address`

The twin exists so a unit with no address cannot leak a broken address clause.
`interpolate()` inspects DECLARED tokens only, so an undeclared `{where}` emits
literally rather than resolving - and `catalog.test.ts:35` fails the build on a
token used but not declared. Declare every token on that entry EXCEPT `where`.

## 7. Timing

`computeDueAt` (`app/src/jobs/tourReminders.ts:89`) returns RAW offsets; the
clamp is applied by the caller at `:250`.

| Kind | Raw due at | Change |
| --- | --- | --- |
| `confirmation` | n/a | no longer armed |
| `day_before` | 19:30 org-local on the day BEFORE the tour's local date | was `scheduledAt - 24h` |
| `morning_of` | `scheduledAt - 4h` | was 08:00 org-local on the tour's local date |
| `en_route` | `scheduledAt - 1h` | unchanged |
| `no_show_checkin` | `scheduledAt + 30m` | never armed in production; see 9.4 |

"7:30pm EST" means 7:30pm local to the property (Cameron, 2026-08-26). We hold a
single org-level timezone; per-property is future work. Resolve it with
`resolveQuietHoursTimezone` (`lib/quietHours.ts:39`), NEVER by reading
`settings.timezone` directly (spec D8). Build 19:30 with `instantAtLocalTime`,
the mechanism the old 08:00 rung used. That helper is DST-converging; section 12
owes a DST-transition test, because this is the only local-time-anchored rung.

### 7.1 19:30 is only viable outside the quiet window

Quiet hours are org-configurable (default 21:00-08:00,
`settingsRepo.ts:169`). At the default, 19:30 is outside the window and
unclamped. But an org that sets `quietHoursStart` to 19:00 or earlier makes
every `day_before` clamp forward to 08:00 ON THE TOUR DAY, which trips the
existing `staleDayBefore` rule (`jobs/tourReminders.ts:294`) and retires the rung
100% of the time, labelled "superseded by a later reminder".

DECIDED: do not fail and do not validate the setting (quiet hours are a general
setting and must not be constrained by one rung). Log a WARN at arm time when
19:30 falls inside the configured window, naming the rung, so the cause is
visible when the panel starts showing every `day_before` as skipped. Section 13
owes a test at `quietHoursStart <= 19:30` pinning the retirement AND the warn.

### 7.2 Clamping RETIRES early-tour rungs, it does not delay them

For an 8am tour, `morning_of` (04:00) and `en_route` (07:00) both clamp forward
to 08:00, which is `>= scheduledAt`, so both are born SKIPPED as `past_event`
(`:270`). For a 9am tour the two clamp onto the same 08:00 instant and the later
rung supersedes the earlier. This is accepted (Cameron, 2026-08-26) and is
already communicated to the founder.

### 7.3 The exemption hook - CUT FROM PHASE A (amended 2026-08-26)

AMENDED after plan review: this hook is NOT built in Phase A. It needs injection
points on two deps interfaces that do not exist, and its second site - the
fire-time backstop - is UNREACHABLE in production while the manual-only filter
(`:470`) short-circuits ahead of it. Building an untestable, unreachable hook to
make a later one-line change easier is not worth the surface area. Phase B adds
it where it can actually be exercised.

The design below stands for whoever builds it then.

Add `QUIET_HOURS_EXEMPT_KINDS: ReadonlySet<ReminderKind>`, EMPTY in this change,
mirroring `MANUAL_ONLY_NUDGE_KINDS`. It must be consulted in BOTH:

1. the clamp site in `armTourReminders` (`:250`), and
2. the fire-time backstop in `processReminderRow` (`:729`), which defers any row
   inside the window REGARDLESS of kind.

An arm-time-only exemption is inert: the poll would sit on the unclamped 07:00
row until 08:00 anyway. Do not describe this as a one-line change.

## 8. Skip rules

Both evaluate at ARM time. `now` is the ARM instant - which is the booking
instant, a RESCHEDULE, or a status revival, since `armTourReminders` is called
from `routes/tours.ts:350` (book) and `:1178` (PATCH). A reschedule therefore
re-evaluates both rules against the reschedule time; a same-day reschedule can
legitimately strip most of the ladder. That is intended.

Both rules compare against RAW offsets, BEFORE clamping.

1. `day_before` is skipped when `now > rawDueAt - 4h`.
2. `morning_of` is skipped when `sameDay && now > scheduledAt - 6h`, where
   `sameDay` is `localDateOf(scheduledAt, tz) === localDateOf(now, tz)` using the
   SAME `resolveQuietHoursTimezone` zone as section 7.

Boundaries are strictly `>`: a tour booked exactly 6h out still arms
`morning_of`.

A previous draft of this spec claimed the founder's phrasing ("within 2 hours of
when the 4-hour reminder would fire") and the formula above are the same instant.
THAT IS FALSE once clamping applies - for a 9am tour they differ by three hours.
They coincide only when no clamp applies. We take the RAW reading.

### 8.1 Which skips write a row

There are TWO existing arm-time postures, and they differ:

- past-dueAt writes NO row at all (`:266`, a bare `continue`).
- `past_event` and `quiet_hours_superseded` write a VISIBLE skipped row.

DECIDED: both new rules write a VISIBLE skipped row. A founder who booked late
should see WHY a rung is missing rather than find a gap.

That requires resolving an overlap: for a same-day tour the `day_before` raw
dueAt is already in the past, so the existing past-dueAt branch would fire FIRST
and write nothing. Evaluate skip rule 1 BEFORE the past-dueAt check, so a
late-booked `day_before` is reported as booked-too-late rather than vanishing.
Leave the past-dueAt branch itself alone for every other rung - it is unchanged
behaviour that other tests pin.

### 8.2 A new skip reason is required

The eight existing `ReminderSkipReason` tokens (`tourRemindersRepo.ts:36`) are
`no_conversation`, `contact_missing`, `contact_no_phone`, `tour_missing`,
`quiet_hours_superseded`, `past_event`, `tenant_not_on_roster`,
`roster_unavailable`. NONE means "booked too late for this rung". Reusing
`past_event` is a lie (the rung would land before the tour); reusing
`quiet_hours_superseded` is a lie (nothing superseded it).

DECIDED: add `booked_too_late`, and carry it through the wire union
(`dashboard/src/api/types.ts:1210`) and the operator label map (`:1269`) with the
label `booked too late for this reminder`. Section 13 owes a test on the label.

## 9. Entry restructure

The address fork is kept ONLY on the rung whose copy carries an address. The
resulting id map must be TOTAL:

| kind | fork | ids |
| --- | --- | --- |
| `confirmation` | address | `tour.confirmation` / `tour.confirmation_no_address` |
| `day_before` | none | `tour.day_before` |
| `morning_of` | address | `tour.morning_of` / `tour.morning_of_no_address` |
| `en_route` | tour type | `tour.en_route_self_guided` / `tour.en_route_landlord_led` |
| `no_show_checkin` | none | `tour.no_show_checkin` |

`MessageId` is derived at compose time and persisted nowhere, so removing ids is
compile-safe. `ReminderKind` IS persisted (`tourRemindersRepo.ts:76`) and does
NOT change. `morning_of` keeps its name despite firing four hours before the
tour; renaming would orphan in-flight rows.

### 9.1 The derivation is an unguarded cast - this change makes it live

`tourCopy.ts:67` builds the id by string-cast. If it produces an id the catalog
lacks, `MESSAGE_CATALOG[id]` is `undefined` and `resolve.ts:58` throws a bare
`TypeError`, NOT `UncomposableReminderError`. Every containment block catches
only the latter, so the blast radius is a poll row never claimed and re-listed
every tick forever, PLUS 500s on three read endpoints. Already filed:
`docs/issues/tourcopy-messageid-cast-unguarded.md`.

This change reshapes the id space in three places at once, so section 12 owes an
EXHAUSTIVE matrix test - every `ReminderKind` x {address, no address} x every
`TourType` composes without throwing. That test also closes the filed issue; say
so in the handback.

KEEP the two `confirmation` entries even though nothing arms them: a pending
`confirmation` row may exist at cutover, and a missing entry is the failure above.
Remove `confirmation` from `REMINDER_KINDS` only - the `no_show_checkin` pattern
(`:197`).

### 9.2 `no_show_checkin` is NOT unchanged - it has two throw sites

Its copy gains `{tenantFirstName}`, and BOTH resolution paths pass no vars today:

1. `tourCopy.ts:53` - the composer's early return, above `scheduledAt`
   validation, passing `undefined`.
2. `routes/tourReminders.ts:548` - the `GET /:tourId/no-show-checkin-draft`
   prefill, which BYPASSES the composer entirely.

Both throw strict-mode bare `Error`s once the token lands. Worse, path 2 is
explicitly whitelisted by the guard test (`tourCopyCallSites.test.ts:33`,
`ALLOWED_DIRECT`) on the justification "token-free by design (spec D2)" - a
justification section 5 revokes. Nothing fails at build; the route 500s at
runtime. Update both paths and that whitelist.

### 9.3 In-flight rows are NOT re-armed

Pending rows keep their old dueAts; nothing backfills them. Their BODIES
recompose from the new catalog at fire time (only `sentAt` rows render a stored
snapshot, `routes/tourReminders.ts:236`). So for one booking horizon the panel
shows old timings with new copy - a rung labelled "Day before" sitting at 3pm.
Accept this and say so; a re-arm backfill would be more destructive. This matters
much more under option (B) in section 2, where those rows fire automatically.

### 9.4 `confirmation` also sits in `MANUAL_ONLY_REMINDER_KINDS`

with a long rationale (`:149`) arguing its inclusion is "a deliberate decision,
not a side effect". Once nothing arms it, that entry is dead state and the
comment is false. Say what happens to both.

## 10. Implementation notes

`composeTourReminderBody` (`app/src/messages/tourCopy.ts`) is the composer for
reminder bodies. Its signature grows to take the resolved names and the tour
type. The ACTUAL call sites are four in `app/src` plus one in the harness:

- `jobs/tourReminders.ts:549` (`composeBodyForRow` - serves the poll's 1:1 path,
  `sendGroupReminder`, and `forceSendReminder`)
- `routes/tourReminders.ts:238` (`bodyFor`)
- `routes/contactTimeline.ts:725` (`tourReminderBodyOrEmpty`)
- `routes/relayGroups.ts:258` (the GROUP-THREAD scheduled bucket - not a
  tour-reminder route surface, despite sitting in this list)
- `e2e/scenarios/steps.ts:174` (`tourReminderBody`)

Plus the composer-bypassing no-show draft at `routes/tourReminders.ts:548`
(section 9.2).

Every one must supply the new arguments, INCLUDING the read-only previews - a
preview that renders different copy from the send is the failure
`tourCopyCallSites.test.ts` exists to prevent. Note that test's own header
disclaims the stronger reading: it enforces "route through the composer", not
"the composer can resolve every ReminderKind". The matrix test in 9.1 is what
closes that gap.

The contact timeline's Upcoming bucket resolves rungs for MULTIPLE tours per
request. Resolve contacts once per request and batch; do not read per rung.

`app/test/seedLive.test.ts:37` carries a DELIBERATE second implementation of
`computeDueAt` as a drift guard. Move it in lockstep.

## 11. Behavioural consequences to state, not discover

- A short-notice booking can now produce a ladder where EVERY rung is skipped:
  `day_before` past, `morning_of` by rule 2, and `en_route` clamped past the tour
  for an evening booking. Previously the confirmation went out immediately and
  the tenant had something. The founder will meet this in the first week.
- The operator-facing label `morning_of: 'Morning of'`
  (`dashboard/src/api/types.ts:1242`, mirrored `e2e/scenarios/steps.ts:205`) is
  now wrong - for a 7pm tour that rung fires at 3pm. DECIDED: RELABEL it to
  `4 hours before` (touches the dashboard map, the e2e mirror, and
  `RemindersPanel.test.tsx`). The persisted KIND keeps its name for the
  migration reason in section 9; the LABEL has no such constraint, and leaving a
  staff-facing lie in place because the key underneath it is stuck would be
  choosing the worst of both.

## 12. Open items with the founder (do not block)

1. Whether to exempt `en_route` from quiet hours, for 8-9am tours. The hook is
   built here but stays empty; enabling it is section 7.3's two sites. Moot in
   Phase A - nothing sends automatically - so this is a Phase B question.
2. `relay.member_added` wording and the per-recipient body idea. Separate branch.

## 13. Testing

Suites that pin this copy or timing and WILL break:

`tourCopy`, `tourReminders`, `toursApi`, `seedLive`, `relayApi`,
`messages/catalog`, `tourRemindersApi` (`:244`, `:844`, `:1088`),
`contactTimeline` (`:1108`), `devGating` (`:459`), `relayAnnouncements` (`:67`),
`tourCopyCallSites` (the `ALLOWED_DIRECT` whitelist), and
`dashboard/src/routes/tours/RemindersPanel.test.tsx` (asserts the "Morning of"
label and a skip chip).

New coverage this change owes:

- Every rung's due time, including 19:30 local and `scheduledAt - 4h`.
- A DST-transition day for the 19:30 rung.
- `quietHoursStart <= 19:30` (section 7.1).
- Both skip rules INCLUDING the boundary instants, and the reschedule path.
- Wording selection by tour type, and the property-contact fallback degrading to
  the self-guided entry - covering BOTH zero-roster and zero-primary.
- Read-failure vs absence on a read path and on a send path (6.3).
- The EXHAUSTIVE compose matrix from 9.1.
- `tour.morning_of_no_address` does not declare `where`.
- A pending `confirmation` row still composes after the rung stops arming.
- The new skip reason's operator label.

e2e: `REMINDER_BODY_MARKERS` and the `timesFor` ladder mirror both need updating
(`e2e/scenarios/steps.ts`). Restate the marker invariant: a marker must appear in
EVERY variant of its rung - address forks AND tour-type forks. For `en_route` the
two type variants differ exactly where a marker would be drawn from ("text me"
vs "text here"); `on the way` still satisfies it.

Two further e2e notes. `tourReminderBody()` (`steps.ts:173`) composes expected
bodies through the app's own composer, so once names are required the expectation
couples to the SEEDED tenant's first name. And the new skip rules change how many
rows a short-horizon booking arms, so any spec asserting a rung count for a
near-term tour can flip; `tourScheduleFullLadder()` (14:00, two days out)
survives the retiming cleanly (19:30 D-1 < 10:00 D < 13:00 D < 14:00 start).

## 14. Gates

The five required gates, from the feature worktree, run BARE: `npm run
typecheck`, `npm test`, `npm run smoke`, `npm run e2e`, and `npx eslint` over the
branch's own touched files.

Do NOT pipe a gate command. In the 2026-08-18 session `npm run e2e | tail`
returned the pipe's exit code and a failing suite (10 failed) was reported as a
pass. Capture to a file and read the real exit code. This is not a filed issue,
it is a first-hand incident from that session.
