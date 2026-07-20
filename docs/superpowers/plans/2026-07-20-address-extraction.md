# Address Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The extraction model emits the client's current address as structured parts; apply writes the contact `address` object (edit-form-identical shape) with `address_source` provenance, or queues a parts-carrying suggestion on conflict; the TenantFile "Current address" row gets the Auto badge + review chip; a human PATCH supersedes both.

**Architecture:** Ninth extraction target riding the existing pipeline end-to-end (schema -> parse -> prompt -> apply -> suggestion store -> accept route -> dashboard). Compound-value firsts: the wire carries parts (all-required sentinels, optional-count stays 0), the suggestion item carries BOTH a display string (chip) and a parts object (accept), and equality is a normalized joined-parts compare.

**Tech Stack:** Existing app (Express/DynamoDB/Vitest) + dashboard (React) + e2e (Playwright, fake EXTRACT: driver).

**Spec:** docs/superpowers/specs/2026-07-20-address-extraction-design.md

## Global Constraints

- ASCII-only in every added line (`tr -d '\11\12\15\40-\176' < FILE | wc -c` -> 0).
- The structured-outputs grammar cap: schema stays ALL-REQUIRED (sentinels for "nothing"); the countOptionalParams pin (<= 24) in app/test/extractionSchema.test.ts must stay green.
- Never log transcript text or address values in log lines - ids/field names/counts only (addresses ARE PII here).
- Gates bare from the worktree: `npm run typecheck`, `npm test`, `timeout 1500 npm run e2e`.
- Commit discipline: gating bare `git status` before every commit; explicit paths; Co-Authored-By trailer naming the authoring model.
- `unit` terminology rules (CLAUDE.md) - no new domain nouns here.

---

### Task 1: Shared address helpers

**Files:**
- Create: `app/src/services/extraction/address.ts`
- Test: `app/test/extractionAddress.test.ts` (new)

**Interfaces:**
- Produces: `cleanAddressParts(raw: unknown): ExtractionAddressParts` (trim, drop empties, known keys only, 120-char clamp), `formatAddressParts(parts): string` (comma-joined line1,line2,city,state,zip), `contactAddressToParts(raw: unknown): ExtractionAddressParts` (handles object AND legacy plain-string `address`), `isEmptyAddressValue(raw: unknown): boolean`, `normalizeAddressForCompare(text: string): string`. Types `ExtractionAddressParts`/`ExtractionAddress` come from Task 2's adapter edit - to keep THIS task self-contained, declare the parts type here and have Task 2 re-export it.

- [ ] **Step 1: Write the failing test**

```ts
// app/test/extractionAddress.test.ts
import { describe, expect, it } from 'vitest';
import {
  cleanAddressParts,
  contactAddressToParts,
  formatAddressParts,
  isEmptyAddressValue,
  normalizeAddressForCompare,
} from '../src/services/extraction/address.js';

describe('cleanAddressParts', () => {
  it('keeps trimmed non-empty known parts only', () => {
    expect(
      cleanAddressParts({ line1: ' 535 Seal Pl NE ', line2: '', city: 'Atlanta', state: 'GA', zip: '30328', bogus: 'x' }),
    ).toEqual({ line1: '535 Seal Pl NE', city: 'Atlanta', state: 'GA', zip: '30328' });
  });
  it('returns {} for non-objects', () => {
    expect(cleanAddressParts('535 Seal Pl')).toEqual({});
    expect(cleanAddressParts(undefined)).toEqual({});
  });
  it('clamps parts to 120 chars', () => {
    const long = 'a'.repeat(150);
    expect(cleanAddressParts({ line1: long }).line1).toHaveLength(120);
  });
});

describe('formatAddressParts', () => {
  it('joins non-empty parts in canonical order', () => {
    expect(formatAddressParts({ city: 'Atlanta', line1: '535 Seal Pl NE', zip: '30328', state: 'GA' })).toBe(
      '535 Seal Pl NE, Atlanta, GA, 30328',
    );
  });
  it('is empty for empty parts', () => {
    expect(formatAddressParts({})).toBe('');
  });
});

describe('contactAddressToParts', () => {
  it('reads a stored parts object', () => {
    expect(contactAddressToParts({ line1: '1 Main St', city: 'Atlanta' })).toEqual({ line1: '1 Main St', city: 'Atlanta' });
  });
  it('treats a legacy plain-string address as line1', () => {
    expect(contactAddressToParts('1 Main St, Atlanta GA')).toEqual({ line1: '1 Main St, Atlanta GA' });
  });
});

describe('isEmptyAddressValue', () => {
  it('true for absent / empty object / whitespace parts / empty string', () => {
    expect(isEmptyAddressValue(undefined)).toBe(true);
    expect(isEmptyAddressValue({})).toBe(true);
    expect(isEmptyAddressValue({ line1: '  ' })).toBe(true);
    expect(isEmptyAddressValue('  ')).toBe(true);
  });
  it('false for a real part or non-empty legacy string', () => {
    expect(isEmptyAddressValue({ city: 'Atlanta' })).toBe(false);
    expect(isEmptyAddressValue('1 Main St')).toBe(false);
  });
});

describe('normalizeAddressForCompare', () => {
  it('is case/whitespace/punctuation-insensitive', () => {
    expect(normalizeAddressForCompare('535 Seal Pl NE, Atlanta, GA, 30328')).toBe(
      normalizeAddressForCompare('535  seal pl ne atlanta ga 30328.'),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from the worktree root): `npm test -- --run extractionAddress`
Expected: FAIL - cannot resolve `../src/services/extraction/address.js`.

- [ ] **Step 3: Implement**

```ts
// app/src/services/extraction/address.ts
// Shared address-parts helpers for the address extraction target (spec
// 2026-07-20-address-extraction-design SS3/SS5). Used by the schema parser,
// the apply policy, the suggestion-accept route, and the profile snapshot -
// ONE cleaning/formatting/comparison story everywhere.

