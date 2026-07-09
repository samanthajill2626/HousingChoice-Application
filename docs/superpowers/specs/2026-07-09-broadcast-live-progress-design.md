# Broadcast live send progress, recipient identity, and disjoint delivery buckets

Date: 2026-07-09
Status: APPROVED (Cameron, 2026-07-09) - ready for implementation
Branch: feat/broadcast-live-progress (worktree w:/tmp/broadcast-live, cut from main 8c33555)

## 1. Problem

Three user-visible defects on the broadcasts surface, confirmed by code reading:

P1. STALL. Clicking "Send to N tenants" sits on "Sending..." with no feedback for
    the whole fan-out. Root cause: in local dev the app constructs
    InProcessOutboundQueueAdapter (app/src/index.ts ~line 93), whose enqueue()
    AWAITS immediate jobs inline (app/src/adapters/scheduler.ts ~lines 142-148).
    POST /api/broadcasts/:id/send therefore runs the ENTIRE A2P-paced fan-out
    (~1 token/sec per recipient) before responding. Deployed AWS uses SQS and
    returns instantly. The composer already navigates to /broadcasts/:id on
    success (RecipientPreview.tsx onSend) - the user just never gets there until
    the send is over. Once there, nothing ticks: the fan-out loop emits NO SSE
    per recipient; broadcast.updated fires only from the DLR rollup and finalize.

P2. ANONYMOUS ROWS. The results view renders every recipient as "Tenant".
    GET /api/broadcasts/:id/results returns the recipients map keyed by
    contactKey with no name or phone; the dashboard falls back to "Tenant"
    (BroadcastResults.tsx recipientLabel). Rows ARE already links to
    /contacts/:id - there is just nothing human-readable on them.

P3. DOUBLE-COUNTED BADGES. The chips (Recipients / Delivered / Sent / Queued /
    Failed) show a recipient in TWO buckets: the DLR rollup bumps `delivered`
    without decrementing `sent` (app/src/routes/webhooks/twilio.ts ~lines
    1155-1163, "delivered is a refinement"). An 11-recipient broadcast ends
    showing Sent 11 AND Delivered 11. The per-recipient slots underneath are
    already exclusive-state (queued|sent|delivered|failed|skipped, forward-only);
    only the stats rollup double-counts. There is also no Skipped chip, so a
    recipient fenced out mid-send silently breaks "buckets sum to Recipients".

## 2. Goals

- G1: POST /send returns in milliseconds in every environment; the operator
  lands on the broadcast detail page while the send is running.
- G2: The detail page updates live during the send: chips tick (Queued falls,
  Sent rises, then Delivered), recipient rows flip state, roughly once a second
  locally and within a couple of seconds in deployed envs.
- G3: Recipient rows show the tenant's name (primary) and formatted phone
  (secondary) and keep linking to /contacts/:id. Works for HISTORICAL
  broadcasts too.
- G4: The stat chips are mutually exclusive buckets that always sum to
  Recipients: Queued + Sent + Delivered + Failed + Skipped = audience. A fully
  delivered 11-recipient broadcast shows Delivered 11, Sent 0, Queued 0,
  Failed 0, Skipped 0. Historical broadcasts display correctly as well.

## 3. Non-goals

