# Tour reminder supersession + Upcoming placement - design

Date: 2026-09-01
Branch: `feat/tour-reminder-supersession` (cut from `main` @f27aabbf)
Status: FINAL DRAFT after spec review rounds 1-4 (69 findings, 65 accepted).
Doc review is at its four-round cap. Adjudications at
`docs/superpowers/reviews/2026-09-01-tour-reminder-supersession/adjudications.md`

D1 (hard delete) was re-affirmed by the founder at the end of round 3, with the
enforcement surface below priced in.

## 1. Problem

**P1 - dead reminder rungs pile up.** Rescheduling or canceling a tour does not
retire its reminder ladder; it STAMPS every pending rung `canceledAt`
(`routes/tours.ts` -> `cancelTourReminders` -> `tourRemindersRepo.cancelForTour`)
and arms a fresh ladder alongside it. `listByTour` returns every row ever
written for the tour, so the Reminders panel grows by a full dead ladder per
reschedule.

**P2 - the Upcoming block eats the phone.** The pinned
`<section class=upcoming>` is a flex sibling of `.streamWrap`, between the
scrolling stream and the composer. Under 767.98px it holds
`min-height: 2.5rem; max-height: 7rem` out of a roughly 400px column, so two or
three messages remain visible and the block is on screen whether the operator is
looking at it or not.

## 2. Decisions

- **D1 - supersession DELETES.** On reschedule, on the terminal status
  transitions, and on tour-to-placement conversion, the superseded ladder's
  never-sent rungs are hard-deleted - pending, operator-canceled and skipped
  alike. Only rows carrying `sentAt` survive.
- **D2 - sent rungs survive in storage, not in the default view.**
- **D3 - the generation pointer lives on the TOUR.** Each arm call mints a
  `ladderId` (UUID) stamped on every row it writes; the tour carries
  `currentLadderId`. Current ladder = rows matching the pointer. A cleared
  pointer means the tour has no current ladder and nothing of its may send.
- **D3a - the CALLER owns the pointer write.** `armTourReminders` mints the
  `ladderId`, stamps its rows, and returns `{ ladderId, rows }` - `ladderId`
  present whenever at least one row was written, `null` when the arm produced
  none, so the caller writes a pointer only when a ladder actually exists.
  `ArmTourRemindersDeps` gains no `toursRepo`. (Round 4 corrected my cost
  estimate for the alternative - it is roughly 17 call sites, not 25 - but the
  decision stands on shape, not count: the armer has no business writing the
  tour row, and `lib/seed/live.ts` has no repo to thread.)
- **D4 - the Upcoming block moves inside the scroll, at every width**, with
  "at the bottom" continuing to mean the newest MESSAGE is at the bottom.

## 3. Behavior

### 3.1 Arm time

`armTourReminders` mints one `ladderId` per CALL and stamps it on every row that
call creates, rows born already-skipped included. A UUID rather than a timestamp
because `routes/tours.ts:251` takes an injectable `deps.now` and the app suite
injects a constant (`ARM_NOW`, `toursApi.test.ts:1228`), so two arms inside one
test share an instant.

### 3.2 Ordering

The pointer is what makes a rung claimable, so it clears FIRST and is written
LAST.

**Reschedule / revival** (`routes/tours.ts`, `armable && rearmTrigger`):

1. `currentLadderId: null` rides the patch ALREADY being written at
   `routes/tours.ts:1164` - not a separate write. A separate clear would leave a
   window in which the NEW `scheduledAt` is stored against the OLD pointer, and
   it costs an extra round trip for nothing.
2. Sweep (delete every row with no `sentAt`).
3. Arm.
4. Write the returned `ladderId` to the tour, or leave the pointer null if the
   arm produced no rows.

**Terminal transitions** (`canceled` / `closed` / `toured` / `no_show`) run
steps 1-2 and stop: a terminal tour has no current ladder.

