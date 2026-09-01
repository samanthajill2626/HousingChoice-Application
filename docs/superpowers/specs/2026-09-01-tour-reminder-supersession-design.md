# Tour reminder supersession + Upcoming placement - design

Date: 2026-09-01
Branch: `feat/tour-reminder-supersession` (cut from `main` @f27aabbf)
Status: REVISED after spec review rounds 1-3 (56 findings, 52 accepted) -
adjudications at `docs/superpowers/reviews/2026-09-01-tour-reminder-supersession/adjudications.md`

D1 (hard delete) was re-affirmed by the founder at the end of round 3, with the
enforcement surface below priced in.

## 1. Problem

Two symptoms, both reported by the founder on 2026-08-31.

**P1 - dead reminder rungs pile up.** Rescheduling or canceling a tour does not
retire its reminder ladder; it STAMPS every pending rung `canceledAt`
(`routes/tours.ts` -> `cancelTourReminders` -> `tourRemindersRepo.cancelForTour`)
and then arms a fresh ladder alongside it. Every row ever written for the tour
stays in the `byTour` partition and `listByTour` returns all of them, so the
tour's Reminders panel grows by a full dead ladder per reschedule.

**P2 - the Upcoming block eats the phone.** In `Timeline.tsx` the pinned
`<section class=upcoming>` is a flex sibling of `.streamWrap`, between the
scrolling stream and the composer. Under 767.98px `Timeline.module.css` gives it
`min-height: 2.5rem; max-height: 7rem` out of a roughly 400px column, so on a
phone two or three messages remain visible and the block is on screen whether or
not the operator is looking at it.

## 2. Decisions

- **D1 - supersession DELETES.** On reschedule, on the terminal status
  transitions, and on tour-to-placement conversion, the superseded ladder's
  never-sent rungs are hard-deleted. The sweep reaches pending,
  operator-canceled AND skipped rows alike. Only rows carrying `sentAt` survive.
- **D2 - sent rungs survive in storage, not in the default view.**
- **D3 - the generation pointer lives on the TOUR.** Each arm call mints a
  `ladderId` (UUID) stamped on every row it writes; the tour carries
  `currentLadderId`. Current ladder = rows matching the pointer. A cleared
  pointer means the tour has no current ladder.
- **D3a - the CALLER owns the pointer write.** `armTourReminders` mints the
  `ladderId`, stamps its rows and RETURNS it; the caller writes it to the tour.
  `ArmTourRemindersDeps` gains no `toursRepo`. This is the cheap side of a real
  fork: threading a repo into the armer would touch its ~25 call sites, and
  `lib/seed/live.ts:514,528,538` has no repo to thread.
- **D4 - the Upcoming block moves inside the scroll, at every width**, with
  "at the bottom" continuing to mean the newest MESSAGE is at the bottom.

## 3. Behavior

### 3.1 Arm time

`armTourReminders` mints one `ladderId` per CALL, stamps it on every row that
call creates (rows born already-skipped included), and returns it. A UUID rather
than a timestamp because `routes/tours.ts:251` takes an injectable `deps.now`
and the app suite injects a constant (`ARM_NOW`, `toursApi.test.ts:1228`), so
two arms inside one test share an instant.

### 3.2 Ordering - one sequence, all three paths

The pointer is what makes a rung claimable, so it moves FIRST and comes back
LAST. Every path runs:

1. **Clear** the tour's `currentLadderId`.
2. **Sweep** (delete every row with no `sentAt`).
3. Re-arm paths only: **arm** the new ladder, then **set** the pointer to the
   returned `ladderId`.

Between steps 1 and 3 the tour has no current ladder, so the poll and every
other send path refuse every rung of it (3.3). That window is the whole reason
the pointer moves first: it closes the interval the sweep is working in, rather
than leaving it open the way a sweep-then-pointer order would.

Terminal transitions (`canceled` / `closed` / `toured` / `no_show`) stop after
step 2 - a terminal tour has no current ladder.

