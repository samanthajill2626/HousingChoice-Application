# Spec adjudications

Date: 2026-09-01
Reviewers: A (`spec-r1-reviewer-a.md`), B (`spec-r1-reviewer-b.md`,
`spec-r2-reviewer-b.md`).

---

# Round 1

30 findings, 7 BLOCKING across the two reviewers. They converged independently
on the same three blocking defects (A1/B2, A3/B3, A4/B1), the strongest signal
in the round.

Verdict counts: ACCEPT 24, ACCEPT-AS-RISK 3, REJECT 0, MERGED-DUPLICATE 3.
Decisions changed: yes - generation mechanism, delete mechanism, layout
anchoring.

## Blocking

**A1 / B2 - `claimSend` resurrects a deleted row. ACCEPT.**
Verified at `app/src/repos/tourRemindersRepo.ts:285`: an `UpdateCommand`
conditioned only on `attribute_not_exists(sentAt|canceledAt|skippedAt)`. On a
swept row all three hold, so DynamoDB CREATES the item, the claim succeeds, and
the poll sends a reminder for a schedule that no longer exists - from a stub row
with no `tourId`, `kind` or `dueAt`. D1 is inert without a guard. Spec now
requires `attribute_exists(reminderId)` on `claimSend`, `claimSkip` and
`cancel`. `uncancel` already requires `attribute_exists(canceledAt)`.

**A3 / B3 - `armedFor` is not a generation identifier. ACCEPT, redesigned.**
Verified at `app/src/routes/tours.ts:1172`: `rearmTrigger` fires on
`scheduledAtIso !== undefined || patch['status'] === 'scheduled'`, so a
status-only revival re-arms at the STORED time and a no-op re-PATCH re-arms at
an unchanged time. Two generations would share an identifier. Replaced with a
per-arm stamp (further redesigned at round 2 - see below).

**A4 / B1 - a third `cancelTourReminders` caller. ACCEPT.**
Verified at `app/src/routes/placements.ts:716` - tour-to-placement conversion,
between `claimConversion` and `create`, inside a claim/release compensation.

## High

**A2 / B13 - the in-memory fake cannot reproduce the defect. ACCEPT** (but see
round-2 finding 5: my remedy was inverted).
**A5 - two non-null assertions on a deletable row.** Verified at
`routes/tourReminders.ts:395` and `:462`. ACCEPT.
**A6 - legacy sent rows have no `sentBody`** and would recompose against the
CURRENT tour time. ACCEPT.
**B5 - the disclosure has no reachable render slot.** Verified at
`RemindersPanel.tsx:346`. ACCEPT.
**A8 / B6 - D4 breaks bottom-anchoring.** Verified: deps
`[clusters, resetScrollKey, paging?.olderPagesLoaded]` (`Timeline.tsx:1920`),
48px slack (`:1838`), `overflow-anchor: none` (module CSS :142). ACCEPT.
**A9 - uncapping the block can show FEWER messages.** ACCEPT; resolved at round
1 with a height cap, RE-RESOLVED at round 2 (see finding 6).

## Medium and low

All accepted and folded in: A10/B11 (e2e blast radius), A11/B10 (terminal tour's
panel goes empty), A13/B7 (acceptance asserted shipping behavior), B8 (the
"interrupted sweep" slogan), B12 (five `listByTour` sites, not three), B14
(vacuous `next` clause), B15 (`.upcoming` is a sibling of `.streamWrap`; 404 not
409), A14 (`retire-paused-tour-reminders.ts` - see round-2 finding 10, this was
WRONG).

## Accepted as risk

B9 (`listByTour` GSI consistency) and A15 (unpaginated `listByTour`) - both
contested at round 2; B9's contest is upheld.

---

# Round 2

13 findings on the revision, 1 BLOCKING. The round changed decisions again, so
it is not terminal. ACCEPT 12, ACCEPT-AS-CORRECTION-OF-MY-OWN-ERROR 2 (5, 10),
PARTIAL 1.

**R2-1 - `armedAt` collides on the injected test clock. ACCEPT, redesigned.**
Verified: `routes/tours.ts:251` takes `deps.now`, and `toursApi.test.ts:1228`
injects the constant `ARM_NOW`. Two arms inside one test share an instant, so
3.1's "can never share an `armedAt`" - which I grounded in await-ordering -
buys nothing where the build will actually be tested. Await-ordering does not
advance a clock. A time-derived generation key was the wrong shape.

**R2-2 - `maxArmedAt` is computed over SURVIVORS and is not monotonic. ACCEPT,
same redesign.** A terminal sweep that deletes the whole newest generation
promotes the previous one back into the current ladder. Deriving "current" from
the rows that happen to remain cannot be correct, because the sweep's job is to
remove rows.

Both are answered by moving the pointer OFF the rows and ONTO the tour:
`ladderId` (a UUID per arm call, immune to any clock) stamped on every row, and
`currentLadderId` stored on the tour. Current = rows matching the tour's
pointer. Nothing is derived from survivors; a terminal sweep clears the pointer,
which is exactly "this tour has no current ladder".

**R2-3 - "`earlier[]` can hold only `sentAt` rows" is false. ACCEPT.** A sweep
delete can be lost to a swallowed `allSettled` rejection or GSI lag, and the
surviving unsent rung would land in a read-only disclosure with no Cancel -
invisible, uncancelable, and still due to fire. Answered by defense in depth:
the poll refuses to claim a rung whose `ladderId` does not match the tour's
pointer, so a missed row cannot send even if it survives.

