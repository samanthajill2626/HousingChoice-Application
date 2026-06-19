// Status-model transition ROUTES (supertest) — happy paths + 400/404/409 + 401
// unauthenticated + no-PII-on-the-wire, on the shared in-memory world via the
// harness (authed by the real sealed session cookie next to the origin secret).
// Mirrors casesApi.test.ts's auth/harness conventions.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';

describe('status-model transition routes', () => {
  let app: Express;
  let world: FakeWorld;

  beforeEach(async () => {
    const h = makeWebhookHarness();
    app = h.app;
    world = h.world;
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant', rta_in_hand: true, firstName: 'Tasha', lastName: 'Nguyen' });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
  });

  const authedPost = (path: string, body: object) =>
    request(app).post(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).send(body);
  const authedPatch = (path: string, body: object) =>
    request(app).patch(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).send(body);
  const authedGet = (path: string) =>
    request(app).get(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

  it('rejects unauthenticated requests (401/403)', async () => {
    const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    const res = await request(app)
      .post(`/api/cases/${c.caseId}/transition`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .send({ toStage: 'collect_rta', source: 'manual' });
    expect([401, 403]).toContain(res.status);
  });

  describe('POST /api/cases/:caseId/transition', () => {
    it('transitions the placement and returns the case; derivation flows to the world', async () => {
      const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
      const res = await authedPost(`/api/cases/${c.caseId}/transition`, { toStage: 'awaiting_approval', source: 'manual' });
      expect(res.status).toBe(200);
      expect(res.body.case.stage).toBe('awaiting_approval');
      expect(res.body.case.stage_source).toBe('manual');
      expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('under_application');
    });

    it('400s a bad stage / bad source / bad lostReason category / non-positive finalRent', async () => {
      const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
      expect((await authedPost(`/api/cases/${c.caseId}/transition`, { toStage: 'bogus', source: 'manual' })).status).toBe(400);
      expect((await authedPost(`/api/cases/${c.caseId}/transition`, { toStage: 'collect_rta', source: 'robot' })).status).toBe(400);
      expect((await authedPost(`/api/cases/${c.caseId}/transition`, { toStage: 'lost', source: 'manual', lostReason: { category: 'nope' } })).status).toBe(400);
      expect((await authedPost(`/api/cases/${c.caseId}/transition`, { toStage: 'awaiting_rent_acceptance', source: 'manual', finalRent: -1 })).status).toBe(400);
      // Fix #5: a $0 accepted rent is invalid for billing → 400.
      expect((await authedPost(`/api/cases/${c.caseId}/transition`, { toStage: 'awaiting_rent_acceptance', source: 'manual', finalRent: 0 })).status).toBe(400);
      expect((await authedPost(`/api/cases/${c.caseId}/transition`, { toStage: 'awaiting_rent_acceptance', source: 'manual', finalRent: Number.NaN })).status).toBe(400);
    });

    it('400s a lost move with no reason (§7: pick OR write — a reason is always captured)', async () => {
      const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
      // No lostReason at all.
      expect((await authedPost(`/api/cases/${c.caseId}/transition`, { toStage: 'lost', source: 'manual' })).status).toBe(400);
      // Empty object.
      expect((await authedPost(`/api/cases/${c.caseId}/transition`, { toStage: 'lost', source: 'manual', lostReason: {} })).status).toBe(400);
      // Whitespace-only text (no category) is not a real reason.
      expect((await authedPost(`/api/cases/${c.caseId}/transition`, { toStage: 'lost', source: 'manual', lostReason: { text: '   ' } })).status).toBe(400);
      // A category alone is fine.
      expect((await authedPost(`/api/cases/${c.caseId}/transition`, { toStage: 'lost', source: 'manual', lostReason: { category: 'stalled' } })).status).toBe(200);
    });

    it('records the actor (userId) on the case_stage_changed audit row (byActor GSI)', async () => {
      const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
      await authedPost(`/api/cases/${c.caseId}/transition`, { toStage: 'collect_rta', source: 'manual' });
      const audit = world.auditEvents.find((a) => a.event_type === 'case_stage_changed');
      expect(audit).toBeDefined();
      // The seeded session is the VA user; the route forwards req.user.userId.
      expect(typeof (audit!.payload as { actor?: unknown }).actor).toBe('string');
      expect((audit!.payload as { actor: string }).actor.length).toBeGreaterThan(0);
    });

    it('404s an unknown case', async () => {
      expect((await authedPost('/api/cases/case-ghost/transition', { toStage: 'collect_rta', source: 'manual' })).status).toBe(404);
    });

    it('records a lost transition with the structured reason; emits case.updated WITHOUT the free text (no PII)', async () => {
      const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
      const res = await authedPost(`/api/cases/${c.caseId}/transition`, {
        toStage: 'lost',
        source: 'manual',
        lostReason: { category: 'tenant_withdrew', text: 'moved out of state — secret note' },
      });
      expect(res.status).toBe(200);
      expect(res.body.case.lost_reason).toEqual({ category: 'tenant_withdrew', text: 'moved out of state — secret note' });
      const evt = world.emitted.filter((e) => e.event === 'case.updated').at(-1);
      expect(evt).toBeDefined();
      // The wire payload carries the bounded category only — never the free text.
      const json = JSON.stringify(evt!.payload);
      expect(json).toContain('tenant_withdrew');
      expect(json).not.toContain('secret note');
    });
  });

  describe('PATCH /api/contacts/:contactId/tenant-status', () => {
    it('sets the tenant status (happy path) and 409s the RTA gate', async () => {
      // rta_in_hand:true → searching allowed.
      const ok = await authedPatch('/api/contacts/tenant-1/tenant-status', { toStatus: 'searching', source: 'manual' });
      expect(ok.status).toBe(200);
      expect(ok.body.contact.tenant_status).toBe('searching');

      // A tenant without rta_in_hand → 409.
      await world.contactsRepo.create({ contactId: 't-no-rta', type: 'tenant', rta_in_hand: false });
      const blocked = await authedPatch('/api/contacts/t-no-rta/tenant-status', { toStatus: 'searching', source: 'manual' });
      expect(blocked.status).toBe(409);
    });

    it('400s a bad status/source; 404s an unknown contact', async () => {
      expect((await authedPatch('/api/contacts/tenant-1/tenant-status', { toStatus: 'bogus', source: 'manual' })).status).toBe(400);
      expect((await authedPatch('/api/contacts/tenant-1/tenant-status', { toStatus: 'placing', source: 'robot' })).status).toBe(400);
      expect((await authedPatch('/api/contacts/c-ghost/tenant-status', { toStatus: 'placing', source: 'manual' })).status).toBe(404);
    });
  });

  describe('PATCH /api/units/:unitId/listing-status', () => {
    it('sets the listing status (happy path); 400 bad; 404 unknown', async () => {
      const res = await authedPatch('/api/units/unit-1/listing-status', { toStatus: 'on_hold', source: 'manual' });
      expect(res.status).toBe(200);
      expect(res.body.unit.status).toBe('on_hold');
      expect(res.body.unit.status_source).toBe('manual');
      expect((await authedPatch('/api/units/unit-1/listing-status', { toStatus: 'bogus', source: 'manual' })).status).toBe(400);
      expect((await authedPatch('/api/units/u-ghost/listing-status', { toStatus: 'on_hold', source: 'manual' })).status).toBe(404);
    });
  });

  describe('GET /api/cases/:caseId/history', () => {
    it('returns the placement provenance trail newest-first', async () => {
      const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
      await authedPost(`/api/cases/${c.caseId}/transition`, { toStage: 'collect_rta', source: 'manual' });
      await authedPost(`/api/cases/${c.caseId}/transition`, { toStage: 'review_rta', source: 'manual' });
      const res = await authedGet(`/api/cases/${c.caseId}/history`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.history)).toBe(true);
      expect(res.body.history.length).toBeGreaterThanOrEqual(2);
      // Newest-first: the most recent transition (→ review_rta) is first.
      expect(res.body.history[0].payload.to).toBe('review_rta');
    });

    it('401s unauthenticated', async () => {
      const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
      const res = await request(app).get(`/api/cases/${c.caseId}/history`).set('x-origin-verify', ORIGIN_SECRET);
      expect([401, 403]).toContain(res.status);
    });
  });
});
