# Tour reminder supersession + Upcoming placement - implementation plan

Date: 2026-09-01
Branch: `feat/tour-reminder-supersession` (cut from `main` @f27aabbf)
Spec: `docs/superpowers/specs/2026-09-01-tour-reminder-supersession-design.md`
Design review: spec rounds 1-5, adjudications at
`docs/superpowers/reviews/2026-09-01-tour-reminder-supersession/adjudications.md`

Written for a builder with NO prior context. Every slice is TDD: write the
failing test, watch it fail for the RIGHT reason, implement, re-run.

## Slice order and why it is this order

Deletion is the dangerous half, so nothing deletes until everything that
REFUSES a superseded rung is already in place. Read the order as three phases:
make generations identifiable (S1-S4), make them refused and visible (S5-S7),
only then start deleting (S8-S9). S10-S11 are the layout half and are
independent of all of it.

| # | slice | may deletion happen yet |
| --- | --- | --- |
| S1 | repo foundations: fields, claim guards, sweep method | no callers |
| S2 | arm stamps `ladderId`, returns it | no |
| S3 | tour pointer writes: create, re-arm, terminal rotation | no |
| S4 | seeds stamp ladders and set pointers | no |
| S5 | refusal: poll + send-now + `superseded` copy surfaces | no |
| S6 | the three preview surfaces agree | no |
| S7 | read grouping, `earlier[]`, panel disclosure, 404s | no |
| S8 | conversion: defer-on-claim, sweep after finalize | FIRST deletes |
| S9 | tours.ts swaps cancel -> sweep; old wrapper removed | yes |
| S10 | Upcoming block moves inside the scroll | n/a |
| S11 | re-point the tests that encode the old contracts | n/a |

Stopping between any two slices leaves a system where every armed rung either
sends correctly or is refused - never one that deletes without refusing.

---

## S1 - Repo foundations

No caller changes. Everything here is additive and inert until S2.

**T1.1 - `ladderId` on the reminder row.** Add `ladderId?: string` to
`TourReminderItem` (`app/src/repos/tourRemindersRepo.ts`) and accept it on
`create`. Optional because pre-migration rows will never have one.

**T1.2 - `currentLadderId` on the tour.** Add `currentLadderId?: string` to
`TourItem` (`app/src/repos/toursRepo.ts`). NOTE for T3.3: `patch` maps an
explicit `null` to REMOVE (`toursRepo.ts:333`), which is why the spec rotates
this field and never clears it. Do not add a clear path.

**T1.3 - claim guards. RED FIRST, and this test is the reason the slice
exists.** Against DynamoDB Local, at the repo layer:

```
create a row -> delete it directly -> claimSend(reminderId, now)
expect: false, AND getById(reminderId) is still undefined
```

On `main` this test FAILS: `claimSend` is an `UpdateCommand` whose conditions
are all `attribute_not_exists(...)`, which all hold for a missing item, so
DynamoDB CREATES a stub row and returns success. Watch it fail that way before
fixing - a green run here means you wrote the test against the fake.

**This test CANNOT live in the in-memory fake.**
`app/test/helpers/twilioWebhookHarness.ts:2971-2974` returns `false` on a
missing row - which is correct POST-fix behavior and therefore cannot express
the defect. Leave the fake exactly as it is; it needs no change in this whole
plan.

Then add `attribute_exists(reminderId)` to the ConditionExpression of
`claimSend`, `claimSkip` and `cancel`. Do NOT touch `uncancel` - it already
requires `attribute_exists(canceledAt)`. Precedent for the exact form:
`app/scripts/retire-paused-tour-reminders.ts:205-207`.

**T1.4 - `deleteSupersededForTour(tourId)`.** Mirrors `cancelForTour`'s shape
(`listByTour`, then `Promise.allSettled` over the rows) but issues
`DeleteCommand` with `ConditionExpression: 'attribute_not_exists(sentAt)'`.
Tests: a pending row goes; an operator-canceled row goes; a skipped row goes; a
SENT row stays; a row that gains `sentAt` between the list and the delete stays
(drive it by claiming inside the test, not by mocking). A lost condition logs at
debug and does not reject the batch.

Gate: `npm run typecheck`, and the repo suites.

---

## S2 - The armer stamps and returns a ladder id

**T2.1 - RED.** `armTourReminders` returns rows that all carry the SAME
`ladderId`, and two calls return different ones. Assert on the returned rows,
not on a clock.

