# Tour reminder supersession + Upcoming placement - design

Date: 2026-09-01
Branch: `feat/tour-reminder-supersession` (cut from `main` @f27aabbf)
Status: REVISED after spec review round 1 (30 findings, 24 accepted) -
adjudications at `docs/superpowers/reviews/2026-09-01-tour-reminder-supersession/adjudications.md`

## 1. Problem

Two symptoms, both reported by the founder on 2026-08-31.

**P1 - dead reminder rungs pile up.** Rescheduling or canceling a tour does not
retire its reminder ladder; it STAMPS every pending rung `canceledAt`
(`routes/tours.ts` -> `cancelTourReminders` -> `tourRemindersRepo.cancelForTour`)
and then arms a fresh ladder alongside it. Every row ever written for the tour
stays in the `byTour` partition and `listByTour` returns all of them, so the
tour's Reminders panel grows by a full dead ladder per reschedule. A tour
rebooked three times shows four ladders, three of them struck through.

**P2 - the Upcoming block eats the phone.** In `Timeline.tsx` the pinned
`<section class=upcoming>` is a flex sibling of `.streamWrap`, sitting between
the scrolling stream and the composer. Under 767.98px `Timeline.module.css`
gives it `min-height: 2.5rem; max-height: 7rem` out of a roughly 400px column,
so on a phone two or three messages remain visible and the block is on screen
whether or not the operator is looking at it.

## 2. Decisions (D1, D2, D4 locked with the founder 2026-08-31)

- **D1 - supersession DELETES.** On reschedule, on the terminal status
  transitions, and on tour-to-placement conversion, the superseded ladder's
  never-sent rungs are hard-deleted rather than stamped canceled. The sweep
  reaches pending, operator-canceled AND skipped rows alike. Only rows carrying
  `sentAt` survive.
- **D2 - sent rungs survive in storage, not in the default view.** A rung that
  texted somebody keeps its row (it is the send-idempotency record and holds the
  `sentBody` snapshot). It leaves the panel's default list and collapses behind
  one disclosure line.
- **D3 - generation is a monotonic arm stamp.** A new `armedAt` attribute
  records the instant an arm CALL ran, identical on every row that call creates.
  Current ladder = the rows carrying the greatest `armedAt` for the tour.
  REVISED at round 1: the first draft keyed generation off `tour.scheduledAt`,
  which a status-only revival and a no-op re-PATCH both leave unchanged, so two
  generations would have shared an identifier.
- **D4 - the Upcoming block moves inside the scroll, at every width.** It
  becomes the last thing inside the scrolling stream, below the newest message,
  and it keeps a height cap there. No phone-only branch; desktop changes too.

## 3. Behavior

### 3.1 Arm time

`armTourReminders` computes ONE `armedAt` (the `now` it was called with,
canonicalized ISO) and stamps it on every row of the ladder it writes -
including rows born already-skipped, which belong to a generation like any
other row. Two arm calls can never share an `armedAt` for the same tour: the
sweep in 3.2 runs between them, and the route awaits each in turn.

### 3.2 Supersession sweep

A new repo method, `deleteSupersededForTour`, replaces `cancelForTour` at ALL
THREE of its call sites:

1. `routes/tours.ts` re-arm path (`armable && rearmTrigger`), immediately BEFORE
   `armTourReminders`.
2. `routes/tours.ts` terminal path (`canceled` / `closed` / `toured` /
   `no_show`).
3. `routes/placements.ts:716`, tour-to-placement conversion, between
   `claimConversion` and `create`. Its compensation semantics are unchanged: a
   throw still releases the conversion claim and rethrows. Deleting rather than
   canceling is correct here for the same reason cancel was - the tour is over
   as a tour - and the rows it removes are exactly the ones no longer reachable.

`cancelForTour` is removed once all three move.

The sweep lists the tour's rows and deletes every row with no `sentAt`. Each
delete is CONDITIONAL on `attribute_not_exists(sentAt)`, so a rung the poll
claimed between the list and the delete survives: the condition fails, the
delete is a benign no-op, and the row stays as sent history. A lost condition
logs at debug, never as an error - the posture `cancelForTour` already takes
with `Promise.allSettled`.

