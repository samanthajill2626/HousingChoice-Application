// services/orgRecords.ts (spec D3, D10, D11; plan 3.4, 3.4b): uses, "Not on
// the list", holders and (Task 3.5) the per-field rewrite pass - over the
// harness world fakes, so the reads page exactly as the route and the job
// will. TRAP (planner rulings, R1): the harness units.list fake ignores the
// cursor and caps at 50 - every case here keeps its units under 50.
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { createOrgRecordsService } from '../src/services/orgRecords.js';
import { ATLANTA, AUGUSTA, DCA, ORG_FIXTURE, STEP_UP, VASH, orgRef, quietLogger } from './helpers/orgFixtures.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

const DELETED_AT = '2026-10-01T00:00:00.000Z';

function contact(contactId: string, extra: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'tenant', status: 'searching', ...extra };
}

function unit(unitId: string, extra: Partial<UnitItem> = {}): UnitItem {
  return { unitId, landlordId: 'l-1', status: 'available', ...extra };
}

function setup(seed: { contacts?: ContactItem[]; units?: UnitItem[] } = {}) {
  const world = createFakeWorld();
  world.contacts.push(...(seed.contacts ?? []));
  for (const u of seed.units ?? []) world.units.set(u.unitId, u);
  const records = createOrgRecordsService({
    contactsRepo: world.contactsRepo,
    unitsRepo: world.unitsRepo,
    auditRepo: world.auditRepo,
    logger: quietLogger(),
  });
  return { world, records };
}

describe('OrgRecordsService.usage (spec D3, D10)', () => {
  it('counts the exact name in a field of the entry kind - active per column, deleted beside them', async () => {
    const { records } = setup({
      contacts: [
        contact('t-1', { housingAuthority: ATLANTA.name }),
        contact('t-2', { housingAuthority: 'AHA' }), // a spelling is not a use
        contact('t-3', { housingAuthority: ATLANTA.name, deleted_at: DELETED_AT }),
        contact('l-1', { type: 'landlord', status: 'active', housingAuthority: ATLANTA.name }),
        contact('p-1', { type: 'partner', status: 'active', agency: STEP_UP.name }),
        contact('t-4', { agency: ATLANTA.name }), // an authority in the agency field: not a use
        contact('t-5', { housingAuthority: STEP_UP.name }), // an agency in the authority field: not a use
      ],
      units: [
        unit('u-1', { accepted_authorities: [ATLANTA.name, 'DCA'] }),
        unit('u-2', { accepted_authorities: [DCA.name], deleted_at: DELETED_AT }),
        unit('u-3', { accepted_authorities: [ATLANTA.name, ATLANTA.name] }), // one property, one use
        unit('u-4', { jurisdiction: ATLANTA.name }), // no STORED list: not a use
      ],
    });
    expect(await records.usage(ORG_FIXTURE)).toEqual({
      'org-atl': { tenants: 1, otherContacts: 1, properties: 2, deleted: 1 },
      'org-aug': { tenants: 0, otherContacts: 0, properties: 0, deleted: 0 },
      'org-dca': { tenants: 0, otherContacts: 0, properties: 0, deleted: 1 },
      'org-vash': { tenants: 0, otherContacts: 0, properties: 0, deleted: 0 },
      'org-stepup': { tenants: 0, otherContacts: 1, properties: 0, deleted: 0 },
    });
  });

  it('follows the listByType cursor past one page', async () => {
    const tenants = Array.from({ length: 60 }, (_, i) => contact(`t-${i}`, { housingAuthority: ATLANTA.name }));
    const { records } = setup({ contacts: tenants });
    expect((await records.usage(ORG_FIXTURE))['org-atl']?.tenants).toBe(60);
  });
});

