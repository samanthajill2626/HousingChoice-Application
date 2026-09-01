# Tour reminder supersession + Upcoming placement - design

Date: 2026-09-01
Branch: `feat/tour-reminder-supersession` (cut from `main` @f27aabbf)
Status: FINAL DRAFT after five review rounds (80 findings, 76 accepted).
Round 5 was a fresh cold reviewer at the founder's request, after the four-round
cap; it found a blocking defect the four prior rounds missed. Adjudications at
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
- **D3 - the generation pointer lives on the TOUR, and is NEVER removed.** Each
  arm call mints a `ladderId` (UUID) stamped on every row it writes; the tour
  carries `currentLadderId`. Current ladder = rows matching the pointer.
  "This tour has no live ladder" is expressed by ROTATING the pointer to a fresh
  UUID that no row carries - never by clearing it. `toursRepo.patch` maps an
  explicit null to REMOVE (`toursRepo.ts:333`), so a cleared pointer would be
  byte-identical to a never-migrated one, and the pre-migration rules in 3.5
  would then re-adopt a terminal tour's legacy rows as current and let a
  sweep-miss send. ABSENT means pre-migration, permanently and only.
- **D3a - the CALLER owns the pointer write.** `armTourReminders` mints the
  `ladderId`, stamps its rows, and returns `{ ladderId, rows }` - `ladderId`
  present whenever at least one row was written, `null` when the arm produced
  none. `ArmTourRemindersDeps` gains no `toursRepo`.
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

**Tour CREATE** (`POST /api/tours` with a `scheduledAt`): arm, then write the
returned `ladderId`. The 201 must return the POST-arm tour - the same
stale-pointer defect called out for PATCH below applies here and is easy to miss
because this path has no sweep.

**Reschedule / revival** (`routes/tours.ts`, `armable && rearmTrigger`):

1. Rotate `currentLadderId` to a fresh unmatched UUID, riding the patch ALREADY
   being written at `routes/tours.ts:1164` - not a separate write. A separate
   rotation would leave a window in which the NEW `scheduledAt` is stored
   against the OLD pointer, and costs a round trip for nothing.
2. Sweep (delete every row with no `sentAt`).
3. Arm.
4. Write the returned `ladderId`, CONDITIONAL on `currentLadderId` still holding
   the rotation value from step 1. Two concurrent reschedules can otherwise
   interleave so that the pointer names a ladder the other request already
   swept: two 200s, a silently disarmed tour, no error. The loser logs at error
   and leaves the winner's pointer; its rows are unpointed, refused by 3.3, and
   visible in `earlier[]` until the next sweep.

**Terminal transitions** (`canceled` / `closed` / `toured` / `no_show`) run
steps 1-2 and stop: the rotated pointer matches nothing, so the tour has no live
ladder.

**Conversion** (`routes/placements.ts:716`) does NOT touch the pointer. The tour
already carries a reversible in-flight marker - the conversion claim sentinel
written by `claimConversion` and undone by `releaseConversionClaim` - and 3.3
makes the poll DEFER every rung of a claim-in-flight tour: left unclaimed, no
skip stamp, no delete. The sweep runs only after the FINALIZE succeeds
(`placements.ts:757-773` shows a finalize failure releasing the claim and
rethrowing with the tour left `scheduled` and retryable by design; sweeping
before it is exactly the silently-disarmed tour this ordering prevents).
Deferral, not a claim-skip, is what makes this reversible: `skippedAt` is
terminal (`tourRemindersRepo.ts:361`), so a rung retired during the window could
never come back when the claim is released. The deferral is bounded - the claim
either finalizes (the sweep removes the rungs) or is released (the rungs
resume) - so nothing re-lists forever.

