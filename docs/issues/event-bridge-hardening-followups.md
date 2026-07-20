---
id: event-bridge-hardening-followups
title: Event bridge - low-severity hardening follow-ups from adversarial review
type: improvement
severity: low
status: open
area: app
created: 2026-07-20
refs: app/src/routes/internal.ts:47, app/src/lib/config.ts:481, app/src/lib/eventBridge.ts:24
---

**Problem.** The 2026-07-20 adversarial review of the cross-process event
bridge (feat/event-bridge, spec docs/superpowers/specs/2026-07-20-event-bridge-design.md)
found no must-fix defects but four low-severity hardening/ops items worth a
follow-up pass rather than scope-creeping the feature branch:

1. POST /internal/events has no rate limit, and the global express.json()
   (default 100kb cap) parses the body BEFORE the route's bridge-token check.
   Exploiting this requires already holding CF_ORIGIN_SECRET or network
   access inside the box/compose network (the locked chain gates everything
   else), so exposure is minimal - but a router-level limiter and/or a
   tighter body cap for /internal would shrink the parse-then-403 surface.
2. WORKER_POLL_INTERVAL_MS validates only "positive integer" - a value like
   100 (a plausible "meant seconds" typo) makes all three worker polls fire
   every 100ms (~30 listDue queries/sec). Consider a sane floor (>= 1000ms)
   while still allowing the ~1500ms QA cadence the design names.
3. The bridge token is HKDF-derived from SESSION_SECRET (deliberate:
   zero new secret material). Ops note: rotating SESSION_SECRET changes the
   token, so until BOTH containers restart on the new value, worker bridge
   POSTs 403 and live updates silently degrade to next-fetch (best-effort
   semantics, self-heals). Worth one line in any future rotation runbook.
4. Ops awareness (by design, not a defect): the forwarder attaches at the
   appEvents singleton, so EVERY worker emit crosses the bridge - SQS job
   handlers (broadcast fan-out per-recipient message.persisted etc.)
   included, not just the three polls. Volume is A2P-paced (~1 send/sec) and
   poll-scale; a claim-skip backlog bursts at most one POST per listDue row.

Items 5-7 were added by the planner's independent plan-blind adversarial
review (2026-07-20, same day):

5. The REAL public-edge fence for POST /internal/events is the CloudFront
   method allowlist (infra/modules/cloudfront/main.tf: POST only on
   /api/*, /webhooks/*, /auth/*; the default behavior is GET/HEAD/OPTIONS).
   That coupling is load-bearing but lives in Terraform with no code/test
   lock - a future behavior widening silently exposes the route (still
   token-gated). The route header now documents it; a terraform-side comment
   or an infra test pinning the default-behavior method list would close it.
6. lib/eventBridge.ts builds `JSON.stringify({ name, payload })`
   SYNCHRONOUSLY inside the bus listener, before the detached fetch's
   .catch attaches - a non-serializable payload (BigInt/circular) would
   throw out of the emit into the originating job, violating the stated
   fire-and-forget contract. Theoretical today (all payloads are plain
   typed objects); wrapping the body build in the same try/catch posture
   would honor the contract fully.
7. `Number('')` === 0: a BLANK `WORKER_POLL_INTERVAL_MS=` line in a
   hand-edited .env fails loadConfig's positive-integer check in BOTH
   processes - an app-boot crash from a worker-only knob. Consistent with
   the PORT house style, but a `?.trim()`+length guard (the
   EVENT_BRIDGE_URL pattern) would treat blank as unset.

**Suggested fix.** Small standalone pass: add a createRateLimit instance in
front of createInternalRouter's POST handler + consider a floor in the
WORKER_POLL_INTERVAL_MS validation (and the item-7 blank guard); pin the
item-5 CloudFront method-allowlist coupling on the infra side; wrap the
item-6 stringify; fold items 3-4 into operator docs when a rotation runbook
next gets touched. None of this blocks the bridge.
