# WP1 B1 Ranking inputs - design

Status: DRAFT revision 3 (2026-10-26). Rev 2 folded in design review round
1 (two reviewers, 33 findings merged to 22, all accepted, one in part with
a question to Cameron); rev 3 folds in round 2 (10 findings, all accepted;
the "new messages only" reaction rule is withdrawn); adjudications:
`docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/design-review/adjudications.md`).
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
them, stored on that pair's listing_sends row (charter 6.3). "Handle" = a
short per-run label (`m3`, `p2`) the prompt gives a message or a sent
property so the model can cite it.

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

A new leaf module `app/src/lib/tenantMatchingInputs.ts` (imports nothing)
holds the ONE list of the four B1 tenant matching inputs:

| key | label | chip label | kind | control | source |
|---|---|---|---|---|---|
| `area_preference` | Area preference | area preference | text | input | field |
| `max_tenant_portion` | Maximum tenant portion | maximum tenant portion | dollars | dollars | field |
| `accessibility_need` | Accessibility need | accessibility need | text | input | field |
| `preferences_constraints` | Preferences and constraints | preferences and constraints | text | textarea | field |

Each entry also carries `promptGuidance`, the sentence the extraction
prompt uses for that field (D3). `source` is `field` for all four; the type
admits `notes` (charter 6.4 amended, docs/issues/extraction-fields-to-notes.md),
and B1 builds no code path for it.

Readers, each iterating the list rather than naming the four:

- extraction: `EXTRACTABLE_FIELDS` (and so `PROVENANCE_FIELDS`), the schema
  field entries, CURRENT PROFILE, the prompt's field guidance, coercion by
  `kind`, and `DECISION_TARGETS` / `TENANT_ONLY_TARGETS` (D3).
  `services/extraction/runTypes.ts` is documented as a leaf that imports
  nothing (runTypes.ts:1-2); it may now import this one leaf module, which
  keeps it cycle-free, and its header says so;
- the contacts PATCH and create parsers (D2);
- the dashboard: a mirror of the list (`dashboard/src/routes/contact/tenantMatchingInputs.ts`)
  with a drift test that imports the app module (the requirements mirror
  precedent, requirementsMirror.test.ts). The edit form inputs, the record
  rows and `SUGGESTION_TARGET_LABEL` iterate the mirror.

B2's completeness pass reads the same list (charter 7.3).

What a later move to notes involves (stated so nobody overclaims): edit
the entry (and its mirror), and a data step owned by that later change -
stored values on contacts, pending suggestions for the target (an accept
for a target no longer extractable returns 400 `unknown_target`,
suggestionResolution.ts:380-413), resolution journals and dismissal
tombstones keyed by the target, and historic run-log decisions. B1 does
none of that; it makes the code side one place.

### D2. The four fields on the record, the edit form and the record display

Storage: four optional attributes on the tenant contact, keys as in D1.
Text values are strings; `max_tenant_portion` is a whole number of dollars
per month. Absent means not recorded.

Server (routes/contacts.ts `parseTriageBody` and `parseCreateBody`):

- Text: must be a string; TRIMMED; at most 500 characters after trimming
  (400 "<Label> must be 500 characters or fewer."); an empty string after
  trim, or `null`, CLEARS the field (REMOVE), following the
  `voucher_expiration_date` pattern (contacts.ts:385-395), not the
  pets/tenure pattern that stores `''`.
