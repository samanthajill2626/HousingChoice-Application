---
id: app-server-default-keepalive-timeout
title: The app's Express server runs at Node's 5s keepAliveTimeout - the same stalled-client ECONNRESET exposure the fake just fixed, and a known 502 source behind load balancers
type: bug
severity: low
status: resolved
area: app
created: 2026-08-24
resolved: 2026-08-24
refs: app/src/index.ts, fake-twilio/src/server.ts
---

**Resolution (2026-08-24, `fix/test-suite-wave3`).** Applied to BOTH servers
the e2e stack fronts requests through:

- the app server (`app/src/index.ts`): keepAliveTimeout 65s / headersTimeout
  66s, set on the listen() return;
- the Vite dev server (`dashboard/vite.config.ts`, a configureServer plugin):
  same values - the browser and Playwright request contexts pool sockets to
  Vite exactly the way the proxy pools to the app.

The sizing question this issue deferred resolves without knowing the upstream:
CloudFront's origin keep-alive idle default is 5s and an ALB's is 60s, so 65s
satisfies origin-outlives-upstream against EITHER - the rule is strict
inequality, and Node's old 5s default TIED CloudFront's 5s, which is the racy
configuration. No terraform change involved; this is app-process behaviour.

Immediate motivation beyond prophylaxis: two gate failures (2026-08-23 :318,
2026-08-24 :258) whose preserved snapshots showed the placement page stuck at
`status "Loading"` for a full 30s test budget - a hung bundle fetch under
two-suite load, the exact symptom a proxy writing into a FINned keep-alive
socket produces. `pickPlacementStage` now also names that phase explicitly
(waits for the header with its own message) so a recurrence says "the page was
still Loading", never "a button would not click".

Not re-proven by a dedicated A/B here: the mechanism itself was reproduced 3/3
vs 0/3 against the fake-twilio server the same day with the identical values
(see `fake-twilio-control-econnreset-under-suite-load`); these two servers get
the same physics.


**Problem.** While fixing
[`fake-twilio-control-econnreset-under-suite-load`](./fake-twilio-control-econnreset-under-suite-load.md)
(reproduced 2026-08-24: a client whose event loop is stalled writes its next
request into a keep-alive socket the server already FINned, and the kernel
answers RST), it became clear the same default applies to the APP's own
Express server. Any HTTP server on Node's default `keepAliveTimeout` of 5s
carries the exposure; the fake was just the one that got caught.

Two distinct surfaces, different stakes:

1. **Hermetic/e2e (test noise).** Playwright workers talk to the app (via the
   Vite dev proxy) with kept-alive connections. A stalled worker loop plus an
   expired socket is the same deterministic RST the fake produced 3/3. Not yet
   OBSERVED against the app - the fake's control plane took the hit first, its
   calls being sparser - but the mechanism does not care which server it is.
2. **Production (the real stakes).** The deployed app sits behind CloudFront ->
   load balancer. A Node origin whose keep-alive timeout (5s) is SHORTER than
   the upstream's idle timeout is the classic intermittent-502 configuration:
   the origin closes a pooled connection the LB believes is reusable, and the
   next forwarded request takes the reset at the edge. Whether our current
   prod topology exhibits this depends on the LB's idle timeout and retry
   behaviour - NOT verified, and no 502s are currently attributed to it.

**Why filed rather than fixed on the test-hardening branch.** Raising the
fake's timeout is test infrastructure; raising the APP server's changes the
behaviour of every deployed environment and belongs in its own reviewed
change, sized against the actual CloudFront/LB idle timeouts (the rule is
origin keep-alive STRICTLY ABOVE upstream idle).

**Suggested fix.** In the app's boot path, set `server.keepAliveTimeout`
above the upstream idle timeout (AWS guidance for ALB's 60s default is
typically 65s, with `headersTimeout` above that), after confirming the actual
edge configuration in terraform. Reuse the fake's `hardenServerTimeouts`
reasoning; the measured A/B and the mechanism write-up live in the resolved
fake issue.
