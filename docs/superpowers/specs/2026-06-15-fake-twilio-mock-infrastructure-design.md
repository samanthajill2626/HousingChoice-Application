<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-06-18).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted on 2026-06-18. **This file is NOT
> current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Fake-Twilio Mock Infrastructure — Design & Scope

- **Date:** 2026-06-15
- **Status:** Designed (brainstorming complete) — not yet implemented
- **Owner:** Cameron Abt
- **Authored with:** Claude Code (brainstorming skill)

---

## 1. Problem & Goal

To properly test the platform we need to send and receive SMS, MMS, RCS, voice
calls, and voicemail across **many different numbers acting as different parties**
(landlords, tenants, property managers, and our own staff). We do not have the
real-world infrastructure (multiple physical phones / multiple Twilio numbers /
multiple humans) to drive these flows, and we don't want tests to touch the real
Twilio account.

**Confirmed premise (from codebase investigation):** *all* phone communication —
inbound and outbound SMS, MMS, voice, recordings, and transcriptions — routes
exclusively through **Twilio**, and all Twilio SDK usage is isolated behind a
single adapter ([`app/src/adapters/messaging.ts`](../../../app/src/adapters/messaging.ts),
the only file that imports `twilio`). The one non-Twilio channel is **web push**
([`app/src/adapters/webPush.ts`](../../../app/src/adapters/webPush.ts)) — browser
notifications, not phones, and out of scope here. **RCS is not implemented anywhere
in the codebase today.**

The goal: a mock "switchboard" that impersonates Twilio so we can (a) **interactively**
drive fake phones as any party from a dev web UI and watch the real app react, and
(b) run **scripted, deterministic** multi-party scenarios in CI — both powered by
**one shared engine**.

### Success criteria

- From a dev web page, a human (or agent) can act as any seeded or ad-hoc party,
  send/receive texts, and watch the **real** dashboard and **real** app webhooks
  react — with no real Twilio account.
- The same engine drives headless scripted scenarios that assert app behavior
  deterministically (seeded clock, no `Math.random` in delivery timing).
- Every arrow crossing the Twilio boundary is **real HTTP with a real signature**:
  the app's `TwilioMessagingDriver` and `twilioSignature` middleware run unchanged.
- The mock can **never** run in production (defense in depth, §8).

---

## 2. Context: current architecture (as explored)

All file/line references verified during the investigation that preceded this spec.

- **Outbound seam:** `MessagingAdapter` interface; `TwilioMessagingDriver`
  instantiates the SDK at [`messaging.ts:352`](../../../app/src/adapters/messaging.ts)
  (`this.client = deps.client ?? twilio(...)`) and sends via `client.messages.create`
  at `messaging.ts:359`. `ConsoleMessagingDriver` is the zero-dependency local fake.
- **Inbound seam:** Twilio webhooks land at `POST /webhooks/twilio/sms`
  ([`twilio.ts:285`](../../../app/src/routes/webhooks/twilio.ts)) and status callbacks
  at `POST /webhooks/twilio/status` (`twilio.ts:552`), both behind
  `twilioSignatureMiddleware` ([`twilioSignature.ts:64`](../../../app/src/middleware/twilioSignature.ts),
  `twilio.validateRequest(authToken, signature, url, params)`). Voice routes exist
  under `/webhooks/twilio/voice*` but are **out of scope for v1**.
- **Existing test seams:** a fake adapter / `TwilioClientLike` in
  `app/test/helpers/twilioWebhookHarness.ts`; the `RecordingMessagingDriver`
  decorator + `GET /__dev/outbox` send-log (see §7); the Dockerized hermetic e2e
  harness ([`e2e/`](../../../e2e/)) that orchestrates a multi-container stack
  (app + worker + DynamoDB Local).
