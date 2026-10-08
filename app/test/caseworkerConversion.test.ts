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
