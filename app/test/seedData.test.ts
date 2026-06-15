// Guards the SEED field CASING against the app's read paths. The repos are
// flexible documents (they store ANY key), so a snake_case name like
// `first_name` is persisted without error but then NEVER read — the dashboard
// (contactFullName) + server (displayNameOf) + audience targeting
// (audienceResolution.voucherSizeOf) all read camelCase, so a mis-cased seed
// contact silently renders as its phone number and drops out of bedroom-size
// broadcasts. This is the bug fixed 2026-06-15; this test is its tripwire.
import { describe, expect, it } from 'vitest';
import { SEED } from '../src/lib/seedData.js';

const contacts = SEED['contacts'] ?? [];

describe('seed data field casing', () => {
  it('seeds at least the canonical tenant + landlord contacts', () => {
    expect(contacts.length).toBeGreaterThanOrEqual(2);
  });

  it('every named seed contact uses camelCase firstName/lastName (never snake_case)', () => {
    for (const c of contacts) {
      // The flexible-doc snake_case variants would be silently stored + ignored.
      expect(c).not.toHaveProperty('first_name');
      expect(c).not.toHaveProperty('last_name');
      // Each seed contact carries a real name in the fields the readers use, so
      // it renders as a person rather than falling back to its phone number.
      expect(typeof c['firstName']).toBe('string');
      expect((c['firstName'] as string).length).toBeGreaterThan(0);
      expect(typeof c['lastName']).toBe('string');
      expect((c['lastName'] as string).length).toBeGreaterThan(0);
    }
  });

  it('the seed names join the way the readers display them ("First Last")', () => {
    // Both readers (server displayNameOf / dashboard contactFullName) join the
    // camelCase fields with a space; prove the seed feeds them a real name.
    const names = contacts.map((c) => `${c['firstName'] as string} ${c['lastName'] as string}`.trim());
    expect(names).toContain('Tasha Nguyen');
    expect(names).toContain('Marcus Bell');
  });

  it('tenant voucher size is the camelCase voucherSize audience targeting reads', () => {
    // audienceResolution.voucherSizeOf reads contact['voucherSize']; a seeded
    // `voucher_size` would silently drop the tenant from bedroom-size broadcasts.
    const tenant = contacts.find((c) => c['type'] === 'tenant');
    expect(tenant).toBeDefined();
    expect(tenant).not.toHaveProperty('voucher_size');
    expect(typeof tenant!['voucherSize']).toBe('number');
  });
});