/** The five storable postal parts (matches the edit-form PATCH allowlist). */
export const ADDRESS_PART_KEYS = ['line1', 'line2', 'city', 'state', 'zip'] as const;
export type AddressPartKey = (typeof ADDRESS_PART_KEYS)[number];

export type ExtractionAddressParts = Partial<Record<AddressPartKey, string>>;

const MAX_PART_CHARS = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Trimmed, non-empty, known-key, clamped parts from an untrusted value. */
export function cleanAddressParts(raw: unknown): ExtractionAddressParts {
  if (!isRecord(raw)) return {};
  const out: ExtractionAddressParts = {};
  for (const key of ADDRESS_PART_KEYS) {
    const part = raw[key];
    if (typeof part !== 'string') continue;
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    out[key] = trimmed.length > MAX_PART_CHARS ? trimmed.slice(0, MAX_PART_CHARS) : trimmed;
  }
  return out;
}

/** Canonical single-line display form: non-empty parts joined by ', '. */
export function formatAddressParts(parts: ExtractionAddressParts): string {
  return ADDRESS_PART_KEYS.map((k) => parts[k])
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(', ');
}

/**
 * A stored contact `address` as parts. Handles the two stored shapes: the
 * structured object the edit form writes, and the legacy plain-string
 * `address` some pre-contract dev records carry (folds to line1).
 */
export function contactAddressToParts(raw: unknown): ExtractionAddressParts {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? { line1: trimmed } : {};
  }
  return cleanAddressParts(raw);
}

/** True when the stored value holds NO usable address content. */
export function isEmptyAddressValue(raw: unknown): boolean {
  return formatAddressParts(contactAddressToParts(raw)).length === 0;
}

