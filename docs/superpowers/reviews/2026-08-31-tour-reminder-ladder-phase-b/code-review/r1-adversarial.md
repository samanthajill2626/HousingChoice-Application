# Reviewer B - adversarial, fresh eyes (read-only)

Branch `feat/tour-reminder-ladder-phase-b`, merge-base `ec32170a`. Input: the
diff package plus full read of the branch working tree. No Playwright, no
suites run; every claim below is anchored at `file:line` in the BRANCH TREE
(not the diff package) and was derived by reading the code, not the spec.

Counts: BLOCKING 0, MUST-FIX 2, SHOULD 6, NOTE 6.

The change is unusually careful, and I want that on the record before the
findings. The past-tour gate, the two-set split (MANUAL_ONLY vs DISCONTINUED),
the single-pass `interpolate`, the sweep's conditional writes and its shared
predicate with the runtime are all correct as written, and I could not break the
send-path concurrency: `claimSend`, `claimSkip` and the sweep's `UpdateCommand`
carry the same no-terminal condition, so overlapping poll ticks, a sweep racing
the poll, and Send-now racing the poll each resolve to exactly one outcome. A
list of what I checked and cleared is at the bottom so it is not redone.

---

## MUST-FIX

### MF1 - the owner-routed tour intro has no PAST-TOUR guard, so a relay group opened on (or deferred past) a tour that already happened texts the tenant and the landlord to attend it

**Claim.** `resolveRelayComposeInputs` asks only "is the tour TODAY", never "has
the tour already started". A tour-owned group whose `scheduledAt` is in the past
still composes a tour variant, so the tenant and the property contact receive
`Hey Alicia! Putting you in a group text with Marcus to tour 412 Oak St at 9:00
AM. ... Please let us know when you're on the way.` for a tour that ran hours or
days earlier. This is the exact staleness class the same branch judged serious
enough to add a runtime gate for on the reminder ladder.

**Evidence.**
- `app/src/jobs/relayFanOut.ts:445` - the only time test is
  `localDateOf(nowIso, timezone) === localDateOf(scheduledAt, timezone)`. A
  same-day PAST tour takes `tour_today` (`:446`); any other past day takes the
  dated `tour` variant (`:451`). `scheduledAt` is read at `:370` and never
  compared to `nowIso`.
- `app/src/jobs/tourReminders.ts:172-186` `retiredByTourStart` - the predicate
  this branch added for precisely this reason, deliberately shared between the
  poll and the sweep so "the sweep and the runtime can never disagree". The
  relay composer is a third writer of tour-time copy and does not use it.
- `app/src/services/rosterProvision.ts:150-163` `tourOpenGuard` refuses only
  `canceled` / `closed` tours. A tour that has happened but whose exit gate is
  not yet filled is still `scheduled`, so `POST /api/tours/:tourId/relay`
  (`app/src/routes/tours.ts:1312`) accepts it, as does
  `GET /:tourId/roster/preview-open` (`app/src/routes/tours.ts:937`), which has
  no status or time guard at all.
- `app/src/messages/catalog.ts:346-368` - both tour defaults end "Please let us
  know when you're on the way", which is what makes a past-tour render actively
  confusing rather than merely stale.

**Reproduce / the interleaving.** Two paths, one manual and one fully automatic:
1. Manual: a `scheduled` tour whose `scheduledAt` is yesterday (outcome not yet
   recorded). Operator opens the relay group from TourDetail. `getOwner` ->
   `{type:'tour'}` -> `resolveRelayComposeInputs` -> `variant:'tour'` ->
   `relay.intro_tour` with `{when}` = yesterday's date.
2. Automatic, no operator error: operator clicks Open at 23:00 for a tour at
   07:00 the next morning. Inside quiet hours the route does NOT open - it
   writes a pending roster action due at quiet-end
   (`app/src/routes/tours.ts:1373-1394`, `dueAt = clampOutOfQuietHours(...)`,
   202 response). The apply runs at 08:00 and the intro job composes at 08:00,
   with `nowIso` now past `scheduledAt`. The tenant and the landlord get "to
   tour X at 7:00 AM ... let us know when you're on the way" an hour after the
   tour started.

**Why not BLOCKING.** Nothing is misdirected and no data is lost; it is wrong
copy on a path that needs either an unusual operator action or a deferral that
straddles the tour. It is above SHOULD because path 2 needs no mistake by
anyone and lands on a real tenant.

