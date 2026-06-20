// BE3/C3 route tests — the unit roster + related-units endpoints:
//   GET    /api/units/:id            (now includes `contacts`, superset of legacy)
//   POST   /api/units/:id/contacts   { contactId, role, primaryVoice? }
//   DELETE /api/units/:id/contacts/:contactId
//   GET    /api/units/:id/related    → { related: RelatedUnit[] }
// Plus the back-compat roster for a roster-less unit and the audit trail.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;

function seedUnit(
  world: ReturnType<typeof createFakeWorld>,
  unitId: string,
  overrides: Partial<UnitItem> = {},
): UnitItem {
  const item: UnitItem = {
    unitId,
    landlordId: 'c-ll-1',
    status: 'available',
    jurisdiction: 'DCA',
    beds: 2,
    created_at: '2026-06-12T09:00:00.000Z',
    updated_at: '2026-06-12T09:00:00.000Z',
    ...overrides,
  };
  world.units.set(unitId, item);
  return item;
}

function seedContact(
  world: ReturnType<typeof createFakeWorld>,
  contactId: string,
  overrides: Partial<ContactItem> = {},
): void {
  world.contacts.push({ contactId, type: 'landlord', ...overrides } as ContactItem);
}

describe('GET /api/units/:id — includes contacts (BE3/C3)', () => {
  it('returns a back-compat single-row roster for a roster-less unit (derived from landlordId)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1', { landlordId: 'c-ll-9' });
    const res = await request(app)
      .get('/api/units/u-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    // Legacy fields intact (superset).
    expect(res.body.unit).toMatchObject({ unitId: 'u-1', landlordId: 'c-ll-9', status: 'available', beds: 2 });
    // Back-compat roster: [{ contactId: landlordId, role: 'landlord', primaryVoice: true }].
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-ll-9', role: 'landlord', primaryVoice: true },
    ]);
  });

  it('returns the stored roster when present, name/company enriched at read time', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-2', {
      landlordId: 'c-ll-1',
      contacts: [
        { contactId: 'c-ll-1', role: 'landlord', primaryVoice: false },
        { contactId: 'c-pm-1', role: 'pm', primaryVoice: true },
      ],
    });
    // The pm contact carries the CURRENT name/company — read-time enrichment.
    seedContact(world, 'c-pm-1', { type: 'landlord', firstName: 'Pat', lastName: 'M', company: 'Acme PM' });
    const res = await request(app)
      .get('/api/units/u-2')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toHaveLength(2);
    expect(res.body.unit.contacts).toContainEqual({
      contactId: 'c-pm-1',
      role: 'pm',
      primaryVoice: true,
      name: 'Pat M',
      company: 'Acme PM',
    });
  });

  it('404s an unknown unit', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/units/nope')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unit_not_found');
  });

  it('enriches the back-compat landlord row with name/company resolved at read time', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-enrich', { landlordId: 'c-ll-named' });
    seedContact(world, 'c-ll-named', {
      type: 'landlord',
      firstName: 'Lee',
      lastName: 'Lord',
      company: 'Lord Realty',
    } as Partial<ContactItem>);

    const res = await request(app)
      .get('/api/units/u-enrich')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    const landlordRow = (res.body.unit.contacts as Array<Record<string, unknown>>).find(
      (c) => c.contactId === 'c-ll-named',
    );
    expect(landlordRow).toMatchObject({
      contactId: 'c-ll-named',
      role: 'landlord',
      name: 'Lee Lord',
      company: 'Lord Realty',
    });
  });

  it('reflects the CURRENT contact name at read time (stored roster goes fresh on rename)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-fresh', {
      landlordId: 'c-ll-1',
      contacts: [
        { contactId: 'c-ll-1', role: 'landlord', primaryVoice: false },
        // Stale denormalized name stored on the row.
        { contactId: 'c-pm-fresh', role: 'pm', primaryVoice: true, name: 'Old Name' },
      ],
    });
    seedContact(world, 'c-pm-fresh', { type: 'landlord', firstName: 'New', lastName: 'Name' });

    const res = await request(app)
      .get('/api/units/u-fresh')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    const pmRow = (res.body.unit.contacts as Array<Record<string, unknown>>).find(
      (c) => c.contactId === 'c-pm-fresh',
    );
    // Read-time enrichment wins over the stale stored value.
    expect(pmRow?.name).toBe('New Name');
  });

  it('a missing contact leaves name/company absent (never 500)', async () => {
    const { app, world } = makeWebhookHarness();
    // The landlord contact does NOT exist in the contacts store.
    seedUnit(world, 'u-missing', { landlordId: 'c-ghost-ll' });

    const res = await request(app)
      .get('/api/units/u-missing')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    const row = (res.body.unit.contacts as Array<Record<string, unknown>>).find(
      (c) => c.contactId === 'c-ghost-ll',
    );
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('name');
    expect(row).not.toHaveProperty('company');
  });
});

