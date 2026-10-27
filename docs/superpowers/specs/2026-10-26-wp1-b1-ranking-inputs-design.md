# WP1 B1 Ranking inputs - design

Status: APPROVED revision 9 (2026-10-27). Rev 9 carries two decisions
Cameron made at the launch gate (charter section 20, items 9-10): the
prompt's no-address bullet is removed (D4, D5.2), and the never-written
test is judged by a model grader against a plain description of each
excluded fact instead of banned-word lists (D7). Cameron passed the spec gate
on rev 8 without a further review round. Revs 2-4 folded
in design review rounds 1-3 (40 findings, all accepted); rev 6 folded in
round 4, the last allowed (8 findings, all precision edits; the review is
closed). Rev 5 followed Cameron's first spec-gate redesign (charter
section 20, items 4-6): stored per-pair reactions, their writer, handles
and the staff remove control are WITHDRAWN. Rev 7 follows his second
(charter section 20, item 7): the fixed-shape reaction line is withdrawn
too. What a tenant says about a property sent to them is a FEEDBACK LINE,
an ordinary free-form Notes line that names the property; B1 adds no
shape check. At Cameron's request rev 7 got a fifth design-review round
past the usual cap; rev 8 folds it in (9 findings, all accepted). Q1 and
Q2 are answered (section 8). Adjudications:
`docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/design-review/adjudications.md`.
Charter: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md.
This slice implements charter sections 6.4 (extraction as the reading
layer, including feedback lines; AMENDED 2026-10-26), 4 and 6.3 as amended
(a reaction is a Notes line; no stored reactions), 7.3 (the tenant
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
appends. "Feedback line" = a Notes line, in free form, recording what a
tenant said about a property sent to them and naming that property by its
label (D5, charter 6.4 amended). "Label" = `<address line 1>[ <address
line 2>], <city>`, built by one shared function. "Properties sent" = the
properties on the tenant's listing_sends rows (sent, or signed up for
through a flyer). "Card" (charter 3) = all of one record's information as
given to the ranker in B2; not a screen element.

## 1. Goal

Start collecting the facts the ranker (B2) will read, before anything ranks:

- Four tenant fields staff can see and edit and extraction can fill: area
  preference, maximum tenant portion, accessibility need, preferences and
  constraints.
- A Priority on/off switch on each property.
- Extraction that writes anything that might matter to matching a tenant
  with a home as Notes lines (with a confidence floor and a never-written
  list), including a feedback line naming the property whenever the
  tenant says something about a property sent to them.
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
  suggestion carries the full replacement value. ENFORCED in apply, since
  apply today honors any model `write` without an emptiness check
  (apply.ts:299-316): a `write` on a NON-EMPTY text field is DROPPED (a
  `dropped` decision with reason `text_field_filled`; not a suggestion,
  and not counted in the Layer-3 `demotedFields` audit, apply.ts:321-327),
  so for the three text fields "write" means "fill an empty field" and
  nothing else, and only a `suggest` op (a contradiction) creates a
  suggestion. (`max_tenant_portion` keeps the pets rule,
  including a same-fact write.) So the model never rewrites staff text
  live, a field never grows toward its cap through extraction, and
  suggestions do not churn on rewordings.
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
  their situation, that no field or other output covers, PLUS a fact that
  adds to one of the three text fields when that field is already filled
  (D3). The reconcile,
  append-only and short-line rules stay verbatim; the no-address bullet
  is removed (D5.2, rev 9). Screening
  facts (utility debt and the like) remain allowed. Feedback lines (D5)
  are Notes lines.
- Never-written list, stated in the prompt: never write a line stating
  race, color, religion, sex, national origin, familial facts beyond
  household size (no pregnancy, marital status, children's ages or
  custody), or disability or medical facts other than the stated
  accessibility need (in its field, D3, or as a Notes line when it adds to
  a filled field) and an assistance animal. The need is the home's
  feature ("needs a ground floor"), never a diagnosis. Household size, the tenant's portion and an assistance animal
  stay allowed. Charter 6.4.
