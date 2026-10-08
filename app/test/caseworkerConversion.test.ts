// The caseworker conversion service (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D16, D19, D21, D22; plan 3.4) on the FakeWorld. The harness org-list fake
// serves the starting list (spec Appendix A) on its first read. FakeWorld
// reads return the LIVE stored objects, so a test can change a record
// "between" the service's read and its write by wrapping a repo method.
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { emailRefId, phoneRefId, type ContactItem } from '../src/repos/contactsRepo.js';
import type { PlacementItem } from '../src/repos/placementsRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import {
  CaseworkerReviewError,
  createCaseworkerConversionService,
} from '../src/services/caseworkerConversion.js';
import { createOrgNamesService } from '../src/services/orgNames.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const ACTOR = 'usr_testva00000000000000000';
const NOW = '2026-10-07T12:00:00.000Z';
const ID = 'c-cw-1';
const PHONE = '+15550107001';

function setup() {
  const world = createFakeWorld();
  const capture = createLogCapture();
  const logger = createLogger({ level: 'info', destination: capture.stream });
  const service = createCaseworkerConversionService({
    contacts: world.contactsRepo,
    conversations: world.conversationsRepo,
    placements: world.placementsRepo,
    tours: world.toursRepo,
    units: world.unitsRepo,
    extraction: world.extractionRepo,
    aiRuns: world.aiRuns,
    audit: world.auditRepo,
    activityEvents: world.activityEventsRepo,
    vocabulary: world.vocabularyRepo,
    events: world.events,
    orgNames: createOrgNamesService({ orgListRepo: world.orgListRepo, logger }),
    logger,
    now: () => new Date(NOW),
  });
  return { world, service, capture };
}

function seed(world: FakeWorld, over: Partial<ContactItem> = {}): ContactItem {
  const c = {
    contactId: ID,
    type: 'tenant',
    status: 'onboarding',
    phone: PHONE,
    firstName: 'Ana',
    lastName: 'Ruiz',
    created_at: '2026-10-01T00:00:00.000Z',
    ...over,
  } as ContactItem;
  world.contacts.push(c);
  return c;
}

function stored(world: FakeWorld, contactId = ID): ContactItem | undefined {
  return world.contacts.find((c) => c.contactId === contactId);
}

function placement(world: FakeWorld, placementId: string, stage: string, tenantId = ID): void {
  world.placements.set(placementId, {
    placementId, tenantId, unitId: 'unit-p', stage,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
  } as PlacementItem);
}

function tour(world: FakeWorld, tourId: string, status: string, tenantId = ID): void {
  world.toursMap.set(tourId, {
    tourId, tenantId, unitId: 'unit-t', tourType: 'self_guided', status,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  } as TourItem);
}

function unit(world: FakeWorld, unitId: string, over: Partial<UnitItem> = {}): void {
  world.units.set(unitId, { unitId, status: 'available', ...over } as UnitItem);
}

/** Await a promise that must reject with a CaseworkerReviewError. */
async function refused(p: Promise<unknown>): Promise<CaseworkerReviewError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CaseworkerReviewError) return err;
    throw err;
  }
  throw new Error('expected a CaseworkerReviewError');
}

describe('the domain (rule 1, D22): who can be previewed', () => {
  it('answers 404 contact_not_found for a missing id', async () => {
    const { service } = setup();
    const err = await refused(service.preview('c-nope'));
    expect([err.status, err.code]).toEqual([404, 'contact_not_found']);
  });

  it('answers 404 for a phone pointer id and an email pointer id (the fake sentinel type must not hide them)', async () => {
    const { world, service } = setup();
    seed(world, { contactId: 'c-owner', phone: '+15550107090', email: 'owner@example.org' });
    await world.contactsRepo.addPhone('c-owner', { phone: '+15550107098' });
    await world.contactsRepo.addEmail('c-owner', { email: 'second@example.org' });
    for (const id of [phoneRefId('+15550107098'), emailRefId('second@example.org')]) {
      expect(stored(world, id), id).toBeDefined();
      const err = await refused(service.preview(id));
      expect([err.status, err.code], id).toEqual([404, 'contact_not_found']);
    }
  });

  it('answers 404 for a row whose type is not a ContactType, and for a soft-deleted contact', async () => {
    const { world, service } = setup();
    seed(world, { contactId: 'c-odd', type: 'vendor' as ContactItem['type'] });
    seed(world, { contactId: 'c-gone', deleted_at: '2026-10-05T00:00:00.000Z' });
    for (const id of ['c-odd', 'c-gone']) {
      const err = await refused(service.preview(id));
      expect([err.status, err.code], id).toEqual([404, 'contact_not_found']);
    }
  });

  it('answers 400 caseworker_team_member for a team member', async () => {
    const { world, service } = setup();
    seed(world, { type: 'team_member', status: 'active' });
    const err = await refused(service.preview(ID));
    expect([err.status, err.code]).toEqual([400, 'caseworker_team_member']);
  });

  it('previews an unknown, a tenant, a landlord and a role-less partner', async () => {
    const { world, service } = setup();
    seed(world, { contactId: 'c-u', type: 'unknown', status: 'needs_review' });
    seed(world, { contactId: 'c-t' });
    seed(world, { contactId: 'c-l', type: 'landlord', status: 'interested' });
    seed(world, { contactId: 'c-p', type: 'partner', status: 'active' });
    for (const id of ['c-u', 'c-t', 'c-l', 'c-p']) {
      const p = await service.preview(id);
      expect(p, id).toMatchObject({ contactId: id, alreadyCaseworker: false, refusals: [] });
    }
  });
});

