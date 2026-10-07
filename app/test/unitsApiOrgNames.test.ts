// Organization names on the unit writers (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D5). POST /api/units resolves EVERY accepted_authorities member against the
// stored org list - a new unit holds nothing yet. PATCH passes the members the
// unit already holds (compared trimmed) and its legacy jurisdiction ONLY while
// it has no stored list (ruling R1-F1); every other member must resolve. The
// harness org-list fake serves the starting list (spec Appendix A) on its
// first read.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

function postUnit(app: import('express').Express, body: Record<string, unknown>) {
  return request(app)
    .post('/api/units')
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

/** The names of a 422's candidate / otherKind refs, sorted (order is not the contract). */
function names(refs: Array<{ name: string }>): string[] {
  return refs.map((r) => r.name).sort();
}

describe('POST /api/units - accepted_authorities (spec D5)', () => {
  it('(PIN) stores exact list names as is', async () => {
    const { app } = makeWebhookHarness();
    const res = await postUnit(app, {
      landlordId: 'contact-ll-1',
      accepted_authorities: ['Atlanta Housing Authority', 'Decatur Housing Authority'],
    });
    expect(res.status).toBe(201);
    expect(res.body.unit.accepted_authorities).toEqual(['Atlanta Housing Authority', 'Decatur Housing Authority']);
  });

  it('resolves a unique spelling to the exact name and de-duplicates the result', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await postUnit(app, {
      landlordId: 'contact-ll-1',
      accepted_authorities: ['Atlanta Housing Authority', 'Georgia DCA', 'Georgia Department of Community Affairs'],
    });
    expect(res.status).toBe(201);
    expect(res.body.unit.accepted_authorities).toEqual([
      'Atlanta Housing Authority',
      'Georgia Department of Community Affairs',
    ]);
    expect(world.units.get(res.body.unit.unitId)?.accepted_authorities).toEqual([
      'Atlanta Housing Authority',
      'Georgia Department of Community Affairs',
    ]);
  });

  it('refuses a member of the other kind: 422, nothing created, no audit row', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await postUnit(app, {
      landlordId: 'contact-ll-1',
      accepted_authorities: ['Atlanta Housing Authority', 'Step Up'],
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: 'org_not_on_list',
      field: 'accepted_authorities',
      text: 'Step Up',
      candidates: [],
    });
    expect(names(res.body.otherKind)).toEqual(['Step Up']);
    expect(world.units.size).toBe(0);
    expect(world.auditEvents).toHaveLength(0);
  });

  it('refuses an ambiguous spelling, naming both candidates', async () => {
    const { app } = makeWebhookHarness();
    const res = await postUnit(app, { landlordId: 'contact-ll-1', accepted_authorities: ['MHA'] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'org_not_on_list', field: 'accepted_authorities', text: 'MHA' });
    expect(names(res.body.candidates)).toEqual([
      'Macon-Bibb County Housing Authority',
      'Marietta Housing Authority',
    ]);
  });

  it('a tombstoned jurisdiction in the same body grants no pass (there is no stored unit)', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await postUnit(app, {
      landlordId: 'contact-ll-1',
      jurisdiction: 'Old Place',
      accepted_authorities: ['Old Place'],
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'org_not_on_list', field: 'accepted_authorities', text: 'Old Place' });
    expect(world.units.size).toBe(0);
  });

  it('(PIN) the validator 400 still comes first', async () => {
    const { app } = makeWebhookHarness();
    const res = await postUnit(app, { landlordId: 'contact-ll-1', accepted_authorities: ['Step Up', 7] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'accepted_authorities must be an array of strings' });
  });
});

const STAMP = '2026-10-06T09:00:00.000Z';

function seedUnit(world: FakeWorld, unitId: string, overrides: Partial<UnitItem> = {}): void {
  world.units.set(unitId, {
    unitId,
    landlordId: 'contact-ll-1',
    status: 'available',
    beds: 2,
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  });
}

