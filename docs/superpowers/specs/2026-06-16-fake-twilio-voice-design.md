<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-06-18).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted on 2026-06-18. **This file is NOT
> current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Fake-Twilio Voice (+ RCS seams) — Design & Scope

- **Date:** 2026-06-16
- **Status:** Implemented, live-verified & merged to `main` — all 9 plan phases
  complete; the `fake-twilio-voice` branch + worktree were merged and deleted 2026-06-18.
- **Owner:** Cameron Abt
- **Authored with:** Claude Code (brainstorming skill)
- **Builds on:** the fake-twilio mock (SMS/MMS) + fake-phones UI, now merged to `main`
  (specs `2026-06-15-fake-twilio-mock-infrastructure-design.md` and
  `2026-06-15-fake-phones-ui.md`).

---

## 1. Problem & Goal

The fake-twilio mock covers SMS/MMS at HTTP-seam fidelity (the app's real
`TwilioMessagingDriver` + signature middleware run against a local impersonator).
**Voice** is still a `501` stub. We want to extend the mock to exercise the app's
real **Programmable Voice** flows — masked-relay calling and founder-triage —
without a real Twilio account or real phones.

Voice is a **TwiML state machine**, not fire-and-forget like SMS: an inbound call
makes the app return TwiML (`<Dial>`/`<Gather>`/`<Say>`/`<Pause>`/`<Hangup>`), and
the mock must act as Twilio's call engine and *carry it out* — fetch whisper TwiML,
simulate a digit press, drive the bridge outcome, and (for founder-bridge) fire
recording + transcription callbacks.

**Goal:** drive the app's full voice flow through the mock — both bridges, the
whisper/press-1 gate, press-0 escape, the `<Dial action>` bridge outcome, and
founder-bridge recording + transcription — plus the number-provisioning REST that
masked-relay depends on. Driven and tested via control-API endpoints (the scripted
convention). The fake-phones **voice UI is a separate follow-up plan**.

**RCS** is out of scope as real behavior (the app has no RCS integration at all)
and ships only as a documented integration contract + thin `501` seams (§9).

### Success criteria
- A scripted `place-call` through the control API drives the app's real voice
  routes end-to-end: masked-relay answered/missed, press-0 escape, founder-bridge
  answered with a stored recording + saved transcript, missed → push + auto-text.
- Every webhook the mock sends is **signed** and accepted by the app's real
  `twilioSignatureMiddleware` (a tampered one yields a genuine 403).
- The interpreter reads the app's **actual TwiML** (URLs/attributes), so it stays
  correct as the app's voice flow evolves.
- Masked-relay works end-to-end (number provisioning implemented); this should also
  fix the pre-existing `boards.spec.ts` relay-intro failure.
- Nothing new is reachable in production; the single app change (media-fetch SSRF
  allowlist) is fail-closed in prod.

---

## 2. Context: the app's voice surface (verified)

All `/webhooks/twilio/voice*` routes use the same `twilioSignatureMiddleware` as SMS.

- **Inbound** `POST /webhooks/twilio/voice` (`From`,`To`,`CallSid`,`CallStatus`) →
  routes by `To`: a **pool number** → masked-relay (`handleMaskedInbound`); a
  **business number** → founder-triage (`handleFounderTriage`). Returns TwiML.
- **Masked-relay TwiML:** `<Dial callerId=pool record=do-not-record
  answerOnBridge action=/voice/status><Number url=/voice/whisper?… statusCallback
  (ringing)>callee</Number>…</Dial>`. Never recorded.
- **Founder-bridge TwiML:** `<Pause length=preRing><Dial callerId=business
  record=record-from-answer-dual recordingStatusCallback=/voice/recording
  answerOnBridge action=/voice/status><Number url=/voice/whisper?leg=founder
  statusCallback (ringing)>founderCell</Number></Dial>`. Recorded.