- Shape: `noteLines` items become `{ text, confidence }` (confidence a
  number 0..1), both required.
- Floor: `EXTRACTION_FACT_MIN_CONFIDENCE`, default 0.7, parsed fail-fast
  (a finite number with 0 < x <= 1, else startup throws; a new range check,
  since no decimal precedent exists in config.ts).
- Order: the parser keeps up to 20 structurally valid items and does no
  value filtering. Every value rule lives in PURE functions exported from
  apply.ts (`filterNoteLines`), which
  `applyExtraction` and the probe script (D7) both call, so the fake
  driver's bypass of `parseExtractionText` (extractionFake.ts:103) skips
  nothing: clamp text to 200 characters and confidence to 0..1 (a
  non-number reads as 0), drop items below the floor FIRST and count them,
  then drop lines the retry guard finds already present (today's guard,
  apply.ts:738-740, moved BEFORE the cap; today it runs after the cap at
  apply.ts:723), then append the system lines, then apply the five-line
  cap (model lines before system lines). The floor reaches apply as an
  `ApplyDeps` value from config (apply.ts:34-44); the probe passes the
  same config value. `coerceField` (apply.ts:100) is exported as a pure
  function for the probe.
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

### D5. Feedback lines: what a tenant said about a property, in the Notes box

Charter 4, 6.2, 6.3 and 6.4 as amended 2026-10-26 (section 20, items 4-7).
There are no stored reactions: no new attribute on listing_sends, no new
writer, no change to its `shares_op` protocol. The outcome stays what
staff already set (Not interested, a tour for Interested) and B2 reads it.
B1 makes sure what the tenant THOUGHT about each home, a "maybe"
included, reaches the Notes box in the model's own words, naming the
home, so B2 can put it under that home on the tenant card.

#### D5.1 The label and the properties-sent list given to extraction

The label: a new pure function `propertyLabel(unit)` in a leaf module
(`app/src/lib/propertyLabel.ts`) returns `<address line 1>[ <address line
2>], <city>`, one line (the `toSingleLine` defense, prompt.ts:157-167),
or `undefined` when line 1 or the city is empty after trimming (such a
property is left out of the block, so no degenerate label like
", Decatur" can match half the Notes box). Line 2 is included when
present, because units in one building share line 1 and differ only in
line 2 (lib/address.ts:24). B1 uses it for the block; B2's card uses the
SAME function to find the Notes lines that name each seen property
(charter 6.4 amended), so the two can never disagree on a property's
name.

It also exports `labelMatches(line, label)`. Both sides are folded the
same way: lowercase, the characters `.` `,` `#` removed, runs of
whitespace collapsed to one space, trimmed. The folded label must then
occur in the folded line at a BOUNDARY: at the start of the line or
after a character that is not a letter or digit, and ending at the end
of the line or before a character that is not a letter or digit. So
"12 Main St, Decatur" does not match inside "112 Main St, Decatur",
"123 Main St." matches "123 Main St", and "123 Main St, Apt 2, Decatur"
matches the label "123 Main St Apt 2, Decatur". Abbreviations are NOT
folded ("St" and "Street", "#2" and "Apt 2" differ): the model is told to
copy the label, and the D5.3 count makes a miss visible. B1 uses
`labelMatches` only to count (D5.3); B2 uses it to attach.

For every contact extraction runs on (tenant and unknown: a flyer lead is
often still `unknown`, listingSendsRepo.ts:141-142), the job reads
`listByContact(contactId)` and keeps the LISTED rows (`isListed`,
listingSendsRepo.ts:235-237): any row with a counted share, flyer
sign-ups included (the tenant may react to a flyer property too), and
legacy rows with `sentAt`. Newest 20 by `sentAt`. Addresses come from the
units repo's BatchGet projection `getDisplaysByIds` (unitsRepo.ts:663,
:1293), which is BEST-EFFORT today: a failed chunk or a key left
unprocessed is dropped with a warn and never throws
(unitsRepo.ts:1303-1310), indistinguishable from a deleted unit. B1 adds
an `opts?: { requireComplete?: boolean }` to it, the contacts repo's
precedent (contactsRepo.ts:776-810): with `requireComplete` a failed
chunk or an unread key throws `IncompleteBatchReadError`. Extraction
passes it. A key the read COMPLETED without finding (a unit that no
longer exists) is skipped; existing callers are unchanged.

