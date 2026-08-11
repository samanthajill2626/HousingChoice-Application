// Group-text member stubs (group-texting T3.4 / adjudications A7 + A8).
//
// The whole point of this module is what it does NOT write. `captureContact`
// stamps `consent_method: 'inbound_text'` on every stub it mints, which flows
// through the single hasSmsConsent predicate into SIX consumers and would make
// a SILENT group member proactively sendable - the exact opposite of Cameron's
// ruling. Detection therefore mints its own stubs, records the basis in the
// DISTINCT field `group_participation_at`, and never touches consent_method.
import { describe, expect, it, vi } from 'vitest';

import { contactIdForPhone } from '../src/lib/import/ids.js';
import {
  GROUP_DETECTION_ORIGIN,
  resolveGroupMembers,
} from '../src/services/groupMembers.js';
import type { ContactItem, ContactsRepo } from '../src/repos/contactsRepo.js';
import { hasSmsConsent } from '../src/lib/smsCompliance.js';

const AT = '2026-08-10T12:00:00.000Z';
const A = '+15550100002';
const B = '+15550100003';

interface FakeContacts {
  repo: Pick<ContactsRepo, 'findByPhone' | 'getById' | 'createIfAbsent' | 'stampGroupParticipation'>;
  rows: Map<string, ContactItem>;
  creates: ContactItem[];
  stamps: { contactId: string; at: string }[];
}

function fakeContacts(seed: ContactItem[] = []): FakeContacts {
  const rows = new Map<string, ContactItem>(seed.map((c) => [c.contactId, c]));
  const creates: ContactItem[] = [];
  const stamps: { contactId: string; at: string }[] = [];
  const repo: FakeContacts['repo'] = {
    async findByPhone(phone) {
      return [...rows.values()].find((c) => c.phone === phone);
    },
    async getById(contactId) {
      return rows.get(contactId);
    },
    async createIfAbsent(item) {
      if (rows.has(item.contactId)) return false;
      rows.set(item.contactId, item);
      creates.push(item);
      return true;
    },
    async stampGroupParticipation(contactId, at) {
      const row = rows.get(contactId);
      if (!row) return 'missing';
      if (typeof row.group_participation_at === 'string') return 'already';
      row.group_participation_at = at;
      stamps.push({ contactId, at });
      return 'stamped';
    },
  };
  return { repo, rows, creates, stamps };
}

function contact(over: Partial<ContactItem> & { contactId: string }): ContactItem {
  return { type: 'unknown', ...over } as ContactItem;
}

