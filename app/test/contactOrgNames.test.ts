// Organization names on the contact writers (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D5, section 9). PATCH /api/contacts/:id checks a CHANGED housingAuthority or
// agency against the stored org list; POST /api/contacts keeps ignoring both
// fields. The harness org-list fake serves the starting list (spec Appendix A)
// on its first read, so every name below is an Appendix A name or spelling.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const ID = 'contact-org-1';

function seedTenant(world: FakeWorld, extra: Partial<ContactItem> = {}): void {
  world.contacts.push({
    contactId: ID,
    type: 'tenant',
    status: 'onboarding',
    phone: '+15550100901',
    created_at: '2026-10-06T10:00:00.000Z',
    ...extra,
  });
}

function patchContact(app: import('express').Express, contactId: string, body: Record<string, unknown>) {
  return request(app)
    .patch(`/api/contacts/${contactId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

function storedOf(world: FakeWorld, contactId: string): ContactItem | undefined {
  return world.contacts.find((c) => c.contactId === contactId);
}

/** The names of a 422's candidate / otherKind refs, sorted (order is not the contract). */
function names(refs: Array<{ name: string }>): string[] {
  return refs.map((r) => r.name).sort();
}

describe('PATCH /api/contacts/:id - organization names (spec D5)', () => {
  it('(PIN) stores an exact list name as is', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);
    const res = await patchContact(app, ID, { housingAuthority: 'Atlanta Housing Authority' });
    expect(res.status).toBe(200);
    expect(storedOf(world, ID)?.['housingAuthority']).toBe('Atlanta Housing Authority');
  });

  it('stores a unique spelling, or the name in another case, as the exact entry name', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);
    const res = await patchContact(app, ID, { housingAuthority: 'GA DCA', agency: 'hope atlanta' });
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({
      housingAuthority: 'Georgia Department of Community Affairs',
      agency: 'HOPE Atlanta',
    });
    expect(storedOf(world, ID)?.['housingAuthority']).toBe('Georgia Department of Community Affairs');
  });

  it('refuses an ambiguous spelling: 422 org_not_on_list naming both candidates', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);
    const res = await patchContact(app, ID, { housingAuthority: 'AHA' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: 'org_not_on_list',
      field: 'housingAuthority',
      text: 'AHA',
      close: [],
    });
    expect(names(res.body.candidates)).toEqual(['Atlanta Housing Authority', 'Augusta Housing Authority']);
  });

  it('refuses a name of the other kind in either field (otherKind names it)', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);
    const ha = await patchContact(app, ID, { housingAuthority: 'Step Up' });
    expect(ha.status).toBe(422);
    expect(ha.body).toMatchObject({ error: 'org_not_on_list', field: 'housingAuthority', candidates: [] });
    expect(names(ha.body.otherKind)).toEqual(['Step Up']);
    const ag = await patchContact(app, ID, { agency: 'Atlanta Housing Authority' });
    expect(ag.status).toBe(422);
    expect(ag.body).toMatchObject({ error: 'org_not_on_list', field: 'agency', candidates: [] });
    expect(names(ag.body.otherKind)).toEqual(['Atlanta Housing Authority']);
  });

  it('a 422 writes NOTHING - not the refused field, not the other fields, no audit row', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { housingAuthority: 'Atlanta Housing Authority' });
    const before = structuredClone(storedOf(world, ID));
    const res = await patchContact(app, ID, { housingAuthority: 'Nowhere Housing Authority', firstName: 'Pat' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: 'org_not_on_list',
      field: 'housingAuthority',
      text: 'Nowhere Housing Authority',
      candidates: [],
    });
    expect(storedOf(world, ID)).toEqual(before);
    expect(world.auditEvents.filter((e) => e.event_type === 'contact_updated')).toHaveLength(0);
  });

  it('checks housingAuthority first, so a body failing both names it', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);
    const res = await patchContact(app, ID, { housingAuthority: 'Step Up', agency: 'Atlanta Housing Authority' });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('housingAuthority');
  });

  it('(PIN) an UNCHANGED value passes even when it is not on the list', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { housingAuthority: 'Nowhere Housing Authority', agency: 'Old Helper Org' });
    const res = await patchContact(app, ID, {
      housingAuthority: 'Nowhere Housing Authority',
      agency: 'Old Helper Org',
      firstName: 'Pat',
    });
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({
      housingAuthority: 'Nowhere Housing Authority',
      agency: 'Old Helper Org',
      firstName: 'Pat',
    });
  });

  it('(PIN) a clear always passes: housingAuthority is REMOVEd, agency stores an empty string', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { housingAuthority: 'Nowhere Housing Authority', agency: 'Old Helper Org' });
    const res = await patchContact(app, ID, { housingAuthority: '', agency: '' });
    expect(res.status).toBe(200);
    const stored = storedOf(world, ID);
    expect(stored !== undefined && 'housingAuthority' in stored).toBe(false);
    expect(stored?.['agency']).toBe('');
  });

  it('(PIN) an unknown contact 404s before any 422', async () => {
    const { app } = makeWebhookHarness();
    const res = await patchContact(app, 'contact-nope', { housingAuthority: 'Step Up' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'contact_not_found' });
  });

  it('(PIN) the parser type 400 still comes first', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);
    const res = await patchContact(app, ID, { housingAuthority: 5, agency: 'Atlanta Housing Authority' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/housingAuthority must be a string/);
  });
});

describe('POST /api/contacts - the organization fields stay ignored (spec section 9)', () => {
  it('(PIN) drops housingAuthority and agency instead of storing them unchecked', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        type: 'tenant',
        firstName: 'Pat',
        lastName: 'Q',
        housingAuthority: 'Nowhere Housing Authority',
        agency: 'Step Up',
        organization: 'Nowhere Org', // caseworkers spec D16: POST ignores organization too
      });
    expect(res.status).toBe(201);
    const stored = storedOf(world, res.body.contact.contactId);
    expect(stored).toBeDefined();
    expect(stored !== undefined && 'housingAuthority' in stored).toBe(false);
    expect(stored !== undefined && 'agency' in stored).toBe(false);
    expect(stored !== undefined && 'organization' in stored).toBe(false);
  });
});

describe('PATCH /api/contacts/:id - organization (caseworkers spec D17): D5 against BOTH lists', () => {
  const partner = { type: 'partner' as const, status: 'active' };

  it('stores an agency name or spelling as the exact entry name', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, partner);
    const res = await patchContact(app, ID, { organization: 'hope atlanta' });
    expect(res.status).toBe(200);
    expect(storedOf(world, ID)?.['organization']).toBe('HOPE Atlanta');
  });

  it('accepts a housing authority too (either kind)', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, partner);
    const res = await patchContact(app, ID, { organization: 'Atlanta Housing' });
    expect(res.status).toBe(200);
    expect(res.body.contact.organization).toBe('Atlanta Housing Authority');
  });

  it('refuses text on neither list: 422 org_not_on_list with field organization, nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { ...partner, organization: 'HOPE Atlanta' });
    const before = structuredClone(storedOf(world, ID));
    const res = await patchContact(app, ID, { organization: 'Nowhere Org', firstName: 'Pat' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'org_not_on_list', field: 'organization', text: 'Nowhere Org', candidates: [] });
    expect(res.body.otherKind).toBeUndefined(); // both kinds are accepted: never "other kind"
    expect(storedOf(world, ID)).toEqual(before);
  });

  it('refuses an ambiguous spelling naming both candidates', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, partner);
    const res = await patchContact(app, ID, { organization: 'AHA' });
    expect(res.status).toBe(422);
    expect(names(res.body.candidates)).toEqual(['Atlanta Housing Authority', 'Augusta Housing Authority']);
  });

  it("(PIN-shaped) an unchanged off-list value passes; '' REMOVEs the attribute", async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { ...partner, organization: 'Old Helper Org' });
    expect((await patchContact(app, ID, { organization: 'Old Helper Org', firstName: 'Pat' })).status).toBe(200);
    expect((await patchContact(app, ID, { organization: '' })).status).toBe(200);
    expect('organization' in storedOf(world, ID)!).toBe(false);
  });

  it('a non-string is a parser 400', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, partner);
    const res = await patchContact(app, ID, { organization: 7 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('organization must be a string');
  });
});
