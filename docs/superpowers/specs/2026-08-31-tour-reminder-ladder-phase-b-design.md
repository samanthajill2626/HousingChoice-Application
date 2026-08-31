# Tour reminder ladder Phase B + relay group templates - design

Date: 2026-08-31
Branch: `feat/tour-reminder-ladder-phase-b`
Base: `main` @`ec32170a`
Predecessor: `docs/superpowers/specs/2026-08-26-tour-reminder-ladder-design.md`
(Phase A, merged @`a509eb3b`)
Ledger this discharges: `docs/issues/tour-reminder-ladder-phase-b.md`

## 1. What this is, and why it is ONE mission

Two bodies of work that an earlier split by "risk profile" tried to separate:

- **Turn the tour reminder ladder on.** It has been paused since 2026-08-20
  (`MANUAL_ONLY_REMINDER_KINDS`): every rung still arms and displays, nothing
  auto-sends. Phase A shipped the copy, the name resolution, the retiming and
  the skip rules, and deliberately did not lift the pause.
- **Rewrite the relay group templates** to Sam's 2026-08-24 wording.

They are one mission because the relay copy needs the SAME tokens and the SAME
name resolution Phase A already built (`app/src/lib/tourContacts.ts`), and
because the unpause has an ordering chain that has to be reasoned about as a
whole. Designing them apart is what let the scope drift the first time.

**Governing founder document:**
`W:\AI Projects\Housing Choice\HousingChoiceMessageTemplates_Sam_edits.docx`
(Sam's edits, 2026-08-24). The parallel
`HousingChoice_Templates_Relay_and_Tours_Sam (1).docx` is DISCARDED - it
conflicts; do not read it.

## 2. Decisions locked before this spec

Every item below was settled with Cameron in the brainstorm on 2026-08-31 and
is NOT open for re-litigation by a reviewer. A reviewer may challenge whether
this document IMPLEMENTS them correctly; it may not re-argue the choice.

D1. Confirmation reminders are gone entirely - not armed, not sent.
D2. Two new sweep skip tokens, not one (section 4).
D3. No new dev seam for immediate sends; test-only vehicles (section 10).
D4. The names-read re-list gets a one-hour bound (section 7).
D5. An `overdue` flag ships on the reminder view (section 8).
D6. Ledger item 8 (supersession citing a retired rung) is ASSESSED, NOT WORTH
    FIXING, and DROPPED - not filed (section 12).
D7. `en_route` is exempt from quiet hours, at BOTH sites (section 6).
D8. Three relay intro variants; the no-owner one is unchanged (section 9.1).
D9. `{members}` is removed in favour of `{names}` (section 9.2).
D10. `member_added` splits per-recipient; ONE persisted row carrying the NEW
     MEMBER's body (section 9.4).
D11. Missing intro inputs fall back to the naked intro (section 9.5).
D12. `interpolate` gets a real single-pass fix (section 11).
D13. Merge everything including the unpause; the human runs the sweep against
     prod from their own machine, and deploys (section 3). The ordering
     CONSTRAINT that motivated this has since been designed out - see 3.1 - so
     what survives is the division of labour: an agent never runs the sweep
     against a real environment.

## 3. Ordering - the part that texts people if it is wrong

The pause is a code constant, so lifting it turns sending on the moment the
branch DEPLOYS. Merge is not deploy in this repo; deploy is a separate
human-driven `scripts/deploy.mjs` step.

### 3.1 The ordering hazard, and why the design removes it rather than sequencing around it

An earlier draft of this spec sequenced the deploy after the sweep and claimed a
re-run would catch stragglers. **That was a race, not a fix** (design review R1,
M4). A tour booked between the sweep and the deploy runs the OLD code, arms a
`confirmation` with `dueAt = now`, and that row is past-due from birth - so it
fires on the FIRST post-deploy tick, before any human could re-run anything.

**So there is a permanent send-side guard - and it is NOT
`MANUAL_ONLY_REMINDER_KINDS`.** A round-2 draft of this section reused that set,
which is wrong twice over (design review R2, R2-2):

- `manualOnlyKinds` is read at exactly ONE place, the poll's due-row filter
  (`app/src/jobs/tourReminders.ts:602-603`). `forceSendReminder` (`:1364`) never
  consults it, so the "guarantee" held only against the poll.
- The panel derives its chip from the same set
  (`app/src/routes/tourReminders.ts:589-597`), so a discontinued rung would chip
  **"Paused"** with a working Send now button beside it - inviting an operator to
  send a message we have decided never to send.

"Paused" means *a human decides when this goes out*. "Discontinued" means *this
never goes out*. Conflating them is what produced both holes.

**RULED: a separate, permanent `DISCONTINUED_REMINDER_KINDS` holding
`confirmation`**, consulted by three surfaces:

| surface | behaviour |
|---|---|
| the poll's due-row filter (`jobs/tourReminders.ts:602-603`) | excluded, alongside the manual-only filter |
| `forceSendReminder` (`jobs/tourReminders.ts:1364`) | REFUSES, reason `kind_retired` |
| the tour panel's chip derivation (`routes/tourReminders.ts:589-597`) | reads "no longer sent", never "Paused" |
| **the contact timeline** (`routes/contactTimeline.ts:84`, `:1091`) | same - it has its OWN `MANUAL_ONLY_REMINDER_KINDS` read |

**The fourth row is the one that would have been missed** (design review R3,
R3-4). Emptying `MANUAL_ONLY_REMINDER_KINDS` without giving the timeline a
discontinued read reintroduces the perpetual-"sending shortly" lie on a rung that
can never send - the exact defect the 2026-08-20 pause chip exists to end, one
surface over.

**Standing hazard for the plan:** this review caught an unenumerated READER three
separate times (the relay previews in 9.0, the second view builder in 8.2, and
this). Every kind-filtering or state-derivation change in this mission must be
grepped for readers app-wide, not reasoned about from the writer's side.

`kind_retired` spans the skip union AND the force-send refusal union - but NOT
quite the way `roster_unavailable` does (R3-10): the poll EXCLUDES a discontinued
kind rather than claim-skipping it, so the skip half has no in-app writer at all.
Only the sweep script (section 4) writes that token. That is a third category in
`claimSkipRow`'s docblock taxonomy and the docblock joins the rewrite list.

### 3.1a The chip runs through a SHARED union - widening it touches the excluded surface

`ScheduledSuppressionReason` is declared once
(`app/src/services/scheduledSendSuppression.ts:1`), mirrored on the wire
(`dashboard/src/api/types.ts:1144`), and consumed as an EXHAUSTIVE
`Record<ScheduledSuppressionReason, string>` by the placement card
(`dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:64`). So adding a
reason is a COMPILE ERROR on the surface section 13 excludes (R3-3).

**RULED, and the exclusion is narrowed rather than broken:** widen the union and
add the ONE label entry the placement card needs to compile. That is build
completeness, not feature work - section 13 continues to exclude BUILDING the
overdue twin there. Stated explicitly so a builder does not read a required
one-line map entry as a scope violation and invent a workaround.

**Discontinued is evaluated ABOVE the shared suppression ladder, not inside it.**
That ladder's written rationale is that a HARDER reason wins (opt-out, kill
switch, manual mode). Discontinued is not a suppression a harder reason should
override - it is terminal. Keeping it outside the ladder leaves that rationale
true for the reasons it was written about.

With this, no `confirmation` row sends by ANY path regardless of when or by what
binary it was armed, the sweep/deploy ordering dependency disappears, and the
sweep becomes panel hygiene rather than a deadline. Section 5's disposal of the
kind is about ARMING only.

