# Address extraction - design spec (2026-07-20)

Slice 3 of conversation-fact-extraction (parent spec:
2026-07-15-conversation-fact-extraction-design.md; voice adapter:
2026-07-18-voice-extraction-adapter-design.md). Approved direction from
Cameron 2026-07-20: addresses currently land only as notes lines (live dev
example: "[Auto - Jul 20] Current address: 535 Seal Pl NE, Atlanta, GA,
30328"); promote the client's current address to a structured extraction
target that fills the Details panel's "Current address" field, with the
same write-empty / suggest-conflict / provenance / demotion machinery the
eight scalar fields already have.

## 1. What changes (one paragraph)

The model emits a ninth target: `address`, as structured PARTS (line1,
line2, city, state, zip) plus an op (none/write/suggest) and reason. Apply
writes the contact's `address` object exactly the way the edit form's
PATCH does (trimmed, non-empty parts only, whole-object SET replace),
stamping `address_source` provenance; a conflict with an existing address
becomes a pending suggestion whose item carries BOTH a display string and
the parts. The TenantFile "Current address" row gets the Auto badge and
the suggestion chip. A human PATCH of `address` clears the provenance and
supersedes the pending suggestion. Addresses stop flowing into noteLines.

## 2. Wire schema (all-required posture - the 24-optional cap)

New REQUIRED top-level key in EXTRACTION_SCHEMA (schema.ts), keeping the
schema-wide optional-parameter count at 0 (test pin: countOptionalParams
<= 24 in app/test/extractionSchema.test.ts must stay green):

```
address: {
  type: 'object', additionalProperties: false,
  properties: {
    op:    { enum: ['none', 'write', 'suggest'] },
    line1: { type: 'string' },   // "" sentinel = part not mentioned
    line2: { type: 'string' },
    city:  { type: 'string' },
    state: { type: 'string' },
    zip:   { type: 'string' },
    reason:{ type: 'string' },
  },
  required: ['op','line1','line2','city','state','zip','reason'],
}
```

`address` joins the top-level `required` list.

## 3. Internal types (adapters/extraction.ts)

```ts
export interface ExtractionAddressParts {
  line1?: string; line2?: string; city?: string; state?: string; zip?: string;
}
export interface ExtractionAddress {
  op: 'write' | 'suggest';
  parts: ExtractionAddressParts;   // only non-empty trimmed parts
  reason?: string;
}
// ExtractionResult gains: address?: ExtractionAddress;
```

parseExtractionText normalization: op 'none' -> absent; op write/suggest
with ALL parts empty after trim -> absent (mirrors the value-less field-op
downgrade); each part trimmed + clamped to 120 chars; empty reason
dropped, else clamped to 200.

ExtractionProfileSnapshot gains `address?: string` - the SINGLE-LINE
formatted current address ("line1, line2, city, state, zip" of non-empty
parts), built in jobs/extraction.ts toProfile from the contact's flexible
`address` doc, so the model can reconcile (none/write/suggest) against
what we already store.

## 4. Prompt rules (prompt.ts)

- OUTPUT SHAPE: add address to the always-emit list (sentinel: op "none",
  all parts "", reason "").
- HARD RULES (the false-positive trap - conversations are full of
  PROPERTY addresses):
  - `address` is the client's OWN CURRENT residential address ONLY -
    where they state they live NOW. NEVER the address of a unit/property
    they are asking about, touring, applying to, or that staff sent them.
    NEVER a previous address or a prospective/future address. If unsure,
    op "none".
  - Addresses NEVER go in noteLines (the address output is the only place
    for them).
- Reconciliation: the standard none/write/suggest rules apply against the
  CURRENT PROFILE's address line.

## 5. Apply policy (services/extraction/apply.ts)

- ELIGIBILITY: tenant-only (`address` does NOT apply to unknown - the
  "Current address" row is the tenant file; landlord/unknown conversations
  are saturated with property addresses, so the false-positive cost
  dominates any triage value). Same debug-log skip as fieldApplies.
- EXISTING-EMPTY test: contact.address absent, or an object whose five
  known parts are all absent/empty after trim.
- op 'write' AND NOT demoted: join the batched writePatch -
  `address` = cleaned parts object (trimmed, non-empty only; exactly the
  shape the edit-form PATCH stores), `address_source` = the shared
  sourceStamp. Audit entry in the same ai_extraction_applied batch with
  from/to as FORMATTED single-line strings (never the raw object - keeps
  the audit shape flat). Occupied + op 'write' = the model judged
  same-fact-better-form: direct write, same as the scalar fields.
- op 'suggest', or op 'write' demoted by hasInferredRoleContent (Layer 3;
  'address' joins demotedFields for the ai_extraction_demoted audit):
  skip when NORMALIZED-equal to current (join non-empty parts, lowercase,
  collapse whitespace, strip commas/periods); else putSuggestion:
  target 'address', currentValue = formatted current (when present),
  suggestedValue = formatted new (display string - what the chip shows),
  suggestedAddress = cleaned parts (what accept writes), reason,
  conversationId, tsMsgId.
- BELT-AND-BRACES noteLines filter: drop any incoming noteLine matching
  /^current address\b/i before the append (the prompt forbids it; the
  filter makes the ban deterministic). Historical "[Auto - ...] Current
  address: ..." notes lines on existing contacts stay - no migration.

## 6. Suggestion item + accept path

- SuggestionItem (extractionRepo.ts) gains OPTIONAL
  `suggestedAddress?: { line1?: string; line2?: string; city?: string;
  state?: string; zip?: string }`; putSuggestion passes it through
  (conditional spread like currentValue/reason/tsMsgId).
- suggestions.ts accept: new 'address' branch (before the EXTRACTABLE
  branch). suggestedAddress must be an object with >= 1 non-empty string
  part, else 400 invalid_suggestion_value (a malformed/legacy item never
  half-writes). Patch `address` = cleaned parts + `address_source`
  carrying accepted_by (mirror the field-target branch); audit
  ai_suggestion_accepted with formatted from/to; deleteSuggestion; emit
  suggestion.updated; respond { contact, suggestions }.
- Dismiss needs NO change (target-generic).

## 7. Human-edit supersession (routes/contacts.ts PATCH)

The provenance-clear hook currently gates on EXTRACTABLE.has(f) - address
is NOT an ExtractableField, so TODAY it would NOT clear. Widen the gate to
a PROVENANCE_FIELDS set = the eight EXTRACTABLE_FIELDS + 'address' (single
shared const exported from services/extraction/schema.ts so apply/routes
agree). The supersede-deleteSuggestion loop already iterates ALL
changedFields by name, so deleteSuggestion(contactId,'address') already
fires - verify with a test, no code change expected there.

## 8. Dashboard

- suggestionTargets.ts: SUGGESTION_TARGET_LABEL.address = 'current
  address' (chip accessible name "AI suggestion for current address").
- TenantFile.tsx Details row becomes
  `<KV k="Current address" v={<>{currentAddress}{badgeFor('address')}</>} />`
  + `{chipFor('address')}` - exactly the voucherSize/housingAuthority
  pattern. aiSourceOf already reads `address_source` via the flexible
  contact index.
- dashboard api types: SuggestionItem gains suggestedAddress (optional,
  parts shape). SuggestionChip itself is unchanged (it renders the
  currentValue/suggestedValue display strings).

## 9. Tests / e2e

- Unit: schema parse (sentinel folding, all-empty downgrade, clamp,
  optional-count pin still green), apply (tenant gate, empty->write with
  provenance+audit, occupied write, conflict->suggestion carrying parts +
  display strings, normalized-equal skip, demotion, noteLines address
  filter), accept route (writes parts + provenance + accepted_by, 400 on
  missing parts, supersession), contacts PATCH clears address_source.
- e2e (e2e/tests/flows/conversation-fact-extraction.spec.ts, fake driver
  EXTRACT: protocol - the fake merges Partial<ExtractionResult>
  generically, so `{"address":{"op":"write","parts":{...}}}` needs NO
  driver change): empty->write shows the address + Auto badge on the
  Details row; conflict shows the chip; accept updates the row and clears
  the chip.

## 10. Docs / follow-through

- Parent spec 2026-07-15 decisions log: one-line addendum pointing here
  (address promoted from noteLines to a structured target).
- RUNBOOK extraction smoke-test section: address joins the field list; a
  dev live retest (text a current address) is owed post-merge/deploy.
- No GLOSSARY change (no new domain noun).

## Watch items

- The 24-optional grammar cap: every new schema key stays all-required
  with sentinels; the countOptionalParams pin is the tripwire.
- Property-address false positives are a MODEL behavior risk the fake
  driver cannot test - the dev live retest is the real gate.
- parse must never emit address.op 'suggest'/'write' with zero parts.
- The event-bridge mission (w:/tmp/event-bridge, another agent) touches
  lib/events.ts; this slice only CALLS events.emit - no overlap expected.
