# Cross-process event bridge: worker emits reach app SSE clients

Date: 2026-07-20
Status: approved (design conversation 2026-07-20; one auth refinement flagged below)
Anchor issue: docs/issues/extraction-writes-no-live-push.md (resolve in this change)

## Problem

The SSE event bus (app/src/lib/events.ts) is an in-process EventEmitter. The
app process serves GET /api/events (SSE) and the worker process runs the
pollers/job handlers - separate processes on the one EC2 box. Every
worker-side emit is therefore invisible to connected dashboards: extraction
`suggestion.updated`, tour-reminder + placement-nudge `scheduled.updated`,
relay-announcement `message.persisted`/`conversation.updated`, and any future
job emit. Observed user-facing on dev 2026-07-20 (extraction write landed in
DynamoDB; the open contact page never updated until refresh).

## Goal

A worker-side emit reaches connected app-process SSE clients with the SAME
event names and payloads the in-app emits use today. Frontend
(EventStreamProvider.tsx + per-page hooks) needs zero change. Delivery is
best-effort: SSE is a refresh hint; clients reconcile via GET. No durable
queue.

## Decision record

- Transport: worker -> app internal HTTP notify. Chosen over (a) a DynamoDB
  Streams consumer in the app (multi-instance-correct but week-class: shard
  iterators/checkpointing without Lambda, streams enabled on 4+ tables via
  terraform, and deriving semantic events like scheduled.updated from row
  changes) and (b) a polled shared events table (2-5s latency, new table +
  TTL + read chatter). The Streams design REMAINS the documented
  multi-instance upgrade; this bridge is one internal call site to swap
  later, not a corner painted (events.ts header keeps saying so).
- Auth: bridge token derived from SESSION_SECRET via HKDF (info label
  'hc-event-bridge'). Both containers share the same .env (docker-compose
  env_file), and SESSION_SECRET is required-at-boot in production, so this
  needs ZERO new secrets and ZERO Parameter Store ops - live on next deploy.
