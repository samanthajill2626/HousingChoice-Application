<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-07-20).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Voice Extraction Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Voice transcripts (calls + voicemails) feed the existing AI extraction
pipeline with three-layer speaker attribution, and the suggestion chip's action
row stops clipping.

**Architecture:** The voice pipeline's shared persist helper schedules an
immediate (no-debounce) extraction run on transcript save. The extraction job's
transcript assembly becomes channel-mixed (SMS + transcribed calls in one
chronological window) with per-line speaker parsing of three prefix forms
(Staff:/Client: from the new source-attributed role map; Speaker N: legacy ->
'unknown'; unprefixed voicemail -> client). Inferred-role windows demote all
direct writes to suggestions.

**Tech Stack:** Existing branch patterns only - no new deps, no new config, no
new tables.

**Spec:** docs/superpowers/specs/2026-07-18-voice-extraction-adapter-design.md
(rev 2). **This plan builds ON feat/conversation-fact-extraction in
w:/tmp/fact-extraction (base @b8d3572)** - slice-1 extraction code and the
merged voice-transcription code are both present and are the reference
patterns.

## Global Constraints

- ASCII only in added lines (`tr -d '\11\12\15\40-\176' < FILE | wc -c` -> 0).
- Gates bare, never piped: `npm run typecheck`, `npm test`,
  `timeout 1500 npm run e2e` (worktree only).
- Commit discipline: gating bare `git status` before EVERY commit; explicit
  paths; Co-Authored-By trailer naming the authoring model.
- PII: NEVER log transcript text (lengths/sids only) - the voice code's
  standing rule applies to every touched line here.
- No changes to VI request flow, transcript storage format (beyond the new
  optional `transcript_channel_roles` attr), config, or tables.

## Invariant surfaces (spec section 3 Layer 3 - the demotion rule)

The protected invariant is "inferred-role content never direct-writes". Its
mutation surfaces, all covered by tasks below: (a) the apply service's write
path (T4 demotion flag), (b) the suggestion-accept route (UNAFFECTED by
design: accepting is the human act the demotion exists to obtain), (c) the
fake driver / e2e path (T6 proves demotion end-to-end), (d) notes appends and
suggestions are NOT demoted (they are already review-or-additive surfaces).

### Task 1: Role map at the source + role-aware transcript join

**Files:**
- Modify: `app/src/routes/webhooks/voice.ts` (both record-from-answer-dual
  <Dial> sites: the inbound founder-triage bridge (~L561-622) and the outbound
  originate bridge (~L1072-1120))
- Modify: `app/src/repos/messagesRepo.ts` (annotate path only if a helper is
  needed; `transcript_channel_roles` is a flexible-doc attr on the call
  MessageItem - prefer the existing annotateMessage/call-entity persist the
  two sites already use)
- Modify: `app/src/services/voiceTranscripts.ts` (joinViSentences signature +
  persistViTranscript passes roles)
- Test: extend `app/src/services/voiceTranscripts.test.ts` + the voice webhook
  test file (find via `rg -l "record-from-answer-dual" app/test app/src`)

**Interfaces (Produces):**

```ts
// messagesRepo call MessageItem gains (flexible doc, no schema change):
transcript_channel_roles?: Record<string, 'staff' | 'client'>;  // keys: VI mediaChannel ints as strings

// voiceTranscripts.ts
export type ChannelRoles = Record<string, 'staff' | 'client'>;
export function joinViSentences(sentences: ViSentence[], roles?: ChannelRoles): string;
// roles present AND every distinct mediaChannel mapped -> lines prefixed
// 'Staff: ' / 'Client: '; otherwise EXACTLY today's behavior (single channel
// unprefixed; multi-channel 'Speaker N: ').
```