**Conversion (`routes/placements.ts:716`) stops after step 1 until the placement
exists.** Today's comment is right that a reminder must not fire on a converted
tour, but hard delete broke the compensation: `placements.create` failing
releases the conversion claim and rethrows, and with the ladder already gone the
tour is left live, `scheduled`, and silently disarmed. Clearing the pointer
alone disarms the ladder REVERSIBLY - the poll refuses every rung immediately,
and the release path restores the pointer. The sweep runs only once `create` has
succeeded and the conversion is real.

### 3.3 What refuses a superseded rung

**Every send path checks the pointer, not just the poll.** A rung whose
`ladderId` does not match its tour's `currentLadderId` - including every rung of
a tour whose pointer is cleared - is refused by:

- `runDueTourReminders`, which retires it with a claim-skip carrying a new
  `ReminderSkipReason` token `superseded`, labelled "superseded by a reschedule"
  in the exhaustive `REMINDER_SKIP_REASON_LABELS` map (both unions and the map
  are exhaustive; a new token that misses either fails typecheck).
- `forceSendReminder`, the human "Send now" path, which refuses with 409. It is
  NOT covered by the poll's check - it is a separate entry point - and without
  this it is a live button that sends a superseded reminder on demand.

**The claim guards.** `claimSend`, `claimSkip` and `cancel` are `UpdateCommand`s
conditioned only on `attribute_not_exists(...)`. DynamoDB's UpdateItem CREATES a
missing item, so against a swept row every one of those conditions HOLDS: the
claim succeeds, an attribute-only stub springs into existence with no `tourId`,
`kind` or `dueAt`, and the poll sends. Each gains
`attribute_exists(reminderId)`. `uncancel` already requires
`attribute_exists(canceledAt)`. The precedent is in-repo at
`app/scripts/retire-paused-tour-reminders.ts:205-207`.

**The three PREVIEW surfaces must agree.** `routes/tourReminders.ts` (the
panel), `routes/contactTimeline.ts:981` (contact Upcoming) and
`routes/relayGroups.ts:226` (group Upcoming) all render a pending rung as a
promise that it will send. A pointer-mismatched rung is a promise the send paths
will refuse, and because `listDue` only picks rows up at `dueAt <= now` the lie
would stand until the rung came due - not until the next tick. All three
surfaces therefore render such a rung as suppressed with the `superseded`
reason, never as upcoming.

### 3.4 Read grouping

A row is CURRENT when its `ladderId` matches the tour's `currentLadderId`, or
when the tour has NO pointer and the row has NO `ladderId` (a wholly
pre-migration tour). Every other row is EARLIER.

- `reminders[]` keeps its meaning and shape: the current ladder, and it alone
  feeds `next`.
- `earlier[]` is new: surviving rungs of previous generations, newest first.

`earlier[]` is NOT guaranteed to hold only sent rows - a lost sweep delete (a
swallowed `allSettled` rejection, a GSI read that missed a row) leaves an unsent
superseded rung behind. Such a rung renders with its real state and keeps
**Cancel** so an operator can retire it. It does NOT get **Send now**:
`RemindersPanel.tsx:397` renders that button for any rung in state `upcoming`,
which an unsent earlier rung is, so the action list for `earlier[]` is
allowlisted rather than inherited.

**The disclosure's slot sits OUTSIDE the empty-ladder short-circuit.**
`RemindersPanel.tsx:346` returns "No reminders armed." on an empty
`reminders[]`; a canceled tour is exactly that state with a non-empty
`earlier[]`.

**An earlier rung with no `sentBody` renders no body** - those rows predate the
snapshot field and compose LIVE, which for a superseded generation means
composing against the tour's CURRENT time.

### 3.5 Pre-migration rows

A tour with no `currentLadderId` and rows with no `ladderId` renders, and polls,
exactly as today. The first sweep-and-arm writes a pointer and a stamped ladder,
after which legacy rows sort as EARLIER. No backfill.

