<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-07-20).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Conversation Fact Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every inbound SMS from a tenant/unknown contact, a debounced worker
job runs one structured-output LLM call over the conversation and applies a
strict write policy to the contact record (write empty fields with provenance,
suggest on conflicts, append secondary facts to notes), with inline review UI.

**Architecture:** New single-key `ai_extraction` DynamoDB table holds both
debounce/cursor items (one per conversation) and pending suggestion items (one
per contact+target), indexed by three sparse fixed-partition GSIs. The Twilio
inbound webhook upserts a sliding due item; a worker poller (mirroring the
tour-reminders poller) claims due items, assembles a channel-neutral transcript
from stored messages, calls the extraction driver (Anthropic structured outputs
in prod; deterministic fake in tests), and applies results via a guarded apply
service. Review endpoints + dashboard chips/badges + a Today count complete the
loop.

**Tech Stack:** TypeScript (ESM), Express, DynamoDB (lib-dynamodb), @anthropic-ai/sdk
(NEW dep, app workspace only), Vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-07-15-conversation-fact-extraction-design.md
**Research notes (planner scratchpad, may be gone at build time - plan is self-contained):**
research-worker-messaging.md, research-contacts-domain.md, research-dashboard-seams.md.

## Global Constraints

- ASCII only in every added line (specs, code comments, seed strings, test names):
  `tr -d '\11\12\15\40-\176' < FILE | wc -c` must print 0.
- Gates: `npm run typecheck` AND `npm test` AND `timeout 1500 npm run e2e` - bare,
  never piped; e2e only from the worktree.
- New runtime dep `@anthropic-ai/sdk` goes in app/package.json dependencies ONLY
  (never root). Pure-JS dep - no arm64 binary concerns, but verify the lockfile
  updates cleanly with `npm install` from the repo root (workspaces).
- The twilio SDK adapter rule applies to the Anthropic SDK: imported by EXACTLY ONE
  module (app/src/adapters/extraction.ts).
- Commit discipline: bare `git status` read before EVERY commit; stage explicit
  paths; trailer `Co-Authored-By:` naming the authoring model.
- NEVER run terraform/secrets/deploys. The new table is registered in
  app/src/lib/tables.ts (local/e2e tables auto-create from it); the dev/prod
  terraform apply is an OWED POST-MERGE OP recorded in the handback + RUNBOOK.
- No new automated user-facing SMS copy exists in this feature (no message-catalog
  changes). Dashboard copy says "property" for staff-facing unit references (not
  applicable here - this feature touches contact fields only).
- Contact terminology: fields/types exactly as they exist (`voucherSize`,
  `housingAuthority`, `pets`, `evictions`, `tenure`, `porting`, `notes`).
- ADJUDICATION (planner, 2026-07-16): the app has NO `caseworker` ContactType
  (union is tenant|landlord|team_member|unknown). v1 type suggestions are limited
  to tenant|landlord; a clear caseworker self-identification becomes a notes line
  `[Auto - <date>] Identified as a caseworker (<org if stated>)` plus the contact
  stays in triage. File docs/issues/caseworker-contact-type.md (Task 11).

---

### Task 1: ai_extraction table + repo (due items, suggestions, counts)

**Files:**
- Modify: `app/src/lib/tables.ts` (register new table; mirror tourReminders at
  lines ~356-373 and the fixed-partition sparse-GSI idiom at ~291-305)
- Create: `app/src/repos/extractionRepo.ts`
- Test: `app/src/repos/extractionRepo.test.ts` (mirror the setup of
  `app/src/repos/tourRemindersRepo.test.ts` - local DynamoDB per-suite table)

**Interfaces:**
- Consumes: `tableName(base, env)` from lib/config, `getDocumentClient` from
  lib/dynamo (same imports as tourRemindersRepo.ts).
- Produces (exact signatures later tasks rely on):

```ts
export interface DueExtractionItem {
  itemId: string;                 // 'due#<conversationId>'
  conversationId: string;
  channel: 'sms' | 'voice';
  dueAt?: string;                 // ISO; present only while scheduled
  _duePartition?: 'due';          // sparse byDueAt HASH; present only while scheduled
  cursor?: string;                // last tsMsgId covered by a completed run
  claimedAt?: string;
  attempts?: number;              // consecutive failures
  lastError?: string;
  lastRanAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SuggestionItem {
  itemId: string;                 // 'sugg#<contactId>#<target>'
  ownerContactId: string;         // byOwner GSI HASH (sparse - only suggestions)
  target: string;                 // 'firstName'|'lastName'|'voucherSize'|'housingAuthority'|'pets'|'evictions'|'tenure'|'porting'|'status'|'phone'|'type'
  currentValue?: string;
  suggestedValue: string;
  reason?: string;
  conversationId: string;
  tsMsgId?: string;
  _pendingPartition?: 'pending';  // sparse byPending HASH; present while pending
  createdAt: string;              // byPending RANGE
}

export function createExtractionRepo(deps?: { client?; env? }): {
  scheduleExtraction(conversationId: string, channel: 'sms'|'voice', dueAt: string): Promise<void>;
  listDue(nowIso: string): Promise<DueExtractionItem[]>;
  claim(conversationId: string, nowIso: string, listedDueAt: string): Promise<boolean>;
  complete(conversationId: string, cursor: string, ranAt: string): Promise<void>;
  fail(conversationId: string, error: string, nextDueAt: string | null): Promise<void>;
  getDue(conversationId: string): Promise<DueExtractionItem | undefined>;
  putSuggestion(s: Omit<SuggestionItem, 'itemId'|'_pendingPartition'|'createdAt'> & { createdAt?: string }): Promise<SuggestionItem>;
  getSuggestion(contactId: string, target: string): Promise<SuggestionItem | undefined>;
  listSuggestionsByContact(contactId: string): Promise<SuggestionItem[]>;
  deleteSuggestion(contactId: string, target: string): Promise<void>;
  listPending(opts?: { limit?: number }): Promise<SuggestionItem[]>;
}
```