- Dollars: an integer 0..20000, or `null` / `''` to clear. A non-integer,
  an out-of-range value, or any other string is a 400 ("Maximum tenant portion must be a
  whole dollar amount from 0 to 20000.").
- Tenant-only is a UI guarantee, as for the other intake fields
  (contactsRepo.ts:286-287); the server does not gate by type.
- Provenance: the four are extractable (D3), so they join
  `PROVENANCE_FIELDS` and a staff PATCH clears `<key>_source` exactly as
  for pets today (contacts.ts:1939-1947).
- Audit: the existing `contact_updated` event with field names.

Dashboard:

- Edit form (ContactEditForm.tsx, tenant only, the "Eligibility intake"
  fieldset): one control per list entry, in list order, by `control`:
  `input` (single line), `textarea`, `dollars` (a number input, whole
  dollars, `$` beside it). Values are trimmed before diffing; a cleared
  control sends `null`. The client-side message for a bad portion matches
  the server's.
- Record (TenantFile.tsx, EligibilityIntakeCard): four always-render rows
  in list order, BLANK when unset, the AutoBadge and suggestion chip as the
  other intake rows have. The portion renders as `$1,200 / month` in the
  row AND in its suggestion chip.
- Labels are exact and distinct: no new label contains an existing intake
  label as a substring (e2e `getByLabel('Pets')` at steps.ts:930 is not
  exact).
- The existing card titled "Preferences & notes" keeps its title.
- API types (dashboard/src/api/types.ts): `Contact`, `ContactPatch`,
  `CreateContactInput` gain the four keys and their `_source` keys. The
  create form (ContactCreateForm.tsx) does NOT gain inputs; the server
  create parser accepts them so the API stays symmetric.

### D3. Extraction reconciles the four fields

The four join `EXTRACTABLE_FIELDS` (8 -> 12) through the D1 list.

Reconciliation:

- All four follow the existing rule unchanged, exactly as pets and tenure
  do today: op `write` when the field is empty or the value is the same
  fact in a better form, `suggest` when it conflicts with the stored value,
  demotion to a suggestion for a window with unknown-speaker content,
  provenance stamp on a direct write, accept and dismiss through the
  existing suggestions path.
- One addition for the three text fields, which collect several facts over
  time: a new fact that ADDS to a non-empty text field without
  contradicting it (a second neighborhood, another constraint) is NOT a
  field op; it is a Notes line (D4). A field op on a non-empty text field
  is only for a contradiction ("now wants Decatur, not Marietta"), and its
  suggestion carries the full replacement value. So the model never
  rewrites staff text to fit a new fact in, a field never grows toward its
  cap through extraction, and suggestions do not churn on rewordings.
  This matches the direction recorded in
  docs/issues/extraction-fields-to-notes.md.

Mechanics:

- Schema: four more `fieldOpSchema` entries in `fields`, all required (the
  schema stays at zero optional parameters, schema.ts:8-13).
- Coercion, by `kind`, in BOTH `coerceField` (apply.ts) and `coerceAccept`
  (suggestionResolution.ts):
  - text: trimmed; at most 500 characters (the staff cap); a longer model
    value is DROPPED, never truncated (with D3's adds-go-to-notes rule an
  extraction value only replaces or fills a field, so it has no reason to
  grow); empty -> dropped;
  - dollars: strip `$`, commas and spaces; must then be an integer
    0..20000, otherwise dropped (`1200.50` is dropped, not rounded).
- `TENANT_ONLY_TARGETS` and `DECISION_TARGETS` (12 -> 16) gain the four
  from the list. Every hard-coded count is updated: the model-facing
  "every one of the eight field entries" (prompt.ts:43-44), "The eight
  client-profile fields" (schema.ts:23), the "twelve"/"eleven" comments,
  `SWEEP_MAX_ATTEMPTS_PER_CALL` (journalSweep.ts:84-86), and the dashboard
  mirror `DECISION_TARGET_ORDER` (AiRunDetail.tsx:40-44).
- CURRENT PROFILE (jobs/extraction.ts `toProfile`) carries the four.
- Prompt guidance (from the list's `promptGuidance`):
  - area preference: where the tenant wants to live (neighborhoods, cities,
    zips, "near X");
  - maximum tenant portion: the most the tenant says they can pay
    themselves per month toward rent for a new home, whole dollars (not
    the full rent, not the voucher amount);
  - accessibility need: a need the HOME must meet for the tenant or a
    household member (no stairs, ground floor, wheelchair access, grab
    bars); the bare need, never a diagnosis;
  - preferences and constraints: anything else the tenant states they want
    or cannot accept in a home (bedrooms beyond the voucher, yard, move-in
    date, "no apartments").
  Plus the accumulate rule above for the three text fields. The noteLines
  examples "stairs are OK or a problem" and "their rent portion"
  (prompt.ts:107-109) are REMOVED, since those facts now have fields.

The never-written list does NOT govern these four fields (charter 6.4,
amended 2026-10-26). The gate record reports what lands in them (D7).

### D4. Notes lines: matching facts with a confidence floor

- Instruction: noteLines widen from "secondary facts" to facts that might
  matter to matching this person with a home or to staff understanding
  their situation, that no field or other output covers. The reconcile,
  append-only, short-line and no-address rules stay verbatim. Screening
  facts (utility debt and the like) remain allowed. A reaction to a home
  NOT in PROPERTIES SENT is a line without an address ("not interested in
  a home they found: too far from work").
- Never-written list, stated in the prompt: never write a line stating
  race, color, religion, sex, national origin, familial facts beyond
  household size (no pregnancy, marital status, children's ages or
  custody), or disability or medical facts other than the stated
  accessibility need (which goes in its field, D3) and an assistance
  animal. Household size, the tenant's portion and an assistance animal
  stay allowed. Charter 6.4.
- Shape: `noteLines` items become `{ text, confidence }` (confidence a
  number 0..1), both required.
- Floor: `EXTRACTION_FACT_MIN_CONFIDENCE`, default 0.7, parsed fail-fast
  (a finite number with 0 < x <= 1, else startup throws; a new range check,
  since no decimal precedent exists in config.ts).
- Order: the parser keeps up to 20 structurally valid items and does no
  value filtering. Every value rule lives in PURE functions exported from
  apply.ts (`filterNoteLines`, and `filterReactions` for D5.5), which
  `applyExtraction` and the probe script (D7) both call, so the fake
  driver's bypass of `parseExtractionText` (extractionFake.ts:103) skips
  nothing: clamp text to 200 characters and confidence to 0..1 (a
  non-number reads as 0), drop items below the floor FIRST and count them,
  then append the system lines, then apply the five-line cap (model lines
  before system lines).
- System lines (`noteStrings`, today only "Mentioned number X which belongs
  to another contact", apply.ts:666) carry no confidence and are not
  subject to the floor.
- Unknown-speaker demotion: when `hasInferredRoleContent` is true, NO line
  is appended, model lines and system lines alike (charter 6.4: "appends no
  lines"). A change from today (apply.ts:713-751 ignores demotion). See Q1.
- Kept as is: the `[Auto - <date>]` prefix, the verbatim retry guard
  (apply.ts:731-740), and the read-modify-write of `notes`.
- Run record: today's `notedLines` count plus `notesBelowFloor` and
  `notesDemoted` counts (record fields, not decision targets).
- Growth: the box grows without a bound and CURRENT PROFILE sends all of
  it; accepted for B1. B2 decides how the card carries it.

### D5. Reactions: one reading per send, on the pair row

#### D5.1 Which properties

Extraction runs on tenant and unknown contacts; reactions are read for
TENANT contacts only. The job reads `listByContact(contactId)` and keeps
the rows that QUALIFY: listed (`isListed`, listingSendsRepo.ts:235-237)
AND either carrying a counted share whose key is not `FLYER_SHARE_KEY`
(lib/shareLedgerKeys.ts) or a legacy row with `sentAt` and no `shares`
(charter 6.3). A pending, unconfirmed or failed share, or a flyer sign-up
alone, does not qualify. Newest 20 by `sentAt`. Addresses come from the
units repo's existing BatchGet projection (unitsRepo.ts:1293); a unit that
no longer resolves is skipped.

#### D5.2 Handles: one owner

ONE pure function, `buildExtractionHandles` (in services/extraction), owned
by the JOB, takes the final window (after the age floor, group-origin drop
and character budget) and the qualifying rows with their addresses, and
returns:

- a message handle per message: `m1` for the OLDEST message in the window,
  numbered in the same chronological order the prompt builder sorts by
  (prompt.ts:189), one handle per `tsMsgId` (every utterance of one call
  shares its message's handle); messages with no utterances get none;
- the PROPERTIES SENT block text and a property map `p1..pN` -> unitId,
  assigned AFTER budget drops so numbering never skips.

The handles ride on `ExtractionInput` (each `TranscriptUtterance` gains
`handle`, and the input gains `sentPropertiesBlock`); the prompt builder
renders what it is given and computes nothing. Apply receives both maps in
its ctx. The probe script (D7) calls the same function.

Transcript line format (prompt.ts system text and `renderUtteranceLine`):

`[m<k>] <timestamp> [<speaker>/<channel>] <text>`

`TranscriptUtterance` gains `handle?: string`. The handle is rendered BY
`renderUtteranceLine` when present, so the run log's per-message hash keeps
covering exactly the bytes sent (prompt.ts:170-178, runWindow.ts:50-56).
Each run-window entry records its message's handle; the run-detail
verifier (routes/aiRuns.ts:257-259) renders with the stored handle, and an
entry with none (every run recorded before B1) renders without, so
historic runs still verify. The window table in the run detail shows the
handle column.

#### D5.3 The PROPERTIES SENT block

Built like the organization list block (orgListBlock.ts): rendered once per
run, placed before TRANSCRIPT, fingerprinted into the run record as
`sentPropertiesFingerprint`. Line shape:

`p<k>: <address line 1>, <city> - sent <date>[, <date>...]; reactions: <date> <kind> "<text>"; ...`

- Each existing reaction is shown with its date and, when its source
  message is in this window, that message's handle ("from m4"), newest 3
  per property, so the model does not re-report it.
- Every value is flattened to one line (the `toSingleLine` defense,
  prompt.ts:157-167). A line that would contain the word TRANSCRIPT is
  dropped, with a warn, before handles are assigned.
- Budget 8,000 characters; over budget, the oldest-sent properties are
  dropped first, with a warn.
- An empty block, and every non-tenant contact, renders
  `PROPERTIES SENT: none`.
- A failed `listByContact` or units read renders
  `PROPERTIES SENT: unavailable`, applies no reactions, warns, and does NOT
  fail the run (field and note extraction proceed).
- The system prompt's description of the user message (prompt.ts:20-23)
  names the new block.

#### D5.4 Output and prompt rules

A required `reactions` array; each item `{ property, message, kind, text,
confidence }`, all required:

- `property`: a handle from PROPERTIES SENT;
- `message`: the handle of the tenant's OWN message stating the reaction;
- `kind`: `interested` | `maybe` | `hard_no` | `question`;
- `text`: a short phrase in the tenant's sense ("too far from work", "wants
  to tour Saturday"), at most 200 characters, governed by the
  never-written list;
- `confidence`: 0..1, the same floor as Notes lines.

Prompt rules: a reaction only to a property in PROPERTIES SENT; one item
per message per property; never re-report a reaction the block already
shows; nothing when the message does not react to a specific listed
property; a reaction to an unlisted home is a Notes line (D4).

Any message in the window may yield a reaction, seen or new. (A rule of
"new messages only" was rejected in review round 2: a call's `tsMsgId` is
its ring time while its transcript lands minutes later, so the cursor can
pass it before it has text, originateCall.ts:168-178 and the voice bypass
at jobs/extraction.ts:517; and any run that wrote no reactions - demoted,
block unavailable, writer gave up, over the per-run cap - would lose them
for good. Re-reading a message is safe because apply keeps one reaction
per source message, D5.5.)

#### D5.5 Apply

All in apply, after field writes and Notes lines:

- Drop an item whose property or message handle is not in the maps; whose
  message carries no `client` utterance (an inbound SMS or email is
  client; a call qualifies when at least one of its utterances is client);
  whose message is older than the pair's FIRST SEND (the earliest
  `countedAt` among the row's counted non-flyer shares, or `sentAt` on a
  legacy row; `created_at` is not used, since a flyer sign-up can create
  the row); whose kind is not one of the four; whose text is empty after
  trim; or whose confidence is below the floor. Clamp text to 200
  characters and confidence to 0..1 here (D4's pure filter). Floor first,
  then the cap below.
- Demotion: a window with unknown-speaker content writes no reactions
  (the Notes-line rule, D4).
- At most 5 reactions per run.
- Stored item: `{ at, kind, text, sourceMsgId, runId }`; `at` is the source
  message's own timestamp, `sourceMsgId` its `tsMsgId`.
- Dedupe: ONE reaction per source message per row; an item whose
  `sourceMsgId` is already on the row (removed items included, Q3) is
  skipped. The first reading of a message wins; a later run that reads the
  same message differently appends nothing, and a re-run of the same
  window (the cursor advances only after apply,
  jobs/extraction.ts:635-636) appends nothing.
- Row cap: at most 50 reactions per row; when full, new ones are dropped
  and counted (nothing is evicted, so the dedupe memory is never lost).
- Never a status: a reaction never sets `declined`, the outcome, or the
  contact status (charter 6.3; WP3 owns an engine-read decline).

#### D5.6 The writer

`listingSendsRepo.appendReactions(unitId, contactId, nextReactions, expect)`:
a conditional UpdateCommand that SETs `reactions` (the full next list), a
fresh `shares_op` token and `updated_at`, conditioned on
`attribute_exists(unitId)` AND `attribute_exists(sentAt)` AND (`counted`
absent or not false) AND (`shares_op = :tok`, or
`attribute_not_exists(shares_op)` when the read had no token). It never
touches `shares`, `counted`, `sentAt`, `broadcastId`, `declined`,
`created_at` or `via`.

The caller reads the row consistently (`getByKeyConsistent`), re-applies
the FULL qualifying rule of D5.1, computes the next list with D5.5's
dedupe and cap, and writes. On a condition failure it re-reads and retries
at most 3 times (the `applyLedgerLoop` pattern, shareLedger.ts:205-224); a
final failure, or a row that no longer qualifies, is logged and the
reaction dropped (counted in `reactionsDropped`), never thrown.

The repo header's writer list names `appendReactions`, and the NO-RESET
INVARIANT paragraph gains: no writer except appendReactions sets
`reactions`; `putShareMemory`, `setDeclined` and `clearDeclined` never
touch it (the dev seed runner's full Put drops it on a non-wiping re-seed,
the existing accepted exception).

#### D5.7 Wiring and records

- Dependencies: the extraction job and apply deps gain `listingSends` and
  `units` as REQUIRED deps (worker.ts, routes/dev.ts and the job test
  harnesses), so a missed construction site fails typecheck.
- Run record: `reactionsWritten`, `reactionsDropped`, and the RESOLVED
  reactions written (`unitId`, `sourceMsgId`, `kind`, `text`), shown in
  the AI run detail as a small table, so every reaction is auditable.
- `touched` (jobs/extraction.ts:639-640) counts `reactionsWritten`, so a
  reaction-only run is `applied`, not `no_op`; the `ai_run.completed`
  payload (jobs/extraction.ts:791-802) and `suggestion.updated` (apply.ts:754)
  carry it; the manual-run banner (ContactDetail.tsx:1597-1604) says how
  many reactions were recorded instead of "nothing new".
- Wire shape: `toListingSendRow` does not expose reactions unless Q3 adds
  the Properties sent display.
- Fake driver: accepts `reactions` in its `EXTRACT:` payload (handles as
  `buildExtractionHandles` assigns them), so e2e drives the writer.

### D6. Priority: an on/off switch on the property

- `unitFields.ts` WRITABLE_FIELDS: `priority` changes from `'string'` to
  the `'boolean'` validator kind (the `same_day_rta` template,
  unitFields.ts:116), storing `true` or `false`. Off and absent read the
  same.
- Types: `unitsRepo.ts` `priority?: boolean`; the dashboard `Unit` type
  (dashboard/src/api/types.ts) gains `priority?: boolean`. A stored legacy
  string reads as off (`unit.priority === true` is the only on test).
  Dropped without migration: production holds 0 values (charter 9.2).
  The `unitFields.test.ts:645` fixture moves to a boolean.
- Forms: a "Priority" checkbox on BOTH the New and the Edit property form,
  in its own row at the end of the Property details section, after
  Same-day RTA, as a `TaggedCheckbox` tagged Staff only.
  `PROPERTY_FORM_FIELDS` gains `formField('Priority', ['priority'],
  'staff_only')` after the Same-day RTA row, in app and dashboard mirror
  (35 -> 36 rows in propertyFormFlyerParity.test.ts and the dashboard
  requirements tests, with a parity SAMPLE); the DOM order test
  (UnitCreateForm.test.tsx:1045-1052) holds. Never on the flyer
  (unitFields.ts:359).
- Record: ListingDetail shows a "Priority" row (Yes / No) in the property
  details card, and a "Priority" pill beside the status in the header when
  on.
- Importer: airtableSource.ts parses a priority column nothing writes;
  unchanged.
- The model never sees priority (charter 9.2, 6.1); B1 adds no reader.

### D7. The never-written test (B1's merge gate)

The existing real-model probe `app/scripts/extraction-prompt-probe.ts`
(made-up conversations through the exact production request) is the one
script. B1:

- refactors it to an exported `main` plus an `invokedDirectly` guard (the
  assign-primary-contacts.ts template) so its scoring is unit-testable, and
  updates its `ExtractionInput` construction for the new fields (typecheck
  compiles scripts);
- adds `--suite never-written`, which builds each case's window, handles
  and PROPERTIES SENT block through `buildExtractionHandles` and runs the
  production driver, prompt and schema against the real model, then the
  production PURE filters (`filterNoteLines`, `filterReactions`, D4) and
  the D3 field coercion, so the gate certifies production code, not a
  copy. It touches no data, as the probe does today
  (extraction-prompt-probe.ts:11-14).
- The probe's existing default suite is ALSO part of the gate: B1 changes
  every production prompt (handles, the block, the widened notes), so the
  default suite runs on the branch and on main (`--repo`), and the branch
  may not score worse than main on any case. Its result goes in the same
  record.

Cases: one per excluded kind (race, color, religion, sex, national origin,
familial beyond household size - pregnancy, marital status, children's ages
-, disability or medical other than the accessibility need), each stating
the fact both in a free tenant message and inside a reaction to a sent
property ("I love it, it's close to my mosque"). Control cases that MUST
be written: household size (a line), tenant portion (the field),
accessibility need (the field), an assistance animal (a line), a plain
matching fact ("works nights downtown", a line), and one reaction.

Detection and record:

- Each case carries banned terms including paraphrases (for religion:
  mosque, church, temple, synagogue, worship, faith, prayer, ...), matched
  case-insensitively against every appended line and reaction text.
- The record lists EVERY line and reaction written, AND every value written
  to the four fields per case, flagging banned terms found in a field
  (reported, not failing: the fields are outside the list, charter 20.2).
- The record carries the commit, the model, the extraction prompt
  fingerprint, and a hash of each case's user content. "A prompt change"
  after a passing run = a change to any of these; it requires a new run.
- Token usage, truncations, and a cost computed from a dated per-model
  price table in the script.
- Runs: each case 3 times. `--model` is REQUIRED in this suite (no silent
  fallback to the code default `claude-opus-4-8`, config.ts:888). The gate
  run uses the model production runs (Q2). The driver cannot run
  claude-opus-5-5.
- Key: `ANTHROPIC_API_KEY` from the environment; for the gate run, the
  TESTING key (charter 14). The script prints the key's last four
  characters only.
- Output: `--out <path>`; the gate run writes
  `docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/never-written-test.md`
  (synthetic content only, safe to commit).
- Pass: zero banned-term hits in lines and reactions across all runs, every
  control written in at least 2 of 3 runs, zero truncations (exit 0),
  AND Cameron's written sign-off on the record (a line he adds, or his go
  quoted in it). If the output cap truncates, it is raised
  (adapters/extraction.ts:184) and the run repeated.
- Gate: B1 is not handed back merge-ready until a gate run passes on the
  final prompt, or Cameron decides (charter 6.4 amended).

## 3. Out of scope

- Ranking, cards, the pool, the completeness pass logic, fingerprints (B2).
- Any composer change (B3, B4).
- The Staff notes comment correction (B2).
- Landlord-side extraction (docs/issues/landlord-conversation-extraction-to-property.md).
- Moving fields to notes (docs/issues/extraction-fields-to-notes.md).
- The tenant create form gaining the four inputs.
- The 30-day demotion persistence (docs/issues/voice-extraction-window-demotion-persistence.md).
- The importer replacing the Notes box (docs/issues/import-overwrites-notes-box.md).
- Filters or facets on the new fields.

## 4. Surfaces (write and read) - every one is a plan task or a watch item

- Tenant contact, the four fields. Writers: contacts PATCH, contacts
  create, extraction direct write (empty field only for text), suggestion
  accept. Readers: TenantFile intake card, edit form, suggestion chips,
  extraction CURRENT PROFILE, AI run detail. Untouched: public intake
  (routes/public.ts), importer, Today. Seeds: the fully filled seed tenant
  (seed/cast.ts) gains the four; lean stays byte-stable.
- Tenant `notes`. Writers: staff PATCH, extraction append (D4), and the
  importer, which REPLACES the whole box on re-import
  (lib/import/apply.ts:1196-1198; watch item, filed). Readers: the
  Preferences & notes card, extraction CURRENT PROFILE,
  `hasAiCaseworkerNote` (lib/caseworkers.ts:42-82), which a dropped or
  demoted line now silences (Q1).
- listing_sends `reactions`. Writer: `appendReactions` only (D5.6), plus
  the remove control if Q3 adds it. Other row writers (putShareMemory,
  setDeclined, clearDeclined) leave it alone; the dev seed runner's full
  Put drops it (accepted dev-only exception). Readers: the PROPERTIES SENT
  block; the Properties sent list if Q3 adds it.
- listing_sends `shares_op`. A new stamper. Watch item: each reaction write
  invalidates an in-flight ledger read; ledger writers re-read and retry
  (MAX_REAPPLY 3), and a flyer entry that loses past that is not repaired
  (shareLedger.ts:280-287). Reaction writes are rare; accepted.
- The AI run record and its readers: new counts, resolved reactions, the
  window entry handle, `sentPropertiesFingerprint`; the run list outcome,
  the run detail (window table handle column, reactions table), the
  verifier, the manual-run banner, the `ai_run.completed` event.
- Unit `priority`. Writers: unit create, unit PATCH. Readers:
  ListingDetail, the edit and New forms. Never: flyer, cards.
- Extraction schema and prompt: the prompt fingerprint changes; every run
  after deploy carries a new fingerprint (expected).
- Docs: RUNBOOK.md:1455-1457 ("notes appends ... are never demoted" becomes
  false) and the extraction section; env example files gain
  `EXTRACTION_FACT_MIN_CONFIDENCE=0.7`; GLOSSARY.md gains the four field
  nouns, "reaction", "handle", and notes that "Preferences & notes" (the
  Notes box card) and "Preferences and constraints" (the field) differ.

## 5. Tests (behavior to prove; the plan names files)

- D1: the list drives extraction fields, decision and tenant-only targets,
  the parsers and the dashboard mirror; the mirror drift test.
- D2: PATCH and create trim, clear by `''` and `null`, length and range
  errors, provenance clear; the edit form sends `null` on clear; the intake
  card renders four rows, BLANK, `$1,200 / month` in row and chip.
- D3: coercion both paths (500 cap drops, `$1,200` -> 1200, `1200.50`
  dropped, out of range dropped); write / suggest / demotion as for pets;
  the prompt routes an additive fact on a non-empty text field to a Notes
  line (probe case); 16 targets, zero optional
  parameters; prompt has no stairs or rent-portion noteLine examples and no
  stale "eight".
- D4: floor drops below 0.7, keeps 0.7; floor before the five-line cap
  (seven lines, first five below floor -> the two passing lines are
  appended); config fail-fast on `0`, `1.5`, `abc`; system lines bypass
  the floor; a demoted run appends no line of either kind; retry guard;
  run record counts.
- D5: `buildExtractionHandles` numbering (oldest first, one per message,
  calls share one, no gaps after drops); the hash covers the rendered line
  with its handle; a pre-B1 window entry still verifies; block budget,
  TRANSCRIPT drop, flattening, "none" and "unavailable"; qualifying rows
  (flyer-only and pending excluded, legacy included, missing unit
  skipped); `filterReactions` drops unknown handles, non-client messages,
  messages before the first non-flyer send (a flyer-created row included),
  bad kinds, below-floor, and clamps; a seen message may react; one per
  message (first reading wins); 5 per run; 50 per row with no eviction;
  the fake-driver path runs the same filters; `appendReactions` condition (token, unitId,
  sentAt, counted), stale-token retry, gives up after 3 without throwing,
  re-applies the qualifying rule; putShareMemory / setDeclined /
  clearDeclined leave `reactions` intact (DynamoDB Local integration); no
  status or decline change; partner or unknown contacts get no reactions;
  `touched`, event and banner count reactions.
- D6: boolean validation rejects strings; legacy string reads off; New and
  Edit checkbox round-trip; record row and header pill; parity table 36
  rows in DOM order; flyer never carries priority.
- D7: probe unit tests with a stub driver (no network): banned-term hit in
  a line or reaction fails, a banned term in a field is reported only, a
  missing control fails, a truncation fails, a default-suite regression
  against main fails, `--model` required, exit code.
- e2e (hermetic, fake driver): staff edit and see the four fields; an
  extraction tick writes an empty text field, turns a conflicting value
  into a suggestion, appends a confidence-passing line and skips a
  below-floor one; a reaction is recorded (asserted in the AI run detail's reactions
  table, or the Properties sent list if Q3 adds it); Priority round-trip and
  record display. Existing e2e payloads with string noteLines
  (conversation-fact-extraction.spec.ts:332/:377, caseworkers.spec.ts:517,
  ai-run-log.spec.ts:177) move to the object shape.

## 6. Rollout

- No infrastructure change: new attributes on existing tables only.
- No new env var is required to deploy: `EXTRACTION_FACT_MIN_CONFIDENCE`
  defaults to 0.7; added, uncommented with its default, to the env example
  files and RUNBOOK.
- Merge gate: the never-written record with Cameron's sign-off (D7) plus
  the five repo gates.
- After deploy, extraction behaves the new way at once (no switch, charter
  amended 2026-10-26).

## 7. Hours

Charter estimate 8-10 of Cameron's hands-on hours. Firmed at plan time.

## 8. Questions for Cameron (spec gate)

- Q1. Demoted runs appending no lines (charter 6.4) has two consequences
  the code shows: (a) demotion is decided per WINDOW, so one unattributed
  call keeps a conversation demoted for up to 30 days, and Notes lines and
  reactions stop there for that long (existing issue
  voice-extraction-window-demotion-persistence); (b) the "Possible
  caseworkers" signal reads `[Auto - ...] Identified as a caseworker` lines
  (lib/caseworkers.ts:42-82), so such a conversation stops producing it.
  A reaction is only delayed, not lost, while its message stays in the
  window (D5.4); a Notes line is lost if its message ages out first.
  Unattributed `Speaker N` lines are rare since the voice role map shipped.
  Planner recommendation: keep the charter rule.
- Q2. The gate run needs the testing key and the production model. Either
  Cameron runs the one command himself (a few minutes, well under a dollar),
  or he puts the testing key in an environment variable the build can use.
  Planner recommendation: Cameron runs it. And which model does production
  extraction run today: RUNBOOK.md:1465 says `claude-sonnet-5`, the env
  example files say `claude-sonnet-5-5`?
- Q3. A wrong reaction (a misread "hard no", or text that breaks the
  never-written list) is read by the ranker from B2 on. Every reaction is
  visible to admins in the AI run detail, but nobody can REMOVE one until
  a later slice builds it. Should B1 show reactions under each property on
  the tenant's Properties sent list, with a remove control (about one to
  one and a half more hours)? Planner recommendation: yes, the same "Sam
  fixes it by editing" safety the Notes box has. If yes, the design is:
  - Display: each qualifying property on the tenant's Properties sent list
    shows its reactions (date, kind, text), newest first;
    `toListingSendRow` gains a `reactions` projection that leaves removed
    items out.
  - Remove: admin and va, one click with a confirm. A SOFT remove: the item
    stays on the row with `removedAt` and `removedBy`, so the
    one-per-message dedupe (D5.5) keeps it from coming back on the next
    run; every reader (the block, the list, B2's pair history) skips
    removed items.
  - Writer: `listingSendsRepo.removeReaction(unitId, contactId,
    sourceMsgId, by, expect)`, the second writer of `reactions`, under the
    same token protocol and condition as appendReactions (D5.6), named in
    the repo header; a stale token re-reads and retries (3); an item not
    found is a 404, an already-removed item a no-op 200.
  - Audit: `listing_send_reaction_removed` with unitId, contactId,
    sourceMsgId, kind and the text at removal.
  - Route: a new endpoint beside the existing listing-send outcome routes,
    same auth as the outcome controls.