### 3.6 Upcoming placement

The `<section class=upcoming>` moves from a sibling of `.streamWrap` to the last
child INSIDE `.stream`, keeping its heading, list and `aria-label`. Its
`max-height`, `overflow-y` and `flex` rules go away - a capped block with its
own scrollbar inside the stream's scrollbar is a nested scroller, and the cap is
unnecessary once the pin target is right.

**`atBottom` becomes a predicate over the MESSAGE content.** Today it is
`scrollHeight - scrollTop - clientHeight <= 48` (`Timeline.tsx:1838`) and the
pin is `scrollTop = scrollHeight` (`:1890`). Both are rewritten against a
sentinel element placed after the last cluster and before the Upcoming section:
at-bottom means that sentinel's bottom is within 48px of the viewport bottom;
pinning scrolls it there. Two failure modes this must avoid, and the acceptance
criteria pin both: an operator reading the Upcoming block must NOT be yanked
back to the last message by an arriving item, and a "New messages" pill must NOT
be permanently lit merely because content exists below the sentinel.

**The pin dep must track HEIGHT, not identity or count.** The effect's deps are
`[clusters, resetScrollKey, paging?.olderPagesLoaded]` (`:1920`). An ids/length
key is insensitive to the block's rendered height, which is the quantity the pin
depends on - a body wrapping to a second line moves the anchor with no key
change. A `ResizeObserver` on the Upcoming block, re-pinning when it is at
bottom, is the mechanism. The array itself must never be a dep:
`GroupTextView.tsx:451` passes a fresh `[]` literal every render.

`.stream` sets `overflow-anchor: none` (module CSS :142), so the browser will
not compensate on its own. The "New messages" pill is positioned against
`.streamWrap`, untouched by this move.

## 4. Surfaces

**Writers of reminder rows**: `armTourReminders` (create); the three sweep call
sites (3.2); `claimSend` / `claimSkip` (poll and send-now); `cancel` /
`uncancel` (PATCH); the seed builders under `app/src/lib/seed/`; the dev tick
routes; `app/scripts/retire-paused-tour-reminders.ts` (already guarded - the
precedent, not a victim). Seeds must stamp ONE `ladderId` per seeded ladder and
set the tour pointer to it: `matrix.ts` builds raw rows for a same-tour sent
`confirmation` plus pending `day_before`, and a partial stamp splits every
seeded ladder across the disclosure.

**Writers of the tour row**: `currentLadderId`, written by the CALLER (D3a) at
the three sweep sites and on arm. `routes/tours.ts:1164` captures the tour
BEFORE the reminder side effects and `:1285` returns it, so the PATCH response
would omit a `currentLadderId` the same request wrote - the returned object must
carry it.

**Readers**: `listByTour` at `routes/contactTimeline.ts:981`,
`routes/relayGroups.ts:226`, `jobs/tourReminders.ts:1618`, and FIVE sites in
`routes/tourReminders.ts`; plus `listDue` in the poll. Two of the five (`:395`,
`:462`) end in `.find(...)!` on a post-write re-read - `undefined` reaching a
view composer once rows can vanish - so both return an honest 404, and the 404
path must still emit `scheduled.updated` (`:416`) when the write itself won.

**Client render sites**: `RemindersPanel` (tour detail); `Timeline.tsx` for both
Upcoming buckets - the single render site behind the contact comms tab,
`ConversationDetail`, `GroupTextView`, and the tour and placement conversation
views.

**Tests encoding contracts this change breaks** (re-point, do not delete):
`e2e/tests/scenarios/scheduled-visibility.spec.ts:268` (the only end-to-end
proof that a reschedule retires the previous ladder);
`e2e/scenarios/steps.ts:3615-3661` (rung disambiguation resting on superseded
rows staying visible); `dashboard/src/routes/contact/Timeline.test.tsx:1375-1481`
(five tests encoding the OLD pin contract). jsdom performs no layout, so the new
anchor cannot be proven at the unit layer: unit tests cover the at-bottom
PREDICATE as a pure function, and the anchoring itself is an e2e assertion in a
real browser. Four e2e sites resolve the Upcoming region by role and name.

