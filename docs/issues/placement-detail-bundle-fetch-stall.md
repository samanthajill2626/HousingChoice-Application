---
id: placement-detail-bundle-fetch-stall
title: The placement detail bundle fetch stalls indefinitely in full-suite runs - server timing, proxy pooling and clean-load queueing are all ruled out
type: bug
severity: med
status: open
area: e2e
created: 2026-08-25
refs: dashboard/src/routes/placements/PlacementDetail.tsx:168, e2e/scenarios/steps.ts:3529, e2e/playwright.config.ts:116
---

**Problem.** In a full `npm run e2e`, the placement detail page intermittently
holds `<main>` at `status "Loading"` until the test budget expires. The
`GET /api/placements/:id` promise neither resolves nor rejects. Four sightings:

| date | spec | shape |
|---|---|---|
| 2026-08-23 | approval-and-move-in.spec.ts:318 | opaque kebab-click timeout |
| 2026-08-24 | approval-and-move-in.spec.ts:258 | opaque kebab-click timeout |
| 2026-08-25 | scenarios/tours.spec.ts | 30s timeout, no assertion failure |
| 2026-08-25 | approval-and-move-in.spec.ts:223 | NAMED page-load message |

The 08-25 pair were initially read as machine contention because they were in
DIFFERENT FILES, which the repo's compare-failing-files rule treats as
environmental. That reading does not survive inspection: both specs reach
`/placements/:id` through the SAME helper (`pickPlacementStage` /
`expectPlacementStage` -> `placementBanner()`), so it is one code path, not two
files. Separately, the concurrent session blamed for the second failure started
at 17:46:41Z, and the failing test had already timed out at ~17:42:08Z - four
and a half minutes EARLIER.

**It is a stall, not an error and not slowness.** The preserved accessibility
snapshot shows `status "Loading"` and no alert;
[PlacementDetail.tsx:447](../../dashboard/src/routes/placements/PlacementDetail.tsx)
renders a distinct `role="alert"` on failure, so the error path was never
reached. The page's own perf baseline is 632ms cold / 187ms warm and is labelled
`load_scale_bearing=false`, so a 20s+ hold is a 30-100x blowup, not proportional
degradation.

## Ruled out by measurement

Recorded so the next person does not repeat them.

- **Server-side slowness.** From one green suite's `E2E_CHILD_LOG_DIR` capture:
  `/api/placements/:id` completed **1556 times at p50=11ms, p95=40ms, p99=65ms,
  max=128ms**. The route is never slow.
- **A stale pooled socket on the Vite proxy hop.** Vite resolves
  `outgoing.agent = options.agent || false` and, with no agent, sets
  `Connection: close` on every proxied request
  (`node_modules/vite/dist/node/chunks/config.js:20714`). That hop does not pool,
  so it has no socket to go stale. **Consequence: the app server's
  `keepAliveTimeout = 65s` is a no-op on the e2e path** - see the correction in
  [`app-server-default-keepalive-timeout`](./app-server-default-keepalive-timeout.md)
  and [`placement-stage-more-actions-suite-only-flake`](./placement-stage-more-actions-suite-only-flake.md),
  both of which credit that change as the root-cause class for THIS symptom. It
  remains correct for production, where CloudFront and ALB do pool to the origin.
- **Client-side queueing under clean load.** A probe loading the page 40 times
  measured the bundle fetch **client-side at p50=16ms, p99=34ms, max=34ms**
  (n=80) against the server's 11ms median - a ~5ms gap. Peak concurrent API
  requests reached 12, so requests DO queue past the six-connection limit, but
  queueing costs milliseconds.

## Still open