Semantics the tests must pin:
- `scheduleExtraction` is an UPSERT that SLIDES: two calls leave ONE item with the
  later dueAt (`UpdateCommand` SET dueAt/_duePartition/channel/conversationId/
  updatedAt + `if_not_exists(createdAt)`).
- `claim` is conditional: `attribute_exists(#dp) AND #dueAt <= :now AND #dueAt = :listedDueAt`;
  on success REMOVE _duePartition/dueAt, SET claimedAt. Returns false on
  ConditionalCheckFailedException (slid or already claimed) - the sliding-debounce
  correctness hinges on the `= :listedDueAt` clause.
- `complete` SETs cursor + lastRanAt, REMOVEs claimedAt + attempts + lastError.
  The item persists as the conversation's cursor record.
- `fail` increments attempts; if nextDueAt is non-null re-arms (SET dueAt +
  _duePartition), else parks (REMOVE _duePartition) keeping lastError.
- Suggestion `putSuggestion` computes itemId `sugg#<contactId>#<target>`, stamps
  `_pendingPartition: 'pending'`, createdAt now (or given) - a re-put on the same
  target REPLACES (latest wins).
- `listSuggestionsByContact` Queries the byOwner GSI; `listPending` Queries
  byPending (fixed partition 'pending', range createdAt, newest first is fine
  either way - pick ScanIndexForward false and pin it in a test).

Table registration in tables.ts (exact spec to add, mirroring TableSpec fields
used by tourReminders):

```ts
aiExtraction: {
  base: 'ai_extraction',
  hash: { name: 'itemId', type: 'S' },
  gsis: [
    { name: 'byDueAt',  hash: { name: '_duePartition', type: 'S' }, range: { name: 'dueAt', type: 'S' },  sparse: true },
    { name: 'byOwner',  hash: { name: 'ownerContactId', type: 'S' }, range: { name: 'itemId', type: 'S' }, sparse: true },
    { name: 'byPending',hash: { name: '_pendingPartition', type: 'S' }, range: { name: 'createdAt', type: 'S' }, sparse: true },
  ],
},
```

(Adapt property names to the existing TableSpec/GsiSpec shape in tables.ts - copy
the placementNudges entry and edit. All GSIs project ALL like the others.)

- [ ] **Step 1:** Write `extractionRepo.test.ts` covering: slide-upsert keeps one
  item with later dueAt; listDue returns only scheduled+past-due; claim fails when
  dueAt slid after listDue (put, list, slide, claim with stale listedDueAt ->
  false); claim succeeds and removes from listDue; complete stores cursor and
  clears claim; fail re-arms with attempts=1 then parks when nextDueAt null;
  suggestion put/replace/list-by-contact/delete; listPending sees only items with
  _pendingPartition and excludes deleted. Mirror the local-DynamoDB harness of
  tourRemindersRepo.test.ts verbatim (table create from tables.ts spec).
- [ ] **Step 2:** Run `npm test --workspace app -- extractionRepo` - expect FAIL
  (module not found).
- [ ] **Step 3:** Add the tables.ts entry; implement extractionRepo.ts. Copy the
  UpdateCommand/ConditionalCheckFailedException patterns from
  tourRemindersRepo.ts (claimSend at ~L188 is the template for claim).
- [ ] **Step 4:** Run the suite again - expect PASS. Also run
  `npm run typecheck` (tables.ts is a contract file - catch shape drift now).
