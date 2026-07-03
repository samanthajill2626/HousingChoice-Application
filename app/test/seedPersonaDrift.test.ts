// Drift-alarm test: asserts that the cast contacts in app/src/lib/seed/cast.ts
// and the SEEDED_PERSONAS list in fake-twilio/src/engine/registry.ts stay in
// lockstep. If either is updated without the other this test fails fast — the
// same principle as the phone-lib pinned-tables test.
//
// What we assert:
//  1. Every SEEDED_PERSONA with a seededRef points to a real seeded contact
//     whose primary phone === the persona number.
//  2. Every cast contact flagged drivable=true has exactly one persona in
//     SEEDED_PERSONAS (by seededRef === contactId).
//  3. Cast contacts flagged drivable=false have NO persona entry.
//
// Pattern: import from relative paths — no shared package, mirrors lane.test.ts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAST_CONTACTS_FOR_DRIFT } from '../src/lib/seed/cast.js';
import { SEED } from '../src/lib/seedData.js';

const __here = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.resolve(__here, '../../fake-twilio/src/engine/registry.ts');

// Dynamically import the registry so this test file stays plain ESM without
// needing the fake-twilio package as a dep. We import via vitest's tsx loader
// (same mechanism as lane.test.ts imports lane.mjs).
const { SEEDED_PERSONAS } = await import(registryPath) as typeof import('../../fake-twilio/src/engine/registry.js');

// ---------------------------------------------------------------------------
// Build a contactId → primaryPhone map from lean base + cast contacts
// ---------------------------------------------------------------------------

// Lean base contacts (original trio)
const leanContacts = SEED['contacts'] ?? [];

// contactId → primary phone
const contactPhoneMap = new Map<string, string>();

for (const c of leanContacts) {
  const phone = c['phone'] as string | undefined;
  const id = c['contactId'] as string | undefined;
  if (phone && id) contactPhoneMap.set(id, phone);
}

// Cast contacts — add from CAST_CONTACTS_FOR_DRIFT
for (const entry of CAST_CONTACTS_FOR_DRIFT) {
  contactPhoneMap.set(entry.contactId, entry.primaryPhone);
}

// ---------------------------------------------------------------------------
// Build a set of all seededRef values that exist in SEEDED_PERSONAS
// ---------------------------------------------------------------------------
const personasByRef = new Map<string, { number: string; id: string; label: string }>();
for (const p of SEEDED_PERSONAS) {
  if (p.seededRef) {
    personasByRef.set(p.seededRef, { number: p.number, id: p.id, label: p.label });
  }
}

// ---------------------------------------------------------------------------
// 1. Every persona with seededRef → the referenced contactId must exist in the
//    unified map AND its primary phone must match the persona number.
// ---------------------------------------------------------------------------
describe('persona drift: seededRef resolves to a real seeded contact with matching phone', () => {
  for (const p of SEEDED_PERSONAS) {
    if (!p.seededRef) continue;
    it(`persona '${p.id}' (seededRef='${p.seededRef}') resolves to a contact with phone '${p.number}'`, () => {
      const primaryPhone = contactPhoneMap.get(p.seededRef!);
      expect(
        primaryPhone,
        `persona '${p.id}' has seededRef='${p.seededRef}' but no seeded contact with that contactId has a primary phone`,
      ).toBeDefined();
      expect(
        primaryPhone,
        `persona '${p.id}' seededRef='${p.seededRef}' primary phone mismatch`,
      ).toBe(p.number);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Every drivable cast contact has exactly one persona by seededRef.
// ---------------------------------------------------------------------------
describe('persona drift: every drivable cast contact has a fake-twilio persona', () => {
  for (const entry of CAST_CONTACTS_FOR_DRIFT) {
    if (!entry.drivable) continue;
    it(`cast contact '${entry.contactId}' is drivable and has a SEEDED_PERSONAS entry`, () => {
      const persona = personasByRef.get(entry.contactId);
      expect(
        persona,
        `cast contact '${entry.contactId}' is marked drivable but has no persona with seededRef='${entry.contactId}'`,
      ).toBeDefined();
      // The persona's number must match the cast contact's primary phone
      expect(
        persona!.number,
        `persona for '${entry.contactId}' has number '${persona!.number}' but cast primary phone is '${entry.primaryPhone}'`,
      ).toBe(entry.primaryPhone);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Non-drivable cast contacts must NOT have a persona.
// ---------------------------------------------------------------------------
describe('persona drift: non-drivable cast contacts have no persona entry', () => {
  for (const entry of CAST_CONTACTS_FOR_DRIFT) {
    if (entry.drivable) continue;
    it(`cast contact '${entry.contactId}' is non-drivable and must have NO persona`, () => {
      const persona = personasByRef.get(entry.contactId);
      expect(
        persona,
        `cast contact '${entry.contactId}' is non-drivable but has persona '${persona?.id}'`,
      ).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Total persona count sanity check (3 lean + 8 cast drivable = 11)
// ---------------------------------------------------------------------------
describe('persona drift: total persona count', () => {
  it('SEEDED_PERSONAS has exactly 11 entries (3 lean + 8 cast drivable)', () => {
    expect(SEEDED_PERSONAS.length).toBe(11);
  });

  it('all persona numbers are unique', () => {
    const nums = SEEDED_PERSONAS.map((p) => p.number);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it('all persona seededRefs (where present) are unique', () => {
    const refs = SEEDED_PERSONAS.filter((p) => p.seededRef).map((p) => p.seededRef!);
    expect(new Set(refs).size).toBe(refs.length);
  });
});