- Broadcast MMS (docs/issues/broadcast-mms.md, deferred).
- Per-recipient inline retry/dismiss on the detail page (disposition stays in
  the tenant's 1:1 thread, unchanged).
- Composer or Settings changes beyond what is specified here.
- Any schema or infra change. No new tables, GSIs, or Terraform.
- Changing A2P pacing or send semantics (order, fences, idempotency).

## 4. Design

### S1. In-process queue adapter: defer immediate dispatch (fixes the stall)

File: app/src/adapters/scheduler.ts (InProcessOutboundQueueAdapter).

- enqueue() with delaySeconds <= 0 no longer awaits dispatch inline. It
  schedules the run on a macrotask (setImmediate) and resolves immediately -
  matching SQS semantics, where enqueue never observes dispatch execution or
  failure.
- The deferred run does, in order: tokenBucket.acquire(1) (the coarse local
  admission gate moves INTO the deferred run - the caller must not pay it),
  then dispatch(wire). Errors are caught and logged (add an optional `logger`
  dep to the constructor, defaulting to the module logger) - they no longer
  propagate to the enqueue caller, because they cannot on the SQS path either.
- Test seam: the adapter tracks in-flight deferred dispatches (a Set of
  promises) and exposes `async settle(): Promise<void>` that resolves when the
  set is empty (draining any dispatches enqueued DURING settling). Unit tests
  of the adapter and any integration test that needs "the job finished" await
  settle() instead of relying on inline execution.
- Update the class docstring: the "A dispatch failure propagates to the
  caller" sentence is no longer true; describe the deferred model and settle().
- DELAYED jobs (delaySeconds > 0) are unchanged (recorded + optional
  scheduleTimer).
- index.ts: pass the logger when constructing the adapter.

Blast radius / required sweep: the class is constructed only in
app/src/index.ts, but tests and e2e specs may IMPLICITLY rely on "POST
returned means the job ran" (broadcast send, relay fan-out, relay intro).
Sweep app/test and e2e/ for such assumptions and convert them to state-based
waiting (expect.poll / waitFor on API state or UI) or adapter.settle() where
the test holds the adapter instance. This ordering change is the point of the
feature - do not "fix" a failing test by re-synchronizing the adapter.

### S2. Per-recipient SSE emits from the fan-out (live ticks, local + e2e)

File: app/src/jobs/broadcastFanOut.ts.

- After EVERY broadcasts.bumpStats() call in the per-recipient loop (sent,
  skipped_opted_out, skipped_no_consent, failed no_contact, failed 30007,
  failed 30005/30006, transient-cap failures in the continuation branch), emit:
    events.emit('broadcast.updated', { broadcastId, status, stats })
  where `stats` is DERIVED (S4) from the ALL_NEW item bumpStats already
  returns (zero extra reads), and `status` is that item's status.
- The transient-defer path (slot stays queued, no bumpStats) emits nothing -
  there is no stat change to report.
- finalize() keeps its emit but switches its stats to the derived form (S4).
- Volume: bounded by A2P pacing (~1 emit/sec locally) - no debounce needed
  server-side; the dashboard already debounces refetches.
- Note (accepted): in DEPLOYED envs the fan-out runs in the worker process and
  these emits do not reach the app's SSE clients (documented single-instance
  seam in app/src/lib/events.ts). Liveness there comes from S3 polling plus
  the DLR-rollup emits (which originate in webhooks = the app process).

### S3. Detail-page polling fallback while sending

File: dashboard/src/routes/broadcasts/useBroadcastResults.ts.

- While the loaded results have status === 'sending', poll fetchResults(true)
  on a ~2000ms interval. Start/stop the interval on status transitions; clear
  it on unmount and when status goes terminal (sent/failed). Poll and SSE both
  funnel through the existing abort- and generation-guarded fetchResults, so
  concurrent triggers stay safe.
- Do not poll on draft/sent/failed. The manual Refresh button stays.

### S4. Derived, disjoint stats (single source of truth = recipients map)

New pure helper, exported from app/src/repos/broadcastsRepo.ts:

    deriveBroadcastStats(b: Pick<BroadcastItem,'recipients'|'stats'>): BroadcastStats