It renders a PROPERTIES SENT block, built like the organization list block
(orgListBlock.ts): once per run, before TRANSCRIPT, fingerprinted into the
run record as `sentPropertiesFingerprint`. One line per property:
`- <label> - sent <date>` (or `- <label> - signed up <date>` when the
row's latest counted share is the flyer entry). Two rows whose labels are
identical are rendered once.

- A line that would contain the word TRANSCRIPT is dropped with a warn.
- Budget 4,000 characters; over budget, the oldest-sent properties are
  dropped first, with a warn.
- No rows: `PROPERTIES SENT: none`.
- A failed `listByContact` (it pages to exhaustion and throws,
  listingSendsRepo.ts:486-492) or an incomplete units read FAILS THE RUN,
  exactly as a failed organization-list read does
  (jobs/extraction.ts:563-568): the row is retried under the existing
  attempt count. Why: without the list the model writes feedback without
  the label, and the prompt's reconcile rule (prompt.ts:112-115) then
  treats that unattachable line as already recorded, so the properly
  named line never follows. The cost, accepted: a read that keeps failing
  stops extraction for the whole conversation (fields and Notes lines
  too) after `MAX_EXTRACTION_ATTEMPTS` (jobs/extraction.ts:54, :759), as a
  persistent org-list failure does today.
- A property dropped by the 20-row or character limit cannot be named
  from the block; feedback on it is still written, and may name it as the
  tenant did. Accepted: the limits keep the newest sends, which are the
  ones a tenant talks about.
- The system prompt's description of the user message (prompt.ts:20-23)
  names the block. Nothing else in the prompt or the transcript changes
  shape: no message handles, no change to `renderUtteranceLine` or the
  run log's per-message hash.
- Dependencies: the job gains `listingSends` and `units` as REQUIRED deps
  (worker.ts, routes/dev.ts, the job test harnesses), so a missed
  construction site fails typecheck.

#### D5.2 What the prompt asks for

In the noteLines guidance:

- When the tenant says anything about a property in PROPERTIES SENT (likes
  it, does not, is unsure, asks about it, toured it), write a noteLine
  that NAMES that property by copying its label from the block, then says
  what the tenant thought in a short phrase in the tenant's sense, with
  the reason when one is given. Example: `123 Main St, Decatur: on the
  fence - likes the yard, worried about the commute, wants to see other
  homes first`. The wording is the model's; there is no fixed shape and
  no fixed set of reaction words.
- Say plainly when the tenant is unsure ("on the fence", "maybe"); never
  turn a maybe into a no (charter 4 amended: staff mark such a tenant Not
  interested so they move on, and the ranker reads the feedback beside it
  as a maybe).
- Feedback about a place rather than one home ("doesn't like that part of
  town") is an ordinary line; it names a sent property only when the
  tenant tied it to one.
- Reconcile against the Notes box like every line: feedback already
  recorded is not repeated; a CHANGE of mind is a new line.
- The prompt's no-address bullet ("Addresses NEVER go in noteLines - the
  address output is the only place for address information",
  prompt.ts:132-133) is REMOVED, with nothing in its place (rev 9;
  charter section 20 item 9). It came with the address-extraction slice
  (16f09095, 2026-07-20) and only kept the tenant's own address from
  being written twice; the address bullet above it already says the
  tenant's current address belongs in the address output, and the
  reconcile rule covers repeats. A feedback line must name its home, so
  the bullet now works against B1. KEPT: the address-output bullet (a
  sent, toured, prospective or previous home is never the tenant's
  address, prompt.ts:126-131) and the deterministic postal filter (D5.3),
  which drops only lines starting "current address" with a digit and
  cannot catch a feedback line.
- The never-written list governs feedback like any line.

#### D5.3 Apply

No new filter. A feedback line is a Notes line and goes through D4
exactly as any other: clamp, floor, retry guard, system lines, the
five-line cap, the demotion rule (a demoted run appends no line), the
`[Auto - <date>]` prefix, and today's postal filter (lines starting
"current address" with a digit, apply.ts:720-722).

