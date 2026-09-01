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

---

# Round 4 (terminal - the cap)

13 findings, 1 BLOCKING, verdict "BUILDABLE: no" scoped to ONE mechanism.
ACCEPT 13, REJECT 0. Doc review stops here regardless: four rounds is the cap.

**R4-1 - one boolean cannot drive both the pin and the pill. ACCEPT, BLOCKING.**
Verified: `atBottomRef.current` gates the pin at `Timeline.tsx:1911` and the
pill at `:1914`. Once content exists below the last message the two gates want
opposite answers - strict reading lights the pill permanently for an operator
standing on the block, loose reading fires the pin and yanks them off it. My
sentinel gave one predicate to both and asserted two properties one boolean
cannot deliver. Replaced with a three-valued anchor (`sentinel` / `below` /
`null`): the pill lights only on `null`, the pin never fires on `null`, and
`below` is anchored to the scroller's true bottom rather than re-pinned to the
sentinel.

**R4-2 - the conversion split stopped one step short. ACCEPT.** Verified at
`placements.ts:757-773`: a FINALIZE failure releases the claim, leaves the tour
`scheduled`, and is retryable by design. Sweeping after `create` but before
finalize reproduces exactly the silently-disarmed tour R3-3 was raised for. The
sweep now runs after the finalize succeeds.

**R4-3 - `superseded` needs four surfaces and two are not typecheck-forced.
ACCEPT.** Verified: `SEND_NOW_ERROR_COPY` is `Record<string, string>` read
through `??` (`dashboard/src/api/types.ts:1327`, `:1379`), so a missing entry
renders the generic retry sentence - silently, and green. Named explicitly in
3.3 along with `ScheduledSuppressionReason` / `suppressionLead`.

**R4-4 - "safe by construction: nothing sends" inverts the hazard. ACCEPT.** A
step-3/4 failure leaves a live `scheduled` tour disarmed with no trace. Safe
from SENDING is not safe. Now carries a stated interruption posture and a loud
log.

**R4-5 - fold `currentLadderId: null` into the patch already being written at
`routes/tours.ts:1164`. ACCEPT** - closes the new-scheduledAt-with-old-pointer
window and saves a write.

**R4-6 - D3a's cost rationale was wrong by ~17 call sites, and the return SHAPE
was unspecified. ACCEPT.** The decision stands on shape rather than count, and
the return is now specified as `{ ladderId, rows }` with `ladderId: null` on a
zero-row arm, which is the case the two candidate shapes differed on.

**R4-7 - the pointer restore needs the old id captured and a failure posture.
ACCEPT** - `placements.ts:759-767` is the precedent and is now cited.

**R4-8 - "allowlisted to Cancel" named no states. ACCEPT.** `RemindersPanel.tsx:408`
would render Restore on a canceled earlier rung. Now a per-state table, with the
note that Cancel cannot win against an already `superseded`-skipped row
(`tourRemindersRepo.ts:361`) and that this is correct.

**R4-9 / R4-10 - section 4's "three sweep call sites" wording after the
conversion split; the ResizeObserver covers the block only and does not fix
`clusters`' pre-existing key. BOTH ACCEPT** (R4-10 added to non-goals).

## Round summary and stop

Four rounds, 69 findings, 65 accepted, 0 rejected outright. Every round found at
least one blocking defect, and three of the four found a defect introduced by
the PREVIOUS round's fix - which is the honest signature of a design whose
enforcement surface is wide, and the reason the founder was given the
superseded-stamp off-ramp at round 3.

Reviewer B's terminal verdict was "BUILDABLE: no", scoped to R4-1 alone; every
other part was called executable. R4-1 is now resolved with a mechanism the
reviewer did not see, which is the one thing this process cannot self-certify.
That residual goes to the human's spec gate as an open item, not silently into
the build.

---

# Round 5 - fresh cold reviewer (founder-requested, past the cap)

11 findings, 1 BLOCKING, verdict "BUILDABLE: no". ACCEPT 11, REJECT 0. A
DIFFERENT model, dispatched cold - spec and repo only, no prior reports, and
instructed not to read rounds 1-4 until its own findings were written. It found
a blocking defect that four rounds of a continued reviewer had missed, which is
the argument for cold independence over accumulated context.

**R5-1 - a cleared pointer is indistinguishable from a never-migrated one.
ACCEPT, BLOCKING.** Verified at `toursRepo.ts:333`: `patch` maps an explicit
null to REMOVE. So "terminal transition cleared the pointer" and "this tour
predates the feature" are the same bytes, and 3.5's pre-migration rule then
re-adopts a terminal tour's legacy rows as CURRENT - a legacy sweep-miss on a
canceled tour would still SEND, and EARLIER legacy rows flip back to current the
moment the pointer clears. Fixed by never removing the pointer: terminal
transitions ROTATE it to a fresh unmatched UUID. Absence now means pre-migration
and nothing else.