describe('resolveGroupMembers (T3.4)', () => {
  it('mints a stub per unknown member under the IMPORTER id scheme', async () => {
    const f = fakeContacts();
    const out = await resolveGroupMembers([A, B], { contactsRepo: f.repo }, { at: AT });

    expect(out.members.map((m) => m.contactId)).toEqual([contactIdForPhone(A), contactIdForPhone(B)]);
    expect(out.members.map((m) => m.phone)).toEqual([A, B]);
    expect(out.created).toEqual([contactIdForPhone(A), contactIdForPhone(B)]);
  });

  it('NEVER writes consent_method on a minted stub (A7 - the whole ruling)', async () => {
    const f = fakeContacts();
    await resolveGroupMembers([A], { contactsRepo: f.repo }, { at: AT });

    const stub = f.creates[0]!;
    expect(stub.consent_method).toBeUndefined();
    expect(stub.consent_at).toBeUndefined();
    expect(hasSmsConsent(stub)).toBe(false);
  });

  it('records the basis in the DISTINCT field group_participation_at', async () => {
    const f = fakeContacts();
    await resolveGroupMembers([A], { contactsRepo: f.repo }, { at: AT });
    expect(f.creates[0]!.group_participation_at).toBe(AT);
  });

  it('carries the origin marker the import retract guard refuses to delete through', async () => {
    const f = fakeContacts();
    await resolveGroupMembers([A], { contactsRepo: f.repo }, { at: AT });
    expect(f.creates[0]!.origin).toBe(GROUP_DETECTION_ORIGIN);
    expect(GROUP_DETECTION_ORIGIN).toBe('group_detection');
  });

  it('mints the stub as unknown / needs_review - detection never guesses identity', async () => {
    const f = fakeContacts();
    await resolveGroupMembers([A], { contactsRepo: f.repo }, { at: AT });
    expect(f.creates[0]).toMatchObject({ type: 'unknown', status: 'needs_review', phone: A });
  });

  it('ADOPTS an existing contact instead of minting a duplicate under the derived id', async () => {
    const existing = contact({ contactId: 'hand-made-id', phone: A, firstName: 'Dana', lastName: 'Reed' });
    const f = fakeContacts([existing]);

    const out = await resolveGroupMembers([A], { contactsRepo: f.repo }, { at: AT });

    expect(out.created).toEqual([]);
    expect(out.members[0]).toEqual({ contactId: 'hand-made-id', phone: A, name: 'Dana Reed' });
  });

  it('stamps an EXISTING contact that carries no basis yet, and leaves consent_method alone', async () => {
    const existing = contact({ contactId: 'c1', phone: A, consent_method: 'web_form' });
    const f = fakeContacts([existing]);

    const out = await resolveGroupMembers([A], { contactsRepo: f.repo }, { at: AT });

    expect(out.stamped).toEqual(['c1']);
    expect(f.rows.get('c1')!.group_participation_at).toBe(AT);
    expect(f.rows.get('c1')!.consent_method).toBe('web_form');
  });

  it('does not re-stamp a contact that already carries the basis', async () => {
    const existing = contact({ contactId: 'c1', phone: A, group_participation_at: '2026-01-01T00:00:00.000Z' });
    const f = fakeContacts([existing]);

    const out = await resolveGroupMembers([A], { contactsRepo: f.repo }, { at: AT });

    expect(out.stamped).toEqual([]);
    expect(f.rows.get('c1')!.group_participation_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('adopts the winner when a concurrent create takes the same derived id', async () => {
    const f = fakeContacts();
    const derived = contactIdForPhone(A);
    const original = f.repo.createIfAbsent.bind(f.repo);
    f.repo.createIfAbsent = async (item) => {
      // Somebody else got there first between findByPhone and the create.
      if (!f.rows.has(item.contactId)) {
        f.rows.set(item.contactId, contact({ contactId: derived, phone: A, firstName: 'Race' }));
      }
      return original(item);
    };

    const out = await resolveGroupMembers([A], { contactsRepo: f.repo }, { at: AT });

    expect(out.created).toEqual([]);
    expect(out.members[0]).toMatchObject({ contactId: derived, name: 'Race' });
  });

  it('keeps the member on the roster when its contact write FAILS - never drops a party', async () => {
    const f = fakeContacts();
    f.repo.createIfAbsent = async () => {
      throw new Error('dynamo down');
    };
    const warn = vi.fn();

    const out = await resolveGroupMembers(
      [A, B],
      { contactsRepo: f.repo, logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never },
      { at: AT },
    );

    expect(out.members.map((m) => m.phone)).toEqual([A, B]);
    expect(out.members.map((m) => m.contactId)).toEqual([contactIdForPhone(A), contactIdForPhone(B)]);
    expect(out.failed).toEqual([A, B]);
  });

  it('never logs a phone number (doc 9)', async () => {
    const f = fakeContacts();
    const lines: unknown[] = [];
    const rec = (fields: unknown, msg: unknown): void => {
      lines.push(fields, msg);
    };
    await resolveGroupMembers(
      [A, B],
      { contactsRepo: f.repo, logger: { warn: rec, error: rec, info: rec, debug: rec } as never },
      { at: AT },
    );
    expect(JSON.stringify(lines)).not.toContain('5550100002');
  });
});
