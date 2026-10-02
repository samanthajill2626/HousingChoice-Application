# Plan review r1-a - tour auto-close and reopen

- Plan: `docs/superpowers/plans/2026-10-01-tour-auto-close-reopen.md` (PLAN v2)
- Spec: `docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md` (DRAFT 3)
- Repo read at the worktree HEAD (579a810b, main @ae04122d underneath).
- Reviewer posture: adversarial, plan-blind to rationale. Read-only; nothing
  run except greps and file reads.

Verified and found sound (so later rounds need not re-derive them): every
DynamoDB expression in Tasks 2.2 / 2.3 / 2.4 uses each name and value it
declares (two placeholders mapping to `status` in a patch are legal); the
byStatus GSI projects ALL (`app/src/lib/tables.ts:544-550`,
`infra/modules/dynamodb/main.tf:57`), so the sweep's GSI read carries every
field the clock and the condition need; `PersonMilestoneDeps` is exported with
`activityEvents` optional (`app/src/lib/personEvents.ts:48-59`); the repo
compiles with `strict` + `noUncheckedIndexedAccess` and no
`exactOptionalPropertyTypes` (`tsconfig.base.json`), so the plan's snippets
type-check as written (TS 5.9.3, `as const satisfies` already used in
`app/src/lib/unknownQueue.ts:146`); the two existing park-after-write tests
(`app/test/toursApi.test.ts:2043-2052`, `:2121-2130`) still pass under the new
status precondition because the parked request's write has already landed
before the second request reads; the Task 9.1 row counts and orders check out
against `e2e/tests/dashboard-next/today-past-tours.spec.ts` and
`dashboard/src/routes/today/Today.tsx:218-256`; the landlord timeline takes
the new types through direct activity events, not the audit allowlist
(`app/src/routes/contactTimeline.ts:309-336`); no seed or perf world has a
candidate that is due at reseed time (`app/src/lib/seed/matrix.ts:910-916`,
`:1048-1072`; `app/src/lib/seed/performance.ts:637-667`;
`app/src/lib/seed/live.ts:357-391`).

---

## 1. [MEDIUM] Task 8.5's "exactly one Reopen tour control" test cannot be executed as written and cannot detect a duplicate

**What is wrong.** Task 8.5 RED says: for the primary-CTA states (auto-closed,
not-a-fit) "assert `getAllByRole('button', { name: 'Reopen tour' })` length 1
with the kebab open", and for the convertible-unconverted state "the kebab has
'Reopen tour' (again exactly one)". Both are wrong against the real component:

- Kebab items are `<button role="menuitem">` (`dashboard/src/routes/tours/TourActionsMenu.tsx:127-183`).
  An explicit role wins, so `getAllByRole('button', ...)` never sees a kebab
  item. Every existing kebab test queries `menuitem`
  (`dashboard/src/routes/tours/TourDetail.test.tsx:421-436`,
  `TourActionsMenu.test.tsx:37-87`).