- [ ] **Step 5:** Add one line to the README's Deviations/contract-change log
  (search README.md for the tables contract note; append "ai_extraction table
  added for conversation-fact-extraction (2026-07-16)"). Commit:
  `feat(extraction): ai_extraction table + repo (due items, suggestions)`.

### Task 2: Config flags + env templates

**Files:**
- Modify: `app/src/lib/config.ts`
- Modify: `.env.example`, `.env.dev.example`, `.env.prod.example` (template-first
  rule; NEVER touch real .env files)
- Modify: `scripts/e2e-session.mjs` (childEnv: `EXTRACTION_DRIVER=fake`)
- Test: `app/src/lib/config.test.ts` (extend the existing config test file)

**Interfaces (Produces):**

```ts
// AppConfig additions
aiExtractionEnabled: boolean;    // AI_EXTRACTION_ENABLED; default: false in production, true otherwise
extractionDriver: 'anthropic' | 'console' | 'fake';  // EXTRACTION_DRIVER; default: 'anthropic' in production, 'console' otherwise; 'fake' REJECTED (throw) in production
aiExtractionModel: string;       // AI_EXTRACTION_MODEL; default 'claude-opus-4-8'
aiExtractionDebounceMs: number;  // AI_EXTRACTION_DEBOUNCE_MS; default 30000; warn+default on unparseable (mirror a2pRateLimitPerSec at ~533-545)
anthropicApiKey?: string;        // ANTHROPIC_API_KEY
anthropicApiBaseUrl?: string;    // ANTHROPIC_API_BASE_URL; THROW if set in production (mirror twilioApiBaseUrl ~342-359)
```

Validation rules to implement + test:
- production && aiExtractionEnabled && extractionDriver==='anthropic' &&
  !anthropicApiKey -> fail fast at loadConfig (mirror the MESSAGING_DRIVER=twilio
  required-vars block at ~392-406).
- Boolean parse mirrors smsSendingEnabled (~448-463): true|1|yes / false|0|no,
  warn + default otherwise.

- [ ] **Step 1:** Extend config.test.ts: defaults per NODE_ENV; explicit
  overrides; fake-driver-in-prod throws; enabled+anthropic+no-key-in-prod throws;
  base-url-in-prod throws; bad debounce warns + 30000.
- [ ] **Step 2:** Run `npm test --workspace app -- config` - expect FAIL.
- [ ] **Step 3:** Implement in config.ts (interface fields ~L17-253, parsing in
  loadConfig, return block ~652-703).
- [ ] **Step 4:** Re-run - PASS. Update the three .env templates: add
  `AI_EXTRACTION_ENABLED=`, `EXTRACTION_DRIVER=`, `AI_EXTRACTION_MODEL=`,
  `AI_EXTRACTION_DEBOUNCE_MS=`, `ANTHROPIC_API_KEY=replace-with-anthropic-key`
  (dev/prod only for the key), with one-line comments. Add
  `EXTRACTION_DRIVER: 'fake'` to scripts/e2e-session.mjs childEnv beside the
  TWILIO_* lines (~140-146).
- [ ] **Step 5:** Commit: `feat(extraction): config flags + env templates`.

### Task 3: Extraction driver seam (types, Anthropic, console, fake)

**Files:**
- Create: `app/src/adapters/extraction.ts` (interface + factory + Anthropic +
  console drivers; the ONLY `@anthropic-ai/sdk` import in the repo)
- Create: `app/src/adapters/extractionFake.ts` (deterministic fake driver)
- Modify: `app/package.json` (add `"@anthropic-ai/sdk": "^0.6x"` - latest; then
  `npm install` from repo root to update the lockfile)
- Test: `app/src/adapters/extraction.test.ts`

**Interfaces (Produces - later tasks import these exact names):**

```ts
// app/src/adapters/extraction.ts
export interface TranscriptUtterance {
  speaker: 'staff' | 'client';
  text: string;
  at: string;               // ISO 8601
  channel: 'sms' | 'voice';
}

export type ExtractableField =
  | 'firstName' | 'lastName' | 'voucherSize' | 'housingAuthority'
  | 'pets' | 'evictions' | 'tenure' | 'porting';

export interface ExtractionFieldOp {
  op: 'none' | 'write' | 'suggest';
  value?: string;           // always a string; apply-layer coerces per field
  reason?: string;
}

export interface ExtractionResult {
  fields: Partial<Record<ExtractableField, ExtractionFieldOp>>;
  statusAdvance?: { suggest: boolean; reason?: string };
  typeSuggestion?: { value: 'tenant' | 'landlord'; reason?: string };
  phoneAddition?: { phone: string; label?: string; reason?: string };
  noteLines?: string[];
}

export interface ExtractionProfileSnapshot {
  contactType: string;
  status?: string;
  firstName?: string; lastName?: string;
  voucherSize?: number; housingAuthority?: string;
  pets?: string; evictions?: string; tenure?: string;
  porting?: boolean;
  notes?: string;
  phones: string[];
}

export interface ExtractionInput {
  transcript: TranscriptUtterance[];
  profile: ExtractionProfileSnapshot;
}

export interface ExtractionDriver {
  readonly kind: 'anthropic' | 'console' | 'fake';
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

export class ExtractionRefusedError extends Error {}

export function createExtractionDriver(cfg: {
  driver: 'anthropic' | 'console' | 'fake';
  model: string;
  apiKey?: string;
  apiBaseUrl?: string;
}): ExtractionDriver;

export const EMPTY_EXTRACTION: ExtractionResult; // { fields: {} }
```

Driver behavior:
- Console driver: logs a one-line summary (transcript length, contact type) and
  returns EMPTY_EXTRACTION. This keeps `npm run dev` fully offline.
- Fake driver (extractionFake.ts): scans the transcript NEWEST-first for the
  first client utterance containing a line that starts with `EXTRACT:`; the rest
  of that line is JSON parsed as a Partial<ExtractionResult> and merged over
  EMPTY_EXTRACTION. Malformed JSON -> EMPTY_EXTRACTION (log warn, never throw).
  No marker -> EMPTY_EXTRACTION. This protocol is what e2e drives.
- Anthropic driver: one `client.messages.create` call:
  - `model: cfg.model`, `max_tokens: 2048`
  - `output_config: { format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } }`
    (schema from Task 4 - import `EXTRACTION_SCHEMA` and `parseExtractionText`).
  - `system`: from Task 4 `buildExtractionSystemPrompt()`.
  - `messages: [{ role: 'user', content: buildExtractionUserContent(input) }]`
    (also Task 4).
  - Client constructed once per driver instance:
    `new Anthropic({ apiKey: cfg.apiKey, ...(cfg.apiBaseUrl ? { baseURL: cfg.apiBaseUrl } : {}) })`.
  - Response handling: if `stop_reason === 'refusal'` throw ExtractionRefusedError;
    else find the text block, `parseExtractionText(text)` -> ExtractionResult.
- Factory selects by cfg.driver; throws on 'anthropic' without apiKey.

- [ ] **Step 1:** Write extraction.test.ts covering: factory selection (kind per
  driver string; anthropic-without-key throws); console driver returns
  EMPTY_EXTRACTION; fake driver parses `EXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}`
  from the newest client utterance, ignores staff utterances and older markers,
  and returns EMPTY_EXTRACTION on malformed JSON / no marker. Do NOT test the
  Anthropic driver's network path here (request-shaping is tested in Task 4).
- [ ] **Step 2:** Run `npm test --workspace app -- adapters/extraction` - FAIL.
- [ ] **Step 3:** `npm install @anthropic-ai/sdk --workspace app` from the repo
  root (updates root package-lock.json). Implement both files. The Anthropic
  driver may import Task 4's module lazily (`await import('../services/extraction/prompt.js')`)
  OR Task 4 can come first at build time - either order compiles because Task 4
  has no dependency on Task 3; if building strictly in plan order, define the
  Anthropic driver to import from `../services/extraction/prompt.js` and create
  that module in Task 4 (typecheck for Task 3 will be deferred to Task 4's gate -
  in that case move the Task 3 typecheck run to Task 4 Step 4 and say so in the
  commit body).  Simpler alternative the builder MAY choose: implement Task 4's
  files first, then Task 3 (swap commit order); the tests are independent.
- [ ] **Step 4:** Re-run - PASS.
- [ ] **Step 5:** Commit: `feat(extraction): driver seam (anthropic/console/fake) + sdk dep`.

### Task 4: JSON schema + prompt builder

**Files:**
- Create: `app/src/services/extraction/schema.ts`
- Create: `app/src/services/extraction/prompt.ts`
- Test: `app/src/services/extraction/schema.test.ts`

**Interfaces (Produces):**

```ts
// schema.ts
export const EXTRACTION_SCHEMA: Record<string, unknown>; // JSON schema (draft-07 subset per structured outputs)
export function parseExtractionText(text: string): ExtractionResult; // JSON.parse + structural validation + clamp
export const HOUSING_AUTHORITY_VOCAB: string[]; // controlled vocabulary
// prompt.ts
export function buildExtractionSystemPrompt(): string;
export function buildExtractionUserContent(input: ExtractionInput): string;
```

Schema requirements (structured outputs constraints: every object needs
`additionalProperties: false`; NO minimum/maximum/minLength - clamp in code):
- Top level: `{ fields, statusAdvance?, typeSuggestion?, phoneAddition?, noteLines? }`.
- `fields`: object with the eight ExtractableField keys, each optional, each
  `{ op: enum none|write|suggest, value?: string, reason?: string }`.
- `typeSuggestion.value`: enum tenant|landlord.
- `noteLines`: array of strings.
- parseExtractionText clamps in code: noteLines max 5 entries, each trimmed to
  200 chars; reason trimmed to 200; unknown field keys dropped; missing `fields`
  -> `{}`. Never throws on structurally-valid JSON; throws SyntaxError on
  unparseable text (job layer treats as failure).

HOUSING_AUTHORITY_VOCAB (ASCII, exact strings stored in our data):
`['Jonesboro (JHA)','Fulton County','Atlanta (AHA)','Clayton County','College Park','Georgia Housing Voucher (GHV)','Step Up','Claratel','Hope Atlanta','HUD VASH','DCA','McDonough','East Point']`

System prompt content (write it verbatim in prompt.ts; ASCII):
- Role: extract facts about the CLIENT from an SMS conversation between housing
  navigation staff and a client; output ONLY per the schema.
- Reconciliation rules: for each field, compare with CURRENT PROFILE given in the
  user content. op=none when no new info OR current value already expresses the
  fact (case/whitespace/spelling variants). op=write when the field is empty OR
  the new value is the SAME fact in better form (correct spelling, fuller name,
  normalized program name). op=suggest when the information genuinely conflicts.
  Every write/suggest carries a short reason.
- Hard rules: facts must be stated by or about the client; a staff QUESTION is
  not a fact; never guess names; when unsure omit the field (no op). voucherSize
  is the bedroom count as a string integer. housingAuthority MUST be one of the
  vocabulary values (list them) or omitted. porting value is 'true' or 'false'.
- statusAdvance.suggest=true ONLY when the client clearly states their voucher or
  RTA is now in hand/approved.
- typeSuggestion ONLY when the profile contactType is 'unknown' and the person is
  clearly a tenant (seeking housing for themselves) or landlord (offers/manages
  housing). If they identify as a caseworker, do NOT emit typeSuggestion; add a
  noteLine 'Identified as a caseworker (<org>)'.
- phoneAddition ONLY when the client states another number is also theirs.
- noteLines: NEW secondary facts not already present in the profile notes
  (stairs OK, last moved, household size, rent portion, utility debt, other
  useful screening facts). Do not restate facts already in notes.
- User content layout (buildExtractionUserContent): a `CURRENT PROFILE` JSON
  block (the ExtractionProfileSnapshot verbatim) then a `TRANSCRIPT` section,
  one line per utterance: `<at> [<speaker>] <text>` in chronological order.

- [ ] **Step 1:** Write schema.test.ts: EXTRACTION_SCHEMA has
  additionalProperties:false at every object level (walk it recursively in the
  test); parseExtractionText round-trips a full valid payload; clamps 7 noteLines
  to 5 and long strings to 200; drops unknown field keys; SyntaxError on garbage;
  prompt builder output contains the vocabulary strings, the profile JSON, and
  chronological transcript lines.
- [ ] **Step 2:** Run - FAIL. **Step 3:** Implement both modules.
- [ ] **Step 4:** Run - PASS; run `npm run typecheck` (clears Task 3's deferred
  check if the builder took the strict order).
- [ ] **Step 5:** Commit: `feat(extraction): output schema + prompt builder`.

### Task 5: Apply service (the write policy)

**Files:**
- Create: `app/src/services/extraction/apply.ts`
- Test: `app/src/services/extraction/apply.test.ts`

**Interfaces:**
- Consumes: ExtractionResult/ExtractionProfileSnapshot (Task 3), extractionRepo
  (Task 1), contactsRepo.update/addPhone, auditRepo.append, events bus.
- Produces:

```ts
export interface ApplyDeps {
  contacts: Pick<ReturnType<typeof createContactsRepo>, 'update' | 'addPhone' | 'findByPhone'>;
  extraction: Pick<ReturnType<typeof createExtractionRepo>, 'putSuggestion' | 'deleteSuggestion'>;
  audit: { append(entityKey: string, type: string, payload?: Record<string, unknown>): Promise<unknown> };
  events: { emit(name: string, payload: unknown): void };
  logger: Logger;
  now(): string; // ISO
}

export interface ApplyOutcome {
  wrote: string[];       // field names directly written
  suggested: string[];   // suggestion targets upserted
  notedLines: number;
}

export async function applyExtraction(
  deps: ApplyDeps,
  ctx: { contact: ContactItem; conversationId: string; cursorTsMsgId?: string; result: ExtractionResult },
): Promise<ApplyOutcome>;
```

Behavior to implement and pin with tests (this is the heart of the feature -
be exhaustive):

1. Field ops apply ONLY when `ctx.contact.type === 'tenant'` for tenant facts
   (voucherSize, housingAuthority, pets, evictions, tenure, porting);
   firstName/lastName apply for tenant AND unknown contacts. All ops ignored for
   landlord/team_member (log, no-op).
2. Coercion/validation per field before any write/suggest (invalid -> skip + log):
   voucherSize: string of digits, int 0..12; porting: 'true'|'false' -> boolean;
   housingAuthority: must be in HOUSING_AUTHORITY_VOCAB; names/pets/evictions/
   tenure: non-empty string, <= 120 chars after trim.
3. `op:'none'` -> nothing. `op:'write'` -> ONE contacts.update patch containing
   all written fields plus, per field, `<field>_source: { source:'ai', at,
   conversationId, tsMsgId? }`. Occupied-field writes are permitted (model judged
   equivalence) but the audit payload records `{ field, from, to, reason }` per
   field: `audit.append('contacts#<id>', 'ai_extraction_applied', { fields: [...], conversationId })`.
4. `op:'suggest'` -> skip if suggestedValue string-equals current value exactly
   (belt-and-braces); else extraction.putSuggestion({ ownerContactId, target:
   field, currentValue, suggestedValue, reason, conversationId, tsMsgId }).
5. statusAdvance: only when contact.type==='tenant' AND contact.status==='onboarding'
   -> putSuggestion target 'status', suggestedValue 'searching', currentValue
   contact.status. Any other status -> ignore (log debug).
6. typeSuggestion: only when contact.type==='unknown' -> putSuggestion target
   'type', suggestedValue value ('tenant'|'landlord').
7. phoneAddition: normalize with the same E.164 normalizer the contacts route
   uses (import it - find the normalize helper contacts.ts uses ~1613-1690, it
   lives in a lib; reuse, do not re-implement). Skip when the number is already
   one of contact's phones. When `deps.contacts.findByPhone(phone)` resolves to a
   DIFFERENT contactId -> skip + noteLine
   `Mentioned number <phone> which belongs to another contact` (do NOT suggest).
   Else putSuggestion target 'phone', suggestedValue = E.164, reason/label in
   reason.
8. noteLines: filter empties, cap 5, format each as `[Auto - <MMM D>] <line>`
   (e.g. `[Auto - Jul 16]`, month from deps.now()); append to contact.notes via
   read-modify-write on the ctx.contact snapshot: `contacts.update(id, { notes:
   existingTrimmed + '\n' + joined })` (or just joined when empty). The
   lost-update race with a concurrent human edit is ACCEPTED and documented in a
   code comment (single scalar; low frequency).
9. Every side-effect write is BEST-EFFORT try/catch (mirror the repo posture) -
   a suggestion failure must not abort field writes; collect and log.
10. After any mutation, `deps.events.emit('suggestion.updated', { contactId })`
    (fire once, only when wrote/suggested/notedLines > 0).
11. Return ApplyOutcome.

- [ ] **Step 1:** Write apply.test.ts with in-memory stubs for all deps (no
  DynamoDB): empty-field write stamps `<field>_source`; occupied write allowed +
  audited with from/to; suggest on conflict; suggest skipped when equal;
  landlord contact -> all no-op; voucherSize '2' coerces to 2, '15' skipped,
  'two' skipped; housingAuthority off-vocab skipped; porting 'true' -> true;
  statusAdvance only from onboarding; typeSuggestion only for unknown; phone
  already-owned skipped, other-contact-owned becomes a note, novel number
  suggested; noteLines capped at 5 and prefixed `[Auto - `; notes append
  preserves existing text with newline join; single suggestion.updated emit;
  best-effort isolation (putSuggestion throws -> update still called, outcome
  reflects only successes).
- [ ] **Step 2:** Run - FAIL. **Step 3:** Implement apply.ts.
- [ ] **Step 4:** Run - PASS. **Step 5:** Commit:
  `feat(extraction): apply service - guarded write policy`.

### Task 6: Webhook hook - sliding due upsert

**Files:**
- Modify: `app/src/routes/webhooks/twilio.ts`
- Test: extend the existing twilio webhook test file (find it via
  `rg -l "createTwilioWebhookRouter" app/src --glob '*.test.ts'`)

**Interfaces:**
- Consumes: extractionRepo.scheduleExtraction (Task 1), config.aiExtractionEnabled,
  config.aiExtractionDebounceMs.
- Produces: after any FRESH inbound append (`!appended.deduped`) on the 1:1 path
  (fresh-append block ~L749-762, beside the existing events.emit calls) AND the
  relay twin block (~L417-425), when `config.aiExtractionEnabled` and the
  resolved conversation's type is `tenant_1to1` or `unknown_1to1` (relay/landlord
  conversations are NOT extraction sources in v1):
  `await extraction.scheduleExtraction(persistedConversationId, 'sms', new Date(Date.now() + config.aiExtractionDebounceMs).toISOString())`
  wrapped in best-effort try/catch (a schedule failure never fails the webhook ack).
  Inject the repo through the router factory deps like every other repo
  (createTwilioWebhookRouter deps at ~L173-186, default to the real singleton).