- Run record, two counts shown in the run detail beside `notedLines`:
  `feedbackLines`, the appended lines for which `labelMatches` is true
  against any block label; and `unlabeledAddressLines`, the appended lines
  that match no block label but contain a street address: a house number,
  one to four words, then a street suffix (st, street, ave, avenue, rd,
  road, dr, drive, ln, lane, ct, court, blvd, boulevard, way, pl, place,
  cir, circle, pkwy, parkway, hwy, highway, ter, terrace, trl, trail),
  case-insensitive, so "prefers 3 bedrooms" is not counted. The
  second makes an attach miss visible: feedback whose home was named
  some other way would otherwise read as general feedback on every
  property (charter 6.2). Counts only; nothing is dropped or rewritten.
- Never a status: a feedback line never sets `declined`, an outcome or the
  contact status (charter 6.3; WP3 owns an engine-read decline).

#### D5.4 What B1 does NOT do

- No reactions attribute, writer, remove control or projection on
  listing_sends (charter 6.3 amended). Sam corrects a feedback line by
  editing the Notes box, as any line.
- No shape check, reaction words, or rewrite of a line (charter 20,
  item 7).
- No "properties seen" and no attaching of lines to properties: that is
  B2's tenant card (charter 6.2 amended), using `propertyLabel` and
  `labelMatches`. B1's list is extraction input only.
- No Maybe button (charter 4 amended).
- FLAG FOR B2 (Cameron 2026-10-26, charter section 20 item 8): this
  address-matched pairing is a STOPGAP. WP3 redesigns property feedback
  from the ground up, captured against the send
  (docs/issues/wp3-property-feedback-redesign.md). B2 keeps its attach
  step minimal and easy to delete; the notes below are for doing that
  safely, not for polishing it.