describe('the refusals (rule 3, D19, D22), checked whatever the stored type', () => {
  it('refuses an open placement and an open tour; terminal placements and resolved tours do not count', async () => {
    const { world, service } = setup();
    seed(world);
    placement(world, 'pl-open', 'awaiting_inspection');
    placement(world, 'pl-moved', 'moved_in');
    placement(world, 'pl-lost', 'lost');
    tour(world, 'tr-req', 'requested');
    tour(world, 'tr-sch', 'scheduled');
    tour(world, 'tr-tou', 'toured');
    tour(world, 'tr-ns', 'no_show');
    tour(world, 'tr-can', 'canceled');
    tour(world, 'tr-clo', 'closed');
    const p = await service.preview(ID);
    expect(p.refusals).toEqual([
      { code: 'caseworker_open_placement', placementId: 'pl-open' },
      { code: 'caseworker_open_tour', tourId: 'tr-ns' },
      { code: 'caseworker_open_tour', tourId: 'tr-req' },
      { code: 'caseworker_open_tour', tourId: 'tr-sch' },
      { code: 'caseworker_open_tour', tourId: 'tr-tou' },
    ]);
  });

  it('refuses the landlord of record and a roster seat, soft-deleted units included, one entry per unit', async () => {
    const { world, service } = setup();
    seed(world, { type: 'landlord', status: 'active' });
    unit(world, 'u-ll-live', { landlordId: ID });
    unit(world, 'u-ll-gone', { landlordId: ID, deleted_at: '2026-10-05T00:00:00.000Z' });
    unit(world, 'u-ros-live', {
      landlordId: 'c-someone',
      contacts: [
        { contactId: 'c-someone', role: 'landlord', primaryContact: true },
        { contactId: ID, role: 'pm', primaryContact: false },
      ],
    });
    unit(world, 'u-ros-gone', {
      landlordId: 'c-someone',
      contacts: [{ contactId: ID, role: 'other', primaryContact: true }],
      deleted_at: '2026-10-05T00:00:00.000Z',
    });
    unit(world, 'u-other', { landlordId: 'c-someone' });
    const p = await service.preview(ID);
    expect(p.refusals).toEqual([
      { code: 'caseworker_landlord_of_record', unitId: 'u-ll-gone' },
      { code: 'caseworker_landlord_of_record', unitId: 'u-ll-live' },
      { code: 'caseworker_on_roster', unitId: 'u-ros-gone' },
      { code: 'caseworker_on_roster', unitId: 'u-ros-live' },
    ]);
  });

  it('checks a partner too (an open tour as the tenant), and lists every kind in order', async () => {
    const { world, service } = setup();
    seed(world, { type: 'partner', status: 'active' });
    unit(world, 'u-1', { landlordId: ID });
    tour(world, 'tr-1', 'scheduled');
    placement(world, 'pl-1', 'send_application');
    const p = await service.preview(ID);
    expect(p.refusals.map((r) => r.code)).toEqual([
      'caseworker_open_placement',
      'caseworker_open_tour',
      'caseworker_landlord_of_record',
    ]);
  });
});

describe('the preview (rule 9): what the conversion removes', () => {
  it('names the housing authority, the agency and the pending suggestion count', async () => {
    const { world, service } = setup();
    seed(world, { housingAuthority: 'Atlanta Housing Authority', agency: 'Step Up' });
    await world.extractionRepo.putSuggestion({ ownerContactId: ID, target: 'pets', suggestedValue: 'a dog', conversationId: 'conv-x' });
    await world.extractionRepo.putSuggestion({ ownerContactId: ID, target: 'type', suggestedValue: 'partner', conversationId: 'conv-x' });
    const p = await service.preview(ID);
    expect(p.removes).toEqual({ housingAuthority: 'Atlanta Housing Authority', agency: 'Step Up', pendingSuggestions: 2 });
  });

  it("omits an empty agency and an absent authority", async () => {
    const { world, service } = setup();
    seed(world, { agency: '' });
    expect((await service.preview(ID)).removes).toEqual({ pendingSuggestions: 0 });
  });

  it('a contact already a caseworker: alreadyCaseworker, no refusals (make runs only steps 2-4), removes only suggestions', async () => {
    const { world, service } = setup();
    seed(world, { type: 'partner', status: 'active', role: 'Caseworker', housingAuthority: 'Atlanta Housing Authority' });
    tour(world, 'tr-1', 'scheduled');
    await world.extractionRepo.putSuggestion({ ownerContactId: ID, target: 'pets', suggestedValue: 'a dog', conversationId: 'conv-x' });
    const p = await service.preview(ID);
    expect(p).toMatchObject({ alreadyCaseworker: true, refusals: [], removes: { pendingSuggestions: 1 } });
    expect(p.removes).not.toHaveProperty('housingAuthority');
  });

  it('writes nothing', async () => {
    const { world, service } = setup();
    seed(world, { housingAuthority: 'Atlanta Housing Authority' });
    const before = structuredClone(stored(world));
    await service.preview(ID);
    expect(stored(world)).toEqual(before);
    expect(world.auditEvents).toEqual([]);
  });
});

describe('refusal read contracts', () => {
  it.each(['unknown', 'tenant', 'landlord', 'partner'] as const)('checks every refusal for stored type %s', async (type) => {
    const { world, service } = setup();
    seed(world, { type });
    const read = vi.spyOn(world.contactsRepo, 'getById');
    placement(world, 'p-1', 'send_application');
    tour(world, 't-1', 'requested');
    unit(world, 'u-1', { landlordId: ID, deleted_at: NOW, contacts: [{ contactId: ID, role: 'pm', primaryContact: true }] });
    unit(world, 'u-2', { contacts: [{ contactId: ID, role: 'other', primaryContact: true }], deleted_at: NOW });
    expect((await service.preview(ID)).refusals).toEqual([
      { code: 'caseworker_open_placement', placementId: 'p-1' },
      { code: 'caseworker_open_tour', tourId: 't-1' },
      { code: 'caseworker_landlord_of_record', unitId: 'u-1' },
      { code: 'caseworker_on_roster', unitId: 'u-2' },
    ]);
    expect(read).toHaveBeenCalledWith(ID, { consistentRead: true });
  });

  it('walks the unit scan cursor to a deleted roster seat after the first page', async () => {
    const { world, service } = setup();
    seed(world);
    for (let i = 0; i < 55; i += 1) unit(world, 'scan-' + String(i).padStart(2, '0'));
    unit(world, 'scan-last', { deleted_at: NOW, contacts: [{ contactId: ID, role: 'other', primaryContact: false }] });
    const realList = world.unitsRepo.list.bind(world.unitsRepo);
    const scan = vi.spyOn(world.unitsRepo, 'list').mockImplementation((options) => realList({ ...options, limit: 50 }));
    expect((await service.preview(ID)).refusals).toEqual([{ code: 'caseworker_on_roster', unitId: 'scan-last' }]);
    expect(scan).toHaveBeenCalledTimes(2);
    for (const [options] of scan.mock.calls) expect(options).toMatchObject({ deleted: 'any' });
  });
});