**Interruption posture.** A failure at step 3 or 4 leaves a live `scheduled`
tour whose pointer matches nothing - disarmed, not merely unsent. That is not
"safe by construction"; it is safe only because nothing FIRES. It must be logged
at error with the tourId. Note that the NEXT patch does not necessarily repair
it: only a `scheduledAt` change or an explicit move into `scheduled` re-arms
(`tours.ts:1181-1189`), so a status-only patch to another value leaves it
disarmed.

### 3.3 What refuses a superseded rung

A rung whose `ladderId` does not match its tour's `currentLadderId` is REFUSED:

- `runDueTourReminders` retires it with a claim-skip carrying a new
  `ReminderSkipReason` token `superseded`.
- `forceSendReminder`, the human "Send now" path, refuses with 409. It is a
  separate entry point from the poll; without this it is a live button that
  force-sends a superseded reminder.

A rung of a tour with a CONVERSION CLAIM in flight is DEFERRED instead: left
unclaimed, no stamp, retried on the next tick (3.2).

**Copy and type surfaces for `superseded` - the count matters because only some
break the build.** Exhaustive maps that WILL fail typecheck if the token is
missing: the reminder skip-reason labels, the placement-nudge card's map, and
`ScheduledCard`'s `SUPPRESSION_COPY`. Surfaces that will NOT: the dashboard's
hand-mirrored copy of the reason union (an app-side-only addition compiles green
and renders the raw snake_case token to staff), and `SEND_NOW_ERROR_COPY`, which
is `Record<string, string>` read through a `??` fallback
(`dashboard/src/api/types.ts:1327`, `:1379`) - a missing entry silently renders
the generic retry sentence instead of the truth. The plan must treat the
non-forced ones as explicit tasks, because green is not evidence there.

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
rung as suppressed `superseded`, never as upcoming. This applies to a rung the
sweep MISSED; a rung the sweep deleted is simply absent.

### 3.4 Read grouping

A row is CURRENT when its `ladderId` matches the tour's `currentLadderId`, or
when the tour has NO `currentLadderId` attribute at all AND the row has no
`ladderId` (a wholly pre-migration tour - 3.5). Every other row is EARLIER.

- `reminders[]` keeps its meaning and shape: the current ladder, and it alone
  feeds `next`.