- [ ] **Step 1:** Extend the webhook tests: fresh inbound tenant message ->
  scheduleExtraction called with conversationId + dueAt ~= now+debounce; deduped
  redelivery -> NOT called; flag off -> NOT called; landlord_1to1 conversation ->
  NOT called; unknown_1to1 -> called; schedule throwing -> webhook still acks 200.
  Use a stub extraction repo in deps.
- [ ] **Step 2:** Run - FAIL. **Step 3:** Implement (deps plumbing + two call
  sites + config gate).
- [ ] **Step 4:** Run webhook suite - PASS. **Step 5:** Commit:
  `feat(extraction): inbound webhook schedules sliding extraction`.

### Task 7: Worker job, poller registration, dev tick

**Files:**
- Create: `app/src/jobs/extraction.ts`
- Modify: `app/src/worker.ts` (third poller, mirror tour poll ~L96-133: 60s
  setInterval + .unref(), gated on `config.aiExtractionEnabled`)
- Modify: `app/src/routes/dev.ts` (+ `POST /__dev/extraction/tick`, mirror
  tour-reminders tick ~L244; RegisterDevRouterDeps injection ~67-71)
- Modify: `app/src/lib/events.ts` (AppEventMap + interface: `'suggestion.updated': { contactId: string }`)
- Modify: `app/src/routes/api.ts` (SSE on-handler ~1380-1385 AND close-off list
  ~1410-1415 for suggestion.updated)
