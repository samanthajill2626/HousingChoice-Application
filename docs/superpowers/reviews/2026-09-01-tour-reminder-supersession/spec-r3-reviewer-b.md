# Spec R3 - adversarial doc review (reviewer B)

Spec: `docs/superpowers/specs/2026-09-01-tour-reminder-supersession-design.md` (revision 3)
Adjudications: `.../adjudications.md` (rounds 1 + 2)
Repo: `W:/tmp/tour-reminder-supersession` (read only)
Date: 2026-09-01

Read as cold material, concentrating on the four redesigns. Findings 1-11 are
NEW. I do not re-argue closed findings.

Two things in the revision are right and worth recording so nobody weakens them:

- **The poll's pointer check costs no IO.** `processReminderRow` already reads
  the tour - `const tour = await deps.toursRepo.get(row.tourId);`
  (`app/src/jobs/tourReminders.ts:1049`), above the `tour_missing` claim-skip.
  The `currentLadderId` comparison rides that existing read.
- **`toursRepo.patch` is a merging `UpdateCommand`** with `SET`/`REMOVE` per
  supplied field and `ConditionExpression: 'attribute_exists(tourId)'`
  (`app/src/repos/toursRepo.ts:319-362`), and `null` maps to `REMOVE` (`:333`).
  So `currentLadderId` survives every other tour patch, and clearing it is
  `patch(tourId, { currentLadderId: null })`. The two-write scheme has no
  lost-update problem from the tour side.

---

## 1. [BLOCKING] "Send now" bypasses the pointer check entirely, and 3.3 just gave every unsent earlier rung a Send-now button

**What is wrong.** 3.2 scopes the new defense to one function: "`runDueTourReminders`
refuses to claim any rung whose `ladderId` does not match its tour's
`currentLadderId`." 3.3 then rules that "an earlier rung that is NOT sent renders
with its real state and keeps its Cancel action", and that only "sent rows are
read-only there."

Those two decisions collide. The panel decides its actions from `state`, not from
which array the row came in.

**Evidence.**

`dashboard/src/routes/tours/RemindersPanel.tsx:397`
```
{rung.state === 'upcoming' && rung.suppression?.reason !== 'discontinued' ? (
  ... aria-label={`Send the ${kindLabel} reminder now`} onClick={() => onSendNow(rung)}
```

An unsent superseded rung renders `state: 'upcoming'` (`stateOf`,
`app/src/routes/tourReminders.ts:166-171`), so under 3.3's "real state" rule the
disclosure shows a live **Send now** button on it.

The send-now path is a different function and has no pointer check anywhere on
it. `forceSendReminder` (`app/src/jobs/tourReminders.ts:1609`) checks the row
exists (`:1620`), checks terminal stamps (`:1621-1623`), checks
`DISCONTINUED_REMINDER_KINDS` (`:1632`), resolves the target, runs the pre-claim
gates, and claims at `:1752`. The route in front of it only 404s on a row that is
*absent* (`app/src/routes/tourReminders.ts:447-451`) - a sweep-missed row is
present, so it passes.

The same clause hands out **Restore** on an earlier *canceled* rung
(`RemindersPanel.tsx:408-417` renders Cancel/Restore for
`state === 'upcoming' || state === 'canceled'`), which `uncancel`s a superseded
row back to pending.

**What it implies.** The precise scenario R2-3 and R2-4 were raised about - a
sweep delete lost to a swallowed `allSettled` rejection or GSI lag - now ends
with an operator being *offered a button* that texts the tenant about the tour's
old time. The pointer check makes the automatic path safe and the manual path
unsafe, which is the wrong way round: the poll is the one that can be re-run, and
the human click cannot be undone.

A builder following 3.3 literally ships this. The spec must either (a) extend the
pointer check to `forceSendReminder` and to the PATCH restore, or (b) rule that
an earlier unsent rung gets Cancel *only* - which needs saying explicitly,
because "renders with its real state" plus the existing render site produces
three buttons, not one.