- If the recipients map is EMPTY (drafts, or a legacy row without a map):
  return the persisted stats unchanged (drafts show the audience estimate and
  zero buckets - today's behavior).
- Else compute every field from the map:
    audience  = number of slots
    queued    = slots with status 'queued'
    sent      = slots with status 'sent'
    delivered = slots with status 'delivered'
    failed    = slots with status 'failed'
    skipped_no_consent = slots with status 'skipped' AND errorCode 'no_consent'
    skipped_opted_out  = remaining 'skipped' slots
- Same BroadcastStats shape as today - dashboard types are unchanged.

Apply it EVERYWHERE stats leave the server:
- app/src/routes/broadcasts.ts: toBroadcastResults() and toBroadcastSummary()
  (the byCreated GSI projects ALL, so list items carry the map).
- app/src/routes/webhooks/twilio.ts rollIntoBroadcast(): the broadcast.updated
  emit uses derived stats from the bumpStats ALL_NEW item.
- app/src/jobs/broadcastFanOut.ts: the new S2 emits and finalize()'s emit.

Persisted-counter hygiene (internal bookkeeping only, going forward):
- twilio.ts rollIntoBroadcast delivered case: the delta becomes
  { delivered: 1, ...(fromSent && { sent: -1 }) } - mirroring the existing
  failed case - so persisted counters match the disjoint model on new
  broadcasts. finalize()'s all-failed check (stats.failed >= total) is
  unaffected (failed was already disjoint). Historical rows keep their old
  cumulative persisted stats and STILL DISPLAY correctly because every display
  path derives from the map.

### S5. Recipient enrichment on the results endpoint

File: app/src/routes/broadcasts.ts (GET /broadcasts/:id/results).

- After loading the broadcast, resolve identity for each recipient key:
  - contactId keys: contacts.getById, chunked with bounded concurrency 50
    (same pattern as the send route's explicit-selection fetch).
  - phone#<E164> keys: phone comes from the key (no lookup).
- Each entry in the response's recipients map gains OPTIONAL fields:
    firstName?: string
    lastName?: string
    phone?: string  (E.164)
  Raw fields, SAME shape as the preview endpoint's candidates - display-name
  composition stays in the dashboard (contactDisplayName), which is how the
  composer's review rows already do it. Do not compose a name server-side.
- Unresolvable contact (deleted): omit the fields - the dashboard falls back
  to today's "Tenant" label. Never leak the raw contactKey.
- PII posture: names/phones in an AUTHED response body - same class as the
  existing preview endpoint. Log lines remain IDs/counts only (never names,
  phones, or bodies).
- Cost: bounded by MAX_BROADCAST_RECIPIENTS (1500) worst-case, only on this
  endpoint. Acceptable for a single-operator results view; do not cache.

### S6. Dashboard changes

- dashboard/src/api types: the results recipient entry type gains
  firstName?/lastName?/phone? (mirror the server projection - keep the sync
  comment convention used elsewhere in api/types).
- broadcastFormat.ts toRecipientViews(): compose the row name with the
  existing contactDisplayName(firstName, lastName, phone) helper (the
  composer's review rows already use it); prefer the server-provided phone;
  keep splitContactKey as the fallback for phone# keys; keep failed-first sort.
- BroadcastResults.tsx RecipientRow: name primary + formatted phone secondary
  (formatPhone), visually consistent with the composer's review rows. Keep the
  /contacts/:id link, DeliveryBadge, and the failed "open conversation to
  retry" affordance. Fallback label stays "Tenant" when neither name nor phone
  resolved.
- StatChips.tsx: add a "Skipped" chip (value = skipped_opted_out +
  skipped_no_consent, neutral tone) so buckets visibly sum to Recipients.
  Chip order: Recipients, Delivered, Sent, Queued, Failed, Skipped.
- useBroadcastResults.ts: S3 polling.

### S7. Edge cases and invariants

- Draft (empty map): estimate-based stats, no enrichment, no polling.
- Fast DLR racing the fan-out loop: each emit derives from its own ALL_NEW
  read; the debounced refetch + polling reconcile rows. Worst case one stale
  second - acceptable.
- Continuations/redelivery: terminal-slot idempotency is untouched; emits per
  bumpStats can repeat across passes but stats are derived, so repeated emits
  are self-consistent (never additive drift).
- The buckets invariant (post-send, non-empty map):
  queued + sent + delivered + failed + skipped_opted_out + skipped_no_consent
  == audience == recipients-map size. Pin this in unit tests.
- Send-route behavior (fences, caps, 409 race, markSending, audit) unchanged.

### S8. Testing

Unit (app):
- Adapter: enqueue(delay 0) resolves before dispatch runs; dispatch runs on
  settle(); dispatch failure is logged, not thrown; token acquire happens in
  the deferred run; delayed-job behavior unchanged.
- deriveBroadcastStats: empty-map passthrough; disjoint buckets; the
  invariant above; legacy cumulative persisted stats ignored when map present.
- Fan-out: each transition path emits broadcast.updated with derived stats;
  transient-defer emits nothing; finalize emits derived stats.
- Rollup: delivered decrements sent (persisted); emit carries derived stats.
- Results route: enrichment for contactId keys, phone# keys, deleted-contact
  fallback; no name/phone in logs.

Unit (dashboard):
- StatChips renders Skipped and the disjoint values as given.
- RecipientRow: name+phone rendering, fallbacks, link preserved.
- useBroadcastResults: polls every ~2s while sending, stops on terminal
  status and unmount (fake timers).

E2E (extend e2e/scenarios/broadcasts spec):
- Send a curated broadcast; assert landing on /broadcasts/:id while status is
  still Sending; assert chips tick (Sent rises / Queued falls) during the run;
  assert the terminal state shows Delivered = N, Sent = 0, Queued = 0; assert
  recipient rows show the seeded tenants' names + phones and href to
  /contacts/:id.
- Sweep existing specs for "send POST returned means fan-out done"
  assumptions; convert to waitFor/expect.poll on observable state.

Gates: npm run typecheck + npm test + npm run e2e (bare, real exit codes; e2e
under an outer `timeout 1500`), green on a base freshly merged with main.

## 5. Risk notes for the implementer

- R1: The adapter deferral changes local ordering everywhere immediate jobs
  are enqueued (broadcast send, relay fan-out, relay intro, retries). Expect
  test fallout in the sweep; fix by waiting on state, never by re-inlining.
- R2: Do NOT emit SSE inside the recipient loop before the slot write +
  bumpStats complete - the emitted stats must reflect the persisted state.
- R3: keep bumpStats ReturnValues ALL_NEW (S2/S4 depend on it).
- R4: ASCII only in all new code/comments/spec text (repo rule).
