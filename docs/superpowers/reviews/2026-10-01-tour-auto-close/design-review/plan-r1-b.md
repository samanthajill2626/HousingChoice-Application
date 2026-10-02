# Plan review round 1 (reviewer B) - tour auto-close and reopen

- Plan: `docs/superpowers/plans/2026-10-01-tour-auto-close-reopen.md` (PLAN v2)
- Spec: `docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md` (DRAFT 3)
- Repo: `W:\tmp\tour-auto-close` @579a810b (main @ae04122d + docs)
- Method: every spec decision walked to a task; every touched surface grepped
  across app/, dashboard/, e2e/; the plan's code checked against the real
  signatures, the harness fake, the existing tests and the lint config.

Overall: coverage is close to complete and the server code blocks are sound
against the real repo (expression names/values all used, fake conditions match
the real ones, signatures match `toursRepo.ts`, `personEvents.ts`,
`relayCloseNag.ts`, `pollLoop.ts`, `dev.ts`, `events.ts`). The findings below
are where a literal, zero-context builder fails a step, ships a vacuous test,
or leaves a production path unverified. No BLOCKING finding.

---

## 1. [MEDIUM] Task 8.5's "exactly one Reopen tour control" assertion uses the wrong role and cannot run in the CTA cases

**What is wrong.** Task 8.5 RED says: assert
`getAllByRole('button', { name: 'Reopen tour' })` has length 1 "with the kebab
open", for (a) closed + auto-closed and closed + not_a_fit (CTA cases) and (b)
closed + move_forward + convertible (kebab case, "again exactly one").

- Kebab items are `role="menuitem"`, not buttons:
  `dashboard/src/routes/tours/TourActionsMenu.tsx:113-178`; the existing tests
  query them as menuitems (`TourDetail.test.tsx:461-468`,
  `e2e/scenarios/steps.ts:2349`, `e2e/support/selectors.md` kebab rows).
