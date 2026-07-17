# Voice transcription (Voice Intelligence) + platform voicemail - design

Date: 2026-07-17
Status: approved design, pre-implementation
Branch: feat/voice-transcription-voicemail (worktree w:/tmp/voice-transcription-voicemail)

## 1. Problem

The app was believed to have working call transcription. It does not, and it
cannot be turned on with configuration alone:

- The app-side transcription endpoint (POST /webhooks/twilio/voice/transcription,
  M1.9c) is persist-only: it saves transcript TEXT delivered in the webhook
  body (TranscriptionText / Transcript / transcript / transcript_text).
- The real transcription engine is Twilio Voice Intelligence (VI), a paid,
  account-configured service. Its completion webhook carries ONLY a
  transcript_sid (JSON body) - never the transcript text. The text must be
  fetched from the VI API (Transcript resource + Sentences subresource).
- Therefore, even after an operator configures VI, the existing endpoint
  would log "empty transcript - nothing to save" and drop every event. The
  hermetic e2e green is real but proves only the legacy text-in-body shape,
  which real Twilio does not send for Dial recordings (the legacy
  `<Record transcribe>` attribute is deprecated and does not apply to Dial
  recordings at all).
- Separately: platform voicemail DOES NOT EXIST. A missed business-line
  (founder-bridge) call plays a goodbye and hangs up, then fires the
  missed-call push + zero-tap auto-text. The CallOutcome value 'voicemail'
  is a reserved, unused seam. PHASE1_CHANGE_ORDER_2's mention of "platform
  voicemail" is drift - it was never built.

## 2. Decisions (locked with the human, 2026-07-17)

1. Scope: build BOTH the VI integration slice (calls) and platform voicemail.
2. Missed business-line flow: voicemail PLUS the existing auto-text and
   missed-call push - all three. The auto-text catches callers who hang up
   without recording; the founder additionally gets a "New voicemail" push
   when a voicemail lands.
3. Voicemail is BUSINESS LINE ONLY. Masked relay calls keep the standing
   never-record / never-transcribe privacy invariant untouched; missed
   masked calls keep today's behavior; the masked-refusal guardrails stay
   authoritative.
4. ONE transcription engine: Voice Intelligence transcribes both bridge-call
   recordings and voicemail recordings. No use of the deprecated
   `<Record transcribe>` attribute.
5. Transcript creation is APP-DRIVEN per recording (not the service-level
   auto_transcribe toggle): deterministic CallSid mapping via CustomerKey,
   per-env VI service isolation, and we control exactly which recordings
   are transcribed.
6. Reliability: transcript creation is NOT fire-and-forget. It rides the
   existing jobs pipeline (EventBridge Scheduler -> SQS -> worker) with
   redelivery + DLQ visibility, plus a delayed reconciliation check that
   self-heals a lost webhook. Only the pushes are best-effort.
7. Twilio is NEVER in the read path. Transcript text persists to DynamoDB
   on the call entity (existing `transcript` field); recording audio is
   already mirrored to S3. Conversation loads read only our DB/S3.
8. Architecture: layered reuse (approach 1). New VI webhook endpoint funnels
   into the EXISTING idempotent setCallTranscript seam; voicemail is a call
   entry using the reserved 'voicemail' outcome, riding the existing
   recording mirror, the new VI pipeline, and the existing dashboard call
   bubble (playable recording + collapsible transcript already render).

## 3. Slice 1 - Voice Intelligence transcription for founder-bridge calls

### 3.1 Config

- New optional env var `TWILIO_VI_SERVICE_SID` (per env; dev and prod get
  their OWN VI service so webhooks never cross environments).
- Unset => the feature is OFF and everything degrades gracefully:
  recordings and voicemails still work; no transcript requests are made;
  no transcripts appear. Config validators accept absence in every env.
- Local hermetic stack: the fake-twilio host impersonates the VI API too.
  The app's Twilio API base-URL override mechanism (TWILIO_API_BASE_URL,
  dev-only, rejected by the prod validator) must also route Intelligence
  API calls (real host: intelligence.twilio.com) to the fake. Prod stays
  locked to real Twilio hosts.

### 3.2 Create leg (reliable, job-based)

On the existing recording-completed handler (POST /voice/recording), AFTER
the S3 mirror + entity stamp succeed, for founder-bridge (masked:false)
recordings only, and only when `TWILIO_VI_SERVICE_SID` is set:

- Enqueue job `createVoiceTranscript` with payload
  `{ callSid, recordingSid }` via the standard jobs.enqueue() path.
  Enqueue failure is logged and does not fail the recording callback
  (the recording is already safe; the DLQ/alarm posture covers job-side
  failures once enqueued).

Job handler `createVoiceTranscript`:

1. Load the call entity by CallSid. Skip (success, log) if: missing, not a
   call, masked, or transcript already present.
2. POST VI Create Transcript:
   `intelligence.v2.transcripts.create({ serviceSid, channel: { media_properties: { source_sid: recordingSid } }, customerKey: callSid })`.
   (Exact SDK parameter casing verified at build time against twilio v6.)
3. On success: enqueue `reconcileVoiceTranscript` with
   `{ callSid, transcriptSid, attempt: 1 }` delayed ~10 minutes.
4. On failure: THROW. The jobs pipeline redelivers (visibility timeout,
   5 receives) and dead-letters into the DLQ, tripping the existing
   dlq-depth alarm. Step 1's checks make redelivery idempotent
   (a duplicate create for the same recording is acceptable and harmless -
   the persist seam's never-overwrite guardrail dedupes downstream;
   CustomerKey ties every copy back to the same call).

### 3.3 Return leg A - the VI webhook

New endpoint: `POST /webhooks/twilio/voice/intelligence`.

- Body is JSON (not form-encoded). Twilio signs it with X-Twilio-Signature;
  validation uses the JSON-body variant of Twilio signature validation over
  the RAW request body. The existing form-encoded middleware is not reused
  blindly - a JSON-aware verifier is added beside it (raw-body capture for
  this route).
- The handler trusts ONLY `transcript_sid` from the payload (the full VI
  webhook schema is not publicly documented; nothing else is assumed).
  Missing transcript_sid => 400.
- Flow:
  1. Fetch the Transcript resource -> status, customer_key (our CallSid),
     and media source recording sid.
  2. Resolve CallSid: customer_key when present; else resolve via the
     recording sid against our call entities; unresolvable => 200 + warn
     (not our transcript - e.g. another tool on the same account).
  3. Status not 'completed' => 200 + info (the reconcile job is the safety
     net for stuck transcripts).
  4. Fetch Sentences (paginate to completion), join into plain text
     (format in 3.5), persist via the existing idempotent
     `setCallTranscript(callSid, text)` - which enforces founder-bridge-only
     (masked refusal) and never-overwrite, and emits `message.persisted`
     for live SSE update.
  5. Twilio API fetch failure mid-flow => 500 so Twilio redelivers;
     idempotent persist makes redelivery safe.
- PII: NEVER log transcript text - lengths and sids only (existing rule).

### 3.4 Return leg B - reconciliation (webhook-loss self-healing)

Job handler `reconcileVoiceTranscript` ({ callSid, transcriptSid, attempt }):

1. Load the call entity; transcript already present => done (webhook won).
2. Fetch the Transcript resource:
   - completed => fetch Sentences, join, persist via setCallTranscript
     (same code path as the webhook handler - shared helper).
   - still queued/in-progress => attempt < 3: re-enqueue self with
     attempt+1, delayed ~10 minutes; attempt >= 3: log a WARN with sids
     and stop (visible in logs/telemetry; recording remains playable).
   - failed => log WARN and stop (no transcript for this call).
3. Twilio API errors THROW => standard job redelivery/DLQ.

Whichever leg (webhook or reconcile) runs first wins; the other no-ops on
the never-overwrite guardrail.

### 3.5 Transcript text format

Stored verbatim as plain text on the call entity's existing `transcript`
field. Sentences are joined in order, newline-separated. When the media has
two channels (dual-channel bridge recordings), each line is prefixed with a
stable speaker label derived from the sentence's channel: `Caller:` /
`Receiver:` if the channel->party mapping proves reliable at build time,
else `Speaker 1:` / `Speaker 2:`. Voicemail recordings are single-channel:
no prefixes, just the joined text. No AI cleanup, no summarization - the
verbatim rule from M1.9c stands.

### 3.6 Legacy endpoint