**Proposed fix.** In `resolveRelayComposeInputs`, treat a past `scheduledAt`
exactly as an absent one - after `app/src/jobs/relayFanOut.ts:370`, drop it when
`Date.parse(scheduledAt) <= Date.parse(nowIso)`, and the existing `:441` branch
already routes it to `variant:'naked'`.

---

### MF2 - `next` (the panel's "Next" highlight) is still handed to a DISCONTINUED rung, so the reminders panel points at a row it simultaneously labels "No longer sent"

**Claim.** The list route picks `next` as the earliest `upcoming` rung with no
discontinued exclusion. A pause-era `confirmation` has `dueAt` = the BOOKING
instant (`app/src/jobs/tourReminders.ts:125-126`, `case 'confirmation': return
now`), i.e. always the earliest rung on the ladder, and it is still `upcoming`
(no terminal marker) until the sweep runs. So on every tour booked during the
2026-08-20..08-31 pause whose tour is still ahead, the panel puts the "Next"
tag and `aria-current="step"` on a row whose chip reads "No longer sent".

**Evidence.**
- `app/src/routes/tourReminders.ts:671` -
  `const next = reminderViews.find((v) => v.state === 'upcoming');`, over an
  array just sorted ascending by `dueAt`. The `discontinued` short-circuit
  thirty lines earlier (`:633-646`) touches `suppression` only.
- `dashboard/src/routes/tours/RemindersPanel.tsx:197` takes `nextId` from
  `page.next?.reminderId`; `:331` derives `isNext`; `:350`, `:351` and `:359`
  apply `styles.next`, `aria-current="step"` and the "Next" tag.
- `dashboard/src/routes/tours/RemindersPanel.tsx:116` renders "No longer sent"
  on that same row.
- `dashboard/src/api/types.ts:1260` documents `next` as "The next reminder due
  to fire (highlight it in the UI)".

**Reproduce / the assertion that would catch it.**
`app/test/tourRemindersApi.test.ts:164` pins `next = earliest upcoming`, and
`:259` pins that a SKIPPED rung is excluded from `next` - there is no case for a
discontinued-but-pending one. Add to that suite: seed a pending `confirmation`
at `dueAt: '2026-08-20T09:00:00Z'` plus a pending `day_before` at a later
`dueAt`, GET the ladder, and assert `expect(next?.kind).toBe('day_before')`
alongside `expect(reminders[0]!.suppression).toEqual({reason:'discontinued'})`.
Today the first assertion fails with `'confirmation'`.

**Why this matters beyond cosmetics.** `RUNBOOK.md:114` downgrades sweep-first
from a deadline to a preference on the grounds that sweeping first "means the
panel is honest from the first moment the new dashboard is live rather than a
poll tick later". A deploy that lands before the sweep is exactly the window in
which that sentence is false, so this defect contradicts the RUNBOOK's own
stated rationale for the relaxed ordering.

**Proposed fix.** One line at `app/src/routes/tourReminders.ts:671`:
`const next = reminderViews.find((v) => v.state === 'upcoming' &&
v.suppression?.reason !== 'discontinued');`

---

## SHOULD

### S1 - a discontinued rung still renders a live "Send now" button that can only 409

`dashboard/src/routes/tours/RemindersPanel.tsx:370` gates the button on
`rung.state === 'upcoming'` alone, and a discontinued rung IS upcoming, so the
button renders enabled. The server refuses it permanently
(`app/src/jobs/tourReminders.ts:1603`, `kind_retired`), and the dashboard even
ships copy for the refusal (`dashboard/src/api/types.ts:1367`). The panel's own
comment at `:112` ("'Paused' would invite exactly that refused click") shows the
intent was to STOP inviting the click: the chip changed, the affordance did not.
The existing test at
`dashboard/src/routes/tours/RemindersPanel.test.tsx:280` already builds the
fixture and asserts only the chip. Fix: gate the button on
`rung.state === 'upcoming' && rung.suppression?.reason !== 'discontinued'`, and
extend that test with `queryByRole('button', {name: /Send the/})`.

### S2 - the panel self-refetches every 20s FOREVER on a discontinued rung, and the branch's own new `overdue` flag is the signal that would stop it