---

## 2. [HIGH] The pointer check is poll-only, so three preview surfaces promise a send the poll will refuse - for as long as the rung's `dueAt` is away

**What is wrong.** 3.2 introduces a SECOND retirement mechanism (pointer
mismatch) alongside deletion. Section 4 still carries the round-1 sentence
justifying no read-side work: "The two Upcoming buckets already filter to rows
with no `sentAt` / `canceledAt`, so D1 needs no read-side change there - it
removes the rows they were showing." That was true when deletion was the only
mechanism. It is not true now: a pointer-mismatched row is retired but carries no
terminal stamp, so every filter in the codebase passes it.

**Evidence.** All three preview surfaces filter on the three terminal stamps and
nothing else:

- contact Upcoming bucket - `app/src/routes/contactTimeline.ts:982-984`
- group thread Upcoming bucket - `app/src/routes/relayGroups.ts:270-272`
- the tour panel's own chip - `app/src/routes/tourReminders.ts:644-655`, where
  `suppression` is computed for any `state === 'upcoming'` row and knows nothing
  about `ladderId`

And the mismatch is not resolved until the rung comes DUE, because `listDue`
returns only `#dueAt <= :now` (`app/src/repos/tourRemindersRepo.ts:241`). A
superseded rung whose `dueAt` is three days out sits in all three surfaces for
three days chipping "sends in 3 days" for a send that will be claim-skipped the
instant the poll can reach it.

**What it implies.** This is the exact anti-pattern the codebase already names
twice in its own comments - "the perpetual-'sending shortly' lie claimSkip exists
to prevent" (`app/src/routes/tourReminders.ts:626-627`) and "without it the
contact page would keep promising 'sends in 3h' on a rung the panel one click
away calls retired" (`app/src/routes/contactTimeline.ts:1020-1022`).

Cheap and consistent with the existing design: make the pointer mismatch a
`suppression` reason the same way `discontinued` is - decided outside the
evaluator, on all three surfaces - and drop the mismatched row from the two
Upcoming buckets. Section 4's "no read-side change there" sentence has to go
either way; it is now false.

---

## 3. [HIGH] Conversion's compensation is no longer a compensation: a failed `placements.create` releases the claim but the ladder is already hard-deleted and the pointer cleared

**What is wrong.** 3.2 item 3: "Its compensation semantics are unchanged: a
throw still releases the conversion claim and rethrows."

The code path is unchanged. What it compensates for is not. The sweep is now
irreversible and the spec adds a pointer clear on top of it.

**Evidence.** The conversion's ordered sequence
(`app/src/routes/placements.ts:692-699`) puts the reminder retirement at step 3
and the placement create at step 4, and the create's failure handler is:

`app/src/routes/placements.ts:745-748`
```
} catch (err) {
  await tours.releaseConversionClaim(tour.tourId, sentinel);
  throw err;
}
```

The claim is released, the request 500s, and the tour keeps `status: 'scheduled'`
- `tours.patch(..., { status: 'closed', ... })` is step 5 and never runs
(`:758`). The docblock at `:711-714` states the reasoning the old behavior earned:
"canceling reminders on a still-unconverted tour is benign retry residue." Under
a `canceledAt` STAMP it was: the rows stayed, struck through and visible, and any
later reschedule re-armed. Under D1 the rows are gone with no trace and,
per 3.2 item 3, `currentLadderId` is cleared too.

**What it implies.** A failed conversion leaves a live, still-`scheduled` tour
with zero reminder rows, no pointer, and nothing in the UI to indicate a ladder
ever existed. Nothing re-arms it - the arm only runs from the create route
(`app/src/routes/tours.ts:350`) and the re-arm path (`:1191`), neither of which
this touches. The tenant gets no day-before, no morning-of, no en-route, silently.