`MANUAL_ONLY_REMINDER_KINDS` is then genuinely emptied and its docblock's "TO
RESTORE: empty this set. Nothing else has to change" stays TRUE - which is the
test that the two concepts have been separated properly rather than renamed.

That one line staying true is NOT the same as the docblock staying true (R3-9).
`app/src/jobs/tourReminders.ts:173-206` is about thirty lines, most of which
explain why `confirmation` is IN the set and what its inclusion means; after this
change they describe the wrong set. Full rewrite, not a one-line edit, and the
new text must send a reader to `DISCONTINUED_REMINDER_KINDS` for the kind that
moved.

### 3.2 The remaining sequence

1. Merge the whole branch.
2. The human runs the retirement sweep against dev, then prod, from their own
   machine (`--dry-run` first). NOT an agent action - see section 4.4.
3. The human deploys.

Steps 2 and 3 may now be taken in either order without a burst; this order is
still preferred because it keeps the panel honest from the first moment the new
dashboard is live.

Between them, prod rows carry the new skip reasons while the RUNNING dashboard
has no labels for them. `dashboard/src/routes/tours/RemindersPanel.tsx:107` falls
back to a bare "Skipped" chip on an unrecognized reason, so this degrades
cleanly and resolves itself at deploy. Stated here so it is not diagnosed as a
bug.

**Within the branch**, the build order is: the sweep script, then the test
vehicle conversion, then the manual-only change. The vehicle must exist before
`confirmation` stops arming, because it is what the suites currently ride.

## 4. The retirement sweep

### 4.1 Why it is needed

A manual-only rung is left PENDING, not claim-skipped, so Send now keeps
working. Every rung armed during the pause is therefore still sitting there,
due, waiting. The instant the manual-only set is empty the next poll tick sees
the lot and sends it, carrying OLD dueAts - a burst of reminders for tours that
are long past.

### 4.2 TWO populations, not one

This is the correction that matters, and the ledger did not have it.
`REMINDER_KINDS` governs **arming only**; the poll reads `listDue` and filters
on `manualOnlyKinds`. So dropping `confirmation` from `REMINDER_KINDS` does
nothing to rows that already exist.

- **Population A - the tour has already happened.** Every PENDING rung of any
  kind on a tour whose `scheduledAt` is in the past at sweep time.
  Criterion is THE TOUR BEING PAST, not the dueAt: a `confirmation` armed for a
  tour next week is past-due from birth and must NOT be swept by this arm.
- **Population B - every pending `confirmation`, regardless of tour date.**
  The kind is being discontinued, so an in-flight confirmation for a FUTURE tour
  survives the kind removal, which governs ARMING only.

  Note what this arm does and does not do, because an earlier draft overstated it
  (design review R2, R2-8). Section 3.1's `DISCONTINUED_REMINDER_KINDS` guard is
  what stops these rows SENDING - by every path, permanently. Population B is
  therefore **panel hygiene**: without it those rows sit in the ladder forever
  reading "no longer sent" against a tour that has not happened yet, which is
  noise on a panel whose whole purpose is to say what will and will not go out.
  Sweeping them retires them honestly instead.

A row in both populations takes population A's token.

**Population A retires a documented operator affordance, knowingly.**
`app/src/repos/tourRemindersRepo.ts:152-158` describes restoring a canceled rung
to pending as a deliberate "send it after all", explicitly including a past-due
one. Population A sweeps those too, with no lower bound - a tour that ended ten
minutes ago qualifies. RULED: sweep them. A restored rung on a tour that has
already happened is the same stale text as any other, and the operator retains
Send now on every rung of a tour that has NOT happened. Recorded so the reversal
is visible rather than incidental (design review R1, M17).

### 4.3 Three new `ReminderSkipReason` tokens

`past_event` is NOT reused. It means "would land at or after the tour starts",
which is false of these rows, and spec 8.2 of Phase A already called that reuse
a lie for this row shape.

| token | dashboard label | added by |
|---|---|---|
| `tour_already_passed` | `the tour had already happened` | section 4, population A |
| `kind_retired` | `this reminder is no longer sent` | section 4, population B |
| `names_unavailable` | `couldn't look up the names` | section 7 |

**EACH token touches FOUR sites, and the build does not catch a missed one.**
An earlier draft claimed the existing label test was a safety net; it is not
(design review R1, M6). `dashboard/src/api/types.test.ts:87-106` HAND-COPIES the
reason vocabulary as plain strings, and its own comment states the failure
direction it cannot catch: an app-side token added without touching the
dashboard "fails no build and degrades the chip to a reason-less Skipped".

Per token:

1. `ReminderSkipReason` - `app/src/repos/tourRemindersRepo.ts:38`
2. the dashboard wire union - `dashboard/src/api/types.ts:1207-1223` (`TourReminderView.skipReason`)
3. `REMINDER_SKIP_REASON_LABELS` - `dashboard/src/api/types.ts:1271`
4. `SKIP_REASONS` - `dashboard/src/api/types.test.ts:95`

Site 4 is what makes sites 2 and 3 enforceable, so it is not optional
bookkeeping. `names_unavailable` is listed here rather than only in section 7
because it is the same edit in the same four places.

**A token that ALSO appears in the force-send refusal union needs two more
sites - six, not four** (design review R3, R3-5):

5. the refusal union - `app/src/jobs/tourReminders.ts:1317-1330`
6. `SEND_NOW_ERROR_COPY` in the dashboard

Site 6 matters most for `kind_retired` and `tour_already_passed`, where the map's
generic "please try again shortly" fallback is ACTIVELY WRONG - retrying will
never work. `names_unavailable` deliberately keeps that fallback, because there
retrying IS the right advice.

| token | spans both unions |
|---|---|
| `tour_already_passed` | yes - section 6.1a's force-send refusal |
| `kind_retired` | yes - section 3.1's force-send refusal |
| `names_unavailable` | already did; keeps its generic copy |

Separate tokens rather than one because the panel chip is operator-facing copy.
A swept confirmation for next Tuesday's tour showing "the tour had already
happened" is a visible falsehood, and `kind_retired` is additionally the honest
token for any future kind removal.

### 4.4 Shape: an ops script, run by the human

`app/scripts/retire-paused-tour-reminders.ts`, following the five existing
`backfill-*.ts` precedents exactly (`backfill-relay-optout-flag.ts` is the
closest model):

- a PURE planner function - given a reminder row and its tour, return
  `'tour_already_passed' | 'kind_retired' | 'skip'` - unit-testable with no
  DynamoDB;
- `--dry-run` scans and reports counts, writing nothing;
- every write CONDITIONAL on the state the planner decided from
  (no `sentAt`, no `canceledAt`, no `skippedAt`), so a concurrent runtime write
  cannot be double-applied and a re-run is always safe;
- targets `DYNAMODB_ENDPOINT` and resolves the table via `lib/config.tableName`,
  no local-only guard - it is an ops script the human runs with the target
  environment set on purpose;
- PII: logs counts, tourIds and reminderIds only. Never a name, phone or body.

**No agent runs this against dev or prod.** It is a data mutation on a real
environment; the human runs it. An agent may run it only against a hermetic
local lane. Its RUNBOOK entry is part of this change.

### 4.5 What the sweep does NOT do