- Auth refinement vs the approved conversation (flagged): the design
  conversation proposed rejecting requests that carry x-origin-verify as a
  CloudFront detector. That header is the LOCKED-CHAIN stamp every
  legitimate request carries (middleware/originSecret.ts runs globally,
  stage 2, exempting only /health and /__dev/*), and CloudFront-forwarded
  requests carry it too - it cannot distinguish CloudFront from internal.
  Instead the internal route stays BEHIND the locked chain: the worker sends
  x-origin-verify from its own config.cfOriginSecret (same .env). Posture is
  strictly stronger: a direct-to-EC2 probe dies at stage 2 (no CF secret);
  a via-CloudFront probe passes stage 2 but dies at the route (no bridge
  token - CloudFront and browsers can never compute it).

## Architecture

Three small pieces; emit call sites in jobs/services change ZERO lines.

### 1. Worker-side forwarder - app/src/lib/eventBridge.ts (new)

- `deriveBridgeToken(sessionSecret: string): string` - shared by both
  processes: `crypto.hkdfSync('sha256', sessionSecret, '', 'hc-event-bridge',
  32)` hex-encoded. Deterministic, no new secret material.
- `attachEventBridge(bus: EventBus, opts: { targetUrl, bridgeToken,
  originSecret, logger }): void` - subscribes ONE listener per AppEventMap
  name (all seven, enumerated from a single exported const array of names -
  see Invariants). Each listener fire-and-forgets:
  `POST <targetUrl>/internal/events` with JSON `{ name, payload }`, headers
  `x-origin-verify: <originSecret>` and `x-bridge-token: <bridgeToken>`,
  `AbortSignal.timeout(2000)`, NO retry, NO queue. Failures (network, non-2xx,
  timeout) log ONE warn line carrying the event NAME only - never the
  payload. A listener must never throw into the emitter (the bus already
  isolates, but the forwarder still catches everything itself).
- The forwarder must not delay the emitting job: the POST promise is
  detached (`void`), never awaited in the emit path.

### 2. Internal route - app/src/routes/internal.ts (new)

`createInternalRouter({ config, events, logger })`, mounted in app.ts at the
ROUTE stage (after body parsers, with the locked chain intact - NEVER
exempted from the origin-secret validator, NEVER under /api requireAuth:
this is process-to-process, no session exists).

`POST /internal/events`:
- Require `x-bridge-token` header, timing-safe-compare against
  deriveBridgeToken(config.sessionSecret). Missing/mismatch -> 403
  `{"error":"forbidden"}` + a WARN that never logs the provided value.
- Body must be `{ name, payload }` where `name` is one of the AppEventMap
  keys (validate against the exported names array) and `payload` is a plain
  object. Bad shape/name -> 400. Payload contents are NOT deep-validated:
  the peer is the same codebase authenticated by the token; the route
  passes it through opaquely (`events.emit(name, payload)` with a narrow
  cast at the one seam).
- Success -> 204, after emitting on the app-process bus. From there the
  existing SSE route (routes/api.ts) delivers to browsers - no new event
  names, so its two handler lists (on + close-off) are UNCHANGED.

### 3. Wiring

- worker.ts: after config load, if `config.eventBridgeUrl` is set, import
  eventBridge.ts and `attachEventBridge(appEvents, ...)` with values from
  config. Unset -> no attach, exactly today's behavior. The bridge attaches
  ONLY in worker.ts - the app process never forwards, so no echo/loop is
  possible.
- config.ts: `eventBridgeUrl?: string` from `EVENT_BRIDGE_URL` (non-secret,
  optional, URL-validated like TWILIO_API_BASE_URL's parse; NOT
  production-rejected - it is the production path). No boot requirement:
  best-effort feature, and deployed envs get it from compose (below), so it
  cannot silently drift off in AWS.
- docker-compose.yml: worker service `environment:` gains
  `EVENT_BRIDGE_URL: http://app:8080` (in-repo, ships with deploy - no
  Parameter Store involvement). App service unchanged.
- scripts/dev.mjs + scripts/e2e-session.mjs + the full-suite e2e stack boot:
  set EVENT_BRIDGE_URL to the app's local URL (the lane/app port each
  already knows) when spawning the WORKER process.
- Poll-interval knob for hermetic testing: the worker's three 60s
  setIntervals (tour reminders, placement nudges, extraction) read ONE env
  knob `WORKER_POLL_INTERVAL_MS` (default 60000, positive-integer-validated)
  so the e2e stack can set it low (~1500ms). One knob, three consumers -
  no per-poll flags.

## Security / PII

- Token: HKDF-derived, hex, compared with crypto.timingSafeEqual on
  equal-length buffers (mirror originSecret.ts's secretsMatch).
- Add `x-bridge-token` (request-header form) to the pino redact lists in
  lib/logger.ts alongside x-origin-verify.
- Event payloads ride through unchanged (conversation.updated carries the
  denormalized preview - DATA for authenticated dashboard clients, doc
  section 9 posture). The bridge transports them ONLY over the compose
  network/localhost, and neither side ever logs a payload.
- The route responds 403 identically for missing and mismatched token.

## Failure semantics (best-effort, by construction)

- App down/restarting: POSTs fail, warn-logged (name only), dropped. Clients
  reconcile on next fetch - the status quo, not a regression.
- Worker down: no emits to bridge; unchanged.
- No retry, no buffering, no backpressure. Emit volume is poll-scale
  (60s cadence), so no batching.

## Testing

Unit (app workspace):
- eventBridge: attaches a listener for EVERY name in the exported names
  array (count assertion so a future 8th event cannot be silently
  unbridged - see Invariants); posts name+payload with both headers;
  network failure/non-2xx/timeout never throws and warns without payload;
  disabled (no attach) when url unset.
- internal route: 403 on missing/wrong token (and nothing logged of the
  value); 400 on unknown name / non-object payload / malformed body; 204 +
  bus listener receives the exact payload on success; route sits behind the
  origin-secret validator (403 without x-origin-verify) - assert via the
  app-level test harness, not by trusting the mount order.
- config: EVENT_BRIDGE_URL parse/validation; WORKER_POLL_INTERVAL_MS
  validation + default.

E2E (hermetic - the harness already runs a real separate worker process):
- New spec: with the stack's WORKER_POLL_INTERVAL_MS set low, seed/arm a
  due worker-side row (pick the cheapest reliable path among the three
  polls for the harness, e.g. a scheduled.updated-producing reminder or the
  extraction fake driver), open the dashboard page that subscribes, and
  assert the page updates WITHOUT reload - the true cross-process proof.
- Existing SSE specs (in-app emit paths: accept/dismiss, dev ticks,
  message flows) keep passing - regression guard on the untouched paths.

## Invariants (enumerated per the planner rule)

Protected state: "an emit reaches connected SSE clients regardless of
emitting process."

Mutation surfaces (emitters):
- App-process emit sites (webhooks, /api routes, dev ticks): unchanged, in
  process, keep working - the bridge never touches them.
- Worker-process emit sites: extraction apply (suggestion.updated),
  tour-reminder poll (scheduled.updated + relay-announcement
  message.persisted/conversation.updated), placement-nudge poll
  (scheduled.updated), SQS job handlers (broadcast.updated,
  message.persisted, conversation.updated, placement.updated...), and any
  FUTURE worker emit - all covered generically because the forwarder
  attaches at the appEvents singleton, not per call site.
- The names array: exported next to AppEventMap with a type-level
  exhaustiveness check (compile error if AppEventMap gains a name the array
  lacks) - this is the one place a new event could silently miss the
  bridge, so the type system owns it, plus the count assertion in tests.

Readers/renderers:
- routes/api.ts SSE handler lists (on + close-off): no new event names ->
  no change; reviewer asserts this explicitly.
- EventStreamProvider.tsx + per-page hooks: zero change expected; reviewer
  asserts no diff under dashboard/src.
- routes/internal.ts is a new reader of the wire shape: allowlist derived
  from the same exported names array, so it cannot drift from the emitter.

## Documentation in the same change

- events.ts header: single-instance section now documents the bridge
  (worker emits arrive via POST /internal/events) and KEEPS the
  multi-instance seam note (Streams consumer replaces this module's
  internals; emitters + SSE route keep their contracts).
- worker.ts extraction block + jobs/extraction.ts + events.ts
  SuggestionUpdatedEvent comment: the "poll-driven emits do not reach app
  SSE clients" caveats are now stale - correct them to describe the bridge.
- docs/issues/extraction-writes-no-live-push.md: status -> resolved, dated
  resolution stamp naming the bridge + this spec.
- No RUNBOOK change: zero operator actions owed (compose + code ride the
  normal deploy).

## Out of scope

- Durable delivery, retries, ordering guarantees (explicitly rejected -
  refresh-hint semantics).
- Multi-instance fan-out (Streams consumer) - seam preserved in events.ts.
- Batching/coalescing of bridge POSTs.
- Any dashboard change.
