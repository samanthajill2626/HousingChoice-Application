---
id: app-server-default-keepalive-timeout
title: The app's Express server runs at Node's 5s keepAliveTimeout - the same stalled-client ECONNRESET exposure the fake just fixed, and a known 502 source behind load balancers
type: bug
severity: low
status: open
area: app
created: 2026-08-24
refs: app/src/index.ts, fake-twilio/src/server.ts
---

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
