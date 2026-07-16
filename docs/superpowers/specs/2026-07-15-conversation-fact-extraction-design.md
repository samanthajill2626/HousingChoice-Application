# Conversation Fact Extraction - Design

Date: 2026-07-15
Status: DRAFT - awaiting Cameron's review
Phase: 2 (automations), slice 1

## 1. Overview

When a tenant (or unknown contact) texts us, an AI extraction job reads the
recent conversation and pulls out structured facts about them - voucher
program, voucher size, pets, evictions, household details - plus a
contact-type classification and second-phone-number signals. Facts flow into
the contact record under a strict write policy: empty fields are written
directly (stamped with AI provenance), occupied fields are only overwritten
when the model judges the new value to be the same fact in better form, and
genuine conflicts become pending suggestions that staff review inline, right
where the field is displayed.

This natively replaces the AI-extraction core of the founder's n8n workflows
(the "conversation ai agent", "any pets", and call-transcript agents). The
n8n exports were used as REQUIREMENTS EVIDENCE ONLY - what the founder needs
extracted and the domain vocabulary. No prompt text, pipeline shape, or
behavior is carried over from them.

## 2. Goals

- Staff stop hand-copying facts out of text threads into the contact record.
- Every AI-written value is visibly attributed (never mistaken for
  staff-entered data) and traceable to the exact conversation.
- Human data always wins: no silent overwrite of a conflicting human value.
- Review happens just in time - at the moment staff are looking at the value
  that might be stale - plus one global count so nothing rots unseen.
- The pipeline is channel-neutral from day one so call transcripts can be
  added later as a small adapter, with zero changes to the core.

## 3. Scope

In scope (this slice):
- SMS conversations as the extraction source.
- Tenant screening facts into EXISTING first-class contact fields only:
  firstName/lastName, voucherSize, housingAuthority, pets, evictions,
  tenure, porting. No new enumerated contact fields.
- Secondary facts (stairs OK, last moved, household size, rent portion,
  utility debt, and anything else useful but non-schema) appended to the
  contact notes as clearly attributed lines.
- Voucher/RTA-in-hand signals -> a pending suggestion proposing a tenant
  status advance through the existing transition service.
- Contact-type classification (tenant / caseworker / landlord) for
  unknown-type contacts -> suggestion feeding the existing triage queue.
- Second-number detection -> suggestion proposing a phones[] addition.
- Field-level AI provenance + inline suggestion review UI + Today count.
- Fake-LLM seam for hermetic tests (mirrors the fake-Twilio pattern).

Out of scope (this slice):
- Call recording/transcription (fast-follow slice; the seam is designed here).
- Housing-fair intake form + welcome-SMS automation (separate feature).
- Anything n8n-hosted. Nothing is deployed; the founder's n8n instance keeps
  running against Airtable until cutover.
- Landlord/team_member fact extraction (facts schema is tenant-specific).
- Auto-advancing tenant status (v1 suggests; see 4.7).

## 4. Architecture

### 4.1 Channel-neutral transcript interface

The extraction core consumes a normalized transcript and does not know where
it came from:

    interface TranscriptUtterance {
      speaker: 'staff' | 'client';
      text: string;
      at: string;            // ISO 8601
      channel: 'sms' | 'voice';
    }

- Speaker attribution comes from our own message records (we know the
  direction of every stored message) - no phone-number-subtraction hacks.
- SMS adapter (this slice): assembles utterances from the stored
  conversation - everything since the last extraction cursor, plus a bounded
  window of prior context so new statements can be interpreted (default: the
  50 messages preceding the cursor, capped at 30 days; constants in one
  place, tunable).
- Voice adapter (later): recording -> transcription -> stored transcript ->
  same queue item. See section 8.

### 4.2 Trigger and debounce (sliding)

- When an inbound message is stored for a contact of type tenant or unknown,
  the app UPSERTS an extraction-due item keyed by conversation with
  due = now + 30s.
- Every subsequent inbound message re-upserts the same item, pushing due
  back to now + 30s. The timer therefore slides: extraction runs 30 seconds
  after the LAST message of a burst, and a whole burst is covered by one
  call. A long continuous exchange keeps sliding and gets one extraction at
  the end - intended behavior.
- The existing worker poller pattern (as used for scheduled messages) picks
  up due items. The item records the extraction cursor (last message covered
  by the previous run) so runs are idempotent and non-overlapping.
- Outbound (staff) messages do NOT trigger extraction, but staff utterances
  within the window ARE included in the transcript for context.
- The due-item shape is channel-neutral: { conversationRef, channel, due,
  cursor }. The voice adapter enqueues the same item type.

### 4.3 The extraction call

- One Claude Messages API call per due item, using structured outputs
  (output_config.format with a JSON schema). The API guarantees the response
  parses against the schema - no output-format prompting, no parse-and-pray.