Role orientation per site (Twilio dual-channel <Dial> recording convention:
channel 1 = the leg executing the TwiML (the parent call), channel 2 = the
dialed party - VERIFY against Twilio docs in Step 1 and record the doc URL in
a code comment; if the docs contradict this, stamp per the docs and say so in
the commit body):
- Inbound founder-triage bridge (client called us, we dial the staff cell):
  { "1": "client", "2": "staff" }.
- Outbound originate (we call the staff cell, staff dials through to client):
  { "1": "staff", "2": "client" }.
Stamp `transcript_channel_roles` onto the call entity at each site using the
same persist call that already stamps the call's recording/masked metadata.
persistViTranscript reads `entry.transcript_channel_roles` and passes it to
joinViSentences. Graceful degrade: absent/partial map -> legacy labels.

- [ ] **Step 1:** Docs check (WebFetch Twilio dual-channel recording docs;
  record URL + finding). Write failing tests: joinViSentences with a full
  roles map renders `Client: hi` / `Staff: hello` (channel order irrelevant);
  partial/absent map -> legacy `Speaker N:`; single-channel + roles map still
  unprefixed... NO - single-channel voicemail never has a roles map (no dial),
  pin that assumption instead: roles map with one distinct channel is not
  stamped by any site (assert sites only stamp on the dual-record paths).
  Webhook tests: each <Dial> site stamps its orientation onto the call entity.
- [ ] **Step 2:** Run the two suites - FAIL. **Step 3:** Implement.
- [ ] **Step 4:** Suites + `npm run typecheck` - PASS.
- [ ] **Step 5:** Commit: `feat(voice-extraction): source-attributed channel roles + role-aware join`.

### Task 2: Trigger hook in persistViTranscript

**Files:**
- Modify: `app/src/services/voiceTranscripts.ts` (deps + saved-branch hook)
- Modify: callers building PersistViTranscriptDeps (webhook route + reconcile
  job - find via `rg -n "persistViTranscript" app/src`)
- Test: extend `app/src/services/voiceTranscripts.test.ts`

**Interfaces:**
- Consumes: `createExtractionRepo().scheduleExtraction(conversationId, 'voice', dueAt)` (slice 1), `config.aiExtractionEnabled`.
- Produces: PersistViTranscriptDeps gains
  `extraction?: Pick<ExtractionRepo, 'scheduleExtraction'>` and
  `aiExtractionEnabled: boolean`. In the `saved === true` branch, after
  emitPersisted: when enabled and extraction present,
  `await extraction.scheduleExtraction(entry.conversationId, 'voice', new Date().toISOString())`
  in try/catch (warn log, sids only) - a schedule failure NEVER changes the
  outcome ('saved' still returned).

- [ ] **Step 1:** Failing tests: saved -> scheduled with the entry's
  conversationId + channel 'voice'; already-saved/not-ours/masked/failed ->
  never scheduled; flag off -> not scheduled; schedule throw -> outcome still
  'saved' + warn.
- [ ] **Step 2:** FAIL. **Step 3:** Implement + wire both callers (webhook:
  app-process deps; reconcile job: worker-process deps - both already build
  repos, add extraction the same way).
- [ ] **Step 4:** PASS + typecheck. **Step 5:** Commit:
  `feat(voice-extraction): transcript save schedules extraction (no debounce)`.

### Task 3: Channel-mixed transcript assembly + voice freshness-skip

**Files:**
- Modify: `app/src/jobs/extraction.ts` (toUtterance -> toUtterances; freshness
  gate)
- Modify: `app/src/adapters/extraction.ts` (speaker union widens to
  `'staff' | 'client' | 'unknown'`)
- Test: extend `app/src/jobs/extraction.test.ts`

**Interfaces (Produces):**