/** Case/whitespace/punctuation-insensitive comparison key. */
export function normalizeAddressForCompare(text: string): string {
  return text.toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --run extractionAddress`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git status   # gating read - inspect before staging
git add app/src/services/extraction/address.ts app/test/extractionAddress.test.ts
git commit -m "feat(extraction): shared address-parts helpers (clean/format/compare)"
```
(Every commit in this plan carries the standing Co-Authored-By trailer.)

---

### Task 2: Wire schema + parse + result types

**Files:**
- Modify: `app/src/adapters/extraction.ts` (types)
- Modify: `app/src/services/extraction/schema.ts` (EXTRACTION_SCHEMA + parseExtractionText + PROVENANCE_FIELDS)
- Test: `app/test/extractionSchema.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `cleanAddressParts`, `formatAddressParts`, `ExtractionAddressParts`.
- Produces: `ExtractionResult.address?: ExtractionAddress` where `interface ExtractionAddress { op: 'write' | 'suggest'; parts: ExtractionAddressParts; reason?: string }` (re-export `ExtractionAddressParts` from adapters/extraction.ts for downstream imports); `PROVENANCE_FIELDS: readonly string[]` = the eight EXTRACTABLE_FIELDS + 'address' (exported from schema.ts).

- [ ] **Step 1: Write the failing tests (extend extractionSchema.test.ts)**

```ts
describe('address target', () => {
  const base = {
    fields: allNoneFields(),           // use/extend the file's existing all-sentinel helper
    statusAdvance: { suggest: false, reason: '' },
    typeSuggestion: { value: 'none', reason: '' },
    phoneAddition: { phone: '', label: '', reason: '' },
    noteLines: [],
    speakerRoles: [],
  };

  it('schema requires address with all-required parts (optional count stays pinned)', () => {
    const props = EXTRACTION_SCHEMA['properties'] as Record<string, any>;
    expect((EXTRACTION_SCHEMA['required'] as string[])).toContain('address');
    expect(props['address'].required).toEqual(['op', 'line1', 'line2', 'city', 'state', 'zip', 'reason']);
    // The existing countOptionalParams pin test in this file must still pass unchanged.
  });

  it('parses an op:write address into trimmed parts', () => {
    const r = parseExtractionText(JSON.stringify({
      ...base,
      address: { op: 'write', line1: ' 535 Seal Pl NE ', line2: '', city: 'Atlanta', state: 'GA', zip: '30328', reason: 'stated current address' },
    }));
    expect(r.address).toEqual({
      op: 'write',
      parts: { line1: '535 Seal Pl NE', city: 'Atlanta', state: 'GA', zip: '30328' },
      reason: 'stated current address',
    });
  });

  it('op none folds to absent', () => {
    const r = parseExtractionText(JSON.stringify({
      ...base,
      address: { op: 'none', line1: '', line2: '', city: '', state: '', zip: '', reason: '' },
    }));
    expect(r.address).toBeUndefined();
  });

  it('write/suggest with all-empty parts downgrades to absent', () => {
    const r = parseExtractionText(JSON.stringify({
      ...base,
      address: { op: 'suggest', line1: ' ', line2: '', city: '', state: '', zip: '', reason: 'x' },
    }));
    expect(r.address).toBeUndefined();
  });

  it('a payload without address round-trips unchanged', () => {
    const r = parseExtractionText(JSON.stringify(base));
    expect(r.address).toBeUndefined();
  });
});
```

Also add to the wire-shape/sentinel round-trip tests any place the file enumerates the top-level required keys.

- [ ] **Step 2: Run to verify the new cases fail**

Run: `npm test -- --run extractionSchema`
Expected: new cases FAIL (address key unknown / dropped).

- [ ] **Step 3: Implement**

In `app/src/adapters/extraction.ts` (types only):

```ts
import type { ExtractionAddressParts } from '../services/extraction/address.js';
export type { ExtractionAddressParts } from '../services/extraction/address.js';

/** The ninth target: the client's CURRENT address as structured parts. */
export interface ExtractionAddress {
  op: 'write' | 'suggest';
  parts: ExtractionAddressParts; // only non-empty trimmed parts
  reason?: string;
}
// ExtractionResult gains:
//   address?: ExtractionAddress;
```

(Type-only import keeps extractionFake's no-runtime-cycle rule intact.)

In `app/src/services/extraction/schema.ts`:

```ts
import { cleanAddressParts } from './address.js';

/** Fields carrying `<field>_source` AI provenance a human PATCH must clear:
 *  the eight scalar extractables plus the compound `address`. */
export const PROVENANCE_FIELDS: readonly string[] = [...EXTRACTABLE_FIELDS, 'address'];

// EXTRACTION_SCHEMA properties gains (and top-level required gains 'address'):
address: {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: { type: 'string', enum: ['none', 'write', 'suggest'] },
    line1: { type: 'string' },
    line2: { type: 'string' },
    city: { type: 'string' },
    state: { type: 'string' },
    zip: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['op', 'line1', 'line2', 'city', 'state', 'zip', 'reason'],
},

// parseExtractionText, after the phoneAddition block:
// Address target: op 'none' folds to absent; an op with ZERO usable parts
// downgrades to absent (mirrors the value-less field-op downgrade).
const rawAddress = root.address;
if (isRecord(rawAddress) && (rawAddress.op === 'write' || rawAddress.op === 'suggest')) {
  const parts = cleanAddressParts(rawAddress);
  if (Object.keys(parts).length > 0) {
    const value: NonNullable<ExtractionResult['address']> = { op: rawAddress.op, parts };
    if (typeof rawAddress.reason === 'string' && rawAddress.reason.trim().length > 0) {
      value.reason = clamp(rawAddress.reason, MAX_REASON_CHARS);
    }
    result.address = value;
  }
}
```

(`cleanAddressParts` reads the part keys directly off the raw op object - the wire puts parts flat next to `op`, and cleanAddressParts ignores unknown keys like `op`/`reason`.)

- [ ] **Step 4: Run the FULL schema suite (the optional-count pin especially)**

Run: `npm test -- --run extractionSchema`
Expected: PASS including the countOptionalParams pin (all-new keys are required).

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/adapters/extraction.ts app/src/services/extraction/schema.ts app/test/extractionSchema.test.ts
git commit -m "feat(extraction): address target on the wire - all-required parts schema + sparse parse"
```

---

### Task 3: Prompt rules + profile snapshot

**Files:**
- Modify: `app/src/services/extraction/prompt.ts`
- Modify: `app/src/adapters/extraction.ts` (`ExtractionProfileSnapshot.address?: string`)
- Modify: `app/src/jobs/extraction.ts` (`toProfile`)
- Test: `app/test/extractionAdapter.test.ts` and/or the prompt assertions where buildExtractionSystemPrompt is covered; `app/test/extractionJob.test.ts` for toProfile

**Interfaces:**
- Consumes: Task 1's `contactAddressToParts` + `formatAddressParts`.
- Produces: profile JSON now carries `address` (single formatted line) when the contact has one.

- [ ] **Step 1: Failing tests**

In the prompt test coverage (where the system prompt's rules are asserted):

```ts
it('carries the address hard rules', () => {
  const p = buildExtractionSystemPrompt();
  expect(p).toContain('address');
  expect(p).toContain('NEVER the address of a unit or property');
  expect(p).toContain('Addresses NEVER go in noteLines');
});
```

In `extractionJob.test.ts` (toProfile is exercised via the job; use the file's existing harness):

```ts
it('profile carries the formatted current address', async () => {
  // seed the contact used by the existing run-harness with:
  //   address: { line1: '1 Main St', city: 'Atlanta', state: 'GA' }
  // run one extraction with a capturing fake driver and assert:
  expect(capturedInput.profile.address).toBe('1 Main St, Atlanta, GA');
});
it('profile omits address when the contact has none', async () => {
  expect(capturedInput.profile.address).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --run extractionJob` and the prompt-covering file.
Expected: FAIL.

- [ ] **Step 3: Implement**

`ExtractionProfileSnapshot` gains:

```ts
  /** Single-line formatted current address ("line1, line2, city, state, zip"). */
  address?: string;
```

`toProfile` (jobs/extraction.ts), after the notes line:

```ts
  const address = formatAddressParts(contactAddressToParts(contact['address']));
  if (address.length > 0) profile.address = address;
```

`buildExtractionSystemPrompt` additions (keep ASCII, keep the existing voice):

1. OUTPUT SHAPE paragraph: extend the always-emit list with
   `address (op "none" with every part "" and reason "" when there is no address to record)`.
2. New HARD RULES bullets, placed with the other field rules:

```
'- address is the client\'s OWN CURRENT residential address ONLY - a place',
'  the client states they live at NOW. It is NEVER the address of a unit or',
'  property they are asking about, touring, applying to, or that staff sent',
'  or mentioned to them; NEVER a previous address; NEVER a prospective or',
'  future address. When unsure, use op "none". Put each component in its',
'  part (line1, line2, city, state, zip); leave unknown parts "".',
'- Addresses NEVER go in noteLines - the address output is the only place',
'  for address information.',
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- --run extractionJob` + the prompt file. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/services/extraction/prompt.ts app/src/adapters/extraction.ts app/src/jobs/extraction.ts app/test/extractionJob.test.ts <prompt-test-file>
git commit -m "feat(extraction): address prompt rules (current-residence only) + profile snapshot line"
```

---

### Task 4: Apply policy (write / suggest / demote / notes filter)

**Files:**
- Modify: `app/src/services/extraction/apply.ts`
- Modify: `app/src/repos/extractionRepo.ts` (SuggestionItem.suggestedAddress + putSuggestion passthrough)
- Test: `app/test/extractionApply.test.ts` (extend), `app/test/extractionRepo.test.ts` (suggestedAddress round-trip)

**Interfaces:**
- Consumes: Task 1 helpers; Task 2's `ExtractionResult.address`.
- Produces: `SuggestionItem.suggestedAddress?: ExtractionAddressParts`; apply writes `address` + `address_source`, or a suggestion with target `'address'` carrying `suggestedValue` (display string) AND `suggestedAddress` (parts).

- [ ] **Step 1: Failing tests (extend extractionApply.test.ts, mirroring its harness style)**

Cases (write each as a real test using the file's existing fake deps):

```ts
it('writes address into an empty field with provenance + audit', ...)
  // tenant contact, no address; result.address = { op:'write', parts:{line1:'1 Main St',city:'Atlanta'} }
  // expect contacts.update patch: address={line1:'1 Main St',city:'Atlanta'},
  //   address_source={source:'ai',at,conversationId,tsMsgId}
  // expect audit ai_extraction_applied fields to contain
  //   { field:'address', from: undefined, to: '1 Main St, Atlanta', reason? }
  // expect outcome.wrote to contain 'address'

it('op write on an occupied address still writes (model-judged equivalent)', ...)

it('conflict suggests with display strings AND parts', ...)
  // contact.address={line1:'9 Old Rd',city:'Macon'}; result op:'suggest', parts new
  // expect putSuggestion: target 'address',
  //   currentValue '9 Old Rd, Macon', suggestedValue '1 Main St, Atlanta',
  //   suggestedAddress {line1:'1 Main St',city:'Atlanta'}

it('normalized-equal suggestion is skipped', ...)
  // stored '535 Seal Pl NE, Atlanta' vs suggested {line1:'535  seal pl ne',city:'ATLANTA'} -> no putSuggestion

it('legacy plain-string stored address compares/normalizes correctly', ...)
  // contact.address = '535 Seal Pl NE, Atlanta' (string) + equal suggestion -> skipped

it('inferred-role content demotes an address write to a suggestion', ...)
  // hasInferredRoleContent:true + op:'write' -> putSuggestion, no direct write,
  //   'address' present in the ai_extraction_demoted audit fields

it('address is ignored for non-tenant contacts', ...)
  // landlord + unknown contacts -> no write, no suggestion

it('noteLines starting with "Current address" are dropped', ...)
  // result.noteLines:['Current address: 1 Main St','Has a service dog'] -> only the dog line appends
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --run extractionApply`
Expected: FAIL (address result ignored today).

- [ ] **Step 3: Implement**

`extractionRepo.ts` - SuggestionItem gains:

```ts
  /** Parts payload for the compound 'address' target - what accept writes
   *  (suggestedValue stays the human-readable joined string the chip shows). */
  suggestedAddress?: ExtractionAddressParts;
```

and putSuggestion's item construction gains:

```ts
        ...(s.suggestedAddress !== undefined && { suggestedAddress: s.suggestedAddress }),
```

`apply.ts` - after the EXTRACTABLE_FIELDS loop, BEFORE the batched-write commit block (so an address write rides the same single contacts.update):

```ts
  // --- address (compound ninth target; spec 2026-07-20 SS5) ------------------
  if (result.address !== undefined) {
    if (contact.type !== 'tenant') {
      logger.debug({ contactId, contactType: contact.type }, 'extraction address ignored for contact type');
    } else {
      const parts = cleanAddressParts(result.address.parts);
      const formattedNew = formatAddressParts(parts);
      if (formattedNew.length === 0) {
        logger.debug({ contactId }, 'extraction address skipped (no usable parts)');
      } else {
        const currentParts = contactAddressToParts(contact['address']);
        const formattedCurrent = formatAddressParts(currentParts);
        const hasCurrent = formattedCurrent.length > 0;
        if (result.address.op === 'write' && ctx.hasInferredRoleContent !== true) {
          writePatch['address'] = parts;
          writePatch['address_source'] = sourceStamp;
          auditFields.push({
            field: 'address',
            from: hasCurrent ? formattedCurrent : undefined,
            to: formattedNew,
            ...(result.address.reason !== undefined && { reason: result.address.reason }),
          });
          pendingWrites.push('address');
        } else {
          if (result.address.op === 'write') demotedFields.push('address');
          if (hasCurrent && normalizeAddressForCompare(formattedCurrent) === normalizeAddressForCompare(formattedNew)) {
            logger.debug({ contactId }, 'extraction address suggestion skipped (equal to current)');
          } else {
            const ok = await putSuggestionSafe(deps, {
              ownerContactId: contactId,
              target: 'address',
              ...(hasCurrent && { currentValue: formattedCurrent }),
              suggestedValue: formattedNew,
              suggestedAddress: parts,
              ...(result.address.reason !== undefined && { reason: result.address.reason }),
              conversationId,
              ...(cursorTsMsgId !== undefined && { tsMsgId: cursorTsMsgId }),
            });
            if (ok) suggested.push('address');
          }
        }
      }
    }
  }
```

Notes-filter, where rawNotes is assembled:

```ts
  // Addresses are a structured target now - a model that still narrates one
  // into noteLines is overridden deterministically (spec SS5).
  const rawNotes = [...(result.noteLines ?? []), ...noteStrings].filter(
    (line) => !/^current address\b/i.test(line.trim()),
  );
```

Audit `from` note: the write path can carry `from: undefined` - the existing auditFields entries already do that for empty scalars; keep the shape identical.

- [ ] **Step 4: Run**

Run: `npm test -- --run extractionApply` and `npm test -- --run extractionRepo`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/services/extraction/apply.ts app/src/repos/extractionRepo.ts app/test/extractionApply.test.ts app/test/extractionRepo.test.ts
git commit -m "feat(extraction): apply policy for the address target - write/suggest/demote + parts-carrying suggestion"
```

---

### Task 5: Accept route for target 'address'

**Files:**
- Modify: `app/src/routes/suggestions.ts`
- Test: `app/test/suggestions.test.ts` (extend)

**Interfaces:**
- Consumes: Task 4's `SuggestionItem.suggestedAddress`; Task 1's `cleanAddressParts`/`formatAddressParts`.
- Produces: POST .../suggestions/address/accept -> 200 { contact, suggestions } writing `address` + `address_source{accepted_by}`; 400 `invalid_suggestion_value` when the item has no usable parts.

- [ ] **Step 1: Failing tests**

```ts
it('accepts an address suggestion: writes parts + provenance, audits, deletes', async () => {
  // seed putSuggestion({ ownerContactId, target:'address',
  //   suggestedValue:'1 Main St, Atlanta', suggestedAddress:{line1:'1 Main St',city:'Atlanta'},
  //   conversationId:'conv-1' })
  // POST /api/contacts/:id/suggestions/address/accept
  // expect 200; contact.address == {line1:'1 Main St',city:'Atlanta'};
  // contact.address_source.source=='ai' with accepted_by; suggestion gone;
  // audit 'ai_suggestion_accepted' with target 'address', to '1 Main St, Atlanta'
});

it('400s when the suggestion item carries no usable parts', async () => {
  // seed target:'address' with suggestedValue only (no suggestedAddress)
  // expect 400 { error: 'invalid_suggestion_value' } and the suggestion KEPT
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --run suggestions`
Expected: FAIL (unknown_target today - 'address' is not in EXTRACTABLE).

- [ ] **Step 3: Implement (new branch between the 'phone' branch and the EXTRACTABLE branch)**

```ts
    // --- 'address' -> compound parts write (spec 2026-07-20 SS6) -------------
    if (target === 'address') {
      const parts = cleanAddressParts(suggestion.suggestedAddress);
      const formatted = formatAddressParts(parts);
      if (formatted.length === 0) {
        // A malformed/legacy item must never half-write an address.
        res.status(400).json({ error: 'invalid_suggestion_value' });
        return;
      }
      const from = formatAddressParts(contactAddressToParts(contact['address']));
      const patch: Record<string, unknown> = {
        address: parts,
        address_source: {
          source: 'ai',
          at: now,
          conversationId: suggestion.conversationId,
          ...(suggestion.tsMsgId !== undefined && { tsMsgId: suggestion.tsMsgId }),
          ...(actor !== undefined && { accepted_by: actor }),
        },
      };
      const updated = await contacts.update(contactId, patch);
      await audit.append(`contacts#${contactId}`, 'ai_suggestion_accepted', {
        ...(actor !== undefined && { actor }),
        target,
        ...(from.length > 0 && { from }),
        to: formatted,
      });
      await extraction.deleteSuggestion(contactId, 'address');
      events.emit('suggestion.updated', { contactId });
      const remaining = await extraction.listSuggestionsByContact(contactId);
      log.info({ contactId, target, actor }, 'ai suggestion accepted (address)');
      res.json({ contact: serializeContact(updated), suggestions: remaining });
      return;
    }