describe('the organization without a request (rule 4, D19, R2-F7)', () => {
  async function orgOf(over: Partial<ContactItem>) {
    const { world, service } = setup();
    seed(world, over);
    return (await service.preview(ID)).organization;
  }

  it('keeps a stored organization, even one not on the list', async () => {
    expect(await orgOf({ organization: 'Old Helper Org', agency: 'Step Up' })).toEqual({ value: 'Old Helper Org', source: 'stored' });
  });

  it('the agency wins and resolves against BOTH lists', async () => {
    expect(await orgOf({ agency: 'Hope Atlanta', housingAuthority: 'Atlanta Housing Authority' }))
      .toEqual({ value: 'HOPE Atlanta', source: 'list_match' });
    // A housing authority spelling typed into the agency field still matches.
    expect(await orgOf({ agency: 'Atlanta Housing' })).toEqual({ value: 'Atlanta Housing Authority', source: 'list_match' });
  });

  it('carries agency text that is not on the list, compound text included', async () => {
    expect(await orgOf({ agency: 'Neighborhood Helpers' })).toEqual({ value: 'Neighborhood Helpers', source: 'carried' });
    expect(await orgOf({ agency: 'DCA HUD-VASH' })).toEqual({ value: 'DCA HUD-VASH', source: 'carried' });
    expect(await orgOf({ agency: 'AHA' })).toEqual({ value: 'AHA', source: 'carried' }); // ambiguous is not a match
  });

  it('only with no agency does the housing authority get the same treatment', async () => {
    expect(await orgOf({ housingAuthority: 'GA DCA' }))
      .toEqual({ value: 'Georgia Department of Community Affairs', source: 'list_match' });
    // An agency name sitting in the housing authority field counts.
    expect(await orgOf({ housingAuthority: 'Step Up', agency: '' })).toEqual({ value: 'Step Up', source: 'list_match' });
    expect(await orgOf({ housingAuthority: 'Nowhere Housing Authority' }))
      .toEqual({ value: 'Nowhere Housing Authority', source: 'carried' });
  });

  it('does not carry text that fails the limits, and then does not fall back to the authority', async () => {
    const bell = String.fromCharCode(7);
    expect(await orgOf({ agency: `Helpers${bell}`, housingAuthority: 'Atlanta Housing Authority' })).toEqual({ source: 'none' });
    expect(await orgOf({ agency: 'x'.repeat(121) })).toEqual({ source: 'none' });
    expect(await orgOf({ agency: '---' })).toEqual({ source: 'none' });
  });

  it('none when there is nothing to derive from', async () => {
    expect(await orgOf({})).toEqual({ source: 'none' });
  });
});

// C2: carry uses the raw stored text; D13 failures never fall back to authority.
describe('raw organization carry (D19, R2-F7)', () => {
  it.each(['agency', 'housingAuthority'] as const)('preserves padding in carried %s text', async (field) => {
    const { world, service } = setup();
    seed(world, { [field]: '  Neighborhood Helpers  ' });
    expect((await service.preview(ID)).organization).toEqual({ value: '  Neighborhood Helpers  ', source: 'carried' });
  });

  it.each([
    ['trailing newline', 'Helpers' + String.fromCharCode(10)],
    ['trailing invisible', 'Helpers' + String.fromCharCode(0xfeff)],
    ['raw over limit', '  ' + 'x'.repeat(119)],
    ['nonempty whitespace', '   '],
  ])('does not carry or fall back after an agency with %s', async (_label, agency) => {
    const { world, service } = setup();
    seed(world, { agency, housingAuthority: 'Atlanta Housing Authority' });
    expect((await service.preview(ID)).organization).toEqual({ source: 'none' });
  });

  it('still resolves a canonical list match before considering raw carry eligibility', async () => {
    const { world, service } = setup();
    seed(world, { agency: 'Step Up' + String.fromCharCode(10) });
    expect((await service.preview(ID)).organization).toEqual({ value: 'Step Up', source: 'list_match' });
  });
});

describe('the thread plan (step 3, D21, R1-F15): what the preview counts', () => {
  const OPEN = { status: 'open', ai_mode: 'auto', last_activity_at: NOW, created_at: NOW };

  function thread(world: FakeWorld, conversationId: string, over: Record<string, unknown>): void {
    world.conversations.set(conversationId, { conversationId, ...OPEN, ...over } as never);
  }

  it("counts the contact's own open one-to-one threads on every phone and every email", async () => {
    const { world, service } = setup();
    seed(world, {
      phones: [{ phone: PHONE, primary: true }, { phone: '+15550107002', primary: false }],
      email: 'ana@example.org',
      emails: [{ email: 'ana@example.org', primary: true }, { email: 'ana.secondary@example.org', primary: false }],
    });
    thread(world, 'cv-unknown', { type: 'unknown_1to1', participant_phone: PHONE });
    thread(world, 'cv-second', { type: 'tenant_1to1', participant_phone: '+15550107002' });
    thread(world, 'cv-email', { type: 'landlord_1to1', participant_email: 'ana@example.org' });
    thread(world, 'cv-email-secondary', { type: 'unknown_1to1', participant_email: 'ana.secondary@example.org' });
    thread(world, 'cv-partner', { type: 'partner_1to1', participant_phone: PHONE, status: 'closed' });
    thread(world, 'cv-closed', { type: 'tenant_1to1', participant_phone: PHONE, status: 'closed' });
    thread(world, 'cv-relay', { type: 'relay_group', participant_phone: PHONE });
    expect((await service.preview(ID)).threads).toEqual({ retype: 4, leftShared: 0, leftOther: 0 });
  });

  it('an already partner_1to1 thread is neither re-typed nor counted', async () => {
    const { world, service } = setup();
    seed(world);
    thread(world, 'cv-p', { type: 'partner_1to1', participant_phone: PHONE });
    expect((await service.preview(ID)).threads).toEqual({ retype: 0, leftShared: 0, leftOther: 0 });
  });

  it('leaves (leftShared) a household phone another live contact holds; a deleted holder does not share', async () => {
    const { world, service } = setup();
    seed(world);
    seed(world, { contactId: 'c-household', phone: PHONE });
    seed(world, { contactId: 'c-gone', phone: '+15550107003', deleted_at: '2026-10-05T00:00:00.000Z' });
    world.contacts.find((c) => c.contactId === ID)!.phones = [
      { phone: PHONE, primary: true },
      { phone: '+15550107003', primary: false },
    ];
    thread(world, 'cv-shared', { type: 'tenant_1to1', participant_phone: PHONE });
    thread(world, 'cv-own', { type: 'unknown_1to1', participant_phone: '+15550107003' });
    expect((await service.preview(ID)).threads).toEqual({ retype: 1, leftShared: 1, leftOther: 0 });
  });

  it("leaves a phone another contact holds through a pointer row, and a shared address", async () => {
    const { world, service } = setup();
    seed(world, { phone: '+15550107004', email: 'shared@example.org' });
    seed(world, { contactId: 'c-other', phone: '+15550107005', email: 'other@example.org' });
    await world.contactsRepo.addPhone('c-other', { phone: '+15550107004' });
    seed(world, { contactId: 'c-also', phone: '+15550107006', email: 'shared@example.org' });
    thread(world, 'cv-ptr', { type: 'unknown_1to1', participant_phone: '+15550107004' });
    thread(world, 'cv-mail', { type: 'unknown_1to1', participant_email: 'shared@example.org' });
    expect((await service.preview(ID)).threads).toEqual({ retype: 0, leftShared: 2, leftOther: 0 });
  });

  it("leaves a thread whose participant contactId is another contact (leftShared) and a type-less row (leftOther)", async () => {
    const { world, service } = setup();
    seed(world);
    thread(world, 'cv-theirs', {
      type: 'tenant_1to1', participant_phone: PHONE, participants: [{ contactId: 'c-elsewhere', phone: PHONE }],
    });
    thread(world, 'cv-legacy', { participant_phone: PHONE });
    expect((await service.preview(ID)).threads).toEqual({ retype: 0, leftShared: 1, leftOther: 1 });
  });

  it('a participant contactId equal to the contact is its own thread', async () => {
    const { world, service } = setup();
    seed(world);
    thread(world, 'cv-mine', { type: 'unknown_1to1', participant_phone: PHONE, participants: [{ contactId: ID, phone: PHONE }] });
    expect((await service.preview(ID)).threads).toEqual({ retype: 1, leftShared: 0, leftOther: 0 });
  });
});