**Conversion** (`routes/placements.ts:716`): capture the existing pointer, then
clear it BEFORE `placements.create`. Clearing disarms the ladder immediately and
REVERSIBLY - the poll refuses every rung the moment the pointer is gone - so
both existing compensation paths can restore it. **The sweep runs only after the
FINALIZE succeeds**, not merely after `create`: `placements.ts:757-773` shows a
finalize failure releasing the claim and rethrowing with the tour left
`scheduled` and retryable by design, and a swept ladder at that point is exactly
the silently-disarmed tour this ordering exists to prevent. A failed pointer
restore takes the posture its sibling already uses at `placements.ts:759-767` -
log at error with the tourId, do not mask the original error.

**Interruption posture.** A failure at step 3 or 4 leaves a live `scheduled`
tour with no rungs and no pointer - disarmed, not merely unsent. That is not
"safe by construction"; it is safe only because nothing FIRES. It must be logged
at error with the tourId, and the next PATCH that touches the tour re-arms it.
Stated so it is diagnosed rather than discovered.

### 3.3 What refuses a superseded rung

A rung whose `ladderId` does not match its tour's `currentLadderId` - including
every rung of a tour whose pointer is cleared - is refused by:

- `runDueTourReminders`, which retires it with a claim-skip carrying a new
  `ReminderSkipReason` token `superseded`.
- `forceSendReminder`, the human "Send now" path, which refuses with 409. It is
  a separate entry point from the poll; without this it is a live button that
  force-sends a superseded reminder.

**`superseded` needs FOUR copy/type surfaces, and only two are typecheck-forced.**
The `ReminderSkipReason` union and the exhaustive `REMINDER_SKIP_REASON_LABELS`
map will fail the build if the token is missing. The other two will NOT:
`ScheduledSuppressionReason` and its non-exhaustive `suppressionLead`, and
`SEND_NOW_ERROR_COPY`, which is `Record<string, string>` read through a `??`
fallback (`dashboard/src/api/types.ts:1327`, `:1379`) - a missing entry renders
the generic retry sentence instead of the truth, silently and green.

**The claim guards.** `claimSend`, `claimSkip` and `cancel` are `UpdateCommand`s
conditioned only on `attribute_not_exists(...)`. DynamoDB's UpdateItem CREATES a
missing item, so against a swept row every one of those conditions HOLDS: the
claim succeeds, an attribute-only stub springs into existence with no `tourId`,
`kind` or `dueAt`, and the poll sends. Each gains
`attribute_exists(reminderId)`. `uncancel` already requires
`attribute_exists(canceledAt)`. Precedent in-repo:
`app/scripts/retire-paused-tour-reminders.ts:205-207`.

**The three PREVIEW surfaces must agree.** `routes/tourReminders.ts` (the
panel), `routes/contactTimeline.ts:981` (contact Upcoming) and
`routes/relayGroups.ts:226` (group Upcoming) each render a pending rung as a
promise that it will send. A pointer-mismatched rung is a promise the send paths
refuse, and because `listDue` only picks rows up at `dueAt <= now` the lie would
stand until the rung came due - not until the next tick. All three render such a
rung as suppressed `superseded`, never as upcoming.

### 3.4 Read grouping

A row is CURRENT when its `ladderId` matches the tour's `currentLadderId`, or
when the tour has NO pointer and the row has NO `ladderId` (a wholly
pre-migration tour). Every other row is EARLIER.

- `reminders[]` keeps its meaning and shape: the current ladder, and it alone
  feeds `next`.
- `earlier[]` is new: surviving rungs of previous generations, newest first.

`earlier[]` is NOT guaranteed to hold only sent rows - a lost sweep delete
leaves an unsent superseded rung behind.

**`earlier[]`'s actions are allowlisted BY STATE, not inherited.** The
current-ladder renderer keys off `state`, so an inherited action list would put
**Send now** on an unsent earlier rung (`RemindersPanel.tsx:397` renders it for
any `upcoming` rung) and **Restore** on a canceled one (`:408`), which would
resurrect a rung into a ladder that no longer exists. Therefore, in `earlier[]`:

| state | actions |
| --- | --- |
| sent | none |
| upcoming (a sweep miss) | Cancel only |
| canceled | none - Restore is meaningless here |
| skipped | none |

Cancel on a sweep-missed rung is the operator's remedy of last resort. Note it
cannot win against a rung the poll already claim-skipped `superseded`: the
repo's cancel condition requires `attribute_not_exists(skippedAt)`
(`tourRemindersRepo.ts:361`), which is correct - the rung is already retired -
and the refetch reports the honest state.

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
`max-height`, `overflow-y` and `flex` rules go away - a capped block with its own
scrollbar inside the stream's scrollbar is a nested scroller, and the cap is
unnecessary once the anchoring is right.

**One boolean cannot drive this. Today `atBottomRef` feeds BOTH the pin
(`Timeline.tsx:1911`) and the pill (`:1914`), and once content exists below the
last message those two gates want different answers**: read "at bottom" strictly
against the last message and an operator standing on the Upcoming block is "not
at bottom", so every arriving item lights the pill permanently; read it loosely
so the block counts as bottom and the pin fires, yanking that operator back to
the last message. The single flag is replaced by a three-valued ANCHOR, derived
on scroll from a sentinel element placed after the last cluster and before the
Upcoming section:

| anchor | when | on growth |
| --- | --- | --- |
| `sentinel` | the sentinel's bottom is within 48px of the viewport bottom | scroll the sentinel back to the bottom edge |
| `below` | the operator has scrolled PAST the sentinel (on the block) | preserve distance from the scroller's true bottom |
| `null` | scrolled up, above the sentinel | do not scroll; light the pill if the stream grew |

The pill lights only on `null`. The pin never fires on `null`. An operator
reading the block is `below`, which is anchored but not yanked. "Jump to newest"
targets the sentinel, not the container bottom.

**The re-pin signal must track HEIGHT.** The effect's deps are
`[clusters, resetScrollKey, paging?.olderPagesLoaded]` (`:1920`); an ids/length
key is insensitive to the block's rendered height, which is what the anchor
depends on - a body wrapping to a second line moves it with no key change. A
`ResizeObserver` on the Upcoming block supplies it. The array itself must never
be a dep: `GroupTextView.tsx:451` passes a fresh `[]` literal every render. The
observer covers the BLOCK only; `clusters` keeps its existing key, which is
pre-existing behavior and out of scope here.

`.stream` sets `overflow-anchor: none` (module CSS :142), so the browser will
not compensate on its own. The "New messages" pill is positioned against
`.streamWrap`, untouched by this move.

## 4. Surfaces

**Writers of reminder rows**: `armTourReminders` (create); the sweep (3.2, at
three sites - and note conversion splits into a pointer clear and a later sweep
at two points in an ordered compensation, so it is one call SITE but two
operations); `claimSend` / `claimSkip`; `cancel` / `uncancel`; the seed builders
under `app/src/lib/seed/`; the dev tick routes;
`app/scripts/retire-paused-tour-reminders.ts` (already guarded - the precedent,
not a victim). Seeds must stamp ONE `ladderId` per seeded ladder and set the
tour pointer to it: `matrix.ts` builds raw rows for a same-tour sent
`confirmation` plus pending `day_before`, and a partial stamp would split every
seeded ladder across the disclosure.

**Writers of the tour row**: `currentLadderId`, written by the CALLER (D3a).
`routes/tours.ts:1164` captures the tour BEFORE the reminder side effects and
`:1285` returns it, so the PATCH response would omit a `currentLadderId` the
same request wrote - the returned object must carry it.

**Readers**: `listByTour` at `routes/contactTimeline.ts:981`,
`routes/relayGroups.ts:226`, `jobs/tourReminders.ts:1618`, and FIVE sites in
`routes/tourReminders.ts`; plus `listDue` in the poll. Two of the five (`:395`,
`:462`) end in `.find(...)!` on a post-write re-read - `undefined` reaching a
view composer once rows can vanish - so both return an honest 404, and the 404
path must still emit `scheduled.updated` (`:416`) when the write itself won.

