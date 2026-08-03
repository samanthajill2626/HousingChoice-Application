<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-03).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Relay Number Buying Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relay group texts deliver under A2P 10DLC by never sending from a number until Twilio confirms it is registered, via a warm buffer of pre-registered spare numbers plus a connect-when-ready fallback.

**Architecture:** Extend the existing burn-multiplexing pool. A new `warming` pool state holds a bought+attached number until an Event Streams `number-registration.successful` event promotes it to `active`. Group creation resolves a number in three tiers (reuse -> fresh spare -> connect-when-ready). A fixed buffer of fresh spares (dev 0 / prod 2) is refilled event-driven after each group creation.

**Tech Stack:** TypeScript, Node 24, Express, DynamoDB (single-table, `poolNumbersRepo`), the `twilio` v5 SDK, vitest, the in-repo job queue + webhook harness, Terraform (Event Streams sink).

## Global Constraints

- **ASCII-only** in all specs/prompts/code strings/log messages (repo rule).
- **Buffer target `K`:** dev **0**, prod **2** (`RELAY_SPARE_BUFFER_TARGET`).
- **Never promote `warming -> active` except on the Event Streams registration event.** Timers are for stuck-detection ALERTS only, never promotion.
- **`RELAY_LIVE_PROVISIONING` (existing) gates all number buying** — the whole warm/refill/connect path stays dormant when false (default deployed pre-A2P). Local console driver = true.
- Preserve the **burn-multiplexing invariant** (every `(poolNumber, phone)` pair burned at most once) and the **180-day retirement** window — unchanged.
- **Emit zero 30034** in the normal flow (protects the A2P trust score).
- TDD, explicit-path commits, and `npm run typecheck` must be green per task. Worktree: `w:/tmp/relay-number-strategy`.

## File structure (decomposition)

- `app/src/adapters/messaging.ts` — **+** `attachToMessagingService(phoneNumberSid)`, **+** `detachFromMessagingService(phoneNumber)`; fake/console variants. (Sole Twilio-SDK boundary.)
- `app/test/helpers/twilioWebhookHarness.ts` (+ fake-twilio) — emit a synthetic Event Streams `number-registration.successful` for local/e2e.
- `app/src/repos/poolNumbersRepo.ts` — `warming` state, `warming_started_at`, `createWarming`, `promoteToActive`, `listWarming`, `countFreshSpares`, `countWarming`.
- `app/src/routes/webhooks/twilioEvents.ts` — **new** `POST /webhooks/twilio/events` Event Streams sink handler.
- `app/src/services/poolNumbers.ts` — 3-tier `provisionForGroup` (returns a discriminated result), `warmOneNumber`, `refillBufferIfNeeded`, stuck-warming check.
- `app/src/jobs/relayWarm.ts` — **new** `relay.warmNumber` job handler.
- `app/src/services/relayProvisioning.ts` + `app/src/repos/conversationsRepo.ts` — `connecting` relay group state + assign-number-on-ready.
- `app/src/jobs/relayFanOut.ts` / a new flush path — queued-message flush on open.
- `app/src/lib/config.ts` — `RELAY_SPARE_BUFFER_TARGET`, `RELAY_WARMING_MAX_WAIT`, events webhook path.
- `infra/` — Terraform Event Streams Sink (webhook) + Subscription per env.
- `dashboard/src/routes/contact/` + pool admin — connecting-state UI, queued composer, warming counts.
- `e2e/` — connect-when-ready proof spec.

---

### Task 1: Event Streams spike + `attachToMessagingService` adapter method

**Files:**
- Modify: `app/src/adapters/messaging.ts` (add methods near `provisionPhoneNumber` ~532 and the driver interface ~300-430)
- Test: `app/test/messaging.test.ts`
- Doc: append findings to the spec's "Open questions" as resolved.

**Interfaces:**
- Produces: `MessagingDriver.attachToMessagingService(phoneNumberSid: string): Promise<void>` — attaches a purchased number (its `PN...` SID) to the configured Messaging Service; idempotent (treats Twilio error **21710 "already exists"** as success); surfaces **21714 "pool full"** as a thrown `PoolFullError`.
- Produces (documentation only): the confirmed Event Streams event type `com.twilio.messaging.compliance.number-registration.successful` and the payload field carrying the phone number + `messaging_service_sid`.