3.2 item 3 asserts the semantics are unchanged when it is precisely the semantics
that changed. The spec must either re-arm on the compensation path, or move the
sweep+clear to AFTER the finalize patch (which reopens the "a live reminder
firing on a CONVERTED tour" hazard the ordering docblock exists to prevent, so it
needs a ruling, not a default), or state that a failed conversion silently
disarms the tour and is accepted.

---

## 4. [HIGH] The new pin target is a two-horned problem and the spec picks neither horn - `atBottom` gets a constraint, not a predicate

**What is wrong.** 3.5 changes the pin target: "At-bottom therefore means the
last message is at the bottom edge, with the block just past the fold." The
second anchoring bullet then says `atBottom` "must keep meaning 'the operator is
at the newest MESSAGE' under the new pin target." That is the constraint restated,
not the predicate - and the two candidate predicates each break something.

**Evidence.** The predicate is one expression, used for two different jobs:

`dashboard/src/routes/contact/Timeline.tsx:1835-1838`
```
const isAtBottom = (el: HTMLElement): boolean =>
  el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
```
It sets `atBottomRef` from the scroll handler (`:1851`), and `atBottomRef` gates
the auto-pin (`:1911-1912`) and the pill (`:1914-1915`).

Call `A` the scroll offset that puts the last message at the bottom edge.

- **Predicate "at or past A"** (`scrollTop >= A - 48`). Then an operator who has
  deliberately scrolled DOWN to read the Upcoming block is still "at bottom", so
  the next inbound message runs `el.scrollTop = A` (`:1912`) and **yanks them off
  the block they were reading**. There is no analogue of that on `main` - today
  the block cannot be scrolled to, so it cannot be scrolled away from.
- **Predicate "within 48px of A"** (`Math.abs(scrollTop - A) <= 48`). Then that
  same operator is NOT at bottom, so every inbound message sets `hasNewBelow`
  (`:1915`) - a "New messages" pill that will not clear while they read the
  block, and no auto-scroll. This is reviewer A's round-1 point 8, second break,
  reappearing in the new design.

**What it implies.** Acceptance 11 ("the pill still appears... and dismisses on
scroll to bottom, with an Upcoming block present") passes under both predicates
and detects neither failure, because it never tests the state where the operator
is looking AT the block. The spec must name the predicate and say what happens
when a message arrives while the operator is below `A`. My read is that "past A"
should be at-bottom for the PILL (they have seen everything) but must NOT
re-trigger the pin (do not move someone who is already at rest below the anchor)
- i.e. the two jobs the one expression currently does need to split. That is a
design decision, and it is the whole substance of the D4 redesign.

---

## 5. [HIGH] The revision's test enumeration misses the five tests that actually encode the old pin contract, and jsdom cannot express the new one

**What is wrong.** Section 4: "The D4 move has its own test surface - five unit
sites and four e2e sites resolving the Upcoming region by role and name."

Those nine are the ones that find the *block*. The tests that encode the *pin*
resolve nothing by role or name and are not in the list.

**Evidence.** `dashboard/src/routes/contact/Timeline.test.tsx:1375-1481`, the
`Timeline stick-to-bottom` describe. Five cases, and three of them assert the old
pin target as a literal equality against the mocked `scrollHeight`:

- `:1420` - `expect(el.scrollTop).toBe(700); // re-pinned to the new bottom`
- `:1451` - `expect(el.scrollTop).toBe(700); // jumped to the newest` (the pill)
- `:1478` - `expect(el.scrollTop).toBe(900); // opened on the newest item`

Every one of those becomes wrong under "the last message at the bottom edge". The
other two (`:1433`, `:1465`) encode the scrolled-up branch and survive.

Worse, the harness's own header states the obstacle:
`Timeline.test.tsx:1376` - "jsdom does no layout, so drive the scroll geometry
ourselves", and it mocks `scrollHeight` / `clientHeight` / `scrollTop` by hand
(`:1378-1392`). The same fact is documented on the CSS side -
`Timeline.module.css:136-141`, "No unit test can see either direction: jsdom
performs no layout". The new anchor `A` has to come from real geometry (the
block's `offsetTop`, or the last message's offset), and jsdom returns 0 for all
of it. So the builder must invent and mock a new geometry seam, and whatever
they mock is what the test proves - not the browser.