- `earlier[]` is new: surviving rungs of previous generations, ordered by
  `sentAt ?? dueAt` DESCENDING with `reminderId` as the tie-break. It cannot be
  ordered by `ladderId` (a UUID, by D3's own argument) and `createdAt` ties
  within one arm call.

`earlier[]` is NOT guaranteed to hold only sent rows - a lost sweep delete, or a
lost step-4 conditional (3.2), leaves unsent rows there.

**`earlier[]`'s actions are allowlisted BY STATE, not inherited.** The
current-ladder renderer keys off `state`, so an inherited action list would put
**Send now** on an unsent earlier rung (`RemindersPanel.tsx:397` renders it for
any `upcoming` rung) and **Restore** on a canceled one (`:408`), which would
resurrect a rung into a ladder that no longer exists.

| state | actions |
| --- | --- |
| sent | none |
| upcoming (a sweep miss) | Cancel only |
| canceled | none - Restore is meaningless here |
| skipped | none |

Cancel on a sweep-missed rung is the operator's remedy of last resort. It cannot
win against a rung the poll already claim-skipped `superseded`, because the
repo's cancel condition requires `attribute_not_exists(skippedAt)`
(`tourRemindersRepo.ts:361`) - correct, the rung is already retired, and the
refetch reports the honest state.

**The disclosure's slot sits OUTSIDE the empty-ladder short-circuit.**
`RemindersPanel.tsx:346` returns "No reminders armed." on an empty
`reminders[]`; a terminal tour is exactly that state with a non-empty
`earlier[]`.

**An earlier rung with no `sentBody` renders no body** - those rows predate the
snapshot field and compose LIVE, which for a superseded generation means
composing against the tour's CURRENT time.

### 3.5 Pre-migration rows

A tour with NO `currentLadderId` attribute and rows with no `ladderId` renders,
and polls, exactly as today. Because the pointer is rotated rather than removed
(D3), this state is reachable only by never having armed since the deploy - it
is not something a terminal transition can manufacture. The first arm writes a
pointer and a stamped ladder, after which legacy rows sort as EARLIER. No
backfill.

### 3.6 Upcoming placement

The `<section class=upcoming>` moves from a sibling of `.streamWrap` to the last
child INSIDE `.stream`, keeping its heading, list and `aria-label`. Its
`max-height`, `overflow-y` and `flex` rules go away - a capped block with its own
scrollbar inside the stream's scrollbar is a nested scroller, and the cap is
unnecessary once the anchoring is right.

**One boolean cannot drive this.** `atBottomRef` today gates BOTH the pin
(`Timeline.tsx:1911`) and the pill (`:1914`), and once content exists below the
last message those gates want opposite answers: strict reading lights the pill
permanently for an operator standing on the block; loose reading fires the pin
and yanks them off it. The flag is replaced by a three-valued ANCHOR derived on
scroll from a sentinel element placed after the last cluster and before the
Upcoming section:

| anchor | when | on growth |
| --- | --- | --- |
| `sentinel` | the sentinel's bottom is at or below the viewport bottom, within 48px | scroll the sentinel back to the bottom edge |
| `below` | the sentinel's bottom is ABOVE the viewport bottom by any amount - the operator is on the block | preserve distance from the scroller's true bottom |
| `null` | scrolled up: the sentinel is below the viewport bottom by more than 48px | do not scroll; light the pill if the stream grew |

`below` is defined by direction, not by slack, so it stays reachable when the
block is shorter than 48px. The pill lights only on `null`; the pin never fires
on `null`.

**Every scroll WRITER must be converted, not just the growth pin.** The spec's
earlier drafts specified one of five:

- the growth pin (`:1911`) - anchor-driven, per the table above;
- the conversation-switch reset (`:1890`, `scrollTop = scrollHeight`) - must
  target the SENTINEL, or every thread opens scrolled onto the Upcoming block
  and acceptance 12 fails on open;
- the post-send pin (`:1976`) - same, targets the sentinel;
- the pill-clear condition (`:1853`) - clears on `sentinel` or `below`, not on
  true-bottom;
- the prepend restore (`:1900`) - anchored to prepended height, unaffected, and
  must stay that way.

**The re-pin signal must track HEIGHT.** The effect's deps are
`[clusters, resetScrollKey, paging?.olderPagesLoaded]` (`:1920`); an ids/length
key is insensitive to the block's rendered height, which is what the anchor
depends on - a body wrapping to a second line moves it with no key change. A
`ResizeObserver` on the Upcoming block supplies it. The array itself must never
be a dep: `GroupTextView.tsx:451` passes a fresh `[]` literal every render. The
observer covers the BLOCK only; `clusters` keeps its existing key, which is
pre-existing behavior and out of scope.

`.stream` sets `overflow-anchor: none` (module CSS :142), so the browser will
not compensate on its own. The "New messages" pill is positioned against
`.streamWrap`, untouched by this move.

## 4. Surfaces

**Writers of reminder rows**: `armTourReminders` (create); the sweep (3.2);
`claimSend` / `claimSkip`; `cancel` / `uncancel`; the seed builders under
`app/src/lib/seed/`; the dev tick routes;
`app/scripts/retire-paused-tour-reminders.ts` (already guarded - the precedent,
not a victim).

**Seeds are a first-class surface, not a footnote.** `lib/seed/live.ts` arms
through the REAL armer, which will now stamp every row, but nothing there writes
a tour pointer - so every demo-world ladder would be born refused. It writes its
tour rows directly, so it sets `currentLadderId` inline from the armer's return.
`matrix.ts` builds RAW rows for a same-tour sent `confirmation` plus pending
`day_before`; a partial stamp splits every seeded ladder across the disclosure,
so it stamps one `ladderId` per seeded ladder and sets the pointer to it.

**Writers of the tour row**: `currentLadderId`, written by the CALLER (D3a) on
create, on re-arm, and rotated on terminal transitions. `routes/tours.ts:1164`
captures the tour BEFORE the reminder side effects and `:1285` returns it, so
the PATCH response would omit a `currentLadderId` the same request wrote; the
CREATE path has the identical defect on its 201. Both returned objects must
carry the post-arm pointer.

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
4. FIXTURE A (sweep miss): a superseded rung still present is refused by the
   poll (claim-skipped `superseded`) AND by Send now (409 with its OWN copy, not
   the generic retry sentence); all three preview surfaces render it suppressed
   `superseded` before its `dueAt`; it appears in `earlier[]` with Cancel and no
   other action.
5. FIXTURE B (clean sweep): both Upcoming buckets return nothing for the
   superseded ladder, because the rows are gone.
6. A terminal transition rotates the pointer; the current ladder is empty, every
   survivor reads as earlier, and a legacy row on that tour does NOT re-adopt as
   current. Reviving to `scheduled` arms a NEW ladder that adopts no earlier
   rung.
7. A conversion whose `placements.create` OR whose FINALIZE fails leaves the
   tour still armed, with every rung intact and NONE of them stamped
   `superseded` - a rung due during the claim window is deferred, not retired.
8. Two concurrent reschedules leave the tour pointing at a ladder that exists;
   the loser logs at error and strands no pointer at a swept generation.
9. A hand-canceled rung disappears on the next reschedule; PATCH against a
   deleted rung returns 404, not 500, and still emits `scheduled.updated` when
   the write won.
10. The disclosure renders when the current ladder is EMPTY, and a canceled
    earlier rung offers no Restore.
11. An earlier rung with no `sentBody` shows no body.
12. A tour with no pointer attribute and no stamped rows renders, and polls,
    exactly as on `main`.
13. Opening a conversation lands on the newest MESSAGE, not on the Upcoming
    block; the same after sending a message.
14. On a 390px viewport, in a thread whose messages OVERFLOW the stream, at rest
    the view shows more messages than `main` and no Upcoming block; scrolling
    down reveals it; scrolling up removes it. (A thread shorter than the
    viewport has nothing to scroll and shows the block - correct.)
15. An operator standing on the Upcoming block when a new message arrives is NOT
    scrolled back to the last message, AND the pill does not light - including
    when the block is shorter than 48px. An operator scrolled ABOVE the sentinel
    gets the pill and no jump.
16. The pill still appears on an inbound message while scrolled up and dismisses
    on scroll to bottom, in a contact thread and in a relay-group thread through
    `ConversationDetail` (`GroupTextView` passes `upcoming={[]}` and cannot
    exercise it).
17. The demo seed world (`lib/seed/live.ts`) arms ladders that are LIVE, not
    born refused.

## 7. Risks

- **R1 - deletion is irreversible.** The `attribute_not_exists(sentAt)`
  condition belongs on the DELETE, never a read-then-delete check.
- **R2 - the guards and checks are the load-bearing half.** Sweep without them
  and a blocked rung becomes a sent one.
- **R3 - the sweep widens what `cancelForTour` did**, so any test asserting a
  canceled row survives a reschedule encodes the OLD contract.
- **R4 - two writes, one invariant.** Pointer and rows are separate writes with
  no transaction. The 3.2 ordering and the step-4 condition bound every
  interruption and every race to "disarmed", which fires nothing but is a real
  state needing a loud log.
- **R5 - `listByTour` is unpaginated**; the sweep and the read partition inherit
  it. The pointer check lowers a missed row's consequence from "sends" to
  "appears in earlier".
- **R6 - scroll semantics.** Passes unit tests, fails in the hand. Live QA on a
  phone viewport is required, and the three-anchor model across all five scroll
  writers is the part to drive by hand first.
- **R7 - a terminal tour's panel can go empty.** Intended consequence of D1.