describe('make - the commit write (rules 3-5, step 1, D19, D22)', () => {
  it('converts in ONE fenced write: partner, Caseworker, active, manual, the organization, agency cleared, authority removed, the record', async () => {
    const { world, service } = setup();
    seed(world, {
      housingAuthority: 'Atlanta Housing Authority',
      housingAuthority_source: 'ai',
      agency: 'Hope Atlanta',
      voucherSize: 2,
    });
    const writes: unknown[] = [];
    const original = world.contactsRepo.update.bind(world.contactsRepo);
    world.contactsRepo.update = async (id, patch, opts) => {
      writes.push({ id, opts });
      return original(id, patch, opts);
    };
    const contact = await service.make(ID, { actor: ACTOR });
    expect(writes).toEqual([{
      id: ID,
      opts: {
        expect: [
          { attr: 'classification_revision', value: null },
          { attr: 'housingAuthority', value: 'Atlanta Housing Authority' },
          { attr: 'agency', value: 'Hope Atlanta' },
          { attr: 'organization', value: null },
        ],
        notDeleted: true,
      },
    }]);
    const after = stored(world)!;
    expect(contact).toBe(after);
    expect(after).toMatchObject({
      type: 'partner',
      role: 'Caseworker',
      status: 'active',
      type_source: 'manual',
      organization: 'HOPE Atlanta',
      agency: '',
      voucherSize: 2, // the other tenant facts stay as data
      classification_revision: 1,
      caseworker_conversion: {
        at: NOW,
        by: ACTOR,
        fromType: 'tenant',
        housingAuthority: 'Atlanta Housing Authority',
        agency: 'Hope Atlanta',
      },
    });
    expect('housingAuthority' in after).toBe(false);
    expect('housingAuthority_source' in after).toBe(false);
    expect(after.caseworker_conversion).not.toHaveProperty('fromRole');
  });

  it('records fromRole, carries not-on-the-list text, and guards the stored revision as a number', async () => {
    const { world, service } = setup();
    seed(world, { type: 'unknown', status: 'needs_review', role: 'Case Manager', agency: 'Neighborhood Helpers', classification_revision: 3 });
    await service.make(ID, { actor: ACTOR });
    expect(stored(world)).toMatchObject({
      organization: 'Neighborhood Helpers',
      classification_revision: 4,
      caseworker_conversion: { fromType: 'unknown', fromRole: 'Case Manager', agency: 'Neighborhood Helpers' },
    });
  });

  it("a request organization wins: D5 over both kinds; '' leaves it absent", async () => {
    const { world, service } = setup();
    seed(world, { agency: 'Step Up' });
    seed(world, { contactId: 'c-two', phone: '+15550107010', agency: 'Step Up', organization: 'Old Stored Org' });
    await service.make(ID, { actor: ACTOR, organization: 'atlanta housing' });
    expect(stored(world)?.['organization']).toBe('Atlanta Housing Authority');
    await service.make('c-two', { actor: ACTOR, organization: '' });
    expect('organization' in stored(world, 'c-two')!).toBe(false);
  });

  it('a request organization not on the list: 422 org_not_on_list (field organization), nothing written', async () => {
    const { world, service } = setup();
    seed(world, { agency: 'Step Up' });
    const before = structuredClone(stored(world));
    const err = await refused(service.make(ID, { actor: ACTOR, organization: 'Nowhere Org' }));
    expect([err.status, err.code]).toEqual([422, 'org_not_on_list']);
    expect(err.extras).toMatchObject({ field: 'organization', text: 'Nowhere Org', candidates: [] });
    expect(stored(world)).toEqual(before);
  });

  it('a refusal: 409 with the first refusal as the code and every refusal in the body; nothing written', async () => {
    const { world, service } = setup();
    seed(world);
    tour(world, 'tr-1', 'scheduled');
    unit(world, 'u-1', { landlordId: ID });
    const before = structuredClone(stored(world));
    const err = await refused(service.make(ID, { actor: ACTOR }));
    expect([err.status, err.code]).toEqual([409, 'caseworker_open_tour']);
    expect(err.extras).toEqual({
      refusals: [
        { code: 'caseworker_open_tour', tourId: 'tr-1' },
        { code: 'caseworker_landlord_of_record', unitId: 'u-1' },
      ],
    });
    expect(stored(world)).toEqual(before);
    expect(world.auditEvents).toEqual([]);
  });

  for (const [label, edit] of [
    ['an agency edit', (c: ContactItem) => { c['agency'] = 'Step Up'; }],
    ['an organization edit', (c: ContactItem) => { c['organization'] = 'Mercy Care'; }],
    ['an authority edit', (c: ContactItem) => { c['housingAuthority'] = 'Decatur Housing Authority'; }],
    ['a concurrent classification', (c: ContactItem) => { c.classification_revision = 1; }],
  ] as const) {
    it(`answers 409 contact_changed when ${label} lands between the read and the commit`, async () => {
      const { world, service } = setup();
      seed(world, { agency: 'Hope Atlanta' });
      const original = world.contactsRepo.update.bind(world.contactsRepo);
      world.contactsRepo.update = async (id, patch, opts) => {
        edit(stored(world)!);
        return original(id, patch, opts);
      };
      const err = await refused(service.make(ID, { actor: ACTOR }));
      expect([err.status, err.code]).toEqual([409, 'contact_changed']);
      expect(stored(world)?.type).toBe('tenant');
    });
  }

  it('answers 404 when the contact is deleted between the read and the commit (the fifth clause)', async () => {
    const { world, service } = setup();
    seed(world);
    const original = world.contactsRepo.update.bind(world.contactsRepo);
    world.contactsRepo.update = async (id, patch, opts) => {
      stored(world)!.deleted_at = '2026-10-07T11:59:00.000Z';
      return original(id, patch, opts);
    };
    const err = await refused(service.make(ID, { actor: ACTOR }));
    expect([err.status, err.code]).toEqual([404, 'contact_not_found']);
    expect(stored(world)?.type).toBe('tenant');
  });
});

