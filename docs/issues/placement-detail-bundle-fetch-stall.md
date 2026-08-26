---
id: placement-detail-bundle-fetch-stall
title: The "placement page did not finish loading" failures are a test-budget overrun, not a stall - and the named message blames the wrong thing
type: bug
severity: med
status: open
area: e2e
created: 2026-08-25
refs: e2e/tests/scenarios/approval-and-move-in.spec.ts:223, e2e/scenarios/steps.ts:3529, e2e/playwright.config.ts:108
---

**THE PREMISE OF THE FIRST VERSION OF THIS ISSUE WAS WRONG.** It was filed as a
hung `GET /api/placements/:id`. There is no hang. Two independent investigations
converged on the same answer from opposite directions, and the measurements
below are the reason it is now settled rather than merely re-argued.

**What actually happens.** These are long multi-step scenarios that fit inside a
30s per-test budget on an idle box and do not fit when every step is 30-40%
slower under load. When the budget expires, Playwright attributes the timeout to
whatever assertion is in flight - and `pickPlacementStage`'s banner wait is
frequently the one holding the bag. Its message then announces a page-load hang
that never occurred.

## The sizing data

Per-test durations across two full suites on a lightly loaded box, against each
test's ACTUAL budget. `approval-and-move-in.spec.ts` is the whole story:

| test | override | budget | observed max | % used |
|---|---|---|---|---|
| :161 happy path (nine-stage no-skip walk) | `test.slow()` | 90s | 29.9s | **33%** |
| :223 marked deviation - inspection FAILS | none | 30s | 22.1s | **74%** |
| :258 marked deviation - rent REJECTED | none | 30s | 23.3s | **78%** |
| :295 marked deviation - party BACKS OUT | none | 30s | 26.6s | **89%** |
| :318 LIF non-eligible branch | none | 30s | 26.3s | **88%** |
| tours.spec.ts:93 landlord-led | none | 30s | 20.8s | **69%** |

**Every historical failure is one of :223, :258, :318 and tours.spec.ts:93 - the
tests with NO override.** The one test in the file that has `test.slow()` is the
longest of them all and has never failed. Four siblings do nearly as much work,
never got the override, and sit at 74-89% of budget before any load is applied.
At 89%, a 30-40% slowdown lands at 116-125%. That is the entire mechanism.

## What this retracts

Recorded because these were argued at length and should not be re-argued:

- **There is no stalled request.** One trace covering a failing test shows 7,732
  requests, slowest 810ms, none without a response, and 13 evenly spaced
  navigations making steady progress to the final one 337ms before the budget
  expired. A second (independent) trace: 9,149 entries, max 460ms, zero
  responseless.
- **The `<main> status "Loading"` snapshot is not evidence of a hang.** It is a
  page that had just been navigated to a few hundred ms earlier. Reading a
  spinner as proof of a stall is what kept this alive across four sightings.
- **The keep-alive fix was probably not incomplete.** The "second cause"
  suggested by the reopen trigger was an artifact of where the clock ran out.

Still true and NOT retracted: the app server's `keepAliveTimeout = 65s` is a
no-op on the e2e path, because Vite sets `outgoing.agent = false` and sends
`Connection: close` on every proxied request. It remains correct for production,
where CloudFront and ALB pool to the origin.

Measurements that stand, all consistent with "no stall": `/api/placements/:id`
server-side p50=11ms / max=128ms over 1556 samples; client-observed p50=16ms /
max=34ms over 80 loads; Vite event-loop stalls across two 24m suites: one, at
1008ms.

## The two fixes

1. **Size the budgets.** Add `test.slow()` (Playwright triples: 30s -> 90s) to
   `approval-and-move-in.spec.ts` :223, :258, :295, :318 and `tours.spec.ts:93`.
   Sized, not guessed: worst observed 26.6s under light load, ~37s at a 40%
   slowdown, so 90s keeps ~2.4x margin. **Do NOT raise the global default** -
   across 255 tests p50 is 3.0s and p95 17.2s, so a blanket raise buys these six
   tests nothing the override does not, and doubles how long a genuinely hung
   test takes to surface everywhere else. This is the phase-scoped sizing that
   [`concurrent-capacity-budget-tail`](./concurrent-capacity-budget-tail.md)
   asked for and could not produce for want of reds to measure.
2. **Stop the message from lying.** A test-level timeout will keep being
   attributed to whatever assertion is in flight, so after the budgets are
   raised the next long-running scenario will blame the placement page again.
   `pickPlacementStage` should include how long it ACTUALLY waited, and only
   claim a page-load problem when that wait consumed a meaningful share of its
   own 20s budget. A witness that fires at 337ms of a 20s wait is not a witness.

## Method notes worth keeping

- **`E2E_CHILD_LOG_DIR` is an observer effect** - `scripts/e2e-session.mjs`'s
  docblock forbids using it to reason about timing. A run that did anyway took
  34.7m against a 17.9m baseline with 4 failures, none of them this bug.
  AGENTS.md was corrected to scope the flag away from timing-shaped symptoms.
- **Traces were never captured** before this investigation: `retries: 0` with
  `trace: 'on-first-retry'` collects nothing. `E2E_TRACE=1` (branch
  `chore/placement-stall-hunt`) flips it to `retain-on-failure`. The traces are
  what settled this; nothing else could have.
- **`reuseExistingServer` adopts an orphaned stack on a commit match alone**, so
  an aborted hunt contaminates the next run.
- **Counting requests "received but never completed" is not a signal** - a green
  suite has ~5000, mostly normal navigation aborts.
