# Voice Extraction Adapter - Design

Date: 2026-07-18 (rev 2 - Cameron picked the all-3-layers attribution posture)
Status: APPROVED direction - plan next
Parent: docs/superpowers/specs/2026-07-15-conversation-fact-extraction-design.md
(section 8 promised this slice). Builds ON feat/conversation-fact-extraction
(post second main sync @624eb76, which brought in voice-transcription-voicemail).
Also folds in the open UI nit from the extraction verdict.

## 1. What this adds

When a voice transcript persists (call or voicemail), the same AI extraction
pipeline runs over the conversation - and extraction transcripts become
CHANNEL-MIXED: any run (SMS- or voice-triggered) now sees both texts and
transcribed calls in one chronological window. Speaker attribution for bridge
calls is fixed in three layers (section 3). Plus one UI fix: the suggestion
chip's action row wraps instead of clipping "View conversation".

## 2. Trigger hook (verified against the merged voice code)

- services/voiceTranscripts.ts persistViTranscript(), in the `saved === true`
  branch (the single funnel both the /voice/intelligence webhook and the
  reconcile job flow through; never-overwrite means it fires at most once per
  call). After emitPersisted(), best-effort try/catch:
  scheduleExtraction(entry.conversationId, 'voice', now) - NO debounce.
  Gated on config.aiExtractionEnabled. No conversation-type lookup here: the
  job's existing contact-type guard already no-ops landlord/team calls.
- Masked relay calls never reach the hook (refused earlier). Failed
  transcripts never schedule (different branch).

## 3. Speaker attribution - three layers (Cameron's pick, 2026-07-18)

LAYER 1 - deterministic roles at the source (kills the problem for new calls):
- The app originates BOTH legs of a founder-bridge call, so at recording
  creation time the staff leg vs client leg is KNOWN. Twilio dual-channel
  recordings document a channel convention (first channel = the leg the
  recording started on); VI sentences carry the raw mediaChannel int.
- The recording-creation site persists a channel->role map onto the call
  MessageItem (new flexible-doc attr `transcript_channel_roles`, e.g.
  { "1": "staff", "2": "client" }) WHEN derivable. joinViSentences() gains an
  optional roles argument: known roles render `Staff: ` / `Client: ` line
  prefixes; absent roles keep today's `Speaker N: ` behavior (graceful
  degrade - never block a transcript on attribution).
- The Twilio channel-order guarantee is verified two ways: (a) a docs-level
  check during the build (research task), (b) a POST-MERGE LIVE VERIFICATION
  step on dev (one real bridged call; confirm the prefixes match who spoke)
  recorded in RUNBOOK - until (b) passes, Layer 3 still protects us.
- Already-stored transcripts keep their Speaker N labels (never-overwrite);
  Layers 2-3 cover them.

LAYER 2 - in-call role inference for unattributed transcripts (no separate
agent): the extraction schema gains `speakerRoles` - when the window contains
`Speaker N:` lines the model MUST first commit to a mapping
{ "Speaker 1": "client"|"staff"|"uncertain", ... } before emitting facts.
The mapping is persisted in the run's audit payload (diagnosable). A separate
role-determination agent is REJECTED: the extractor reads the whole transcript
anyway; a pre-pass doubles cost and adds a disagreement seam for zero benefit
at our volume.

LAYER 3 - inferred roles never direct-write: when the assembled window
contains ANY inferred-role (unknown-speaker) utterances, the ENTIRE run is
demoted to suggest-only (every op:'write' is applied as a suggestion instead;
audit notes the demotion). Granularity rationale: facts are not tied to
single utterances, so run-level demotion is the simple, never-under-protective
rule; the cost of over-demotion is one human click on a suggestion. Known-role
sources (SMS, voicemail, Layer-1-attributed calls) keep the full write policy.

## 4. Transcript assembly becomes channel-mixed (jobs/extraction.ts)

- toUtterance() branches on MessageItem.type:
  - sms/mms: unchanged (speaker staff|client from direction, channel 'sms').
  - call WITH completed transcript, expanded per line, channel 'voice', all
    sharing the call's timestamp:
    - `Staff: ` / `Client: ` prefixes (Layer 1): speaker staff|client, prefix
      stripped from the text.
    - `Speaker N: ` prefixes (legacy/underivable): one utterance per line,
      speaker 'unknown' (NEW union member), prefix KEPT in the text so the
      model can track the speakers across lines.
    - No prefixes (voicemail, single channel): ONE utterance, speaker
      'client' (the caller is the client by construction).
  - call without a completed transcript: skipped.
- TranscriptUtterance.speaker union widens: 'staff' | 'client' | 'unknown'.
- Voice-triggered due items SKIP the "no new client utterances since cursor"
  early-exit (the transcript content is new even though the call row's
  tsMsgId may be older than the cursor). Cursor semantics otherwise
  unchanged.

## 5. Prompt + schema (services/extraction/{prompt,schema}.ts)

- System prompt: "conversation transcript (text messages and phone calls)";
  rules for [unknown]-speaker lines (commit to speakerRoles first; extract
  only facts clearly stated by/about the client; uncertain role -> omit);
  voicemail lines are the client speaking.
- User content renders channel per line: `<at> [<speaker>/<channel>] <text>`.
- Schema: optional `speakerRoles` object (values client|staff|uncertain);
  REQUIRED by prompt when Speaker N lines are present; parse clamps unknown
  keys. Fake driver EXTRACT: protocol unchanged (voicemail utterances are
  'client', so e2e drives the voice path with a marker in a fake voicemail).

## 6. UI nit fix

- SuggestionChip action row: flex-wrap so the third action wraps instead of
  clipping in the narrow Details card. Verify at desktop two-pane width AND
  390px mobile.

## 7. Out of scope

- Retro-attribution of already-stored Speaker N transcripts.
- Any VI request/flow change beyond the role map persist + join prefixes.
- No new config; no debounce for voice.

## 8. Testing

- Unit: role-map persist at recording creation (derivable + underivable);
  joinViSentences with/without roles; adapter expansion of all three prefix
  forms; voicemail attribution; voice freshness-skip; speakerRoles schema
  round-trip; run-level demotion (write ops become suggestions when any
  unknown-speaker utterance is in the window); chip wrap.
- E2E (hermetic; fake VI seams + fake extraction driver): voicemail
  transcript with EXTRACT: marker -> tick -> suggestion; bridge call with
  Staff:/Client: prefixes -> direct write lands; bridge call with Speaker N
  prefixes -> same facts arrive as suggestions (demotion proof).
- Full gates on the synced branch; live self-QA of the chip wrap at both
  widths. Post-merge (RUNBOOK): one real dev bridged call to confirm Layer 1
  prefixes match reality before trusting attribution in prod.