**The claim guards are part of this change, not an optimisation.**
`claimSend`, `claimSkip` and `cancel` are `UpdateCommand`s conditioned only on
`attribute_not_exists(...)`. DynamoDB's UpdateItem CREATES a missing item, so
against a row this sweep deleted every one of those conditions HOLDS: the claim
succeeds, an attribute-only stub row springs into existence with no `tourId`,
`kind` or `dueAt`, and the poll sends a reminder for a schedule that no longer
exists. Each of the three gains `attribute_exists(reminderId)`. Without this,
D1 does not retire anything - it converts a reliably-blocked rung into a sent
one. `uncancel` already requires `attribute_exists(canceledAt)` and is safe.

Ordering is load-bearing and is the ONLY thing protecting the incoming ladder:
sweep first, then arm. The sweep does not read `armedAt` and cannot tell
generations apart - it is a "delete everything unsent" operation whose safety
comes entirely from running before the new rows exist.

### 3.3 Read grouping

`GET /api/tours/:tourId/reminders` gains a partition. Let `maxArmedAt` be the
greatest `armedAt` among the tour's rows. A row is CURRENT when its `armedAt`
equals `maxArmedAt`, or when NO row carries an `armedAt` at all (a wholly
pre-migration tour - see 3.4). Every other row is EARLIER.

- `reminders[]` keeps its meaning and its shape: the current ladder, and it
  alone feeds `next`.
- `earlier[]` is new: the surviving sent rungs of previous generations, newest
  first. By construction it can hold only `sentAt` rows.

`RemindersPanel` renders `reminders[]` as today. When `earlier` is non-empty it
renders one muted disclosure - "Earlier schedules (N sent)" - that expands to
the same row treatment, read-only: no Cancel, no Restore, no Send now, all of
which the server already refuses on a sent row.

**The disclosure's slot sits OUTSIDE the empty-ladder short-circuit.** Today
`RemindersPanel.tsx:346` returns "No reminders armed." on an empty
`reminders[]`; a canceled tour is precisely an empty current ladder with a
non-empty `earlier[]`, so a disclosure nested inside the list branch would be
unreachable in the case that needs it most.

**An earlier rung with no `sentBody` renders no body.** Those rows predate the
snapshot field and today's read paths compose them LIVE - which, for a
superseded generation, composes against the tour's CURRENT time and would show
a text sent last month advertising next month's date. The row still shows its
kind and its sent-at.

### 3.4 Pre-migration rows

Rows written before `armedAt` exists have no generation. A tour whose rows ALL
lack it renders exactly as today (everything current, pile-up intact). The
first sweep-and-arm on that tour stamps the new ladder, at which point the
legacy rows sort as EARLIER - the unsent ones are already gone, and the sent
ones move behind the disclosure. No backfill: it would have to guess which
historical rows belonged together, and the state resolves on first use.

### 3.5 Upcoming placement

The `<section class=upcoming>` moves from a sibling of `.streamWrap` to the last
child INSIDE `.stream`, keeping its heading, its list and its `aria-label`.

It KEEPS a height cap there (its current 12rem / 7rem-on-phone ceiling and its
own `overflow-y`). Uncapping it would mean that pinning to the bottom fills a
phone with scheduled cards and no messages - strictly worse than today. Capped
and inside the scroller delivers the actual intent: visible when you scroll to
the bottom, entirely gone when you scroll up, never occupying the pane while you
read.

Three anchoring facts constrain the move, all verified on `main`:

- The layout effect that pins to bottom lists deps
  `[clusters, resetScrollKey, paging?.olderPagesLoaded]` (`Timeline.tsx:1920`).
  `upcoming` must join them, or a block that arrives or grows after the stream
  settles changes `scrollHeight` with nothing re-pinning.
- `atBottom` allows 48px of slack (`Timeline.tsx:1838`), which is smaller than
  the block. The measurement must keep meaning "the operator is at the newest
  content" once the block is inside the scroller.
- `.stream` sets `overflow-anchor: none` (module CSS :142), so the browser will
  not compensate for the height change on its own.

The "New messages" pill is absolutely positioned against `.streamWrap`, which is
unchanged by this move.

## 4. Surfaces

**Writers** of reminder rows: `armTourReminders` (create); `cancelForTour` at
the three call sites in 3.2; `claimSend` / `claimSkip` (poll and send-now);
`cancel` / `uncancel` (PATCH); the seed builders under `app/src/lib/seed/`; the
dev tick routes; and `app/scripts/retire-paused-tour-reminders.ts`, which runs
the same claim path and is subject to the same resurrection race. Seeds that arm
ladders must stamp `armedAt` or the seeded world reads as pre-migration.
`app/src/lib/performanceSeed.ts:167` constructs the repo and hands it on -
whether it writes rows is a plan-time check.

