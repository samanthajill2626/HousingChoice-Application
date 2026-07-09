// Seed roster-shape coherence — guards the `participants` contract on SEEDED
// conversations. The app-wide contract is ConversationParticipant OBJECTS
// ({ contactId, phone, name? }, conversationsRepo.ts); seed builders type rows
// as flexible documents (Record<string, unknown>), so tsc alone never catches a
// roster written as bare contactId STRINGS or left empty. That drift shipped:
// cast relay groups wrote string rosters and matrix relay groups wrote [], so
// the inbox labeled them with the raw pool number and the group Members panel
// rendered empty (found via conv-cast-toured-yes-relay).
//
// Two invariants, across every pure seed builder (lean SEED, castItems,
// matrixItems; live.ts already writes objects and is exercised by e2e):
//   1. every participants entry is an object resolving to a seeded contact
//      (contactId exists; phone is that contact's phone);
//   2. every relay_group roster is COMPLETE: >= 2 members, each carrying the
//      display name the inbox label + sender attribution need.
import { describe, it, expect } from 'vitest';
import { SEED } from '../src/lib/seed/lean.js';
import { castItems } from '../src/lib/seed/cast.js';
import { matrixItems } from '../src/lib/seed/matrix.js';

// matrixItems is now-relative; any fixed instant makes it deterministic.
const FIXED_NOW = new Date('2026-07-01T12:00:00.000Z');
const E164 = /^\+1\d{10}$/;

type Row = Record<string, unknown>;

const PROFILES: Record<string, Record<string, Row[]>> = {
  lean: SEED,
  cast: castItems(),
  matrix: matrixItems(FIXED_NOW),
};

/** Real conversation rows only — phone# claim rows are key-only pointers. */
function conversationRowsOf(tables: Record<string, Row[]>): Row[] {
  return (tables['conversations'] ?? []).filter(
    (r) => typeof r['conversationId'] === 'string' && !(r['conversationId'] as string).startsWith('phone#'),
  );
}

// One combined contact map: matrix (and cast) rosters may reference the lean
// anchor landlord (contact-landlord-0001) — profiles compose additively in
// seedAll, so cross-profile references are legal.
const contactsById = new Map<string, Row>();
for (const tables of Object.values(PROFILES)) {
  for (const c of tables['contacts'] ?? []) {
    const id = c['contactId'];
    if (typeof id === 'string' && !id.startsWith('phoneref#')) contactsById.set(id, c);
  }
}

function fullNameOf(contact: Row): string {
  return [contact['firstName'], contact['lastName']]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' ');
}

describe('seed roster shape (participants contract)', () => {
  it('every participants entry is a {contactId, phone} object resolving to a seeded contact', () => {
    for (const [profile, tables] of Object.entries(PROFILES)) {
      for (const conv of conversationRowsOf(tables)) {
        const roster = conv['participants'];
        if (roster === undefined) continue;
        const where = `${profile}:${String(conv['conversationId'])}`;
        expect(Array.isArray(roster), `${where} participants must be an array`).toBe(true);
        for (const member of roster as unknown[]) {
          expect(
            typeof member === 'object' && member !== null,
            `${where} roster entry must be a ConversationParticipant object, got ${JSON.stringify(member)}`,
          ).toBe(true);
          const m = member as Row;
          expect(typeof m['contactId'], `${where} entry needs a contactId`).toBe('string');
          expect(String(m['phone']), `${where} entry needs an E.164 phone`).toMatch(E164);
          const contact = contactsById.get(m['contactId'] as string);
          expect(contact, `${where} roster contactId ${String(m['contactId'])} is not a seeded contact`).toBeDefined();
          expect(m['phone'], `${where} roster phone must match the seeded contact's phone`).toBe(
            contact?.['phone'],
          );
        }
      }
    }
  });

  it('every relay_group roster is complete: >= 2 members, each named for the inbox label', () => {
    for (const [profile, tables] of Object.entries(PROFILES)) {
      for (const conv of conversationRowsOf(tables)) {
        if (conv['type'] !== 'relay_group') continue;
        const where = `${profile}:${String(conv['conversationId'])}`;
        const roster = (conv['participants'] ?? []) as unknown[];
        expect(
          roster.length,
          `${where} relay roster must include every member (tenant + landlord at minimum)`,
        ).toBeGreaterThanOrEqual(2);
        for (const member of roster) {
          const m = member as Row;
          const name = m['name'];
          expect(
            typeof name === 'string' && name.trim().length > 0,
            `${where} relay member ${JSON.stringify(member)} needs a display name`,
          ).toBe(true);
          const contact = contactsById.get(String(m['contactId']));
          expect(
            name,
            `${where} relay member name must match the seeded contact (no drift)`,
          ).toBe(contact ? fullNameOf(contact) : undefined);
        }
      }
    }
  });
});