describe('make - step 4: the audit, the milestone, the vocabulary (D19)', () => {
  it('audits contact_updated naming the conversion, records Status -> Active by the NEW type, adds the role', async () => {
    const { world, service } = setup();
    seed(world, { housingAuthority: 'Atlanta Housing Authority' });
    await service.make(ID, { actor: ACTOR });
    const audits = world.auditEvents.filter((e) => e.event_type === 'contact_updated');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityKey: `contacts#${ID}`,
      payload: {
        actor: ACTOR,
        conversion: 'caseworker',
        caseworker_conversion: { fromType: 'tenant', housingAuthority: 'Atlanta Housing Authority' },
      },
    });
    const arrow = String.fromCharCode(0x2192);
    expect(world.activityEvents.filter((e) => e.type === 'contact_status_changed').map((e) => e.label))
      .toEqual([`Status ${arrow} Active`]);
    expect(world.vocabularyAdds).toEqual([{ roles: ['Caseworker'] }]);
  });

  it('records no milestone when the status was already active (a partner becoming a caseworker)', async () => {
    const { world, service } = setup();
    seed(world, { type: 'partner', status: 'active' });
    await service.make(ID, { actor: ACTOR });
    expect(world.activityEvents.filter((e) => e.type === 'contact_status_changed')).toEqual([]);
  });
});

describe('make raw guard boundaries', () => {
  it('guards a stored zero revision and empty organization fields as values', async () => {
    const { world, service } = setup();
    seed(world, { classification_revision: 0, housingAuthority: '', agency: '', organization: '' });
    const update = vi.spyOn(world.contactsRepo, 'update');
    await service.make(ID, { actor: ACTOR });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[2]).toEqual({
      expect: [
        { attr: 'classification_revision', value: 0 },
        { attr: 'housingAuthority', value: '' },
        { attr: 'agency', value: '' },
        { attr: 'organization', value: '' },
      ],
      notDeleted: true,
    });
    expect(stored(world)).toMatchObject({ classification_revision: 1, agency: '' });
    expect(stored(world)?.caseworker_conversion).not.toHaveProperty('agency');
    expect(stored(world)?.caseworker_conversion).not.toHaveProperty('housingAuthority');
  });

  it('does not equate an absent revision with a concurrent stored zero', async () => {
    const { world, service } = setup();
    seed(world);
    const original = world.contactsRepo.update.bind(world.contactsRepo);
    world.contactsRepo.update = async (id, patch, opts) => {
      stored(world)!.classification_revision = 0;
      return original(id, patch, opts);
    };
    const err = await refused(service.make(ID, { actor: ACTOR }));
    expect([err.status, err.code]).toEqual([409, 'contact_changed']);
    expect(stored(world)?.type).toBe('tenant');
  });

  it('consistently re-reads a disappeared contact after a failed condition', async () => {
    const { world, service } = setup();
    seed(world);
    const read = vi.spyOn(world.contactsRepo, 'getById');
    const original = world.contactsRepo.update.bind(world.contactsRepo);
    world.contactsRepo.update = async (id, patch, opts) => {
      world.contacts.splice(world.contacts.findIndex((c) => c.contactId === id), 1);
      return original(id, patch, opts);
    };
    const err = await refused(service.make(ID, { actor: ACTOR }));
    expect([err.status, err.code]).toEqual([404, 'contact_not_found']);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.every(([, options]) => options?.consistentRead === true)).toBe(true);
    expect(world.auditEvents).toEqual([]);
  });
});

describe('make - step 2: the suggestions (D16, D19)', () => {
  it("drains the type suggestion as accepted (the canonicalizer's partner preset) and supersedes every other one", async () => {
    const { world, service } = setup();
    seed(world, { type: 'unknown', status: 'needs_review' });
    const stamps: Array<[string, string, string, unknown]> = [];
    world.aiRuns.setVerdict = async (runId, target, verdict, opts) => {
      stamps.push([runId, target, verdict, opts?.by]);
      return true;
    };
    await world.extractionRepo.putSuggestion({
      ownerContactId: ID, target: 'type', suggestedValue: 'partner', conversationId: 'cv', runId: 'run-1',
      contactClassificationRevision: 0,
    });
    await world.extractionRepo.putSuggestion({ ownerContactId: ID, target: 'housingAuthority', suggestedValue: 'AHA', conversationId: 'cv', runId: 'run-1' });
    await world.extractionRepo.putSuggestion({ ownerContactId: ID, target: 'pets', suggestedValue: 'a dog', conversationId: 'cv', runId: 'run-1' });
    await service.make(ID, { actor: ACTOR });
    expect(await world.extractionRepo.listSuggestionsByContact(ID)).toEqual([]);
    expect(stamps.sort()).toEqual([
      ['run-1', 'housingAuthority', 'superseded_by_human_edit', ACTOR],
      ['run-1', 'pets', 'superseded_by_human_edit', ACTOR],
      ['run-1', 'type', 'accepted', ACTOR],
    ]);
    expect(world.emitted.filter((e) => e.event === 'suggestion.updated')).toEqual([
      { event: 'suggestion.updated', payload: { contactId: ID } },
    ]);
  });

  it('a tenant type suggestion is superseded, not accepted', async () => {
    const { world, service } = setup();
    seed(world, { type: 'unknown', status: 'needs_review' });
    const verdicts: string[] = [];
    world.aiRuns.setVerdict = async (_r, _t, verdict) => { verdicts.push(verdict); return true; };
    await world.extractionRepo.putSuggestion({
      ownerContactId: ID, target: 'type', suggestedValue: 'tenant', conversationId: 'cv', runId: 'run-1',
      contactClassificationRevision: 0,
    });
    await service.make(ID, { actor: ACTOR });
    expect(verdicts).toEqual(['superseded_by_human_edit']);
  });
});