- **Config:** Twilio is configured via `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`,
  `TWILIO_API_KEY_SECRET`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`,
  `OUR_PHONE_NUMBERS`, `PUBLIC_BASE_URL` (used to reconstruct the signed webhook URL).

---

## 3. Scope

### In scope (v1)

- **Channels:** SMS and MMS, end-to-end, at full HTTP-seam fidelity.
- **Modes:** both an interactive **fake-phones web UI** and **scripted** scenarios,
  from one shared engine.
- **Parties:** a **seeded roster** (mapped to existing seeded landlords/tenants/PMs
  and their numbers → real app conversations/units) **plus ad-hoc** throwaway numbers.
- **Delivery realism:** configurable async status progression (`queued → sent →
  delivered`) with stall/fail injection.

### Out of scope (v1) — bolt-on later, no rework

- **Voice** (the full TwiML state machine: inbound routing, whisper/press-1 gate,
  press-0 escape, founder triage bridge, recording + transcription callbacks).
- **RCS** (not in the codebase at all yet).
- **Number provisioning** APIs beyond what SMS needs.

These attach at REST routes the fake server scaffolds but answers with an explicit
`501 not-implemented-in-v1`, so the extension points are visible and discoverable.

---

## 4. Architecture (chosen: standalone service over a reusable engine)

Approach **A (standalone `fake-twilio` service) with C's discipline (reusable core)**.
The mock's guts are a framework-agnostic engine module; the standalone HTTP server
is a thin shell over it, and the scripted harness imports the **same** engine
in-process (no HTTP) for speed.

### 4.1 The `fake-twilio` engine (reusable core)

Pure module, no HTTP, fully unit-testable. Five responsibilities:

1. **Persona/number registry** — maps E.164 → persona
   `{ id, label, role: 'landlord'|'tenant'|'pm'|'staff', number, seededRef? }`.
   Loads the seeded roster from existing seed data at boot; `addAdHoc()` mints a
   throwaway number on demand.
2. **Twilio REST impersonation** — handles the exact subset the app calls today:
   `POST …/Accounts/{Sid}/Messages.json` (the `messages.create` the driver uses).
   Returns Twilio-shaped JSON (`SM…` SID, status). Voice / number-provisioning
   routes are scaffolded but return `501 not-implemented-in-v1`.
3. **Conversation store** — **in-memory** per-number threads (both directions,
   status, media). In-memory is deliberate: `e2e:restart` bounces only app+worker,
   so the fake service stays up and threads survive a backend restart; `reset()`
   (wired to reseed) clears it.
4. **Webhook dispatcher + signer** — builds byte-accurate Twilio webhook payloads
   (inbound SMS: `MessageSid, From, To, Body, NumMedia, MediaUrl0…`; status:
   `MessageSid, MessageStatus, ErrorCode?`), computes `X-Twilio-Signature`
   (HMAC-SHA1) against the app's public webhook URL + shared auth token, and POSTs
   to `/webhooks/twilio/sms` and `/webhooks/twilio/status`. **This is the crux that
   makes the real signature middleware run.**
5. **Control surface** — verbs the UI and scripted tests share: `sendAsParty`,
   `listThreads`, `reset`, `addAdHoc`, `setDeliveryOutcome`.

### 4.2 Standalone host

A thin HTTP server wrapping the engine: mounts the REST-impersonation routes + a
control API + serves the web UI (§6). Runs as its own service/container in the
hermetic dev+e2e stack on a fixed port. **Refuses to boot when `NODE_ENV=production`.**

### 4.3 App wiring (minimal — one new optional config)

- Add `TWILIO_API_BASE_URL` (optional). When set, the existing
  `TwilioMessagingDriver` is constructed with a custom `httpClient`/`RequestClient`
  whose host is the fake server, injected at the existing DI seam
  ([`messaging.ts:352`](../../../app/src/adapters/messaging.ts)). **Driver code is
  otherwise untouched.**
- App and fake service **share `TWILIO_AUTH_TOKEN`** so signatures validate.
- `PUBLIC_BASE_URL` = the app address as the fake service reaches it (for the
  signed-URL reconstruction the middleware performs).
- The `TWILIO_API_BASE_URL` override is **hard-ignored / fail-closed** in the
  production config validator.

### 4.4 Primary technical risk (validate first)

`twilio-node` builds hardcoded hosts (`api.twilio.com`, `messaging.twilio.com`).
Redirecting it cleanly to the fake host via a custom `httpClient`/`RequestClient`
(or base-URL shim) is the one non-obvious piece. **A short spike proving REST
redirection + a valid round-trip `messages.create` should precede the rest of the
build.** (Recording fetches are naturally redirected later, since the fake server
supplies the `RecordingUrl`.)

---

## 5. Data flow

### 5.1 Outbound — staff → tenant (human is in the real dashboard)

1. Staff sends a text → real `sendMessage`
   ([`sendMessage.ts:216`](../../../app/src/services/sendMessage.ts)) → real
   `TwilioMessagingDriver` → `client.messages.create` → HTTP to the fake host's
   `…/Messages.json`.
2. Fake validates params, creates a `Message` (`SM…` SID), returns the Twilio-shaped
   JSON the driver expects.
3. Fake **asynchronously** fires status-callback webhooks (`queued → sent →
   delivered`), signed, to `/webhooks/twilio/status` → real middleware validates →
   app advances delivery state.
4. Fake appends the message to the tenant persona's thread → web UI shows it land.

### 5.2 Inbound — tenant → app (human holds the tenant's fake phone)

1. In the UI as the tenant persona, type a reply → control API `sendAsParty`.
2. Fake builds an inbound-SMS webhook, signs it, POSTs to `/webhooks/twilio/sms`.
3. Real signature middleware validates → app processes inbound exactly as in prod →
   may auto-reply, which re-enters the outbound flow (§5.1) and lands on the staff
   dashboard.
4. UI threads update on both sides.

### 5.3 Delivery profiles (configurable async progression)

Each send carries a **delivery profile**:

- **Default:** realistic `queued → sent → delivered` with small **seeded** delays
  (deterministic — no `Math.random`).
- **Overrides:** `stall` at any state; `failed` / `undelivered` with a chosen
  `ErrorCode`.

Scripted tests set the profile via the control API; the UI exposes a per-thread
"next message will…" toggle (normal / stall-at-sent / fail).

---

## 6. Fake-phones web UI

Dev-only page served by the fake-twilio host, held to the project UI quality bar
(self-QA'd via the Playwright harness before any "done" claim).

- **Roster rail** — seeded personas grouped by role (Landlord / Tenant / PM /
  Staff), each with number + unread count; a **＋ Ad-hoc number** button mints a
  throwaway caller.
- **Active phone panel** — SMS-style thread for the selected persona: inbound/
  outbound bubbles, per-message **status chips** (`queued → sent → delivered`, or a
  red `failed`/`undelivered` with its `ErrorCode`), timestamps.
- **Compose bar** — text input + send; **MMS attach** from a small set of **canned
  dev images** (deterministic; no upload plumbing in v1); per-thread
  **delivery-profile toggle**.
- **Live updates** — **Server-Sent Events** from the fake host (one-way, simple);
  the panel reflects webhooks as they fire (you watch `sent → delivered` tick over).
- **Banner** — a subtle "DEV — fake Twilio" marker so it's unmistakably not real.
- **Staff is intentionally not a panel** — staff is the real dashboard, so you watch
  the genuine app react.

---

## 7. Relationship to the existing `/__dev/outbox`

`/__dev/outbox` is today's **proof-of-send** assertion — an **outbound-only** send
log written by the `RecordingMessagingDriver` decorator
([`recordingMessaging.ts`](../../../app/src/adapters/recordingMessaging.ts)) and
exposed by [`dev.ts`](../../../app/src/routes/dev.ts), filterable by `to`/`since`,
cleared by reseed. It is used in three e2e specs:

- [`outbox.spec.ts`](../../../e2e/tests/flows/outbox.spec.ts) — welcome SMS recorded; reseed clears it.
- [`intake-to-reply.spec.ts`](../../../e2e/tests/flows/intake-to-reply.spec.ts) — both auto-welcome and staff reply recorded (the optimistic UI bubble is explicitly *not* proof).
- [`boards.spec.ts`](../../../e2e/tests/dashboard/boards.spec.ts) — relay intro fans out to both tenant and landlord from the pool number.

**Decision: keep it, deprecate it (option #1).** The fake-twilio thread store is a
strict **superset** (outbound + inbound + status). We retain `/__dev/outbox` so the
three already-green specs don't churn, and **signpost it as deprecated** so no new
reliance accrues:

- A `@deprecated` JSDoc tag on the `getOutbox` fixture, the `RecordingMessagingDriver`,
  and the `/__dev/outbox` handler, each pointing to fake-twilio's `listThreads`.
- A header comment in [`outbox.ts`](../../../e2e/fixtures/outbox.ts) and
  [`dev.ts`](../../../app/src/routes/dev.ts): *"Deprecated proof-of-send log —
  outbound-only. New tests should assert against the fake-twilio thread store
  (`listThreads`), which captures both directions + delivery status. Retained only
  so the three pre-existing green specs don't churn."*

New multi-party tests assert against `listThreads`. Eventual migration of the three
specs is a one-line fixture swap (or never — they're cheap). `ConsoleMessagingDriver`
stays as the zero-dependency default when the fake stack isn't booted.

---

## 8. Prod-safety (defense in depth)

Three independent guards; any one failing still leaves two:

1. **Separate artifact** — fake-twilio is its own package/service, simply never
   deployed.
2. **Boot guard** — the service refuses to start under `NODE_ENV=production`.
3. **Config fail-closed** — the app's `TWILIO_API_BASE_URL` override is hard-ignored
   / rejected by the production config validator.

---

## 9. Testing strategy (three tiers, one engine)

- **Engine unit tests** (in-process, no HTTP) — registry mapping; **signer
  correctness** (signature matches what real Twilio produces for a given
  payload+URL+token); payload shape; async status progression on a **seeded clock**.
- **Scripted integration** — drives the mock through the **control API (HTTP)** —
  the single authoring convention for scripted scenarios — to inject inbound texts
  and assert app behavior (inbound creates a conversation; auto-reply fires; failed
  delivery surfaces correctly). No browser. In-process engine calls are reserved for
  pure engine unit tests only (above), so scenarios read identically across
  integration and e2e and there is no second engine-wiring path to drift.
- **e2e (Playwright)** — boot the stack **with** the fake-twilio service; drive the
  real dashboard + the fake-phones UI; assert cross-party flows end to end. Extends
  the existing [`e2e/`](../../../e2e/) harness.

### Failure injection (so error paths actually run)

- `setDeliveryOutcome` → stall / failed / undelivered + `ErrorCode`.
- REST endpoint returns real Twilio-shaped `400`s (e.g. invalid number) so the
  driver's error handling executes.
- STOP / opt-out inbound to exercise opt-out handling.
- Signature mismatches surface as genuine `403`s — proving the middleware, not
  bypassing it.

---

## 10. Terminology note

Per the project glossary, the leasable dwelling is a **`unit`** in code/data
(tenant-facing "home", landlord/staff-facing "listing"). The persona roster links
to seeded **units**/conversations; UI copy for personas follows the audience→noun
table. No new domain noun is introduced by this work.

---

## 11. Open questions / deferred

- Exact `twilio-node` redirection mechanism — settle in the §4.4 spike before the
  rest of the build.
- Voice / RCS / number-provisioning — explicitly deferred; scaffolded `501` routes
  mark the seams.
