<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-09-02).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` (merge `dc686a04`) and its feature branch + worktree were deleted during worktree
> cleanup. **This file is NOT current documentation, and the live code may have drifted from
> it. Do not treat it as authoritative guidance on how the system should be built or how it
> behaves today.** For current truth read the code and the living docs (e.g. `RUNBOOK.md`,
> `e2e/README.md`, `AGENTS.md`). The mission's review record - reviews, adjudications, slice
> reports, drift worklist and handback - is preserved at
> `docs/superpowers/reviews/2026-09-01-tour-reminder-supersession/`.

# Tour reminder supersession + Upcoming placement - implementation plan

Date: 2026-09-01
Branch: `feat/tour-reminder-supersession` (cut from `main` @f27aabbf)
Spec: `docs/superpowers/specs/2026-09-01-tour-reminder-supersession-design.md`
Design review: spec rounds 1-5, plan round 1 (two cold reviewers, 31 findings).
Adjudications: `docs/superpowers/reviews/2026-09-01-tour-reminder-supersession/adjudications.md`

Written for a builder with NO prior context. Every slice is TDD: write the
failing test, watch it fail for the RIGHT reason, implement, re-run.

## Slice order and why it is this order

Deletion is the dangerous half, so nothing deletes until everything that
REFUSES a superseded rung is in place. Three phases: make generations
identifiable (S1-S4), make them refused and visible (S5-S7), only then delete
(S8-S9). S10-S11 are the layout half and are independent.

| # | slice | deletes? |
| --- | --- | --- |
| S1 | repo foundations: fields, guards, sweep method, guarded patch, FAKE | no callers |
| S2 | arm stamps `ladderId`, returns it | no |
| S3 | tour pointer writes: create, re-arm, terminal rotation | no |
| S4 | seeds stamp ladders AND set pointers | no |
| S5 | refusal: poll + send-now + both `superseded` unions | no |
| S6 | the three preview surfaces agree | no |
| S7 | read grouping, `earlier[]`, panel disclosure, 404s | no |
| S8 | conversion: defer, then rotate + sweep after finalize | FIRST deletes |
| S9 | tours.ts swaps cancel -> sweep; old wrapper removed | yes |
| S10 | Upcoming block moves inside the scroll | n/a |
| S11 | re-point tests that encode the old contracts | n/a |

**The guarantee this order buys:** stopping between any two slices leaves a
system where every armed rung either sends correctly or is refused - never one
that deletes without refusing. Plan review round 1 found that guarantee FALSE at
S8 in the previous draft; T8.3 is what restores it.

---

## S1 - Repo foundations

No caller changes. Additive and inert until S2.

**T1.1 - `ladderId` on the reminder row.** Add `ladderId?: string` to
`TourReminderItem` (`app/src/repos/tourRemindersRepo.ts`) and accept it on
`create`. Optional: pre-migration rows never have one.

**T1.2 - `currentLadderId` on the tour.** Add `currentLadderId?: string` to
`TourItem` (`app/src/repos/toursRepo.ts`). Do NOT add a clear path: `patch` maps
an explicit `null` to REMOVE (`toursRepo.ts:333`), and the spec rotates this
field precisely so that ABSENT keeps meaning pre-migration.

**T1.3 - a value-guarded pointer write.** `patch` conditions only on
`attribute_exists(tourId)` (`toursRepo.ts:354`), so T3.3's compare-and-set has
no capability today. Add one - either an `expectedLadderId` option on `patch` or
a narrow `setLadderIdIf(tourId, expected, next)`. It must be a real DynamoDB
`ConditionExpression`, and it must be tested against DynamoDB Local, not only
against the in-memory fake.

This widens `ToursRepo`, and the harness fakes THAT repo too
(`twilioWebhookHarness.ts:2801`, explicitly annotated) - the same typecheck trap
as T1.6, one interface over. The fake's version needs REAL compare semantics
(reject when the stored value differs), or T3.3's test passes against a fake
that never says no.

**T1.4 - claim guards. RED FIRST; this test is why the slice exists.** Against
DynamoDB Local, at the repo layer:

```
create a row -> delete it (raw DeleteCommand) -> claimSend(reminderId, now)
expect: returns false, AND a raw GetCommand for that reminderId finds nothing
```

Assert absence with a **raw `GetCommand` through the test's doc client**. There
is no `getById` on this repo, and `listByTour` is a vacuous substitute here: the
row DynamoDB would resurrect is an attribute-only stub with no `tourId`, so it
cannot appear in a `byTour` query whether the bug is present or not.

On `main` this FAILS: `claimSend` is an `UpdateCommand` whose conditions are all
`attribute_not_exists(...)`, all of which hold for a missing item, so DynamoDB
CREATES the stub and returns success. Watch it fail that way first.

Then add `attribute_exists(reminderId)` to `claimSend`, `claimSkip` and
`cancel`. Do NOT touch `uncancel` - it already requires
`attribute_exists(canceledAt)`. Exact form precedent:
`app/scripts/retire-paused-tour-reminders.ts:205-207`.

**T1.5 - `deleteSupersededForTour(tourId)`.** Same skeleton as `cancelForTour`
(`listByTour`, `Promise.allSettled`) but issuing `DeleteCommand` with
`ConditionExpression: 'attribute_not_exists(sentAt)'`.

**Do NOT copy `cancelForTour`'s `pending` filter** (`tourRemindersRepo.ts:412-414`).
It excludes canceled and skipped rows - exactly the rows D1 deletes. The only
filter here is "no `sentAt`", and the condition on the delete is what makes the
race safe.

Tests: pending goes; operator-canceled goes; skipped goes; SENT stays; a row
that gains `sentAt` between the list and the delete stays (drive it by claiming
inside the test, not by mocking). A lost condition logs at debug and does not
reject the batch; a NON-`ConditionalCheckFailedException` error logs at error
and does not silently vanish.

**T1.6 - the in-memory fake MUST change.** Three things, and the previous draft
of this plan wrongly told the builder to leave it alone:

1. `TourRemindersRepo` gains `deleteSupersededForTour` and (at S9) loses
   `cancelForTour`. The fake implements the interface, so S1's own typecheck
   gate is unsatisfiable until it does too.
2. The fake's `create` is hand-built field by field
   (`app/test/helpers/twilioWebhookHarness.ts:2933-2952`) and will silently DROP
   `ladderId`. Read the comment at `:2939-2946` before you touch it: this file
   already carries the scar of dropping `input.skipped`, which made every
   arm-time skip look like a live rung to route-level suites.
3. `claimSend`/`claimSkip`/`cancel` in the fake already return `false` on a
   missing row (`:2971-2974`), which IS the correct post-guard behavior. Leave
   that alone. It is also why T1.4 cannot live here.

Gate: `npm run typecheck` + the repo suites.

---

## S2 - The armer stamps and returns a ladder id

**T2.1 - RED.** All rows from one `armTourReminders` call share a `ladderId`;
two calls differ. Assert on the returned rows, never on a clock - the suite
injects a constant `now`.

**T2.2.** In `app/src/jobs/tourReminders.ts`, mint `randomUUID()` once per call
and pass it to every `create`, born-skipped rows included.

**T2.3 - return `{ ladderId, rows }`**, with `ladderId: null` when the arm wrote
no rows. Update every call site. `ArmTourRemindersDeps` gains NOTHING (spec
D3a): the armer does not write the tour row.

Gate: `npm run typecheck` is the real gate - vitest strips types and will not
prove the new shape threaded.

---

## S3 - The tour pointer

**T3.1 - CREATE path** (`POST /api/tours` with `scheduledAt`). Write the
returned `ladderId` after the arm. RED: the 201 body carries `currentLadderId`
matching the armed rows. Fails today because the response is built from the
tour captured before the arm.

**T3.2 - re-arm path** (`tours.ts`, `armable && rearmTrigger`). Rotate the
pointer to a fresh UUID inside the patch ALREADY written at `tours.ts:1164` -
one write. Then arm, then T3.3.

**The existing `cancelTourReminders` call stays exactly where it is until S9.**
Do not delete it here (the ladder would stop being retired at all) and do not
swap it for the sweep here (deletion would start before refusal exists). Either
misreading breaks the slice-order guarantee.

**T3.3 - the final pointer write is a COMPARE-AND-SET** on the rotation value
from T3.2, using T1.3's guarded method. RED: two interleaved reschedules leave
the tour pointing at a ladder whose rows exist, and the loser logs at error.
Without it both return 200 and the tour is silently disarmed. **Test the real
`ConditionExpression` against DynamoDB Local**, not only the fake - a
fake-passing conditional write is the exact gap T1.4 exists to warn about.

**T3.4 - terminal transitions** rotate to a fresh unmatched UUID. No clear, no
sweep yet. RED: after a terminal patch no row's `ladderId` matches the pointer
AND the attribute is still PRESENT. The presence assertion is the load-bearing
one.

**T3.5 - both write paths must return the pointer they wrote** - the PATCH
response (`tours.ts:1164` captured, `:1285` returned) and the CREATE 201.

**T3.6 - interruption logging** (spec 3.2, R4). An arm or pointer-write failure
after the rotation leaves a live `scheduled` tour whose pointer matches nothing:
disarmed. Log at error with the tourId. A CREATE-path pointer-write failure
leaves stamped rows with NO pointer, which is NOT covered by T5.3's
pre-migration exemption - it is refused, so it is safe, but it must be loud.

---

## S4 - Seeds

Must land BEFORE refusal (S5) or every seeded world goes dark.

**T4.1 - `lib/seed/live.ts`** arms through the REAL armer (`:514`, `:528`,
`:538`) and writes tour rows directly. Note `seedAll` PERSISTS the tours before
`seedLive` arms, so "inline" is not available as written: either patch the
pointer after the arm, or reorder to arm before the tour write. Pick one and say
which. RED: after a live seed, every armed rung matches its
tour's pointer.

**T4.2 - `lib/seed/matrix.ts`** builds RAW rows including a same-tour SENT
`confirmation` plus PENDING `day_before`. Stamp ONE `ladderId` across both and
set the pointer. Assert both land in the CURRENT ladder - a partial stamp splits
that pair across the disclosure.

**T4.3 - `lib/seed/cast.ts:780-808`** is a third raw ladder writer and feeds the
byte-stable e2e world. Same treatment.

**T4.4 - stamping without pointing is worse than neither.** For every builder
touched above, and any other reminder-row writer under `app/src/lib/seed/` or
`app/src/lib/performanceSeed.ts` (`:167` constructs the repo - follow it),
verify BOTH halves: rows stamped, and the tour pointed at that stamp.

**T4.5 - a seeded TERMINAL tour** would otherwise carry a pointer-matching
ladder, a state production can no longer produce. Either rotate its pointer in
the seed or leave a comment saying why the demo world keeps it.

---

## S5 - Refusal

**T5.1 - `superseded` spans TWO unions.** `ReminderSkipReason`
(`tourRemindersRepo.ts`) for what the poll stamps, AND `ScheduledSuppressionReason`
(`app/src/services/scheduledSendSuppression.ts:9-11`) for what the preview
surfaces render. The previous draft widened only the first, which left S6 and
acceptance 4 unbuildable.

Follow the `discontinued` precedent documented at the head of that file: the
token lives in the suppression union but is NOT produced by the evaluator -
callers that know the rung is superseded short-circuit ahead of it. A pointer
mismatch is caller knowledge, exactly like a retired kind.

**T5.2 - the copy census, forced and unforced.** Enumerate and update, and do
not trust the previous draft's count - reviewers corrected it twice. Exhaustive
maps that FAIL the build when a token is missing, and the two hand-mirrored
dashboard unions that do NOT (an app-side-only addition compiles green and
renders the raw snake_case token to staff), plus `SEND_NOW_ERROR_COPY`, a
`Record<string, string>` read through `??` (`dashboard/src/api/types.ts:1327`,
`:1379`) whose missing entry silently renders the generic retry sentence.

Method, since the census keeps being wrong: probe with an EXISTING token and add
`superseded` everywhere it appears. Two probes are needed, not one -
`discontinued` reaches only the SUPPRESSION surfaces, while the skip-reason and
409 surfaces need a second (`tour_already_passed` appears across all of them).
Write an explicit assertion for each surface the typechecker does not force. Include the
`types.test.ts` hand-lists. Green is not evidence here.

**T5.3 - the poll refuses.** In `runDueTourReminders`, a rung whose `ladderId`
does not match its tour's `currentLadderId` is claim-skipped `superseded`. A
rung with NO `ladderId` on a tour with NO pointer attribute is EXEMPT
(pre-migration) and behaves as today. Test both.

**Placement matters.** `processReminderRow`'s own comment reads "POSITION IS
BEHAVIOUR here" (`tourReminders.ts:1034`). Decide deliberately where the check
goes relative to the existing resolve/suppress ladder, and say why in a comment.

**T5.4 - the poll DEFERS for a conversion in flight.** The predicate is
`convertedPlacementId` starting with the literal prefix `pending:` - the
sentinel format is `pending:${randomUUID()}` (`placements.ts:699`). A bare
"is a string" predicate would defer every FINALIZED converted tour forever,
because finalize replaces the sentinel with a real placement id.

Deferred means: left unclaimed, NOTHING stamped, retried next tick. It must not
be a claim-skip - `skippedAt` is terminal (`tourRemindersRepo.ts:361`), so a
skip inside the window could never be undone when the claim is released.

**Position: ABOVE the batch-supersession block** (`tourReminders.ts:1086-1099`).
Below it, a claim-window rung picks up a terminal `quiet_hours_superseded` stamp
on its way past, which reintroduces the same irreversibility through a different
token - the deferral would be undone by nothing.

**Bound it, and NAME the token.** A crashed conversion leaves the sentinel with
no TTL and no recovery route, so an unbounded deferral is a silent forever-loop.
Follow this job's own bounded-wait pattern (`tourReminders.ts:1193-1206`): past
the grace window, retire the rung visibly rather than deferring again, and log.

That retire needs its OWN skip reason - every existing token is false for a
stuck conversion claim, and `superseded` is wrong because the cause and the
operator's remedy are both different (the conversion is stuck, not the ladder
replaced). Adding it re-runs the whole T5.2 census: two unions, every exhaustive
map, both hand-mirrored dashboard unions, and a `SEND_NOW_ERROR_COPY` entry.
Budget for that here rather than discovering it in S6.

**T5.5 - Send now refuses.** `forceSendReminder` is a SEPARATE entry point and
inherits nothing from T5.3. A pointer-mismatched rung gets 409 with its own
error code, and that code gets a `SEND_NOW_ERROR_COPY` entry (T5.2).

---

## S6 - The preview surfaces agree

Because `listDue` only picks a row up at `dueAt <= now`, a mismatched rung would
keep promising to send until it came due - not until the next tick.

**T6.1** `routes/tourReminders.ts` (panel GET).
**T6.2** `routes/contactTimeline.ts:981` (contact Upcoming).
**T6.3** `routes/relayGroups.ts:226` (group Upcoming).

Each renders a pointer-mismatched pending rung as suppressed `superseded`, never
as upcoming. **Each carries T5.3's pre-migration exemption**: a legacy rung on a
pointerless tour is NOT suppressed. Without that clause a literal build marks
every legacy pending rung suppressed on all three surfaces and breaks acceptance
12. One RED test per surface, all three on the same fixture, plus one legacy
fixture per surface.

---

## S7 - Read grouping and the panel

**T7.1 - `earlier[]` on the GET.** CURRENT = `ladderId` matches the pointer, or
(tour has no pointer ATTRIBUTE and row has no `ladderId`). EARLIER = the rest.
`next` from `reminders[]` alone.

**T7.2 - ordering:** `sentAt ?? dueAt` DESC, tie-break `reminderId`. Not
`ladderId` (a UUID), not `createdAt` (ties within one arm).

**T7.3 - the disclosure renders OUTSIDE the empty short-circuit.**
`RemindersPanel.tsx:346` returns "No reminders armed." on an empty
`reminders[]`, and a terminal tour is exactly that state with a non-empty
`earlier[]`. RED: zero current rungs, two sent earlier ones, disclosure renders.
Assert on the RENDER, not a derived flag.

**T7.4 - default COLLAPSED.** D2 is "out of the default view"; an expanded
default satisfies every other test here and violates the decision.

**T7.5 - the action allowlist, by state.** sent -> none; `upcoming` (a sweep
miss) -> Cancel ONLY; canceled -> none; skipped -> none. Do not reuse the
current-ladder action list: it keys off `state` and would put Send now on an
unsent earlier rung (`RemindersPanel.tsx:397`) and Restore on a canceled one
(`:408`).

**T7.6 - `earlier[]` views carry `suppression`.** After T7.1's partition no row
in `reminders[]` can carry the `superseded` annotation, so without this the
annotation has nowhere to render. Acceptance 4 forces the answer: the earlier
view shape includes `suppression`, and the disclosure renders its chip.

**T7.7 - no body without `sentBody`.** An earlier rung lacking the snapshot
renders NO body rather than composing live against the tour's current time.

**T7.8 - the two non-null assertions.** `routes/tourReminders.ts:395` and `:462`
do `.find(...)!` on a post-write re-read: return an honest 404, and keep
emitting `scheduled.updated` (`:416`) when the write itself won.

---

## S8 - Conversion (first slice that deletes)

**T8.1.** Move the retirement from between `claimConversion` and `create` to
AFTER the finalize succeeds, and use `deleteSupersededForTour`.

**T8.2 - RED, both failure paths.** A conversion whose `create` throws, and one
whose FINALIZE throws (`placements.ts:757-773` releases the claim, leaves the
tour `scheduled`, retryable by design): in both, the tour keeps every rung, its
pointer, and has NO rung stamped `superseded`. Sweeping before the finalize
passes the first and fails the second - that is the point of the task.

**T8.3 - ROTATE the pointer INSIDE the finalize patch.** Without a rotation the
converted tour has no refusal backstop at all: T5.4's deferral ends when the
sentinel is replaced, the pointer still matches, and the poll has no tour-status
check - so a rung the sweep MISSED (or a sweep that failed outright) sends on a
converted tour, permanently. This is the task that makes the slice-order
guarantee true at S8; an earlier draft's guarantee was false here.

Write it as part of the finalize patch at `placements.ts:758` - the same
one-write idiom the re-arm path uses - NOT as a separate write afterwards. A
separate write reopens a slice of the same gap between finalize and rotation,
and adds a rotation-failure branch nothing covers. Folding it in also settles
the order question: the pointer is rotated by the finalize, and the sweep
follows it.

**T8.4 - sweep-failure posture.** The sweep is best-effort at this point - the
conversion is already real and must not be rolled back for it. Log at error;
the rotated pointer from T8.3 is what keeps a missed row harmless.

**T8.5 - accepted, state it in a comment:** conversion emits no
`scheduled.updated` (this route emits only placement and tour events), so after
the sweep the two Upcoming buckets stay stale until their next refetch. That is
parity with today's cancel-based behavior, not a regression this slice
introduces - but post-S8 the stale rows are DELETED rather than merely canceled,
so say so where the next reader will look.

---

## S9 - The tours.ts sweep, and removing the old path

**T9.1.** Replace `cancelTourReminders` with `deleteSupersededForTour` at both
`tours.ts` sites. Order per spec 3.2: rotate (S3), sweep, arm, compare-and-set.

**T9.2.** Delete `cancelTourReminders` (`jobs/tourReminders.ts`) and
`cancelForTour` (`tourRemindersRepo.ts`) once no caller remains - and from the
fake (T1.6). Grep before deleting; three call sites were known and a fourth
would be worth stopping for.

**T9.3 - the acceptance test for P1.** Reschedule twice; assert the current
ladder holds exactly one generation AND the superseded unsent rows are absent
from the TABLE - query the repo, do not read the API response.

---

## S10 - The Upcoming block moves inside the scroll

Independent of S1-S9; can go first if the phone fix is wanted early.

**T10.1 - markup.** Move `<section class=upcoming>` from a sibling of
`.streamWrap` to the LAST CHILD of `.stream`. Keep heading, list, `aria-label`.

**T10.2 - CSS.** Drop the block's `max-height`, `overflow-y` and `flex` rules
and its phone override - there are TWO `767.98px` media blocks in the file, so
identify the right one by the selector it contains, not by ordinal. Check what
`.stream`'s padding and gap now inherit onto the moved block. Leave
`overflow-anchor: none` and `.streamWrap` alone.

**T10.3 - the anchor as a PURE FUNCTION first.** jsdom performs no layout, so
this is the only part unit tests can prove:

| anchor | when |
| --- | --- |
| `sentinel` | sentinel bottom at or below the viewport bottom, within 48px |
| `below` | sentinel bottom ABOVE the viewport bottom by any amount |
| `null` | sentinel bottom below the viewport bottom by more than 48px |

`below` is defined by DIRECTION, not slack, so it stays reachable when the block
is shorter than 48px. Unit-test all three bands including the small-block case.

**T10.4 - the sentinel element**, after the last cluster. The Upcoming section
is CONDITIONALLY rendered (`Timeline.tsx:2102`) and never exists in
`GroupTextView`, so define the anchor for the NO-BLOCK case explicitly: with no
block, `below` is unreachable and behavior must be identical to `main`.

**T10.5 - convert ALL SIX scroll writers.** Converting only the growth pin is
the likeliest way to get this wrong, and the previous draft missed one and
mis-cited another:

| site | disposition |
| --- | --- |
| growth pin `:1912` | anchor-driven per T10.3 |
| conversation-switch reset `:1890` | target the SENTINEL, not `scrollHeight` |
| `scrollToBottom` `:1840-1846` (the PILL's onClick) | target the sentinel; it also writes the replaced `atBottomRef` |
| post-send pin (`atBottomRef` write near `:1976`) | re-derive; verify the line, it drifted |
| pill-clear `:1853` | clears on `sentinel` or `below`, not true bottom |
| prepend restore `:1900` | unchanged - anchored to prepended height |

Miss `:1890` and every thread OPENS on the block. Miss `:1840` and the pill
scrolls the operator to the block instead of the newest message.

**T10.6 - the re-pin signal.** `ResizeObserver` on the block, wired INTO the
existing layout effect's decision path - not a standalone effect, which would
bypass the prepend-anchor re-baseline and the pill logic that effect owns. Do
NOT put the `upcoming` array in the deps (`GroupTextView.tsx:451` passes a fresh
`[]` every render); an ids/length key is also wrong, since a body wrapping to a
second line moves the anchor with no key change. Leave `clusters`' key alone.

**T10.7 - e2e, because unit tests cannot see layout.** Use the harness's
existing `NARROW_360` viewport (`e2e/support/viewport.ts:23`) - do not introduce
a second narrow definition. Assert observables: scrolling down reveals the
block; scrolling up hides it; an operator on the block is not scrolled away and
gets no pill when a message arrives; opening a thread lands on the newest
message. For "more messages than `main`", assert the mechanism instead - the
block is NOT within the viewport at rest - since a cross-branch count has no
in-run pass/fail.

**T10.8 - acceptance 16's relay-group case.** The pill regression must be
asserted in a relay-group thread through `ConversationDetail`; `GroupTextView`
passes `upcoming={[]}` and cannot exercise it. No task delivered this before.

**T10.9 - live phone QA (spec R6).** e2e is not the same as driving it by hand.
Drive the three-anchor behavior on a real phone viewport in the interactive lane
before handback.

---

## S11 - Re-point the tests that encode old contracts

These fail because the contract changed. Re-point; do not delete.

- `e2e/tests/scenarios/scheduled-visibility.spec.ts:268` - the only end-to-end
  proof a reschedule retires the previous ladder; asserts canceled rows stay
  VISIBLE, must now assert they are gone.
- `e2e/scenarios/steps.ts:3615-3661` - rung disambiguation resting on superseded
  rows staying visible.
- `dashboard/src/routes/contact/Timeline.test.tsx:1375-1481` - five tests
  encoding the OLD pin contract.
- `app/test/tourReminders.test.ts`, `app/test/toursApi.test.ts:1229-1246`,
  `app/test/placementConvert.test.ts:78-79` - all encode cancel-on-reschedule or
  cancel-on-convert.
- Four e2e sites resolve the Upcoming region by role and name - confirm they
  still resolve after the move.

This list is OPEN, not closed: grep for `cancelForTour`, `cancelTourReminders`
and `canceledAt` across `app/test/` and `e2e/` before declaring it complete.

---

## Gates

From the worktree, bare, in order, per `AGENTS.md`:

1. `npm run typecheck`
2. `npm test`
3. `npm run smoke`
4. `npm run e2e`
5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`

Attribute gate-5 errors by BASELINE COMPARISON at the merge base, never by line
number.

## Watch items

- **Vitest strips types.** A green suite does not prove S2's return shape
  threaded, nor the two hand-mirrored dashboard unions in T5.2. Only
  `npm run typecheck` does, and for the mirrors not even that.
- **Two conditional writes must be proven against DynamoDB Local**, not the
  fake: T1.4's claim guard and T3.3's compare-and-set.
- **The fake is not a no-op this time** (T1.6) - but its claim-on-missing-row
  behavior is already correct and must not be "fixed".
- **Do not commit while `npm run e2e` is running.**
- `npm test` needs DynamoDB Local (`npm run db:start`). Red on DynamoDB suites
  with timeouts and no assertion failures: re-run under a clean access key
  before blaming the branch.
