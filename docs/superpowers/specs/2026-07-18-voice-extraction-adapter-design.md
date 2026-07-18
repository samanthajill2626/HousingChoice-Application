# Voice Extraction Adapter - Design

Date: 2026-07-18
Status: DRAFT - awaiting Cameron's review
Parent: docs/superpowers/specs/2026-07-15-conversation-fact-extraction-design.md
(section 8 promised this slice). Builds ON feat/conversation-fact-extraction
(post second main sync @624eb76, which brought in voice-transcription-voicemail).
Also folds in the open UI nit from the extraction verdict.

## 1. What this adds

When a voice transcript persists (call or voicemail), the same AI extraction
pipeline runs over the conversation - and extraction transcripts become
CHANNEL-MIXED: any run (SMS- or voice-triggered) now sees both texts and
transcribed calls in one chronological window. Plus one UI fix: the suggestion
chip's action row wraps instead of clipping "View conversation" in the narrow
Details card.

## 2. Integration points (verified against the merged voice code)

- Trigger hook: services/voiceTranscripts.ts persistViTranscript(), in the
  `saved === true` branch (the single funnel both the /voice/intelligence
  webhook and the reconcile job flow through; never-overwrite means it fires
  at most once per call). After emitPersisted(), best-effort try/catch:
  scheduleExtraction(entry.conversationId, 'voice', now) - NO debounce (one
  transcript = one run; dueAt = now). Gated on config.aiExtractionEnabled.
  No conversation-type lookup here: the job's existing contact-type guard
  already no-ops landlord/team calls (same defense the SMS path relies on;
  the webhook-side conversation-type gate is an optimization we skip for
  voice to keep the persist path lean).
- Masked relay calls never reach the hook (persistViTranscript refuses them
  earlier). transcript_status 'failed' never schedules (different branch).

## 3. Transcript assembly becomes channel-mixed (jobs/extraction.ts)

- toUtterance() branches on MessageItem.type:
  - sms/mms (direction-attributed): unchanged - one utterance, speaker
    staff|client from direction, channel 'sms'.
  - call WITH transcript (transcript_status 'completed'): expand the stored
    blob into utterances, channel 'voice', all sharing the call's timestamp:
    - No 'Speaker N: ' prefixes (voicemail, single channel): ONE utterance,
      speaker 'client' (the caller is the client by construction - staff do
      not leave voicemails on our own line).
    - 'Speaker N: ' prefixed lines (dual-channel bridge): one utterance per
      line, speaker 'unknown' (NEW union member), text KEEPS the Speaker N
      prefix so the model can track who said what across lines.
  - call WITHOUT a completed transcript: skipped (no utterance).
- TranscriptUtterance.speaker union widens: 'staff' | 'client' | 'unknown'.
- The freshness early-exit ("no client utterances newer than cursor") is
  SKIPPED for channel 'voice' due items: the transcript content is new even
  though the call item's tsMsgId may be older than the cursor (transcripts
  persist minutes after the call row is appended, and an SMS-triggered run
  may have advanced the cursor past it meanwhile). Cursor semantics are
  otherwise unchanged (advance to newest tsMsgId seen).

## 4. Prompt becomes channel-aware (services/extraction/prompt.ts)

- The system prompt's context line describes a "conversation transcript
  (text messages and phone calls)" instead of "SMS conversation".
- New rules: lines marked [unknown] come from a two-party phone call where
  the speakers are labeled Speaker 1/Speaker 2 without role attribution -
  infer from content which speaker is the client; extract ONLY facts clearly
  stated by or about the client; when role inference is uncertain, omit the
  fact entirely. Voicemail lines ([client], channel voice) are the client
  speaking.
- buildExtractionUserContent renders the channel per line:
  `<at> [<speaker>/<channel>] <text>`.
- The fake driver's EXTRACT: protocol is unchanged (it scans client
  utterances; voicemail utterances are 'client', so e2e can drive the voice
  path with an EXTRACT: marker in a fake voicemail transcript).

## 5. UI nit fix (from the extraction verdict)

- SuggestionChip action row: allow flex-wrap (the third action wraps to its
  own line instead of clipping mid-word in the narrow Details card). Verify
  at desktop two-pane width AND 390px mobile.

## 6. Explicitly out of scope

- Role-attributed bridge channels (persisting which VI channel is the
  client) - a voice-pipeline change; file docs/issues/vi-channel-role-attribution.md
  (enhancement) so extraction quality on bridge calls can improve later.
- Any change to VI request/persist flow, transcript storage format, or the
  voice UI. No new config. No debounce for voice.

## 7. Testing

- Unit: joiner-format detection (prefix regex), voicemail-single-utterance
  attribution, bridge multi-utterance 'unknown' expansion, voice-due-item
  freshness-skip, channel-aware prompt rendering, chip wrap (component test
  asserts the wrap class/style).
- E2E (hermetic; fake VI via the voice feature's existing fake seams + fake
  extraction driver): a fake voicemail whose transcript carries an EXTRACT:
  marker -> tick -> suggestion appears; an SMS-triggered run whose window
  contains a transcribed call includes its lines (assert via a suggestion
  sourced from call content).
- Full gates on the synced branch; live self-QA of the chip wrap at both
  widths.
