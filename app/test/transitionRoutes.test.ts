// Status-model transition ROUTES (supertest) — happy paths + 400/404 + 401
// unauthenticated + no-PII-on-the-wire, on the shared in-memory world via the
// harness (authed by the real sealed session cookie next to the origin secret).
// Mirrors placementsApi.test.ts's auth/harness conventions.
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
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant', firstName: 'Tasha', lastName: 'Nguyen' });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
  });

  const authedPost = (path: string, body: object) =>
    request(app).post(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).send(body);
  const authedPatch = (path: string, body: object) =>
    request(app).patch(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).send(body);
  const authedGet = (path: string) =>
    request(app).get(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

  it('rejects unauthenticated requests (401/403)', async () => {
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    const res = await request(app)
      .post(`/api/placements/${c.placementId}/transition`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .send({ toStage: 'collect_rta', source: 'manual' });
    expect([401, 403]).toContain(res.status);
  });

  describe('POST /api/placements/:placementId/transition', () => {
    it('transitions the placement and returns the placement; derivation flows to the world', async () => {
      const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
      const res = await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'awaiting_approval', source: 'manual' });
      expect(res.status).toBe(200);
      expect(res.body.placement.stage).toBe('awaiting_approval');
      expect(res.body.placement.stage_source).toBe('manual');
      expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('under_application');
    });

    it('400s a bad stage / bad source / bad lostReason category / non-positive finalRent', async () => {
      const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
      expect((await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'bogus', source: 'manual' })).status).toBe(400);
      expect((await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'collect_rta', source: 'robot' })).status).toBe(400);
      expect((await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'lost', source: 'manual', lostReason: { category: 'nope' } })).status).toBe(400);
      expect((await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'awaiting_rent_acceptance', source: 'manual', finalRent: -1 })).status).toBe(400);
      // Fix #5: a $0 accepted rent is invalid for billing → 400.
      expect((await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'awaiting_rent_acceptance', source: 'manual', finalRent: 0 })).status).toBe(400);
      expect((await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'awaiting_rent_acceptance', source: 'manual', finalRent: Number.NaN })).status).toBe(400);
    });

    it('400s a lost move with no reason (§7: pick OR write — a reason is always captured)', async () => {
      const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
      // No lostReason at all.
      expect((await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'lost', source: 'manual' })).status).toBe(400);
      // Empty object.
      expect((await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'lost', source: 'manual', lostReason: {} })).status).toBe(400);
      // Whitespace-only text (no category) is not a real reason.
      expect((await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'lost', source: 'manual', lostReason: { text: '   ' } })).status).toBe(400);
      // A category alone is fine.
      expect((await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'lost', source: 'manual', lostReason: { category: 'stalled' } })).status).toBe(200);
    });

    it('records the actor (userId) on the placement_stage_changed audit row (byActor GSI)', async () => {
      const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
      await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'collect_rta', source: 'manual' });
      const audit = world.auditEvents.find((a) => a.event_type === 'placement_stage_changed');
      expect(audit).toBeDefined();
      // The seeded session is the VA user; the route forwards req.user.userId.
      expect(typeof (audit!.payload as { actor?: unknown }).actor).toBe('string');
      expect((audit!.payload as { actor: string }).actor.length).toBeGreaterThan(0);
    });

    it('404s an unknown placement', async () => {
      expect((await authedPost('/api/placements/placement-ghost/transition', { toStage: 'collect_rta', source: 'manual' })).status).toBe(404);
    });

    it("writes inspection_outcome on the inspection-complete move (awaiting_inspection → determine_rent)", async () => {
      const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
      const res = await authedPost(`/api/placements/${c.placementId}/transition`, {
        toStage: 'determine_rent',
        source: 'manual',
        inspectionOutcome: 'pass',
      });
      expect(res.status).toBe(200);
      expect(res.body.placement.inspection_outcome).toBe('pass');
    });

    it('400s an invalid inspectionOutcome at the route', async () => {
      const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
      const res = await authedPost(`/api/placements/${c.placementId}/transition`, {
        toStage: 'determine_rent',
        source: 'manual',
        inspectionOutcome: 'maybe',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('inspectionOutcome must be pass or fail');
    });

    it('accepts inspectionDate on the schedule_inspection → awaiting_inspection move and persists it', async () => {
      const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'schedule_inspection' });
      const res = await authedPost(`/api/placements/${c.placementId}/transition`, {
        toStage: 'awaiting_inspection',
        source: 'manual',
        inspectionDate: '2026-07-20',
      });
      expect(res.status).toBe(200);
      expect(res.body.placement.inspection_date).toBe('2026-07-20');
    });

    it('400s an empty inspectionDate at the route', async () => {
      const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'schedule_inspection' });
      const res = await authedPost(`/api/placements/${c.placementId}/transition`, {
        toStage: 'awaiting_inspection',
        source: 'manual',
        inspectionDate: '',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('inspectionDate must be a non-empty date string');
    });

    it('400s a non-positive / non-numeric rentDetermined at the route', async () => {
      const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'determine_rent' });
      expect((await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'awaiting_rent_acceptance', source: 'manual', rentDetermined: 0 })).status).toBe(400);
      expect((await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'awaiting_rent_acceptance', source: 'manual', rentDetermined: -5 })).status).toBe(400);
      const nan = await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'awaiting_rent_acceptance', source: 'manual', rentDetermined: 'lots' });
      expect(nan.status).toBe(400);
      expect(nan.body.error).toBe('rentDetermined must be a finite number > 0');
    });

    it('records a lost transition with the structured reason; emits placement.updated WITHOUT the free text (no PII)', async () => {
      const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
      const res = await authedPost(`/api/placements/${c.placementId}/transition`, {
        toStage: 'lost',
        source: 'manual',
        lostReason: { category: 'tenant_withdrew', text: 'moved out of state — secret note' },
      });
      expect(res.status).toBe(200);
      expect(res.body.placement.lost_reason).toEqual({ category: 'tenant_withdrew', text: 'moved out of state — secret note' });
      const evt = world.emitted.filter((e) => e.event === 'placement.updated').at(-1);
      expect(evt).toBeDefined();
      // The wire payload carries the bounded category only — never the free text.
      const json = JSON.stringify(evt!.payload);
      expect(json).toContain('tenant_withdrew');
      expect(json).not.toContain('secret note');
    });
  });

  describe('PATCH /api/contacts/:contactId/tenant-status', () => {
    it('sets the tenant status (happy path); → searching has NO RTA gate (2026-06-19)', async () => {
      const ok = await authedPatch('/api/contacts/tenant-1/tenant-status', { toStatus: 'searching', source: 'manual' });
      expect(ok.status).toBe(200);
      expect(ok.body.contact.status).toBe('searching');

      // The RTA-in-hand gate was removed: a tenant with NO rta_in_hand (and even
      // porting:true) is no longer refused — → searching succeeds (200, never 409).
      await world.contactsRepo.create({ contactId: 't-no-rta', type: 'tenant', porting: true });
      const allowed = await authedPatch('/api/contacts/t-no-rta/tenant-status', { toStatus: 'searching', source: 'manual' });
      expect(allowed.status).toBe(200);
      expect(allowed.body.contact.status).toBe('searching');
    });

    it('400s a bad status/source; 404s an unknown contact', async () => {
      expect((await authedPatch('/api/contacts/tenant-1/tenant-status', { toStatus: 'bogus', source: 'manual' })).status).toBe(400);
      expect((await authedPatch('/api/contacts/tenant-1/tenant-status', { toStatus: 'placing', source: 'robot' })).status).toBe(400);
      expect((await authedPatch('/api/contacts/c-ghost/tenant-status', { toStatus: 'placing', source: 'manual' })).status).toBe(404);
    });

    // A tenant still accepts its full §5 lifecycle — the type-scoped guard must
    // NOT regress the tenant path (on_hold/inactive stay valid tenant statuses).
    it('a TENANT still accepts on_hold/inactive (no regression from the type-scoped guard)', async () => {
      const held = await authedPatch('/api/contacts/tenant-1/tenant-status', { toStatus: 'on_hold', source: 'manual' });
      expect(held.status).toBe(200);
      expect(held.body.contact.status).toBe('on_hold');
      const gone = await authedPatch('/api/contacts/tenant-1/tenant-status', { toStatus: 'inactive', source: 'manual' });
      expect(gone.status).toBe(200);
      expect(gone.body.contact.status).toBe('inactive');
    });

    // Landlord lead lifecycle (docs/issues/landlord-lead-status-and-park.md):
    // a landlord validates against LANDLORD_STATUSES on this route (the leak was
    // that it only checked isTenantStatus, so a landlord wrongly took on_hold/
    // inactive and rejected parked).
    describe('landlord lead lifecycle', () => {
      beforeEach(async () => {
        await world.contactsRepo.create({ contactId: 'll-1', type: 'landlord', status: 'needs_review' });
      });

      it('accepts interested / onboarding / active / needs_review for a landlord', async () => {
        // 'onboarding' is the new signed-landlord status; it validates against
        // LANDLORD_STATUSES automatically (statusAllowlistFor(type)) - no route
        // change (landlord-status-onboarding design S3).
        for (const toStatus of ['interested', 'onboarding', 'active', 'needs_review'] as const) {
          const res = await authedPatch('/api/contacts/ll-1/tenant-status', { toStatus, source: 'manual' });
          expect(res.status, toStatus).toBe(200);
          expect(res.body.contact.status, toStatus).toBe(toStatus);
        }
      });

      it('parks a landlord FROM onboarding, persisting the supplied reason as park_reason (E2)', async () => {
        // A signed landlord can still back out: parked is reachable from ANY
        // state incl. onboarding, and the park move persists the reason.
        const onb = await authedPatch('/api/contacts/ll-1/tenant-status', { toStatus: 'onboarding', source: 'manual' });
        expect(onb.status).toBe(200);
        expect(onb.body.contact.status).toBe('onboarding');

        const res = await authedPatch('/api/contacts/ll-1/tenant-status', {
          toStatus: 'parked',
          source: 'manual',
          reason: 'signed then backed out - sold the building',
        });
        expect(res.status).toBe(200);
        expect(res.body.contact.status).toBe('parked');
        expect(res.body.contact.park_reason).toBe('signed then backed out - sold the building');
        expect((await world.contactsRepo.getById('ll-1'))!.park_reason).toBe(
          'signed then backed out - sold the building',
        );
      });

      it('moves a landlord to parked and persists the supplied reason as park_reason', async () => {
        const res = await authedPatch('/api/contacts/ll-1/tenant-status', {
          toStatus: 'parked',
          source: 'manual',
          reason: 'declined — rent above payment standard',
        });
        expect(res.status).toBe(200);
        expect(res.body.contact.status).toBe('parked');
        expect(res.body.contact.park_reason).toBe('declined — rent above payment standard');
        // Persisted on the stored contact, not just echoed.
        expect((await world.contactsRepo.getById('ll-1'))!.park_reason).toBe('declined — rent above payment standard');
      });

      it('REJECTS tenant-only statuses (on_hold/inactive/searching) for a landlord with 400', async () => {
        for (const toStatus of ['on_hold', 'inactive', 'searching'] as const) {
          const res = await authedPatch('/api/contacts/ll-1/tenant-status', { toStatus, source: 'manual' });
          expect(res.status, toStatus).toBe(400);
        }
      });

      it('REJECTS an unknown status for a landlord with 400', async () => {
        expect((await authedPatch('/api/contacts/ll-1/tenant-status', { toStatus: 'bogus', source: 'manual' })).status).toBe(400);
      });
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

  describe('GET /api/placements/:placementId/history', () => {
    it('returns the placement provenance trail newest-first', async () => {
      const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
      await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'collect_rta', source: 'manual' });
      await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'review_rta', source: 'manual' });
      const res = await authedGet(`/api/placements/${c.placementId}/history`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.history)).toBe(true);
      expect(res.body.history.length).toBeGreaterThanOrEqual(2);
      // Newest-first: the most recent transition (→ review_rta) is first.
      expect(res.body.history[0].payload.to).toBe('review_rta');
    });

    it('401s unauthenticated', async () => {
      const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
      const res = await request(app).get(`/api/placements/${c.placementId}/history`).set('x-origin-verify', ORIGIN_SECRET);
      expect([401, 403]).toContain(res.status);
    });
  });
});
