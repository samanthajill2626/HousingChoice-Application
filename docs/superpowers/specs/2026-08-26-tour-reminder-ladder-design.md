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
- **Phase B - a later branch.** Two things, together, because neither matters
  until the other happens. (1) Flip the ladder to automatic once the founder's
  outstanding answers are in and the copy is confirmed correct in the panel -
  one line, but it takes on real scope: in-flight rows armed under the OLD
  timing begin firing automatically (section 9.3), and the blast radius is live
  texts. (2) STOP ARMING `confirmation` (section 9.5). Its own branch, own
  review, own deploy.

RULED (Cameron, 2026-08-26): `confirmation` STAYS ARMED through Phase A. The
founder asked for no confirmation text, and while the pause holds she gets none -
nothing auto-sends, and force-send is a deliberate act she simply does not take
on that rung. Un-arming it buys nothing observable now and costs a great deal:
`confirmation` is the ONLY rung whose dueAt is `now`, which makes it the test
suites' universal "fire a reminder immediately" vehicle - roughly forty
structural sites in `tourReminders.test.ts` and fourteen across three e2e specs.
Nothing else can replace it, because a rung already due at ARM time writes no row
at all (`jobs/tourReminders.ts:266`), so the obvious substitute cannot exist.

So Phase A leaves `REMINDER_KINDS` alone entirely. The rung keeps its current
copy; it is simply never sent. Phase B removes it at the same moment the pause
lifts - which is the moment it would otherwise start firing - and owns the
harness surgery then, when the suites have to change anyway.

TWO CONSEQUENCES OF THIS RULING, both accepted, both stated so nobody discovers
them in the panel:

- The founder still SEES a `confirmation` rung on every tour, on a ladder she
  asked to have no confirmation on, and its "Send now" button
  (`RemindersPanel.tsx:347`) is LIVE. Nothing prevents her sending one by hand.
  Accepted: she asked for the rung not to FIRE, and it does not; suppressing a
  per-rung button is dashboard work this phase does not otherwise touch, and a
  disabled button with no explanation is its own confusion. If it turns out to
  bother her in the panel, that is a small follow-up, not a reason to take on the
  harness problem in 9.5 early.
- Its copy is the 2026-08-18 wording, which IS in her voice (it was rewritten in
  the previous pass), but it is now the only rung this change does not touch. So
  the panel shows one rung phrased to an older brief beside four phrased to the
  current one. Accepted for the same reason: rewriting copy for a rung she asked
  to delete is work with a negative expected value.

Sequencing this way is what makes the copy reviewable before the POLL can reach
anyone.

BUT DO NOT READ THAT AS "NOTHING REACHES A TENANT IN PHASE A". Force-send is the
founder's ONLY send path while the pause holds, and it is the path she is using
daily. Every word of the new copy, and every fallback in section 6.3, goes to a
real tenant or landlord the moment she presses Send now. Phase A removes the
AUTOMATIC blast radius, not the human one - so the copy and the fallbacks get
the same scrutiny they would if the poll were live, and `forceSendReminder` is a
first-class path in section 6.3, not an afterthought.

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

GOVERNING REGISTRY ITEM: `docs/issues/founder-message-template-updates-owed.md`
is the tracked home for this whole thread and MUST be updated by this change -
its tour-ladder items close here; its relay items stay open.

