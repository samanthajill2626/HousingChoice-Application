// The caseworker-review routes (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D19, D22; plan 3.5) through the full /api app on the harness world. The
// service's rules are proved in caseworkerConversion.test.ts; this file proves
// the wire: paths, route order, bodies, error shapes, and that the router got
// the world's units, placements and tours repos (a landlord-of-record refusal
// can only come from world.unitsRepo).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { phoneRefId } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const ID = 'c-api-1';

function seed(world: FakeWorld, over: Partial<ContactItem> = {}): void {
  world.contacts.push({
    contactId: ID, type: 'tenant', status: 'onboarding', phone: '+15550107501',
    firstName: 'Ana', lastName: 'Ruiz', ...over,
  } as ContactItem);
}

function get(app: import('express').Express, path: string) {
  return request(app).get(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
}

function post(app: import('express').Express, contactId: string, body: unknown) {
  return request(app)
    .post(`/api/contacts/${contactId}/caseworker-review`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body as object);
}

describe('GET /api/contacts/possible-caseworkers', () => {
  it('answers { rows } - registered before /:contactId, so the segment is not a contact id', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, { contactId: 'p-api', type: 'partner', status: 'active', lastName: 'Stamp-0710' });
    const res = await get(app, '/api/contacts/possible-caseworkers');
    expect(res.status).toBe(200);
    expect(res.body.rows).toContainEqual(expect.objectContaining({
      contactId: 'p-api', type: 'partner', signals: ['partner_no_role'],
    }));
  });

  it('(PIN) GET /api/contacts/vocabulary still answers', async () => {
    const { app } = makeWebhookHarness();
    expect((await get(app, '/api/contacts/vocabulary')).status).toBe(200);
  });
});

describe('GET /api/contacts/:contactId/caseworker-review/preview', () => {
  it('answers the preview, refusals included', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world);
    world.units.set('u-api', { unitId: 'u-api', status: 'available', landlordId: ID } as UnitItem);
    const res = await get(app, `/api/contacts/${ID}/caseworker-review/preview`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      contactId: ID,
      alreadyCaseworker: false,
      refusals: [{ code: 'caseworker_landlord_of_record', unitId: 'u-api' }],
      removes: { pendingSuggestions: 0 },
      threads: { retype: 0, leftShared: 0, leftOther: 0 },
      organization: { source: 'none' },
    });
  });

  it('404s a missing contact and a pointer id; 400s a team member', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world);
    await world.contactsRepo.addPhone(ID, { phone: '+15550107502' });
    seed(world, { contactId: 'c-team', type: 'team_member', status: 'active', phone: '+15550107503' });
    expect((await get(app, '/api/contacts/c-none/caseworker-review/preview')).body).toEqual({ error: 'contact_not_found' });
    const ptr = await get(app, `/api/contacts/${encodeURIComponent(phoneRefId('+15550107502'))}/caseworker-review/preview`);
    expect([ptr.status, ptr.body]).toEqual([404, { error: 'contact_not_found' }]);
    const team = await get(app, '/api/contacts/c-team/caseworker-review/preview');
    expect([team.status, team.body]).toEqual([400, { error: 'caseworker_team_member' }]);
  });
});

describe("POST /api/contacts/:contactId/caseworker-review { action: 'make' }", () => {
  it('converts and answers { contact }; the record and the audit name the session user', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, { agency: 'Hope Atlanta' });
    const res = await post(app, ID, { action: 'make' });
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({
      contactId: ID, type: 'partner', role: 'Caseworker', status: 'active', organization: 'HOPE Atlanta',
      caseworker_conversion: { by: TEST_SESSION_USER.userId, fromType: 'tenant', agency: 'Hope Atlanta' },
    });
    expect(world.auditEvents.find((e) => e.event_type === 'contact_updated')?.actorId).toBe(TEST_SESSION_USER.userId);
  });

  it('409 with the first refusal code and every refusal', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world);
    world.units.set('u-api', { unitId: 'u-api', status: 'available', landlordId: ID } as UnitItem);
    const res = await post(app, ID, { action: 'make' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'caseworker_landlord_of_record',
      refusals: [{ code: 'caseworker_landlord_of_record', unitId: 'u-api' }],
    });
  });

  it('422 org_not_on_list in A shape for an organization on neither list', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world);
    const res = await post(app, ID, { action: 'make', organization: 'Nowhere Org' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'org_not_on_list', field: 'organization', text: 'Nowhere Org' });
  });

  it('a staff pick wins over the derived organization', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, { agency: 'Hope Atlanta' });
    const res = await post(app, ID, { action: 'make', organization: 'Step Up' });
    expect(res.body.contact.organization).toBe('Step Up');
  });
});

