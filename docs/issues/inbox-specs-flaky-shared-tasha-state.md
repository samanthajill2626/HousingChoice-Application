---
id: inbox-specs-flaky-shared-tasha-state
title: Inbox e2e specs flake in the full suite (shared seeded-TASHA cross-spec state)
type: bug
severity: med
status: open
area: e2e
created: 2026-06-30
refs: e2e/tests/dashboard-next/inbox-comms.spec.ts, e2e/tests/dashboard-next/inbox-markread.spec.ts, fake-twilio/src/engine/engine.ts:102, e2e/tests/flows/outbox.spec.ts
---

**Problem.** The full e2e suite (`npm run e2e`) intermittently fails three specs, which
makes it unreliable as a green gate:

- `e2e/tests/dashboard-next/inbox-comms.spec.ts` (inbound SMS → inbox → reply round-trip)
- `e2e/tests/dashboard-next/inbox-markread.spec.ts` (both tests)

All three fail the same way: a `getByText('<unique stamped body>')` for the seeded tenant
**TASHA** (`+15550100001`) inbound/reply message times out — the message never renders in
the contact timeline. Observed 3/3 failing in one full run on `main` (commit `e2e1398`),
while the rest of the suite (incl. the tenant-onboarding scenarios) passed.

**Evidence gathered (2026-06-30).**

- The three specs **pass in isolation** (`npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/inbox-comms.spec.ts tests/dashboard-next/inbox-markread.spec.ts` → 3 passed) but **fail in the full suite** — the classic cross-spec-state signature.
- The suite is **serial** (`e2e/playwright.config.ts`: `workers: 1`, `fullyParallel: false`), so it is NOT parallel-worker interference.
- The fake mints SMS SIDs as `SMfake` + a **monotonic per-engine counter** (`fake-twilio/src/engine/engine.ts` `mintSid`), reset to 0 only by `POST /control/reset` or a fake restart. **No e2e spec currently calls `resetFake`.**
- The app DB is reseeded mid-suite by `e2e/tests/flows/outbox.spec.ts` (`POST /__dev/reseed`), which clears the app messages table but NOT the fake's threads / SID counter.
- These three specs reuse the **seeded TASHA** contact and do not reseed/reset between runs, so they ride on whatever TASHA conversation state has accumulated by the time they run.

**Candidate mechanisms (not yet confirmed — root-cause first).**

1. Provider-SID dedup / idempotency in the inbound pipeline dropping the message after the
   mid-suite reseed leaves the app DB and the fake's SID counter out of sync.
2. Accumulated TASHA conversation state (many prior specs use TASHA) changing
   timeline/unread behavior.
3. SSE / async-processing render timing under a long run vs. the fixed 10s `getByText`
   wait.

**Suggested fix (pending confirmed root cause).** Make these TASHA-dependent specs
self-isolating the way the scenario suite (`e2e/scenarios/steps.ts`) already is, without
reintroducing anti-patterns: give them a clean, in-sync slate (reset the fake AND reseed
together at file start so app DB and fake SID counter don't drift — `beforeAll`, since
per-test `/__dev/reseed` is heavy and historically broke dev-login, see
[[reseed-leaves-stale-session-epoch-cache]]), or switch them to a fresh per-run number
with a named contact created up front. If the cause is SSE/async timing, replace the fixed
timeout with condition-based polling on the API before asserting the DOM — do NOT just bump
timeouts. Being fixed on the `chore/relay-verb-flake` branch alongside the related relay
flake work.