`nextReminderRefetchDelay` returns `OVERDUE_POLL_MS` (20s -
`dashboard/src/routes/tours/RemindersPanel.tsx:52`) for ANY `upcoming` rung
whose `dueAt` is past (`:72`), on the assumption that the worker will flip it
within a poll or two. A discontinued rung never flips, so a tab left open on a
tour with a pause-era `confirmation` issues `GET /api/tours/:id/reminders` every
20 seconds indefinitely - a route that reads the tour, the unit, two contacts,
settings and the ladder per request. PRE-EXISTING (under the pause every
held-back rung did the same), but Phase B is the change that was meant to end
it, and it added exactly the server-side signal the timer needs (`overdue`,
`app/src/routes/tourReminders.ts:651`) and used it only for a chip. Fix: skip
rungs whose `suppression.reason === 'discontinued'` in the loop at `:64-69`.

### S3 - `uncancel`'s docblock now states two things the code no longer does

`app/src/repos/tourRemindersRepo.ts:170-171`: "A restored PAST-DUE rung fires on
the next poll tick (the panel shows 'sending shortly' - deliberate: an
un-canceled confirmation means 'send it after all')." Both halves are false
now: a `confirmation` can never fire by any path
(`app/src/jobs/tourReminders.ts:283` `DISCONTINUED_REMINDER_KINDS`, applied at
`:719` and `:1603`), and a restored past-due rung on a tour that has already
started is claim-skipped `tour_already_passed` rather than fired (`:1029-1036`).
This sits four lines below the branch's own additions in the same file, and the
"Restore" button is still offered on a canceled confirmation
(`dashboard/src/routes/tours/RemindersPanel.tsx:380`), which is how a reader
would act on it. Fix: rewrite the last sentence to name the two gates.

### S4 - "the preview cannot show a different intro than the one that goes out" is not true; the resolver is clock-dependent

`app/src/services/rosterEdits.ts:19-24` and the `buildOpenPreview` comment at
`:569-572` both assert the preview and the send cannot differ because they share
one resolver. They share the resolver but not the CLOCK: the variant is decided
from `nowIso` (`app/src/jobs/relayFanOut.ts:443-452`), which the preview takes
from `QuietHoursState` (`app/src/services/rosterEdits.ts:476`) and the job takes
from the wall clock at job time. Any gap between the two flips the variant when
it crosses org-local midnight, the tour start, or the "is it today" boundary -
and two such gaps are ordinary: a quiet-hours deferral to 08:00
(`app/src/routes/tours.ts:1373-1394`) and a `connecting` group waiting on
`relay.numberReady`. Concretely: preview at 23:00 for a tour tomorrow at 09:00
shows the dated `relay.intro_tour`; the deferred send at 08:00 emits
`relay.intro_tour_today`. Fix: weaken the two comments to "the same ENTRY SET,
resolved at send time" - threading the preview's `nowIso` into the job would
pin a variant that has genuinely gone stale, which is worse.

### S5 - the one-shot sweep aborts with NO partial report, and one malformed row aborts it

`app/scripts/retire-paused-tour-reminders.ts:184` re-throws anything that is not
a `ConditionalCheckFailedException`, and the throw escapes the paging loop. The
top-level handler at `:211-213` logs `{ err }` only - the accumulated `result`
is discarded - so an operator whose prod run dies at row 400 of 900 learns
neither how many rows were stamped nor with which tokens. Every write is
idempotent so a re-run repairs the DATA, but the RUNBOOK's step 2 ("read the
report before applying") and step 3's `skippedOnCondition` promise both
evaporate on the one run where they matter. The sibling script this same RUNBOOK
section documents does the opposite: `RUNBOOK.md:95` - "the run logs a
**PARTIAL** report (the counters as of the abort) before the error and exits 1".

Second half, the corrupt-row case the brief asks about: `tourFor(raw.tourId)`
(`app/scripts/retire-paused-tour-reminders.ts:120-127`, called at `:152`) runs
for every scanned row with no validation. A row with a missing or empty `tourId`
reaches `toursRepo.get(undefined)` (`app/src/repos/toursRepo.ts:266-268`), whose
`GetCommand` `Key: { tourId: undefined }` is marshalled by a client configured
`removeUndefinedValues: true` (`app/src/lib/dynamo.ts:87`) into an EMPTY key,
which DynamoDB rejects with `ValidationException` - aborting the whole sweep on
one bad row. There is deliberately no `FilterExpression` (`:153-155`), so every
row in the table is exposed to this.

Fix: wrap the per-row body in a try/catch that increments a `failed` counter and
continues, and log the counters from the top-level catch before `exitCode = 1`.

### S6 - the tour and placement intros are addressed to the TENANT by name but are sent verbatim to the landlord too

