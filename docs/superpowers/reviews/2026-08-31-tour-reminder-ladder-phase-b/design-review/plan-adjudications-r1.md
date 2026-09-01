# Plan design review - round 1 adjudications

Plan: `docs/superpowers/plans/2026-08-31-tour-reminder-ladder-phase-b.md` @`e0df9e50`
Reviewers: A (17 findings), B (17 findings), independent, both `opus`, plan +
spec + repo, blind to the brainstorm and to each other.

**Merged: 21 findings - 20 ACCEPTED, 1 ACCEPTED IN PART. 0 rejected.**
Two spec-level consequences surfaced (P5, P6) - recorded here and patched into
the spec as dated addenda, since both are implementation completeness of
already-locked decisions (D7, D1), not new design.

## P1. ACCEPT [BLOCKING] (B1, B3, A3) - the union widening breaks THREE exhaustive Records, and the plan named one

Verified: `REMINDER_SUPPRESSION_LABELS`
(`dashboard/src/api/types.ts:1259-1268`) is `Record<...suppression reason,
string>` and is the map that renders the TOUR panel chip; the contact
timeline's `ScheduledCard.tsx` carries its own exhaustive record over the same
union (its file head names the pattern); `DeadlinesNudgesCard.tsx:64` was the
only one the plan listed. Adding `'discontinued'` breaks all three at compile
time - which is good (loud), but a builder following the plan literally would
add the placement entry and be left with two compile errors the plan never
mentioned, and the TOUR chip - the one that matters - was routed through a map
the plan did not name. Task 8 rewritten to enumerate all three records plus
`suppressionLead`, with the timeline SCHEDULED CARD as the fourth reader the
spec's standing hazard predicted.

## P2. ACCEPT [BLOCKING] (A2, B5) - emptying the pause turns the e2e worker into a live wall-clock sender

The e2e stack runs the real worker; its 60s poll has been a no-op for every
auto-armed kind since 2026-08-20. Lifting the pause makes it a live sender
DURING every interactive lane and spec run. The harness's own discipline
already absorbs half of this - `steps.ts:1711-1713` orders "assert ARRIVAL,
never which trigger fired" - but rungs a spec deliberately leaves PENDING and
asserts as upcoming can now be fired mid-spec if their dueAt passes during the
run. Task 6 gains an explicit audit step: every touched spec is checked for
pending-rung assertions whose dueAt falls inside the spec's runtime window;
fixtures use far-future dueAts for rungs meant to stay upcoming.

## P3. ACCEPT [BLOCKING] (A1) - `{tenantFirstName}` is not TOTAL in the relay composer

Spec 9.5 rules a missing tenant first name "degrades in-sentence the way Phase
A already does" - and Phase A does it via `?? 'there'`
(`app/src/messages/tourCopy.ts:80-85`). The plan's `RelayComposeInputs` left
the field optional and handed it to strict non-editable entries opening
"Hey {tenantFirstName}!" - a nameless tenant THROWS in the intro job after its
idempotency marker, losing the announcement (the exact failure mode spec 9.4
documents for `{name}`, one token over). The composer builds its vars with the
same `?? 'there'` fallback; test added.

## P4. ACCEPT [BLOCKING] (A4, B2) - the send-now 409 "mapping" the plan extends does not exist

`:654-690` is the no-show-DRAFT route. The real send-now handler
(`routes/tourReminders.ts:421-472`) passes `result.reason` through
GENERICALLY (`const error = ... : result.reason;` at `:466`) with the honest
re-read view attached - so the correct instruction is NO route edit at all,
and the prescribed `res.status(409).json({ error: '...' })` shape would have
DROPPED the `reminder` field the panel needs. Tasks 3 and 7 route steps
deleted; a one-line note records that the generic passthrough is why only the
union member + dashboard copy are needed.

## P5. ACCEPT [HIGH] (B4) - the quiet-hours suppression ESTIMATE is a third kind-blind `en_route` site

The route's estimate (`routes/tourReminders.ts:558-564`) evaluates the
quiet-window disjuncts for every rung regardless of kind, so an `en_route` due
inside the window would chip "Will wait" while the poll (Task 10) now sends
it. That contradicts locked decision D7, not just the plan - the spec's
section 6 named two sites and there are three. SPEC ADDENDUM (dated) added to
section 6; Task 10 implements the kind exemption in the estimate's quiet
disjuncts on both tour surfaces that compute it (`routes/tourReminders.ts`,
`routes/contactTimeline.ts` - same formula per the shared comment at
`:527-528`; `placementNudges.ts` has no `en_route` and is untouched).

## P6. ACCEPT [HIGH] (A5) - Task 13 leaves the repo RED between commits

Task 13 rewrote the catalog entries (`{members}` -> `{names}`) while
`composeIntroBody` still passed `members` - every intro send and preview
throws until Task 14. Restructured: Task 13 ALSO rewires the two composers
internally (naked path via `composeNameList`, `{name}` via `joinedName`),
byte-identical output, all call sites green; Task 14 adds the variant
machinery. The byte-identity pin (already planned) is what proves the seam.

## P7. ACCEPT [HIGH] (A6) - two e2e sites misclassified as pure cat-2

`scheduled-visibility.spec.ts:225-259` TICKS and asserts confirmation
ARRIVALS (cat 1) as its re-arm proof, interleaved with next-rung assertions
(cat 2) - "leave green now, Task 9 rewrites" was right about the timing but
Task 9's instruction ("drop confirmation from expected sets") was nowhere near
sufficient: the block's re-arm proof must be REDESIGNED around day_before
(cancel on reschedule, fresh arm, future-tick arrival). Task 9 now says
exactly that. Same treatment for `tour-roster.spec.ts:488-501`.