- For a closed, non-convertible tour every kebab guard is false
  (`TourDetail.tsx:301-321`: reschedule / cancel / no-show / check-in /
  open-group are all off for `closed`), and the plan's `canReopen` is false
  there by design, so `TourActionsMenu` returns null
  (`TourActionsMenu.tsx:80-88`; pinned by the existing test
  `TourDetail.test.tsx:449-457` "a closed tour with a group has no kebab at
  all"). "With the kebab open" is impossible: the `More actions` button does
  not exist.
- In the convertible state the correct implementation yields ZERO `button`
  matches for "Reopen tour" (the only one is a `menuitem`), so the prescribed
  `length 1` fails on correct code.

**Implication.** The one dashboard test meant to pin spec 9.2 / D7 ("one
placement per state, never both at once") is vacuous in the state where a
duplicate could appear and red in the state where the implementation is right.
A literal builder either rewrites it ad hoc or bends the implementation to fit
(rendering the kebab item as a `button`, or a kebab on every closed tour -
which also breaks the existing no-kebab pin). The assertion must count BOTH
roles (`button` for the header CTA, `menuitem` for the kebab) and must not
open a kebab that the state does not render. (Minor, same task: spec 11's
matrix asks for "auto-closed from each status"; the plan's CTA matrix covers
only `autoClosedFrom: 'scheduled'`.)

## 2. [MEDIUM] Task 6.1 test 12 ("two concurrent reopens -> one 200 and one 409 `tour_changed`") is not reproducible on the harness

**What is wrong.** The harness repos are in-memory and resolve in microtasks
with no I/O between a read and a write (`app/test/helpers/twilioWebhookHarness.ts:3485-3493`
for `get`; the plan's fake `reopenIf` is a synchronous check-and-set). Two
supertest requests issued together are dispatched on separate I/O turns, and
once a handler starts it runs to completion inside the microtask queue. So the
second request's consistent read happens AFTER the first reopen landed, sees a
non-closed tour, and answers 409 `tour_not_closed` from `reopenTargetFor`, not
`tour_changed` from the conditional write. The existing concurrency test the
plan is implicitly copying survives this only because its loser gets the SAME
code on either path (`relay_already_provisioned`,
`app/test/toursApi.test.ts:2601-2620`); reopen's two paths have DIFFERENT
codes. The repo's established way to force the interleaving is a parked
wrapper (`toursApi.test.ts:2043-2052`), which Task 4.2 uses for PATCH but
Task 6.1 does not.

**Implication.** Red (or order-dependent) on a correct implementation, and the
route's `tour_changed` branch (spec 7.1 row 6) ends up untested at the route
level. The test needs a park: wrap `world.toursRepo.reopenIf` so the first
call lets a second reopen run to completion before the real write.

## 3. [MEDIUM] `activityEventsRepo` is OPTIONAL in `TourAutoCloseDeps`, and the worker / dev-tick wiring has no test - the tenant and landlord pins can be dropped silently

**What is wrong.** Task 5.2 declares `activityEventsRepo?: ActivityEventsRepo`
(optional) and passes it straight to the shared writer, where
`recordPersonMilestone` returns early when it is absent
(`app/src/lib/personEvents.ts:82`). Task 5.3 tells the builder to add the
worker block "after the tour-reminder poll block ... with the same lazy-import
style"; that block constructs no audit or activity-events repo
(`app/src/worker.ts:303-350`). Typecheck forces `auditRepo` / `unitsRepo` /
`conversationsRepo` (required) but NOT `activityEventsRepo`. Task 5.4's dev
tick "mirrors the worker" and inherits the same omission. Nothing catches it:
the job tests inject the fake world's repo, Task 5.3 has no test, and the new
e2e never reads a contact timeline.

**Implication.** Spec decision 4 / 6.4 step 2 (the "Tour closed automatically"
pin on the tenant's AND the landlord's timelines) can ship missing in
production - including for the whole first-run burst - with every planned gate
green. Make the field required (no caller has a reason to omit it), and say in
Task 5.3 / 5.4 exactly which repos the block constructs (the roster-action
block, `worker.ts:394-434`, is the right model, not the tour-reminder one).

## 4. [MEDIUM] Decision 6's handback deliverable (how to preview the first production run) is assigned to no task

**What is wrong.** Spec 2 decision 6 (a Cameron decision, not a planner
default): "The handback says how to preview what the first production run
will close (section 13)." Section 13 carries the recipe and its blind spot.
The plan has no handback step at all: S11 is main sync, the five gates and
self-QA; Task 10.3's RUNBOOK entry covers only what happens and how to review
AFTER the run ("Closed tab, newest first ..."), which is spec 15's RUNBOOK
item, not decision 6.

**Implication.** The deploy owner gets no pre-deploy preview in the handback,
and the first production run silently closes every tour more than two weeks
past (spec 13). Add an S11 step: the handback reproduces the section-13
preview recipe and its 90-day / one-page blind spot.

## 5. [LOW] Ordering: Tasks 1.1 to 4.1 leave staff able to write `no_outcome`

**What is wrong.** Task 1.1 adds `no_outcome` to `TOUR_OUTCOMES`, but the PATCH
keeps validating with `isTourOutcome` (`app/src/routes/tours.ts:1047-1049`)
until Task 4.1. Every commit in S1-S3 therefore accepts
`PATCH {outcome:'no_outcome', moveForward:false}` on a toured tour, producing a
`no_outcome` tour without `autoClosedAt` / `autoClosedFrom` - the exact state
spec 12's invariant forbids. The plan's own claim ("nothing in between is left
unguarded") covers only the precondition, not this guarantee.

**Implication.** Harmless on an unmerged branch, but the slices are not
stoppable as advertised. Fold Task 4.1 into Task 1.1 (same commit).

## 6. [LOW] Task 8.1 misses the hard-coded mutation count

`e2e/performance/mutationCatalog.test.ts:375` pins
`toHaveLength(110)` with a comment enumerating every addition. Adding the
`reopenTour` entry makes it 111; Task 8.1 says only "run the catalog test
GREEN". Self-revealing, but the comment ledger should be extended, not just
the number bumped.

## 7. [LOW] Task 8.6 does not name the existing Past-intro pin it breaks

`dashboard/src/routes/tours/ToursPage.test.tsx:708-716` asserts the exact
current Past intro string; appending the spec sentence turns it red. Task 8.6
writes a new assertion but does not say to update this one. (The e2e
`tours-past.spec.ts:113` uses a `^Last 90 days:` prefix regex and survives.)

## 8. [LOW] Two info lines per closed tour where spec 6.4 asks for one

Task 2.3's real `autoCloseIf` logs `'tour auto-closed'` with `{tourId, from}`
and Task 5.2's job logs `'tour closed automatically ...'` with the same fields
for every closed tour. Spec 6.4: "plus one info line per closed tour". On the
first production run that doubles the burst. Keep one (the job's).

## 9. [LOW] The seed vocabulary "drift alarm" goes stale silently

`app/test/seedTourTrails.test.ts:53-69` and `app/src/lib/seed/history.ts:79-96`
both state that their 8-type list MIRRORS `tourActivityFormat.ts`
`TOUR_EVENT_LABELS` and "must change with it". Task 8.8 adds two keys there;
the spec rightly does not extend the seed vocabulary, so the subset test still
passes, but both "mirror" claims become false. Reword them (seeded types are a
subset; the two auto-close kinds are never seeded) in the same change.

## 10. [LOW] Task 4.2 misstates what the tour dialogs show for a 409

Task 4.2 says the tour page's "header alert and the dialogs already show"
`ApiError.message` for every other 409. Only the header alert does
(`TourDetail.tsx:340-353`, `runDirect`). Every dialog catches with no binding
and shows fixed copy (`TourModals.tsx:86-88`, `:220-222`, `:303-305`,
`:377-379`). So a reschedule or cancel that races an auto-close shows "Couldn't
... please try again." - accepted by spec D14, but a builder or reviewer
trusting the plan's sentence will expect `tour_changed (...)` text in dialogs
and may test for it.