- [ ] **Step 1: Spike — confirm the Event Streams payload + auth (no code).** Using the Twilio docs / Event Streams schema registry, confirm: (a) the exact JSON field holding the phone number and/or `PN` SID in the v2 `number-registration.successful` payload; (b) how an Event Streams **webhook sink** authenticates its POSTs (it is delivered as a CloudEvents-style batch and does NOT use the classic `X-Twilio-Signature` request-validation flow — determine the actual header/secret). Write the answer as a comment block at the top of the new `twilioEvents.ts` (created in Task 3) or in this task's commit message. This unblocks Task 3's correlation + validation.

- [ ] **Step 2: Write the failing test** in `app/test/messaging.test.ts` — a `describe('attachToMessagingService')`: with a fake Twilio client whose `messaging.v1.services(sid).phoneNumbers.create` is a spy, assert `attachToMessagingService('PN123')` calls it with `{ phoneNumberSid: 'PN123' }`; a second test where the spy throws `{ code: 21710 }` asserts the method resolves (idempotent); a third where it throws `{ code: 21714 }` asserts it rejects with `PoolFullError`. Follow the existing fake-client idiom in this file.

- [ ] **Step 3: Run to verify failure** — `cd w:/tmp/relay-number-strategy/app && npx vitest run test/messaging.test.ts` -> FAIL (method missing).

- [ ] **Step 4: Implement.** On `TwilioMessagingDriver`, add:
```ts
async attachToMessagingService(phoneNumberSid: string): Promise<void> {
  const svc = this.deps.messagingServiceSid;
  if (!svc) throw new Error('attachToMessagingService: no messagingServiceSid configured');
  try {
    await this.client.messaging.v1.services(svc).phoneNumbers.create({ phoneNumberSid });
    this.log.info({ phoneNumberSid, svc }, 'attached number to messaging service');
  } catch (err) {
    const code = errorCodeOf(err);
    if (code === '21710') { this.log.info({ phoneNumberSid }, 'number already attached (21710) - idempotent'); return; }
    if (code === '21714') throw new PoolFullError('messaging service number pool full (21714)');
    throw err;
  }
}
```
Console driver: a no-op that logs. Add `PoolFullError` to the driver's error module. Add the method to the `MessagingDriver` interface. (Provisioning returns the `PN` SID already at `provisionPhoneNumber` -> `sid`; thread it through so callers have the SID to attach.)

- [ ] **Step 5: Run to verify pass + typecheck** — `npx vitest run test/messaging.test.ts` -> PASS; `cd w:/tmp/relay-number-strategy && npm run typecheck` green (callers unchanged this task).

- [ ] **Step 6: Commit** — `git add app/src/adapters/messaging.ts app/test/messaging.test.ts && git commit -m "feat(relay): attachToMessagingService adapter + Event Streams payload spike"`

---

### Task 2: Pool repo - `warming` state, promote, counts

**Files:**
- Modify: `app/src/repos/poolNumbersRepo.ts`
- Test: `app/test/poolNumbersRepo.test.ts` (existing DynamoDB-local harness)

**Interfaces:**
- Produces: `createWarming({ poolNumber, sid, voiceCapable, smsCapable, provisionedVia, tag? }): Promise<PoolNumberItem>` (state `warming`, `warming_started_at = nowIso`, empty burn).
- Produces: `promoteToActive(poolNumber: string): Promise<boolean>` — conditional `warming -> active`; `false` if not `warming` (idempotent for a redelivered event).
- Produces: `listWarming(): Promise<PoolNumberItem[]>`; `countFreshSpares(): Promise<number>` (active AND `attribute_not_exists(burned_phones)`); `countWarming(): Promise<number>`.
- Consumes: existing `listActive`, `burnClaim` (must already skip non-`active`).