## P8. ACCEPT [HIGH] (B6, B13) - no verification cadence between Task 2 and the final gates

Full app unit suite now runs at the end of Tasks 3, 7, 9 and 14; full
`npm run e2e` after Task 9 (tour half) and after Task 14 (relay half). Two
extra 18-minute runs buy attributable red - four tasks of e2e edits with no
run until the gate was the plan's own cat-4 mistake applied to itself.

## P9. ACCEPT [HIGH] (B7) - the tour-roster tripwire instruction was impossible as written

The tour-intro entries declare no `{names}` and OPEN with a token, so
"re-target the split to `{names}` on the tour-intro entry" cannot work
(`introHead` would be empty - the exact failure its own guard message names).
Rewritten: the split-tripwire stays aimed at the NAKED entry
(`relay.intro`, which keeps `{names}` mid-template); the tour-preview
assertions become resolved-copy assertions (startsWith "Hey <first>!",
contains the street and "Putting you in a group text with").

## P10. ACCEPT [MEDIUM] (A8, B11) - `refuse` scope + unstated refusal precedence

Both new force-send refusals are placed per the function's actual structure
(read before editing; `refuse` is a local helper), and precedence is now
STATED AND PINNED: `kind_retired` (checked at row lookup, before target
resolution) outranks `tour_already_passed` (after target resolution) outranks
`names_unavailable` (at compose). A discontinued rung on a past tour refuses
`kind_retired` - test added.

## P11. ACCEPT [MEDIUM] (A9, B12, B8) - `toursRepo.get`, and the hoist's re-tokening

Method is `get` (`toursRepo.ts:131`), not `getById` - snippet fixed. The hoist
means a row that is BOTH superseded-in-batch AND tour-missing now takes
`tour_missing` (was `quiet_hours_superseded`) - more truthful; stated and
pinned. Builder greps the comments around `resolveReminderTarget`'s tour fetch
for any the hoist falsifies.

## P12. ACCEPT [MEDIUM] (A7, B14) - Task 1 must EXTEND `resolve.test.ts`, not overwrite

The file exists (~134 lines). Step rewritten: read it, append the new
describes, keep every existing case. The Task 13 probe-id switch is
cross-referenced from Task 13 itself, not just a comment inside Task 1's code
block.

## P13. ACCEPT [MEDIUM] (B10) - the member_added "parity pin" contradicted spec 9.6

Preview shows the GROUP body while the persisted row carries the NEW MEMBER's
- by design. The parity pin is split: intro preview === intro job body;
member_added preview === the job's GROUP body AND persisted body === the
job's NEW-MEMBER body. Both directions pinned.

## P14. ACCEPT [MEDIUM] (B9, A15) - preview path inventory was wrong

There are TWO preview routes but FOUR call sites including
`buildStandaloneOpenPreview` (a fifth composer path). The standalone preview
has no owner -> resolver's null-owner path -> naked intro, byte-identical to
today - its pins are re-baselined to UNCHANGED, and the plan says so instead
of implying they move.

## P15. ACCEPT [MEDIUM] (A12) - the sweep's mutating half ships untested

A DynamoDB-Local integration test is now REQUIRED (the repo's standard
dynamo-backed test idiom): seed rows in the three planner states, run the
script module's apply function against the local endpoint, assert conditional
skips + dry-run writes nothing + a re-run is a no-op.

## P16. ACCEPT [MEDIUM] (A13) - Task 3's tests are self-sufficient

The "use the Task 5 helper if merged" alternative is gone; Task 3 seeds via
`armTourReminders` with a past `now` at tick time, full stop.

## P17. ACCEPT [MEDIUM] (A10) - Task 8's timeline instruction

Rewritten to "read the derivation first" with the grep, and notes the surface
covers 1:1-routed rungs only - the discontinued branch there is simpler than
the tour-panel one, not a copy of it.

## P18. ACCEPT IN PART [MEDIUM] (A11) - `overdue` reaches send-now responses via `viewOf`

True and now tested (the 409 echo carries `overdue` for an overdue pending
rung). Rejected half: no code change follows - the echo SHOULD carry it; the
finding's value is the missing test, not a defect.

## P19. ACCEPT [LOW] (A14) - the vars-charset grep cannot see spread-built arrays

Replaced with a unit test: iterate `MESSAGE_CATALOG`, assert every declared
var matches the interpolate token regex. Structural, spread-proof, and it
guards every future entry too.

## P20. ACCEPT [LOW] (A16, B16) - the founder items get an owner and an artifact

Task 15 now writes `founder-handback-items.md` into the mission records dir
(committed) carrying spec section 15's five items verbatim, including the
ask-Sam-BEFORE-deploy sequencing note. The handback references the file.

## P21. ACCEPT [LOW] (A17, B15, B17) - comment reconciliation sweep

One Task 7/13 sweep list: the `manualOnlyKinds` seam docblocks whose purpose
statement changes (`routes/api.ts:389`, `contactTimeline.ts:115`,
`tourReminders.ts:110`), `steps.ts` `tickTourReminders` docblock ("fires the
just-armed 'confirmation' rung" - false after Task 9), `lean.ts:423`, and the
two comments still naming `composeConnectionSentence` after the rename.

## Round 2

Round 1 changed the plan materially (P1-P9), so one continued reviewer runs
round 2 on the revised plan. Reviewer A landed the round's unique BLOCKING
composer-totality find plus the misclassification; A is continued, handed B's
report.
