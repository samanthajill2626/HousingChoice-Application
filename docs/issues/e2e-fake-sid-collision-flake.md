---
id: e2e-fake-sid-collision-flake
title: e2e flake — reused DynamoDB container's stale SID pointers drop the first inbound on a freshly-booted fake
type: bug
severity: med
status: resolved
area: e2e
created: 2026-06-30
resolved: 2026-06-30
refs: e2e/support/preflight.ts, scripts/e2e-session.mjs:263, app/scripts/db-seed.ts, app/src/repos/messagesRepo.ts:10
---

**Problem.** A single inbound-using scenario run against a freshly-booted `e2e:session`
stack intermittently failed at `expectRelayedToTeam` → `getByText(<inbound body>)`: the
contact was created but its message never appeared on the timeline. The full suite was
green (earlier specs warm past it), so it read as a cold-boot flake.

**Root cause (confirmed by deterministic reproduction).** fake-twilio assigns
**deterministic, monotonic** SIDs (`SMfake0000000N`) and resets the counter to 1 only
when the fake **process** restarts (NOT on `/control/reset`). The backend dedups inbound
messages by `sid#<providerSid>` pointers (`messagesRepo`). The launcher reuses the
**DynamoDB container** across boots for speed and only runs `db-seed` (idempotent
fixed-ID PutItems — it never CLEARS), so those pointers **accumulate across boots**. A
freshly-restarted fake (counter→1) then re-emits `SMfake00000001…`, which collide with
stale pointers from prior runs → the backend dedups and **drops** the inbound → contact
created, message gone → empty timeline. Reproduced deterministically: restart fake →
send (lands as `SMfake00000001`) → restart fake → send → reuses `SMfake00000001` →
dropped (timeline empty). This is the mock-comms-determinism gotcha, local-dev-only
(CI gets a fresh container); NOT a product bug and NOT a dashboard live-update race
(that hypothesis was investigated and refuted — the message is genuinely dropped, so no
reload/poll recovers it).

**Resolution (2026-06-30).** `e2e/support/preflight.ts` (`globalSetup`) now reseeds the
backend (`POST /__dev/reseed`) and resets the fake (`POST /control/reset`) once before
the suite, after the stale-stack guards pass — clearing the accumulated `sid#…` pointers
so the fresh fake's SID space is clean. Verified: a collision-primed stack that dropped a
raw inbound passes the scenario after the reseed; full suite green (33/33).

**Follow-up (optional, not blocking).** This fixes `npm run e2e`. Ad-hoc dev that drives
the stack directly (`e2e:session` + Playwright MCP, no globalSetup) still accumulates
pointers — run `npm run e2e:reseed` before manual inbound testing (per the
mock-comms-debugging note). A more complete fix would have the `e2e:session` launcher
reseed on every boot so each session is hermetic from the start; deferred to avoid a
shared-infra change while several branches are in flight.