**Readers**: `listByTour` at `routes/contactTimeline.ts:981` (the contact
Upcoming bucket), `routes/relayGroups.ts:226` (the group thread's Upcoming
bucket, `GET /api/conversations/:id/scheduled`), `jobs/tourReminders.ts:1618`
(the force-send path), and FIVE sites in `routes/tourReminders.ts`; plus
`listDue` in the poll. Two of those five (`:395`, `:462`) end in `.find(...)!`
on a post-write re-read; once rows can vanish that assertion is `undefined`
reaching a view composer, so both must return an honest 404 instead.

The two Upcoming buckets already filter to rows with no `sentAt` / `canceledAt`,
so D1 needs no read-side change there - it removes the rows they were showing.

**Client render sites**: `RemindersPanel` (tour detail) for the ladder;
`Timeline.tsx` for both Upcoming buckets - the single render site behind the
contact comms tab, `ConversationDetail`, `GroupTextView`, and the tour and
placement conversation views.

**Tests encoding the OLD contract** (must be re-pointed, not deleted):
`e2e/tests/scenarios/scheduled-visibility.spec.ts:268` is the only end-to-end
proof that a reschedule retires the previous ladder, and
`e2e/scenarios/steps.ts:3615-3661` disambiguates rungs in a way that rests on
superseded rows remaining visible.

## 5. Non-goals

- No change to when rungs fire, what they say, or the quiet-hours clamp - Phase
  A and Phase B own that and both just landed.
- No backfill of `armedAt` onto historical rows (3.4).
- No change to per-rung Cancel / Restore / Send now for the current ladder.
- No new mobile-only layout branch (D4 is deliberately uniform).
- No pagination work on `listByTour` (see R5).

## 6. Acceptance

1. After two reschedules the panel's current ladder holds exactly one
   generation, and the superseded rows are GONE from the table - not merely
   filtered out of a response.
2. A rung the poll claims between the sweep's list and its delete survives and
   reads as sent. Proven at the REPO layer against DynamoDB Local, because the
   in-memory fake returns `false` on a missing row and cannot express this.
3. A rung deleted by the sweep and then reached by the poll's `claimSend` does
   NOT resurrect and does NOT send.
4. A hand-canceled rung disappears on the next reschedule and cannot be
   restored into the new ladder; PATCH against it returns 404, not 500.
5. A tour whose earlier ladder sent a confirmation shows that rung only behind
   the disclosure - including when the current ladder is EMPTY (a canceled
   tour), where the disclosure must still render.
6. An earlier rung with no `sentBody` shows no body rather than a body composed
   from the tour's current time.
7. A tour whose rows all predate `armedAt` renders exactly as it does on `main`.
8. On a 390px viewport the conversation stream shows more messages than it does
   on `main`; scrolling to the bottom reveals the Upcoming block; scrolling up
   removes it from view entirely.
9. The "New messages" pill still appears on an inbound message while scrolled
   up and dismisses on scroll to bottom, with an Upcoming block present.
10. Both Upcoming buckets (contact and group thread) stop returning rungs from a
    superseded ladder, because those rows no longer exist.

## 7. Risks

- **R1 - deletion is irreversible.** The `attribute_not_exists(sentAt)`
  condition must be on the DELETE itself, never a read-then-delete check.
- **R2 - the claim guards are the load-bearing half.** Shipping the sweep
  without `attribute_exists(reminderId)` on the three claim paths is worse than
  shipping nothing: it turns a blocked rung into a sent one.
- **R3 - the sweep widens what `cancelForTour` did.** It now also removes
  operator-canceled and skipped rows. Any test asserting a canceled row remains
  visible after a reschedule now encodes the OLD contract.
- **R4 - `listByTour` is an eventually-consistent GSI query.** D1 makes
  staleness user-visible for the first time: an immediate re-read can still
  return a deleted row. The panel's existing `scheduled.updated` refetch and
  dueAt anchor converge it; no design change, but a live-QA watch item.
- **R5 - `listByTour` is unpaginated.** Both the sweep and the read partition
  inherit that. Five rungs per generation puts the 1MB page hundreds of
  reschedules away, but this repo has shipped this exact class of bug before.
- **R6 - scroll semantics.** Moving a block inside the scroller passes unit
  tests and fails in the hand. Live QA on a phone viewport is required.
- **R7 - a terminal tour's panel can go empty.** A canceled tour that never sent
  a rung now reads "No reminders armed." where it used to list the struck-through
  ladder. That is the intended consequence of D1, stated here so it is not
  discovered as a regression.