**What it implies.** Two spec-level requirements are missing: name this describe
block alongside the nine region sites, and state that the pin target is provable
only in the e2e lane (acceptance 10 and 11 are e2e criteria, not unit ones). Left
unsaid, the likeliest outcome is that these five tests get their constants edited
until they pass, which is the same as deleting them.

---

## 6. [HIGH] `armTourReminders` has no `toursRepo`, and the spec never says who owns the pointer write

**What is wrong.** 3.1 assigns both halves of the two-write scheme to the arm
function: "`armTourReminders` mints one `ladderId` per CALL" and "Order is: write
the tour's `currentLadderId` FIRST, then create the rows." Writing the tour
requires a tours repo the function does not have.

**Evidence.** `app/src/jobs/tourReminders.ts:346-355`:
```
export interface ArmTourRemindersDeps {
  tourRemindersRepo: TourRemindersRepo;
  settingsRepo: Pick<SettingsRepo, 'getOrgSettings'>;
  logger?: Logger;
}
```

Adding a required `toursRepo` reaches every call site. The production ones are
`app/src/routes/tours.ts:350` and `:1191` (both already hold `tours`), but the
seed does not: `app/src/lib/seed/live.ts:514`, `:528`, `:538` pass exactly
`{ tourRemindersRepo: remindersRepo, settingsRepo }`, and the block's own comment
at `:484-486` states the current contract - "armTourReminders only needs
tourRemindersRepo (+ optional logger)". live.ts hand-builds its `TourItem` shapes
out of `staticItems['tours']` (`:499-503`), i.e. raw seed objects, so a
pointer write from inside the arm would have to patch rows the seed batch wrote,
after the fact. There are also roughly 25 direct call sites in
`app/test/tourReminders.test.ts` plus `app/test/relayApi.test.ts:1454`.

**What it implies.** There are two coherent designs and the spec picks neither:

- **Arm owns both writes** - `armTourReminders` gains a `toursRepo` dep, and
  `seed/live.ts` must acquire one and guarantee the tour rows are persisted
  before the arm call.
- **Caller owns the pointer** - the route mints the `ladderId`, patches the tour,
  and passes the id into the arm. This keeps the arm's dep surface and its ~27
  test call sites untouched, and it makes 3.1's ordering rule enforceable at the
  one place that can see both writes.

They differ in blast radius by an order of magnitude and in where the
crash-between-writes window lives. Section 4's "Writers of the tour row gain one
field: `currentLadderId`, written at arm time" does not decide it.

---

## 7. [MEDIUM] The pointer's order relative to the SWEEP is unspecified on all three paths, and the literal reading leaves the window the pointer check exists to close

**What is wrong.** The revision fixes two orderings and omits the third. 3.1
fixes pointer-before-rows. 3.2 fixes sweep-before-arm. Nothing fixes the pointer
relative to the sweep.

**Evidence and consequence.**

- **Re-arm path.** Taking 3.1 and 3.2 literally the order is: sweep, then write
  the pointer, then create rows (`app/src/routes/tours.ts:1190-1195` is where
  the sweep+arm pair sits). Between the sweep and the pointer write, the pointer
  still names the OLD ladder - so a row the sweep MISSED still matches, and the
  poll's new check passes it. That is precisely the interleaving 3.2's check was
  added for.
- **Terminal path.** 3.2 item 2 says the sweep "also CLEARS the tour's
  `currentLadderId`", which reads as sweep-then-clear and leaves the same window.
- **Conversion path.** Same wording, same window.

The safe rule is uniform and one sentence: write (or clear) the pointer BEFORE
the sweep on all three paths, so a missed row is non-current from the first
instant. That also makes the terminal and conversion paths mirror 3.1's own
argument rather than contradict it. The window is narrow, but "narrow" is the
same word that described the resurrection race in round 1.