- Test: `app/src/jobs/extraction.test.ts`

**Interfaces (Produces):**

```ts
// jobs/extraction.ts
export interface ExtractionJobDeps {
  repo: ReturnType<typeof createExtractionRepo>;
  conversations: Pick<..., 'getById'>;
  messages: Pick<..., 'listByConversation'>;
  contacts: Pick<..., 'getById' | 'findByPhone' | 'update' | 'addPhone'>;
  driver: ExtractionDriver;
  applyDeps: ApplyDeps;      // built once by the caller
  config: Pick<AppConfig, 'aiExtractionDebounceMs'>;
  logger: Logger;
}
export async function runDueExtractions(nowIso: string, deps: ExtractionJobDeps): Promise<{ processed: number; failed: number }>;
export const MAX_EXTRACTION_ATTEMPTS = 5;
export const MAX_TRANSCRIPT_MESSAGES = 50;
export const MAX_TRANSCRIPT_AGE_DAYS = 30;
```

runDueExtractions behavior:
1. `repo.listDue(nowIso)`; per row try/catch-log-continue (isolation, mirror
   tourReminders ~228-239).
2. `repo.claim(conversationId, nowIso, row.dueAt)` - false -> skip silently.
3. Load conversation (getById); resolve the contact: 1:1 participant ->
   contacts by participants[0].contactId when present else findByPhone
   (participant_phone). Missing conversation/contact, or contact type
   landlord/team_member, or phone_ref item -> `repo.complete(conversationId,
   row.cursor ?? '', nowIso)` (nothing to do; do not fail forever).
