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
6. Reliability AND latency: transcript creation is NOT fire-and-forget,
   and it must be fast. The happy path creates the VI transcript INLINE in
   the recording callback (no jobs-pipeline latency floor); failure falls
   back to the jobs pipeline (EventBridge Scheduler -> SQS -> worker) with
   redelivery + DLQ visibility; a delayed reconciliation check self-heals
   a lost webhook. Only the pushes are best-effort.
7. Twilio is NEVER in the read path. Transcript text persists to DynamoDB
   on the call entity (existing `transcript` field); recording audio is
   already mirrored to S3. Conversation loads read only our DB/S3.
8. Architecture: layered reuse (approach 1). New VI webhook endpoint funnels
   into the EXISTING idempotent setCallTranscript seam; voicemail is a call
   entry using the reserved 'voicemail' outcome, riding the existing
   recording mirror, the new VI pipeline, and the existing dashboard call
   bubble (playable recording + collapsible transcript already render).
9. The legacy `/voice/transcription` endpoint is REMOVED (real Twilio never
   had a path to it; fake + tests migrate to the VI shape - see 3.6).
10. Schema flexibility: no schema change is expected, but the implementer
    MAY adjust/extend the data model where that is cleaner or more
    maintainable going forward (human's explicit allowance, 2026-07-17).
11. In-flight visibility: while a transcript has been requested but not
    yet returned, the conversation window MUST show that fact on the call
    entry (a "Transcribing..." indicator), driven by a persisted
    transcript lifecycle status - see 3.8.

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

### 3.2 Create leg (fast inline path + reliable job fallback)

On the existing recording-completed handler (POST /voice/recording), AFTER
the S3 mirror + entity stamp succeed, for founder-bridge (masked:false)
recordings only, and only when `TWILIO_VI_SERVICE_SID` is set:

- FAST PATH: attempt the VI Create Transcript call INLINE (one short API
  call, after recording persistence is already safe - it can never lose
  the recording). On success, enqueue `reconcileVoiceTranscript`
  ({ callSid, transcriptSid, attempt: 1 }, ~10 min) and finish.
- FALLBACK: if the inline create fails (Twilio error, timeout), enqueue
  job `createVoiceTranscript` with `{ callSid, recordingSid }` via the
  standard jobs.enqueue() path and ack the callback normally. Enqueue
  failure is logged and does not fail the recording callback.

Rationale: the jobs pipeline has an EventBridge Scheduler delay floor of
~60s, which would push every transcript a minute later than necessary.
Inline-first keeps the happy path fast (transcripts typically land ~1-2
minutes after hangup, often under a minute for short voicemails); the job
exists purely as the retry/visibility mechanism for failures.

Job handler `createVoiceTranscript` (fallback/retry only):

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
  3. Status 'failed' => stamp transcript_status 'failed' (3.7), 200.
     Any other non-'completed' status => 200 + info (the reconcile job is
     the safety net for stuck transcripts).
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
     attempt+1, delayed ~10 minutes; attempt >= 3: stamp transcript_status
     'failed' (3.7), log a WARN with sids and stop (visible in
     logs/telemetry; recording remains playable).
   - failed => stamp transcript_status 'failed' (3.7), log WARN and stop
     (no transcript for this call).
3. Twilio API errors THROW => standard job redelivery/DLQ.

Whichever leg (webhook or reconcile) runs first wins; the other no-ops on
the never-overwrite guardrail.

### 3.5 Transcript text format

Stored verbatim as plain text on the call entity's existing `transcript`
field. Sentences are joined in order, newline-separated. There are exactly
two media shapes:

- BRIDGE recordings are ALWAYS dual-channel (record-from-answer-dual: the
  caller leg and the founder leg). Each line is prefixed with a stable
  speaker label derived from the sentence's channel: `Caller:` /
  `Receiver:` if the channel->party mapping proves reliable at build time,
  else `Speaker 1:` / `Speaker 2:`.
- VOICEMAIL recordings are the one single-channel case (nobody answered;
  the `<Record>` captures only the caller): no prefixes, just the joined
  text.

No AI cleanup, no summarization - the verbatim rule from M1.9c stands.

### 3.6 Legacy endpoint - REMOVED

`POST /voice/transcription` is DELETED in this feature (decision with the
human, 2026-07-17). The app's TwiML never sets `transcribeCallback`
anywhere, so real Twilio has never had a path to this endpoint - its only
caller is our own fake, which made transcription look "done" when it was
not. Keeping it would confuse future developers. The removal migrates:

- the fake engine's legacy text-in-body transcription flow -> the VI model
  (section 6); legacy builders (`buildTranscriptionParams`) go with it;
- the existing endpoint tests in voiceRecording.test.ts -> equivalent
  coverage against the new VI webhook + persist path (the guardrail
  intents - masked refusal, never-overwrite, signature required - carry
  over 1:1).

### 3.7 Transcript lifecycle status (drives the in-flight UI indicator)

New persisted field on the call entity: `transcript_status`
('pending' | 'completed' | 'failed'; ABSENT when no transcript will ever
be requested - masked calls, VI unconfigured, pre-feature calls).
This is the one schema addition (allowed per decision 10); client-side
inference was rejected because the dashboard cannot know whether VI is
enabled or whether a request failed, and would show a spinner forever.

Transitions (each one emits the SSE update event so the open thread
reflects it live):

- 'pending': stamped by the recording handler's create leg the moment a
  transcript WILL be requested (recording persisted, founder-bridge, VI
  configured) - before the inline create, so the indicator is correct even
  while the fallback job retries.
- 'completed': stamped atomically by the setCallTranscript persist
  (whichever leg wins - webhook or reconcile).
- 'failed': stamped when the pipeline gives up - VI reports the transcript
  failed, or reconcile exhausts its attempts with nothing persisted.
  A later successful persist (e.g. a very late webhook) may still upgrade
  failed -> completed; completed is terminal.

Dashboard rendering on the call bubble (and voicemail bubble - same
component), replacing the spot where the collapsible transcript sits:

- pending -> muted "Transcribing..." indicator.
- completed -> the existing collapsible transcript.
- failed -> muted "Transcript unavailable".
- absent -> nothing (exactly today's rendering).

### 3.8 Latency expectations (user-visible; goes in the RUNBOOK too)

- Call entry in dashboard: at RING time (entity persisted on the inbound
  webhook; SSE-live), outcome stamped at hangup.
- Recording playable: ~5-30s after hangup (Twilio recording processing +
  our S3 mirror), SSE-live.
- Transcript visible: typically ~1-2 minutes after hangup (inline create +
  VI processing, which scales with audio length); short voicemails often
  under a minute. The gap is bridged by the "Transcribing..." indicator
  (3.7), so the wait is visible, not confusing. Reconcile safety net means
  a lost webhook delays a transcript to ~10 minutes, never loses it.

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

- ONE schema addition: `transcript_status` on the call entity (3.7).
  Otherwise reuse: the reserved CallOutcome 'voicemail' (becomes real),
  existing `recording_s3_key` (present => playable), existing `transcript`
  (present => collapsible, never auto-shown - now gated by
  transcript_status per 3.7's rendering table).
  Per decision 10, the implementer may adjust the model further where
  cleaner.
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
- The engine's legacy text-in-body transcription flow and its
  `buildTranscriptionParams` builder are REMOVED; `scenario.transcript`
  now feeds the VI sentences instead. Existing scenarios/specs that relied
  on the legacy flow are migrated to the VI shape in the same change.

## 7. Testing

Unit (app):

- VI webhook: signature required (JSON variant), missing transcript_sid
  400, unknown transcript 200+warn, non-completed 200, completed persists
  joined sentences, masked call refused at persist, redelivery never
  overwrites, API failure 500s.
- Recording handler create leg: stamps transcript_status 'pending' before
  the create; inline create on success enqueues reconcile (no fallback
  job); inline failure enqueues the fallback job and still acks the
  callback; VI-unset skips both and leaves transcript_status absent.
- transcript_status transitions: pending->completed on persist (either
  leg), pending->failed on VI-failed / reconcile exhaustion, late persist
  upgrades failed->completed, completed terminal; SSE emitted on each.
- Dashboard: pending renders "Transcribing...", failed renders
  "Transcript unavailable", completed renders the collapsible transcript,
  absent renders nothing.
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
- viWebhook:'drop' scenario -> the bubble shows "Transcribing..." while
  pending, then the transcript still appears via reconciliation.
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