One of its entries needs an explicit ruling rather than a silent reversal. It
records the `no_show_checkin` name token as an open PRODUCT question, because the
rung was deliberately kept token-free under spec D2 ("when you are not certain
someone no-showed, vaguer wording is kinder"). Section 5 of this document
reverses D2.

RULED (Sam via Cameron, 2026-08-26): D2 IS REVERSED. The founder asked for
"Hi {tenant first name}! Do you need to reschedule?" with the name, and that is
approved. Recording it here as a dated decision so the reversal is traceable to
a person rather than appearing as drift, and so D2's original reasoning is not
re-argued later without knowing it was considered and overruled.

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

`tour.confirmation` / `tour.confirmation_no_address` are NOT in this table and
are NOT retimed, re-worded or un-armed in Phase A (section 2). They keep their
current copy and keep arming. The founder gets no confirmation text because
nothing auto-sends, not because the rung was removed.

They DO still need the new token declarations from section 6, because the
exhaustive compose matrix in 9.1 covers every kind and would otherwise fail on
them - and because a human CAN force-send one, in which case it must not throw.

SEGMENT BUDGET IS A HARD EXISTING GATE, NOT A MEASUREMENT. `tourCopy.test.ts:115`
already asserts `analyzeSms(body).segments === 1` for every rung composed with a
REAL seeded address, alongside an ASCII check. An earlier revision framed this as
"measure and report at gate time"; that was wrong.

`tour.morning_of` is the longest and highest-volume rung, and the measured margin
is roughly NINETEEN CHARACTERS. So this is a design constraint on the founder's
wording: if the copy grows, that gate goes red and the answer is to shorten the
copy or take the two-segment decision deliberately, NOT to relax the assertion.

READ THE GATE BEFORE TRUSTING ANY MARGIN. As written
(`tourCopy.test.ts:109-118`) it composes with NO `names`, so it measures the
FALLBACK body - the one greeting "there". A real send substitutes a real first
name, and every character beyond five eats into the budget ("Alejandra" is nine
characters against "there"'s five, so four more, not nine - an earlier revision
of this paragraph got that arithmetic wrong and then quoted a margin computed
from the wrong body).

STATE IT AS A BUDGET, NOT A MARGIN. The body has TWO variable inputs, and pinning
one while leaving the other free is how this silently regresses:

    len(firstName) + len(where) <= ~59 characters

for `tour.morning_of` to stay inside one GSM-7 segment. Compute the exact
constant during the build from the final copy and pin it in the test's comment -
a margin quoted against the fallback body is meaningless once a name is
substituted.

The gate must be EXTENDED to compose with representative values for BOTH inputs,
not just a name. `350 Boulevard SE, Atlanta, GA 30312` (the seeded address the
gate already uses) is 35 characters, which leaves roughly 24 for a first name at
that address - comfortable. A LONGER address is the tighter constraint, and it is
the input nobody controls: legacy plain-string addresses carry the full postal
tail (section 6 note on `formatStreet`), so the worst realistic case is a long
legacy address plus a long name. Pin that case, not the comfortable one.

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
  ?? nonEmpty(unit.landlordId)
```

as in `lib/rosterResolution.ts:274` and `services/rosterProvision.ts:233`.

KEEP THE EMPTY-STRING GUARD - an earlier revision of this snippet dropped it. A
legacy unit can carry `landlordId: ''`, and a bare `??` passes an empty string
straight through as a contactId, which then reads as a missing contact rather
than as "no property contact", producing the wrong branch in 6.3b.

`nonEmpty` in `rosterResolution.ts:151` is MODULE-PRIVATE and is not exported, so
it cannot simply be imported - a second correction the round-3 pass caught. Write
the guard inline in the new module rather than exporting `nonEmpty` for one
caller; a one-line `typeof x === 'string' && x.length > 0` check needs no shared
helper, and widening another module's surface for it is the kind of drive-by 6.2
already refuses.

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

CORRECTED after round 2 - the earlier instruction here was WRONG and would have
directed a builder to violate a documented rule.

`firstName` is not a declared field on `ContactItem`; it rides the index
signature, so any read of it must be defensive (a non-string must never reach
`.trim()`).

`app/src/lib/contactName.ts` does NOT export a first-name helper. It exports a
bedroom-suffix convention parser and `contactDisplayName`, a full-name join -
and it carries an explicit scope guard: it is "consumed by PUSH-COPY sites only",
consolidating the older copies is tracked in
`docs/issues/consolidate-contact-display-name-helpers.md`, and the file says in
terms "do not re-point them here as a drive-by". Adding a tour consumer there is
exactly that drive-by.

So: put the first-name helper next to its consumer, in the NEW module section
6.1's resolver lives in (`app/src/lib/tourContacts.ts` - this document's only
new module; 6.1's heading says "reuse, do not reimplement" about the PRIMARY-
CONTACT RULE, not about where the module sits), NOT in `contactName.ts`. That
does add one more local
implementation to the six the tracking issue already counts - accepted
deliberately, because honouring the guard and letting the filed consolidation do
its job later is better than widening a module whose own docblock forbids it.
Add a `TODO(consolidate-contact-display-name-helpers)` marker on the new helper
so it is picked up when that issue is worked.

### 6.3 Fallbacks - absence and failure are DIFFERENT

Absence (no such contact, or no name on it):

- No tenant first name: pass `there`, giving `Hey there, confirming your tour...`.
- No property-contact first name on a landlord-led tour: compose the
  SELF-GUIDED entry instead. Do not invent a filler noun - "your contact will be
  headed that way shortly" reads badly and asserts what we cannot back.

### 6.3a Where names are resolved - the GROUP path is the hard one

CORRECTED after round 3. An earlier revision split this on the wrong axis: poll
versus force-send. The axis that actually matters is 1:1 VERSUS GROUP.

`resolveReminderTarget` (`jobs/tourReminders.ts:641`) returns
`{ route: 'group' }` for a `landlord_led` or `pm_team` tour with a usable group
BEFORE it reaches "resolve the tenant contact" at `:646`. So the group path
performs ZERO contact reads today - and it is precisely the path carrying the
landlord-led copy, which is the only copy needing BOTH names. Nothing to ride
along on; all of it is new work.

RULED (Cameron, 2026-08-26): that plumbing is IN SCOPE for this phase.

THERE IS NO SHARED SEAM. A round-3 revision of this section claimed
`composeBodyForRow` was one and told the builder to resolve there. That was WRONG
on two counts, and it contradicted section 10 of this same document:

- `composeBodyForRow` (`jobs/tourReminders.ts:532`) is MODULE-PRIVATE. Its only
  callers are inside the job (`:846`, `:1006`, `:1224`). No preview can reach it.
- All three previews call `composeTourReminderBody` DIRECTLY and do so
  SYNCHRONOUSLY - `relayGroups.ts:256` is a `((): string => {...})()` IIFE inside
  a `.map()`. An async resolve cannot be dropped behind their compose call.

`composeTourReminderBody` stays PURE and SYNCHRONOUS: it receives already-resolved
names. Resolution happens in EACH CALLER, before composition:

- SEND, 1:1 and group both: inside `composeBodyForRow`, which is already `async`
  and already reads the unit for the address. Widen its deps - they are
  `Pick<RunDueTourRemindersDeps,'unitsRepo'>` today with no `contactsRepo`. On
  the 1:1 route `resolveReminderTarget` has ALREADY fetched the tenant into
  `target.contact`; pass it through rather than reading twice. On the GROUP route
  nothing has been read, so both reads happen here - that is the new work
  ruling (a) put in scope.
- PREVIEWS, all three: HOIST the resolve ABOVE the synchronous composition.
  Resolve once per request, keyed by `unitId` (the property contact varies per
  TOUR, so a single per-request value would stamp one name onto every row), then
  pass the resolved names into the existing sync call.

THE REAL HAZARD IS THE DUPLICATION, and the codebase already names it:
`relayGroups.ts:253` carries "DUPLICATED SHAPE (3 copies, keep in sync)" with
twins in `routes/tourReminders.ts` (`bodyFor`) and `routes/contactTimeline.ts`
(`tourReminderBodyOrEmpty`). Three hand-mirrored compose blocks now each need
identical name resolution and identical fallbacks. Any one of them drifting makes
a PREVIEW disagree with the SEND, which is the exact failure
`tourCopyCallSites.test.ts` exists to prevent and which no test currently covers
at the body level. Extend that guard, or accept that three copies will drift.

### 6.3b Absence versus read FAILURE

Read FAILURE (the contacts read threw) is not absence and must not silently
degrade into a wrong-but-valid message:

- READ paths (the three preview surfaces) degrade to the absence fallbacks and
  MUST NOT throw. Each catches only `UncomposableReminderError`
  (`routes/tourReminders.ts:245`, `routes/contactTimeline.ts:727`,
  `routes/relayGroups.ts:262`), so an escaping repo error 500s the whole bucket.
- SEND paths leave the rung UNCLAIMED on a read failure - the existing
  `roster_unavailable` idiom - and use fallbacks only on genuine absence.

TWO SEND PATHS, NOT ONE. The poll is one; `forceSendReminder` is the other, and
in Phase A it is the ONLY one that reaches anybody (section 2). "Leave unclaimed"
is the poll's vocabulary and does not translate: a human pressing Send now needs
an answer, so force-send returns a REFUSAL the route can render, not silence.
It needs a REASON TOKEN, not a new outcome - a fourth `ForceSendResult` outcome
would break the route's existing ternary at `routes/tourReminders.ts:394`, and
the reason has to reach the string-keyed `SEND_NOW_ERROR_COPY` map or it degrades
to a blank error. That map is SHARED with the nudge route; adding a key there
must not change nudge behaviour.

TWO WATCH ITEMS, both of which make a naive test green before the feature exists:

- `resolveReminderTarget:646` does a BARE `contactsRepo.getById` with no
  try/catch, so a throwing read ALREADY escapes and already leaves the rung
  unclaimed. A test asserting that passes today.
- TENANT ABSENCE IS UNREACHABLE ON THE 1:1 PATH: `:653` returns
  `contact_missing` before compose is ever called. Do NOT write a spec or a test
  that requires an absent tenant to SEND on that route - satisfying it would mean
  deleting the `contact_missing` claim-skip, which is not intended. The reachable
  absence fixture is a contact that EXISTS but carries no name; and on the GROUP
  route, where no contact is fetched at all, absence is reachable directly.

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

That requires resolving an overlap, and round 2 caught this specified for ONE
rule when BOTH have it. For a same-day tour the `day_before` raw dueAt is already
past; for a booking under four hours out the `morning_of` raw dueAt
(`scheduledAt - 4h`) is ALSO already past. In both cases the existing past-dueAt
branch fires FIRST and writes nothing - so the MOST-late booking, the one the
founder most needs explained, is exactly the one that would vanish silently.
That is the opposite of this section's intent.

DECIDED: evaluate BOTH new skip rules BEFORE the past-dueAt check, each for its
own rung only. Leave the past-dueAt branch itself untouched for every other rung
- it is unchanged behaviour other tests pin.

PRECEDENCE, which must be explicit because three rules can now claim the same
rung: for `day_before` and `morning_of` the order is (1) the new booked-too-late
rule, (2) past-dueAt, (3) past-event, (4) supersession / `staleDayBefore`. A rung
retired by rule 1 is NOT re-examined by the later rules.

ONE MIS-ATTRIBUTION THIS ORDERING CREATES, accepted knowingly: a rung whose RAW
time is inside its booked-too-late window AND whose CLAMPED time would have
landed at/past the tour now reports `booked_too_late`, when the more truthful
cause is the clamp. Both are true of the same rung and rule 1 wins by order.
Accepted because the founder-facing answer is the same either way - the reminder
could not usefully fire - and because a combined reason would be worse to read
than either. Do not "fix" it by reordering; that reopens the vanishing-row
problem this precedence exists to solve.

CONSEQUENCE the tests must pin: for `day_before` this makes the past-dueAt branch
effectively unreachable, because any booking late enough to put 19:30-the-night-
before in the past is also late enough to trip rule 1. Named assertions at
`tourReminders.test.ts:1211`, `:356` and `:397` do not merely need re-baselining
- their POLARITY inverts. Re-derive them; do not flip an expectation to make a
test pass.

### 8.2 A new skip reason is required

The NINE existing `ReminderSkipReason` tokens (`tourRemindersRepo.ts:36`) are
`no_conversation`, `contact_missing`, `contact_no_phone`, `tour_missing`,
`quiet_hours_superseded`, `past_event`, `tenant_not_on_roster`,
`roster_unavailable` and `invalid_schedule`. (An earlier revision said eight and
omitted `invalid_schedule`.) NONE means "booked too late for this rung". Reusing
`past_event` is a lie (the rung would land before the tour); reusing
`quiet_hours_superseded` is a lie (nothing superseded it).

DECIDED: add `booked_too_late`, and carry it through the wire union
(`dashboard/src/api/types.ts:1213`) and the operator label map (`:1273`) with the
label `booked too late for this reminder`. Section 13 owes a test on the label.

THE TWO UNIONS ARE HAND-DUPLICATED, app-side and dashboard-side, with nothing
enforcing agreement. Omitting the dashboard half does not fail a build - the chip
degrades silently to a reason-less "Skipped", which reads as a bug in the ladder
rather than a missing label. Change both, and let the label test be what catches
a future divergence.

WHAT `dueAt` IS PERSISTED on a `booked_too_late` row: store the CLAMPED dueAt,
exactly as the `past_event` and `quiet_hours_superseded` branches already do.

An earlier revision said "raw, unclamped" and justified it by the panel's "Next"
selection. That justification was HALF FALSE - `next` is computed from PENDING
rows only (`routes/tourReminders.ts:508`), so a skipped row never supplies it -
and the instruction contradicted the rule that these rows are shaped like the
existing skip branches. Consistency with the neighbouring branches wins; the
RAW value is what the skip RULE compares against (section 8), not what the ROW
stores.

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

### 9.0 THREE tour types, TWO wording buckets - and routing (restored)

RESTORED after round 2. An earlier revision of this document deleted the routing
section wholesale and with it every mention of `pm_team`, leaving the two-id
`en_route` fork above with no mapping for the third type. Do not delete it again.

`TOUR_TYPES` is `['self_guided', 'landlord_led', 'pm_team']`
(`app/src/lib/toursModel.ts:93`). There are THREE types and TWO wording buckets:

| tour type | wording bucket | `en_route` id |
| --- | --- | --- |
| `self_guided` | self-guided | `tour.en_route_self_guided` |
| `landlord_led` | landlord-led | `tour.en_route_landlord_led` |
| `pm_team` | landlord-led | `tour.en_route_landlord_led` |

`pm_team` takes the landlord-led wording (Cameron, 2026-08-26), with
`{propertyContactFirstName}` resolving to the PM via the unit's primary contact -
which is what makes that sentence true rather than naming the owner. Any
selection logic must therefore branch on `=== 'self_guided'` and let both other
types fall through, NEVER enumerate `landlord_led` alone.

THIS IS NOT THEORETICAL: `app/src/lib/seed/matrix.ts:930` makes every THIRD demo
tour `pm_team`, while the lean e2e seed has none - so an implementation that
mishandles it passes the whole e2e suite and breaks the demo world.

ROUTING is UNCHANGED and needs no work. `landlord_led` and `pm_team` reminders
already go to the tour's masked GROUP thread, with a 1:1 fallback when no usable
group exists; `self_guided` goes to the tenant 1:1
(`jobs/tourReminders.ts:641`, founder decision 2026-07-02). The founder's
"confirmed with you - landlord-led reminders go into the group text" is a
description of existing behaviour, not a request.

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

### 9.4 `confirmation` - NOTHING CHANGES IN PHASE A

Superseded by Cameron's 2026-08-26 ruling in section 2. `confirmation` keeps
arming, keeps its current copy, and keeps its `MANUAL_ONLY_REMINDER_KINDS` entry
- whose 6-line rationale at `:149` therefore stays TRUE rather than becoming dead
state. `REMINDER_KINDS` is not edited in this phase.

The only Phase A change touching these entries is the token declarations from
section 6, which they need for the 9.1 matrix and for a force-send not to throw.

### 9.5 What Phase B owes here

When Phase B lifts the pause it must, in the same change, stop arming
`confirmation` - remove it from `REMINDER_KINDS` only, the `no_show_checkin`
pattern, leaving the kind valid in the union, `computeDueAt`, `LADDER_ORDER` and
the catalog so in-flight rows still compose (9.1). At that point its
`MANUAL_ONLY_REMINDER_KINDS` entry DOES become dead state and its comment DOES
become false; correct both then.

Phase B also inherits the harness problem Phase A deliberately avoids:
`confirmation` is the suites' only immediate-send vehicle (~40 sites in
`tourReminders.test.ts`, ~14 across `scheduled-visibility.spec.ts`,
`tour-roster.spec.ts` and `tours.spec.ts`), and no armed rung can replace it
because a rung already due at arm time writes no row (`:266`). Phase B needs a
different mechanism - most likely a dev seam that arms a row with an arbitrary
dueAt - and should budget for that rather than discovering it.

### 9.6 THE UNPAUSE BACKLOG - Phase B's real hazard

A manual-only rung is left PENDING, not claim-skipped, so that "Send now" still
works. That means every rung armed while the pause holds is still sitting there,
due, waiting. `confirmation` is armed with `dueAt = now`, so it is past-due the
instant it is written: EVERY tour booked during Phase A leaves a pending,
already-due `confirmation` row behind it.

The moment Phase B empties `MANUAL_ONLY_REMINDER_KINDS`, the next poll tick sees
all of them at once and sends the lot.

TWO THINGS TO BE HONEST ABOUT. First, this is NOT created by ruling (b) - the
ladder has been paused since 2026-08-20 and all four armed rungs have been
accumulating pending rows since. Phase B was always going to face it. Ruling (b)
adds `confirmation` to the pile and keeps the pile growing. Second, it is not
only a volume problem: those rows carry OLD dueAts (section 9.3), so what fires
is a burst of reminders for tours that are long past.

So Phase B owes a ONE-TIME RETIREMENT SWEEP of stale pending rows BEFORE it
lifts the pause - retire anything whose dueAt is meaningfully past, as
`past_event` - and must prove it on real dev data, not only in a test. Lifting
the pause without that sweep texts a backlog of tenants about tours that already
happened. Write it into the Phase B branch as its first task, not its last.

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

- A short-notice booking can now produce a ladder where every AUTOMATED rung is
  skipped: `day_before` past, `morning_of` by rule 2, and `en_route` clamped past
  the tour for an evening booking. `confirmation` still arms in Phase A
  (section 2), so the trace is not empty - but nothing is SENT, because the
  ladder is paused. The founder will meet this in her first week.
- RESCHEDULE AND REVIVAL STAMP THE NEW SKIP TOO. `armTourReminders` is called
  from `routes/tours.ts:349` (book) AND `:1168-1182` (PATCH: any `scheduledAt`
  change, and any status move back into `scheduled` from `canceled`/`no_show`).
  `now` is the ARM instant, so back-dating a tour, or reviving a cancelled one
  onto its stored time, evaluates both skip rules against the REVIVAL moment -
  and can stamp a visible "booked too late" chip on a tour nobody booked late.
  That is a mutation surface no earlier revision enumerated. Accepted as
  correct-by-mechanism (the rung genuinely cannot usefully fire), but the CHIP
  WORDING must not accuse: it says when the reminder was armed too late, not
  that the operator was slow. Worth a test on the revival path.
- The operator-facing label `morning_of: 'Morning of'`
  (`dashboard/src/api/types.ts:1242`, mirrored `e2e/scenarios/steps.ts:205`) is
  now wrong - for a 7pm tour that rung fires at 3pm. DECIDED: RELABEL it to
  `4 hours before`. The persisted KIND keeps its name for the migration reason in
  section 9; the LABEL has no such constraint, and leaving a staff-facing lie in
  place because the key underneath is stuck would be the worst of both.

  KNOCK-ON the relabel decision did not account for: that label is INTERPOLATED
  into aria-labels (`RemindersPanel.tsx:347`, `:358`), producing "Send 4 hours
  before reminder now", and one of those is a PINNED accessible-name contract at
  `e2e/support/selectors.md:72`. The label map alone is not the whole edit: fix
  the surrounding sentence so it still reads as English, and move the pinned
  contract with it. If no phrasing reads well, prefer changing the SENTENCE
  ("Send the 4-hours-before reminder now") over reverting to a label that lies.

## 12. Open items with the founder (do not block)

1. Whether to exempt `en_route` from quiet hours, for 8-9am tours. The hook is
   NOT built here - see 7.3, it is CUT from Phase A. (An earlier revision said
   "built here but stays empty", contradicting 7.3; corrected in round 2.) Moot
   while the pause holds, so this is a Phase B question, and Phase B owes a
   registry entry for the deferral rather than relying on this line.
2. `relay.member_added` wording and the per-recipient body idea. Separate branch.

## 13. Testing

Suites that pin this copy or timing and WILL break:

`tourCopy`, `tourReminders` (roughly FORTY structural sites keyed on
`confirmation`), `toursApi`, `seedLive`, `relayApi`, `messages/catalog`,
`tourRemindersApi` (`:244`, `:844`, `:1088`), `contactTimeline` (`:1108`),
`devGating` (`:459`), `tourCopyCallSites` (the `ALLOWED_DIRECT` whitelist), and
`dashboard/src/routes/tours/RemindersPanel.test.tsx` (asserts the "Morning of"
label and a skip chip).

`relayAnnouncements` was listed here in an earlier revision and is NOT affected -
`:60` uses a literal body and a rung-derived tag string. Removed rather than left
to waste someone's time.

NON-TEST SURFACES that state the ladder and must move with it - each is a READER
that would otherwise disagree with the new rule:

- `documentation/tours-sequence-writeup.md:110` states the ladder verbatim.
- `app/src/lib/seed/matrix.ts:958` is a THIRD hardcoded `scheduledAt - 24h`
  carrying a `computeDueAt('day_before') parity` comment this change falsifies,
  and `:930` is the `pm_team` generator from 9.0.
- `app/src/lib/seed/live.ts` describes a "Full 5-rung ladder".
- `app/src/lib/seed/cast.ts:768-795` is a FIFTH reminder-row writer, hardcoding
  the old `08:00Z` ladder times. Found only at round 4, after three passes that
  each believed the enumeration complete.
- `e2e/support/selectors.md:72` pins the Send-now accessible-name contract,
  which lists "Morning of".

NO SEED WRITES `sentBody`. The read paths render a stored `sentBody` only when
one exists (`routes/tourReminders.ts:236`) and otherwise RECOMPOSE from the live
catalog - so every seeded "already sent" reminder row will silently re-render in
the NEW copy, including rows representing historical sends in the demo world.
That is not wrong exactly, but it means the demo shows tours from months ago
quoting wording that did not exist then, and it is worth a deliberate decision
rather than a discovery.

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

### 13.1 The 19:30 rung versus the quiet-hours timing contract

THE HARDEST e2e PROBLEM IN THIS CHANGE, and an earlier revision framed it as
arithmetic. `e2e/tests/scenarios/quiet-hours.spec.ts:21` declares an explicit
TIMING CONTRACT - "the part that makes this deterministic at ANY wall clock" -
and the suite is deliberately time-of-day INDEPENDENT, built that way after a
documented time-of-day flake class. A `day_before` anchored to a fixed 19:30
org-local instant is precisely the dependency that contract exists to exclude:
whether 19:30 falls inside the spec's synthetic window changes behaviour with the
wall clock the suite runs at.

Do NOT approximate 19:30 host-locally to paper over this - that is the "wrong
answer waiting to be used" the `TourTimes` docblock (`steps.ts:234`) already
warns about, and it is why `morningOf` was removed from that struct.

THE REPO ALREADY HAS THE ANSWER: read the armed `dueAt` BACK from the reminders
API rather than computing it host-side, and drive the tick from that. Any
solution must keep the suite time-of-day independent; a solution that passes only
between certain hours is a regression against a contract someone paid for.

Note the INVERSION this change causes: `morning_of` becomes a pure
`scheduledAt - 4h` offset and CAN now be mirrored host-locally, while
`day_before` no longer can. `TourTimes` should gain `morningOf` and lose
`dayBefore`.

Specs that drive ticks off `times.dayBefore` and must be reworked, not
re-baselined: `quiet-hours.spec.ts:293,318`,
`scheduled-visibility.spec.ts:163,228`, `tours.spec.ts:134`.

### 13.2 What the e2e side DOES and does NOT owe in Phase A

DOES NOT: any `confirmation` rework. Section 2 keeps that rung armed, so its ~14
e2e sites and ~40 unit sites are untouched here. That whole problem moves to
Phase B (9.5), which is also where the replacement mechanism has to be designed
- no armed rung can substitute, because a rung already due at arm time writes no
row (`:266`).

DOES, and each is easy to miss:

- `tour-comms-pane.spec.ts:230` and `tourReminderContext` - both reached by the
  required `tourType` and the threaded names, not by any copy change.
- `tour-no-show-checkin.spec.ts:63-75` - a FOURTH affected spec no earlier
  revision named. Its first half goes vacuous once the copy carries a name, and
  its comment becomes false. Re-derive it; do not just re-baseline the string.
- `tourReminderBody()` (`steps.ts:173`) composes through the app's own composer,
  so once names are required every exact-equality expectation couples to the
  SEEDED tenant's first name. Thread that through the context rather than
  hard-coding a name per spec.
- The new skip rules change how many rows a short-horizon booking arms, so any
  spec asserting a rung COUNT for a near-term tour can flip - and note the
  direction: `booked_too_late` writes a VISIBLE row where the old past-dueAt
  branch wrote none, so those ladders get LONGER, not shorter.
  `tourScheduleFullLadder()` (14:00, two days out) survives cleanly
  (19:30 D-1 < 10:00 D < 13:00 D < 14:00 start).

## 14. Gates

The five required gates, from the feature worktree, run BARE: `npm run
typecheck`, `npm test`, `npm run smoke`, `npm run e2e`, and `npx eslint` over the
branch's own touched files.

Do NOT pipe a gate command. In the 2026-08-18 session `npm run e2e | tail`
returned the pipe's exit code and a failing suite (10 failed) was reported as a
pass. Capture to a file and read the real exit code. This is not a filed issue,
it is a first-hand incident from that session.