4. Transcript: `messages.listByConversation(conversationId, { limit: MAX_TRANSCRIPT_MESSAGES })`
   -> newest-first, REVERSE to chronological, drop rows older than
   MAX_TRANSCRIPT_AGE_DAYS, map to TranscriptUtterance (speaker: direction
   'inbound' -> 'client', else 'staff'; text: body ?? '[media]'; channel 'sms').
   Note: this window INCLUDES messages before the cursor deliberately (context);
   the cursor marks progress, not a hard filter. Skip run (complete with same
   cursor) when there are no client utterances newer than row.cursor.
5. Build ExtractionProfileSnapshot from the contact (phones via contactPhones()).
6. `driver.extract(input)` -> applyExtraction(applyDeps, { contact,
   conversationId, cursorTsMsgId: newestTsMsgId, result }).
7. `repo.complete(conversationId, newestTsMsgId, nowIso)`.
8. Failure path (driver throw incl. ExtractionRefusedError, apply throw):
   attempts+1 via `repo.fail(conversationId, message, nextDueAt)` where nextDueAt
   = now + debounce * 2^attempts capped at 1h, or null (park) when attempts+1 >=
   MAX_EXTRACTION_ATTEMPTS.

Worker + dev tick:
- worker.ts: build deps once (lazy dynamic imports like the tour poll), driver
  from createExtractionDriver(config...), 60s setInterval gated on
  config.aiExtractionEnabled.
- dev.ts tick: `POST /__dev/extraction/tick` computes
  `nowIso = new Date(Date.now() + config.aiExtractionDebounceMs + 1000).toISOString()`
  (so tests need not wait out the debounce) and runs runDueExtractions with the
  SAME dep builder; responds `{ processed, failed }`. In-app tick emits reach SSE
  clients (worker emits do not - single-instance seam; the dashboard's live
  update path is therefore dev/tick + accept/dismiss only in v1; poller-driven
  changes appear on next fetch. State this in a comment).

- [ ] **Step 1:** Write jobs/extraction.test.ts with stub repos + fake driver
  (real apply.ts with stub deps is fine): happy path writes cursor + calls apply
  with chronological transcript; claim-false skips; landlord contact completes
  without driver call; no-new-client-messages completes without driver call;
  driver throw -> fail with doubled nextDueAt; 5th failure parks (nextDueAt null);
  refusal error follows the failure path.
- [ ] **Step 2:** Run - FAIL. **Step 3:** Implement job + worker registration +
  dev tick + events.ts/api.ts SSE registration.
- [ ] **Step 4:** Run job suite + `npm run typecheck` - PASS.
- [ ] **Step 5:** Commit: `feat(extraction): worker poller + dev tick + suggestion.updated SSE`.

### Task 8: Review API routes + provenance-clear on human edit

**Files:**
- Create: `app/src/routes/suggestions.ts` (router factory pattern like
  routes/statusTransition.ts)
- Modify: `app/src/app.ts` (mount under /api - copy how statusTransition router
  is mounted)
- Modify: `app/src/routes/contacts.ts` (PATCH provenance-clear + type-suggestion
  cleanup)
- Test: `app/src/routes/suggestions.test.ts` (mirror an existing route test,
  e.g. the statusTransition route tests - supertest against buildApp or router)

**Interfaces (Produces - dashboard consumes these exact shapes):**

```
GET  /api/contacts/:contactId/suggestions
  -> 200 { suggestions: SuggestionItem[] }        (empty array when none)
POST /api/contacts/:contactId/suggestions/:target/accept   (no body)
  -> 200 { contact: Contact, suggestions: SuggestionItem[] }  (updated contact + remaining)
  -> 404 unknown contact or no pending suggestion for target
  -> 409 { error: 'phone_in_use' } for phone target conflicts
POST /api/contacts/:contactId/suggestions/:target/dismiss  (no body)
  -> 200 { suggestions: SuggestionItem[] }
```

Accept semantics per target (all audited, all emit suggestion.updated):
- field targets (the eight ExtractableField values): coerce like apply.ts
  (voucherSize int, porting boolean), `contacts.update(id, { [field]: value,
  [field + '_source']: { source: 'ai', at: now, conversationId, tsMsgId,
  accepted_by: actor } })`, audit `ai_suggestion_accepted` { target, from, to },
  delete suggestion.
