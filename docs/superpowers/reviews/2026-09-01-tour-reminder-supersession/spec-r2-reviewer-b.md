# Spec R2 - adversarial doc review (reviewer B)

Spec under review: `docs/superpowers/specs/2026-09-01-tour-reminder-supersession-design.md` (revised)
Adjudications: `.../adjudications.md`
Reviewer A round 1: `.../spec-r1-reviewer-a.md`
Repo: `W:/tmp/tour-reminder-supersession` (read only)
Date: 2026-09-01

Read cold. Findings 1-8 are NEW - none of them appear in either round-1 report or
in the adjudications. Findings 9-13 are smaller defects introduced or left by the
revision. Findings 4 and 6 also contest adjudications; A15 is conceded at the end.

My round-1 findings are closed in the revision as follows and are not re-argued:
B1 (third caller) -> 3.2 item 3; B2 (resurrection) -> 3.2 claim guards; B3
(`armedFor`) -> D3 `armedAt`; B4 -> 3.4; B5 -> 3.3 slot; B6 -> 3.5 anchoring
facts; B7 -> acceptance 10; B8 -> 3.2 ordering paragraph; B10 -> R7; B11 ->
section 4 tests; B12/B14/B15 -> section 4 / acceptance 4. B9 and B5 are revisited
below for reasons the revision created.

---

## 1. [BLOCKING] `armedAt` collides on the app suite's injected clock - the redesigned generation key cannot distinguish generations in the one place the build will test it

**What is wrong.** 3.1 asserts a guarantee: "Two arm calls can never share an
`armedAt` for the same tour: the sweep in 3.2 runs between them, and the route
awaits each in turn."

Neither clause establishes it. `await` orders the calls; it does not advance a
clock. The sweep does not touch the clock at all. `armedAt` is distinct only if
the value `armTourReminders` is *called with* differs between the two calls - and
in the app suite it deliberately does not.

**Evidence.** The arm instant is an injected dependency, not a read of the wall
clock:

- `app/src/routes/tours.ts:251` - `const getNow = deps.now ?? (() => new Date().toISOString());`
- `app/src/routes/tours.ts:350` and `:1191` - `await armTourReminders(tour, getNow(), {...})`

Every tours API test injects it as a **constant**:
`app/test/toursApi.test.ts:1228` defines `const ARM_NOW = '2026-07-13T14:00:00.000Z';`
and every case in that describe block builds the harness with
`makeWebhookHarness({ toursNow: () => ARM_NOW })` (`:1255`, `:1269`, `:1280`,
`:1295`, `:1319`). Two arms in one test therefore receive byte-identical `now`,
so under D3 they receive byte-identical `armedAt`, so `maxArmedAt` matches BOTH
generations and every row of both is CURRENT.

The seed path has the same shape - `app/src/lib/seed/live.ts:514`, `:528`, `:538`
pass one captured `nowIso` to three `armTourReminders` calls (different tours
there, so harmless today, but it is the same pattern).

