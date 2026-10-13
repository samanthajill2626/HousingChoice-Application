import { describe, expect, it } from 'vitest';
import { resolveTourContactNames } from '../src/lib/tourContacts.js';
import { composeTourReminderBody } from '../src/messages/tourCopy.js';
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
const DANA = contact({ contactId: 'c-pm', firstName: 'Dana', lastName: 'Ortiz' });
const LEE = contact({ contactId: 'c-ll', firstName: 'Lee', lastName: 'Park' });
const DELETED_AT = '2026-10-01T00:00:00.000Z';
/** 2026-09-08 15:00 New York - any parseable instant composes the en-route rung. */
const TOUR_AT = '2026-09-08T19:00:00.000Z';

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
      contactsRepo: repoOf({ 'c-t': TENANT, 'c-pm': DANA }, calls),
    });
    expect(r).toEqual({
      names: {
        tenantFirstName: 'Alice', tenantName: 'Alice Rivera',
        propertyContactFirstName: 'Dana', propertyContactName: 'Dana Ortiz',
      },
      tenantReadFailed: false,
      propertyReadFailed: false,
      propertyContact: { kind: 'found', contactId: 'c-pm', contact: DANA },
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

  it('the tenant being their own property contact is NO property contact, never a self-named body', async () => {
    // The de-dupe rosterResolution.ts:279-281 carries one line below the rule
    // spec 6.1 says to reuse. Without it, a unit whose landlordId is the tour's
    // own tenant composes "Hey Alice, Alice will be headed that way shortly."
    // and texts it to Alice. Absence is the right answer: idFor() then degrades
    // the rung to the self-guided entry (spec 6.3).
    const calls: string[] = [];
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({ unitId: 'u1', landlordId: 'c-t' }),
      contactsRepo: repoOf({ 'c-t': TENANT }, calls),
    });
    expect(r.names.tenantFirstName).toBe('Alice');
    expect(r.names.propertyContactFirstName).toBeUndefined();
    expect(r.names.propertyContactName).toBeUndefined();
    expect(r.propertyReadFailed).toBe(false);
    // Read ONCE, for the tenant - not a second time under the property role.
    expect(calls).toEqual(['c-t']);
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

  // primary-contact-integrity spec 4.1: the property contact comes from the ONE
  // shared lookup (lib/propertyContact.ts), which SKIPS a soft-deleted or
  // missing contact. Before it, a deleted primary was named in every reminder.
  it('a DELETED primary is skipped: the names and the en-route body come from the landlord of record', async () => {
    const calls: string[] = [];
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({
        unitId: 'u1',
        landlordId: 'c-ll',
        contacts: [
          { contactId: 'c-ll', role: 'landlord', primaryContact: false },
          { contactId: 'c-pm', role: 'pm', primaryContact: true },
        ],
      }),
      contactsRepo: repoOf(
        {
          'c-t': TENANT,
          'c-pm': contact({ contactId: 'c-pm', firstName: 'Dana', lastName: 'Ortiz', deleted_at: DELETED_AT }),
          'c-ll': LEE,
        },
        calls,
      ),
    });
    expect(r.names.propertyContactFirstName).toBe('Lee');
    expect(r.names.propertyContactName).toBe('Lee Park');
    expect(r.propertyReadFailed).toBe(false);
    expect(r.propertyContact).toEqual({ kind: 'found', contactId: 'c-ll', contact: LEE });
    // Lazy: the landlord of record is read only because the primary was skipped.
    expect(calls).toEqual(['c-t', 'c-pm', 'c-ll']);
    const body = composeTourReminderBody({
      kind: 'en_route',
      scheduledAt: TOUR_AT,
      timezone: 'America/New_York',
      tourType: 'landlord_led',
      names: r.names,
    });
    expect(body).toBe(
      "Hey Alice, Lee will be headed that way shortly. Can you please text here when you're on the way?",
    );
  });

  it('a deleted SOLE primary with no landlord of record is NO property contact (reason deleted)', async () => {
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({
        unitId: 'u1',
        contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: true }],
      }),
      contactsRepo: repoOf(
        { 'c-t': TENANT, 'c-pm': contact({ contactId: 'c-pm', firstName: 'Dana', deleted_at: DELETED_AT }) },
        [],
      ),
    });
    expect(r.names.propertyContactFirstName).toBeUndefined();
    expect(r.names.propertyContactName).toBeUndefined();
    expect(r.propertyReadFailed).toBe(false);
    expect(r.propertyContact).toEqual({ kind: 'nobody', reason: 'deleted' });
    // No name can back "will be headed that way": the rung degrades to the
    // self-guided entry (spec 6.3) and never names the deleted contact.
    expect(
      composeTourReminderBody({
        kind: 'en_route',
        scheduledAt: TOUR_AT,
        timezone: 'America/New_York',
        tourType: 'landlord_led',
        names: r.names,
      }),
    ).toBe("Hey Alice, can you please text me when you're on the way?");
  });

  it('a primary with NO record (an import retract hard-deletes) falls through to the landlord like a deleted one', async () => {
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({
        unitId: 'u1',
        landlordId: 'c-ll',
        contacts: [
          { contactId: 'c-ll', role: 'landlord', primaryContact: false },
          { contactId: 'c-gone', role: 'pm', primaryContact: true },
        ],
      }),
      contactsRepo: repoOf({ 'c-t': TENANT, 'c-ll': LEE }, []),
    });
    expect(r.names.propertyContactFirstName).toBe('Lee');
    expect(r.propertyContact).toEqual({ kind: 'found', contactId: 'c-ll', contact: LEE });
  });

  it('exposes the shared lookup answer for every outcome - and none at all without a unit', async () => {
    const none = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({ unitId: 'u1', landlordId: '', contacts: [] }),
      contactsRepo: repoOf({ 'c-t': TENANT }, []),
    });
    expect(none.propertyContact).toEqual({ kind: 'nobody', reason: 'none' });

    const self = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({ unitId: 'u1', landlordId: 'c-t' }),
      contactsRepo: repoOf({ 'c-t': TENANT }, []),
    });
    expect(self.propertyContact).toEqual({ kind: 'nobody', reason: 'is_tenant' });

    const failed = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({ unitId: 'u1', landlordId: 'c-boom' }),
      contactsRepo: {
        async getById(id: string) {
          if (id === 'c-boom') throw new Error('repo down');
          return TENANT;
        },
      },
    });
    expect(failed.propertyContact).toEqual({ kind: 'read_failed', candidateId: 'c-boom' });
    expect(failed.propertyReadFailed).toBe(true);

    const noUnit = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: undefined,
      contactsRepo: repoOf({ 'c-t': TENANT }, []),
    });
    expect('propertyContact' in noUnit).toBe(false);
  });
});