describe("POST /api/contacts/:contactId/caseworker-review { action: 'dismiss' }", () => {
  it('dismisses and answers { contact }; the row leaves the Possible list', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, { type: 'partner', status: 'active' });
    const res = await post(app, ID, { action: 'dismiss' });
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({ contactId: ID, caseworker_review: 'dismissed' });
    const list = await get(app, '/api/contacts/possible-caseworkers');
    expect(list.body.rows.map((r: { contactId: string }) => r.contactId)).not.toContain(ID);
  });

  it('400 caseworker_dismiss_not_allowed on an unknown; 404 on a missing contact', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, { type: 'unknown', status: 'needs_review' });
    expect((await post(app, ID, { action: 'dismiss' })).body).toEqual({ error: 'caseworker_dismiss_not_allowed' });
    const missing = await post(app, 'c-none', { action: 'dismiss' });
    expect([missing.status, missing.body]).toEqual([404, { error: 'contact_not_found' }]);
  });
});

describe('POST /api/contacts/:contactId/caseworker-review - body validation', () => {
  for (const body of [
    {},
    { action: 'convert' },
    { action: 'make', organization: 7 },
    { action: 'make', organization: null },
    { action: 'make', actor: 'client-forged' },
    { action: 'dismiss', organization: null },
    { action: 'make', type: 'partner' },
    { action: 'dismiss', organization: 'Step Up' },
    { action: 'dismiss', note: 'x' },
    ['make'],
  ]) {
    it(`400 invalid_body for ${JSON.stringify(body)}, nothing written`, async () => {
      const { app, world } = makeWebhookHarness();
      seed(world, { type: 'partner', status: 'active' });
      const before = structuredClone(world.contacts);
      const res = await post(app, ID, body);
      expect([res.status, res.body]).toEqual([400, { error: 'invalid_body' }]);
      expect(world.contacts).toEqual(before);
    });
  }
});


describe('caseworker route boundary pins', () => {
  for (const path of ['/possible-caseworkers', '/' + ID + '/caseworker-review/preview']) {
    it('requires a signed-in user for GET ' + path, async () => {
      const { app } = makeWebhookHarness();
      const res = await request(app).get('/api/contacts' + path).set('x-origin-verify', ORIGIN_SECRET);
      expect(res.status).toBe(401);
    });
  }
  for (const action of ['make', 'dismiss']) {
    it('requires a signed-in user for ' + action, async () => {
      const { app, world } = makeWebhookHarness();
      seed(world);
      const before = structuredClone(world.contacts);
      const res = await request(app).post('/api/contacts/' + ID + '/caseworker-review')
        .set('x-origin-verify', ORIGIN_SECRET).send({ action });
      expect(res.status).toBe(401);
      expect(world.contacts).toEqual(before);
    });
  }
  it('passes an explicit empty organization through to removal', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, { organization: 'Step Up', agency: 'Hope Atlanta' });
    const res = await post(app, ID, { action: 'make', organization: '' });
    expect(res.status).toBe(200);
    expect(res.body.contact).not.toHaveProperty('organization');
  });
  it('preview and make refuse a deleted contact', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, { deleted_at: '2026-10-08T00:00:00.000Z' });
    for (const res of [await get(app, '/api/contacts/' + ID + '/caseworker-review/preview'), await post(app, ID, { action: 'make' })]) {
      expect([res.status, res.body]).toEqual([404, { error: 'contact_not_found' }]);
    }
  });
});