- A closed tour that is not convertible renders NO kebab at all: every guard is
  false for `closed` (`TourDetail.tsx:301-321`) and the menu returns null when
  nothing qualifies (`TourActionsMenu.tsx:79-89`; pinned by
  `TourDetail.test.tsx:449-457` "a closed tour with a group has no kebab at
  all"). "With the kebab open" is impossible in case (a).

**Implication.**
- Case (a): the count only ever sees the header CTA. If the builder wires
  `canReopen={reopenTarget !== null}` (dropping the `convertible === true`
  gate), the kebab renders a "Reopen tour" menuitem beside the CTA - the exact
  "never both" regression spec 9.2 / D7 forbid - and the assertion still
  reads 1.
- Case (b): the only Reopen control IS the menuitem, so
  `getAllByRole('button', ...)` finds zero elements and throws on a CORRECT
  implementation.
The test must count both roles (button + menuitem), and must not try to open a
kebab that is correctly absent.

## 2. [MEDIUM] Existing tests the plan's own steps break, not named: the mutation-catalog count pin (and the Past intro pin)

**What is wrong.** `e2e/performance/mutationCatalog.test.ts:364-375` pins the
discovered mutation count: `toHaveLength(110)`, with an itemized comment
(:366-374) listing every addition since the last baseline. Task 8.1 adds
`reopenTour` (a new `request(... method: 'POST')` in `endpoints.ts`) and the
catalog entry, then says "Run the e2e workspace's catalog test ... GREEN". With
the plan's edits only, discovery finds 111 and the test fails. The plan never
names this file or the pin. The e2e workspace's vitest is part of root
`npm test` (`package.json` "test" runs every workspace; `e2e/package.json`
"test": "vitest run"), so it is gate 2.

Secondary, same class: `dashboard/src/routes/tours/ToursPage.test.tsx:711-716`
asserts the OLD Past intro by exact `getByText`; Task 8.6 appends a sentence.
Task 8.6's RED ("intro strings equal the spec's") implies editing it but does
not say an existing assertion must change.

**Implication.** Task 8.1's stated GREEN is unreachable as written; the builder
must discover and bump the pin (110 -> 111, extend the comment). Name both
files in Tasks 8.1 / 8.6.

## 3. [MEDIUM] The production path (worker) and the dev tick build their deps by "mirroring", nothing checks them, and the one dep that matters most is optional

**What is wrong.** Task 5.2 declares `TourAutoCloseDeps.activityEventsRepo?:
ActivityEventsRepo` (optional). `recordPersonMilestone` returns immediately when
`activityEvents` is absent (`app/src/lib/personEvents.ts:80-82` - "an absent
repo means the whole milestone is skipped"). Task 5.3 (worker) says only "builds
the deps with the same lazy-import style" and lists no fields; Task 5.4 says
"Lazily built deps mirroring the worker's". Neither has a test of the
constructed deps: Task 5.3 is "Typecheck. Commit."; every unit test injects
world deps (Tasks 5.2, 5.4, 6.1); the e2e (Task 9.2) drives the APP-side dev
tick and asserts the Closed badge, the Outcome card and "nothing sent" - never
a tenant or landlord timeline pin.

**Implication.** Omitting `activityEventsRepo` in `worker.ts` (or in the dev
tick) typechecks, passes every test and every gate, and silently drops the
"Tour closed automatically" pin from every tenant AND landlord timeline in
production (spec decision 4, 10.1) - delivered only if the builder guesses to
include an optional field. Make it required in `TourAutoCloseDeps` (the sweep
always has one), and list the worker's dep fields explicitly in Task 5.3.

## 4. [MEDIUM] Task 6.1 case 12 (concurrent reopens -> one 200 + one 409 `tour_changed`) does not exercise the race it names

**What is wrong.** Case 12 asks for two concurrent POSTs to yield exactly one
200 and one 409 `tour_changed`, with no instruction to park either request.
Against the harness every repo call is an in-memory microtask (the fake `get`
and the planned fake `reopenIf` have no I/O, `twilioWebhookHarness.ts:3485-3493`).
The first request's read-check-write therefore completes before the second
request's handler (which waits on its own `json()` body-parse I/O) reads the
tour, so the loser reads status `toured`/`scheduled` and the route answers 409
`tour_not_closed` from `reopenTargetFor`, not `tour_changed`.

**Implication.** Written literally the test fails on a correct implementation,
or gets loosened to "any 409" - either way the route's
`reopened === undefined -> 409 tour_changed` branch ships untested (Task 2.4
only proves the repo method loses; nothing proves the route maps it). The repo's
own pattern for this is a parking wrapper between read and write
(`app/test/toursApi.test.ts:2034-2052`, `:2112-2130`); Task 4.2 case 1 already
uses one. Case 12 needs the same (e.g. wrap `world.toursRepo.reopenIf` to run a
first reopen before forwarding).

## 5. [LOW] Ordering: the "nothing in between is left unguarded" claim is false for `no_outcome`

**What is wrong.** Task 1.1 adds `no_outcome` to `TOUR_OUTCOMES`, so
`isTourOutcome('no_outcome')` becomes true. The PATCH route validates outcome
with `isTourOutcome` and prints `TOUR_OUTCOMES` in the 400
(`app/src/routes/tours.ts:1047-1049`) until Task 4.1, eight commits later. In
between, staff can PATCH `{ outcome: 'no_outcome', moveForward: false }` onto a
toured tour (a `no_outcome` tour with no `autoClosedAt`/`autoClosedFrom` -
breaking spec 12's invariant) and the 400 text advertises the system value.
Likewise S5 (the sweep closes tours) lands before S6 (the only way out of
`closed`) and S8 (until then the tour page renders `TOUR_OUTCOME_LABELS['no_outcome']
?? 'no_outcome'` and "Moving forward: No", `TourDetail.tsx:795-796`).

**Implication.** Branch-internal (nothing deploys mid-branch), but the plan's
section 2 asserts stoppable, guarded intermediate states. Fold Task 4.1's
validator switch into Task 1.1's commit, or drop the claim.

## 6. [LOW] Spec decision 6 (the handback says how to preview the first production run) is delivered by no task

**What is wrong.** Spec 2 decision 6 and section 13 require the handback to
explain how to preview what the first production run will close (Past tab rows
dated more than 14 days ago, minus Needs placement and recently-marked rows,
plus undated rows; the 90-day blind spot). Task 10.3 (RUNBOOK) covers what the
run does and how to review it afterwards only; S11 has no handback step.

**Implication.** The pre-deploy preview Cameron was promised depends on the
builder reading spec 13 unprompted. Add it to S11 (handback) or Task 10.3.

## 7. [LOW] The dashboard type switch leaves unused imports (lint errors in touched files)

**What is wrong.** After Task 8.1 types `patchTour`'s outcome and the Record
outcome decision as `StaffTourOutcome`, the `TourOutcome` imports at
`dashboard/src/api/endpoints.ts:77`, `dashboard/src/routes/tours/TourDetail.tsx:43`
and `dashboard/src/routes/tours/TourModals.tsx:23` have no remaining use (each
file's only use is the one being retyped: `endpoints.ts:2674`,
`TourDetail.tsx:532`, `TourModals.tsx:286`). `@typescript-eslint/no-unused-vars`
is `error` (`eslint.config.mjs:31-39`). The plan handles unused imports only
for `routes/tours.ts` (Task 4.1) and lints only Tasks 5.2 and 8.7.

**Implication.** Gate 5 catches them at the end; a per-task note avoids the
churn.

## 8. [LOW] Several RED steps are green before any code changes

**What is wrong.**
- Task 4.2 case 2 (racing delete -> 404): the current route already maps
  `ConditionalCheckFailedException` to 404 (`app/src/routes/tours.ts:1240-1244`).
- Task 8.7's `Today.test.tsx` no-show row: `Today.test.tsx` feeds the hook's
  state directly (`past = { ... }`, e.g. `:345-346`, helper `:72-80`) and
  `Today.tsx:191-216` renders any row it is given; the no-show filter lives in
  `useTours.ts:261-263`, so this test passes on unchanged code.
- Task 2.2 cases 3-4 (no-opts patch succeeds; missing tour throws) pass today.

**Implication.** Harmless as regression pins, but the plan's rule "confirm it is
red for the stated reason" cannot be met for these; the only real RED for 8.7 is
the `useTodayPastTours.test.tsx` case.

## 9. [LOW] Minor divergences from the spec text

- Two info lines per closed tour: `autoCloseIf` logs `'tour auto-closed'` (Task
  2.3) and the job logs `'tour closed automatically ...'` (Task 5.2); spec 6.4
  says one info line per closed tour. Same doubling on reopen (repo
  `'tour reopened'` + route `'tour reopened via api'`).
- `autoCloseDueAtMs` returns null when `createdAt` is missing (Task 1.2 case
  10); spec 5.3 only nulls a PRESENT-but-unparseable instant. Harmless (every
  writer stamps `createdAt`), but it is a rule the spec does not state.
- Task 8.4 says mirror `CancelTourModal` "exactly"; that modal's secondary
  button is "Keep tour" and its confirm is `variant="danger"`
  (`TourModals.tsx:389-394`), while the spec wants "Cancel" / "Yes, reopen". The
  constants table wins, but "exactly" invites copying the wrong label/variant.

## 10. [LOW] Comments that state the old rule are left out of every task

Not behavior, but readers of the invariant:
- `dashboard/src/routes/tours/ToursPage.tsx:25-29` - Closed view "status closed
  (terminal)"; status badge "tells Closed and Canceled apart" (rows now carry an
  outcome badge too).
- `dashboard/src/routes/tours/useTours.ts:10-12` - "closed is terminal".
- `app/src/services/relayCloseNag.ts:1-14` - header lists only placement/tour
  PATCH terminal events as arm triggers; gains the sweep and a clear-on-reopen.
- `app/src/lib/seed/history.ts:79-85` and `app/test/seedTourTrails.test.ts:53-58`
  - both claim to MIRROR the dashboard `TOUR_EVENT_LABELS` keys ("8-type
  vocabulary ... a deliberate drift alarm"), which Task 8.8 grows to ten. The
  test still passes (it is a subset check of seeded rows), so the "alarm" is
  silent and the comments become false.
- `dashboard/src/routes/today/Today.test.tsx:421` - title "...more than Today
  lists (its no-shows)".

---

## Verified and found correct (no finding)

- Real-repo expressions: every `ExpressionAttributeNames` / `Values` entry in
  `patch` (+ expectedStatus), `autoCloseIf` and `reopenIf` is referenced; the
  harness conditions are field-for-field equivalent; the byStatus GSI projects
  ALL (`infra/modules/dynamodb/main.tf:57`), so `listByStatus` items carry every
  field the clock and the conditions read.
- `ToursRepo` has exactly one full implementation outside the factory (the
  harness, `twilioWebhookHarness.ts:3463`); every other consumer uses the factory
  or `Pick<...>`, so the two new required methods break nothing else.
- Existing parking wrappers (`toursApi.test.ts:2044`, `:2122`, `:2242`,
  `:3302`; `placementConvert.test.ts:307`, `:782`) park AFTER the real write, so
  the status precondition does not turn any of them red.
- `PersonMilestoneDeps` is exported; `startPoll` is imported as `startPollLoop`
  (`worker.ts:24`); `tour.updated` / `scheduled.updated` payloads match
  `events.ts:227-241`; all events are bridged (`events.ts:315-328`).
- The e2e Today rewrite's counts, order, cap and link texts (Task 9.1) match the
  current spec file and `selectPastTours` ordering.
- No exhaustive `Record<ActivityEventType|TimelineMilestoneType, ...>` exists;
  the contact Timeline colour switch defaults to neutral (`Timeline.tsx:428-444`).