The trigger. It has not reproduced solo: three full suites green
(25.3m / 22.1m, plus the reporting agent's own second run), with only light
concurrent agent activity. All four sightings had a second full suite or an
interactive session live.

### The leading hypothesis is now the Vite dev server, not the browser

A per-origin connection-starvation theory was the front-runner: Vite serves the
app as an unbundled module graph on the SAME origin as `/api/*`, and a probe
measured **166 concurrent module requests** on one navigation, competing for
Chrome's six HTTP/1.1 connections with the `/api/events` EventSource holding one
permanently.

**Evidence against it.** The 2026-08-25 instrumented run timed out twice on
`page.request.get()` calls - `steps.ts:2894` hits
`/api/placements/:id`, the SAME route as the browser-side stall, and
`steps.ts:3218` hits `/api/units/:id`. `page.request` is Playwright's NODE-side
client with its own connection pool, entirely separate from Chrome's. A
mechanism that starves the browser's six connections cannot explain a stall in
a different process with a different pool.

What both clients share is the **Vite dev server**, which proxies `/api/*` to
the app. Vite is single-threaded Node: if its event loop blocks on dev-server
work (module transform, HMR graph walk, dependency re-optimization), a proxied
API request sits unserved. That predicts exactly what is observed - the app logs
nothing (the request never arrives), the client waits indefinitely, server-side
timings stay fast, and the app's own `keepAliveTimeout` is irrelevant.

If Vite is the mechanism, this is **dev/e2e-shaped and NOT a product defect**:
production serves a static bundle with no Vite in the path.

**Next test of it:** measure Vite's event-loop lag during a suite (a
`configureServer` plugin logging stalls past ~1s) and correlate with the stall.
That is a direct test, unlike waiting for a rare failure.

## What was blocking diagnosis

- **Traces were never captured.** `playwright.config.ts` pairs `retries: 0` with
  `trace: 'on-first-retry'`, which collects nothing, so all four sightings have
  screenshots and video but no network data - and "was the request even sent?"
  is the question that splits the remaining hypotheses. `E2E_TRACE=1` now flips
  tracing to `retain-on-failure` (branch `chore/placement-stall-hunt`). It is
  opt-in because continuous capture perturbs the timing being measured.
- **`E2E_CHILD_LOG_DIR` IS AN OBSERVER EFFECT - do not use it for this bug.**
  `scripts/e2e-session.mjs` says so in its own docblock: piping a child's stdout
  makes `isTTY` false and the stream block-buffered, and it ends "Do not use
  this variable to reproduce a timing-sensitive symptom and then reason from the
  timings." A 2026-08-25 run that ignored this took **34.7m against a 17.9m
  baseline and produced 4 failures instead of 1**, none of them this bug (two
  SSE-rollup, two `apiRequestContext` timeouts). AGENTS.md recommends the flag
  for intermittent failures generally; that recommendation and this docblock
  conflict for timing-sensitive symptoms, and the docblock wins.
  A wall-clock cost of ~17% (25.3m vs 21.7m) was measured on a run with BOTH
  tracing and child logging on, so it cannot be attributed to either alone.
- **The request logger cannot tell an aborted client from a hung server.** A
  green suite logged **4982 requests received with no completion** (989 of them
  `/api/events` streams, the rest almost certainly navigation-aborted). Nothing
  distinguishes those from a genuine hang, which is why this symptom has always
  read as "nothing in any log". Counting them is not a useful signal.
- **`reuseExistingServer` silently adopts an orphaned stack.** The preflight
  compares commits only, so a same-commit server that has already been driven
  for 20+ minutes is adopted unchallenged. Killing a run orphans its stack, so
  an interrupted hunt can contaminate the next run - and did: of the two
  original 2026-08-25 failures, the second ran against the stack the first had
  already driven for 19.7 minutes. **Long-lived-stack reuse is itself a
  candidate variable**, and it correlates with every sighting: all three of the
  fresh-stack runs since were green.

**Next capture.** Run with `E2E_TRACE=1` and
`E2E_CHILD_LOG_DIR=.artifacts/child-logs`, and COPY THE ARTIFACTS ASIDE before
re-running - Playwright wipes `test-results` at the start of every run, which is
how the 2026-08-23 snapshot was lost. Then read the trace for the stuck
`/api/placements/:id`: a long stalled phase before it is issued means connection
starvation, while sent-and-waiting means the response was lost in transit.

Related: [`dashboard-api-client-has-no-request-timeout`](./dashboard-api-client-has-no-request-timeout.md)
is why the stall presents as an indefinite spinner rather than an error. Fixing
it makes this failure legible; it does not stop it.