The test at `app/test/toursApi.test.ts:1294-1304` ("status-only revival
{status:'scheduled'} on a canceled tour re-arms off the stored time") is exactly
the shape reviewers A and B blocked on in round 1, and it runs on a frozen clock.

**What it implies.**

- **Acceptance 1 cannot be proven where it matters.** "After two reschedules the
  panel's current ladder holds exactly one generation" written against the
  standard harness either fails (whenever generation 1 left a `sentAt` row) or
  passes *vacuously* (when it did not, because the sweep deleted everything and
  there was never a second generation to partition). Neither outcome tests D3.
  This is the round-1 A2/B13 lesson repeating one layer up: the test double's
  semantics silently invert the thing being proven.
- The revision replaced a key that collides on a *supported user flow* with a key
  that collides on a *supported test configuration*. That is a smaller blast
  radius, not a closed hole, and 3.1 currently tells the builder the hole does
  not exist.
- In production the collision needs two arms for one tour inside the same
  millisecond, i.e. concurrent PATCHes on one tour. I did not observe this and
  mark it UNVERIFIED as a live occurrence - but `Date.now()` is millisecond
  resolution and nothing serialises PATCHes per tour, so "can never" is not a
  property the code has.

The spec must either (a) make `armedAt` collision-proof by construction (append a
per-call uuid, or derive the generation from the first row's `reminderId`), or
(b) state that generation identity depends on a monotonic injected clock and
require the test harness to advance it - and then say so where a builder writing
acceptance 1 will read it.

---

## 2. [HIGH] `maxArmedAt` is computed over SURVIVORS, so it is not monotonic - deleting the newest generation promotes an older one back into the current ladder

**What is wrong.** 3.3 defines the partition dynamically: "Let `maxArmedAt` be the
greatest `armedAt` among the tour's rows." Nothing anchors it to the tour. The
sweep deletes rows. So the maximum can go DOWN, and rows move backwards from
`earlier[]` into `reminders[]`.

**Evidence + reachable sequence** (every step a shipped path):

1. Tour armed, generation 1, `armedAt = A1`. Its `day_before` sends -
   `claimSend` stamps `sentAt` (`app/src/repos/tourRemindersRepo.ts:271-307`).
2. Operator reschedules. Sweep deletes generation 1's unsent rows; the sent
   `day_before` survives (D1: only `sentAt` rows survive). Generation 2 arms with
   `armedAt = A2 > A1`.
   Panel now: `reminders[] = ` generation 2, `earlier[] = ` the sent `day_before`.
   This is exactly acceptance 5.
3. Operator cancels the tour. The terminal path
   (`app/src/routes/tours.ts:1197-1210`) sweeps and does NOT arm. Every
   generation-2 row is unsent, so all of them are deleted.
4. The only surviving row is generation 1's sent `day_before`. `maxArmedAt` is
   now `A1`. That row is CURRENT again.

The rung the feature just moved behind "Earlier schedules (1 sent)" is back in
the default ladder, and the disclosure is gone.

**What it implies.** Acceptance 5 ("shows that rung **only** behind the
disclosure") is false for that tour from step 3 onward, and the same oscillation
happens on the conversion path (3.2 item 3), which also sweeps without arming.
The spec presents `armedAt` as a stamp that fixes a row's generation; the READ
rule makes a row's classification depend on which *other* rows still exist. Those
are different mechanisms and the spec conflates them.

The fix is cheap and belongs in 3.3: anchor the current generation to the tour
(store the arm stamp on the tour row at arm time and compare against it), or
state explicitly that a tour with no surviving current-generation row shows its
newest surviving generation as current - and re-word acceptance 5 accordingly.

---

## 3. [HIGH] 3.3's "By construction it can hold only `sentAt` rows" is false, and the read-only disclosure is built on it - a surviving superseded rung becomes invisible, uncancelable, and still fires

**What is wrong.** 3.3 states an invariant and then spends it: `earlier[]` "By
construction it can hold only `sentAt` rows", therefore the disclosure is
"read-only: no Cancel, no Restore, no Send now, all of which the server already
refuses on a sent row."

The invariant holds only if the sweep is exhaustive. It is not, by three
independent mechanisms already in the code.

**Evidence.**

1. **The sweep swallows unexpected errors.** `cancelForTour`'s
   `Promise.allSettled` loop logs a non-conditional rejection at `error` and
   continues - `app/src/repos/tourRemindersRepo.ts:440-448`. 3.2 explicitly
   adopts "the posture `cancelForTour` already takes with `Promise.allSettled`".
   A throttled or transient delete failure leaves an unsent row alive, with no
   retry anywhere.
2. **The sweep's list is an eventually-consistent GSI query.**
   `listByTour` queries `IndexName: 'byTour'`
   (`app/src/repos/tourRemindersRepo.ts:222-228`). A row the index has not caught
   up on is never handed to the delete loop. R4 records this consequence for the
   READ only.
3. **Unpaginated list** (R5) truncates the same way.

Any survivor carries generation 1's `armedAt`, which is less than `maxArmedAt`,
so 3.3 classifies it EARLIER. Two outcomes, both bad, depending on how literally
the builder reads the invariant:

- Builder filters `earlier[]` to `sentAt` rows (which 3.3 says is what it is):
  the row is in **neither** array. It disappears from the Reminders panel
  completely.
- Builder does not filter: the row renders inside a disclosure labelled
  "Earlier schedules (N sent)" - wrong count, wrong word - with **Cancel
  removed**, because 3.3 says those rungs are sent.

Either way the row is still returned by `listDue`
(`app/src/repos/tourRemindersRepo.ts:233-268` filters only on the three terminal
stamps, never on generation) and the poll sends it. The tenant gets the
superseded ladder's text.

**What it implies.** Today the identical sweep miss is survivable: the row stays
visible in the panel as `upcoming` with a working Cancel button
(`dashboard/src/routes/tours/RemindersPanel.tsx:413-416`), so an operator who
notices can stop it. The revision removes that remedy on the basis of an
invariant the mechanism does not deliver. 3.3 must define `earlier[]` by
generation ("rows whose `armedAt` is below `maxArmedAt`, whatever their state"),
keep Cancel on an unsent earlier row, and label the disclosure by row count
rather than by "sent".

---

## 4. [HIGH] CONTESTING B9's accept-as-risk: the adjudication reasons only about the READ, and D1 removed the operator's remedy on the WRITE

I raised GSI staleness in round 1 as a UI flash. The adjudication accepted it as
risk on that framing - "a deleted row can still come back on the immediate
re-read... the panel already refetches on `scheduled.updated` and on its own
dueAt anchor" (adjudications :106-110), and R4 repeats it as "no design change,
but a live-QA watch item."

I do not concede, because the revision changed the consequence.

**What the adjudication does not address.** The panel refetching converges the
READ side; nothing converges the SWEEP side. `deleteSupersededForTour` is
`listByTour` (GSI) followed by deletes. A row missing from that GSI page is never
deleted, and D1 removed the only other retirement mechanism - there is no
`canceledAt` stamp any more, and the terminal/conversion paths do not run twice.
The row survives until the tour is rescheduled again, which for a canceled or
converted tour is never.

That is not a "stale read that converges." It is a permanent unretired rung, and
finding 3 above is what happens to it: hidden or mislabelled, Cancel removed,
still in `listDue`, still sends.

**What I am asking for.** Not a redesign of the sweep - GSI reads cannot be made
strongly consistent, and a table Scan is not proportionate. The cheap correction
is in 3.3 (finding 3): stop asserting `earlier[]` is sent-only, and keep the
Cancel affordance on an unsent earlier row. That converts an unfixable
consistency property into a survivable UI state, which is what the old
`canceledAt` stamp bought us for free. R4 should also name the sweep-side miss,
not only the read-side flash.

---

## 5. [HIGH] The adjudication tells the builder to "correct" the in-memory fake in the direction that re-injects the bug 3.2 fixes

**What is wrong.** Adjudication A2/B13 (`adjudications.md:49-54`): "the fake
returns `false` on a missing row, the opposite of the real upsert... Spec now
requires the race proven at the REPO layer against DynamoDB Local, **and the fake
corrected to mirror the real conditional**." Acceptance 2 repeats the premise:
"because the in-memory fake returns `false` on a missing row and cannot express
this."

Both sentences were true of the repo *before* 3.2's guard. After it, they are
inverted.

**Evidence.** The fake:

`app/test/helpers/twilioWebhookHarness.ts:2971-2974`
```
async claimSend(reminderId, claimedAt, sentBody) {
  const r = tourRemindersMap.get(reminderId);
  if (!r || r.sentAt !== undefined || r.canceledAt !== undefined || r.skippedAt !== undefined) {
    return false;
  }
```
`claimSkip` (`:2983-2986`) and `cancel` (`:2992-2995`) have the identical `!r ->
false` shape.

3.2 adds `attribute_exists(reminderId)` to all three real methods, whose whole
point is to make the real repo return `false` on a missing row. **The fake is
already the post-fix behavior.** The correct instruction is "leave the fake's
missing-row branch alone; it is now correct", not "correct it to mirror the real
conditional."

**What it implies.** A builder following the adjudication makes the fake resurrect
rows on `claimSend`. That models a defect production no longer has, and it will
break unrelated app suites that reasonably assume a claim against a deleted row
is a no-op. The spec's own acceptance 3 ("a rung deleted by the sweep and then
reached by the poll's `claimSend` does NOT resurrect and does NOT send") would
then be *disproven* by the fake while production is correct - the exact
false-signal failure mode A2 was raised to prevent, pointing the other way.

Acceptance 2's parenthetical should be re-grounded: the reason that case needs
DynamoDB Local is that the fake has **no conditional delete** and cannot express
the delete-loses-to-claim interleaving at all - not that it mishandles a missing
row.

---

## 6. [HIGH] CONTESTING A9's resolution: 3.5 keeps the cap but never decides the PIN TARGET, so acceptance 8's first clause is unsupported in the default state

A9 was resolved by decision - the block keeps its height cap inside the scroller
(adjudications :84-89). The cap answers "an uncapped block fills the phone." It
does not answer the question that actually decides whether P2 is fixed: **where
does `scrollTop = scrollHeight` land now?**

**Evidence.** With the block as the last child of `.stream`, "the bottom of the
scroller" is the bottom of the block. Four code paths drive there:

- `dashboard/src/routes/contact/Timeline.tsx:1830` - `atBottomRef = useRef(true)`,
  commented "default true -> open on the newest item".
- `:1890` - conversation switch / mount: `el.scrollTop = el.scrollHeight`.
- `:1912` - every at-bottom update.
- `:1843` (`scrollToBottom`, wired to the pill at `:2094`) and `:1976` (after the
  operator sends).

So the DEFAULT state of every conversation - opened, or sitting at the bottom
reading new messages - puts the capped block in the bottom 7rem of the pane,
which is precisely where `main` puts it
(`Timeline.module.css:661-667`, `max-height: 7rem` under 767.98px). The message
area visible on open is unchanged.

3.5's own promise - "visible when you scroll to the bottom, entirely gone when you
scroll up, never occupying the pane while you read" - inverts the actual usage.
The operator scrolls UP to read history (block correctly gone) and sits at the
BOTTOM to read new messages (block still there, same 7rem). P2 reported the block
eating the phone; the phone it eats is the one showing the newest messages.

Acceptance 8's first clause - "On a 390px viewport the conversation stream shows
more messages than it does on `main`" - is therefore not delivered by the
mechanism as specified.

3.5 half-notices this. Its second anchoring bullet says `atBottom`'s measurement
"must keep meaning 'the operator is at the newest content' once the block is
inside the scroller." That is a constraint, correctly identified, and then left
undecided - and it is the same shape of gap A9 was raised about. The two options
are not interchangeable and the spec must pick one:

- **Pin above the block.** `scrollToBottom` and the two auto-pins target the last
  message, `isAtBottom` measures against that offset, and acceptance 8's second
  clause ("scrolling to the bottom reveals the Upcoming block") becomes a
  deliberate extra scroll - so that clause needs rewording too.
- **Pin to the true bottom.** Then acceptance 8's first clause must be deleted,
  because the phone gains nothing in the state it is normally in.

Without the decision, a builder will do the zero-effort thing (leave the pins
alone), ship, and acceptance 8 will be argued about in live QA - which R6 already
predicts and does not prevent.

---

## 7. [MEDIUM] 3.5 re-introduces the nested scroller the first draft rejected by name, and nobody adjudicated the reversal

**What is wrong.** Draft 1's 3.5: "Its own `max-height` / `overflow-y` / `flex`
rules go away: it scrolls with the stream now, and **a private scrollbar inside a
scrollbar is exactly what P2 complains about**."

Revised 3.5: "It KEEPS a height cap there (its current 12rem / 7rem-on-phone
ceiling **and its own `overflow-y`**)."

A9's adjudication (`adjudications.md:84-89`) discusses only the height cap. The
`overflow-y` half was reversed silently.

**Evidence.** `.upcoming` carries `max-height: 12rem; overflow-y: auto`
(`Timeline.module.css:652-653`) and `.stream` carries `overflow: auto`
(`:118`). Post-move that is an `overflow-y: auto` box nested directly inside an
`overflow: auto` box, both vertically scrollable, on a touch surface.

**What it implies.** Two consequences the spec does not state: touch scroll at the
bottom of the stream is captured by the inner 7rem box until it bottoms out and
scroll-chains, which is the interaction draft 1 called out; and a four-rung
ladder in a 7rem box still hides rungs behind a scrollbar whose position no
outer measurement can see. If keeping `overflow-y` is deliberate, 3.5 should say
why the round-1 objection no longer applies. If the intent was cap-without-inner-
scroll (clip, or let the block size to content under a cap), that is a different
CSS instruction and the spec should give it.

---

## 8. [MEDIUM] "`upcoming` must join them" is imprecise at a render site that passes a fresh array literal every render

**What is wrong.** 3.5's first anchoring bullet prescribes adding `upcoming` to
the layout effect's dep array (`Timeline.tsx:1920`). One of the five Timeline
call sites passes a new array identity on every render.

**Evidence.** `dashboard/src/routes/conversation/GroupTextView.tsx:451` -
`upcoming={[]}`. A literal, not a memo. The other four pass hook state, which is
stable between fetches (`ContactCommsPane.tsx:322` <- `useContactTimeline.ts:563`
`upcoming: state.upcoming`; `ConversationDetail.tsx:483`,
`PlacementConversation.tsx:323`, `TourConversation.tsx:470` all pass
`thread.upcoming`).

**What it implies.** On GroupTextView the pin `useLayoutEffect` would run on
**every render** - including every composer keystroke, since `draft` is state in
the same component (`Timeline.tsx` composer). Each run executes
`el.scrollTop = el.scrollHeight; setHasNewBelow(false)` while at bottom, and
re-baselines `prependAnchorRef` at `:1909`. I traced the branches and believe the
net behavior is benign rather than broken (GroupTextView renders no block at all,
so `scrollHeight` does not change) - marking the *severity* of the runtime effect
UNVERIFIED - but prescribing a raw prop as a layout-effect dependency without
naming the stability requirement is how a benign churn becomes a real one the
first time someone gives GroupTextView a real bucket. The spec should say
`upcoming` must be depended on by a stable value (its length, or a memoized
reference), and `GroupTextView.tsx:451` should be named.

---

## 9. [MEDIUM] Section 4's seed instruction is underspecified for the two builders that write raw rows, and a partial stamp splits a seeded ladder across the disclosure

**What is wrong.** Section 4: "Seeds that arm ladders must stamp `armedAt` or the
seeded world reads as pre-migration." Two seed builders do not *arm* anything -
they write reminder rows as raw objects - so the instruction does not obviously
apply to them, and 3.3's rule is all-or-nothing per tour.

**Evidence.** `app/src/lib/seed/matrix.ts` writes, for the SAME `tourId`, a sent
`confirmation` (`:990-998`) and then either a pending `day_before` (`:1005-1013`),
a canceled one (`:1024-1032`), or a sent one (`:1037-1045`).
`app/src/lib/seed/cast.ts:780-808` writes three sent rows for `TOUR_TOURED`.
`app/src/lib/seed/live.ts:514-538` is the only builder that goes through
`armTourReminders` and so gets `armedAt` for free.

3.4's rule is "A tour whose rows ALL lack it renders exactly as today." A builder
who stamps only the rows that look like an armed ladder - the pending
`day_before` - and leaves the historical `confirmation` unstamped makes
`maxArmedAt` the `day_before`'s stamp, which pushes the sent `confirmation` behind
the "Earlier schedules" disclosure on every matrix-seeded tour.

**What it implies.** The demo world's tour panels change appearance for a reason
nobody intended, and the lean world's byte stability is touched by a choice the
spec left open. Section 4 should rule explicitly: raw-row seed builders stamp
`armedAt` on **every** row of a tour or on **none** of them, and say which is
wanted for cast/matrix.

---

## 10. [LOW] Section 4's new claim that the retirement script "is subject to the same resurrection race" is factually wrong

**Evidence.** Section 4: "`app/scripts/retire-paused-tour-reminders.ts`, which
runs the same claim path and is subject to the same resurrection race."

It is not. That script is the one place in the repo that already carries the
guard - `app/scripts/retire-paused-tour-reminders.ts:205-207`:

```
ConditionExpression:
  'attribute_exists(reminderId) AND attribute_not_exists(#sentAt) AND ' +
  'attribute_not_exists(#canceledAt) AND attribute_not_exists(#skippedAt)',
```

It also does not use the repo - it issues its own `UpdateCommand` (`:200-216`), so
3.2's repo-level guard does not reach it either way.

**What it implies.** Harmless if the builder checks, misleading if they do not
(they may "fix" correct code, or take the script as the racing example and look
for a defect that is not there). The accurate sentence is the interesting one:
this script is the existing PRECEDENT for the guard 3.2 adds, which is worth
saying because it shows the pattern is established rather than invented.

---

## 11. [LOW] Section 4 still lists `cancelForTour` as a live writer at three call sites that 3.2 deletes

**Evidence.** 3.2: "`cancelForTour` is removed once all three move." Section 4,
Writers: "`cancelForTour` at the three call sites in 3.2".

Also inherited from draft 1: `cancelForTour` has never had *call sites in
`routes/tours.ts`*. It has exactly one caller anywhere -
`cancelTourReminders` at `app/src/jobs/tourReminders.ts:584` - and it is that
wrapper which has the three route sites. 3.2 item 3 now names
`routes/placements.ts:716` correctly, so this is a leftover label rather than a
missed surface.

**What it implies.** The Writers list is the enumeration a builder audits their
diff against; naming a function the same document deletes weakens it. It should
read `deleteSupersededForTour`, and the wrapper `cancelTourReminders` should be
named as the thing whose three call sites move.

---

## 12. [LOW] The layout move's own test surface is not enumerated

**What is wrong.** Section 4's "Tests encoding the OLD contract" names two files,
both about supersession. The D4 move touches assertion sites nobody listed.

**Evidence.** `dashboard/src/routes/contact/Timeline.test.tsx:1032`, `:1042`,
`:1057` and `dashboard/src/routes/conversation/ConversationDetail.test.tsx:291`,
`:322` all resolve the block by
`getByRole('region', { name: 'Upcoming scheduled messages' })`. The e2e sites are
`e2e/scenarios/steps.ts:3595` and `:3677`,
`e2e/tests/dashboard-next/tour-comms-pane.spec.ts:226`, and
`e2e/tests/dashboard-next/placements-page.spec.ts:205`. `steps.ts:3677` is
DOM-structural - `upcoming.locator('> div > div')` - which still matches, since
the move changes the block's parent and not its internals (`Timeline.tsx:2103-2110`).

I expect all of these to keep passing: the role and the accessible name are
preserved by 3.5, and Playwright's visibility test is a bounding-box test, so an
element scrolled outside an `overflow` clip still reads visible. **UNVERIFIED** -
I did not run anything, and that last point is the one that could bite: if
Playwright treats clipped-by-ancestor-overflow as not visible, every
`toBeVisible()` on the region becomes position-dependent.

**What it implies.** One line in section 4 telling the builder to check the
region assertions after the move, rather than discovering it during gate 4.

---

## 13. [LOW] Under D1 a WON cancel can 404 on its own echo, skipping the live-update emit

**Evidence.** The PATCH handler cancels, then re-reads
(`app/src/routes/tourReminders.ts:395`) and emits `scheduled.updated` at `:416`.
D1 makes the sweep delete operator-canceled rows too ("The sweep reaches pending,
operator-canceled AND skipped rows alike"), so a concurrent terminal transition
can delete the row between the winning `cancel` and the re-read. Section 4
correctly requires an honest 404 there - but returning at that point skips the
`:416` emit, so the other open surfaces (the contact and group Upcoming buckets,
other panels) do not refetch.

**What it implies.** A one-line rule in 3.3 or section 4: emit
`scheduled.updated` before the absence check, or on the 404 path too. Small, but
the emit is the mechanism the whole live-update story rests on and the 404 path
is new.

---

## Conceded

**A15 - `listByTour` is unpaginated - accepted-as-risk. Conceded.** The math in R5
is right: `app/src/repos/tourRemindersRepo.ts:221-231` issues one `QueryCommand`
with no `LastEvaluatedKey` loop (unlike `listDue` at `:233-268`, which paginates
and documents why), but at a few hundred bytes per row a 1MB page is roughly
three thousand rows, so hundreds of reschedules. Not worth designing around.

One correction to the risk's framing rather than its verdict: R5 says "both the
sweep and the read partition inherit that" as though the exposure were the same.
It is not. A truncated READ shows a short ladder and self-corrects on the next
fetch; a truncated SWEEP leaves rows permanently undeleted, which is finding 3's
input. And the sweep's first run on any given tour is the one facing the LARGEST
partition, because that partition is exactly P1's pile-up ("a tour rebooked three
times shows four ladders"). Same verdict, but R5 should name the sweep as the
side that does not self-correct.
