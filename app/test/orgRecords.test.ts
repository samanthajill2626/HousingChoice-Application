// services/orgRecords.ts (spec D3, D10, D11; plan 3.4, 3.4b): uses, "Not on
// the list", holders and (Task 3.5) the per-field rewrite pass - over the
// harness world fakes, so the reads page exactly as the route and the job
// will. TRAP (planner rulings, R1): the harness units.list fake ignores the
// cursor and caps at 50 - every case here keeps its units under 50.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import {
  createOrgRecordsService,
  OrgRewriteAbortedError,
  OrgRewriteLockLostError,
} from '../src/services/orgRecords.js';
import {
  ATLANTA,
  AUGUSTA,
  DCA,
  ORG_FIXTURE,
  STEP_UP,
  VASH,
  orgRef,
  quietLogger,
  runningRewrite,
} from './helpers/orgFixtures.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

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

describe('OrgRecordsService.rewrite - one conditional pass over one field (spec D11)', () => {
  const OPTS = { auditType: 'org_name_rewrite', actor: 'usr_admin' } as const;
  const ZERO = { housingAuthority: 0, agency: 0, accepted_authorities: 0, skipped: 0, conflicts: 0 };
  const NEW = 'Housing Authority of the City of Atlanta';
  const rewrites = (world: FakeWorld) => world.auditEvents.filter((e) => e.event_type === 'org_name_rewrite');
  const contactIn = (world: FakeWorld, id: string) => world.contacts.find((c) => c.contactId === id);

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rename, one pass per field: every holder of the old name - active, deleted, any case - gets the new name', async () => {
    const { world, records } = setup({
      contacts: [
        contact('t-1', { housingAuthority: ATLANTA.name }),
        contact('t-2', { housingAuthority: 'ATLANTA HOUSING AUTHORITY' }),
        contact('t-3', { housingAuthority: ATLANTA.name, deleted_at: DELETED_AT }),
        contact('t-4', { agency: ATLANTA.name }), // agency is not a field of the housing authority kind
        contact('t-5', { housingAuthority: 'AHA' }), // not a from-text
      ],
      units: [
        unit('u-1', { accepted_authorities: [ATLANTA.name, 'DCA'], updated_at: '2026-01-01T00:00:00.000Z' }),
        unit('u-2', { accepted_authorities: [NEW, ATLANTA.name] }),
        unit('u-3', { accepted_authorities: [ATLANTA.name], deleted_at: DELETED_AT }),
      ],
    });
    const def = runningRewrite({ action: 'rename', fromTexts: [ATLANTA.name], toName: NEW });
    expect(await records.rewrite({ ...def, field: 'housingAuthority' }, OPTS)).toEqual({ ...ZERO, housingAuthority: 3 });
    expect(await records.rewrite({ ...def, field: 'accepted_authorities' }, OPTS)).toEqual({
      ...ZERO,
      accepted_authorities: 3,
    });
    expect(['t-1', 't-2', 't-3', 't-5'].map((id) => contactIn(world, id)?.['housingAuthority'])).toEqual([
      NEW,
      NEW,
      NEW,
      'AHA',
    ]);
    expect(contactIn(world, 't-4')?.['agency']).toBe(ATLANTA.name);
    // Machine writes never stamp updated_at (the importer's ownership signal).
    expect(world.units.get('u-1')).toMatchObject({
      accepted_authorities: [NEW, 'DCA'],
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    expect(world.units.get('u-2')?.accepted_authorities).toEqual([NEW]); // de-duplicated
    expect(world.units.get('u-3')?.accepted_authorities).toEqual([NEW]);
    expect(rewrites(world)).toHaveLength(6);
    expect(rewrites(world)).toContainEqual({
      entityKey: 'contacts#t-2',
      event_type: 'org_name_rewrite',
      actorId: 'usr_admin',
      payload: { field: 'housingAuthority', from: 'ATLANTA HOUSING AUTHORITY', to: NEW, action: 'rename', actor: 'usr_admin' },
    });
    expect(rewrites(world)).toContainEqual({
      entityKey: 'units#u-1',
      event_type: 'org_name_rewrite',
      actorId: 'usr_admin',
      // A property's from/to are its WHOLE list before and after, joined (strings only).
      payload: {
        field: 'accepted_authorities',
        from: `${ATLANTA.name}, DCA`,
        to: `${NEW}, DCA`,
        action: 'rename',
        actor: 'usr_admin',
      },
    });
  });

  it('needs def.field: a rename as stored (no field) stops before any record is read', async () => {
    const { world, records } = setup({ contacts: [contact('t-1', { housingAuthority: ATLANTA.name })] });
    const err = await records
      .rewrite(runningRewrite({ action: 'rename', fromTexts: [ATLANTA.name], toName: NEW }), OPTS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgRewriteAbortedError);
    expect((err as OrgRewriteAbortedError).counts).toEqual(ZERO);
    expect(contactIn(world, 't-1')?.['housingAuthority']).toBe(ATLANTA.name);
  });

  it('use on a name variant rewrites the variant and leaves the exact name holders alone (no write, no audit)', async () => {
    const { world, records } = setup({
      contacts: [
        contact('t-1', { housingAuthority: 'atlanta housing authority' }),
        contact('t-2', { housingAuthority: ATLANTA.name }),
      ],
    });
    const def = runningRewrite({
      action: 'use',
      field: 'housingAuthority',
      fromTexts: ['atlanta housing authority'],
      toName: ATLANTA.name,
    });
    expect(await records.rewrite(def, OPTS)).toEqual({ ...ZERO, housingAuthority: 1 });
    expect(rewrites(world).map((e) => e.entityKey)).toEqual(['contacts#t-1']);
  });

  it('(PIN) use whose from-text IS the name (a padded stored name arrives trimmed) rewrites only the padded holders', async () => {
    const { world, records } = setup({
      contacts: [
        contact('t-1', { housingAuthority: `${ATLANTA.name} ` }),
        contact('t-2', { housingAuthority: ATLANTA.name }),
      ],
    });
    const def = runningRewrite({ action: 'use', field: 'housingAuthority', fromTexts: [ATLANTA.name], toName: ATLANTA.name });
    expect(await records.rewrite(def, OPTS)).toEqual({ ...ZERO, housingAuthority: 1 });
    expect(contactIn(world, 't-1')?.['housingAuthority']).toBe(ATLANTA.name);
    expect(rewrites(world).map((e) => e.entityKey)).toEqual(['contacts#t-1']);
  });

  it('use on the agency field; clear REMOVEs a housing authority, stores an empty agency, drops a list member', async () => {
    const { world, records } = setup({
      contacts: [
        contact('p-1', { type: 'partner', status: 'active', agency: 'Steps' }),
        contact('t-1', { housingAuthority: 'Junk HA' }),
        contact('t-2', { agency: 'Junk Agency' }),
      ],
      units: [
        unit('u-1', { accepted_authorities: ['Junk HA', DCA.name] }),
        unit('u-2', { accepted_authorities: ['Junk HA'] }),
      ],
    });
    const use = runningRewrite({ action: 'use', field: 'agency', fromTexts: ['Steps'], toName: STEP_UP.name });
    expect(await records.rewrite(use, OPTS)).toEqual({ ...ZERO, agency: 1 });
    expect(contactIn(world, 'p-1')?.['agency']).toBe(STEP_UP.name);
    await records.rewrite(runningRewrite({ action: 'clear', field: 'housingAuthority', fromTexts: ['Junk HA'] }), OPTS);
    await records.rewrite(runningRewrite({ action: 'clear', field: 'agency', fromTexts: ['Junk Agency'] }), OPTS);
    await records.rewrite(runningRewrite({ action: 'clear', field: 'accepted_authorities', fromTexts: ['Junk HA'] }), OPTS);
    expect(contactIn(world, 't-1')).not.toHaveProperty('housingAuthority'); // REMOVEd, never ''
    expect(contactIn(world, 't-2')?.['agency']).toBe('');
    expect(world.units.get('u-1')?.accepted_authorities).toEqual([DCA.name]);
    expect(world.units.get('u-2')?.accepted_authorities).toEqual([]);
    // A REMOVE is audited as to: '' - from and to are always strings.
    expect(rewrites(world).find((e) => e.entityKey === 'contacts#t-1')?.payload).toEqual({
      field: 'housingAuthority',
      from: 'Junk HA',
      to: '',
      action: 'clear',
      actor: 'usr_admin',
    });
    expect(rewrites(world).find((e) => e.entityKey === 'units#u-2')?.payload).toMatchObject({ from: 'Junk HA', to: '' });
  });

  it('move to agency: an absent or empty agency takes the name; the same agency only drops the authority; another agency is a conflict', async () => {
    const { world, records } = setup({
      contacts: [
        contact('c-1', { housingAuthority: 'HUD VASH' }),
        contact('c-2', { housingAuthority: 'HUD VASH', agency: '' }),
        contact('c-3', { housingAuthority: 'HUD VASH', agency: VASH.name }),
        contact('c-4', { housingAuthority: 'HUD VASH', agency: STEP_UP.name }),
      ],
    });
    const def = runningRewrite({
      action: 'move_to_agency',
      field: 'housingAuthority',
      fromTexts: ['HUD VASH'],
      toName: VASH.name,
    });
    expect(await records.rewrite(def, OPTS)).toEqual({ ...ZERO, housingAuthority: 3, conflicts: 1 });
    for (const id of ['c-1', 'c-2', 'c-3']) {
      expect(contactIn(world, id)).not.toHaveProperty('housingAuthority');
      expect(contactIn(world, id)?.['agency']).toBe(VASH.name);
    }
    expect(contactIn(world, 'c-4')).toMatchObject({ housingAuthority: 'HUD VASH', agency: STEP_UP.name });
    // One event per field written (plan 3.8): the authority REMOVEd (to: ''),
    // then the agency set - an absent agency audits as from: ''.
    const payloads = (id: string) => rewrites(world).filter((e) => e.entityKey === `contacts#${id}`).map((e) => e.payload);
    expect(payloads('c-1')).toEqual([
      { field: 'housingAuthority', from: 'HUD VASH', to: '', action: 'move_to_agency', actor: 'usr_admin' },
      { field: 'agency', from: '', to: VASH.name, action: 'move_to_agency', actor: 'usr_admin' },
    ]);
    // c-3 already held that agency: only its authority changed, so one event.
    expect(payloads('c-3')).toEqual([
      { field: 'housingAuthority', from: 'HUD VASH', to: '', action: 'move_to_agency', actor: 'usr_admin' },
    ]);
    expect(payloads('c-4')).toEqual([]);
  });

  it('move to housing authority: an absent authority takes the name and the agency is emptied; another authority is a conflict', async () => {
    const { world, records } = setup({
      contacts: [
        contact('c-1', { agency: 'DCA' }),
        contact('c-2', { agency: 'DCA', housingAuthority: DCA.name }),
        contact('c-3', { agency: 'DCA', housingAuthority: ATLANTA.name }),
      ],
    });
    const def = runningRewrite({
      action: 'move_to_housing_authority',
      field: 'agency',
      fromTexts: ['DCA'],
      toName: DCA.name,
    });
    expect(await records.rewrite(def, OPTS)).toEqual({ ...ZERO, agency: 2, conflicts: 1 });
    expect(contactIn(world, 'c-1')).toMatchObject({ housingAuthority: DCA.name, agency: '' });
    expect(contactIn(world, 'c-2')).toMatchObject({ housingAuthority: DCA.name, agency: '' });
    expect(contactIn(world, 'c-3')).toMatchObject({ housingAuthority: ATLANTA.name, agency: 'DCA' });
    // One event per field written: c-1 gained its authority, c-2 already held it.
    const payloads = (id: string) => rewrites(world).filter((e) => e.entityKey === `contacts#${id}`).map((e) => e.payload);
    expect(payloads('c-1')).toEqual([
      { field: 'agency', from: 'DCA', to: '', action: 'move_to_housing_authority', actor: 'usr_admin' },
      { field: 'housingAuthority', from: '', to: DCA.name, action: 'move_to_housing_authority', actor: 'usr_admin' },
    ]);
    expect(payloads('c-2')).toEqual([
      { field: 'agency', from: 'DCA', to: '', action: 'move_to_housing_authority', actor: 'usr_admin' },
    ]);
  });

  it('split: the authority is always set; the agency only where empty, else a conflict that keeps it', async () => {
    const { world, records } = setup({
      contacts: [
        contact('c-1', { housingAuthority: 'DCA HUD-VASH' }),
        contact('c-2', { housingAuthority: 'DCA HUD-VASH', agency: STEP_UP.name }),
        contact('c-3', { housingAuthority: 'DCA HUD-VASH', agency: VASH.name }),
      ],
    });
    const def = runningRewrite({
      action: 'split',
      field: 'housingAuthority',
      fromTexts: ['DCA HUD-VASH'],
      toName: DCA.name,
      agencyName: VASH.name,
    });
    expect(await records.rewrite(def, OPTS)).toEqual({ ...ZERO, housingAuthority: 3, conflicts: 1 });
    expect(contactIn(world, 'c-1')).toMatchObject({ housingAuthority: DCA.name, agency: VASH.name });
    expect(contactIn(world, 'c-2')).toMatchObject({ housingAuthority: DCA.name, agency: STEP_UP.name });
    expect(contactIn(world, 'c-3')).toMatchObject({ housingAuthority: DCA.name, agency: VASH.name });
    // One event per field written: only c-1's agency was set.
    const payloads = (id: string) => rewrites(world).filter((e) => e.entityKey === `contacts#${id}`).map((e) => e.payload);
    expect(payloads('c-1')).toEqual([
      { field: 'housingAuthority', from: 'DCA HUD-VASH', to: DCA.name, action: 'split', actor: 'usr_admin' },
      { field: 'agency', from: '', to: VASH.name, action: 'split', actor: 'usr_admin' },
    ]);
    expect(payloads('c-2').map((p) => p?.['field'])).toEqual(['housingAuthority']);
    expect(payloads('c-3').map((p) => p?.['field'])).toEqual(['housingAuthority']);
  });

  it('a value action on a from-text that normalizes to nothing matches that stored text, trimmed', async () => {
    const { world, records } = setup({
      contacts: [
        contact('t-1', { housingAuthority: '-' }),
        contact('t-2', { housingAuthority: '()' }), // also normalizes to '', but another stored value
        contact('t-3', { housingAuthority: ' - ' }), // padded legacy text; the request's '-' arrives trimmed
        contact('p-1', { type: 'partner', status: 'active', agency: '-' }),
      ],
    });
    const use = runningRewrite({ action: 'use', field: 'housingAuthority', fromTexts: ['-'], toName: ATLANTA.name });
    expect(await records.rewrite(use, OPTS)).toEqual({ ...ZERO, housingAuthority: 2 });
    expect(contactIn(world, 't-1')?.['housingAuthority']).toBe(ATLANTA.name);
    expect(contactIn(world, 't-3')?.['housingAuthority']).toBe(ATLANTA.name);
    expect(contactIn(world, 't-2')?.['housingAuthority']).toBe('()');
    await records.rewrite(runningRewrite({ action: 'clear', field: 'agency', fromTexts: ['-'] }), OPTS);
    expect(contactIn(world, 'p-1')?.['agency']).toBe('');
  });

  it('a record edited between the read and the write is skipped and left as the edit made it', async () => {
    const { world, records } = setup({
      contacts: [contact('t-1', { housingAuthority: 'AHA' }), contact('t-2', { housingAuthority: 'AHA' })],
    });
    const write = world.contactsRepo.rewriteOrgFields.bind(world.contactsRepo);
    world.contactsRepo.rewriteOrgFields = async (contactId, expected, next) => {
      const held = contactIn(world, contactId);
      if (contactId === 't-1' && held !== undefined) held['housingAuthority'] = 'Edited Meanwhile';
      return write(contactId, expected, next);
    };
    const def = runningRewrite({ action: 'use', field: 'housingAuthority', fromTexts: ['AHA'], toName: ATLANTA.name });
    expect(await records.rewrite(def, OPTS)).toEqual({ ...ZERO, housingAuthority: 1, skipped: 1 });
    expect(contactIn(world, 't-1')?.['housingAuthority']).toBe('Edited Meanwhile');
    expect(rewrites(world).map((e) => e.entityKey)).toEqual(['contacts#t-2']);
  });

  it('a read or write that throws stops the pass with the counts so far', async () => {
    const { world, records } = setup({
      contacts: [
        contact('t-1', { housingAuthority: 'AHA' }),
        contact('t-2', { housingAuthority: 'AHA', deleted_at: DELETED_AT }),
      ],
    });
    const list = world.contactsRepo.listByType.bind(world.contactsRepo);
    let pages = 0;
    world.contactsRepo.listByType = async (type, opts) => {
      pages += 1;
      if (pages === 2) throw new Error('ProvisionedThroughputExceededException');
      return list(type, opts);
    };
    const def = runningRewrite({ action: 'use', field: 'housingAuthority', fromTexts: ['AHA'], toName: ATLANTA.name });
    const err = await records.rewrite(def, OPTS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgRewriteAbortedError);
    expect((err as OrgRewriteAbortedError).counts).toEqual({ ...ZERO, housingAuthority: 1 });
    expect((err as OrgRewriteAbortedError).message).toContain('ProvisionedThroughputExceededException');
  });

  it('heartbeats at most every 20 seconds, and a failed heartbeat does not stop the pass', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T12:00:00.000Z'));
    const { world, records } = setup({
      contacts: [1, 2, 3, 4, 5, 6, 7].map((i) => contact(`p-${i}`, { type: 'partner', status: 'active', agency: 'Steps' })),
    });
    const write = world.contactsRepo.rewriteOrgFields.bind(world.contactsRepo);
    world.contactsRepo.rewriteOrgFields = async (contactId, expected, next) => {
      vi.setSystemTime(Date.now() + 7_000); // each write takes 7 s
      return write(contactId, expected, next);
    };
    const def = runningRewrite({ action: 'use', field: 'agency', fromTexts: ['Steps'], toName: STEP_UP.name });
    let beats = 0;
    const counts = await records.rewrite(def, {
      ...OPTS,
      heartbeat: async () => {
        beats += 1;
        throw new Error('org list busy');
      },
    });
    // 7 s, 14 s, 21 s, then a beat before record 4; 28 s, 35 s, 42 s, then one before record 7.
    expect(beats).toBe(2);
    expect(counts).toEqual({ ...ZERO, agency: 7 });
  });

  // Code review R3-BE-1: a page read that hangs past the lock's lapse returns
  // records the pass has not checked the lock for - the beat runs BEFORE each
  // record is matched and written, never only after.
  it('beats BEFORE each record: the first record after a stalled page read is never written unchecked', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T12:00:00.000Z'));
    const { world, records } = setup({
      contacts: [contact('p-1', { type: 'partner', status: 'active', agency: 'Steps' })],
      units: [unit('u-1', { accepted_authorities: ['Junk HA'] })],
    });
    // The FIRST page read of each pass hangs 16 minutes, and the lock lapses meanwhile.
    const stallMs = 16 * 60_000;
    const listByType = world.contactsRepo.listByType.bind(world.contactsRepo);
    let contactsStalled = false;
    world.contactsRepo.listByType = async (type, opts) => {
      if (!contactsStalled) {
        contactsStalled = true;
        vi.setSystemTime(Date.now() + stallMs);
      }
      return listByType(type, opts);
    };
    const listUnits = world.unitsRepo.list.bind(world.unitsRepo);
    let unitsStalled = false;
    world.unitsRepo.list = async (opts) => {
      if (!unitsStalled) {
        unitsStalled = true;
        vi.setSystemTime(Date.now() + stallMs);
      }
      return listUnits(opts);
    };
    const lapsed = { ...OPTS, heartbeat: async () => false };
    const use = runningRewrite({ action: 'use', field: 'agency', fromTexts: ['Steps'], toName: STEP_UP.name });
    const useErr = await records.rewrite(use, lapsed).catch((e: unknown) => e);
    expect(contactIn(world, 'p-1')?.['agency']).toBe('Steps');
    expect(useErr).toBeInstanceOf(OrgRewriteLockLostError);
    expect((useErr as OrgRewriteLockLostError).counts).toEqual(ZERO);
    const clear = runningRewrite({ action: 'clear', field: 'accepted_authorities', fromTexts: ['Junk HA'] });
    const clearErr = await records.rewrite(clear, lapsed).catch((e: unknown) => e);
    expect(world.units.get('u-1')?.accepted_authorities).toEqual(['Junk HA']);
    expect(clearErr).toBeInstanceOf(OrgRewriteLockLostError);
    expect((clearErr as OrgRewriteLockLostError).counts).toEqual(ZERO);
    expect(rewrites(world)).toEqual([]);
  });

  it('a heartbeat that answers false (the lock is no longer ours) stops the pass before its next write', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T12:00:00.000Z'));
    const { world, records } = setup({
      contacts: [1, 2, 3, 4, 5, 6].map((i) => contact(`p-${i}`, { type: 'partner', status: 'active', agency: 'Steps' })),
    });
    const write = world.contactsRepo.rewriteOrgFields.bind(world.contactsRepo);
    world.contactsRepo.rewriteOrgFields = async (contactId, expected, next) => {
      vi.setSystemTime(Date.now() + 7_000); // each write takes 7 s
      return write(contactId, expected, next);
    };
    const def = runningRewrite({ action: 'use', field: 'agency', fromTexts: ['Steps'], toName: STEP_UP.name });
    const err = await records.rewrite(def, { ...OPTS, heartbeat: async () => false }).catch((e: unknown) => e);
    // 7 s, 14 s, 21 s (beat: the lock is gone) - then not one more write.
    expect(err).toBeInstanceOf(OrgRewriteLockLostError);
    expect((err as OrgRewriteLockLostError).counts).toEqual({ ...ZERO, agency: 3 });
    expect(world.contacts.filter((c) => c['agency'] === STEP_UP.name)).toHaveLength(3);
    expect(rewrites(world)).toHaveLength(3);
  });

  it('the cleanup audit type records field, from and to only - no action, no actor', async () => {
    const { world, records } = setup({ contacts: [contact('t-1', { housingAuthority: 'DCA' })] });
    const def = runningRewrite({ action: 'use', field: 'housingAuthority', fromTexts: ['DCA'], toName: DCA.name });
    await records.rewrite(def, { auditType: 'org_name_cleanup' });
    expect(world.auditEvents).toEqual([
      { entityKey: 'contacts#t-1', event_type: 'org_name_cleanup', payload: { field: 'housingAuthority', from: 'DCA', to: DCA.name } },
    ]);
  });
});