- **Whisper** `POST /voice/whisper` (query `callerLabel,conversationId,
  parentCallSid,leg`) → `<Gather numDigits=1 timeout=8 action=/voice/whisper-gate>
  <Say>…press 1 [press 0]…</Say></Gather><Hangup/>`.
- **Whisper-gate** `POST /voice/whisper-gate` (`Digits` + query) → `1` →
  `<Pause length=1>` (accept; stamps `answered_at`); `0` (masked only) → `<Dial>`
  team numbers; timeout/other/`0`-on-founder → `<Hangup/>`.
- **Status** `POST /voice/status` — the authoritative bridge outcome arrives as the
  `<Dial action>` summary (`CallSid`,`DialCallStatus`,`DialCallDuration`); per-leg
  callbacks subscribe to `ringing` only. Missed → `<Say>`+`<Hangup>` + missed-call
  push + `MISSED_CALL_AUTOTEXT_JOB`.
- **Recording** `POST /voice/recording` (`CallSid`,`RecordingSid`,`RecordingStatus`,
  `RecordingUrl`,`RecordingDuration`) → founder-bridge only (refuses masked) →
  claim-before-fetch → `adapter.getRecordingStream(RecordingUrl)` → media store.
- **Transcription** `POST /voice/transcription` (`CallSid`,`TranscriptionText`/
  `Transcript`) → founder-bridge only → `messages.setCallTranscript` verbatim.
- **Adapter (voice-relevant):** `initiateCall` (`client.calls.create` — currently
  unused by the voice path; TwiML `<Dial>` does the bridging), `getRecordingStream`
  (authenticated fetch, **SSRF-guarded to `api.twilio.com`**, 25 MB cap),
  `provisionPhoneNumber` (`availablePhoneNumbers('US').local.list` +
  `incomingPhoneNumbers.create`), `setVoiceWebhook` (`incomingPhoneNumbers.list` +
  `.update`). The fake currently `501`s `Calls.json`, `AvailablePhoneNumbers`,
  `IncomingPhoneNumbers`.

**RCS:** entirely absent — no send path, no inbound webhook, no adapter method, no
RCS fields parsed anywhere.

---

## 3. Scope

### In scope (v1, voice backend)
- The **`twimlInterpreter`** for the used verb subset (`Dial`,`Number`,`Gather`,
  `Say`,`Pause`,`Hangup`) — reads real TwiML, follows real URLs/attributes.
- The **`CallEngine`**: per-call state + step-drivable lifecycle.
- Both bridges (masked-relay + founder-triage), whisper/press-1, press-0 escape,
  the `<Dial action>` bridge outcome, recording + transcription (founder-bridge).
- **Number provisioning** REST (`AvailablePhoneNumbers`, `IncomingPhoneNumbers`)
  so masked-relay pool setup works end-to-end.