- 'status': call the status transition service
  (createStatusTransitionService - same construction the statusTransition route
  uses) `setTenantStatus(contactId, { toStatus: suggestion.suggestedValue,
  source: 'ai', actor })`; delete suggestion. If the contact's status is no
  longer 'onboarding' (stale suggestion), still attempt the transition; the
  service/allowlist governs validity - surface a 409 with the service error if
  it rejects.
- 'phone': normalize; findByPhone conflict -> 409 phone_in_use (suggestion NOT
  deleted); else contacts.addPhone + audit contact_phone_added + activity
  number_added milestone (mirror the POST /phones route behavior ~1613-1690);
  delete suggestion.
- 'type': NOT accepted via this route - return 400
  { error: 'accept_type_via_triage' }. (The dashboard triages via the existing
  PATCH { type }; see below.)
- Actor: same auth/session extraction as other routes (copy how contacts.ts
  reads the actor for audit).

contacts.ts PATCH additions (choke point ~1217-1226):
- For every changedField f that is one of the eight extractable fields: add
  `patch[f + '_source'] = null` (REMOVE) so human edits clear AI provenance -
  UNLESS the incoming patch itself carries `f + '_source'` (it never does from
  the dashboard today; the guard is future-proofing).
- Best-effort: for every changedField, `extraction.deleteSuggestion(id, f)` (a
  human edit supersedes the pending suggestion). When `type` changed:
  deleteSuggestion(id, 'type').

- [ ] **Step 1:** Write suggestions.test.ts: list returns pending; accept-field
  writes value + provenance + deletes + returns updated contact; accept-status
  routes through the transition service (assert status + status_source 'ai');
  accept-phone adds phone, 409 on conflict keeps suggestion; accept-type -> 400;
  dismiss deletes + audits; 404s for unknown contact/target. PATCH tests: human
  edit to pets clears pets_source and deletes the pets suggestion; type triage
  deletes the type suggestion.
- [ ] **Step 2:** Run - FAIL. **Step 3:** Implement router + mount + PATCH hook.
- [ ] **Step 4:** Run route suites + typecheck - PASS.
- [ ] **Step 5:** Commit: `feat(extraction): suggestion review API + provenance clear on human edit`.

### Task 9: Dashboard - badges, chips, triage recommendation, Today tile

**Files:**
- Modify: `dashboard/src/api/endpoints.ts` (getSuggestions, acceptSuggestion,
  dismissSuggestion - typed fns beside updateContact ~L931)
- Create: `dashboard/src/routes/contact/useSuggestions.ts` (hand-rolled hook like
  useContact: fetch on mount + expose { suggestions, refetch, accept, dismiss };
  subscribe to suggestion.updated via useEventStream and refetch on match)
- Create: `dashboard/src/routes/contact/SuggestionChip.tsx` +
  `dashboard/src/routes/contact/AutoBadge.tsx`
- Modify: `dashboard/src/api/EventStreamProvider.tsx` (register
  'suggestion.updated' beside the existing event names)
- Modify: `dashboard/src/routes/contact/ContactDetail.tsx` (own useSuggestions,
  pass suggestions + handlers down; accept applies returned contact via
  setContact)
- Modify: `dashboard/src/routes/contact/TenantFile.tsx` (badges + chips on the
  field rows; a status-advance chip near the status area of the file card)
- Modify: `dashboard/src/routes/contact/UnknownFile.tsx` (AI type recommendation
  line inside the Needs-triage card: "AI suggests: Tenant - <reason>"; the
  existing Mark-as buttons remain the action; after onTriage the suggestion
  disappears server-side)
- Modify: `app/src/routes/today.ts` + `dashboard/src/routes/today/Today.tsx` +
  `dashboard/src/routes/today/useToday.ts` (new group)
- Test: `dashboard/src/routes/contact/SuggestionChip.test.tsx`,
  extend `ContactDetail.test.tsx`, `Today.test.tsx` (mirror existing *.test.tsx
  patterns - testing-library, fetch mocked at the endpoints layer)

**Interfaces:**
- Consumes: Task 8 routes verbatim.
- Produces (UI contracts the e2e selectors rely on - keep these accessible
  names EXACTLY):
  - AutoBadge: a `<span>` with accessible name `Auto` and a title/tooltip
    `Extracted from a conversation on <date>` rendered next to a field value
    whose contact carries `<field>_source` with source 'ai'.
  - SuggestionChip: container role=group with accessible name
    `AI suggestion for <label>`; text `AI heard "<value>"`; buttons
    `Accept` and `Dismiss` (getByRole('button', { name: 'Accept' }) within the
    chip group).
  - Status chip label: `AI suggestion for status` with text
    `AI heard "searching"`.
  - Today group: TodayGroup `'ai_suggestions'`, GROUP_META label
    `AI suggestions to review`, items `{ group: 'ai_suggestions', refType:
    'contact', refId: contactId, who: <contact name>, why: <n> suggestion(s) }`
    built in today.ts from `extractionRepo.listPending({ limit: 100 })` grouped
    by ownerContactId (cap 20 items; count = distinct contacts).

Notes for the builder:
- Field rows live inside TenantFile's card layout - render AutoBadge inline
  after the value, SuggestionChip on the line below its field.
- contact type guard: chips only render for targets present in the fetched
  suggestions; no client-side policy logic (server is authoritative).
- Accept handler: `const res = await acceptSuggestion(id, target);
  setContact(res.contact); setSuggestions(res.suggestions);` - matches the
  update-in-place convention. 409 phone_in_use -> inline error text on the chip.
- useToday: add 'ai_suggestions' to its SSE debounce list (suggestion.updated).

- [ ] **Step 1:** Write the component tests: AutoBadge renders only when
  `<field>_source.source === 'ai'`; chip renders value + Accept/Dismiss and fires
  handlers; ContactDetail applies accept response via setContact (mock endpoints
  module); UnknownFile shows the AI-suggests line when a type suggestion exists;
  Today renders the new group with count.
- [ ] **Step 2:** Run `npm test --workspace dashboard` - FAIL on the new tests.
- [ ] **Step 3:** Implement all files.
- [ ] **Step 4:** Run dashboard tests + `npm run typecheck` - PASS.
- [ ] **Step 5:** Commit: `feat(extraction): dashboard review UI + Today group`.

