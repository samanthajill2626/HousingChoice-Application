// Guards the SEED field names against the app's read paths. The repos are
// flexible documents (they store ANY key), so a mis-named field like
// `first_name` / `bedrooms` / `pets_allowed` is persisted without error but
// then NEVER read — the dashboard + server + audience targeting all read the
// canonical names, so a mis-named seed record silently renders blank (a
// contact as its phone number, a unit with no beds/rent, an un-shareable
// listing). This is the bug class fixed 2026-06-15; this test is its tripwire.
import { describe, expect, it } from 'vitest';
import { SEED } from '../src/lib/seedData.js';
import { UNIT_STATUSES } from '../src/repos/unitsRepo.js';

const contacts = SEED['contacts'] ?? [];
const units = SEED['units'] ?? [];
const auditEvents = SEED['audit_events'] ?? [];

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

  it('every seed unit uses the canonical field names the app reads', () => {
    expect(units.length).toBeGreaterThanOrEqual(1);
    for (const u of units) {
      // The orphan field names a flexible-doc Put would store + the UI ignore.
      expect(u).not.toHaveProperty('bedrooms'); // canonical: beds
      expect(u).not.toHaveProperty('rent'); // canonical: rent_min / rent_max
      expect(u).not.toHaveProperty('pets_allowed'); // canonical: pets
      // beds drives the flyer voucher_size + broadcast bedroom targeting.
      expect(typeof u['beds']).toBe('number');
      // Rent is a range everywhere it's read (Flyer / Units / UnitDetail).
      expect(typeof u['rent_min']).toBe('number');
      expect(typeof u['rent_max']).toBe('number');
    }
  });

  it('every seed unit status is a real UNIT_STATUSES value (byStatus GSI + flyer gate)', () => {
    for (const u of units) {
      expect(UNIT_STATUSES as readonly string[]).toContain(u['status']);
    }
  });

  it('seed audit events use the auditRepo shape (event_type + payload, not action/detail)', () => {
    expect(auditEvents.length).toBeGreaterThanOrEqual(1);
    for (const e of auditEvents) {
      expect(e).not.toHaveProperty('action'); // canonical: event_type
      expect(e).not.toHaveProperty('detail'); // canonical: payload
      expect(typeof e['event_type']).toBe('string');
      expect(typeof e['payload']).toBe('object');
    }
  });
});