- The **media-fetch SSRF dev-override** (§6) so the app can fetch a fake recording.
- A **recording-serve** endpoint + a canned `audio/mpeg` asset.
- Voice **control API** (place-call + step endpoints) and voice **events** on the
  engine bus. A **real `Calls.json`** outbound-origination impersonation (for
  click-to-call — fetches the app's TwiML `url` and drives it via the interpreter).
- **RCS scaffold seams** (§9): a documented contract + thin `501`/stub seams.

### Out of scope (deferred)
- **Fake-phones voice UI** (place-call button, press-1/0, ringing/answered/missed,
  recording playback, transcript view) — a **separate follow-up plan** (mirrors the
  SMS Plan 1/Plan 2 split).
- **Real RCS** behavior — a future cycle, gated on the app gaining RCS support.

---

## 4. Architecture & components

A new **`CallEngine`** sibling to the messaging engine in the fake-twilio service,
sharing the signed `WebhookDispatcher`, clock, control-surface, and event bus.

- **`fake-twilio/src/engine/twimlInterpreter.ts`** — parses returned TwiML using a
  small, well-maintained XML-parse dependency (e.g. `fast-xml-parser`; pin it, no
  hand-rolled parser) and walks the used verbs, returning a structured plan: which `<Number>`
  legs exist + their `url`(whisper)/`statusCallback`; the `<Dial>` `callerId`,
  `record`, `recordingStatusCallback`, `action`; `<Gather>` `action`/`numDigits`/
  `timeout`; `<Pause>`/`<Say>`/`<Hangup>`. No hardcoded URLs — all read from TwiML.
  Pure, unit-testable against fixtures.
- **`fake-twilio/src/engine/callEngine.ts`** — owns per-call state (`callSid`,
  from/to, legs, status, digit, bridge outcome, recording/transcript) and runs the
  lifecycle as discrete steps: *place → fetch inbound TwiML → interpret → whisper →
  digit → bridge outcome → (recording/transcription)*. Step-drivable (for the future
  UI); a scenario config auto-runs the steps (for scripted tests). Recognizes
  provisioned pool numbers vs business numbers for routing parity with the app.
- **Voice webhook builders** (extend `signer.ts`): `buildInboundVoiceParams`,
  `buildWhisperGateParams` (`Digits`), `buildDialStatusParams`
  (`DialCallStatus`,`DialCallDuration`), `buildRecordingParams`,
  `buildTranscriptionParams` — signed exactly like the SMS builders.
- **REST impersonation** (extend `routes/rest.ts`): `POST /Calls.json` — a **real
  outbound-origination** path (not a stub): mint a `CA…` Call, then fetch the
  app-provided TwiML `url` (POST `CallSid`/`From`/`To`/`CallStatus`) and run it
  through the SAME `twimlInterpreter`/`CallEngine` that drives inbound calls — so
  future **click-to-call** (`adapter.initiateCall`) works through the mock now (§5,
  Flow C). Plus `GET /AvailablePhoneNumbers/US/Local.json`, `POST
  /IncomingPhoneNumbers.json` (+ `list`/`update` if the relay path uses them).
- **Recording serve:** `GET /recordings/:callSid/:recordingSid(.mp3)` → a tiny
  committed canned `audio/mpeg` blob.
- **Number registry:** tracks provisioned pool numbers (number + smsUrl/voiceUrl).

The messaging engine is untouched.

---

## 5. Control API + the two call flows

### Control API (step-drivable, scenario-runnable)
- `POST /control/place-call` — body `{ from (party #), to (pool|business #),
  scenario? }`. The **scenario** supplies the human decisions: `{ answerLeg,
  digit: '1'|'0'|none, ringMs, record?, transcript?, outcome:
  'answered'|'no-answer'|'busy' }`. Returns `{ callSid }`. With a scenario it
  auto-runs; without one it pauses for step calls.
- Step endpoints (future UI): `POST /control/calls/:sid/press {digit}`,
  `/answer {leg}`, `/hangup`.
- `GET /control/calls` — per-call state for assertions + the future UI.
- Voice events on the engine bus: `call.placed/whisper/answered/completed/
  recording/transcript`.

### Flow A — masked relay (pool number)
1. `place-call` tenant → pool #, scenario `{answerLeg: callee, digit:'1'}`.
2. Engine mints `CA…`, POSTs signed `/voice` (`From=tenant,To=pool,CallStatus=ringing`).
3. App returns the masked `<Dial>` TwiML (§2).
4. Interpreter → for the answering callee leg, fetch the whisper (`POST /voice/whisper?…`).
5. Whisper `<Gather>` → engine injects the digit (`POST /voice/whisper-gate Digits=1`) → `<Pause>` accept.
6. Engine POSTs the `<Dial action>` summary to `/voice/status`
   (`DialCallStatus=completed,DialCallDuration=N`) → app finalizes "answered".
   - press-0 → gate `<Dial>` team → engine simulates the team leg + status.
   - timeout/no-answer → `<Hangup/>` → `DialCallStatus=no-answer`. Never recorded.

### Flow B — founder triage (business number, recorded)
1. `place-call` caller → business #, scenario `{answerLeg: founder, digit:'1',
   record:true, transcript:"…"}`.
2. Engine POSTs signed `/voice` → app persists the founder-bridge entry + pre-ring
   push, returns the founder `<Pause>`+`<Dial record=record-from-answer-dual …>` TwiML.
3. Interpreter walks Pause→Dial→Number(founder); fetch whisper (founder leg =
   press-1 only); inject `1` → accept; POST `/voice/status DialCallStatus=completed`.
4. TwiML carried `record` + `recordingStatusCallback` → engine fires `/voice/recording`
   (`RecordingUrl=<fake host>/recordings/<callSid>/<recordingSid>`, …). App's
   `getRecordingStream` fetches it (via the SSRF dev-override, §6) → media store.
5. Engine fires `/voice/transcription` (`Transcript=<scenario text>`) → saved verbatim.
   - digit:none → gate `<Hangup/>` → `DialCallStatus=no-answer` → app missed-call
     push + auto-text job; no recording.

### Flow C — outbound origination (click-to-call, future-proofed now)
The app's future click-to-call will call `adapter.initiateCall({to, from, url})` →
`POST …/Calls.json`. The fake handles it symmetrically: mint `CA…`, return the Call
resource, then fetch the app-provided TwiML `url` (POST `CallSid`/`From`/`To`/
`CallStatus`) and run it through the same interpreter/`CallEngine` (legs, whisper if
present, status/recording per the TwiML + scenario). A `place-call`-style scenario
supplies the human choices. The app has no click-to-call endpoint yet, so this path
is generic (whatever TwiML the app returns is interpreted) and exercised in v1 via a
test fixture; it's ready the moment the app adds the feature. Not on the masked/
founder critical path.

Throughout, the interpreter reads the app's **actual TwiML**; the scenario only
supplies the human choices.

---

## 6. Recording fetch — the SSRF-guard dev override (the one app change)

`getRecordingStream` → `fetchTwilioMediaStream` hard-guards `hostname ===
'api.twilio.com'`. Widen the allowlist to **also** accept the host of
`config.twilioApiBaseUrl` **only when that dev override is set**:

- Allowed media hosts = `api.twilio.com` always **plus** `new
  URL(config.twilioApiBaseUrl).host` when configured. Basic-auth still sent (fake
  ignores it); the 25 MB cap + content-type checks unchanged.
- **Prod-safe:** `TWILIO_API_BASE_URL` is already rejected in production (the SMS
  spec's config fail-closed), so the allowlist can never widen in a deployed env.
  A test asserts production keeps only `api.twilio.com`.
- The fake serves the recording at `GET /recordings/:callSid/:recordingSid(.mp3)`.

Transcription needs no app change (the app accepts `Transcript`/`TranscriptionText`
in the callback body).

---

## 7. Number provisioning (+ the boards bonus)

Masked-relay provisions a pool number (`availablePhoneNumbers('US').local.list` +
`incomingPhoneNumbers.create`). The fake currently `501`s these — almost certainly
why `boards.spec.ts` relay-intro fails. Implement the used subset:

- `GET …/AvailablePhoneNumbers/US/Local.json` → mintable **voice+sms** numbers from
  a deterministic fake pool (a `+1555019xxxx` range, distinct from persona/ad-hoc).
- `POST …/IncomingPhoneNumbers.json` → record number + `smsUrl`/`voiceUrl` in the
  number registry; return a `PN…` SID + `capabilities {voice:true, sms:true}`.
  Implement `list`/`update` if `setVoiceWebhook` is exercised.
- Both engines recognize provisioned pool numbers so inbound **To** a pool routes
  as masked-relay.
- **Verify in the plan:** this should fix `boards.spec.ts` relay-intro. If it does,
  close that known issue; if not, note it stays open.
- Provisioning REST is part of the fake → dev/e2e-only, never deployed.

---

## 8. Error handling & failure injection

Driven by the scenario knobs (and REST/signing posture):
- **Call outcomes:** answered, no-answer (no press / timeout), busy, decline.
- **Press-0 escape** (masked only) → team dial.
- **Recording-fetch failure:** fake returns 404 / oversized → exercises the app's
  recording error path (claim-before-fetch, no partial store).
- **Transcription absent** → app handles a missing transcript gracefully.
- **Signature mismatch** → genuine 403 from the app (proves the middleware).
- **Masked-recording guardrail:** a recording/transcription callback for a masked
  call is refused by the app — the fake should never fire one for a masked call.

---

## 9. RCS scaffold seams (no real behavior)

- **Integration-contract doc** (a section here / a `docs/` note) describing what the
  *app* must add before RCS can be mocked: (a) an outbound **Content API** send path
  (`ContentSid`/rich-card templates, distinct from the SMS Messaging Service),
  (b) an inbound `/webhooks/twilio/rcs` webhook parsing RCS fields (button/postback
  payloads, rich-card replies, capability/typing events), (c) `MessagingAdapter`
  methods + types; and what the *fake* would then add (RCS REST impersonation +
  webhook builders + control endpoints + UI).
- **Thin seams in the fake:** RCS-shaped REST endpoints return `501
  rcs-not-wired-yet`; a `POST /control/send-rcs` stub returns "RCS not implemented —
  see the RCS contract." No engine logic, no UI.
- YAGNI: no speculative RCS behavior against a guessed shape; just a clear on-ramp.

---

## 10. Testing strategy

- **Engine/interpreter units** (in-process, deterministic `ManualClock`): the
  `twimlInterpreter` against representative TwiML fixtures (masked `<Dial>`, founder
  `<Pause>`+`<Dial>`, whisper `<Gather>`, gate `<Pause>`/`<Dial>`/`<Hangup>`) — asserts
  URL/attribute extraction + the step plan; `CallEngine` step sequencing; voice
  signer builders verified against the real `twilio.validateRequest`; number registry.
- **Integration (control-API-over-HTTP — the convention):** `place-call` scenarios
  drive the fake → signed voice webhooks → a real app; assert masked answered/missed,
  press-0 escape, founder-bridge answered + recording stored + transcript saved,
  missed → push + auto-text.
- **e2e proof:** a scripted voice flow against the booted stack (masked answered;
  founder recorded+transcribed). Code now; the live run is a joint step.
- **Regression:** confirm `boards.spec.ts` relay-intro (and the SMS specs) stay/turn
  green with provisioning implemented.

---

## 11. Prod-safety

- The `CallEngine`/interpreter/provisioning/recording-serve/control endpoints all
  live in the fake (dev/e2e-only, boot-guarded `NODE_ENV=production`, never deployed).
- The single app change (media-fetch SSRF allowlist) is gated on the already-prod-
  rejected `TWILIO_API_BASE_URL` → cannot widen in prod (covered by a test).
- No other new prod surface. The e2e-session / `npm run dev -- --mock` wiring already
  points the app at the fake; voice webhooks flow the same signed path.

---

## 12. Decomposition & sequencing

- **This spec → one plan:** the voice backend + RCS seams (phased). The §6 SSRF
  dev-override spike (proving the app can fetch a fake recording) should lead, as the
  one app-side change everything recording-related depends on.
- **Follow-up plan:** the fake-phones **voice UI**.
- **Future cycle:** real RCS, gated on app support (the §9 contract is the on-ramp).

## 13. Resolved decisions

- **XML parsing:** use a small, well-maintained XML-parse dependency (e.g.
  `fast-xml-parser`), pinned — no hand-rolled parser. Verify the interpreter against
  real app TwiML fixtures.
- **`Calls.json`:** implement it as a **real outbound-origination** path now (§4/§5
  Flow C), not a stub, so future click-to-call works through the mock. Generic
  (interprets whatever TwiML the app's `url` returns); exercised in v1 via a test
  fixture; off the masked/founder critical path but built in.