- [ ] **Step 1: Write failing tests.** In `poolNumbersRepo.test.ts`: `createWarming` writes state `warming` + `warming_started_at`; it is NOT returned by `listActive` and NOT claimable by `burnClaim`; `promoteToActive` flips warming->active and returns true, a second call returns false (idempotent), and it refuses a non-warming number; `countFreshSpares` counts active+empty-burn only (not warming, not burned actives); `countWarming` counts warming only.

- [ ] **Step 2: Run -> FAIL.** `npx vitest run test/poolNumbersRepo.test.ts`.

- [ ] **Step 3: Implement.** Add `'warming'` to the `lifecycle_state` union type + item docs; add `warming_started_at?: string`. `createWarming` = `PutCommand` with `attribute_not_exists(poolNumber)` guard, `lifecycle_state:'warming'`, `warming_started_at`, `quarantine_until` sentinel (as other creates). `promoteToActive` = `UpdateCommand SET lifecycle_state=:active REMOVE warming_started_at` conditional on `lifecycle_state = :warming`; catch `ConditionalCheckFailedException -> return false`. `listWarming` = `byLifecycleState` GSI query on `warming`. `countFreshSpares` = query active + in-code filter `!burned_phones?.size` (or `attribute_not_exists`) -> length. `countWarming` = `listWarming().length`. Confirm `listActive` already filters to `active` (it does) and `burnClaim`'s condition already requires `lifecycle_state = :active` (it does) - so warming is excluded for free.

- [ ] **Step 4: Run -> PASS + typecheck** (repo-only; service callers unaffected).

- [ ] **Step 5: Commit** — explicit paths.

---

### Task 3: Event Streams webhook - promote `warming -> active`

**Files:**
- Create: `app/src/routes/webhooks/twilioEvents.ts`
- Modify: the webhook router registration (where `/webhooks/twilio` mounts) + `app/src/lib/config.ts` (events path)
- Test: `app/test/twilioEventsWebhook.test.ts` (new; use the webhook harness)

**Interfaces:**
- Produces: `POST /webhooks/twilio/events` — accepts an Event Streams batch; for each `number-registration.successful` event, resolves the phone number, calls `poolNumbers.onNumberRegistered(phoneNumber)`.
- Produces (service): `poolNumbersService.onNumberRegistered(phoneNumber: string): Promise<void>` — `promoteToActive`; if the number is tagged to a `connecting` group, emit a domain event `relay.numberReady` (Task 6 consumes). No-op if already active.

- [ ] **Step 1: Write failing tests** (webhook harness + fake pool service). POST a batch containing one `com.twilio.messaging.compliance.number-registration.successful` whose payload carries a known warming number -> `onNumberRegistered` called with that E.164 and the record promoted to active; an unknown number -> promote returns false, 200, no throw; a non-registration event type -> ignored (200); a de-registration event -> logged only. Assert always HTTP 200 (Event Streams retries on non-2xx).

- [ ] **Step 2: Run -> FAIL.**