**R5-2 - acceptances 5 and 15 contradicted each other. ACCEPT.** One said the
Upcoming buckets render a superseded rung as suppressed, the other said they
return nothing for a superseded ladder. Both were written about "a superseded
rung" without distinguishing the sweep-MISS case from the swept case. Split into
two named fixtures.

**R5-3 - 3.6 converted one scroll writer out of five. ACCEPT.** Verified: the
conversation-switch reset at `Timeline.tsx:1890` and the post-send pin at
`:1976` both do `scrollTop = scrollHeight`, so every thread would OPEN scrolled
onto the Upcoming block - acceptance 12 failing on open, before any growth
happens. The pill-clear at `:1853` was also unspecified. All five writers are
now enumerated with their individual dispositions.

**R5-4 - concurrent reschedules can interleave to a pointer at a swept ladder.
ACCEPT.** 3.2's interruption posture covered a single request failing, not two
succeeding in the wrong order: two 200s, a silently disarmed tour, no error. The
step-4 pointer write is now conditional on the rotation value from step 1.

**R5-5 - "REVERSIBLY" overclaimed on the conversion path. ACCEPT, redesigned.**
A rung claim-skipped `superseded` inside the cleared window can never come back,
because `skippedAt` is terminal (`tourRemindersRepo.ts:361`) - so restoring the
pointer does not restore the ladder, and the token would then be a lie on a
pointer-matched ladder. The pointer dance is dropped from the conversion path
entirely: the tour already carries a reversible in-flight marker (the conversion
claim), and the poll now DEFERS - leaves unclaimed, stamps nothing - for a tour
with a claim in flight. Bounded, because the claim either finalizes or is
released.

**R5-6 - `lib/seed/live.ts` arms through the real armer but writes no pointer.
ACCEPT.** Every demo-world ladder would be born refused. Seeds promoted from a
footnote to a named surface in section 4.

