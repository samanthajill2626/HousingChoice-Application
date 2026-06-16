# RCS integration contract

RCS (Rich Communication Services — Twilio's rich-card / RBM channel, delivered
through the **Content API**) is **not wired** in this codebase. The fake-twilio
mock exposes thin **501 seams** for it (`POST /v1/Content` and
`POST /control/send-rcs`, see `fake-twilio/src/routes/rcs.ts`) that point here
instead of returning a silent 404.

This document is the **on-ramp**: it specifies exactly what the **app** must add
before RCS can be mocked, and what the **fake** would then add to impersonate it.
It is intentionally a contract, not an implementation — YAGNI. No speculative
behavior is built until RCS is actually on the roadmap.

> Terminology note: RCS messages still map onto the existing `unit` / conversation
> thread model; RCS is a richer *transport*, not a new domain entity.

---

## Part A — what the APP must add first

RCS rides Twilio's **Content API** (rich-card / quick-reply templates referenced
by a `ContentSid`), which is a **distinct send path** from today's A2P
**Messaging Service** (`TWILIO_MESSAGING_SERVICE_SID`) SMS/MMS send. The app's
`MessagingAdapter` (`app/src/adapters/messaging.ts` — the single place the Twilio
SDK is imported) is the seam that must grow.

### A1. Outbound: a Content-API send path

- Add a `MessagingAdapter` method (alongside the existing `sendMessage`), e.g.
  `sendRichMessage({ to, contentSid, contentVariables?, from? })`, that creates a
  message referencing a pre-registered `ContentSid` (rich-card / quick-reply
  template) over the RCS-enabled sender — **not** the plain SMS body path.
- New params/types for the rich payload: a `ContentSid`, a
  `contentVariables` map (template substitution), and the RCS-capability /
  fallback-to-SMS semantics. Keep these as new fields/types so the existing
  `SendMessageParams` / `SendMessageResult` contract stays stable.
- Capability gating: RCS sends must degrade to SMS/MMS when the recipient or
  sender is not RCS-capable. Decide this in the adapter (or a service above it),
  not in callers.

### A2. Inbound: an RCS webhook

- Add an inbound webhook route under `app/src/routes/webhooks/` (mirroring
  `twilio.ts` for SMS and `voice.ts` for voice — mounted via
  `app/src/routes/webhooks/index.ts`), e.g. `/webhooks/twilio/rcs`.
- It must parse the RCS-specific inbound fields the SMS webhook does not carry:
  - **button / postback payloads** (a tapped quick-reply or suggested action),
  - **rich-card replies**,
  - **capability events** (recipient became RCS-capable / fell back),
  - **typing / read / delivery events** (RCS read receipts + typing indicators).
- It must reuse the existing webhook security posture: the CloudFront
  origin-secret (`x-origin-verify`) check that gates `/webhooks/*`, and Twilio
  signature (HMAC) validation — the same chain SMS and voice webhooks run.

### A3. `MessagingAdapter` methods + types

- Extend the `MessagingAdapter` interface with the outbound method(s) from A1 and
  any inbound-parse helper types from A2, and implement them in **both** drivers
  (the real Twilio driver and the console/dev driver), so dev and prod stay at
  parity. The console driver should echo RCS sends the way it echoes SMS today.

Once A1–A3 exist, the app can send and receive RCS — and only **then** is there
anything for the fake to impersonate.

---

## Part B — what the FAKE would then add

Mirroring how the fake already impersonates SMS (`routes/rest.ts` +
`routes/control.ts` + the messaging engine) and voice (`routes/voiceRest.ts` +
`routes/voiceControl.ts` + `engine/callEngine.ts`):

### B1. RCS REST impersonation

- Replace the `POST /v1/Content` 501 seam with a real Content-API impersonation:
  accept the template create/send the app's new adapter method calls, mint a
  deterministic `ContentSid` (a counter, like the existing `SM…` / `CA…` / `PN…`
  sids — no `Date.now()` / `Math.random()`), and record the outbound rich
  message in an engine store.

### B2. RCS webhook builders + a signed dispatch

- Add builders (alongside `engine/signer.ts`'s `buildInboundVoiceParams` etc.)
  that construct the inbound RCS webhook params: button/postback payloads,
  rich-card replies, capability and typing/read events.
- Dispatch them through the existing `WebhookDispatcher` (so they carry the
  Twilio signature + `x-origin-verify` origin secret the app's chain requires)
  to the app's new `/webhooks/twilio/rcs` route.

### B3. Control endpoints

- Replace the `POST /control/send-rcs` 501 seam with a real handler that injects
  an inbound RCS event (a tapped button, an inbound rich reply, a capability
  change), mirroring `control.ts`'s `send-as-party` for SMS — same
  `400 {error}` bad-input convention, same engine-driven dispatch.

### B4. UI (fake-phones)

- Surface RCS rich cards / quick-reply buttons in the fake-phones UI and emit
  the corresponding engine events over the existing SSE stream
  (`routes/events.ts`), so a human can tap a button and the app sees the inbound
  postback — the same way the UI drives SMS today.

---

## Status

**Not started.** The seams in `fake-twilio/src/routes/rcs.ts` are the only RCS
code that exists; they 501 and point here. Build Part A before Part B.