describe('OrgRecordsService.notOnList (spec D10)', () => {
  it('lists every off-list value per field with active and deleted counts and its D4 resolution', async () => {
    const { records } = setup({
      contacts: [
        contact('t-1', { housingAuthority: 'AHA' }),
        contact('t-2', { housingAuthority: 'AHA' }),
        contact('t-3', { housingAuthority: 'AHA', deleted_at: DELETED_AT }),
        contact('t-4', { housingAuthority: ATLANTA.name }), // on the list: no row
        contact('t-5', { housingAuthority: 'HUD VASH' }),
        contact('t-6', { housingAuthority: 'DCA HUD-VASH' }),
        contact('t-7', { housingAuthority: 'Nowhere Housing' }),
        contact('t-8', { agency: ATLANTA.name }),
        contact('t-9', { agency: '' }), // a cleared agency is not a value
        contact('t-10', { housingAuthority: '  ' }), // whitespace only (pre-trim data): blank, not a value
        contact('p-1', { type: 'partner', status: 'active', agency: 'Nobody Org' }),
      ],
      units: [
        unit('u-1', { accepted_authorities: ['DCA', DCA.name, 'DCA'] }),
        unit('u-2', { accepted_authorities: ['DCA'], deleted_at: DELETED_AT }),
      ],
    });
    expect(await records.notOnList(ORG_FIXTURE)).toEqual([
      {
        field: 'housingAuthority',
        value: 'AHA',
        count: 2,
        deletedCount: 1,
        resolution: { status: 'ambiguous', candidates: [orgRef(ATLANTA), orgRef(AUGUSTA)] },
      },
      {
        field: 'housingAuthority',
        value: 'DCA HUD-VASH',
        count: 1,
        deletedCount: 0,
        resolution: { status: 'compound', compound: [[orgRef(DCA)], [orgRef(VASH)]] },
      },
      {
        field: 'housingAuthority',
        value: 'HUD VASH',
        count: 1,
        deletedCount: 0,
        resolution: { status: 'other_kind', otherKind: [orgRef(VASH)] },
      },
      {
        field: 'housingAuthority',
        value: 'Nowhere Housing',
        count: 1,
        deletedCount: 0,
        resolution: { status: 'unknown', close: [] },
      },
      {
        field: 'agency',
        value: ATLANTA.name,
        count: 1,
        deletedCount: 0,
        resolution: { status: 'other_kind', otherKind: [orgRef(ATLANTA)] },
      },
      {
        field: 'agency',
        value: 'Nobody Org',
        count: 1,
        deletedCount: 0,
        resolution: { status: 'unknown', close: [] },
      },
      {
        field: 'accepted_authorities',
        value: 'DCA',
        count: 1,
        deletedCount: 1,
        resolution: { status: 'match', match: orgRef(DCA) },
      },
    ]);
  });
});

describe('OrgRecordsService.holders (spec D10 "Show records")', () => {
  it('returns the records holding one EXACT value: contacts by name, type and deleted; properties by address', async () => {
    const { records } = setup({
      contacts: [
        contact('t-1', { firstName: 'Tia', lastName: 'One', housingAuthority: 'AHA' }),
        contact('t-2', { housingAuthority: 'AHA', deleted_at: DELETED_AT }),
        contact('t-3', { housingAuthority: 'aha' }), // another stored value: another row
      ],
      units: [
        unit('u-1', {
          accepted_authorities: ['DCA'],
          address: { line1: '1 Main St', city: 'Atlanta', state: 'GA', zip: '30303' },
        }),
        unit('u-2', { accepted_authorities: ['Georgia DCA'] }),
      ],
    });
    expect(await records.holders('housingAuthority', 'AHA')).toEqual([
      { kind: 'contact', contactId: 't-1', name: 'Tia One', type: 'tenant', deleted: false },
      { kind: 'contact', contactId: 't-2', name: null, type: 'tenant', deleted: true },
    ]);
    expect(await records.holders('accepted_authorities', 'DCA')).toEqual([
      { kind: 'unit', unitId: 'u-1', address: '1 Main St, Atlanta, GA 30303', deleted: false },
    ]);
  });
});