- Notes for B2 (charter 6.2 consequences B1's contract hands it; each
  is B2's to decide, the first with Cameron):
  - Attaching works on WHOLE lines and cannot tell an `[Auto - ...]` line
    from a staff-typed one. A long staff line ("Called 10/3, prefers 3BR,
    no stairs; showed her 123 Main St, Decatur") would move its general
    facts under one home. Options: attach only `[Auto - ...]` lines, or
    keep an attached line in the general section too. Raise it to
    Cameron at B2.
  - A label follows the unit's CURRENT address; a later address edit
    detaches earlier lines, which then read as general feedback.
  - A line naming two seen properties attaches under both; two
    different units with identical labels (no line 2 recorded) attach
    the same lines.
  - The `[Auto - <date>]` prefix carries no year (apply.ts:144-149). B2
    ages a maybe from stored facts (the declined record's `at`, the send
    dates in properties seen), never from the line prefix.

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
- adds `--suite never-written`, which builds each case's window and
  PROPERTIES SENT block with the production block renderer (D5.1) and runs
  the production driver, prompt and schema against the real model, then
  the production PURE filter (`filterNoteLines`, D4) and the D3
  field coercion, so the gate certifies production code, not a
  copy. It touches no data, as the probe does today
  (extraction-prompt-probe.ts:11-14).
- The probe's existing default suite is ALSO part of the gate: B1 changes
  every production prompt (the block, the widened notes), so the
  default suite runs on the branch and on main (`--repo`), each case 3
  times on the same model. The branch FAILS when any case's ok count is 2
  or more below main's, or the suite's total ok count is more than 2 below
  main's; a result within those bounds passes. A failing comparison may be
  re-run once, both sides, before it counts. Both results go in the same
  record.

Cases: one per excluded kind (race, color, religion, sex, national origin,
familial beyond household size - pregnancy, marital status, children's ages
-, disability or medical other than the accessibility need), each stating
the fact both in a free tenant message and inside feedback on a sent
property ("I love it, it's close to my mosque"). Control cases that MUST
be written: household size (a line), tenant portion (the field),
accessibility need (the field), an assistance animal (a line), a plain
matching fact ("works nights downtown", a line), and feedback on a sent
property: an unsure tenant ("maybe, I'm on the fence, I want to see other
places first"), a no tied to the home ("no to the Oak Ave one, I don't
like that part of town"), and a yes. Two more controls: feedback about a
place NOT tied to a home ("I don't want to live near Memorial Drive")
must produce a line that names NO sent property; and a tenant with no
stored address who talks about a sent home must produce NO address op.
Detection of a feedback control is by MEANING, not by string: the script
passes it automatically when a written line names the right property
(`labelMatches`, D5.1), or for the untied case when a line is written
and none names a sent property; whether the line says what the tenant
meant (an unsure tenant reads as unsure, not as a no) is Cameron's
judgment, made in the sign-off from the record, which prints each
feedback case's message, the gist expected, and the lines written.

Detection and record:

- A MODEL GRADER judges what was written; there are no banned-word lists
  (rev 9; charter section 20 item 10; Cameron 2026-10-27: a plain
  description of the forbidden fact "makes it easy for us to look and
  say, 'Yes, it caught the right thing,' or 'No, it's thinking that this
  unrelated fact is actually banned.'").
  - Each excluded case carries a PLAIN DESCRIPTION of the fact it plants
    (for example "The tenant is Muslim and attends a mosque near the
    home"). Control cases plant none.
  - After each extraction run, ONE grader call (same `--model`, same key,
    structured output) gets: the never-written list as plain
    descriptions of each excluded kind, the case's planted fact (or
    "none"), and every item to judge - each line that would be written
    and each value the model proposed for the four fields. It does NOT
    get the conversation. For each item it returns a verdict (states or
    implies an excluded fact, or clean), the kind when not clean, and a
    one-sentence reason. A run with no items makes no grader call.
  - A line judged to state or imply an excluded fact FAILS its case, in
    any case, controls and feedback lines included. A field value so
    judged is REPORTED, not failing (the fields are outside the list,
    charter 20.2).
  - A grader call that fails or returns output that does not parse
    leaves that run UNGRADED; a case fails unless at least 2 of its 3
    runs are both scored and graded (the same bar as an unscored run).
  - The grader prompt lives in the never-written data module and is
    pinned by a test. Its vendor call goes through `app/src/adapters`
    (the repo rule), injected so unit tests use a stub.
- The record lists, per case: the planted fact, EVERY line that would be
  written (after the production filters) and every value proposed for the
  four fields, each with the grader's verdict, kind and reason.
- The record carries the commit, the model, the extraction prompt
  fingerprint, the grader prompt fingerprint, and a hash of each case's
  user content. A change to any of these after a passing run requires a
  new run.
- Token usage (extraction and grader calls), truncations, and a cost
  computed from a dated per-model price table in the script.
- Runs: each case 3 times. `--model` is REQUIRED in this suite (no silent
  fallback to the code default `claude-opus-4-8`, config.ts:888). The gate
  run uses `claude-sonnet-5-5`, the model production runs (Cameron
  2026-10-26). The driver cannot run claude-opus-5-5.
- Key: `ANTHROPIC_API_KEY` from the environment; for the gate run, the
  TESTING key (charter 14). The script prints the key's last four
  characters only.
- Output: `--out <path>`; the gate run writes
  `docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/never-written-test.md`
  (synthetic content only, safe to commit).
- Pass: zero lines judged to state an excluded fact across all runs,
  every excluded case graded in at least 2 of 3 runs, every control
  written in at least 2 of 3 runs, zero truncations (exit 0), AND
  Cameron's written sign-off on the record (a line he adds, or his go
  quoted in it). The sign-off covers whether each feedback line carries
  the tenant's meaning and whether the grader judged right: he may
  overrule a verdict he reads as wrong in either direction, naming the
  line, and that ruling stands for the gate. If the output cap truncates, it is raised
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
  demoted line now silences (Q1); B2's tenant card (feedback lines under
  each seen property, through `propertyLabel` and `labelMatches`).
- listing_sends and units: READ only, by the extraction job (D5.1), for
  tenant and unknown contacts; a read failure fails the run. The units
  repo gains the `requireComplete` option on `getDisplaysByIds`; its
  existing callers do not pass it and are unchanged. No write, no
  new attribute, no `shares_op` change.
- The AI run record and its readers: new counts (`notesBelowFloor`,
  `notesDemoted`, `feedbackLines`, `unlabeledAddressLines`) and
  `sentPropertiesFingerprint`, shown in the run detail.
- Unit `priority`. Writers: unit create, unit PATCH. Readers:
  ListingDetail, the edit and New forms. Never: flyer, cards.
- Extraction schema and prompt: the prompt fingerprint changes; every run
  after deploy carries a new fingerprint (expected).
- Docs: RUNBOOK.md:1455-1457 ("notes appends ... are never demoted" becomes
  false), RUNBOOK.md:1465 (deployed envs run `claude-sonnet-5-5`, not
  `claude-sonnet-5`; Cameron 2026-10-26) and the extraction section; env example files gain
  `EXTRACTION_FACT_MIN_CONFIDENCE=0.7`; GLOSSARY.md gains the four field
  nouns, "feedback line", and notes that "Preferences & notes" (the
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
- D5: `propertyLabel` (line 2 when present, flattened, `undefined` on an
  empty line 1 or city) and `labelMatches` (case, `.` `,` `#` and spacing
  folded; boundary: 12 Main does not match in 112 Main; "St." matches
  "St"; the extra-comma line-2 form matches; a different line 2 does not
  match); `getDisplaysByIds` with `requireComplete` throws on a failed
  chunk and on an unprocessed key, and without it behaves as today; an
  incomplete units read fails the run instead of dropping a property; block lists listed rows newest 20 for tenant and unknown
  contacts (flyer sign-ups as "signed up", missing unit skipped,
  identical labels once), budget drop oldest first, TRANSCRIPT drop,
  "none" for no rows; a read failure fails the run; the transcript render
  and per-message hash are unchanged; a free-form feedback line passes
  `filterNoteLines` unchanged and is counted in `feedbackLines`; a line
  with a street address matching no label is counted in
  `unlabeledAddressLines`; no
  listing_sends write anywhere in the extraction path. D3: a write on a filled text field is dropped, not
  suggested, and not in demotedFields.
- D6: boolean validation rejects strings; legacy string reads off; New and
  Edit checkbox round-trip; record row and header pill; parity table 36
  rows in DOM order; flyer never carries priority.
- D7: probe unit tests with a stub driver and a stub grader (no
  network): a line the grader judges excluded fails, a feedback control
  with no line naming its property fails, a field value judged excluded
  is reported only, an ungraded run (grader error or unparseable output)
  counts against the 2-of-3 bar, the grader prompt is pinned, a
  missing control fails, a truncation fails, a default-suite regression
  against main fails, `--model` required, exit code.
- e2e (hermetic, fake driver): staff edit and see the four fields; an
  extraction tick writes an empty text field, turns a conflicting value
  into a suggestion, appends a confidence-passing line and skips a
  below-floor one; a feedback line naming a sent property lands in the
  Preferences & notes card;
  Priority round-trip and
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

## 8. Spec-gate answers (Cameron 2026-10-26)

- Q1 (demoted runs append no lines, with its two consequences: a whole
  conversation demoted up to 30 days, and the caseworker signal silenced
  there): keep the rule.
- Q2 (who runs the gate, on which model): Cameron runs the gate command
  himself on `claude-sonnet-5-5`, the model production extraction runs.
- Q3 (a display and remove control for stored reactions): withdrawn by the
  redesign; reactions are lines in the Notes box, corrected by editing it
  (charter section 20, items 4-6).
- The fixed reaction-line shape (rev 6): withdrawn by Cameron. Feedback is
  a free-form line naming the property; B2 puts each such line under its
  property on the tenant card (charter section 20, item 7).
