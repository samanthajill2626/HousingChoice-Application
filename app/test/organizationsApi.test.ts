// /api/organizations (spec 2026-10-06 section 6, D10-D13; plan 3.4b, 3.5,
// 3.6): supertest over the shared harness with real sealed cookies - a VA
// (TEST_SESSION_COOKIE) and an admin (TEST_ADMIN_COOKIE) - and the world fakes
// (contacts, units, audit, the in-memory org list). Task 5.3 runs rewrites
// through the REAL in-process queue and the registered org.rewrite job (the
// broadcastApi.test.ts pattern): a 202, then settle(), then the records.
import request, { type Test } from 'supertest';
import { describe, expect, it } from 'vitest';
import { STARTING_ORG_LIST } from '../src/lib/orgStartingList.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { ATLANTA, AUGUSTA, DCA, STEP_UP, orgListItem, orgRef, runningRewrite } from './helpers/orgFixtures.js';
import { makeWebhookHarness, ORIGIN_SECRET, type Harness } from './helpers/twilioWebhookHarness.js';

const BASE = '/api/organizations';
const DELETED_AT = '2026-10-01T00:00:00.000Z';

/** Calls as one session (the CloudFront header and the session cookie set). */
function as(h: Harness, cookie: string) {
  const authed = (t: Test): Test => t.set('x-origin-verify', ORIGIN_SECRET).set('cookie', cookie);
  return {
    get: (path = '') => authed(request(h.app).get(`${BASE}${path}`)),
    post: (path: string, body: object = {}) => authed(request(h.app).post(`${BASE}${path}`)).send(body),
    patch: (path: string, body: object) => authed(request(h.app).patch(`${BASE}${path}`)).send(body),
    del: (path: string) => authed(request(h.app).delete(`${BASE}${path}`)),
  };
}

/** A harness whose org list is the five-entry fixture. */
async function harness(): Promise<Harness> {
  const h = makeWebhookHarness();
  await h.world.orgListRepo.putForSeed(orgListItem());
  return h;
}

function tenant(contactId: string, extra: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'tenant', status: 'searching', ...extra };
}

function property(unitId: string, extra: Partial<UnitItem> = {}): UnitItem {
  return { unitId, landlordId: 'l-1', status: 'available', ...extra };
}

describe('GET /api/organizations - both lists, for everyone', () => {
  it('a VA reads the lists; an empty store answers with the starting list', async () => {
    const h = makeWebhookHarness();
    const res = await as(h, TEST_SESSION_COOKIE).get();
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(res.body.entries.map((e: { name: string }) => e.name)).toEqual(STARTING_ORG_LIST.map((s) => s.name));
    expect(res.body).not.toHaveProperty('lastRewrite');
  });

  it('carries lastRewrite once one exists', async () => {
    const h = makeWebhookHarness();
    const last = runningRewrite({ action: 'clear', field: 'agency', fromTexts: ['x'] });
    await h.world.orgListRepo.putForSeed(orgListItem(undefined, { lastRewrite: last }));
    expect((await as(h, TEST_SESSION_COOKIE).get()).body.lastRewrite).toEqual(last);
  });

  it('(PIN) sits behind requireAuth', async () => {
    const h = makeWebhookHarness();
    expect((await request(h.app).get(BASE).set('x-origin-verify', ORIGIN_SECRET)).status).toBe(401);
  });
});

describe('GET /api/organizations/usage', () => {
  it('counts the records whose field of the entry kind holds the exact name, deleted ones beside them', async () => {
    const h = await harness();
    h.world.contacts.push(
      tenant('t-1', { housingAuthority: ATLANTA.name }),
      tenant('t-2', { housingAuthority: ATLANTA.name, deleted_at: DELETED_AT }),
      { contactId: 'p-1', type: 'partner', status: 'active', agency: STEP_UP.name },
    );
    h.world.units.set('u-1', property('u-1', { accepted_authorities: [ATLANTA.name] }));
    const res = await as(h, TEST_SESSION_COOKIE).get('/usage');
    expect(res.status).toBe(200);
    expect(res.body.usage['org-atl']).toEqual({ tenants: 1, otherContacts: 0, properties: 1, deleted: 1 });
    expect(res.body.usage['org-stepup']).toEqual({ tenants: 0, otherContacts: 1, properties: 0, deleted: 0 });
  });
});

describe('GET /api/organizations/not-on-list (+ /records) - for everyone', () => {
  it('lists the off-list values with their resolution and expands one value into its records', async () => {
    const h = await harness();
    h.world.contacts.push(tenant('t-1', { firstName: 'Tia', lastName: 'One', housingAuthority: 'AHA' }));
    h.world.units.set('u-1', property('u-1', { accepted_authorities: ['DCA'] }));
    const va = as(h, TEST_SESSION_COOKIE);
    const rows = await va.get('/not-on-list');
    expect(rows.status).toBe(200);
    expect(rows.body.rows).toEqual([
      {
        field: 'housingAuthority',
        value: 'AHA',
        count: 1,
        deletedCount: 0,
        resolution: { status: 'ambiguous', candidates: [orgRef(ATLANTA), orgRef(AUGUSTA)] },
      },
      {
        field: 'accepted_authorities',
        value: 'DCA',
        count: 1,
        deletedCount: 0,
        resolution: { status: 'match', match: orgRef(DCA) },
      },
    ]);
    const records = await va.get('/not-on-list/records').query({ field: 'housingAuthority', value: 'AHA' });
    expect(records.status).toBe(200);
    expect(records.body.records).toEqual([
      { kind: 'contact', contactId: 't-1', name: 'Tia One', type: 'tenant', deleted: false },
    ]);
  });

  it('a records request needs a known field and a value', async () => {
    const va = as(await harness(), TEST_SESSION_COOKIE);
    expect((await va.get('/not-on-list/records').query({ field: 'type', value: 'x' })).status).toBe(400);
    expect((await va.get('/not-on-list/records').query({ field: 'agency' })).status).toBe(400);
  });
});

describe('POST /api/organizations/check - for everyone', () => {
  it('answers the D4 resolution with the new-name and spelling problems', async () => {
    const va = as(await harness(), TEST_SESSION_COOKIE);
    const res = await va.post('/check', { kind: 'housing_authority', text: 'AHA', spellingFor: 'org-dca' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      candidates: [orgRef(ATLANTA), orgRef(AUGUSTA)],
      close: [],
      nameProblem: 'org_name_taken',
      spellingProblem: 'shared_same_kind',
    });
  });

  it('400s a bad kind or text and 404s an unknown spellingFor', async () => {
    const va = as(await harness(), TEST_SESSION_COOKIE);
    expect((await va.post('/check', { kind: 'county', text: 'x' })).status).toBe(400);
    expect((await va.post('/check', { kind: 'agency', text: 7 })).status).toBe(400);
    const missing = await va.post('/check', { kind: 'agency', text: 'x', spellingFor: 'org-nope' });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'org_not_found' });
  });

  it('refuses a text over 200 characters before any check runs (spec section 6)', async () => {
    const va = as(await harness(), TEST_SESSION_COOKIE);
    expect((await va.post('/check', { kind: 'agency', text: 'x'.repeat(201) })).status).toBe(400);
    expect((await va.post('/check', { kind: 'agency', text: 'x'.repeat(200) })).status).toBe(200);
  });
});