`POST /voice/transcription` stays exactly as-is (tests included). It remains
the seam for the fake's legacy shape and any manually-configured legacy
source; it is no longer the path real Twilio is expected to use.

## 4. Slice 2 - platform voicemail (business line only)

### 4.1 Caller experience

The missed founder-bridge branch of the Dial-action handler (today: goodbye
`<Say>` + `<Hangup>`) becomes:

- `<Say>` voicemail prompt (new catalog message `voice.voicemail_prompt`,
  e.g. "Sorry we missed you. Please leave a message after the tone and
  we'll get back to you.")
- `<Record maxLength="120" playBeep="true" recordingStatusCallback="<base>/webhooks/twilio/voice/recording" recordingStatusCallbackEvent="completed">`
- `<Say>` thanks (new catalog message `voice.voicemail_thanks`) + `<Hangup>`
  on the Record action (caller pressed # or timed out); a caller who just
  hangs up mid-recording still produces the recording via the callback.

All copy goes through the message catalog (hard rule). The MISS-time side
effects are UNCHANGED and still fire when the Dial summary lands (before
any recording exists): missed-call push + zero-tap auto-text.

Callers who leave no message (hang up at/before the beep, or a zero/near-zero
length recording): Twilio either sends no completed-recording callback or a
sub-second one; recordings under a minimum duration (~2s) are discarded
(logged, not stored) and the call simply stays 'missed' - exactly today's
net behavior, auto-text already sent.

### 4.2 Voicemail recording handling

The voicemail recording arrives at the EXISTING /voice/recording callback
with the same inbound CallSid. Classification: a completed recording for a
founder-bridge call whose outcome is 'missed' IS a voicemail (an answered
bridge produces its recording on a call whose outcome is 'answered'; the
Dial summary always precedes the Record verb, so outcome is settled first).

On a voicemail recording:

1. Mirror to S3 + stamp recording_s3_key + duration (existing code path,
   unchanged).
2. Upgrade the call outcome 'missed' -> 'voicemail' via a CONDITIONAL
   write (only-if-currently-missed), which also makes redelivered
   recording callbacks idempotent.
3. When the conditional upgrade succeeds (first delivery only): fire the
   NEW "New voicemail" push to the founder(s) - best-effort, masked
   content posture identical to the existing missed-call push (no PII in
   the push beyond what the missed-call push already carries), never
   throws.
4. Enqueue `createVoiceTranscript` (slice 1) - voicemail transcription is
   automatic because the create leg keys on founder-bridge + recording,
   not on outcome.

Masked guardrail: unchanged - a recording callback for a masked call is
refused before any of this.

### 4.3 Out-of-scope edges (explicit)

- OUTBOUND founder-bridge calls that go unanswered get NO voicemail (we
  are the caller; the callee's carrier voicemail is their own). The missed
  branch changed here is the INBOUND founder-bridge miss only.
- Masked relay voicemail: excluded by decision 3.
- Ring-through rules, quick-reply sheet, decline-with-message: unchanged /
  still deferred (change orders 1-2).

## 5. Data model and dashboard

- NO schema change. Uses: the reserved CallOutcome 'voicemail' (becomes
  real), existing `recording_s3_key` (present => playable), existing
  `transcript` (present => collapsible, never auto-shown).
- Dashboard: the call bubble renders "Voicemail" labeling when
  outcome === 'voicemail' (wherever outcome currently renders: call bubble
  label/chip, contact timeline row, any outcome text map). Play + transcript
  UI is the existing machinery - no new components.
- Live updates: `message.persisted` on transcript save and the existing
  event on recording stamp already drive SSE refresh.
- GLOSSARY: no new domain nouns expected ("voicemail" is a call outcome,
  not an entity); if implementation coins one, update GLOSSARY.md in the
  same change (standing rule).

## 6. fake-twilio (hermetic verification of the REAL shapes)

The CallEngine + REST surface grow a VI model:

- REST: `POST /v2/Services/:serviceSid/Transcripts` (validates serviceSid
  matches the configured fake service, captures customer_key +
  media source_sid, mints a transcript sid GTxxxx) served on the same fake
  host the app's Intelligence base-URL override points at; plus
  `GET /v2/Transcripts/:sid` (status + customer_key + media) and
  `GET /v2/Transcripts/:sid/Sentences` (sentences built from
  `scenario.transcript`, split into 1-3 sentences to exercise joining).
- Event: after a create, the engine fires the signed JSON webhook
  `POST <app>/webhooks/twilio/voice/intelligence` with `{ transcript_sid }`
  (signature over the raw JSON body, same auth token scheme). A scenario
  knob `viWebhook: 'deliver' | 'drop'` lets tests exercise the
  reconciliation leg (drop => only the reconcile job persists).
- Voicemail: the engine follows the new missed-branch TwiML - plays the
  prompt, "records" for scenario-controlled duration, posts the completed
  recording callback, serves the canned MP3 - driving the real voicemail
  path end-to-end.
- The legacy `/voice/transcription` text-in-body flow remains available in
  the engine (existing scenarios keep passing) but new specs use the VI
  shape.

## 7. Testing

Unit (app):

- VI webhook: signature required (JSON variant), missing transcript_sid
  400, unknown transcript 200+warn, non-completed 200, completed persists
  joined sentences, masked call refused at persist, redelivery never
  overwrites, API failure 500s.
- createVoiceTranscript job: skips (missing/masked/already-transcribed),
  creates with customerKey=callSid, throws on API failure, enqueues
  reconcile.
- reconcileVoiceTranscript job: webhook-won no-op, completed persists,
  in-progress re-enqueues to cap of 3, failed stops with warn.
- Voicemail: missed-branch TwiML contains prompt + Record + callback;
  recording-on-missed upgrades outcome conditionally (idempotent on
  redelivery), fires the voicemail push once, enqueues transcript job;
  sub-minimum-duration recording discarded, outcome stays missed; masked
  recording still refused; outbound miss produces no Record TwiML.
- Config: VI-unset => no jobs enqueued, everything else unchanged.

E2E (hermetic, VI shapes):

- Answered business-line call -> recording -> VI webhook -> transcript
  visible (collapsible) on the call bubble in the conversation thread.
- Missed business-line call -> caller leaves voicemail -> Voicemail bubble
  with playable recording + transcript; auto-text asserted via /__dev/outbox;
  founder pushes not asserted beyond existing push-test seams.
- viWebhook:'drop' scenario -> transcript still appears via reconciliation.
- Masked relay miss unchanged (no voicemail offered).

Gates (profile): npm run typecheck + npm test + timeout 1500 npm run e2e,
bare, from the worktree.

## 8. Operator runbook additions (post-merge, human-gated; NO infra by agents)

- Create a Voice Intelligence service per env (dev, prod) in the Twilio
  console/API; set its webhook_url to
  `<env base URL>/webhooks/twilio/voice/intelligence` (events: transcript
  available); note the GAxxxx service sid.
- Add `TWILIO_VI_SERVICE_SID` to .env.<stage>.example (template-first rule)
  and the real env secrets; deploy.
- Cost note: VI is billed per transcribed hour; only business-line bridge
  calls + voicemails are transcribed (masked relay never).
- RUNBOOK gains: the VI section (setup + how transcripts flow + the
  reconcile safety net) and the founder-facing voicemail behavior
  description. Owed ops recorded in the handback.

## 9. Build-time verification items (watch items for the plan)

- twilio v6 SDK: exact intelligence.v2 create/fetch/sentences call shapes
  and parameter casing; sentences pagination API.
- JSON-body X-Twilio-Signature validation mechanics (raw body capture in
  express for this route; the validator variant used).
- Channel->party mapping reliability for speaker labels (3.5 fallback is
  pre-approved).
- The Intelligence API host override seam: how the twilio client is pointed
  at the fake for intelligence.* calls locally (mechanism exists for
  api.twilio.com; extend, do not fork).
- `<Record>` behavior details: action vs callback ordering, minimum
  duration behavior, hangup-mid-recording delivery.
- EventBridge Scheduler minimum delay (~60s floor; the ~10min reconcile
  delay is well clear).

## 10. Explicitly out of scope

- Masked-relay voicemail or any change to masked privacy invariants.
- AI processing of transcripts (summaries, fact extraction) - the
  conversation-fact-extraction Phase 2 voice adapter consumes the
  transcript field later; this feature only populates it.
- Retention/deletion of Twilio-side recordings/transcripts (door left open;
  Twilio is not in the read path).
- Real-time (during-call) transcription.
- Voicemail greeting customization UI; ring-through rules; quick replies.