function patchUnit(app: import('express').Express, unitId: string, body: Record<string, unknown>) {
  return request(app)
    .patch(`/api/units/${unitId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

describe('PATCH /api/units/:id - accepted_authorities (spec D5)', () => {
  it('keeps members the unit already holds (even off-list) and resolves the new ones', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-held', { accepted_authorities: ['atlanta_housing'] });
    const res = await patchUnit(app, 'u-held', { accepted_authorities: ['atlanta_housing', 'GA DCA'] });
    expect(res.status).toBe(200);
    expect(world.units.get('u-held')?.accepted_authorities).toEqual([
      'atlanta_housing',
      'Georgia Department of Community Affairs',
    ]);
  });

  it('refuses a new member that is not on the list: 422, the unit is untouched', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-new', { accepted_authorities: ['Atlanta Housing Authority'] });
    const res = await patchUnit(app, 'u-new', {
      accepted_authorities: ['Atlanta Housing Authority', 'Nowhere Housing Authority'],
      beds: 3,
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: 'org_not_on_list',
      field: 'accepted_authorities',
      text: 'Nowhere Housing Authority',
    });
    const stored = world.units.get('u-new');
    expect(stored?.accepted_authorities).toEqual(['Atlanta Housing Authority']);
    expect(stored?.beds).toBe(2);
    expect(stored?.updated_at).toBe(STAMP);
    expect(world.auditEvents).toHaveLength(0);
  });

  it('(PIN) the legacy jurisdiction passes while the unit has NO stored list (the synthesized form value)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-legacy', { jurisdiction: 'Old Place' });
    const res = await patchUnit(app, 'u-legacy', { accepted_authorities: ['Old Place', 'Atlanta Housing Authority'] });
    expect(res.status).toBe(200);
    expect(world.units.get('u-legacy')?.accepted_authorities).toEqual(['Old Place', 'Atlanta Housing Authority']);
  });

  it('a STORED list, even an empty one, ends the legacy jurisdiction pass (ruling R1-F1)', async () => {
    // 'Fulton' is a bare legacy value that no entry name or spelling equals.
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-cleared', { accepted_authorities: [], jurisdiction: 'Fulton' });
    const res = await patchUnit(app, 'u-cleared', { accepted_authorities: ['Fulton'] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'org_not_on_list', field: 'accepted_authorities', text: 'Fulton' });
    expect(world.units.get('u-cleared')?.accepted_authorities).toEqual([]);
  });

  it('(PIN) a held member padded in storage still counts as held (compared trimmed)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-padded', { accepted_authorities: [' Old Place '] });
    const res = await patchUnit(app, 'u-padded', { accepted_authorities: ['Old Place'] });
    expect(res.status).toBe(200);
    expect(world.units.get('u-padded')?.accepted_authorities).toEqual(['Old Place']);
  });

  it('(PIN) an unknown unit 404s before any 422', async () => {
    const { app } = makeWebhookHarness();
    const res = await patchUnit(app, 'unit-nope', { accepted_authorities: ['Step Up'] });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unit_not_found' });
  });

  it('(PIN) a PATCH without accepted_authorities leaves an off-list list alone', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-other', { accepted_authorities: ['Nowhere Housing Authority'] });
    const res = await patchUnit(app, 'u-other', { beds: 4 });
    expect(res.status).toBe(200);
    expect(world.units.get('u-other')?.accepted_authorities).toEqual(['Nowhere Housing Authority']);
  });

  it('decides what the unit already holds from a CONSISTENT read', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-read', { accepted_authorities: ['Atlanta Housing Authority'] });
    const getById = vi.spyOn(world.unitsRepo, 'getById');
    const res = await patchUnit(app, 'u-read', { accepted_authorities: ['Atlanta Housing Authority'] });
    expect(res.status).toBe(200);
    expect(getById).toHaveBeenCalledWith('u-read', { consistentRead: true });
  });
});