Rows armed BEFORE 2026-08-26 for tours still in the future keep their stored
dueAts and begin firing under the OLD timings for one booking horizon (Phase A
spec 9.3, ledger item 6). Nothing re-arms them and nothing should. Expected, not
a bug: the first `day_before` may fire at the old `scheduledAt - 24h`.

## 5. Stopping `confirmation`

Remove `'confirmation'` from `REMINDER_KINDS` ONLY - the `no_show_checkin`
pattern. The kind stays valid in the `ReminderKind` union, in `computeDueAt`, in
`LADDER_ORDER` and in the catalog, so an in-flight row still composes and still
displays.

This is about ARMING only. `MANUAL_ONLY_REMINDER_KINDS` keeps its `confirmation`
entry permanently as the send-side guard - see section 3.1, which is where the
reasoning lives. The two changes are complementary: one stops new rows, the
other stops every row that already exists or that an older deployed binary might
still write.

Founder authority: Sam's 2026-08-24 doc, verbatim - "Turned off:
tour.confirmation and tour.confirmation_no_address. No confirmation text at all
- I'm scheduling manually, so it's redundant."

`tour.confirmation` and `tour.confirmation_no_address` catalog entries STAY.
Phase A spec 6.4 says Phase B disposes of them; that is superseded here - an
in-flight row must still compose for the panel, and the entries cost nothing.
They become unreachable from `armTourReminders` only.

## 6. `en_route` is exempt from quiet hours

Sam approved this explicitly. It must be built at **both** sites; one without
the other reopens the hole. This is Phase A spec 7.3's cut hook.

1. **Arm-time clamp** (`armTourReminders`, `app/src/jobs/tourReminders.ts:306`):
   the `en_route` rung's dueAt is stored UNCLAMPED. Every other rung clamps as
   today.
2. **Fire-time backstop** (the `isQuietTime(now, window)` branch at
   `app/src/jobs/tourReminders.ts:910`): `en_route` is not deferred.

The exemption must NOT change `clampOutOfQuietHours` itself - that helper is
shared with the placement ladder and the timeline. Exempt at the call sites, by
kind.

### 6.1 What this changes for Sam, and what she must be told

Her email documents the current overnight behaviour: a 9am tour yields one text
at 8am with the 4-hour reminder skipped, and **a tour at 8am or earlier gets NO
automated reminder at all**. The exemption changes that second half - an 8am
tour now gets its 7am `en_route`. That is the outcome she approved, but she was
given the old explanation.

**There is no floor on the tour hour.** An exempt `en_route` for a 04:00 tour
sends at 03:00. That is the decision working as directed, not a defect, but it
is the unbounded consequence of it and it was never stated to her. BOTH of these
go in the handback (section 15).

### 6.1a A fire-time past-tour gate, which the exemption makes necessary

There is NO past-tour gate anywhere on the send path (design review R2, R2-1).
Verified: the only `scheduledAt` comparison there is `beforeStart`
(`app/src/jobs/tourReminders.ts:956`), which gates the group-open-pending branch
and nothing else. Arm time has `past_event`; fire time has no equivalent.

Today quiet hours accidentally caps the damage - an overnight backlog defers to
08:00. Exempting `en_route` at fire time removes that last brake, so a worker
returning from an outage at 03:00 texts its entire `en_route` backlog at once,
including rungs whose tours have already happened.

**RULED: a fire-time gate. A rung WHOSE OWN dueAt IS BEFORE THE TOUR, on a tour
that has already started, is claim-skipped `tour_already_passed` instead of
sent.**

**The dueAt-before-the-tour qualifier is load-bearing, not a hedge** (design
review R3, R3-1). `no_show_checkin` is due at `scheduledAt + 30m`
(`app/src/jobs/tourReminders.ts:153-154`): its whole purpose is to fire AFTER the
tour and ask a no-show whether they need to reschedule. A gate on "the tour has
started" would kill exactly the one rung designed to survive it.

So the principle is **"a rung whose own copy assumes the tour has not happened
yet"**, and the qualifier derives the exemption from the ladder's own data rather
than from a name in a list. An earlier draft argued the gate should cover ALL
kinds because "a gate that applies to one rung is the kind of asymmetry the next
reader deletes" - that reasoning is withdrawn, because here it is the argument
that would delete the carve-out the product needs.

**PRECEDENCE.** Position is behaviour, and this gate collides with two existing
ones (R3-2). Evaluated in this order, most-specific first:

1. **past-tour gate** - the truest cause: the tour happened.
2. the group-open-pending bound (`beforeStart`, `app/src/jobs/tourReminders.ts:956`)
3. the names bound (section 7) - which for `en_route` lands at the SAME instant
   as the past-tour gate (`dueAt + 1h` and `scheduledAt` coincide for that rung),
   so without this ordering the two race for the same row with different tokens.

The `beforeStart` branch's comment claims a rung can never be held past the tour;
that becomes false and joins the rewrite list.

**Absent `scheduledAt`:** the gate does NOT apply, and `invalid_schedule` keeps
the rung (R3-11). Firing here would steal a more accurate token.

**Naming:** do not call this "start passed" - that already names a different,
CLIENT-side gate (`e2e/tests/tour-no-show-checkin.spec.ts:21-23`) on the very kind
this one must exempt (R3-12).

Placed with the other pre-claim gates, ABOVE the claim, so a gated rung is
retired exactly once rather than re-listed. The token already exists from section
4, and this makes the sweep what it should have been: cleanup of a condition the
RUNTIME also enforces, rather than the only thing enforcing it. Same reasoning as
section 7.1's names bound - the branch that turns sending on must not also be the
branch that lets a recovered backlog fire stale.

**Force-send** on a past-tour rung REFUSES with `tour_already_passed`, EXCEPT
`no_show_checkin` (R3-6). A refusal, never a claim-skip: the standing posture is
that a human action never retires a rung. The exception is the point - a tenant
who did not show is exactly when an operator reaches for that button.

### 6.2 Interaction with supersession - THE ONE RULE CHANGE THIS MISSION MAKES

An earlier draft claimed un-clamping `en_route` only REMOVES collisions. **That
is wrong** (design review R1, M2), and the counter-example is not an edge case -
it is the 08:00-09:00 band the founder was specifically told about.

Default window 21:00-08:00, tour at 08:30 local:

| rung | raw | today (clamped) | with the exemption |
|---|---|---|---|
| `morning_of` | 04:30 | 08:00 | 08:00 |
| `en_route` | 07:30 | 08:00 | **07:30** |