- Model: configurable via env (AI_EXTRACTION_MODEL). Default
  claude-opus-4-8. Rationale: at current volume (order of 50 inbound/day,
  ~2K tokens/call) this is roughly $25/month, and a wrong value landing in a
  tenant record is the expensive failure mode, not the API bill.
  claude-haiku-4-5 (~$5/month) is the dial-down if volume grows 10x.
- Kill switch: AI_EXTRACTION_ENABLED env flag. Off = no due items are
  enqueued and the poller skips any that exist.
- The prompt is built fresh from OUR data model:
  - Controlled vocabulary for housingAuthority comes from the values our
    app recognizes (seeded from the domain list the founder uses: Jonesboro
    /JHA, Fulton County, Atlanta/AHA, Clayton, College Park, GHV, Step Up,
    Claratel, Hope Atlanta, HUD VASH, DCA, McDonough, East Point).
  - Rules: facts must be stated by or about the CLIENT; never guess names;
    a question ("do you have a 2-bed voucher?") is not a fact until the
    client confirms; when unsure, omit the field entirely.
- The call receives the contact's CURRENT profile values (the reconcilable
  fields + current notes) alongside the transcript, enabling in-model
  reconciliation (4.4).

### 4.4 Write policy - reconciliation inside the model

For each first-class field, the model returns an operation, a value, and a
one-line reason:

- none  - no new information, or the current value is already this fact
          (case, whitespace, spelling variants included). No write.
- write - the field is empty, OR the new value is the SAME fact in better
          form (correct spelling, fuller name, normalized program name).
          Direct write, stamped with AI provenance; the previous value (if
          any) is preserved in the audit trail.
- suggest - genuinely conflicting information (household of 3 when we have
          5; a different program). Becomes a pending suggestion; the stored
          value is untouched until a human accepts.

The server applies ops as returned - no programmatic string-equality layer -
but records everything so a model misjudgment is visible and reversible:
audit event per applied op (old value, new value, reason, conversation ref).

Secondary facts skip this machinery: the model decides whether each is
already recorded in the notes it was shown, and returns only NEW note lines.
The server appends them as, e.g.:

    [Auto - Jul 14] OK with stairs; last moved spring 2024

### 4.5 Field provenance

- A field_sources map on the contact item:
  field_sources.pets = { source: 'ai', at, conversationRef, messageRef }.
- Written whenever the extractor writes a field. CLEARED for a field when a
  human edits it (hook: the contact PATCH route already computes
  changedFields).
- This generalizes the existing status_source / TransitionSource pattern;
  'ai' is already a defined source value in the status model.
- Flexible-document posture: no schema/infra change for this.

### 4.6 Pending suggestions