- [ ] **Step 3: Implement.** New router `createTwilioEventsRouter({ config, logger, poolNumbersService })`. Parse the CloudEvents batch (array of events, each with `type` + `data`). Use the payload field confirmed in Task 1 to extract the phone number (fall back to looking up by `PN` SID via the record's stored `sid` if the payload gives only the SID). For each `...number-registration.successful`, `await poolNumbersService.onNumberRegistered(number)`. Validate the sink's shared secret/header per Task 1's finding; reject unauthenticated with 403. Always return 200 on handled/ignored events (log at info; a processing error logs at `error` per the taxonomy but still 200 so Event Streams does not hot-loop-retry a poison event - or 5xx only for transient store errors to get a retry: pick per Task 1). Mount under the existing twilio webhook base. Add `onNumberRegistered` to `poolNumbers.ts` (promote + emit `relay.numberReady` when a connecting group is tagged - the emit is a no-op until Task 6 wires the listener).

- [ ] **Step 4: Run -> PASS + typecheck.**

- [ ] **Step 5: Commit.**

---

### Task 4: Config + warm job + refill calc + stuck-warming check

**Files:**
- Modify: `app/src/lib/config.ts` (+ `.env.example`)
- Create: `app/src/jobs/relayWarm.ts`
- Modify: `app/src/services/poolNumbers.ts` (`warmOneNumber`, `refillBufferIfNeeded`, `flagStuckWarming`)
- Test: `app/test/relayWarm.test.ts` (new), extend `app/test/poolNumbers.service.test.ts`

**Interfaces:**
- Produces: config `relaySpareBufferTarget: number` (env `RELAY_SPARE_BUFFER_TARGET`, default 0 local, resolved 0 dev / 2 prod via `.env.<env>`), `relayWarmingMaxWaitMs: number` (`RELAY_WARMING_MAX_WAIT`, default e.g. 30*60_000).
- Produces: `poolNumbersService.warmOneNumber(): Promise<void>` — buy (`provisionPhoneNumber`) -> `createWarming` -> `attachToMessagingService(sid)`. Gated by `relayLiveProvisioning` (throws `RelayProvisioningDisabledError` otherwise, mirroring provision).
- Produces: `poolNumbersService.refillBufferIfNeeded(): Promise<void>` — `const have = countFreshSpares() + countWarming(); const need = max(0, target - have); enqueue need x relay.warmNumber`.
- Produces: job `relay.warmNumber` -> `warmOneNumber()`.

- [ ] **Step 1: Write failing tests.** (fake repo + fake adapter + fake queue) `warmOneNumber` calls provision, createWarming with the bought number+SID, then attachToMessagingService(sid) in that order; it throws when `relayLiveProvisioning=false`. `refillBufferIfNeeded`: target 2, have 0 -> enqueues 2 warm jobs; target 2, 1 fresh + 1 warming -> enqueues 0 (debounce: warming counts); target 0 (dev) -> enqueues 0 regardless. `flagStuckWarming` logs an `error` for a warming record older than `relayWarmingMaxWaitMs` and skips fresh ones.

- [ ] **Step 2: Run -> FAIL.**

- [ ] **Step 3: Implement.** Config: add the two keys with per-env resolution (follow the existing numeric-env pattern; `.env.example` documents dev 0 / prod 2). `warmOneNumber`: reuse the existing provision path's buy + voice-capability check, but persist via `createWarming` (NOT the active create) and then `attachToMessagingService(candidate.sid)`; do NOT wire webhooks-for-voice here differently than provision does. `refillBufferIfNeeded`: the count+enqueue above; enqueue `relay.warmNumber` with `enqueueImmediate`. `flagStuckWarming`: iterate `listWarming()`, compare `warming_started_at` to `now - maxWait`, `log.error({ event:'relay_warm_stuck', poolNumber })`. Register the `relay.warmNumber` handler in the worker handler list.

- [ ] **Step 4: Run -> PASS + typecheck.**

- [ ] **Step 5: Commit.**

---

### Task 5: Three-tier `provisionForGroup` + refill trigger

**Files:**
- Modify: `app/src/services/poolNumbers.ts` (`provisionForGroup`)
- Test: `app/test/poolNumbers.service.test.ts`

**Interfaces:**
- Produces (CHANGED return type): `provisionForGroup(rosterPhones, tag?): Promise<ProvisionResult>` where
  `type ProvisionResult = { kind: 'assigned'; poolNumber; record; provisioned: boolean } | { kind: 'needs_connecting' }`.
  Tier 1 reuse (prefer already-burned actives) -> tier 2 fresh spare -> else `{ kind: 'needs_connecting' }` (NO throw, NO inline buy). After resolving, `await refillBufferIfNeeded()` (fire-and-forget-safe; awaited so the enqueue lands).
- Consumes: `refillBufferIfNeeded` (Task 4), repo reuse primitives (existing), `countFreshSpares`.

- [ ] **Step 1: Write failing tests.** Reuse PREFERS an already-burned non-overlapping active over an empty-burn spare (seed one of each; assert the burned one is claimed, the spare untouched). When no active number is un-burned for the roster but a fresh spare exists -> the spare is claimed (`provisioned:false`, kind `assigned`). When NO active number and NO spare -> `{ kind: 'needs_connecting' }` and NO adapter buy call. After any assign, `refillBufferIfNeeded` ran (spy). Dev target 0: a fresh-spare consumption enqueues 0 refills.

- [ ] **Step 2: Run -> FAIL.**

- [ ] **Step 3: Implement.** Split the current reuse loop: first pass over `listActive()` considering only candidates WITH burns (`burned_phones?.size`), non-overlapping -> burnClaim; second pass over empty-burn spares -> burnClaim. If both miss: return `{ kind:'needs_connecting' }` (delete the old "buy fresh" block + the `RelayProvisioningDisabledError` throw from THIS path - buying now only happens via `warmOneNumber`). Wrap the return so every path calls `await this.refillBufferIfNeeded()` before returning. Update the guard for empty roster (keep). Note: `provisionForGroup` callers change in Task 6.

- [ ] **Step 4: Run -> PASS + typecheck** (callers in relayProvisioning break; Task 6 fixes - if red, do 6 next; note it).

- [ ] **Step 5: Commit.**

---

### Task 6: Connecting relay groups + assign-on-ready

**Files:**
- Modify: `app/src/services/relayProvisioning.ts`, `app/src/repos/conversationsRepo.ts`, the routes that create relay groups (`tours.ts`, `placements.ts`, `relayGroups.ts`) only where they handle the provision result
- Test: `app/test/placementsRelay.test.ts` / `app/test/relayProvisioning.test.ts`

**Interfaces:**
- Produces: a `connecting` relay group - `createRelayGroup` accepts no `pool_number` and sets `relay_status = 'relay_group#connecting'` (new value); `assignPoolNumberAndOpen(conversationId, poolNumber)` sets pool_number + `relay_status = 'relay_group#open'` conditional on current `connecting`.
- Produces: listener for `relay.numberReady` (emitted by Task 3 `onNumberRegistered`): find the connecting group tagged to that number, `assignPoolNumberAndOpen`, then `enqueueImmediate(RELAY_INTRO_JOB, ...)`.
- Consumes: `provisionForGroup` `ProvisionResult` (Task 5).

- [ ] **Step 1: Write failing tests.** `provisionRelayGroup`: when `provisionForGroup` returns `assigned` -> today's behavior (group open + intro enqueued). When `needs_connecting` -> a group is created in `connecting` state with NO pool number, and a `relay.warmNumber` job is enqueued TAGGED to this conversation (so its promotion routes back). On a `relay.numberReady` for that tagged number -> the group flips to open, pool_number set, intro enqueued. A group left `connecting` past `relayWarmingMaxWaitMs` is flagged (attention/error).

- [ ] **Step 2: Run -> FAIL.**

- [ ] **Step 3: Implement.** In `provisionRelayGroup`: branch on the result kind. `needs_connecting` path: `createRelayGroup` in connecting state; enqueue `relay.warmNumber` carrying `{ conversationId }` so `warmOneNumber` stamps the resulting warming record with the group tag (add a `pending_conversation_id` to the warming record, or maintain a small connecting->number map). When Task 3's `onNumberRegistered` promotes a number that has a `pending_conversation_id`, emit `relay.numberReady({ conversationId, poolNumber })`. Add the listener (in the events wiring) to `assignPoolNumberAndOpen` + enqueue intro. Add the `connecting` relay_status value to `conversationsRepo` + its type docs; ensure inbox/timeline reads tolerate a pool-number-less connecting group (render "connecting"). Stuck-connecting: extend `flagStuckWarming` (or a sibling) to also flag groups stuck in connecting.

- [ ] **Step 4: Run -> PASS + typecheck** (green now across the provision path).

- [ ] **Step 5: Commit.**

---

### Task 7: Queued fire-and-forget messages on a connecting group

**Files:**
- Modify: `app/src/repos/messagesRepo.ts` (a `queued_pending` outbound state), the send service that a connecting group's composer hits, the `relay.numberReady` -> open path (Task 6) to flush
- Test: `app/test/relayQueuedMessages.test.ts` (new)

**Interfaces:**
- Produces: on a `connecting` group, an outbound compose persists the message as `delivery_status: 'queued_pending'` and does NOT call the adapter.
- Produces: `flushQueuedMessages(conversationId)` - on open, after the intro is enqueued, send each `queued_pending` message in `created_at` order via the now-live number (as a relay announcement/fan-out), clearing the pending flag.

- [ ] **Step 1: Write failing tests.** Composing on a connecting group stores a `queued_pending` message and sends nothing (adapter spy not called). On `relay.numberReady`, intro enqueues first, then queued messages flush in creation order via the pool number; a normal (open) group is unaffected (sends immediately). A queued message on a group that never opens stays pending (not lost).

- [ ] **Step 2: Run -> FAIL.**

- [ ] **Step 3: Implement.** Add `queued_pending` to the outbound status handling; the relay send entry point checks the group's relay_status - if `connecting`, persist `queued_pending` and return (surface to UI). `flushQueuedMessages`: query the group's `queued_pending` outbound messages ordered by `created_at`, send each via the relay send path, flip to sent/queued as the send resolves. Call it from the `relay.numberReady` handler AFTER enqueuing the intro (order matters - intro first).

- [ ] **Step 4: Run -> PASS + typecheck.**

- [ ] **Step 5: Commit.**

---

### Task 8: Retirement - explicit Messaging Service detach

**Files:**
- Modify: `app/src/adapters/messaging.ts` (`detachFromMessagingService`), `app/src/services/poolNumbers.ts` (`retireEligible` release path)
- Test: `app/test/poolNumbers.service.test.ts`

**Interfaces:**
- Produces: `MessagingDriver.detachFromMessagingService(phoneNumber: string): Promise<void>` - look up the `PN` SID in the service and `.remove()` it; idempotent (missing = no-op).

- [ ] **Step 1: Write failing tests.** The retirement release path calls `detachFromMessagingService` BEFORE `releasePhoneNumber`; a detach for a number not in the service is a no-op (no throw). Console driver detach = no-op.

- [ ] **Step 2: Run -> FAIL.**

- [ ] **Step 3: Implement.** `detachFromMessagingService`: `services(svc).phoneNumbers.list()` -> find by E.164 -> `services(svc).phoneNumbers(sid).remove()`; catch not-found -> log no-op. In `retireEligible`, between `beginRelease` and `releaseNumber`, call `adapter.detachFromMessagingService(poolNumber)` (best-effort; a detach failure logs but does not abort the Twilio delete, which detaches implicitly anyway).

- [ ] **Step 4: Run -> PASS + typecheck.**

- [ ] **Step 5: Commit.**

---

### Task 9: Fake-twilio - simulate the registration event (local/e2e)

**Files:**
- Modify: the fake-twilio control surface (`app/test/helpers/twilioWebhookHarness.ts` for unit; the fake-twilio dev server + a `POST /control/...` for e2e/local) and a hermetic-only dev endpoint if needed
- Test: covered via Task 3 tests (unit) + Task 11 (e2e)

**Interfaces:**
- Produces (test harness): a helper `emitNumberRegistered(app, phoneNumber)` that POSTs a well-formed `number-registration.successful` batch to `/webhooks/twilio/events` (unit).
- Produces (local/e2e): a fake-twilio control `POST /control/register-number { phoneNumber }` that fires the same event at the app - so a local warm number can be "registered" on demand, and dev K=0 connect-when-ready can be driven end to end.

- [ ] **Step 1: Write a failing e2e-support test** (or a harness unit test) asserting `emitNumberRegistered` drives a warming number to active through the real webhook.

- [ ] **Step 2: Run -> FAIL.**

- [ ] **Step 3: Implement** the harness helper + the fake-twilio control route (gated hermetic-only, mirroring the existing `/control/*` dev surface). Console-driver `attachToMessagingService` already no-ops; the control route supplies the missing "Twilio registered it" signal locally.

- [ ] **Step 4: Run -> PASS + typecheck.**

- [ ] **Step 5: Commit.**

---

### Task 10: Infra - Event Streams Sink + Subscription (Terraform)

**Files:**
- Create: `infra/modules/twilio-events/` (or extend an existing module) + wire in `infra/envs/{dev,prod}`
- Doc: RUNBOOK entry for applying + the per-env sink URLs

**Interfaces:** a `webhook` Sink per env pointing at `https://<env-app-host>/webhooks/twilio/events`, and a Subscription to the compliance number-registration event types. (Event Streams config is account-scoped; dev + prod need distinct sinks.)

- [ ] **Step 1:** Write the Terraform for the Sink (webhook type, destination = the env app URL + shared secret) and the Subscription (event types from Task 1). Use the Twilio Terraform provider if present; else a `null_resource`/provisioning script calling the Twilio API (document which).
- [ ] **Step 2:** `npm run plan -- dev` renders cleanly (do NOT apply - operator step).
- [ ] **Step 3:** Add a RUNBOOK section: apply order (sink before flipping `RELAY_LIVE_PROVISIONING`), the shared-secret wiring into app config, and how to verify a live event.
- [ ] **Step 4: Commit** (code + docs only; **no apply** - flag to Cameron per the no-infra-without-ask rule).

---

### Task 11: Dashboard - connecting state, queued composer, warming counts

**Files:**
- Modify: `dashboard/src/routes/contact/` (timeline/composer for a connecting relay group), pool-admin inventory view
- Test: the relevant `*.test.tsx`

- [ ] **Step 1: Failing tests.** A connecting relay group renders a "Connecting..." state and the composer, when used, shows the message as "Queued - will send when connected" (not sent); pool-admin inventory shows warming + fresh-spare counts alongside active.
- [ ] **Step 2: Run -> FAIL.**
- [ ] **Step 3: Implement** (accessibility-first, ASCII, staff "group text"/"property" copy per the glossary). Connecting banner + queued-message chip; admin counts from the inventory API (extend it to return warming/spare counts).
- [ ] **Step 4: Run dashboard suite + typecheck -> PASS.**
- [ ] **Step 5: Commit.**

---

### Task 12: E2E - connect-when-ready proof

**Files:**
- Create: `e2e/tests/relay-connect-when-ready.spec.ts`

- [ ] **Step 1:** Write the spec: dev stack (K=0) -> open a group text for a fresh pair (no reusable/spare number) -> assert the group shows Connecting and the intro is NOT sent -> queue a fire-and-forget message -> fire the fake-twilio `register-number` control -> assert the group opens, the intro delivers, then the queued message delivers, in order (assert via `/__dev/outbox`). Also assert zero 30034 in the outbox.
- [ ] **Step 2:** `cd w:/tmp/relay-number-strategy && timeout 1500 npm run e2e` (from the worktree) -> green.
- [ ] **Step 3: Commit.**

---

## Self-review notes (applied)

- **Spec coverage:** warming state (T2) + Event Streams gate (T1 spike, T3 webhook, T10 infra, T9 fake) ; 3-tier provisioning (T5); buffer + debounced refill + dev0/prod2 (T4); connect-when-ready (T6) + queued messages (T7); retirement detach (T8); observability via existing taxonomy (stuck logs at error in T4/T6); UI (T11); e2e proof (T12). All spec sections mapped.
- **Ordering caveat:** T5 changes `provisionForGroup`'s return type and breaks `relayProvisioning` callers; T6 fixes them - if executing strictly, keep T5+T6 in one review batch or expect a red typecheck between them (noted in T5 Step 4).
- **Promotion invariant:** the only `warming -> active` writer is `promoteToActive`, called ONLY from `onNumberRegistered` (T3), which is reached ONLY by the Event Streams event - no timer path promotes (Global Constraints upheld). Stuck timers (T4/T6) only ALERT.
- **Type consistency:** `ProvisionResult` (T5) is consumed by T6; `attachToMessagingService(phoneNumberSid)` (T1) consumed by T4; `onNumberRegistered`/`relay.numberReady` (T3) consumed by T6; `flushQueuedMessages` (T7) called from T6's ready path.