Today both clamp onto 08:00, `supersededBySlot`
(`app/src/jobs/tourReminders.ts:412-417`) sees `otherDue === dueAt` and retires
`morning_of`, and ONE text goes out. Un-clamping `en_route` separates the slots,
the equality no longer holds, and BOTH send: `en_route` at 07:30 ("she is headed
that way shortly") followed by `morning_of` at 08:00 ("looking forward to having
you tour at 8:30 today"). Two texts, in reverse ladder order, on exactly the
tours this exemption exists to serve.

**RULED: generalize the predicate from equality to `otherDue <= dueAt`.** An
earlier rung is stale when a LATER rung fires at or BEFORE it. Equality was only
ever a proxy for that; clamping is what used to make the two coincide, and the
exemption is what breaks the coincidence.

**The `undefined` guard is explicit and its polarity is part of the rule**
(design review R2, R2-9). `dues.get(other)` is `string | undefined`; today's
`otherDue === dueAt` narrows it for free, `<=` does not - and `undefined <= x`
would coerce rather than error at runtime. Write it as
`otherDue !== undefined && otherDue <= dueAt && otherDue < scheduledIso`. A rung
with no computed dueAt NEVER supersedes: absence is not an earlier send time.

**The `LADDER_ORDER` docblock (`app/src/jobs/tourReminders.ts:158-164`) becomes
false and must be rewritten in the same change** (R2-10). It currently states
that "clamping can only push an EARLIER rung forward onto a later one's slot" -
which is the exact reasoning a future reader would use to "fix" this predicate
back to equality. It has to say why an inequality is now required.

This is deliberately NOT a precedence reorder. Phase A spec 8.1 warns that
reordering rule EVALUATION reopens the vanishing-row problem; this changes no
ordering and no rule's position. It widens one comparison, and only in cases
where clamping has inverted the ladder. On an unclamped ladder the rungs are
strictly increasing in time, so the widened predicate is false for every pair
and nothing changes - which is the regression test.

`supersededInBatch` (the fire-time twin, `app/src/jobs/tourReminders.ts:889-894`)
already retires an earlier rung whenever a later one is in the same batch, so it
covers the resurrected `morning_of` on a catch-up tick without a change. Stated
so the builder does not "make it symmetric" and alter behaviour that is already
correct.

`past_event` still applies (`en_route`'s raw dueAt is `scheduledAt - 1h`, always
before the tour) and `staleDayBefore` does not involve `en_route`.

## 7. Bounding the names-read re-list

Ledger item 7, and the one item whose acceptance was explicitly conditioned on
the pause. When name resolution's contact or unit read THROWS on a rung whose
copy renders what was lost, `composeBodyForRow` raises
`ReminderNamesUnavailableError`, and the poll logs and returns WITHOUT claiming.
There is no bound: a persistently failing read re-lists every tick forever, and
the panel keeps calling the rung `upcoming` because there is no overdue state.

**THERE ARE TWO SUCH SITES AND BOTH NEED THE BOUND** (design review R1, M1). An
earlier draft cited only the first and named a function `sendOneReminder` that
does not exist in the codebase at all:

| site | route | note |
|---|---|---|
| `app/src/jobs/tourReminders.ts:1037-1043` | tenant 1:1 | |
| `app/src/jobs/tourReminders.ts:1210-1216` | relay GROUP | carries the ledger-item-7 comment verbatim |

The group site is the one that matters most: a landlord-led or PM-led `en_route`
rung is the ONLY rung whose copy forks on the property-contact name, so it is the
single rung-differential names failure in the whole ladder - the same fact
section 12 relies on when disposing of ledger item 8. Bounding the 1:1 route and
leaving the group route unbounded would close the smaller half of the hole and
leave the reasoned-about half open.

### 7.1 The failure this actually guards

Not a poisoned row. Absence never throws - a missing contact, a deleted unit or
a nameless contact all return `undefined` and compose the fallbacks. Only a
THROWN read counts. The obvious poisoned-key candidate, an empty-string key
(which DynamoDB rejects identically on every attempt), is rejected by the tour
create route (`routes/tours.ts:315`). That is ONE writer, not proof that no
writer can produce one - seeds and importers reach the repo directly - so the
claim here is narrow: a poisoned row is not the failure this bound is designed
for, whether or not one is reachable.

What throws repeatedly is a **sustained failure of the contacts or units
table**: an IAM permission lost in a deploy, a table misconfiguration, a long
throttling episode. Every rung due during that window re-lists; when the read
recovers, the whole backlog fires at once, carrying copy whose moment has
passed. The bound is what makes an outage degrade into "these did not send, and
the panel says so" instead of "these sent at the wrong time".

### 7.2 The fix - mirror the twin exactly

`roster_unavailable` was bounded for precisely this reason. Reuse its shape, at
BOTH sites identically: past `ROSTER_UNAVAILABLE_GRACE_MS` (one hour,
`app/src/lib/rosterResolution.ts:100`) after the row's `dueAt`, claim-skip with a
new `names_unavailable` `ReminderSkipReason`. Dashboard label:
`couldn't look up the names`. Its four edit sites are in section 4.3 with the
other two tokens.

`names_unavailable` ALREADY exists in the force-send REFUSAL union
(`app/src/jobs/tourReminders.ts:1328`, the union member) - the same dual-union shape
`roster_unavailable` established. Adding it to the skip union is consistent, not
a new naming argument.

One hour and not longer, deliberately: a rung more than an hour past due has
copy that has gone stale regardless of whether the read recovers. An `en_route`
"she is headed over" landing ninety minutes late is worse than a chip saying it
did not send.

The FORCE-SEND path is unchanged - a human action must never retire a rung. It
keeps refusing with `names_unavailable` and the generic retry sentence, so an
operator can still push the rung through the moment the table recovers, for as
long as the rung stays pending.

## 8. The `overdue` flag

A rung is `'upcoming' | 'sent' | 'canceled' | 'skipped'`
(`app/src/routes/tourReminders.ts:138` `TourReminderView`), derived by `stateOf`
(`:157`) from terminal markers alone - `dueAt` is not consulted. So a rung stuck
behind any pre-claim deferral reads "upcoming" with a dueAt weeks in the past,
and nothing says so.

### 8.1 An ADDITIVE BOOLEAN, never a fifth state value

Do NOT widen the `state` union. Two predicates test `'upcoming'` by equality -
`hasUpcoming` (`routes/tourReminders.ts:497`) and the next-rung pick (`:616`) -
and an `'overdue'` value would silently drop overdue rungs out of exactly the
places that surface them.

Add to `TourReminderView` (`app/src/routes/tourReminders.ts:138`) and its
dashboard twin (`dashboard/src/api/types.ts:1191`):

```
/** Derived, never stored: this rung's send time has passed and it still has
 *  not sent. Composes with `suppression`, which says WHY. */
overdue?: boolean;
```

as `state === 'upcoming' && row.dueAt < nowIso`, omitted when false to match the
file's conditional-spread style.

### 8.2 EVERY builder and EVERY renderer - enumerated

There are TWO builders of `TourReminderView`, not one (design review R1, M5). A
flag set in one is a view that disagrees with itself depending on which request
produced it.

| site | what it is | disposition |
|---|---|---|
| `routes/tourReminders.ts:598-609` | the GET list projection | SET `overdue` |
| `routes/tourReminders.ts:336-345` (`viewOf`) | the PATCH state-echo projection | SET `overdue` |

`overdue` needs only `row.dueAt` and a `now`, so neither path takes new I/O.
**Each builder computes its own `nowIso`** - an earlier draft said the handler
"passes the same `nowIso` it already computes", which is false on every path
(design review R2, R2-7): the GET route's is block-scoped inside the
`self_guided && hasUpcoming` branch, and the PATCH path has none at all.

Two OTHER surfaces render the same pending rungs and are EXPLICITLY EXCLUDED
rather than left unmentioned:

| site | why excluded |
|---|---|
| `routes/contactTimeline.ts` (upcoming bucket) | a different wire shape with its own reason vocabulary; it aggregates across tours and placements, and a per-rung staleness flag there is the placement-twin's problem, not this one's |
| `routes/relayGroups.ts` (group scheduled view) | same shape argument; it renders a group's scheduled sends, not the tour ladder |

Both are named in `docs/issues/placement-nudge-overdue-invisible-on-card.md` as
part of that item's scope. An unmentioned reader is where a rule silently
disagrees with itself, so the exclusion is recorded, not assumed.

`overdue` composes with `suppression` rather than competing: a quiet-hours
deferred rung is overdue AND carries `{reason: 'quiet_hours'}`. Chip copy pairs
them.

### 8.3 Scope boundary

`routes/placementNudges.ts` has the identical four-value union, the identical
`stateOf` (`:176`) and the identical blind spot, with its own `'upcoming'`
equality predicates at `:376` and `:419`. It is FILED, not built:
`docs/issues/placement-nudge-overdue-invisible-on-card.md`. This branch does not
touch the placement surface.

## 9. Relay group templates

### 9.0 EVERY call site of the two composers - enumerate before changing either

Both composers have a JOB caller and a PREVIEW caller, and the preview's stated
contract is parity with the job (`app/src/services/rosterEdits.ts:21-22`: previews
must go through the same composers "or a template edit silently diverges"). An
earlier draft named only the jobs (design review R1, M3).

| composer | job | preview |
|---|---|---|
| `composeIntroBody` | `jobs/relayFanOut.ts:634` | `services/rosterEdits.ts:473` |
| `composeMemberAddedBody` | `jobs/relayFanOut.ts:683` | `services/rosterEdits.ts:673` (`buildAddPreview`) |

**RULED: the preview shows the same variant the job would send.** Anything else
breaks the escape hatch section 9.5 depends on, and worse: intro precedence rule
1 pins `intro_body` from what the operator EDITED, so an operator who tweaks a
previewed naked intro would pin the wrong variant permanently.

For `buildAddPreview` specifically, where the job now produces two bodies: the
preview shows the **GROUP** body. That is what the operator is authoring and
announcing; the new member's body is the fixed naked intro and needs no preview.
Its docblock currently says it previews "the body the WHOLE group receives" -
still true of what it shows, but it must be amended to say the new member
receives something different and where that is defined.

Both previews therefore need the same owner-and-names resolution the jobs get
(section 9.3).

### 9.1 Three intro variants, routed on the conversation's owner

`getOwner(conv)` (`app/src/repos/conversationsRepo.ts:385`) returns
`{type: 'tour'|'placement', id}` or `{type: null}`, with a legacy
`placementId` fallback. The intro job already holds the conversation
(`relayFanOut.ts:626`), so the routing is free.

**Precedence, highest first:**

1. An operator-edited `intro_body` - sends verbatim, exactly as today. Sam:
   "the manual, editable opener you just shipped works great for right now -
   nothing to change there, and please don't pull it."
2. `owner.type === 'tour'` -> the tour intro.
3. `owner.type === 'placement'` -> the placement intro.
4. Otherwise, or any missing input per 9.5 -> the naked intro, unchanged.

**Tour intro - the tour is TODAY in the org timezone**

```
Hey {tenantFirstName}! Putting you in a group text with {propertyContactFirstName} to tour {where} at {time}. Looking forward to you seeing the property and meeting {propertyContactFirstName}! Please let us know when you're on the way.
```

**Tour intro - any other day**

```
Hey {tenantFirstName}! Putting you in a group text with {propertyContactFirstName} to tour {where} on {when}. Looking forward to you seeing the property and meeting {propertyContactFirstName}! Please let us know when you're on the way.
```

Sam wrote "at {when}" for both. Our `{when}` renders "Tue, Sep 8 at 3:00 PM", so
"at Tue, Sep 8 at 3:00 PM" reads badly; Cameron approved "on" for the dated
form. The today form drops the date entirely and uses the existing `{time}` -
"on Monday, August 31st at 3:00 PM" for a tour later the same day is confusing.
There is deliberately NO "tomorrow" variant.

"Today" uses the SAME timezone the booked-too-late rules use for their same-day
test (`resolveQuietHoursTimezone`), so the two can never disagree.

**Placement intro**

```
Hey {tenantFirstName}! Excited to have you move into {where}. Please use this group text for all future communication and {propertyContactFirstName} will share updates as they receive them from the housing authority. This can be a long process so if you have any questions feel free to ask in here! We are committed to the process and are excited to have you move in.
```

**Naked intro** - the live copy, rewritten only to drop `{members}` per 9.2. The
sent text is BYTE-IDENTICAL to today's.

**Two notes on the founder copy, neither of which changes a word of it.**

*Sender identity.* The naked intro opens "Hey, it's Sam." - and section 9.4's
argument for giving a new member that body rests on exactly that: a relay intro
carries no brand and no STOP, so "it's Sam" is the only thing telling a stranger
who is texting them from an unknown number. **Sam's tour and placement intros
carry no sender identity at all**, so the same argument applies to them and the
same exposure is real (design review R1, M8). Engineering has stated this
exposure before and the founder directed it anyway
(`app/src/messages/catalog.ts:240-250`). We do NOT invent a sentence for her:
this goes to her as a question (section 15), and until she rules, her copy ships
as written.

*The housing-authority sentence.* `app/src/messages/catalog.ts:250-252` records a
dated 2026-08-20 removal of a housing-authority sentence from `relay.intro`, on
the rationale that "updates come from the landlord, not from Sam". Sam's
placement copy reinstates such a sentence in a form that HONOURS that rationale -
it attributes the updates to the property contact, not to Sam - and the existing
assertion is scoped to `relay.intro`, so nothing breaks. Recorded with its date
here so the next reader of that comment does not file the placement intro as
drift (design review R1, M16).

### 9.2 `{members}` is removed; `{names}` replaces it

`{members}` is a whole computed SENTENCE
(`composeConnectionSentence`, `relayFanOut.ts:189`) carrying fixed copy that
never varies. That copy belongs in the catalog where it is visible and
editable, not buried in code.

`{names}` is the bare list only - "Alice, Bob, and Carol". The naked intro
becomes:

```
Hey, it's Sam. You're now connected with {names} on this number. Reply here and everyone in the group sees it. Use this group text for anything that comes up. It can be a long process, so ask me anything in here!
```

`composeConnectionSentence` becomes a name-list builder. Its no-names branch
today RESTRUCTURES the sentence; as a token it resolves to a noun phrase instead,
so the one sentence in the template always works.

**`{names}` is TOTAL - it never returns the empty string.** An earlier draft
dropped the zero-others branch on the grounds that "a relay group with no other
members is not a group". That is an assumption, the PREVIEW builder can reach the
branch, and a `{names}` with no value in a strict catalog DEFAULT does not
degrade - it THROWS (`app/src/messages/resolve.ts:36`). A crash on a preview, not
a clumsy sentence (design review R1, M12).

| roster | `{names}` |
|---|---|
| names known | `Alice, Bob, and Carol` (Oxford list, FIRST names) |
| no names, 2+ others | `2 other people` |
| no names, 1 other | `1 other person` |
| no names, 0 others | `1 other person` |

The last row is deliberately not "unreachable": it returns a sentence that is
mildly wrong rather than a throw that takes out the preview.

Never a phone number, ever, in any branch. That rule is unchanged.

### 9.2a Catalog metadata for the five new entries

Constrained by existing invariants - `app/test/messages/catalog.test.ts:35-41`
(every `{token}` in a default is declared in `vars`), `:43-52` (a NON-editable
entry uses every var it declares - no dead tokens), and `:62-69` (the two relay
entries are `editable: false` with a written rationale). Stated so a builder does
not guess (design review R1, M15).

Every new id is also added to the `MessageId` union
(`app/src/messages/catalog.ts:36-52`) - omitted from an earlier draft of this
table that presented itself as complete (design review R2, R2-13).

| id | `vars` (in order) | class | channel | editable |
|---|---|---|---|---|
| `relay.intro` | `names` | operational | sms | false |
| `relay.intro_tour_today` | `tenantFirstName`, `propertyContactFirstName`, `time`, `where` | operational | sms | false |
| `relay.intro_tour` | `tenantFirstName`, `propertyContactFirstName`, `when`, `where` | operational | sms | false |
| `relay.intro_placement` | `tenantFirstName`, `propertyContactFirstName`, `where` | operational | sms | false |
| `relay.member_added` | `name` | operational | sms | false |
| `relay.member_added_role` | `name`, `role` | operational | sms | false |

`editable: false` for the same reason the existing entries carry it: nothing can
store or route an override for a relay entry, and advertising a capability the
system cannot honour is what that flag was flipped to stop.

The no-dead-tokens rule is why the two tour variants split `{time}` and `{when}`
rather than declaring both - a single entry declaring both would fail `:43-52`.
`{where}` is declared LAST in every entry per 9.3.

### 9.3 Token contract for the relay entries

Reuse, do not reimplement:

- `resolveTourContactNames` (`app/src/lib/tourContacts.ts`) for
  `{tenantFirstName}` and `{propertyContactFirstName}`. It already brace-strips
  names (`inertName`), which is what keeps a user-supplied name from re-opening
  a token.
- `formatStreet` (`app/src/lib/address.ts`) for `{where}`. It is ALREADY
  street-only for structured addresses; Sam's request for that predates the
  change and is satisfied. A legacy plain-string address still returns verbatim
  (`seed-addresses-unstructured`, out of scope).
- `formatLocalDate` / `formatLocalTime` (`app/src/lib/localTime.ts`) for
  `{when}` ("Tue, Sep 8 at 3:00 PM") and `{time}` ("3:00 PM").

**Declare `{where}` LAST in every new entry's `vars` array.** With section 11's
single-pass fix this is belt-and-braces rather than load-bearing, but the
ordering costs nothing and the address is the one value that is not
brace-stripped.

The composer stays PURE and synchronous, mirroring Phase A's split: a resolver
gathers owner -> tour/placement -> unit + names + roster role, and hands plain
values to a pure entry-selection-and-interpolate function. No repo reads below
the composer.

**The resolver is SHARED and it needs a dependency neither call site has today**
(design review R1, M7). `{role}` comes from `UnitContact.role`, which requires
the unit; the member-added job (`jobs/relayFanOut.ts:669-698`) currently reads
only the conversation, and `buildAddPreview` takes `RosterResolutionDeps` with no
units handle either. So:

- one exported async resolver taking the **OWNER** (`{type, id}`), NOT a
  conversation -> tour or placement -> `unitsRepo.getById` +
  `resolveTourContactNames` -> a plain `RelayIntroInputs` /
  `RelayMemberAddedInputs` value. The JOB does `getOwner(conv)` above it; the
  PREVIEW passes its `RosterOwner` straight through.

  **This is not a style choice** (design review R2, R2-5). `buildOpenPreview`
  (`services/rosterEdits.ts:508`) has no conversation to pass: preview-open runs
  BEFORE provisioning and 409s `relay_already_provisioned` once a thread exists.
  A resolver keyed on the conversation is uncallable from the main authoring path
  for precedence rule 1 - the very call that stores the operator's edited
  `intro_body` (`repos/conversationsRepo.ts:1902`);
- `unitsRepo` (and, for the tour variant, `toursRepo`; for placement,
  `placementsRepo`) added to the job's dep wiring AND to the preview's;
- all four call sites in 9.0 go through it, so the preview cannot drift from the
  job by construction rather than by discipline.

A read failure in the resolver is NOT a throw: it degrades to missing inputs,
which 9.5 turns into the naked intro. A relay intro must never be lost over a
failed unit read, and the preview must never 500.

### 9.4 `member_added` splits per recipient

**This REVERSES the recorded founder decision of 2026-07-14**, which made
`member_added` a single body to the whole group precisely so it could double as
the new member's first contact. Recording the reversal explicitly, with its
date, the way Phase A recorded D2's reversal, so nobody re-derives the old
rationale and "fixes" it back. Authority: Cameron, 2026-08-31, on Sam's
2026-08-24 wording.

**To the GROUP** - Sam's line, with the role clause she asked for:

```
Hey, adding {name} to the group as the {role}.
```

**To the GROUP, when the role does not resolve** - a separate entry, because
the role sits MID-sentence and cannot blank out cleanly (Phase A spec 6.4's
empty-clause trick only works for a trailing sentence):

```
Hey, adding {name} to the group.
```

**To the NEW MEMBER** - the naked intro from 9.1, unchanged, with the full
post-add roster in `{names}`. No tour/placement variants of this: one message.
It is the right body because the new member cannot see any history - a relay
member receives forward traffic only - so this message IS their entire context,
and the naked intro is the one that already carries "it's Sam" and names who
else is on the number.

`{name}` is the FIRST name, matching the 2026-08-20 decision and the name list -
**and it is TOTAL, exactly like `{names}` in 9.2** (design review R2, R2-6). A
relay member can be a bare phone with no contact row; that is why
`ANONYMOUS_JOINED_LABEL` exists today (`jobs/relayFanOut.ts:224`), and the
nameless case is reachable from BOTH callers. Under a strict non-editable
default an unvalued `{name}` does not degrade, it THROWS - killing the job
handler AFTER its `putJobExecutionMarker` claim, so the announcement is LOST
rather than retried, and 500ing the add-preview route.

| new member | `{name}` |
|---|---|
| name known | first name |
| no name | `a new member` |

Lower-cased from the existing constant so it reads correctly mid-sentence in
Sam's wording: "Hey, adding a new member to the group." Never a phone.

`ANONYMOUS_JOINED_LABEL` is REPLACED by this value, not left beside it (design
review R3, R3-13). Left in place it becomes an unused const in a file this branch
touches, and gate 5 would attribute the `no-unused-vars` to this branch - the
exact baseline-attribution trap AGENTS.md warns about, where deleting the last
USE of a symbol fires the rule on a line your diff never touched.

**STOP is omitted on both.** Sam's logged A2P decision for relay intros
(changelog 1.2.1 #7). The new member's first contact IS an intro, so the same
decision governs. DECIDED - do not re-open.

**Role token source: `UnitContact.role`** (`app/src/repos/unitsRepo.ts:69`),
`'landlord' | 'pm' | 'owner' | 'other'` - NOT `ContactItem.type`, which has no
property-manager value.

| roster role | `{role}` |
|---|---|
| `pm` | `property manager` |
| `landlord`, `owner` | `landlord` |
| the owning tour's or placement's tenant | `tenant` |
| `other`, no roster row, no unit, no owner | use the no-role entry |

Free: `resolveTourContactNames` already reads `unitContacts(unit)`.

### 9.5 Missing inputs fall back to the naked intro

ONE rule. A missing landlord, address or tour time on a tour or placement relay
-> send the naked intro. **Exception:** a missing tenant first name degrades
in-sentence the way Phase A already does ("Hey there,").

This must be a fallback and not an empty clause because both new intros use
`{where}` MID-sentence, which Phase A spec 6.4 identifies as exactly the case
the empty-clause trick cannot handle. The escape hatch for a case where the
naked opener is not good enough is the one Sam already uses: the operator sees
the preview and edits it.

### 9.6 ONE persisted row, carrying the NEW MEMBER's body

`sendRelayAnnouncement` (`app/src/services/relayAnnouncements.ts:147`, roster loop at `:190-294`)
persists ONE message row with a `delivery_recipients` map for the whole roster,
then sends that one `body` to every member. Per-recipient bodies change that
function, not just the composer.

**DECIDED (Cameron, 2026-08-31): one announcement row, one bubble, one rollup
chip, and the persisted body is the NEW MEMBER's copy.** The group-side copy
goes out to everyone else and is deliberately NOT shown in the dashboard thread.
`touchLastActivity`'s inbox preview inherits the same body, which is consistent.

**This is a NAMED, DATED EXCEPTION to the founder decision of 2026-07-14 that
everything sent into a relay group must be visible in its dashboard thread.**
Written here with its rationale so it is not filed as a bug: this is the only
message in the product where recipients get different copy, and of the two the
new member's is the one worth seeing. Two rows would mean two bubbles and two
rollup chips for one event, which Cameron ruled out.

Implementation shape: `sendRelayAnnouncement` takes an optional per-member body
selector alongside `body`; `body` remains what is persisted and previewed. The
default (no selector) is byte-identical to today's behaviour, so every existing
caller - tour reminders included - is unaffected.

**In `persist: false` legs-only mode** (the dev intro replay seam) the selector
still drives per-member bodies and there is simply no row - the rule degrades
rather than being undefined (design review R1, M13). Only the intro job uses that
mode today; the member-added job does not. Stated so a builder does not read
"the persisted body is the new member's copy" as a precondition that mode
violates.

Per-recipient DELIVERY (rows and chips) already exists and does NOT help here:
that is delivery state, not bodies.

### 9.7 `relay.group_closed` and the placement nudges - nothing owed

Sam's doc asks to "please delete" `relay.group_closed` and to "DISABLE FOR NOW"
all four placement nudges. Both are already satisfied and neither is in scope:

- `relay.group_closed` is already not sent (changelog 1.2.1 #10). The catalog
  entry and the code STAY.
- The placement nudges are already manual-only. "Disable" means not
  automatically sending, which is already true. Do NOT remove the copy or the
  code.

Recorded so a reviewer does not read the founder doc and file them as gaps.

## 10. Test vehicles - no new dev seam

`confirmation` is the suites' only immediate-send vehicle today. The ledger
recommended budgeting for a new dev seam. **That is not needed**, and the
correction is load-bearing enough to state with its evidence:

- **Unit tests.** Only `armTourReminders` drops a past-due row; the repo's own
  `create` does not. A test-only helper calling
  `tourRemindersRepo.create({tourId, kind, dueAt: now0})` yields an
  immediately-due row of any kind with ZERO production code. Those sites test
  the SEND path, not arming, and arming has its own dedicated cases - so the
  split is more honest than what they do today.
- **E2E.** The vehicle already exists. `e2e/scenarios/steps.ts:2013-2046` -
  `tickTourReminders(justAfter(await armedReminderDueAt(kind)))` - and its
  docblock describes firing a future rung in terms.

E2E runs `workers: 1, fullyParallel: false`, so there is no concurrent-spec
hazard.

**A clock-travel tick is NOT behaviour-neutral, and the converted specs must
expect that** (design review R1, M10). Ticking with a future `now` pulls every
EARLIER same-tour rung into the same `listDue` batch, where `supersededInBatch`
(`app/src/jobs/tourReminders.ts:889-894`) claim-skips them. So a spec converted
to fire `en_route` will find its `morning_of` retired
`quiet_hours_superseded` as a side effect. That is the machinery working, not a
flake - the converted specs ASSERT the retirement rather than being surprised by
it. Note this reaches the same code as section 6.2's widening from the other
direction; the two need to be tested together.

**If a spec genuinely cannot be made deterministic this way, RAISE IT** rather
than building a `POST /__dev/tour-reminders/fire` seam speculatively. Adding a
second code path through the send machinery in the change that turns the send
machinery on is the wrong risk.

The existing dev tick's DELIBERATE DIVERGENCE comment
(`app/src/routes/dev.ts:404-418`) says "Delete this when the hold-back is
lifted; do not leave a permanent dev/prod fork." Honour it: with
`MANUAL_ONLY_REMINDER_KINDS` genuinely empty (section 3.1), the
`manualOnlyKinds: new Set()` override and its comment both go.

**The dev tick must NOT bypass `DISCONTINUED_REMINDER_KINDS`** (design review R2,
R2-3). That set is not a hold-back to be overridden for testing; overriding it
would give e2e a send path production does not have, which is precisely the
dev/prod fork the deleted comment forbids.

## 10a. The conversion inventory - BOTH halves of the mission

**The plan owes a DERIVED, ENUMERATED inventory. A count is not an inventory**
(design review R1 M9, widened by R2-4, which showed the same gap on the relay
half where round 1 had scoped the requirement to `confirmation` only).

### 10a.1 `confirmation` sites - three kinds, and "convert them" is wrong for two

1. **Immediate-send rides** - tests using `confirmation` only because it is due
   at arm time. These CONVERT per section 10.
2. **Arm-time and ladder-position assertions** - tests asserting `confirmation`
   ARMS, or depending on its position as the next rung
   (`e2e/tests/tour-roster.spec.ts:488-501`,
   `e2e/tests/scenarios/scheduled-visibility.spec.ts:234-259`). These are
   DELETIONS or re-baselines: the behaviour they pin is being removed on purpose.
3. **Seeds** - files that arm or expect a `confirmation` rung; re-baseline or the
   fixtures stop matching the ladder.
4. **Sites whose BEHAVIOUR changes without their assertions failing** - the most
   dangerous category, because the suite stays green (design review R3, R3-8).
   `e2e/tests/scenarios/tours.spec.ts:283-287` ticks past the tour and documents
   that earlier rungs fire; section 6.1a's gate changes that behind an ABSENCE
   assertion. The plan hunts these deliberately rather than trusting green.

Section 6.1a also imposes an unstated PRECONDITION on section 10's unit vehicle
(R3-7): a row created with `dueAt: now0` only sends if `now0 < tour.scheduledAt`.
Fixtures carrying hardcoded absolute tour dates must be checked against it, or
the helper silently produces rows the new gate retires.

### 10a.2 Relay sites - four are TRIPWIRES, not passive coverage

Round 1 wrote that the existing catalog tests "cover the new entries". They do
not cover them; several of them FAIL BY DESIGN on exactly this edit, and one
raises rather than fails:

| site | what breaks |
|---|---|
| `app/test/messages/catalog.test.ts:66-69` | THROWS after the `{members}` rename - it builds its expectation with `.replace('{members}', 'M.')`, and the entry is strict + non-editable, so an unvalued declared token raises |
| `e2e/tests/tour-roster.spec.ts:252-269` | splits the default on the LITERAL `'{members}'`; its own failure message names this failure. Asserts against a TOUR preview, so 9.0's routing breaks it a second, independent time |
| `e2e/scenarios/steps.ts:1887`, `:1930-1949` | assert `/You're now connected with/` in the dashboard thread and in EVERY member's fake thread. SHARED steps, so every tour and placement relay spec calling them breaks |
| `app/test/toursApi.test.ts:3989-3998`, `:4096`; `placementsApi.test.ts:989`, `:1007`; `relayGroupPreview.test.ts:151`, `:208`; `relayFanOut.test.ts:703-716` | preview/job parity pins asserting composed bodies directly |

This table is the known FLOOR, not the complete list. The plan derives the rest.

## 11. The shared `interpolate` re-expansion fix

`interpolate` (`app/src/messages/resolve.ts:24-45`) substitutes declared tokens
SEQUENTIALLY into an accumulating string, so a value inserted for an earlier
token is rescanned for later ones. Live today in `relay.member_added`
(`vars: ['joined', 'members']`, both fed from contact display names): a member
named `{members}` injects the member list into the SMS to the whole group.
Filed as `message-interpolate-token-reexpansion`. Phase A closed the NAME vector
at the tour source with `inertName`; the general fix was left because it changes
every message in the app.

**FIX IT (Cameron approved).** Replace the per-token loop with a SINGLE pass
that fills every declared token simultaneously, so a substituted value can never
be rescanned.

**USE A FUNCTION REPLACEMENT, NEVER A STRING ONE.** This is the sharpest thing
round 1 found (M11) and it would have turned the fix into a new vulnerability.
Today's `split(needle).join(value)` is IMMUNE to `$`-patterns. A naive
`template.replace(/\{(\w+)\}/g, value)` with a STRING replacement interprets
`$&`, `$1`, `` $` `` and `$'` inside the substituted value - so a contact who
names themselves `$&$&$&` gets expansion again, through a different door. The
replacement MUST be a callback (`(match, token) => ...`), which never interprets
`$`-patterns, and the regression test MUST include a value carrying `$&` and
`$1`.

Both existing behaviours must be preserved EXACTLY, and each needs its own
regression test:

- an UNDECLARED token stays literal in the output (it is not in `allowed`);
- a DECLARED token present in the template but missing from `vars` THROWS for a
  code-controlled DEFAULT (`strict`) and degrades to the empty string for an
  operator OVERRIDE (`!strict`). That split is load-bearing: an operator's
  personalized `welcomeText` using `{firstName}` can fire on a path with no
  name, and must not crash the send.
- a DECLARED token ABSENT from the template needs no value and must not throw
  (`welcome.sms` declares `{firstName}` for override use).

This touches every message in the app. It is a pure function with no I/O, which
is what makes it a small risk, but the test coverage above is not optional.

## 12. Ledger items disposed of here

| item | disposition |
|---|---|
| 1. retirement sweep | BUILT - section 4, plus the second population the ledger missed |
| 2. empty manual-only + stop arming `confirmation` | BUILT WITH A CORRECTION - sections 3.1 and 5. The set is NOT emptied; `confirmation` stays in it permanently as the send-side guard |
| 3. replacement immediate-send vehicle | BUILT differently - section 10; no seam needed |
| 4. quiet-hours exemption hook, both sites | BUILT - section 6 |
| 5. the founder's open `en_route` question | ANSWERED - exempt; section 6 |
| 6. in-flight rows fire under OLD timings | ACCEPTED, documented - section 4.5 |
| 7. unbounded names-read re-list | BOUNDED - section 7 |
| 8. `confirmation` retired citing a rung that never armed | **ASSESSED, NOT FIXED, DROPPED - not filed.** See below |
| 9. failure-scope derivation reads catalog DEFAULTS only | RE-DEFERRED - see below |

**Item 8, in full, because the ledger asks Phase B to "say which one you are
doing".** It is TWO defects. The arm-time one (`supersededBySlot`) does vanish
when `confirmation` stops arming, and with confirmation gone it is only
reachable at all when quiet hours start at or before 19:30 - not the default.
The fire-time one (`supersededInBatch`) has no armability check and does NOT
vanish. But for it to cost a message, the later rung must fail for a reason that
would not also have killed the earlier one, and every terminal failure mode is
per-tour or per-tenant - no phone, contact missing, tenant not on roster,
unusable schedule, roster unreadable - killing both identically. The ONE
rung-differential mode is `names_unavailable` on a landlord-led `en_route`. So
the full failing scenario requires worker downtime AND a landlord-led tour AND a
live database read failure, simultaneously - during which the earlier rung was
firing hours late anyway. **Cameron's ruling: disaster-recovery only, drop
entirely, do not file.** The predicate stays as-is.

**Item 9** stays safe and stays deferred: `reminderNamesUsed` derives failure
scope from catalog DEFAULT templates, and no `tour.*` override can exist
(`settingsToOverrides` maps two non-tour ids; no tour compose site passes
`overrides`). This branch adds no override path. The
`TODO(tour-reminder-ladder-phase-b)` marker is RE-POINTED at
`docs/issues/tour-copy-where-token-declared-not-passed.md`, its sibling of the
same class, rather than left pointing at a closed ledger.

## 13. Out of scope

- Settings UI for tour copy. Cameron ruled it OUT. `relay.intro` stays
  `editable: false` and the catalog docblock's reasoning stands.
- `missed_call.autotext` - already solved.
- Legacy plain-string address cleanup - `seed-addresses-unstructured`.
- Voice prompts, `welcome.sms`, compliance-locked entries.
- The placement-nudge `overdue` twin - filed, section 8.2.
- `routes/placementNudges.ts` in general.

## 14. Testing

- **Unit.** The sweep planner (pure, both populations, the not-past-tour
  negative, the operator-restored past-tour rung, and idempotency against an
  already-skipped row). The `en_route` exemption at both sites, AND section
  6.1a's fire-time past-tour gate, AND section 3.1's discontinued-kind guard at
  all three of its surfaces - including `forceSendReminder` REFUSING, which is
  the half a poll-only test would miss. **The section 6.2
  widening: the 08:30-tour double-send as a regression test, AND a normal
  unclamped ladder proving the widened predicate changes nothing there.** The
  one-hour names bound at BOTH the 1:1 and GROUP sites, including the force-send
  path still refusing rather than retiring. `overdue` true/false/absent in BOTH
  view builders. Every relay entry's composition including all four fallbacks and
  the total `{names}` table. `interpolate`'s three preserved behaviours, a
  re-expansion regression, and a `$&`/`$1`-bearing value.
- **E2E.** The converted immediate-send sites, each asserting the same-tour
  retirements a clock-travel tick causes (section 10). A tour relay intro and a
  placement relay intro landing in every member's fake thread with resolved
  names, AND the operator PREVIEW showing the same variant. `member_added`
  proving the new member's fake thread carries the naked intro while the others
  carry Sam's line, that the preview shows the GROUP line, and that ONE row is
  persisted carrying the new member's body.
- **Catalog.** The existing "no dead tokens" and label-completeness tests cover
  the new entries; add a case pinning the naked intro's composed output is
  byte-identical to the pre-change body.

## 15. Owed to the founder (handback items, not build work)

1. `en_route`'s quiet-hours exemption changes what her email told her about
   tours at 8am or earlier - they now get a reminder where the email said they
   get none. It also has NO FLOOR: a 4am tour texts at 3am. Tell her both
   (section 6.1).
2. **Her tour and placement intros carry no sender identity**, where the naked
   intro opens "Hey, it's Sam." A relay intro carries no brand and no STOP, so
   on those two variants a stranger's first text from an unknown number says
   nothing about who it is from. Engineering has stated this exposure before and
   she directed it anyway; this is the same class of decision and it is hers.
   Her copy ships as written unless she says otherwise (section 9.1).
   SEQUENCING: because the deploy is a separate human step, she can be asked
   BEFORE the first tour or placement intro ever sends - not after.
3. Confirm that `pm` on a unit roster is what she means by "property manager"
   (section 9.4).
4. The placement intro runs about 370 characters, roughly three SMS segments.
   Phase A spec section 5 rules that a cost note, not a gate. Do not shorten her
   words.
5. Her question "please also confirm {landlord} is wired to tour templates and
   not just to relays" - it is, as `{propertyContactFirstName}` on
   `tour.en_route_landlord_led`.