Related, and cheap: on the terminal path the pointer clear and the status patch
are two writes to the same tour row in one request
(`app/src/routes/tours.ts:1164` patches status, the sweep runs at `:1208`). They
can be one `patch` call. The spec should say whether they are, because if they
are not there is a window where the tour reads `canceled` with a live pointer.

---

## 8. [MEDIUM] The pointer-mismatch claim-skip needs a new `ReminderSkipReason` and an entry in an exhaustive user-facing label map; the spec names neither

**What is wrong.** 3.2: the poll refuses a mismatched rung, "retiring it with a
claim-skip instead." A claim-skip requires a `ReminderSkipReason`.

**Evidence.** The union is closed and heavily documented -
`app/src/repos/tourRemindersRepo.ts:38-92`, thirteen tokens, each with a comment
saying which layer writes it. And the operator copy is an exhaustive mapped type
that will not compile without the new key:

`dashboard/src/api/types.ts:1301-1317`
```
export const REMINDER_SKIP_REASON_LABELS: Readonly<
  Record<NonNullable<TourReminderView['skipReason']>, string>
> = { ... }
```

**What it implies.** Typecheck forces the map entry, so nothing ships broken -
but nobody will have DECIDED the wording, and this is automated user-facing copy
on a staff surface, where the existing entries are carefully non-accusatory
("booked too late for this reminder", per the precedence note at
`app/src/jobs/tourReminders.ts:468-475`). The spec should name the token and the
sentence. "superseded by a newer schedule" is the honest one; the existing
`quiet_hours_superseded` label ("superseded by a later reminder") is close enough
to be confused with it, which is its own reason to decide this deliberately
rather than at 2am in a build.

---

## 9. [MEDIUM] Acceptance 10's "no Upcoming block at rest" is false for any thread shorter than the viewport

**What is wrong.** Acceptance 10: "On a 390px viewport, at rest, the conversation
stream shows MORE messages than it does on `main` and no Upcoming block."

The block is hidden at rest only because it is scrolled past the fold. A thread
whose content is shorter than `.stream`'s height has nothing to scroll: content
sits at the top, the block sits directly under the last message, and both are on
screen. `scrollTop` clamps to 0 and the pin is a no-op.

**Evidence.** `.stream` is `flex: 1` with `min-height: 8rem` (`overflow: auto`) -
`Timeline.module.css:110-118` - and `4rem` under 767.98px (`:156-160`). A new
contact, a freshly opened relay group, or any thread with two or three bubbles is
below that on a 390px viewport. The block renders whenever `upcoming` is
non-empty (`Timeline.tsx:2102`), independent of scroll.

"Shows MORE messages than on `main`" is also vacuous in that case: on `main`
every message is visible too (the column is not full), so the two are equal, not
greater.

**What it implies.** As written the criterion fails on a common, correct case,
which costs a live-QA cycle and invites someone to "fix" the non-bug by hiding
the block on short threads - a mobile-only branch section 5 forbids. Qualify it:
a thread with enough history to overflow the stream.

---

## 10. [MEDIUM] "A STABLE derived key (ids/length)" does not capture the block's HEIGHT, which is the quantity the dep exists to react to

**What is wrong.** 3.5's first anchoring bullet: the Upcoming content "must join
them via a STABLE derived key (ids/length), never the array identity."

The advice correctly avoids R2-8's per-render churn, but the key it prescribes is
insensitive to the thing the pin actually depends on. The pin has to re-run when
the block's rendered HEIGHT changes. Ids and length do not change when a card
gets taller.