- Stored in the contacts table under the contact's partition, one item per
  target (suggestion#<field>, plus suggestion#status and suggestion#phone).
  Latest-wins: a newer extraction for the same field replaces a stale
  pending suggestion.
- Item carries: current value, suggested value, reason, source conversation
  and message refs, created at, status (pending only - resolution removes).
- Accept -> writes the value (through the same paths a human edit uses, so
  audit + any downstream sync fire), stamps provenance
  { source: 'ai', accepted_by: <userId> }, removes the item, audit event.
- Dismiss -> audit event, item removed.
- Counting for the Today tile: preferred design is a sparse GSI attribute
  set only while a suggestion is pending (cheap global count). If an
  existing index can serve the count without a new GSI, the implementation
  plan will use it; otherwise this is the ONE infra change in the slice
  (terraform plan/apply on dev - flagged for Cameron to run per house
  rules; never applied by Claude unprompted).

### 4.7 Status-advance suggestion (voucher/RTA in hand)

- There is no voucher-in-hand contact field, and we are not adding one. The
  concept lives in the tenant lifecycle: the RTA/voucher being in hand is
  what justifies advancing (e.g. onboarding -> searching), and porting
  (boolean, exists) covers "being moved between jurisdictions".
- When the client states their voucher/RTA is in hand, the extractor emits a
  suggestion proposing the specific status transition. Accepting routes
  through the existing transition service with source 'ai' (already a
  defined TransitionSource with correct precedence semantics).
- v1 is suggestion-only. The June-2026 "admin advances the tenant" decision
  is acknowledged to be softening; the architecture deliberately leaves a
  one-line policy change (op: write instead of suggest for this signal) to
  enable auto-advance later, without structural rework.
- Porting statements set/suggest the existing porting boolean under the
  same 4.4 policy.

### 4.8 Classification and phone signals

- Classification: for contacts of type 'unknown' only, the model returns a
  suggested ContactType (tenant / caseworker / landlord) + reason. This
  lands as a suggestion attached to the contact, surfaced in the EXISTING
  triage queue flow (type=unknown, status=needs_review) - the human still
  performs the triage action; the AI pre-fills the recommendation. Never a
  direct type change.
- Second number: when the client says another number is theirs ("this is my
  second number", "text me at ..."), the extractor emits a suggestion
  proposing a phones[] addition (label from context when stated). Accepting
  runs the existing add-phone path (phone-pointer item etc.). Never touches
  Name (the n8n "John Doe-backup" rename hack is explicitly not replicated).

## 5. UI

- Provenance badge: fields whose field_sources entry says 'ai' render a
  subtle "Auto" marker with tooltip "Extracted from a conversation on
  <date>" linking to the source conversation. Human-edited fields look
  unchanged.
- Inline suggestion (the just-in-time surface): a field with a pending
  suggestion renders its current value plus a highlighted chip:
  "AI heard <value> (<date>) - Accept | Dismiss | View conversation".
  Same pattern for the status-advance and add-phone suggestions on the
  contact page.
- Today tile: "N AI suggestions awaiting review", linking to the affected
  contacts. No new page.
- Notes: auto-appended lines are visually distinguishable by their
  "[Auto - <date>]" prefix; no special rendering required in v1.
- MOBILE parity is required (standing rule for new dashboard surfaces).

## 6. Config, ops, privacy

- Secrets: ANTHROPIC_API_KEY via the existing secrets flow (template-first
  .env rule; secretsCore sync where applicable). Never hardcoded (the n8n
  workflows' in-prompt API keys are the cautionary tale; those OpenPhone
  keys were also flagged to the founder for rotation).
- Env: AI_EXTRACTION_ENABLED (kill switch), AI_EXTRACTION_MODEL,
  AI_EXTRACTION_DEBOUNCE_MS (default 30000; starting value to test - it is
  an env knob precisely so we can tune without a code change).
- Cost: order of $1/day at current volume on claude-opus-4-8; revisit model
  choice if volume grows 10x.
- Privacy/PII: conversation text (tenant PII) flows to the Anthropic API.
  Standard API terms: inputs/outputs are not used for training; ~30-day
  retention window. Documented here as an accepted vendor data flow
  alongside Twilio. Revisit if a BAA-equivalent or zero-retention posture
  is ever required.
- Failure handling: an extraction failure (API error, refusal, schema
  mismatch after SDK retries) marks the due item failed with backoff; it
  never blocks message flow. Extraction is strictly additive/asynchronous -
  inbound message handling has zero dependency on it.

## 7. Testing

- Fake-LLM seam (mirrors fake-Twilio): the Anthropic client sits behind a
  thin provider interface; hermetic/local runs use a fake returning canned,
  schema-valid responses keyed by scenario. No network, deterministic, free.
- Unit: write-policy application (none/write/suggest per field state),
  provenance stamping + clearing on human edit, sliding debounce upsert
  semantics, notes append (no duplicate lines), suggestion lifecycle
  (accept/dismiss/replace).
- E2E (Playwright, accessibility-first selectors): inbound SMS -> (fake)
  extraction -> field written with Auto badge; conflicting fact -> inline
  suggestion chip -> Accept updates the field; Dismiss clears; Today tile
  count; triage queue shows the AI type recommendation.
- Full gates before merge: npm run typecheck + npm test + npm run e2e.

## 8. Voice fast-follow (designed now, built later)

The later slice adds ONLY:
1. Call recording enablement on the Twilio voice paths (consent posture to
   be decided in that slice - GA is a one-party-consent state, but company
   policy may require an announcement).
2. A transcription step (provider TBD - Twilio Voice Intelligence or
   equivalent) producing a stored transcript.
3. A voice adapter that normalizes the transcript to TranscriptUtterance[]
   and enqueues the standard extraction-due item (channel: 'voice', no
   debounce needed - one item per completed call).
The extraction core, write policy, provenance, suggestions, and UI are
untouched. The fake-Twilio CallEngine seam gives the hermetic test path.

## 9. Decisions log

- Native pipeline chosen over n8n peer-service or hybrid (n8n remains the
  founder's Airtable-side tool until cutover; nothing n8n is deployed).
- Direct-write empty fields; review required for conflicting values;
  equivalence/normalization judged BY THE MODEL, not string comparison.
- Automated writes always visibly attributed (provenance map + Auto badge).
- Review surfaces: inline just-in-time chips + Today count tile. No
  dedicated review page.
- v1 scope: facts + classification + phone signals (broadest option chosen).
- No new enumerated contact fields; secondary facts go to notes.
- Voucher/RTA-in-hand -> status-advance suggestion via transition service;
  auto-advance is a deliberate one-line policy change away.
- SMS-only sources in v1; transcript interface makes voice an adapter.