```ts
// jobs/extraction.ts - replaces the single-message mapper
function toUtterances(m: MessageItem): TranscriptUtterance[];
// sms/mms: [ { speaker: direction==='inbound'?'client':'staff', text: body ?? '[media]', at, channel:'sms' } ]
// call with transcript_status==='completed' and non-empty transcript:
//   lines = transcript.split('\n'); per line:
//     /^Staff: (.*)$/   -> { speaker:'staff',  text: capture,   channel:'voice' }
//     /^Client: (.*)$/  -> { speaker:'client', text: capture,   channel:'voice' }
//     /^Speaker \d+: /  -> { speaker:'unknown', text: WHOLE line, channel:'voice' }
//     otherwise (voicemail, unprefixed) -> { speaker:'client', text: line, channel:'voice' }
//   all utterances share the call row's timestamp; empty lines dropped.
// call without completed transcript: []
```

Freshness gate change: the early-exit "no client utterances newer than cursor
-> complete without extracting" is BYPASSED when the due item's channel is
'voice' (`row.channel === 'voice'`). Comment WHY (transcript text persists
minutes after the call row's tsMsgId; an SMS-triggered run may have advanced
the cursor past the call row meanwhile). 'unknown'-speaker utterances also
count as client-side content for the freshness check on SMS-triggered runs
(a newly transcribed call IS new content when its tsMsgId is fresh).

- [ ] **Step 1:** Failing tests: each of the four line forms parses as
  specified; a window mixing SMS + a transcribed call interleaves
  chronologically; incomplete-transcript call contributes nothing; voice due
  item runs even when the newest call row is older than the cursor; SMS due
  item still early-exits when nothing new.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS + typecheck.
- [ ] **Step 5:** Commit: `feat(voice-extraction): channel-mixed transcript assembly`.

### Task 4: speakerRoles schema + channel-aware prompt + run-level demotion

**Files:**
- Modify: `app/src/services/extraction/schema.ts` (ExtractionResult +
  EXTRACTION_SCHEMA + parse clamp)
- Modify: `app/src/services/extraction/prompt.ts` (system prompt rules; user
  content renders `<at> [<speaker>/<channel>] <text>`)
- Modify: `app/src/adapters/extraction.ts` (ExtractionResult type)
- Modify: `app/src/services/extraction/apply.ts` (demotion)
- Test: extend schema.test.ts, apply.test.ts

**Interfaces (Produces):**

```ts
// ExtractionResult gains:
speakerRoles?: Record<string, 'client' | 'staff' | 'uncertain'>; // keys like "Speaker 1"

// applyExtraction ctx gains:
hasInferredRoleContent: boolean;  // computed by the JOB: any utterance with speaker==='unknown'
// When true: every fields op:'write' is APPLIED AS a suggestion instead
// (same putSuggestion path as op:'suggest'; skip-if-equal still applies);
// audit payload gains { demoted: true, speakerRoles }. Notes appends and
// native suggestions are unchanged. Provenance is NOT stamped (nothing was
// written).
```

Prompt additions (system, verbatim rules to add):
- "The transcript may mix text messages and phone calls; each line is
  `<time> [<speaker>/<channel>] <text>`."
- "[unknown] lines come from a two-party phone call whose speakers are
  labeled Speaker 1/Speaker 2 without role attribution. FIRST decide who is
  the client and output speakerRoles mapping every Speaker label to client,
  staff, or uncertain. Extract only facts clearly stated by or about the
  client; if a fact's speaker role is uncertain, omit the fact."
- "[client/voice] lines with no Speaker label are a voicemail: the client
  speaking."

- [ ] **Step 1:** Failing tests: schema round-trips speakerRoles (unknown-role
  values dropped by the clamp); prompt renders channel + rules + Speaker-role
  instruction only text (rules are unconditional - presence-gating the prompt
  by content is NOT required, keep it simple); apply with
  hasInferredRoleContent=true converts a write op on an EMPTY field into a
  suggestion (no contact.update call for that field, no provenance, audit
  demoted:true), leaves notes + native suggests unchanged; false -> unchanged
  slice-1 behavior (regression: rerun the existing apply tests untouched).