describe('make - step 3: the threads (D21)', () => {
  const OPEN = { status: 'open', ai_mode: 'auto', last_activity_at: NOW, created_at: NOW };

  it("re-types the contact's own threads to partner_1to1 with the name, leaves shared ones, emits per thread", async () => {
    const { world, service } = setup();
    seed(world, { email: 'ana@example.org' });
    seed(world, { contactId: 'c-household', phone: '+15550107020' });
    world.contacts.find((c) => c.contactId === ID)!.phones = [
      { phone: PHONE, primary: true },
      { phone: '+15550107020', primary: false },
    ];
    world.conversations.set('cv-own', { conversationId: 'cv-own', ...OPEN, type: 'tenant_1to1', participant_phone: PHONE } as never);
    world.conversations.set('cv-mail', { conversationId: 'cv-mail', ...OPEN, type: 'unknown_1to1', participant_email: 'ana@example.org' } as never);
    world.conversations.set('cv-shared', { conversationId: 'cv-shared', ...OPEN, type: 'tenant_1to1', participant_phone: '+15550107020' } as never);
    await service.make(ID, { actor: ACTOR });
    expect(world.conversations.get('cv-own')).toMatchObject({ type: 'partner_1to1', participant_display_name: 'Ana Ruiz' });
    expect(world.conversations.get('cv-mail')).toMatchObject({ type: 'partner_1to1', participant_display_name: 'Ana Ruiz' });
    expect(world.conversations.get('cv-shared')?.type).toBe('tenant_1to1');
    const updated = world.emitted.filter((e) => e.event === 'conversation.updated');
    expect(updated.map((e) => (e.payload as { conversationId: string }).conversationId).sort()).toEqual(['cv-mail', 'cv-own']);
    expect(world.auditEvents.find((e) => e.event_type === 'contact_updated')?.payload).toMatchObject({
      propagatedConversations: 2, conversationType: 'partner_1to1',
    });
  });

  it('skips a thread whose type changed after the plan read it (conditional on the read type)', async () => {
    const { world, service } = setup();
    seed(world);
    world.conversations.set('cv-own', { conversationId: 'cv-own', ...OPEN, type: 'unknown_1to1', participant_phone: PHONE } as never);
    const original = world.conversationsRepo.setTypeIfCurrent.bind(world.conversationsRepo);
    world.conversationsRepo.setTypeIfCurrent = async (id, expected, next, name) => {
      world.conversations.get(id)!.type = 'landlord_1to1'; // a triage landed in between
      return original(id, expected, next, name);
    };
    await service.make(ID, { actor: ACTOR });
    expect(world.conversations.get('cv-own')?.type).toBe('landlord_1to1');
    expect(world.emitted.filter((e) => e.event === 'conversation.updated')).toEqual([]);
  });
});

describe('make - the repair path (rule 2) and failures after the commit', () => {
  const OPEN = { status: 'open', ai_mode: 'auto', last_activity_at: NOW, created_at: NOW };

  it('on a caseworker re-runs steps 2-4 only: no refusals, no commit, no new record, no milestone', async () => {
    const { world, service } = setup();
    seed(world, {
      type: 'partner', status: 'active', role: 'Caseworker', type_source: 'manual', classification_revision: 2,
    });
    tour(world, 'tr-1', 'scheduled'); // would refuse a conversion; the repair does not check
    world.conversations.set('cv-own', { conversationId: 'cv-own', ...OPEN, type: 'unknown_1to1', participant_phone: PHONE } as never);
    await world.extractionRepo.putSuggestion({ ownerContactId: ID, target: 'pets', suggestedValue: 'a dog', conversationId: 'cv' });
    const contact = await service.make(ID, { actor: ACTOR, organization: 'Nowhere Org' });
    expect(contact.classification_revision).toBe(2);
    expect('caseworker_conversion' in contact).toBe(false);
    expect('organization' in contact).toBe(false);
    expect(world.conversations.get('cv-own')?.type).toBe('partner_1to1');
    expect(await world.extractionRepo.listSuggestionsByContact(ID)).toEqual([]);
    expect(world.auditEvents.find((e) => e.event_type === 'contact_updated')?.payload).toMatchObject({
      repair: true, conversion: 'caseworker', fields: [],
    });
    expect(world.activityEvents.filter((e) => e.type === 'contact_status_changed')).toEqual([]);
  });

  it('the repair path re-checks deletion first', async () => {
    const { world, service } = setup();
    seed(world, { type: 'partner', status: 'active', role: 'Caseworker', deleted_at: '2026-10-05T00:00:00.000Z' });
    const err = await refused(service.make(ID, { actor: ACTOR }));
    expect([err.status, err.code]).toEqual([404, 'contact_not_found']);
  });

  it('a failure after the commit is logged at error level and never thrown', async () => {
    const { world, service, capture } = setup();
    seed(world);
    world.conversations.set('cv-own', { conversationId: 'cv-own', ...OPEN, type: 'unknown_1to1', participant_phone: PHONE } as never);
    world.failAuditAppendFor.add('contact_updated');
    world.conversationsRepo.setTypeIfCurrent = async () => {
      throw new Error('injected thread write failure');
    };
    const contact = await service.make(ID, { actor: ACTOR });
    expect(contact).toMatchObject({ type: 'partner', role: 'Caseworker' });
    expect(capture.atLevel(50).length).toBeGreaterThanOrEqual(2);
    expect(capture.atLevel(50).every((l) => String(l['msg']).startsWith('caseworker conversion'))).toBe(true);
  });
});