**Client render sites**: `RemindersPanel`; `Timeline.tsx` for both Upcoming
buckets - the single render site behind the contact comms tab,
`ConversationDetail`, `GroupTextView`, and the tour and placement conversation
views.

**Tests encoding contracts this change breaks** (re-point, do not delete):
`e2e/tests/scenarios/scheduled-visibility.spec.ts:268`;
`e2e/scenarios/steps.ts:3615-3661`;
`dashboard/src/routes/contact/Timeline.test.tsx:1375-1481`. jsdom performs no
layout, so the anchor cannot be proven at the unit layer: unit tests cover the
anchor DERIVATION as a pure function, and the anchoring itself is an e2e
assertion in a real browser. Four e2e sites resolve the Upcoming region by role
and name.

## 5. Non-goals

- No change to when rungs fire, what they say, or the quiet-hours clamp.
- No backfill of `ladderId` / `currentLadderId` (3.5).
- No change to per-rung actions on the CURRENT ladder.
- No mobile-only layout branch.
- No pagination work on `listByTour` (R5).
- No change to `clusters`' existing dep key (3.6).

## 6. Acceptance

1. After two reschedules the current ladder holds exactly one generation and the
   superseded unsent rows are GONE from the table, not merely filtered.
2. A rung the poll claims between the sweep's list and its delete survives and
   reads as sent. Proven at the REPO layer against DynamoDB Local: the in-memory
   fake returns `false` on a missing row, which is correct POST-guard behavior
   and cannot express the pre-guard defect.
3. A rung deleted by the sweep and then reached by `claimSend` does NOT
   resurrect and does NOT send.
4. A rung the sweep failed to delete is refused by the poll (claim-skipped
   `superseded`) AND by Send now (409 with its OWN copy, not the generic retry
   sentence), and appears in `earlier[]` with Cancel and no other action.
5. All three preview surfaces render a pointer-mismatched pending rung as
   suppressed `superseded` before its `dueAt` arrives.
6. A terminal transition clears the pointer; the current ladder is empty and
   every survivor reads as earlier. Reviving to `scheduled` arms a NEW ladder
   that adopts no earlier rung.
7. A conversion whose `placements.create` OR whose FINALIZE fails leaves the
   tour with its ladder intact and its pointer restored - still armed.
8. A hand-canceled rung disappears on the next reschedule; PATCH against a
   deleted rung returns 404, not 500, and still emits `scheduled.updated` when
   the write won.
9. The disclosure renders when the current ladder is EMPTY, and a canceled
   earlier rung offers no Restore.
10. An earlier rung with no `sentBody` shows no body.
11. A tour with no pointer and no stamped rows renders, and polls, exactly as on
    `main`.
12. On a 390px viewport, in a thread whose messages OVERFLOW the stream, at rest
    the view shows more messages than `main` and no Upcoming block; scrolling
    down reveals it; scrolling up removes it. (A thread shorter than the
    viewport has nothing to scroll and shows the block - correct.)
13. An operator standing on the Upcoming block when a new message arrives is NOT
    scrolled back to the last message, AND the "New messages" pill does not
    light. An operator scrolled ABOVE the sentinel gets the pill and no jump.
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
  no transaction. The 3.2 ordering bounds every interruption to "disarmed",
  which fires nothing but is a real state needing a loud log.
- **R5 - `listByTour` is unpaginated**; the sweep and the read partition inherit
  it. The pointer check lowers a missed row's consequence from "sends" to
  "appears in earlier".
- **R6 - scroll semantics.** Passes unit tests, fails in the hand. Live QA on a
  phone viewport is required, and the three-anchor model is the part to drive by
  hand first.
- **R7 - a terminal tour's panel can go empty.** Intended consequence of D1.