`sendRelayAnnouncement` sends ONE `body` to every roster member
(`app/src/services/relayAnnouncements.ts:279-284`; the new `bodyFor` selector is
supplied only by the member-added handler). So `relay.intro_tour_today`,
`relay.intro_tour` and `relay.intro_placement`
(`app/src/messages/catalog.ts:346-388`) reach the property contact as "Hey
Alicia! Putting you in a group text with Marcus to tour 412 Oak St ... Looking
forward to you seeing the property and meeting Marcus!" - where Marcus is the
reader, greeted as someone else and named in the third person, twice. This is a
CHANGE: the pre-Phase-B naked intro was audience-neutral ("You're now connected
with ..."), which is why nobody had to think about it before.
`docs/superpowers/reviews/2026-08-31-tour-reminder-ladder-phase-b/founder-handback-items.md`
item 2 flags the missing sender identity on these two entries and item 8 flags a
related "she only ever reviewed one form" gap, so the handback is the right
home. Fix: add it as a handback item (a landlord-facing read of the same copy),
not a code change - this is founder wording and hers to rule on.

---

## NOTE

- **N1 - the member-added persisted row is a body most recipients never got, and
  can be a body NOBODY got.** `app/src/jobs/relayFanOut.ts:1044-1066`: the
  persisted row and the inbox preview carry `newMemberBody` (the naked intro),
  while everyone except the joiner receives `groupBody`. Deliberate per spec
  9.6, but it also means the ADD confirm dialog previews one sentence
  (`app/src/services/rosterEdits.ts:725`) and the thread bubble shows another.
  Edge: if the joiner is removed from the roster between the add and the job,
  `added` is undefined (`:1029`) and `bodyFor` (`:1064`) matches no member - so
  every leg gets `groupBody` and the persisted body is a copy nobody received.
  The docblock at `:1027-1028` anticipates the raced remove, but only for the
  name fallback.
- **N2 - `DeadlinesNudgesCard`'s muted-tone test omits `discontinued`.**
  `dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:314-316` still tests
  only `quiet_hours` / `paused`, while its own chip branch at `:109` handles
  `discontinued` and both tour surfaces mute it
  (`dashboard/src/routes/tours/RemindersPanel.tsx:426-428`,
  `dashboard/src/routes/contact/ScheduledCard.tsx:127-128`). Unreachable today
  (no nudge writer emits it) - which is exactly the argument the file uses to
  justify adding the chip branch, so the omission contradicts its own reasoning.
- **N3 - `viewOf`'s new `overdue` is read by nobody.**
  `app/src/routes/tourReminders.ts:346-352` computes a third `nowIso` for the
  PATCH echo, with a docblock justifying it; the only consumer discards the
  PATCH response and refetches
  (`dashboard/src/routes/tours/RemindersPanel.tsx:271-278`). Harmless
  (wire-shape consistency), recorded so "this adds no IO to the PATCH echo" is
  not read as "this is used".
- **N4 - the held-back log makes two extra full passes and would double-count.**
  `app/src/jobs/tourReminders.ts:723-727`: `heldBackManualOnly +
  heldBackDiscontinued` exceeds `heldBack` for any kind in both sets. Impossible
  today (`MANUAL_ONLY_REMINDER_KINDS` is empty) and cheap either way; it becomes
  wrong the day someone re-pauses `confirmation`, which is the scenario the
  docblock at `:187-215` explicitly keeps the mechanism alive for.
- **N5 - the unpause newly exercises a poll loop with no in-flight guard.**
  `app/src/jobs/pollLoop.ts:60-73` schedules on a bare `setInterval` with no
  overlap guard (pre-existing, shared by all five polls). Until this branch the
  tour poll returned at `dueRows.length === 0` (`:731`) before any per-row IO;
  it now does per-row reads plus provider sends over the first-tick backlog.
  Overlapping 30s ticks are SAFE - every write is conditional and the A2P bucket
  paces the sends - so this is duplicated reads, not double sends. Recorded
  because the exposure is new even though the code is not.
- **N6 - accepted copy regression, recorded so it is not re-derived.** A
  single-member roster now renders "You're now connected with 1 other person on
  this number" where the old composer restructured the sentence
  (`app/src/jobs/relayFanOut.ts:216-228`). Deliberate (spec 9.2), pinned by
  `app/test/relayFanOut.test.ts:832`, with the byte-identity of every other
  roster pinned at `:803` and `:819`.

---

## Checked and cleared (so the next reviewer does not redo it)

- **`interpolate` single-pass.** `app/src/messages/resolve.ts:41-53`. The
  callback form is right - a string replacement would have traded token
  re-expansion for `$&`/`$1`/`` $` ``/`$'` expansion inside the VALUE - and the
  undeclared-token and strict-vs-degrade behaviours are preserved exactly. I
  checked all 41 `vars:` sites in `app/src/messages/catalog.ts`: every declared
  token matches the regex charset `[A-Za-z][A-Za-z0-9_]*`, so nothing silently
  stops substituting. The structural test that pins the charset is the right
  guard, since several `vars` arrays are spread-built and grep cannot see them.
  The user-controlled inputs that reach templates (`{names}` and `{name}` from
  participant names, which are NOT brace-stripped, and `{where}` from the unit
  address) are all made safe by the single pass.
- **The supersession widening `<=`** (`app/src/jobs/tourReminders.ts:518`) is
  necessary and not over-wide. I walked the 08:30-tour case its comment cites
  plus 07:00, 09:00, 09:30 and 14:00 tours against a 21:00-08:00 window and
  found no pair where the inequality retires a rung equality would have kept
  while that rung's copy was still current.
- **`retiredByTourStart` exempts `no_show_checkin` by construction**
  (`app/src/jobs/tourReminders.ts:172-186`): its `dueAt` is `scheduledAt + 30m`,
  so `row.dueAt < startIso` is false. The ISO canonicalisation at `:183` is
  load-bearing and correct (a stored `...T15:00:00Z` would otherwise sort before
  `...T14:00:00.000Z`).
- **The sweep's write condition matches `claimSkip`'s exactly**
  (`app/scripts/retire-paused-tour-reminders.ts:138-142` vs
  `app/src/repos/tourRemindersRepo.ts:310`), and `listDue` filters on
  `attribute_not_exists(#skippedAt)` (`:235`) rather than on a sparse-index
  attribute - so a SET-only sweep write genuinely removes the row from the poll.
  The race case at `app/test/retirePausedTourReminders.test.ts:259` drives the
  real interleaving through the injected client rather than a production seam,
  which is the right shape.
- **All three read surfaces carry their OWN `DISCONTINUED_REMINDER_KINDS` read**
  (`app/src/routes/tourReminders.ts:633`,
  `app/src/routes/contactTimeline.ts:1029`,
  `app/src/routes/relayGroups.ts:343`) and there is no fourth surface that
  renders a pending rung: grepping the dashboard for `suppression` /
  `skipReason` yields only `RemindersPanel`, `ScheduledCard` and
  `DeadlinesNudgesCard`, all three handled.
- **The `en_route` quiet exemption is mirrored at all four sites** - arm-time
  clamp skip (`app/src/jobs/tourReminders.ts:517` region / the `dues.set` call),
  fire-time backstop (`:1087`), tour panel (`:643` via
  `suppressionOf(..., row.kind === 'en_route')`), contact timeline
  (`app/src/routes/contactTimeline.ts:1035`) - and is correctly kept OUT of the
  shared `clampOutOfQuietHours` / `quietFor` helpers the placement ladder also
  uses. The control assertion at `app/test/contactTimeline.test.ts:1657` proves
  the placement nudge still chips `quiet_hours` in the same fixture.
- **The e2e worker cannot cross-contaminate specs**: `workers: 1`,
  `fullyParallel: false` (`e2e/playwright.config.ts:140-141`), and the new
  `/Skipped/` filter at `e2e/scenarios/steps.ts:3623` converts a
  false-pass-on-a-corpse into a loud failure, which is the right direction. The
  regexp-not-string reasoning in its docblock (case-sensitivity vs the
  lower-case "Will be skipped" prediction note) is correct.
- **`resolveMemberRole`** (`app/src/jobs/relayFanOut.ts:186-203`) is exhaustive
  over the real `UnitContact['role']` union
  (`app/src/repos/unitsRepo.ts:69`: `'landlord' | 'pm' | 'owner' | 'other'`),
  and `formatStreet` is total on `undefined`/`null`/non-string fields
  (`app/src/lib/address.ts:90-104`), so the `variant:'naked'` degrade paths
  cannot throw.
- **Both preview routes wire the new optional resolver deps**
  (`app/src/routes/tours.ts:525` wires `tours` + `settings`;
  `app/src/routes/placements.ts:923` wires `tours` + `placements` + `settings`),
  and the standalone preview legitimately wires none - `buildStandaloneOpenPreview`
  has no owner, so it composes the naked intro by construction. `tours.ts`
  omitting `placements` is correct, not an oversight: a tour-owned preview never
  takes the placement branch.