**R5-7 - the copy-surface count was wrong in BOTH directions. ACCEPT.** Three
exhaustive maps break the build, not two (the placement-nudge card and
`ScheduledCard`'s `SUPPRESSION_COPY` were unnamed), and the pair I called
"typecheck-forced" is forced only if the hand-mirrored dashboard union is
updated too - an app-side-only addition compiles green and renders the raw
snake_case token to staff.

**R5-8 - the tour CREATE path was absent from 3.2** and its 201 carries the same
stale-pointer defect the spec fixes for PATCH. ACCEPT.

**R5-9 - "the next PATCH re-arms it" is false. ACCEPT.** Verified at
`tours.ts:1181-1189`: only a `scheduledAt` change or an explicit move into
`scheduled` re-arms.

**R5-10 - `earlier[]`'s "newest first" had no sort key. ACCEPT** - `ladderId` is
a UUID by D3's own argument and `createdAt` ties within one arm call. Now
`sentAt ?? dueAt` descending, `reminderId` tie-break.

**R5-11 - `below` was unreachable for a block shorter than the 48px slack.
ACCEPT** - it is now defined by DIRECTION rather than by slack.

## Where this leaves the process

Five rounds, 80 findings, 76 accepted, 0 rejected outright. Rounds 2, 3, 4 and 5
each found a defect introduced by the previous round's fix. Round 5's blocker
was a REPRESENTATION defect - null-means-remove - that no amount of continuing
the same reviewer was going to surface, because that reviewer had already
accepted the pointer model as given.

The lesson to carry: the four-round cap is about diminishing returns from ONE
reviewer's accumulated context, not about a document being finished. A fresh
cold pass at the end is cheap and, here, caught the most consequential defect of
the five rounds.

---

# PLAN round 1 - two cold reviewers (opus + fable, parallel, independent)

31 findings, 4 distinct BLOCKING. ACCEPT 31, REJECT 0. Both reviewers were
dispatched fresh and told not to read the spec-round reports until their own
findings were written.

**PA-1 / PB-4 - `superseded` was added to the WRONG union. ACCEPT, BLOCKING.**
Verified: `ScheduledSuppressionReason` is a separate closed union at
`app/src/services/scheduledSendSuppression.ts:9-11` and the plan widened only
`ReminderSkipReason`. S6's three preview surfaces render SUPPRESSION, so they
were unbuildable and acceptance 4 undeliverable. Fixed, and pointed at the
`discontinued` precedent documented at the head of that same file: a token that
lives in the union but is never produced by the evaluator, because the callers
short-circuit ahead of it. A pointer mismatch is caller knowledge in exactly the
same way.

**PA-2 / PB-1 - "the fake needs no change" was wrong three ways. ACCEPT,
BLOCKING, my error.** I generalized a true statement about `claimSend` into a
blanket instruction. In fact the fake must gain `deleteSupersededForTour` and
lose `cancelForTour` (so S1's own typecheck gate was unsatisfiable as written),
and its hand-built `create` (`twilioWebhookHarness.ts:2933-2952`) would silently
drop `ladderId` - the exact scar the file documents at `:2939-2946`, where
dropping `input.skipped` once made every arm-time skip look like a live rung to
route-level suites. Only its claim-on-missing-row behavior was correctly
left alone. T1.6 now spells out all three.

**PA-3 / PB-7 - T3.3's compare-and-set had no repo capability. ACCEPT,
BLOCKING.** Verified at `toursRepo.ts:354`: `patch` conditions only on
`attribute_exists(tourId)`. T1.3 now adds a value-guarded write, and both it and
T1.4's claim guard are explicitly required to be proven against DynamoDB Local
rather than the fake.

**PB-2 - the conversion path deletes with NO refusal backstop. ACCEPT,
BLOCKING.** The sharpest finding of the round, and unique to reviewer B. After
finalize the sentinel is gone (so T5.4's deferral ends), the pointer still
matches (I had removed the rotation from this path at spec round 5), and the
poll has no tour-status check - so a rung the sweep MISSED sends on a converted
tour, permanently. The plan's central slice-order guarantee was FALSE at S8.
T8.3 restores it by rotating the pointer together with the post-finalize sweep;
the rotation was only unsafe BEFORE finalize, where reversibility mattered.

**PA-5 / PB-3 - a SIXTH scroll writer. ACCEPT.** `scrollToBottom` at
`Timeline.tsx:1840-1846` is the pill's own onClick; post-move it would scroll the
operator to the block instead of the newest message, and it writes the
`atBottomRef` being replaced. PB-14 also caught line drift in the table
(`:1912`, not `:1911`; the `:1976` citation is an `atBottomRef` write, not a
scroll write).

**PA-4 / PB-4 - the copy census was wrong in BOTH directions again**, for the
third review in a row. ACCEPT. T5.2 now gives a METHOD rather than a list: probe
with `discontinued`, the most recently added token, and treat every map or union
it appears in as a surface.

**PA-6 / PB-8 - T5.4's deferral was unbounded with an undefined predicate.
ACCEPT.** The sentinel is `pending:${randomUUID()}` (`placements.ts:699`), so
the predicate is that literal prefix - a bare "is a string" test would defer
every FINALIZED converted tour forever, since finalize replaces the sentinel
with a real placement id. And a crashed conversion leaves no TTL and no recovery
route, so the deferral is now bounded by this job's own documented grace-window
pattern (`tourReminders.ts:1193-1206`).

**PB-5 - S6 omitted T5.3's pre-migration exemption. ACCEPT.** A literal build
would mark every legacy pending rung suppressed on all three preview surfaces.

**PA-7 / PB-6 - acceptance 16 had no delivering task** (T10.8), **PA-13 / PB-12 -
R6's live phone QA and R4's interruption logging had none** (T10.9, T3.6),
**PA-8 / PB-15 - `earlier[]` views carrying `suppression`** (T7.6), and the
disclosure's default collapsed state (T7.4). ALL ACCEPT.

**PB-10 - T1.4's RED test called a nonexistent `getById`. ACCEPT.** There is no
such method, and `listByTour` is a VACUOUS substitute: the resurrected row is an
attribute-only stub with no `tourId`, so it cannot appear in a `byTour` query
whether or not the bug is present. The test now asserts absence with a raw
`GetCommand`.

**PA-9 (check placement in `processReminderRow`, whose comment reads "POSITION
IS BEHAVIOUR here"), PA-10 / PB (S11's list was closed and incomplete - now
explicitly open, with a grep), PA-14 (do not copy `cancelForTour`'s `pending`
filter, which excludes exactly the rows D1 deletes), PA-15 / PB-9 (`seed/cast.ts`
is a third raw writer), PB-11 (390px contradicted the harness's `NARROW_360`,
and "more messages than main" has no in-run pass/fail), PB-13 (the
ResizeObserver must wire into the existing effect, not a standalone one),
PB-16 (seeded terminal tours), PA-12, PA-11, PB-15 - ALL ACCEPT** and folded in.
