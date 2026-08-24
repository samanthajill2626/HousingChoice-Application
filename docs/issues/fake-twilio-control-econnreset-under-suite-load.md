---
id: fake-twilio-control-econnreset-under-suite-load
title: The fake-twilio control plane resets a connection mid-suite, failing registerParty with ECONNRESET
type: bug
severity: low
status: resolved
area: e2e
created: 2026-08-23
resolved: 2026-08-24
refs: e2e/fixtures/fakeTwilio.ts:128, e2e/scenarios/steps.ts:3588, e2e/tests/scenarios/post-tour-application.spec.ts:104
---

**REPRODUCED AND FIXED (2026-08-24, `fix/test-suite-wave3`).** Two probe
designs failed before the mechanism came clear, and the failures are the
finding:

- Timed idle-then-reuse NEVER collides on loopback: 0 resets in 1,600
  cross-process samples jittered to +/-3ms around the expiry instant. The FIN
  is dispatched and the socket evicted long before any timer-scheduled reuse.
- Node also does not close an expired socket AT its keepAliveTimeout - it
  closes it at the next `connectionsCheckingInterval` sweep (~30s), so the
  close instant is not even aligned with the timeout.

What DOES reproduce it, deterministically: a STALLED CLIENT EVENT LOOP. The
server FINs the expired socket while the client process is busy; the FIN sits
undispatched in the kernel; the next request - issued in the same synchronous
tick the stall ends on - is written into the dead socket and the kernel
answers RST. That is what "under full-suite load" meant all along: a busy
Playwright worker, not unlucky timing.

A/B against the real fake app, cross-process, identical 36s client stall:

```
default (keepAliveTimeout 5s):   3/3 ECONNRESET
hardened (65s / headers 66s):    3/3 ok
```

Fix: `hardenServerTimeouts` in fake-twilio/src/server.ts, applied in
index.ts (the entry point both dev.mjs and the e2e session use). 65s clears
every stall a LIVE test can produce - Playwright's per-test budget is 30s, so
no in-test gap can exceed it - with 2x margin, and headersTimeout sits above
keepAliveTimeout per Node's requirement. A unit test pins both properties.

The original caveat ("cannot be proven by a green run") is retired: the fix
was validated against a deterministic reproduction, not a quiet suite.

Spun out: the SAME default exposure exists on the app's own Express server -
see [`app-server-default-keepalive-timeout`](./app-server-default-keepalive-timeout.md).


**Problem.** In a full `npm run e2e`, registering an ad-hoc persona against the
fake-twilio control plane fails at the socket:

```
2) tests\scenarios\post-tour-application.spec.ts:104:1
   happy path: convert -> walk EVERY placement stage in ladder order (no skip)
   -> Awaiting authority approval
   > Tenant texts: "I would like to tour this one" (5317912 Sender Way NW)

   Error: apiRequestContext.post: read ECONNRESET
   Call log:
     - -> POST http://127.0.0.1:9321/control/personas/ad-hoc

   at registerParty (e2e/fixtures/fakeTwilio.ts:128)
   at Scenario.ensureParty (e2e/scenarios/steps.ts:3588)
```

**ECONNRESET is not ECONNREFUSED, and the difference is the whole diagnosis.**
Refused means nothing is listening yet - that is
[`fake-relay-replay-boot-race`](./fake-relay-replay-boot-race.md), a boot-order
problem. RESET means a server that WAS listening accepted the connection and
then dropped it. So this is not the boot race under a new name: the fake was up
and serving, roughly seven minutes into the run.

`registerParty` already tolerates a 409 and an "already exists" body, so
duplicate registration is handled. A transport-level reset is not, and it
arrives as a raw error that fails the test at its first step.

**Evidence (2026-08-23, `fix/test-hardening-wave2`).**

- FULL suite, run 1: 2 failed / 251 passed (21.5m). This was one of the two.
- SOLO, this spec plus `approval-and-move-in.spec.ts` (the other failure) in one
  targeted run: **10 passed (3.0m)**.
- FULL suite, run 2, same commit, nothing changed between them:
  **253 passed (19.0m)**.

1 failure in 2 full runs, green solo - intermittent, which is consistent with a
socket race and rules out anything deterministic.

**CONFIRMED by reading the server, and this is the leading candidate.**
`fake-twilio/src/index.ts` is a bare `app.listen(config.port, ...)` that sets
neither `keepAliveTimeout` nor `headersTimeout`. So it runs at Node's DEFAULT
`server.keepAliveTimeout` of 5 seconds: the server closes an idle keep-alive
socket after 5s, and a client that reuses that socket at the moment it closes
sees the close as ECONNRESET rather than as a clean end.

That is the textbook shape of this symptom, and this suite is exactly the
workload that provokes it - control-plane calls are minutes apart while the run
is busy, so every reused socket is far past 5s idle.

What is confirmed is the EXPOSURE (the server takes the 5s default and does
nothing to mitigate it), not that this particular reset came from it. Nobody has
captured the socket close.

Still to rule out, and cheap:

- The fake restarting or crashing mid-suite. Would appear in its own output, and
  would likely take more than one test down.
- A listen backlog overflow under concurrent workers.

**Suggested fix, once the above are ruled out.** Raise the fake's
`keepAliveTimeout` (with `headersTimeout` above it, which Node requires) so the
SERVER is never the side that closes first. That is the standard Node remedy and
it belongs in the fake, not in a retry at each call site - a blanket retry in
`registerParty` would equally paper over a crash, which needs the opposite fix.

Note the mitigation shrinks the race window rather than removing it, so it
cannot be PROVEN by a green run. Do not close this on one.