**R2-4 - contesting B9's accept-as-risk. UPHELD, my adjudication was too
narrow.** I reasoned only about the READ converging. The SWEEP's GSI miss does
not converge - nothing re-runs it - and D1 removed the `canceledAt` stamp that
used to leave the operator a manual remedy. Folded into the R2-3 answer: the
claim-time pointer check is what makes a missed row harmless.

**R2-5 - my "correct the fake" instruction is inverted. ACCEPT, my error.**
`twilioWebhookHarness.ts:2971-2974` returns `false` on a missing row, which IS
the correct behavior once `attribute_exists(reminderId)` lands. Following my
round-1 remedy would have re-injected the resurrection bug into the double. The
requirement is only that the RACE be proven at the repo layer against DynamoDB
Local; the fake stays as it is.

**R2-6 - the cap decides height but never the PIN TARGET. ACCEPT, re-resolved.**
With `scrollTop = scrollHeight` the capped block still occupies the bottom of
the viewport at rest, so acceptance 8 was unsupported. Resolved by changing the
pin target instead of the height: at-bottom means the last MESSAGE is at the
bottom, with the Upcoming block just below the fold. This also dissolves R2-7 -
with no cap needed, the nested scroller goes away too.

**R2-7 - a nested scroller the first draft rejected by name. ACCEPT** (resolved
by R2-6: no cap, no inner `overflow-y`).

**R2-8 - `GroupTextView.tsx:451` passes a fresh `[]` literal every render.
ACCEPT.** "Add `upcoming` to the deps" would make the pin effect fire every
render there. The dep must be a stable derived key, not the array identity.

**R2-9 - the seed rule is underspecified for raw-row builders. ACCEPT.** A
partial stamp on `matrix.ts`'s same-tour sent-`confirmation`-plus-pending-
`day_before` pair splits a seeded ladder across the disclosure.

**R2-10 - `retire-paused-tour-reminders.ts` already carries the guard. ACCEPT,
my error.** Verified at `:205-207`: `attribute_exists(reminderId) AND ...`. It
is the existing PRECEDENT for the guard 3.2 adds, not a victim of the race.
Section 4 corrected.

**R2-11 - section 4 lists `cancelForTour` as a live writer. ACCEPT** (the
wrapper `cancelTourReminders` owns the three sites).

**R2-12 - the D4 move's test surface is unenumerated. ACCEPT.**

**R2-13 - a won cancel can 404 on its own echo and skip the
`scheduled.updated` emit at `routes/tourReminders.ts:416`. ACCEPT** - the 404
path must still emit.

**A15 (pagination) - PARTIAL.** Still accepted as risk. Round 2 did not contest
it and the arithmetic is unchanged.

---

# Round 3

13 findings, 1 BLOCKING. ACCEPT 13, REJECT 0. Decisions changed again; the
founder was given the option to switch D1 from delete to a superseded STAMP
(which would have collapsed most of the enforcement surface) and RE-AFFIRMED
hard delete with that surface priced in. Round 4 is the last round of the cap.

**R3-1 - Send now bypasses the pointer check, and 3.3's "real state" rule armed
it. ACCEPT, BLOCKING.** Verified at `RemindersPanel.tsx:397`: the Send-now
button renders for any rung in state `upcoming`, which an unsent EARLIER rung
is. `forceSendReminder` is a separate entry point from the poll and carries no
pointer check. My round-2 fix therefore created a live button that force-sends a
superseded reminder. Fixed on both sides: `forceSendReminder` refuses with 409,
and `earlier[]`'s action list is ALLOWLISTED (Cancel only) rather than inherited
from the current-ladder renderer.

**R3-2 - the pointer check was poll-only, so previews lie. ACCEPT.** All three
preview surfaces render a pending rung as a promise to send. Because `listDue`
only picks rows up at `dueAt <= now`, the lie stands until the rung comes due,
not until the next tick. All three now render a mismatched rung as suppressed.

**R3-3 - conversion's compensation is no longer a compensation. ACCEPT.**
`placements.create` failing releases the conversion claim and rethrows, but with
the ladder hard-deleted the tour is left live, `scheduled`, and silently
disarmed. Answered by splitting the operation: clear the POINTER (reversible,
and it disarms immediately) before `create`, sweep only after `create` succeeds.

**R3-4 / R3-10 - the pin target is a predicate, not a constraint, and the dep
must track HEIGHT. ACCEPT.** A sentinel element after the last cluster now
defines at-bottom; a `ResizeObserver` on the block supplies the re-pin signal.
An ids/length key would miss a body wrapping to a second line.

**R3-5 - `Timeline.test.tsx:1375-1481` encodes the old pin contract, and jsdom
does no layout. ACCEPT.** Named in section 4; the anchor proof moves to e2e and
the unit layer keeps the pure predicate.

**R3-6 - arm-vs-caller pointer ownership was undecided. ACCEPT.** Verified:
`ArmTourRemindersDeps` has no `toursRepo`, and `lib/seed/live.ts:514,528,538`
has no repo to thread. Decided as D3a - the armer returns the `ladderId`, the
caller writes it.

**R3-7 - pointer order relative to the sweep unspecified. ACCEPT.** Section 3.2
is now one explicit sequence for all three paths: clear, sweep, arm, set.

**R3-8 - the claim-skip needs a token and user-facing copy. ACCEPT.**
`superseded` / "superseded by a reschedule".

**R3-9 / R3-11 / R3-12 - acceptance 10 false for a short thread; the PATCH
response omits the pointer it wrote (`routes/tours.ts:1164` captured, `:1285`
returned); acceptance 11's group case is unsatisfiable through
`GroupTextView.tsx:451` (`upcoming={[]}`). ALL ACCEPT.**

**R3-13 - A15 conceded again.** Kept as a risk, now lower-consequence: the
pointer check downgrades a missed row from "sends" to "appears in earlier".