## 5. Non-goals

- No change to when rungs fire, what they say, or the quiet-hours clamp.
- No backfill of `ladderId` / `currentLadderId` (3.5).
- No change to per-rung Cancel / Restore / Send now on the CURRENT ladder.
- No mobile-only layout branch.
- No pagination work on `listByTour` (R5).

## 6. Acceptance

1. After two reschedules the current ladder holds exactly one generation and the
   superseded unsent rows are GONE from the table, not merely filtered.
2. A rung the poll claims between the sweep's list and its delete survives and
   reads as sent. Proven at the REPO layer against DynamoDB Local: the in-memory
   fake returns `false` on a missing row, which is correct POST-guard behavior
   and therefore cannot express the pre-guard defect.
3. A rung deleted by the sweep and then reached by `claimSend` does NOT
   resurrect and does NOT send.
4. A rung the sweep failed to delete is refused by the poll (claim-skipped
   `superseded`) AND by Send now (409), and shows in `earlier[]` with its real
   state, a working Cancel, and NO Send now button.
5. All three preview surfaces render a pointer-mismatched pending rung as
   suppressed `superseded`, not as upcoming, before its `dueAt` arrives.
6. A terminal transition clears the pointer; the current ladder is empty and
   every survivor reads as earlier. Reviving to `scheduled` arms a NEW ladder
   that adopts no earlier rung.
7. A conversion whose `placements.create` FAILS leaves the tour with its ladder
   intact and its pointer restored - still armed, still sending.
8. A hand-canceled rung disappears on the next reschedule; PATCH against a
   deleted rung returns 404, not 500, and still emits `scheduled.updated` when
   the write won.
9. The disclosure renders when the current ladder is EMPTY.
10. An earlier rung with no `sentBody` shows no body.
11. A tour with no pointer and no stamped rows renders, and polls, exactly as on
    `main`.
12. On a 390px viewport, in a thread whose messages OVERFLOW the stream, at rest
    the view shows more messages than `main` and no Upcoming block; scrolling
    down reveals it; scrolling up removes it. (A thread shorter than the
    viewport has nothing to scroll and shows the block - that is correct.)
13. An operator scrolled onto the Upcoming block is NOT yanked back to the last
    message when a new item arrives, and the "New messages" pill is not lit
    merely because the block sits below the sentinel.
14. The pill still appears on an inbound message while scrolled up and dismisses
    on scroll to bottom, in a contact thread and in a relay-group thread through
    `ConversationDetail` (`GroupTextView` passes `upcoming={[]}` and cannot
    exercise it).
15. Both Upcoming buckets stop returning rungs from a superseded ladder.

## 7. Risks

- **R1 - deletion is irreversible.** The `attribute_not_exists(sentAt)`
  condition belongs on the DELETE, never a read-then-delete check.
- **R2 - the guards and checks are the load-bearing half.** Sweep without them
  and a blocked rung becomes a sent one.
- **R3 - the sweep widens what `cancelForTour` did**, so any test asserting a
  canceled row survives a reschedule encodes the OLD contract.
- **R4 - two writes, one invariant.** Pointer and rows are separate writes with
  no transaction. The 3.2 ordering bounds every interruption to "no current
  ladder", which is safe by construction: nothing sends.
- **R5 - `listByTour` is unpaginated**; the sweep and the read partition inherit
  it. The pointer check lowers the consequence of a missed row from "sends" to
  "shows up in earlier".
- **R6 - scroll semantics.** Passes unit tests, fails in the hand. Live QA on a
  phone viewport is required.
- **R7 - a terminal tour's panel can go empty.** Intended consequence of D1.