```

Update the route-doc comment block at the top of the file to list the
'address' accept semantics.

- [ ] **Step 4: Run**

Run: `npm test -- --run suggestions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/routes/suggestions.ts app/test/suggestions.test.ts
git commit -m "feat(extraction): accept path for the compound address suggestion"
```

---

### Task 6: Human PATCH supersession (provenance clear widened)

**Files:**
- Modify: `app/src/routes/contacts.ts`
- Test: `app/test/contactProfile.test.ts` or the contacts-API test file already covering the T8 provenance-clear behavior (find `_source` assertions; extend the same file)

**Interfaces:**
- Consumes: Task 2's `PROVENANCE_FIELDS` (from services/extraction/schema.ts).

- [ ] **Step 1: Failing test**

```ts
it('a human address edit clears address_source and supersedes the pending address suggestion', async () => {
  // seed contact with address + address_source {source:'ai',...} + a pending
  // target:'address' suggestion
  // PATCH /api/contacts/:id { address: { line1: '2 New St', city: 'Decatur' } }
  // expect stored address == {line1:'2 New St',city:'Decatur'};
  // address_source attribute REMOVED; suggestion for 'address' gone
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL - address_source survives (the clear-gate is EXTRACTABLE-only today).

- [ ] **Step 3: Implement**

In contacts.ts, where the T8 hook builds its field set (the `EXTRACTABLE` set near the top of the file), swap the source list:

```ts
import { PROVENANCE_FIELDS } from '../services/extraction/schema.js';
// replaces the EXTRACTABLE_FIELDS-built set used by the provenance-clear hook:
const PROVENANCE = new Set<string>(PROVENANCE_FIELDS);
```

and in the PATCH hook (~L1234):

```ts
    for (const f of parsed.changedFields) {
      if (PROVENANCE.has(f) && !(`${f}_source` in parsed.patch)) {
        parsed.patch[`${f}_source`] = null;
      }
    }
```

Keep any OTHER uses of the old EXTRACTABLE set semantically intact - only
the provenance-clear gate widens. The supersede-deleteSuggestion loop
below it already iterates every changedField by name (deletes 'address') -
the test proves it, no change there.

- [ ] **Step 4: Run**

Run: `npm test -- --run <that test file>` then `npm test -- --run contact` (the contact suites) to catch collateral.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/routes/contacts.ts app/test/<test-file>
git commit -m "feat(extraction): human address edit clears address_source + supersedes the suggestion"
```

---

### Task 7: Dashboard - badge + chip on the Current-address row

**Files:**
- Modify: `dashboard/src/api/types.ts` (SuggestionItem.suggestedAddress)
- Modify: `dashboard/src/routes/contact/suggestionTargets.ts` (label)
- Modify: `dashboard/src/routes/contact/TenantFile.tsx` (row wiring)
- Test: the dashboard component test covering TenantFile suggestions/badges (extend alongside the existing voucherSize/housingAuthority cases; find it via `grep -rl "AI suggestion for" dashboard/src`)

**Interfaces:**
- Consumes: server SuggestionItem with target 'address' + display-string suggestedValue; `address_source` provenance read by `aiSourceOf`.

- [ ] **Step 1: Failing tests (mirror the existing chip/badge cases)**

```tsx
it('shows the Auto badge on Current address when address_source is ai', ...)
  // contact.address={line1:'1 Main St',city:'Atlanta'}, address_source:{source:'ai',at:'...'}
  // expect the Current address row to contain the AutoBadge (existing query pattern)

it('renders the address suggestion chip and forwards accept', ...)
  // suggestions=[{target:'address', suggestedValue:'1 Main St, Atlanta', currentValue:'9 Old Rd, Macon', ...}]
  // expect getByRole/name 'AI suggestion for current address'; accept fires onAcceptSuggestion('address')
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --run TenantFile` (or that test file's name).
Expected: FAIL.

- [ ] **Step 3: Implement**

`types.ts` SuggestionItem gains:

```ts
  /** Parts payload for the compound 'address' target (server-side accept uses it). */
  suggestedAddress?: Address;
```

`suggestionTargets.ts`:

```ts
  address: 'current address',
```

`TenantFile.tsx` (line ~166):

```tsx
        <KV k="Current address" v={<>{currentAddress}{badgeFor('address')}</>} />
        {chipFor('address')}
```

- [ ] **Step 4: Run**

Run: `npm test -- --run <dashboard test file>`; then `npm run typecheck`.
Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git status
git add dashboard/src/api/types.ts dashboard/src/routes/contact/suggestionTargets.ts dashboard/src/routes/contact/TenantFile.tsx dashboard/src/<test-file>
git commit -m "feat(dashboard): Current-address row gets the AI Auto badge + review chip"
```

---

### Task 8: e2e + docs + full gates

**Files:**
- Modify: `e2e/tests/flows/conversation-fact-extraction.spec.ts` (extend)
- Modify: `docs/superpowers/specs/2026-07-15-conversation-fact-extraction-design.md` (decisions-log addendum line)
- Modify: `RUNBOOK.md` (extraction smoke-test field list + dev retest note)

**Interfaces:**
- Consumes: the fake driver's EXTRACT: protocol - it merges `Partial<ExtractionResult>` generically, so `EXTRACT:{"address":{"op":"write","parts":{"line1":"1 Main St","city":"Atlanta","state":"GA"}}}` works with NO driver change (the fake bypasses parseExtractionText - supply the INTERNAL shape, i.e. `parts` nested, exactly as ExtractionAddress).

- [ ] **Step 1: Extend the e2e spec (follow the file's existing scenario style)**

Scenarios to add:
1. Empty -> write: send an inbound SMS containing an `EXTRACT:` marker with `address op:'write'`; open the tenant's contact page; expect the Details "Current address" row to show `1 Main St, Atlanta, GA` and the Auto badge.
2. Conflict -> chip -> accept: send a second marker with `op:'suggest'` and different parts (include `suggestedValue`-relevant parts only); expect the chip "AI suggestion for current address" with both values; click Accept; expect the row updated and the chip gone.

Use the file's existing helpers for dev-login/reseed/sending the marker
message and its accessibility-first selectors.

- [ ] **Step 2: Run the extended spec from the worktree e2e workspace**

Run (from `e2e/`): the file's filtered-run command as used for this spec today (never `npm run e2e -- --flag` from the root - npm eats the flag).
Expected: PASS.

- [ ] **Step 3: Docs**

- Parent spec decisions log, one line: `2026-07-20: address promoted from noteLines to a structured ninth target (parts on the wire, compound suggestion) - see 2026-07-20-address-extraction-design.md.`
- RUNBOOK extraction section: add address to the extracted-field list and to the smoke-test script ("text a current address; expect the Details row + Auto badge"), and note the owed dev retest.

- [ ] **Step 4: Full gates, bare, from the worktree root**

```
npm run typecheck        # expect exit 0
npm test                 # expect exit 0
timeout 1500 npm run e2e # expect exit 0
```

- [ ] **Step 5: Commit**

```bash
git status
git add e2e/tests/flows/conversation-fact-extraction.spec.ts docs/superpowers/specs/2026-07-15-conversation-fact-extraction-design.md RUNBOOK.md
git commit -m "test(e2e)+docs: address extraction end-to-end + decisions-log/RUNBOOK addenda"
```

---

## Self-review notes (planner)

- Spec SS2-SS10 each map to a task (SS2/SS3->T2, SS4->T3, SS5->T4, SS6->T4+T5, SS7->T6, SS8->T7, SS9->T1..T8 tests, SS10->T8).
- Compound-value seams called out: suggestedValue (string, chip) vs suggestedAddress (parts, accept); legacy plain-string stored addresses (T1 contactAddressToParts + T4 test).
- The fake driver needs NO change (generic Partial merge) - T8 documents the internal-shape marker payload.
- Watch: the countOptionalParams pin (T2 step 4), PII (no address values in log lines - debug lines log ids only), and the parallel event-bridge mission (no shared files expected; events.emit call signature unchanged).
