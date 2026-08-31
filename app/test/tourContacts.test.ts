import { describe, expect, it } from 'vitest';
import { resolveTourContactNames } from '../src/lib/tourContacts.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';

const contact = (o: Record<string, unknown>): ContactItem => o as unknown as ContactItem;
const unit = (o: Record<string, unknown>): UnitItem => o as unknown as UnitItem;

function repoOf(byId: Record<string, ContactItem | undefined>, calls: string[]) {
  return {
    async getById(id: string): Promise<ContactItem | undefined> {
      calls.push(id);
      return byId[id];
    },
  };
}

const TENANT = contact({ contactId: 'c-t', firstName: 'Alice', lastName: 'Rivera' });

describe('resolveTourContactNames', () => {
  it('resolves the roster PRIMARY and the tenant, first and full names', async () => {
    const calls: string[] = [];
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({
        unitId: 'u1',
        landlordId: 'c-ll',
        contacts: [
          { contactId: 'c-ll', role: 'landlord', primaryContact: false },
          { contactId: 'c-pm', role: 'pm', primaryContact: true, name: 'Stale Cached' },
        ],
      }),
      contactsRepo: repoOf({ 'c-t': TENANT, 'c-pm': contact({ contactId: 'c-pm', firstName: 'Dana', lastName: 'Ortiz' }) }, calls),
    });
    expect(r).toEqual({
      names: {
        tenantFirstName: 'Alice', tenantName: 'Alice Rivera',
        propertyContactFirstName: 'Dana', propertyContactName: 'Dana Ortiz',
      },
      tenantReadFailed: false,
      propertyReadFailed: false,
    });
    // LIVE read, not the roster's denormalized name.
    expect(calls).toContain('c-pm');
  });

  it('a ZERO-PRIMARY roster falls back to the landlord of record', async () => {
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({
        unitId: 'u1', landlordId: 'c-ll',
        contacts: [{ contactId: 'c-x', role: 'pm', primaryContact: false }],
      }),
      contactsRepo: repoOf({ 'c-t': TENANT, 'c-ll': contact({ contactId: 'c-ll', firstName: 'Lee' }) }, []),
    });
    expect(r.names.propertyContactFirstName).toBe('Lee');
    expect(r.propertyReadFailed).toBe(false);
  });

  it('NO roster at all resolves the landlord via the synthesized primary', async () => {
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({ unitId: 'u1', landlordId: 'c-ll' }),
      contactsRepo: repoOf({ 'c-t': TENANT, 'c-ll': contact({ contactId: 'c-ll', firstName: 'Lee', lastName: 'Park' }) }, []),
    });
    expect(r.names.propertyContactName).toBe('Lee Park');
  });

  it('an EMPTY-STRING landlordId is "no property contact" - getById is never called with it', async () => {
    const calls: string[] = [];
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({ unitId: 'u1', landlordId: '', contacts: [] }),
      contactsRepo: repoOf({ 'c-t': TENANT }, calls),
    });
    expect(r.names.propertyContactFirstName).toBeUndefined();
    expect(r.propertyReadFailed).toBe(false);
    expect(calls).not.toContain('');
  });

  it('a NAMELESS contact is ABSENCE: undefined fields, no failure flags, no surname fallback', async () => {
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: undefined,
      contactsRepo: repoOf({ 'c-t': contact({ contactId: 'c-t', lastName: 'Chen' }) }, []),
    });
    expect(r.names.tenantFirstName).toBeUndefined();
    expect(r.names.tenantName).toBe('Chen'); // full-name join still has a surname
    expect(r.tenantReadFailed).toBe(false);
    expect(r.propertyReadFailed).toBe(false);
  });

  it('a THROWING property read sets ONLY propertyReadFailed, never throws out, partial names kept', async () => {
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({ unitId: 'u1', landlordId: 'c-boom' }),
      contactsRepo: {
        async getById(id: string) {
          if (id === 'c-boom') throw new Error('repo down');
          return TENANT;
        },
      },
    });
    expect(r.propertyReadFailed).toBe(true);
    expect(r.tenantReadFailed).toBe(false);
    expect(r.names.tenantFirstName).toBe('Alice');
    expect(r.names.propertyContactFirstName).toBeUndefined();
  });

  it('a THROWING tenant read sets ONLY tenantReadFailed', async () => {
    const r = await resolveTourContactNames({
      tenantId: 'c-boom',
      unit: unit({ unitId: 'u1', landlordId: 'c-ll' }),
      contactsRepo: {
        async getById(id: string) {
          if (id === 'c-boom') throw new Error('repo down');
          return contact({ contactId: 'c-ll', firstName: 'Lee' });
        },
      },
    });
    expect(r.tenantReadFailed).toBe(true);
    expect(r.propertyReadFailed).toBe(false);
    expect(r.names.propertyContactFirstName).toBe('Lee');
  });

  it('BRACES are stripped: a name of "{where}" comes back inert, so no token can re-open', async () => {
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({ unitId: 'u1', landlordId: 'c-ll' }),
      contactsRepo: repoOf(
        {
          'c-t': contact({ contactId: 'c-t', firstName: '{where}', lastName: '{addressLine}' }),
          'c-ll': contact({ contactId: 'c-ll', firstName: '{propertyContactName}' }),
        },
        [],
      ),
    });
    expect(r.names.tenantFirstName).toBe('where');
    expect(r.names.tenantName).toBe('where addressLine');
    expect(r.names.propertyContactFirstName).toBe('propertyContactName');
    // Nothing handed to interpolate() carries a brace, so the sequential
    // substitution in messages/resolve.ts has nothing left to re-expand.
    expect(Object.values(r.names).join(' ')).not.toMatch(/[{}]/);
  });

  it('a name that is NOTHING but braces reads as absence, not an empty name', async () => {
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: undefined,
      contactsRepo: repoOf({ 'c-t': contact({ contactId: 'c-t', firstName: '{ }' }) }, []),
    });
    expect(r.names.tenantFirstName).toBeUndefined();
    expect(r.names.tenantName).toBeUndefined();
    expect(r.tenantReadFailed).toBe(false);
  });

  it('a supplied tenantContact skips the tenant read', async () => {
    const calls: string[] = [];
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: undefined,
      tenantContact: TENANT,
      contactsRepo: repoOf({}, calls),
    });
    expect(r.names.tenantFirstName).toBe('Alice');
    expect(calls).toEqual([]);
  });
});