**T2.2.** In `app/src/jobs/tourReminders.ts`, mint `randomUUID()` once per call,
pass it into every `create`, including the born-skipped rows.

**T2.3 - change the return shape** to `{ ladderId, rows }`, with
`ladderId: null` when the arm produced no rows (a timeless tour, or an arm where
every rung clamped past the tour start). Callers currently destructure an array;
update every one. `ArmTourRemindersDeps` gains NOTHING - the armer does not
write the tour row (spec D3a).

Gate: `npm run typecheck` is the real gate here - vitest strips types and will
not prove the new shape threaded.

---

## S3 - The tour pointer

**T3.1 - CREATE path** (`POST /api/tours` with a `scheduledAt`). After the arm,
write the returned `ladderId` to the tour. RED test: the 201 body carries
`currentLadderId`, and it matches the armed rows. The existing code returns the
tour object captured BEFORE the arm, so this fails until the returned object
carries the pointer.

**T3.2 - re-arm path** (`routes/tours.ts`, `armable && rearmTrigger`). Rotate
the pointer to a fresh UUID as part of the patch ALREADY being written at
`routes/tours.ts:1164` - one write, not two. Then arm, then write the returned
`ladderId`.

**T3.3 - the step-4 write is CONDITIONAL** on `currentLadderId` still equalling
the rotation value from T3.2. RED test: simulate two interleaved reschedules and
assert the tour ends pointing at a ladder whose rows exist, and that the loser
logged at error. Without the condition both requests return 200 and the tour is
silently disarmed.

**T3.4 - terminal transitions** (`canceled` / `closed` / `toured` / `no_show`)
rotate the pointer to a fresh unmatched UUID. They do NOT clear it and do NOT
sweep yet (S9). RED test: after a terminal patch, no row's `ladderId` matches
the tour's pointer, AND the attribute is still PRESENT. The presence assertion
is the one that matters - see T1.2.

**T3.5 - the PATCH response** must carry the pointer this request wrote.
`routes/tours.ts:1164` captures the tour before the side effects and `:1285`
returns it.

Gate: typecheck + `app/test/toursApi.test.ts`.

---

## S4 - Seeds

Seeds must land BEFORE refusal (S5) or the seeded worlds go dark the moment
refusal ships.

**T4.1 - `lib/seed/live.ts`.** It arms through the REAL armer (`:514`, `:528`,
`:538`) and writes its tour rows directly, so set `currentLadderId` inline from
each arm's returned `ladderId`. RED test: after a live seed, every armed rung's
`ladderId` matches its tour's pointer.

**T4.2 - `lib/seed/matrix.ts`.** It builds RAW rows, including a same-tour
SENT `confirmation` plus PENDING `day_before` pair. Stamp ONE `ladderId` across
both and set the tour pointer to it. A partial stamp splits that pair across the
disclosure, which is the failure this task exists to prevent - assert both rows
land in the CURRENT ladder.

**T4.3.** Sweep the other builders under `app/src/lib/seed/` and
`app/src/lib/performanceSeed.ts` for reminder-row writes; stamp any you find.
`performanceSeed.ts:167` constructs the repo and hands it on - follow it and
confirm whether it writes rows before deciding it needs nothing.

Gate: `app/test/seedLive.test.ts` and the seed-coherence check.

---

## S5 - Refusal

**T5.1 - the `superseded` token.** Add to `ReminderSkipReason`
(`tourRemindersRepo.ts`) and to the exhaustive `REMINDER_SKIP_REASON_LABELS`.
Copy: "superseded by a reschedule".

**T5.2 - the FIVE copy/type surfaces, three forced and two not.** Typecheck
will catch a miss in: the reminder skip-reason labels, the placement-nudge
card's reason map, and `ScheduledCard`'s `SUPPRESSION_COPY`. It will NOT catch:
the dashboard's hand-mirrored copy of the reason union (an app-side-only
addition compiles green and renders the raw snake_case token to staff), and
`SEND_NOW_ERROR_COPY`, a `Record<string, string>` read through `??`
(`dashboard/src/api/types.ts:1327`, `:1379`) whose absent entry silently renders
the generic retry sentence. Write an explicit assertion for each of the two
unforced ones. Green is not evidence here.

**T5.3 - the poll refuses.** In `runDueTourReminders`, a rung whose `ladderId`
does not match its tour's `currentLadderId` is claim-skipped `superseded`. A
rung with NO `ladderId` on a tour with NO pointer attribute is EXEMPT (spec 3.5
pre-migration) and behaves exactly as today - test both.

