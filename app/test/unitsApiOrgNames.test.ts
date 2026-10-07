// Organization names on the unit writers (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D5). POST /api/units resolves EVERY accepted_authorities member against the
// stored org list - a new unit holds nothing yet. The harness org-list fake
// serves the starting list (spec Appendix A) on its first read.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

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
