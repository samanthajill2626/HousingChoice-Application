---
id: inbox-specs-flaky-shared-tasha-state
title: Inbox e2e specs flake in the full suite (shared seeded-TASHA cross-spec state)
type: bug
severity: med
status: resolved
area: e2e
created: 2026-06-30
resolved: 2026-06-30
refs: e2e/tests/dashboard-next/inbox-comms.spec.ts, e2e/tests/dashboard-next/inbox-markread.spec.ts, fake-twilio/src/engine/engine.ts:102, e2e/support/preflight.ts, app/src/repos/messagesRepo.ts:10
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

**Root cause (CONFIRMED 2026-06-30, deterministic boundary reproduction).** Candidate #1
in spirit, but NOT via the mid-suite reseed — the failing `dashboard-next/inbox-*` specs
run *alphabetically before* `flows/outbox.spec`, so that reseed cannot affect them. The
real mechanism is identical to the cold-boot flake in
[[e2e-fake-sid-collision-flake]]: the inbound pipeline dedups by `sid#<providerSid>`
pointer (`messagesRepo.append` — a `TransactWrite` conditioned on
`attribute_not_exists` for BOTH the message SK and the pointer), and those pointers
**accumulate in the REUSED DynamoDB container** (`e2e:session`/CI reuse the container;
`db-seed` never CLEARS). `fake-twilio` mints **deterministic monotonic** SIDs
(`SMfake0000000N`) and resets its counter to 0 only on a **process restart** — NOT on
`/control/reset` (confirmed: `engine.reset()` clears threads/timers/profiles but leaves
`sidSeq`). So a freshly-restarted fake re-mints the SAME low SIDs from a prior run. The
`inbox-*` specs run **early** in the suite → mint the **lowest** SIDs → highest odds of
colliding with a stale low-SID pointer left by a prior boot → the genuinely-new TASHA
inbound is dedup-**dropped** (contact unchanged, message gone) → `getByText(<body>)` times
out. (Candidate #2 accumulated-state and #3 SSE-timing were refuted: a primed-clean
container lands every inbound; only a pre-existing pointer drops one.)

Reproduced deterministically against a live `e2e:session` stack: plant a
`sid#SMfake0000000N` pointer for the fake's NEXT SID, send a TASHA inbound → app logs
`message append deduped (provider SID already persisted)` and the body never reaches
`GET /api/contacts/contact-tenant-0001/timeline`. Clear the pointer (`/__dev/reseed`) →
the same send lands.

**Resolution (2026-06-30).** Already fixed at the harness layer by the **globalSetup
clean-slate reseed** added for the cold-boot flake on this same branch
(`e2e/support/preflight.ts` — `POST /__dev/reseed` + `POST /control/reset` once before any
spec). `/__dev/reseed` clears the messages table, so **every** stale `sid#…` pointer is
gone before the first spec sends — removing exactly the pointers the early `inbox-*` specs
would collide with. No per-spec change was needed: within a single run the fake's SID
counter is monotonic and no spec calls `/control/reset`, so once the container starts
clean there is no intra-run collision source. A per-file reset+reseed would be redundant
and is deliberately NOT added (YAGNI).

Verified: (a) deterministic A/B — a stale pointer planted at the fake's next SID drops a
raw inbound, but the `inbox-*` specs planted the same way go **green** because globalSetup
clears it first; (b) the two specs pass in isolation (3 passed); (c) the full
`npm run e2e` is green 3×/3 (33/33), with `inbox-comms` + both `inbox-markread` tests
passing every run. This and [[e2e-fake-sid-collision-flake]] are the same harness bug
surfacing in two places; both are closed by the one globalSetup reseed.
