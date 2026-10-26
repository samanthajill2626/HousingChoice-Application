# WP1 B1 Ranking inputs - design

Status: DRAFT revision 1 (2026-10-26), before design review.
Charter: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md.
This slice implements charter sections 6.3 (per-send reactions), 6.4
(extraction as the reading layer, AMENDED 2026-10-26), 7.3 (the tenant
completeness fields as stored inputs; the pass itself is B2) and 9.2 (the
priority boolean), per the section 15.1 B1 row. Charter decisions bind; a
change goes to Cameron and is recorded in charter section 20.
Branch: `feat/wp1-b1-ranking-inputs` (worktree `W:\tmp\wp1-b1-ranking-inputs`,
cut from main @d0e2c2d8).
Review records: `docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/`
(intent.md holds Cameron's decisions verbatim).

Vocabulary (documentation/GLOSSARY.md): a `unit` is a "property" to staff.
"Notes box" = the tenant's `notes` field, shown on the tenant record as the
"Preferences & notes" card, where extraction appends dated
`[Auto - <date>]` lines and staff also type. "Staff notes" = `staff_notes`,
human-only. A "Notes line" = one `[Auto - <date>] <text>` line extraction
appends. "Reaction" = a tenant's extracted response to one property sent to
them, stored on that pair's listing_sends row (charter 6.3).

## 1. Goal

Start collecting the facts the ranker (B2) will read, before anything ranks:

- Four tenant fields staff can see and edit and extraction can fill: area
  preference, maximum tenant portion, accessibility need, preferences and
  constraints.
- A Priority on/off switch on each property.
- Extraction that writes anything that might matter to matching a tenant
  with a home as Notes lines (with a confidence floor and a never-written
  list), and records a tenant's reaction to each property actually sent to
  them.
- A real-model test proving the never-written list holds. It is B1's merge
  gate (charter 6.4, amended).

Nothing ranks in B1 and nothing new is shown to a tenant.

## 2. Decisions

### D1. One list of tenant matching inputs

A new leaf module `app/src/lib/tenantMatchingInputs.ts` (imports nothing,
like `services/extraction/runTypes.ts`) holds the ONE list of the four B1
tenant matching inputs:

| key | staff label | kind | source |
|---|---|---|---|
| `area_preference` | Area preference | text | field |
| `max_tenant_portion` | Maximum tenant portion | dollars | field |
| `accessibility_need` | Accessibility need | text | field |
| `preferences_constraints` | Preferences and constraints | text | field |

Each entry: `key`, `label`, `kind` (`text` or `dollars`), `source`
(`field` today; the type admits `notes` so a later change is a value edit,
charter 6.4 amended, docs/issues/extraction-fields-to-notes.md).

Readers in B1, every one driven by the list rather than by the four names:

- extraction: the field entries of the schema, the CURRENT PROFILE block,
  coercion, decision targets and tenant-only targets (D3);
- the contacts PATCH and create parsers (D2);
- the dashboard edit form inputs and the record rows, through a dashboard
  mirror of the list with a drift test that imports the app module (the
  `REQUIREMENT_ITEMS` mirror precedent, requirementsMirror.test.ts).

B2's completeness pass reads the same list (charter 7.3). Only entries with
`source: 'field'` are stored fields; B1 has no `notes` entry and builds no
code path for one beyond the type.

Why: Cameron 2026-10-26: "the source of information, like area preferences,
can be easily changed from a specific field to just existing in the notes
section." Moving a fact later = change its entry, delete its form input
(the mirror entry), and the widened notes instruction picks the fact up.

### D2. The four fields on the record, the edit form and the record display

Storage: four optional attributes on the tenant contact, keys as in D1.
Text values are strings; `max_tenant_portion` is a whole number of dollars
per month. Absent means not recorded.

Server (routes/contacts.ts `parseTriageBody` and `parseCreateBody`):

- Text: must be a string; TRIMMED; at most 500 characters after trimming
  (400 "<label> must be 500 characters or fewer"); an empty string after
  trim, or `null`, CLEARS the field (REMOVE), following the
  `voucher_expiration_date` pattern, not the pets/tenure pattern that stores
  `''`.
- Dollars: an integer 0..20000, or `null` / `''` to clear. A non-integer or
  out-of-range value is a 400 ("Maximum tenant portion must be a whole
  dollar amount from 0 to 20000."). Strings are not accepted (the dashboard
  sends a number).
- Tenant-only is a UI guarantee, as for the other intake fields
  (contactsRepo.ts:286-287); the server does not gate by type.
- Provenance: because the four become extractable (D3), they join
  `PROVENANCE_FIELDS` through `EXTRACTABLE_FIELDS`, so a staff PATCH clears
  `<key>_source` exactly as for pets today (contacts.ts:1939-1947).
- Audit: the existing `contact_updated` event with field names.

Dashboard:

- Edit form (ContactEditForm.tsx, tenant only, the "Eligibility intake"
  fieldset): three text inputs (Area preference, Accessibility need as
  single-line inputs; Preferences and constraints as a textarea) and one
  number input (Maximum tenant portion, whole dollars, `$` shown beside
  it). Inputs are trimmed before diffing; a cleared input sends `null`.
  Client-side message for a bad portion matches the server's.
- Record (TenantFile.tsx, the EligibilityIntakeCard): four always-render
  rows in list order, BLANK when unset, the AutoBadge and suggestion chip
  as the other intake rows have. The portion renders as `$1,200 / month`.
- Labels are exact and distinct: no new label may contain an existing
  intake label as a substring (e2e `getByLabel('Pets')` at steps.ts:930 is
  not exact).
- The existing card titled "Preferences & notes" keeps its title; the new
  "Preferences and constraints" row lives in the intake card.
- Suggestion labels: SUGGESTION_TARGET_LABEL gains the four (from the
  mirror).
- API types: `Contact`, `ContactPatch`, `CreateContactInput` gain the four
  keys and their `_source` keys. The create form (ContactCreateForm.tsx)
  does NOT gain inputs; the server create parser accepts them so the API
  stays symmetric.

### D3. Extraction reconciles the four fields

The four join `EXTRACTABLE_FIELDS` (8 -> 12) through the D1 list and follow
the existing reconciliation unchanged: op `write` when empty or the same
fact, `suggest` when it conflicts, demotion to a suggestion for a window
with unknown-speaker content, provenance stamp on a direct write, staff
accept/dismiss through the existing suggestions path.

- Schema: four more `fieldOpSchema` entries in `fields`, all required (the
  schema stays at zero optional parameters, schema.ts:8-13).
- Coercion, in BOTH `coerceField` (apply.ts) and `coerceAccept`
  (suggestionResolution.ts), driven by `kind`:
  - text: trimmed, at most 300 characters from the model (longer is cut at
    a word boundary), empty -> dropped;
  - dollars: strip `$`, commas and spaces; must then be an integer 0..20000,
    otherwise dropped (no rounding of "1200.50": dropped).
- Tenant-only: the four join `TENANT_ONLY_TARGETS`.
- Decision targets: the four join `DECISION_TARGETS` (12 -> 16); every
  hard-coded "twelve"/"eleven" comment and count is updated, including
  `SWEEP_MAX_ATTEMPTS_PER_CALL` (journalSweep.ts:84-86), and the dashboard
  mirror `DECISION_TARGET_ORDER` (AiRunDetail.tsx:40-44).
- CURRENT PROFILE (jobs/extraction.ts `toProfile`): carries the four.
- Prompt: the field guidance names each with its meaning:
  - area preference: where the tenant wants to live (neighborhoods,
    cities, zips, "near X");
  - maximum tenant portion: the most the tenant says they can pay
    themselves per month toward rent for a new home, in whole dollars
    (not the full rent, not the voucher amount);
  - accessibility need: a need the HOME must meet for the tenant or a
    household member (no stairs, ground floor, wheelchair access, grab
    bars); the bare need, never a diagnosis;
  - preferences and constraints: anything else the tenant states they
    want or cannot accept in a home (bedrooms beyond the voucher, school,
    yard, move-in date, "no apartments").
  The noteLines examples "stairs are OK or a problem" and "their rent
  portion" (prompt.ts:107-109) are REMOVED, since those facts now have
  fields.

The never-written list does NOT govern these four fields (charter 6.4,
amended 2026-10-26).

### D4. Notes lines: matching facts with a confidence floor

- Instruction: noteLines widen from "secondary facts" to facts that might
  matter to matching this person with a home or to staff understanding
  their situation, that no field or other output covers. The existing
  reconcile, append-only, short-line and no-address rules stay verbatim.
  Screening facts (utility debt and the like) remain allowed.
- Never-written list, stated in the prompt: never write a line stating
  race, color, religion, sex, national origin, familial facts beyond
  household size (no pregnancy, marital status, children's ages or
  custody), or disability or medical facts other than the stated
  accessibility need (which goes in its field, D3) and an assistance
  animal. Household size, the tenant's portion and an assistance animal
  stay allowed. Charter 6.4.
- Shape: `noteLines` items become `{ text, confidence }` (confidence a
  number 0..1). Both keys required.
- Floor: `EXTRACTION_FACT_MIN_CONFIDENCE`, default 0.7, parsed fail-fast
  (finite number, 0 < x <= 1, else startup throws, a new range check since
  no decimal precedent exists, config.ts). A line below the floor is not
  appended. Confidence is clamped to 0..1 and a non-number reads as 0.
- Enforced in APPLY, not only in the parser, because the fake driver
  bypasses `parseExtractionText` (adapters/extractionFake.ts).
- System lines (`noteStrings`, today only "Mentioned number X which belongs
  to another contact", apply.ts:666) carry no confidence and are not
  subject to the floor.
- Unknown-speaker demotion: when `hasInferredRoleContent` is true, NO line
  is appended - model lines and system lines alike (charter 6.4: "appends
  no lines"). A change from today (apply.ts:713-751 ignores demotion).
  See Q1 in section 8 for the two consequences found in the code.
- Kept as is: the five-line cap per run, the 200-character clamp, the
  `[Auto - <date>]` prefix, the verbatim retry guard (apply.ts:731-740),
  and the read-modify-write of `notes`.
- Run record: the AI run keeps today's `notedLines` count and gains
  `notesBelowFloor` and `notesDemoted` counts (aiRunsRepo record fields,
  not decision targets).

### D5. Reactions: one reading per send, on the pair row

Which properties. Extraction runs on tenant and unknown contacts; reactions
are read for TENANT contacts only. The job reads `listByContact(contactId)`
and keeps the rows that are LISTED (`isListed`, listingSendsRepo.ts:235)
AND either carry a counted share whose key is not the flyer key
(`FLYER_SHARE_KEY`, lib/shareLedgerKeys.ts) or are legacy rows with
`sentAt` and no `shares` (charter 6.3). A pending, unconfirmed or failed
share, or a flyer sign-up alone, does not qualify. At most the 20 newest by
`sentAt`.

Prompt input: a PROPERTIES SENT block, built like the organization list
block (orgListBlock.ts: rendered once per run, before TRANSCRIPT, never
containing the word TRANSCRIPT, fingerprinted into the run record as
`sentPropertiesFingerprint`). One line per property: a handle `p1..pN`,
the address line and city, the date(s) sent, and the reactions already
recorded on the row (kind and short text) so the model reconciles rather
than repeats. An empty block reads "PROPERTIES SENT: none".

Message handles: each transcript line in the PROMPT gains a handle
`m1..mN` (per message; every utterance of one call shares its message's
handle). The handle is added at prompt assembly; `renderUtteranceLine` and
the run log's per-message hash stay unchanged, so historic runs still
verify (routes/aiRuns.ts:257-259).

Output: a required `reactions` array; each item `{ property, message,
kind, text, confidence }`, all required:

- `property`: a handle from PROPERTIES SENT;
- `message`: the handle of the TENANT'S OWN message that states the
  reaction;
- `kind`: `interested` | `maybe` | `hard_no` | `question`;
- `text`: a short phrase in the tenant's sense ("too far from work",
  "wants to tour Saturday"), at most 200 characters, governed by the
  never-written list;
- `confidence`: 0..1, the same floor as Notes lines.

Prompt rules: only a reaction to a property in PROPERTIES SENT; a reaction
about a property NOT listed (a home they found, a flyer, one staff
mentioned) goes in noteLines instead; one item per message per property;
nothing when the tenant's message does not react to a specific listed
property.

Apply (all in apply, after field writes):

- Drop an item whose property or message handle is unknown, whose message
  is not a client utterance, whose kind is not one of the four, whose text
  is empty after trim, or whose confidence is below the floor.
- Demotion: a window with unknown-speaker content writes no reactions
  (same rule as Notes lines).
- At most 5 reactions per run.
- Stored item: `{ at, kind, text, sourceMsgId, runId }`; `at` is the source
  message's own timestamp, `sourceMsgId` its `tsMsgId`.
- Dedupe: an item whose `(sourceMsgId, kind)` is already on the row is
  skipped, so a re-run of the same window (the cursor advances only after
  apply, jobs/extraction.ts:635-636) appends nothing.
- Row cap: at most 50 reactions per row; when full, the oldest are dropped
  to make room.
- Writer: a new `listingSendsRepo.appendReactions(unitId, contactId, items,
  expect)`: a conditional UpdateCommand that SETs `reactions` (the full
  next list), a fresh `shares_op` token and `updated_at`, conditioned on
  `shares_op = :tok` (or `attribute_not_exists(shares_op)` when the read
  had no token) AND the row being listed (`counted` absent or not false).
  It never touches `shares`, `counted`, `sentAt`, `broadcastId`,
  `declined`, `created_at` or `via`. The caller reads the row
  consistently, computes the next list, and on a condition failure
  re-reads and retries at most 3 times (the `applyLedgerLoop` pattern,
  shareLedger.ts:205-224); a final failure, or a row no longer listed, is
  logged and the reaction dropped (never thrown; the run still completes).
- The repo header's writer list names `appendReactions`, and the
  NO-RESET INVARIANT paragraph gains: no writer except appendReactions
  sets `reactions`; `putShareMemory`, `setDeclined` and `clearDeclined`
  never touch it.
- Never a status: a reaction never sets `declined`, the outcome, or the
  contact status (charter 6.3; WP3 owns an engine-read decline).
- Dependencies: the extraction job and apply deps gain `listingSends`
  (worker.ts, routes/dev.ts and the job test harnesses).
- Run record: `reactionsWritten` and `reactionsDropped` counts.

Read surface: `toListingSendRow` (the wire shape) does NOT expose reactions
in B1; nothing in the dashboard shows them until B3's ranked row. They are
visible in the AI run detail's raw output. See Q3.

Fake driver: accepts `reactions` in its `EXTRACT:` payload (handles as the
prompt would render them) so e2e can drive the writer.

### D6. Priority: an on/off switch on the property

- `unitFields.ts` WRITABLE_FIELDS: `priority` changes from `'string'` to
  the `'boolean'` validator kind (the `same_day_rta` template,
  unitFields.ts:116), storing `true` or `false`. Off and absent read the
  same.
- `unitsRepo.ts` type: `priority?: boolean`. A stored legacy string reads
  as off (`unit.priority === true` is the only on test). Dropped without
  migration: production holds 0 values (charter 9.2).
- Forms: a "Priority" checkbox on BOTH the New and the Edit property form,
  in the Property details section after Subzone, as a `TaggedCheckbox`
  tagged Staff only. `PROPERTY_FORM_FIELDS` gains
  `formField('Priority', ['priority'], 'staff_only')` in app and dashboard
  mirror (row count 35 -> 36 in propertyFormFlyerParity.test.ts and the
  dashboard requirements tests, with a parity SAMPLE). It is never on the
  flyer (unitFields.ts:359 never-list).
- Record: ListingDetail shows a "Priority" row (Yes / No) in the property
  details card, and a "Priority" pill beside the status in the header when
  on.
- Importer: airtableSource.ts parses a priority column that nothing writes;
  unchanged, noted in a comment.
- The model never sees priority (charter 9.2, 6.1); B1 adds no reader.

### D7. The never-written test (B1's merge gate)

A script `app/scripts/extraction-never-written.ts` (exported `main` plus
an `invokedDirectly` guard, the assign-primary-contacts.ts template, so
its logic is unit-testable) runs SYNTHETIC conversations through the
production extraction driver, prompt, schema and apply-side filters
(floor, never-written is the model's job) against the real model.

- Cases: one per excluded kind (race, color, religion, sex, national
  origin, familial beyond household size - pregnancy, marital status,
  children's ages -, disability or medical other than the accessibility
  need), each stating the fact both in a free tenant message and inside a
  reaction to a sent property ("I love it, it's close to my mosque").
  Plus control cases that MUST be written: household size, tenant portion
  (as the field), accessibility need (as the field), an assistance animal
  (as a line), and a plain matching fact ("works nights downtown").
- Detection: each case carries banned terms (case-insensitive) that must
  not appear in any appended line or reaction text, and the control cases
  carry the facts that must appear. The record lists EVERY line and
  reaction written so a person can read them, not only the term check.
- Runs: each case 3 times. Model: `--model`, default `AI_EXTRACTION_MODEL`;
  the gate run uses the model production runs. RUNBOOK.md:1465 says the
  deployed envs set `claude-sonnet-5`; the 2026-09-29 Sonnet 5.5 flip was
  an owed ops step, so Cameron confirms which (Q2). The driver cannot run
  claude-opus-5-5.
- Key: `ANTHROPIC_API_KEY` from the environment, which for the gate run is
  the TESTING key (charter 14). The script prints the key's last four
  characters only, never more.
- Output: a markdown record at a path given by `--out`; the gate run writes
  `docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/never-written-test.md`
  (synthetic content only, safe to commit), with per-case results, token
  usage, truncations and the run's dollar cost.
- Pass: zero banned-term hits across all runs, every control written in
  at least 2 of 3 runs, zero truncations. Exit code 0 on pass, 1 on fail.
- Truncation: the extraction output cap stays 4096 tokens unless the gate
  run truncates; then it is raised (adapters/extraction.ts:184) and the run
  repeated.
- Gate: B1 is not handed back merge-ready until a gate run passes on the
  final prompt, or Cameron decides (charter 6.4 amended). A prompt change
  after a passing run requires a new run.

## 3. Out of scope

- Ranking, cards, the pool, the completeness pass logic, fingerprints (B2).
- Any composer change; showing reactions anywhere (B3).
- The Staff notes comment correction (B2).
- Landlord-side extraction (docs/issues/landlord-conversation-extraction-to-property.md).
- Moving fields to notes (docs/issues/extraction-fields-to-notes.md).
- The tenant create form gaining the four inputs.
- The 30-day demotion persistence (docs/issues/voice-extraction-window-demotion-persistence.md).
- Filters or facets on the new fields.

## 4. Surfaces (write and read) - every one is a plan task or a watch item

Protected state and its mutators/readers:

- Tenant contact, the four fields. Writers: contacts PATCH, contacts create,
  extraction direct write, suggestion accept. Readers: TenantFile intake
  card, edit form, extraction CURRENT PROFILE, suggestion chips, AI run
  detail. Untouched: public intake, importer, seeds (one fully filled
  seed tenant in cast.ts gains the four; lean stays byte-stable unless a
  spec needs them).
- Tenant `notes`. Writers: staff PATCH, extraction append (D4). Reader:
  the Preferences & notes card, extraction CURRENT PROFILE,
  `hasAiCaseworkerNote` (lib/caseworkers.ts:42-82, which a dropped or
  demoted line now silences, Q1).
- listing_sends `reactions`. Writer: `appendReactions` only. Other writers
  of the row (putShareMemory, setDeclined, clearDeclined, the dev seed
  runner's full Put) must leave it alone or, for the seed runner, drop it
  (accepted dev-only exception, header). Readers: the extraction
  PROPERTIES SENT block only.
- listing_sends `shares_op`. A new stamper (`appendReactions`); every
  existing token-conditioned writer must re-read and retry on the fresh
  token as today.
- Unit `priority`. Writers: unit create, unit PATCH. Readers: ListingDetail,
  the edit form. Never: flyer, cards.
- Extraction schema and prompt fingerprint: changes, so every run after
  deploy carries a new prompt fingerprint (expected).

## 5. Tests (behavior to prove; the plan names files)

- D1: the list's keys drive extraction fields, decision targets, tenant-only
  targets and the parsers; the dashboard mirror drift test.
- D2: PATCH/create trim, clear by `''` and `null`, length and range errors,
  provenance clear; the edit form diff sends `null` on clear; the intake card
  renders four rows, BLANK, `$1,200 / month`.
- D3: coercion both paths (text cap, dollars `$1,200` -> 1200, `1200.50`
  dropped, out of range dropped); write vs suggest vs demoted; schema has
  16 targets and zero optional parameters; prompt no longer lists stairs
  or rent portion as noteLine examples.
- D4: floor drops a line below 0.7, keeps one at 0.7; config fail-fast on
  `0`, `1.5`, `abc`; system lines bypass the floor; a demoted run appends
  no line of either kind; retry guard unchanged; run record counts.
- D5: block built from listed non-flyer rows only, 20 newest, existing
  reactions shown; handles do not change the per-message hash; apply drops
  unknown handles, non-client messages, bad kinds, below-floor; dedupe on
  `(sourceMsgId, kind)`; 5 per run; 50 per row; `appendReactions` condition
  (token and listed), retry on a stale token, gives up after 3 without
  throwing; putShareMemory / setDeclined / clearDeclined leave `reactions`
  intact (integration, DynamoDB Local); no status or decline change; a
  partner or unknown contact gets no block and no reaction.
- D6: boolean validation rejects strings; legacy string reads off; form
  checkbox round-trip on New and Edit; record row and header pill; parity
  table 36 rows; flyer never carries priority.
- D7: script unit tests for case scoring (banned-term hit, control
  missing, truncation) and the exit code, with a stub driver (no network).
- e2e (hermetic, fake driver): staff edit and see the four fields; an
  extraction tick writes a field, appends a confidence-passing line and
  skips a below-floor one; a reaction lands on a sent pair (asserted
  through a dev read or the AI run detail); Priority checkbox round-trip
  and record display. Existing e2e payloads with string noteLines are
  migrated to the object shape.

## 6. Rollout

- No infrastructure change: new attributes on existing tables only.
- No new env var is required to deploy: `EXTRACTION_FACT_MIN_CONFIDENCE`
  defaults to 0.7; it is added, uncommented with its default, to the env
  example files and RUNBOOK.
- Merge gate: the never-written test record (D7) plus the five repo gates.
- After deploy, extraction behaves the new way at once (no switch, charter
  amended 2026-10-26).

## 7. Hours

Charter estimate 8-10 of Cameron's hands-on hours. Firmed at plan time.

## 8. Questions for Cameron (spec gate)

- Q1. Demoted runs appending no lines (charter 6.4) has two consequences
  the code shows: (a) demotion is decided per WINDOW, and one
  unattributed call keeps a conversation's window demoted for up to 30
  days, so Notes lines and reactions stop for that conversation for that
  long (the existing issue voice-extraction-window-demotion-persistence);
  (b) the "Possible caseworkers" signal reads `[Auto - ...] Identified as a
  caseworker` lines (lib/caseworkers.ts:42-82), so such a conversation
  stops producing it. Unattributed `Speaker N` lines are rare since the
  voice role map shipped. Planner recommendation: keep the charter rule.
- Q2. The gate run needs the testing key. Either Cameron runs the one
  command himself (about 3 minutes, cost under a dollar), or he puts the
  key in an environment variable the build can use. Planner recommendation:
  Cameron runs it. Also: which model does production extraction run today,
  `claude-sonnet-5` (RUNBOOK) or `claude-sonnet-5-5`? The gate run uses it.
- Q3. Reactions are recorded but shown nowhere until B3, except the AI run
  detail's raw output. OK, or should B1 show them on the tenant's
  Properties sent list?