**T5.4 - the poll DEFERS for a conversion in flight.** A rung whose tour carries
a conversion claim sentinel is left unclaimed with NO stamp, and retried next
tick. It must not be claim-skipped: `skippedAt` is terminal
(`tourRemindersRepo.ts:361`), so a skip inside the window could never be undone
when the claim is released. RED test both halves - deferred now, sends after the
claim releases.

**T5.5 - Send now refuses.** `forceSendReminder` is a SEPARATE entry point from
the poll and inherits none of T5.3. A pointer-mismatched rung gets a 409 with
its own error code, and the code has a `SEND_NOW_ERROR_COPY` entry (T5.2).

Gate: typecheck + `app/test/tourReminders.test.ts` + `tourRemindersApi.test.ts`.

---

## S6 - The preview surfaces agree

Three surfaces render a pending rung as a promise it will send. Because
`listDue` only picks a row up at `dueAt <= now`, a mismatched rung would keep
promising until it came due - not until the next tick.

**T6.1** `routes/tourReminders.ts` (the panel's GET).
**T6.2** `routes/contactTimeline.ts:981` (contact Upcoming bucket).
**T6.3** `routes/relayGroups.ts:226` (group thread Upcoming bucket).

Each renders a pointer-mismatched pending rung as suppressed `superseded`, never
as upcoming. One RED test per surface, all three on the same fixture.

---

## S7 - Read grouping and the panel

**T7.1 - `earlier[]` on the GET.** CURRENT = `ladderId` matches the tour's
pointer, or (tour has no pointer ATTRIBUTE and row has no `ladderId`). EARLIER =
everything else. `next` is computed from `reminders[]` alone.

**T7.2 - ordering.** `earlier[]` sorts by `sentAt ?? dueAt` DESCENDING, tie-break
`reminderId`. Not `ladderId` (a UUID) and not `createdAt` (ties within one arm).

**T7.3 - the panel's disclosure, OUTSIDE the empty short-circuit.**
`RemindersPanel.tsx:346` returns "No reminders armed." on an empty
`reminders[]`, and a terminal tour is exactly that state with a non-empty
`earlier[]`. RED test: a tour with zero current rungs and two sent earlier ones
renders the disclosure. This is the finding a prior mission shipped twice -
assert on the RENDER, not on a derived flag.

**T7.4 - the action allowlist, by state.** In `earlier[]`: sent -> no actions;
`upcoming` (a sweep miss) -> Cancel ONLY; canceled -> none; skipped -> none. Do
not reuse the current-ladder renderer's action list: it keys off `state` and
would put Send now on an unsent earlier rung (`RemindersPanel.tsx:397`) and
Restore on a canceled one (`:408`).

**T7.5 - no body without `sentBody`.** An earlier rung lacking the snapshot
renders NO body rather than composing live - a live compose for a superseded
generation uses the tour's CURRENT time and advertises a date that never applied
to that text.

**T7.6 - the two non-null assertions.** `routes/tourReminders.ts:395` and
`:462` do `.find(...)!` on a post-write re-read. Return an honest 404 instead,
AND keep emitting `scheduled.updated` (`:416`) when the write itself won - a
cancel that succeeded and then lost its echo row still changed the ladder.

---

## S8 - Conversion (first slice that deletes)

`routes/placements.ts:716`. The pointer is NOT touched here; T5.4's deferral is
the disarm, and it is reversible because the conversion claim already is.

**T8.1.** Move the reminder retirement from its current position (between
`claimConversion` and `create`) to AFTER the finalize succeeds. Replace
`cancelTourReminders` with `deleteSupersededForTour`.

**T8.2 - RED test, both failure paths.** A conversion whose `placements.create`
throws, and one whose FINALIZE throws (`placements.ts:757-773` releases the
claim, leaves the tour `scheduled`, and is retryable by design): in both the
tour keeps every rung, keeps its pointer, and has NO rung stamped `superseded`.
Sweeping before the finalize passes the create test and fails this one - that is
the whole point of the task.

---

## S9 - The tours.ts sweep, and removing the old path

**T9.1.** Replace `cancelTourReminders` with `deleteSupersededForTour` at both
`routes/tours.ts` sites (re-arm, terminal). Ordering per spec 3.2: rotate
(already done in S3), sweep, arm, conditional pointer write.

**T9.2.** Delete `cancelTourReminders` (`jobs/tourReminders.ts`) and
`cancelForTour` (`tourRemindersRepo.ts`) once no caller remains. Grep before
deleting; three call sites were known and a fourth would be a surprise worth
stopping for.

**T9.3 - the acceptance test for P1.** Reschedule a tour twice; assert the
current ladder holds exactly one generation AND the superseded unsent rows are
absent from the table - query the repo, do not just read the API response.

---

## S10 - The Upcoming block moves inside the scroll

Independent of S1-S9. Can be built in parallel or first if that suits.

**T10.1 - markup.** Move `<section class=upcoming>` from a sibling of
`.streamWrap` to the LAST CHILD of `.stream` in `Timeline.tsx`. Keep the
heading, the list and the `aria-label`.

**T10.2 - CSS.** Drop the block's `max-height`, `overflow-y` and `flex` rules
and the `@media (max-width: 767.98px)` override. Leave `.stream`'s
`overflow-anchor: none` alone. Leave `.streamWrap` alone - the "New messages"
pill is positioned against it.

**T10.3 - the anchor, as a PURE FUNCTION first.** jsdom performs no layout, so
this is the only part unit tests can prove. Derive from the sentinel's position:

| anchor | when |
| --- | --- |
| `sentinel` | sentinel bottom is at or below the viewport bottom, within 48px |
| `below` | sentinel bottom is ABOVE the viewport bottom by any amount |
| `null` | sentinel bottom is below the viewport bottom by more than 48px |

`below` is defined by DIRECTION, not slack, so it stays reachable when the block
is shorter than 48px. Unit-test the function across all three bands including
the small-block case.

**T10.4 - a sentinel element** after the last cluster, before the Upcoming
section.

**T10.5 - convert ALL FIVE scroll writers.** Converting only the growth pin is
the single most likely way to get this wrong:

| site | disposition |
| --- | --- |
| growth pin `:1911` | anchor-driven per the table |
| conversation-switch reset `:1890` | target the SENTINEL, not `scrollHeight` |
| post-send pin `:1976` | target the sentinel |
| pill-clear `:1853` | clears on `sentinel` or `below`, not on true bottom |
| prepend restore `:1900` | unchanged - anchored to prepended height |

Miss `:1890` and every thread OPENS scrolled onto the block.

**T10.6 - the re-pin signal.** `ResizeObserver` on the Upcoming block. Do NOT
put the `upcoming` array in the effect deps: `GroupTextView.tsx:451` passes a
fresh `[]` literal every render. An ids/length key is also wrong - it misses a
body wrapping to a second line, which moves the anchor with no key change. Leave
`clusters`' existing key alone (out of scope).

**T10.7 - e2e, because unit tests cannot see layout.** In a real browser at
390px: at rest the stream shows more messages than `main` and no block; scroll
down reveals it; scroll up removes it; an operator standing on the block is not
yanked and gets no pill when a message arrives; opening a thread lands on the
newest message.

---

## S11 - Re-point the tests that encode old contracts

These fail because the contract changed, not because the build broke. Re-point
them; do not delete them.

- `e2e/tests/scenarios/scheduled-visibility.spec.ts:268` - the only end-to-end
  proof that a reschedule retires the previous ladder. It asserts canceled rows
  remain VISIBLE; it must now assert they are gone.
- `e2e/scenarios/steps.ts:3615-3661` - rung disambiguation that rests on
  superseded rows staying visible.
- `dashboard/src/routes/contact/Timeline.test.tsx:1375-1481` - five tests
  encoding the OLD pin contract.
- Four e2e sites resolve the Upcoming region by role and name - confirm they
  still resolve after the move.

---

## Gates

From the worktree, bare, in order, per `AGENTS.md`:

1. `npm run typecheck`
2. `npm test`
3. `npm run smoke`
4. `npm run e2e`
5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`

Attribute any gate-5 error by BASELINE COMPARISON at the merge base, never by
line number.

## Watch items

- **Vitest strips types.** A green suite does not prove S2's return shape
  threaded. Only `npm run typecheck` does.
- **Two of the five copy surfaces compile green while broken** (T5.2).
- **The in-memory fake needs no change** and must not be "fixed" - it is already
  correct post-guard, and altering it re-injects the bug into the double.
- **Do not commit while `npm run e2e` is running.**
- `npm test` needs DynamoDB Local (`npm run db:start`). If it comes back red on
  DynamoDB suites with timeouts and no assertion failures, re-run under a clean
  access key before blaming the branch.