// C1: errors swallowed inside shared helpers must still reach conversion error logs.
describe('post-commit suggestion failures (C1)', () => {
  it.each(['type-read', 'type-delete', 'other-delete', 'type-verdict', 'other-verdict', 'exhausted'] as const)(
    'returns the committed conversion and logs %s at error with context', async (failure) => {
      const { world, service, capture } = setup();
      seed(world, { agency: 'Neighborhood Helpers', housingAuthority: 'Atlanta Housing Authority' });
      const target = failure.startsWith('other') ? 'pets' : 'type';
      if (failure !== 'type-read') await world.extractionRepo.putSuggestion({
        ownerContactId: ID, target, suggestedValue: target === 'type' ? 'partner' : 'a dog',
        conversationId: 'cv', runId: 'run-1', contactClassificationRevision: 0,
      });
      const error = new Error('injected ' + failure);
      if (failure === 'type-read') {
        const original = world.extractionRepo.getSuggestion.bind(world.extractionRepo);
        vi.spyOn(world.extractionRepo, 'getSuggestion').mockImplementation((...args) => {
          if (stored(world)?.type === 'partner') return Promise.reject(error);
          return original(...args);
        });
      }
      if (failure === 'type-delete') vi.spyOn(world.extractionRepo, 'deleteTypeSuggestionIfCurrentAtContactRevision').mockRejectedValue(error);
      if (failure === 'other-delete') vi.spyOn(world.extractionRepo, 'deleteSuggestionIfCurrent').mockRejectedValue(error);
      if (failure.endsWith('verdict')) vi.spyOn(world.aiRuns, 'setVerdict').mockRejectedValue(error);
      const drain = failure === 'exhausted'
        ? vi.spyOn(world.extractionRepo, 'deleteTypeSuggestionIfCurrentAtContactRevision').mockResolvedValue('suggestion_changed_or_absent')
        : undefined;
      const contact = await service.make(ID, { actor: ACTOR });
      expect(contact).toMatchObject({
        type: 'partner', role: 'Caseworker', classification_revision: 1,
        caseworker_conversion: { agency: 'Neighborhood Helpers', housingAuthority: 'Atlanta Housing Authority' },
      });
      expect(capture.atLevel(50)).toEqual([
        expect.objectContaining({
          contactId: ID, conversion: 'caseworker', repair: false,
          msg: expect.stringContaining(failure === 'exhausted' ? 'exhausted bounded retries' : 'failed (best-effort)'),
        }),
      ]);
      expect(capture.atLevel(40)).toEqual([]);
      expect(world.auditEvents.filter((event) => event.event_type === 'contact_updated')).toHaveLength(1);
      expect(world.vocabularyAdds).toEqual([{ roles: ['Caseworker'] }]);
      if (drain) expect(drain).toHaveBeenCalledTimes(4);
    },
  );

  it('logs a failed repair read at error even when the drain read then succeeds', async () => {
    const { world, service, capture } = setup();
    seed(world, { type: 'partner', role: 'Caseworker', status: 'active', classification_revision: 2 });
    await world.extractionRepo.putSuggestion({
      ownerContactId: ID, target: 'type', suggestedValue: 'partner', conversationId: 'cv',
      runId: 'run-1', contactClassificationRevision: 0,
    });
    vi.spyOn(world.extractionRepo, 'getSuggestion').mockRejectedValueOnce(new Error('repair snapshot failed'));
    await expect(service.make(ID, { actor: ACTOR })).resolves.toMatchObject({ type: 'partner', role: 'Caseworker' });
    expect(await world.extractionRepo.listSuggestionsByContact(ID)).toEqual([]);
    expect(capture.atLevel(50)).toEqual([
      expect.objectContaining({ contactId: ID, conversion: 'caseworker', repair: true }),
    ]);
    expect(capture.atLevel(40)).toEqual([]);
  });
});