**Evidence.** `ScheduledCard` (`dashboard/src/routes/contact/ScheduledCard.tsx`)
renders a conditional suppression line through `suppressionNote(...)` and a state
line whose text changes over time; the Timeline drives a clock (`tickNow`,
`Timeline.tsx:1723`) that re-renders those relative labels. A card going from
"sends in 3h" to "sending shortly", or gaining a "Will be skipped - <reason>"
line, changes the block's height with the same ids and the same length. With
`overflow-anchor: none` (`Timeline.module.css:142`) the browser will not
compensate, which is exactly the third anchoring fact 3.5 lists.

**What it implies.** The drift the dep was added to prevent comes back through a
narrower door. The honest mechanism is a measurement, not a data key - a
`ResizeObserver` on the block, or including its measured `offsetHeight` in the
effect's trigger. Either is a couple of lines; neither is what the spec
prescribes.

---

## 11. [LOW] The PATCH response returns the pre-arm tour, so it omits the `currentLadderId` the same request just wrote

**Evidence.** `tour` is captured from the first patch (`app/src/routes/tours.ts:1164`)
and is what the handler returns - `res.json({ tour })` at `:1285`. The sweep and
arm run at `:1190-1195`, after that capture. A pointer written by the arm
(finding 6) is therefore absent from the response body.

**What it implies.** Nothing reads `currentLadderId` client-side under this
design - the partition is computed server-side in
`GET /api/tours/:tourId/reminders` - so this is cosmetic today. It stops being
cosmetic the moment anything client-side wants the pointer, and a stale field in
a 200 response is the kind of thing that gets trusted later. One line in section
4: the PATCH response's tour does not carry the pointer written by that same
request, or re-read before responding.

---

## 12. [LOW] Acceptance 11's "group thread" is unsatisfiable on the surface that name most obviously points at

**Evidence.** Acceptance 11 requires the pill behavior proven "with an Upcoming
block present, in both a contact thread and a group thread."
`dashboard/src/routes/conversation/GroupTextView.tsx:451` passes
`upcoming={[]}` - hard-coded, correctly, because a `group_text` thread never has
scheduled sends (`app/src/routes/relayGroups.ts:206-211` returns
`{scheduled: []}` for anything that is not a relay-owned tour thread). The
surface that CAN have a block is the relay group through `ConversationDetail`
(`ConversationDetail.tsx:483` passes `thread.upcoming`, fed by
`relayGroups.ts:226`).

**What it implies.** A builder who reaches for GroupTextView will conclude the
criterion is impossible. Name `ConversationDetail` / the relay-group thread.

---

## Contested adjudications

**A15 (unpaginated `listByTour`) - PARTIAL, still accepted as risk. I concede
again, and note it is now MORE right than when it was written.** The arithmetic
is unchanged (`app/src/repos/tourRemindersRepo.ts:221-231`, one `QueryCommand`,
no `LastEvaluatedKey` loop, unlike `listDue` at `:233-268`). But the consequence
shrank: at round 2 a truncated SWEEP meant a live rung nothing could stop, which
was my reason for pressing on the sweep side. With 3.2's pointer check, a rung
the sweep never reached is refused at claim time, so truncation now costs a
lingering row in `earlier[]` rather than a text to a tenant - subject to findings
1 and 2, which are what re-open it.

**R2-6's resolution (pin target instead of height cap) - the direction is right,
the resolution is incomplete.** Changing the pin target rather than the height is
the correct call and it does dissolve R2-7's nested scroller. But it moved the
unresolved decision one level down rather than closing it: see finding 4. The
adjudication records "at-bottom means the last MESSAGE is at the bottom" as a
resolution; it is a target, and `atBottom` is a predicate that now has to answer
a question it never had to answer before (what is true BELOW the anchor).

**R2-5 (my inverted-remedy correction) - accepted correctly, and acceptance 2 now
states it accurately.** No contest. Recorded only because it is the one place a
future reader might re-derive the wrong instruction from the round-1 text, which
is still in the file above the correction.

Nothing else in the adjudications is contested. The three round-1 blocking
findings, R2-1 through R2-4 and R2-8 through R2-13 are all answered by mechanisms
I can trace in the revision.