describe('POST /api/units/:id/contacts (BE3/C3)', () => {
  it('adds a roster contact, denormalizes name/company, and audits unit_contact_added', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-3', { landlordId: 'c-ll-1' });
    seedContact(world, 'c-pm-3', { type: 'landlord', firstName: 'Pat', lastName: 'Manager', company: 'Acme PM' });

    const res = await request(app)
      .post('/api/units/u-3/contacts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ contactId: 'c-pm-3', role: 'pm' });

    expect(res.status).toBe(200);
    const roster = res.body.unit.contacts as Array<Record<string, unknown>>;
    expect(roster.map((c) => c.contactId).sort()).toEqual(['c-ll-1', 'c-pm-3']);
    expect(roster.find((c) => c.contactId === 'c-pm-3')).toMatchObject({
      role: 'pm',
      primaryVoice: false,
      name: 'Pat Manager',
      company: 'Acme PM',
    });
    expect(world.auditEvents).toContainEqual(
      expect.objectContaining({ entityKey: 'units#u-3', event_type: 'unit_contact_added' }),
    );
  });

  it('setting primaryVoice keeps a single ☎ primary and updates the voice-routing field', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-4', { landlordId: 'c-ll-1' });
    seedContact(world, 'c-pm-4', { type: 'landlord', firstName: 'Pat', lastName: 'M' });

    const res = await request(app)
      .post('/api/units/u-4/contacts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ contactId: 'c-pm-4', role: 'pm', primaryVoice: true });

    expect(res.status).toBe(200);
    const roster = res.body.unit.contacts as Array<Record<string, unknown>>;
    expect(roster.filter((c) => c.primaryVoice === true)).toHaveLength(1);
    expect(roster.find((c) => c.primaryVoice === true)?.contactId).toBe('c-pm-4');
    // The WIRE response carries the updated voice-routing field (serializer
    // verified, not just the fake's backing map).
    expect(res.body.unit.primary_voice_contact).toBe('c-pm-4');
    // The stored unit's voice-routing field tracks the roster ☎ primary.
    expect(world.units.get('u-4')?.primary_voice_contact).toBe('c-pm-4');
  });

  it('404s an unknown unit', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-pm-x', { type: 'landlord' });
    const res = await request(app)
      .post('/api/units/ghost/contacts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ contactId: 'c-pm-x', role: 'pm' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unit_not_found');
  });

  it('404s an unknown contact', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-5', { landlordId: 'c-ll-1' });
    const res = await request(app)
      .post('/api/units/u-5/contacts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ contactId: 'c-ghost', role: 'pm' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('contact_not_found');
  });

  it('400s a bad role', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-6', { landlordId: 'c-ll-1' });
    seedContact(world, 'c-pm-6', { type: 'landlord' });
    const res = await request(app)
      .post('/api/units/u-6/contacts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ contactId: 'c-pm-6', role: 'banker' });
    expect(res.status).toBe(400);
  });

  it('400s a non-boolean primaryVoice', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-7', { landlordId: 'c-ll-1' });
    seedContact(world, 'c-pm-7', { type: 'landlord' });
    const res = await request(app)
      .post('/api/units/u-7/contacts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ contactId: 'c-pm-7', role: 'pm', primaryVoice: 'yes' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/units/:id/contacts — landlord role is pinned (BE3/C3 FIX C)', () => {
  it('keeps the landlord row role:landlord even when added with a non-landlord role', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-pin', { landlordId: 'c-ll-pin' });
    // The contact IS the unit's landlord, but is (mistakenly) posted as a 'pm'.
    seedContact(world, 'c-ll-pin', { type: 'landlord', firstName: 'Lee', lastName: 'Lord' });

    const res = await request(app)
      .post('/api/units/u-pin/contacts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ contactId: 'c-ll-pin', role: 'pm' });

    expect(res.status).toBe(200);
    const roster = res.body.unit.contacts as Array<Record<string, unknown>>;
    const landlordRow = roster.find((c) => c.contactId === 'c-ll-pin');
    // Role is forced back to 'landlord' (structural), NOT the supplied 'pm'.
    expect(landlordRow?.role).toBe('landlord');
  });
});

describe('DELETE /api/units/:id/contacts/:contactId (BE3/C3)', () => {
  it('removing the ☎-primary pm keeps the roster flag and scalar in agreement (FIX B)', async () => {
    const { app, world } = makeWebhookHarness();
    // Landlord present; the pm is the current ☎ primary.
    seedUnit(world, 'u-consist', {
      landlordId: 'c-ll-c',
      primary_voice_contact: 'c-pm-c',
      contacts: [
        { contactId: 'c-ll-c', role: 'landlord', primaryVoice: false },
        { contactId: 'c-pm-c', role: 'pm', primaryVoice: true },
      ],
    });
    const res = await request(app)
      .delete('/api/units/u-consist/contacts/c-pm-c')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    const roster = res.body.unit.contacts as Array<Record<string, unknown>>;
    // Exactly one primaryVoice — the landlord — and the scalar agrees.
    expect(roster.filter((c) => c.primaryVoice === true)).toHaveLength(1);
    expect(roster.find((c) => c.primaryVoice === true)?.contactId).toBe('c-ll-c');
    expect(res.body.unit.primary_voice_contact).toBe('c-ll-c');
    expect(world.units.get('u-consist')?.primary_voice_contact).toBe('c-ll-c');
  });

  it('removes a non-landlord roster contact + audits unit_contact_removed', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-8', {
      landlordId: 'c-ll-1',
      contacts: [
        { contactId: 'c-ll-1', role: 'landlord', primaryVoice: true },
        { contactId: 'c-pm-8', role: 'pm', primaryVoice: false },
      ],
    });
    const res = await request(app)
      .delete('/api/units/u-8/contacts/c-pm-8')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect((res.body.unit.contacts as Array<{ contactId: string }>).map((c) => c.contactId)).toEqual([
      'c-ll-1',
    ]);
    expect(world.auditEvents).toContainEqual(
      expect.objectContaining({ entityKey: 'units#u-8', event_type: 'unit_contact_removed' }),
    );
  });

  it('409s removing the primary landlord', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-9', { landlordId: 'c-ll-1' });
    const res = await request(app)
      .delete('/api/units/u-9/contacts/c-ll-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_remove_primary_landlord');
  });

  it('404s a contact not on the roster', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-10', { landlordId: 'c-ll-1' });
    const res = await request(app)
      .delete('/api/units/u-10/contacts/c-ghost')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/units/:id/related (BE3/C3)', () => {
  it('returns same_property siblings then same_landlord units, deduped + self excluded', async () => {
    const { app, world } = makeWebhookHarness();
    // Target unit: belongs to property P, owned by landlord L.
    seedUnit(world, 'u-target', { landlordId: 'L', propertyId: 'P', status: 'available' });
    // same_property sibling (also owned by L → must NOT double as same_landlord).
    seedUnit(world, 'u-sib', { landlordId: 'L', propertyId: 'P', status: 'placed' });
    // same_landlord only (different/no property).
    seedUnit(world, 'u-other', { landlordId: 'L', status: 'available' });
    // Unrelated unit (different landlord, different property).
    seedUnit(world, 'u-unrelated', { landlordId: 'M', propertyId: 'Q', status: 'available' });

    const res = await request(app)
      .get('/api/units/u-target/related')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    const related = res.body.related as Array<{ unitId: string; relation: string }>;
    const ids = related.map((r) => r.unitId);
    expect(ids).not.toContain('u-target'); // self excluded
    expect(ids).not.toContain('u-unrelated');
    // Dedupe: the sibling appears ONCE, as same_property (not also same_landlord).
    expect(related.filter((r) => r.unitId === 'u-sib')).toHaveLength(1);
    expect(related.find((r) => r.unitId === 'u-sib')?.relation).toBe('same_property');
    expect(related.find((r) => r.unitId === 'u-other')?.relation).toBe('same_landlord');
    // Order: same_property first, then same_landlord.
    const firstLandlordIdx = related.findIndex((r) => r.relation === 'same_landlord');
    const lastPropertyIdx = related.map((r) => r.relation).lastIndexOf('same_property');
    expect(lastPropertyIdx).toBeLessThan(firstLandlordIdx);
  });

  it('propertyId is WRITABLE end-to-end: create + PATCH two units to the same property, then related → same_property (FIX A)', async () => {
    const { app } = makeWebhookHarness();
    // Create the target unit WITH a propertyId straight through the API
    // (proves propertyId passes the strict field allowlist on create).
    const createA = await request(app)
      .post('/api/units')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ landlordId: 'c-ll-prop', propertyId: 'prop-API' });
    expect(createA.status).toBe(201);
    const targetId = createA.body.unit.unitId as string;
    expect(createA.body.unit.propertyId).toBe('prop-API');

    // Create a sibling without propertyId, then PATCH it to the same property
    // (proves propertyId passes the allowlist on update too).
    const createB = await request(app)
      .post('/api/units')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ landlordId: 'c-ll-other' });
    expect(createB.status).toBe(201);
    const siblingId = createB.body.unit.unitId as string;

    const patchB = await request(app)
      .patch(`/api/units/${siblingId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ propertyId: 'prop-API' });
    expect(patchB.status).toBe(200);
    expect(patchB.body.unit.propertyId).toBe('prop-API');

    // The related endpoint now finds the sibling via the same_property branch.
    const res = await request(app)
      .get(`/api/units/${targetId}/related`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    const related = res.body.related as Array<{ unitId: string; relation: string }>;
    expect(related.find((r) => r.unitId === siblingId)?.relation).toBe('same_property');
  });

  it('returns { related: [] } for a roster-less + property-less unit (only itself owned)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-lonely', { landlordId: 'SOLO' });
    const res = await request(app)
      .get('/api/units/u-lonely/related')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.related).toEqual([]);
  });

  it('404s an unknown unit', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/units/ghost/related')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
  });
});