describe('conversion follow-on boundaries', () => {
  const OPEN = { status: 'open', ai_mode: 'auto', last_activity_at: NOW, created_at: NOW };

  it('repair preserves the existing record and organization, skips commit and refusals, and emits once per effect', async () => {
    const { world, service } = setup();
    const record = { at: '2026-10-01T00:00:00.000Z', by: 'original-user', fromType: 'tenant' as const, agency: 'Original Agency' };
    seed(world, {
      type: 'partner', role: 'Caseworker', status: 'active', classification_revision: 4,
      organization: 'Original Org', caseworker_conversion: record,
    });
    const before = structuredClone(stored(world));
    const update = vi.spyOn(world.contactsRepo, 'update');
    const placements = vi.spyOn(world.placementsRepo, 'listByTenant');
    const tours = vi.spyOn(world.toursRepo, 'listByTenant');
    const units = vi.spyOn(world.unitsRepo, 'list');
    world.conversations.set('repair-own', { conversationId: 'repair-own', ...OPEN, type: 'unknown_1to1', participant_phone: PHONE } as never);
    await world.extractionRepo.putSuggestion({ ownerContactId: ID, target: 'pets', suggestedValue: 'cat', conversationId: 'cv' });
    await service.make(ID, { actor: ACTOR, organization: '' });
    expect(stored(world)).toEqual(before);
    expect(update).not.toHaveBeenCalled();
    expect(placements).not.toHaveBeenCalled();
    expect(tours).not.toHaveBeenCalled();
    expect(units).not.toHaveBeenCalled();
    expect(world.auditEvents.filter((event) => event.event_type === 'contact_updated')).toHaveLength(1);
    expect(world.activityEvents).toEqual([]);
    expect(world.vocabularyAdds).toEqual([{ roles: ['Caseworker'] }]);
    expect(world.emitted.filter((event) => event.event === 'suggestion.updated')).toHaveLength(1);
    expect(world.emitted.filter((event) => event.event === 'conversation.updated')).toHaveLength(1);
  });

  it('builds the conversation event from the returned updated row', async () => {
    const { world, service } = setup();
    seed(world);
    world.conversations.set('cv-returned', { conversationId: 'cv-returned', ...OPEN, type: 'tenant_1to1', participant_phone: PHONE } as never);
    const original = world.conversationsRepo.setTypeIfCurrent.bind(world.conversationsRepo);
    world.conversationsRepo.setTypeIfCurrent = async (...args) => {
      const result = await original(...args);
      return result.outcome === 'skipped' ? result : {
        outcome: 'updated',
        conversation: { ...result.conversation, unread_count: 37, last_message_preview: 'Returned preview', last_activity_at: '2026-10-07T13:00:00.000Z' },
      };
    };
    await service.make(ID, { actor: ACTOR });
    expect(world.emitted.filter((event) => event.event === 'conversation.updated')).toEqual([{
      event: 'conversation.updated',
      payload: {
        conversationId: 'cv-returned', type: 'partner_1to1', participant_display_name: 'Ana Ruiz',
        unread_count: 37, preview: 'Returned preview', last_activity_at: '2026-10-07T13:00:00.000Z',
      },
    }]);
  });

  it('passes null when the contact has no name, preserving the existing thread name', async () => {
    const { world, service } = setup();
    seed(world, { firstName: '', lastName: '   ' });
    world.conversations.set('cv-nameless', { conversationId: 'cv-nameless', ...OPEN, type: 'unknown_1to1', participant_phone: PHONE, participant_display_name: 'Existing name' } as never);
    const retype = vi.spyOn(world.conversationsRepo, 'setTypeIfCurrent');
    await service.make(ID, { actor: ACTOR });
    expect(retype).toHaveBeenCalledExactlyOnceWith('cv-nameless', 'unknown_1to1', 'partner_1to1', null);
    expect(world.conversations.get('cv-nameless')?.participant_display_name).toBe('Existing name');
  });

  it.each([0, 1])('preserves revision and identity semantics for a racing type replacement at revision %s', async (revision) => {
    const { world, service } = setup();
    seed(world);
    await world.extractionRepo.putSuggestion({
      ownerContactId: ID, target: 'type', suggestedValue: 'partner', conversationId: 'cv', runId: 'old-run', contactClassificationRevision: 0,
    });
    const verdict = vi.spyOn(world.aiRuns, 'setVerdict');
    const original = world.contactsRepo.update.bind(world.contactsRepo);
    world.contactsRepo.update = async (...args) => {
      await world.extractionRepo.putSuggestion({
        ownerContactId: ID, target: 'type', suggestedValue: 'partner', conversationId: 'cv', runId: 'replacement-run', contactClassificationRevision: revision,
      });
      return original(...args);
    };
    await service.make(ID, { actor: ACTOR });
    if (revision === 0) {
      expect(await world.extractionRepo.getSuggestion(ID, 'type')).toBeUndefined();
      expect(verdict).toHaveBeenCalledExactlyOnceWith('replacement-run', 'type', 'superseded_by_human_edit', expect.objectContaining({ by: ACTOR }));
    } else {
      expect(await world.extractionRepo.getSuggestion(ID, 'type')).toMatchObject({ runId: 'replacement-run', contactClassificationRevision: 1 });
      expect(verdict).not.toHaveBeenCalled();
      expect(world.emitted.filter((event) => event.event === 'suggestion.updated')).toEqual([]);
    }
  });

  it.each(['suggestion-list', 'thread-plan', 'milestone', 'vocabulary'] as const)('logs %s failure after commit and returns the converted contact', async (failure) => {
    const { world, service, capture } = setup();
    seed(world, { agency: 'Neighborhood Helpers' });
    const error = new Error('injected ' + failure);
    if (failure === 'suggestion-list') vi.spyOn(world.extractionRepo, 'listSuggestionsByContact').mockRejectedValue(error);
    if (failure === 'thread-plan') vi.spyOn(world.conversationsRepo, 'findByParticipantPhone').mockRejectedValue(error);
    if (failure === 'milestone') vi.spyOn(world.activityEventsRepo, 'record').mockRejectedValue(error);
    if (failure === 'vocabulary') vi.spyOn(world.vocabularyRepo, 'add').mockRejectedValue(error);
    await expect(service.make(ID, { actor: ACTOR })).resolves.toMatchObject({
      type: 'partner', role: 'Caseworker', caseworker_conversion: { agency: 'Neighborhood Helpers' },
    });
    expect(capture.atLevel(50)).toHaveLength(1);
    expect(capture.atLevel(50)[0]).toMatchObject({ contactId: ID, msg: expect.stringMatching(/^caseworker conversion:/) });
    expect(world.auditEvents.filter((event) => event.event_type === 'contact_updated')).toHaveLength(1);
  });
});

describe('dismiss (D19, D22)', () => {
  it('writes caseworker_review dismissed with no revision bump, audits it, returns the contact', async () => {
    const { world, service } = setup();
    for (const [id, type, status] of [['c-t', 'tenant', 'onboarding'], ['c-l', 'landlord', 'interested'], ['c-p', 'partner', 'active']] as const) {
      seed(world, { contactId: id, type, status, classification_revision: 5 });
      const contact = await service.dismiss(id, ACTOR);
      expect(contact, id).toMatchObject({ caseworker_review: 'dismissed', classification_revision: 5 });
    }
    expect(world.auditEvents.filter((e) => e.event_type === 'contact_updated').map((e) => e.payload)).toEqual([
      { fields: ['caseworker_review'], actor: ACTOR },
      { fields: ['caseworker_review'], actor: ACTOR },
      { fields: ['caseworker_review'], actor: ACTOR },
    ]);
  });

  it('refuses an unknown and a caseworker with 400 caseworker_dismiss_not_allowed', async () => {
    const { world, service } = setup();
    seed(world, { contactId: 'c-u', type: 'unknown', status: 'needs_review' });
    seed(world, { contactId: 'c-cw', type: 'partner', status: 'active', role: 'Case worker' });
    for (const id of ['c-u', 'c-cw']) {
      const err = await refused(service.dismiss(id, ACTOR));
      expect([err.status, err.code], id).toEqual([400, 'caseworker_dismiss_not_allowed']);
      expect(stored(world, id)).not.toHaveProperty('caseworker_review');
    }
  });

  it('shares the domain: 404 missing, pointer or deleted; 400 team member', async () => {
    const { world, service } = setup();
    seed(world, { contactId: 'c-owner', phone: '+15550107030' });
    await world.contactsRepo.addPhone('c-owner', { phone: '+15550107031' });
    seed(world, { contactId: 'c-gone', deleted_at: '2026-10-05T00:00:00.000Z' });
    seed(world, { contactId: 'c-team', type: 'team_member', status: 'active' });
    for (const id of ['c-nope', phoneRefId('+15550107031'), 'c-gone']) {
      expect((await refused(service.dismiss(id, ACTOR))).status, id).toBe(404);
    }
    expect((await refused(service.dismiss('c-team', ACTOR))).code).toBe('caseworker_team_member');
  });

  it('answers 404 when the contact is deleted between the read and the write', async () => {
    const { world, service } = setup();
    seed(world);
    const original = world.contactsRepo.update.bind(world.contactsRepo);
    world.contactsRepo.update = async (id, patch, opts) => {
      stored(world)!.deleted_at = '2026-10-07T11:59:00.000Z';
      return original(id, patch, opts);
    };
    const err = await refused(service.dismiss(ID, ACTOR));
    expect([err.status, err.code]).toEqual([404, 'contact_not_found']);
    expect(stored(world)).not.toHaveProperty('caseworker_review');
  });
});