- [ ] **Step 2:** FAIL. **Step 3:** Implement (job computes
  hasInferredRoleContent from the assembled utterances and passes it in ctx -
  touch jobs/extraction.ts here for that one wiring line).
- [ ] **Step 4:** PASS + typecheck. **Step 5:** Commit:
  `feat(voice-extraction): speakerRoles + inferred-role demotion`.

### Task 5: SuggestionChip action-row wrap

**Files:**
- Modify: `dashboard/src/routes/contact/SuggestionChip.tsx` (action row style:
  `flexWrap: 'wrap'` + a row gap consistent with the existing style object)
- Test: extend `dashboard/src/routes/contact/SuggestionChip.test.tsx`

- [ ] **Step 1:** Failing test: the actions container carries the wrap style
  (assert on the computed style/class the component uses - match the file's
  existing styling idiom).
- [ ] **Step 2:** FAIL. **Step 3:** One-line fix (+ gap if needed).
- [ ] **Step 4:** PASS. **Step 5:** Commit:
  `fix(extraction): suggestion chip actions wrap instead of clipping`.

### Task 6: E2E + docs

**Files:**
- Modify: `e2e/tests/flows/conversation-fact-extraction.spec.ts` (or a new
  sibling `voice-extraction.spec.ts` if the file is crowded)
- Modify: `e2e/fixtures/extraction.ts` (helper to plant a transcribed call:
  use the voice feature's existing fake seams - find how its e2e plants
  calls/transcripts via `rg -n "transcript" e2e/` and reuse; if no seam
  exists, plant the call MessageItem + transcript via a `/__dev` fixture route
  addition in `app/src/routes/dev.ts` mirroring the deadline-fixture route)
- Modify: `RUNBOOK.md` (AI extraction section: voice trigger note + the
  POST-MERGE LIVE VERIFICATION step - one real dev bridged call, confirm the
  Staff:/Client: prefixes match who actually spoke, BEFORE trusting
  attribution in prod)
- Modify: `e2e/support/selectors.md` if any new selector is used

Spec scenarios:
1. Voicemail extraction: plant a voicemail-shaped call (single-channel
   transcript, no prefixes) whose transcript contains the EXTRACT: marker ->
   `/__dev/extraction/tick` -> suggestion appears on the contact.
2. Attributed bridge: transcript with `Client: ` EXTRACT-marker line ->
   tick -> DIRECT write lands (Auto badge).
3. Unattributed bridge (Speaker N lines): same fact -> arrives as a
   SUGGESTION (demotion proof; no Auto badge on the field).
4. Chip wrap: at the desktop Details-card width the third action is visible
   (assert `View conversation` link is visible + no horizontal overflow on
   the chip container).

- [ ] **Step 1:** Write fixture + spec. **Step 2:** Filtered run from the e2e
  workspace dir - iterate to green. **Step 3:** Full gates:
  `npm run typecheck` + `npm test` + `timeout 1500 npm run e2e` (bare,
  worktree) - all green; re-run full e2e once before blaming any flake.
- [ ] **Step 4:** RUNBOOK + selectors + ASCII sweep of the diff.
- [ ] **Step 5:** Commit: `test(voice-extraction): e2e voice paths + runbook`.

## Self-review (planner)

- Spec coverage: 2 hook (T2), 3 Layer 1 (T1), Layer 2 (T4), Layer 3 (T4 +
  invariant surfaces block), 4 assembly + freshness (T3), 5 prompt/schema
  (T4), 6 chip (T5), 8 testing (per-task + T6 incl. the post-merge live
  verification note). No placeholders; types consistent (ChannelRoles /
  toUtterances / speakerRoles / hasInferredRoleContent named identically
  across tasks).
- Deliberate simplifications: prompt rules unconditional (not content-gated);
  demotion computed by the job, enforced by apply (single choke point);
  voicemail roles never stamped (no dial site).