### Task 10: End-to-end spec (hermetic, fake driver)

**Files:**
- Create: `e2e/fixtures/extraction.ts` (helper: `extractionTick(request)` ->
  POST /__dev/extraction/tick; `sendExtractSms(request, phone, payload)` ->
  fakeTwilio postInboundSms with body `EXTRACT:` + JSON.stringify(payload))
- Create: `e2e/tests/flows/conversation-fact-extraction.spec.ts`
- Modify: `e2e/scenarios/steps.ts` (helpers if the spec reads better with them)
- Modify: `e2e/support/selectors.md` (add the chip/badge selectors to the table)

**Interfaces:** Consumes the accessible names pinned in Task 9 and the fake
driver protocol from Task 3. EXTRACTION_DRIVER=fake is set by e2e-session/e2e
env (Task 2).

Spec scenarios (each a test; reseed via the standard fixture; create fresh
contacts via steps helpers so lean seed stays byte-stable):
1. Empty-field direct write: fresh tenant contact with no pets value; inbound
   `EXTRACT:{"fields":{"pets":{"op":"write","value":"yes","reason":"said has a dog"}}}`;
   extractionTick; open contact page; expect pets value 'yes' with the `Auto`
   badge visible.
2. Conflict -> chip -> Accept: tenant with voucherSize 2; inbound EXTRACT suggest
   voucherSize 3; tick; contact page shows chip `AI heard "3"`; click Accept;
   value shows 3 (and badge); chip gone.
3. Dismiss: as (2) but Dismiss; value unchanged; chip gone.
4. Status advance: tenant in onboarding; EXTRACT `{"statusAdvance":{"suggest":true,"reason":"voucher in hand"}}`;
   tick; status chip visible; Accept; header status shows Searching.
5. Type recommendation: unknown contact texts EXTRACT
   `{"typeSuggestion":{"value":"tenant","reason":"looking for a home"}}`; tick;
   Needs-triage card shows `AI suggests: Tenant`; Mark as Tenant; card resolves
   (existing triage assertions).
6. Today tile: after (2)'s suggestion exists (before accept), Today page shows
   the `AI suggestions to review` group with count >= 1.
7. Debounce slide (API-level, no UI): two quick inbound texts -> exactly one
   extraction run after tick (assert via GET suggestions/processed count from
   tick response `{ processed: 1 }`).

- [ ] **Step 1:** Write the fixture + spec. **Step 2:** Run just this spec from
  the e2e workspace dir (filtered run; NOT `npm run e2e -- --flag` from root -
  npm eats flags) - expect FAIL (UI not wired yet if tasks ran out of order;
  normally these pass immediately after Tasks 1-9 - the "failing first" proof
  for e2e is the spec failing on any missing piece, then green).
- [ ] **Step 3:** Fix anything the spec surfaces. **Step 4:** Run
  `timeout 1500 npm run e2e` (FULL suite, from the worktree) - all green
  including the two known flakes' re-run rule (re-run full suite once before
  blaming a flake; report both runs).
- [ ] **Step 5:** Update selectors.md + commit:
  `test(extraction): hermetic e2e for extraction pipeline + review UI`.

### Task 11: Docs, issue filing, owed-ops record

**Files:**
- Create: `docs/issues/caseworker-contact-type.md` (copy _TEMPLATE.md; type:
  decision, severity: medium, status: open - "n8n world models caseworkers;
  app ContactType lacks it; v1 extraction downgrades caseworker ID to a note.
  Decide: add ContactType 'caseworker' or keep notes-only.")
- Modify: `RUNBOOK.md` (operational only): new section "AI extraction" - env
  flags, model knob, how to tick manually in dev, owed ops on deploy:
  (1) terraform plan/apply for ai_extraction table, (2) `npm install` (new dep),
  (3) push ANTHROPIC_API_KEY via secrets flow, (4) set AI_EXTRACTION_ENABLED,
  (5) restart app+worker. Until then the feature is dormant (flag default off in
  deployed envs).
- Modify: `documentation/GLOSSARY.md` ONLY if it lacks a "suggestion" noun -
  add one line defining "suggestion (AI)" as the pending-review record.

- [ ] **Step 1:** Write all three. **Step 2:** `npm run issues` regenerates the
  index (do not hand-edit INDEX.md). **Step 3:** ASCII-check both new docs.
- [ ] **Step 4:** `npm run typecheck && npm test` full - green.
- [ ] **Step 5:** Commit: `docs(extraction): runbook, caseworker issue, glossary`.

---

## Self-review notes (planner)

- Spec coverage: 4.1 transcript interface (T3/T7), 4.2 sliding debounce (T1/T6,
  pinned by claim's listedDueAt clause + e2e 7), 4.3 call + config + kill switch
  (T2/T3/T4), 4.4 write policy (T5), 4.5 provenance + human-edit clear (T5/T8),
  4.6 suggestions + counting GSI (T1/T8/T9), 4.7 status advance (T5/T8/T9 e2e 4),
  4.8 classification + phone (T5/T8/T9 e2e 5), UI section 5 (T9), config/ops 6
  (T2/T11), testing 7 (every task + T10), voice seam 8 (channel fields
  throughout; no voice code), decisions log 9 (constraints block).
- Deviation from spec 4.6: suggestions live in the NEW ai_extraction table, not
  the contacts table - the contacts table has no sort key, so per-owner listing
  there would need a contacts-table GSI anyway; one new table serves due items +
  suggestions + the pending count. Spec's "sparse GSI" intent is honored
  (byPending). Recorded here as the adjudication of record.
- Deviation from spec 4.8: caseworker classification downgraded to notes line
  (no ContactType exists) - flagged in Global Constraints + issue in T11.
- The fake-driver EXTRACT protocol is a TEST seam only; it ships in prod code
  (extractionFake.ts) but is unreachable: config rejects driver 'fake' in
  production (T2 test pins this).
