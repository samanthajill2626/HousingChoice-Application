// Status-model transition ROUTES (supertest) — happy paths + 400/404 + 401
// unauthenticated + no-PII-on-the-wire, on the shared in-memory world via the
// harness (authed by the real sealed session cookie next to the origin secret).
// Mirrors placementsApi.test.ts's auth/harness conventions.
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

    // The dashboard moves stages THROUGH THIS ROUTE, so the dual-party
    // milestone (contact-comms-pane) is pinned here end-to-end, not only at the
    // service level: a landlord's contact timeline must carry the placement
    // stage moves of their own property.
    it('records the stage_changed milestone for the tenant AND the unit landlord', async () => {
      const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
      const res = await authedPost(`/api/placements/${c.placementId}/transition`, { toStage: 'collect_rta', source: 'manual' });
      expect(res.status).toBe(200);
      const ev = world.activityEvents.filter((e) => e.type === 'stage_changed');
      expect(ev).toHaveLength(2);
      expect(ev.map((e) => e.contactId).sort()).toEqual(['ll-1', 'tenant-1']);
      for (const e of ev) {
        expect(e).toMatchObject({ refType: 'placement', refId: c.placementId });
      }
    });

    it('records the placement_closed milestone for both parties on a terminal move', async () => {
      const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
      const res = await authedPost(`/api/placements/${c.placementId}/transition`, {
        toStage: 'lost',
        source: 'manual',
        lostReason: { category: 'stalled' },
      });
      expect(res.status).toBe(200);
      const ev = world.activityEvents.filter((e) => e.type === 'placement_closed');
      expect(ev).toHaveLength(2);
      expect(ev.map((e) => e.contactId).sort()).toEqual(['ll-1', 'tenant-1']);
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

    // unknown-inactive spec D2 + section 5 test 2 (rulings AR3, AR4): every
    // contact type moves through this route; the write is conditioned on the
    // type the route's check read; every success notifies open pages.
    describe('every contact type: Inactive, the conditional write, contact.updated', () => {
      let notified: unknown[];
      // Built, never written as an escape: the Edit/Write tools decode
      // backslash-u escapes (plan section 5; caseworkerConversion.test.ts:593).
      const ARROW = String.fromCharCode(0x2192);

      beforeEach(async () => {
        await world.contactsRepo.create({ contactId: 'pt-1', type: 'partner', status: 'active' });
        await world.contactsRepo.create({ contactId: 'tm-1', type: 'team_member', status: 'active' });
        await world.contactsRepo.create({ contactId: 'uk-1', type: 'unknown', status: 'needs_review' });
        notified = [];
        world.events.on('contact.updated', (payload) => notified.push(payload));
      });

      it('(PIN after S1) accepts inactive for partner, team_member and unknown: status_source manual, the audit, a typed timeline label', async () => {
        const cases = [
          { contactId: 'pt-1', from: 'active' },
          { contactId: 'tm-1', from: 'active' },
          { contactId: 'uk-1', from: 'needs_review' },
        ] as const;
        for (const { contactId, from } of cases) {
          const res = await authedPatch(`/api/contacts/${contactId}/tenant-status`, { toStatus: 'inactive', source: 'manual' });
          expect(res.status, contactId).toBe(200);
          expect(res.body.contact.status, contactId).toBe('inactive');
          expect(res.body.contact.status_source, contactId).toBe('manual');
          expect((await world.contactsRepo.getById(contactId))?.status, contactId).toBe('inactive');
          const audit = world.auditEvents.filter(
            (a) => a.entityKey === `contacts#${contactId}` && a.event_type === 'tenant_status_changed',
          );
          expect(audit, contactId).toHaveLength(1);
          expect(audit[0]!.payload, contactId).toMatchObject({ from, to: 'inactive', source: 'manual' });
          // The seeded session's userId rides on the audit row (byActor GSI).
          expect(typeof (audit[0]!.payload as { actor?: unknown }).actor, contactId).toBe('string');
          const timeline = world.activityEvents.filter(
            (e) => e.contactId === contactId && e.type === 'contact_status_changed',
          );
          // The partner map labels partner + team_member; the unknown map
          // labels unknown (S1 statusLabelFor). Both read "Inactive".
          expect(timeline.map((e) => e.label), contactId).toEqual([`Status ${ARROW} Inactive`]);
        }
      });

      it('emits contact.updated { contactId } on every successful call, every type, a same-status call included', async () => {
        await authedPatch('/api/contacts/uk-1/tenant-status', { toStatus: 'inactive', source: 'manual' });
        await authedPatch('/api/contacts/tenant-1/tenant-status', { toStatus: 'searching', source: 'manual' });
        await authedPatch('/api/contacts/pt-1/tenant-status', { toStatus: 'active', source: 'manual' });
        expect(notified).toEqual([{ contactId: 'uk-1' }, { contactId: 'tenant-1' }, { contactId: 'pt-1' }]);
      });

      it('(PIN) emits nothing on a refused call (400 status illegal for the type, 404 unknown contact)', async () => {
        expect((await authedPatch('/api/contacts/uk-1/tenant-status', { toStatus: 'searching', source: 'manual' })).status).toBe(400);
        expect((await authedPatch('/api/contacts/c-ghost/tenant-status', { toStatus: 'inactive', source: 'manual' })).status).toBe(404);
        expect(notified).toEqual([]);
      });

      it('the route check reads the stored contact strongly consistent (plan round 1 P12)', async () => {
        // The edit form follows a type-change PATCH at once with this route
        // (S4.4); an eventually consistent check read could still see the old
        // type and 400 or 409 a status the PATCH already made legal.
        const getById = vi.spyOn(world.contactsRepo, 'getById');
        const res = await authedPatch('/api/contacts/uk-1/tenant-status', { toStatus: 'inactive', source: 'manual' });
        expect(res.status).toBe(200);
        // The first read of the request is the route's check read.
        expect(getById).toHaveBeenNthCalledWith(1, 'uk-1', { consistentRead: true });
      });

      it('a re-type landing between the route check and the write is 409 contact_type_changed and writes nothing', async () => {
        // The route's check read sees `unknown` (inactive is legal); a
        // concurrent writer makes the contact a landlord right after it, so
        // the status write must not store (landlord, inactive). The fake
        // repo hands out its LIVE stored object, so the route gets a
        // snapshot and the re-type lands on the stored contact.
        const realGetById = world.contactsRepo.getById.bind(world.contactsRepo);
        let reads = 0;
        vi.spyOn(world.contactsRepo, 'getById').mockImplementation(async (id, opts) => {
          const hit = await realGetById(id, opts);
          if (id !== 'uk-1' || hit === undefined) return hit;
          reads += 1;
          if (reads !== 1) return hit;
          const snapshot = structuredClone(hit);
          hit.type = 'landlord';
          return snapshot;
        });

        const res = await authedPatch('/api/contacts/uk-1/tenant-status', { toStatus: 'inactive', source: 'manual' });

        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'contact_type_changed' });
        const stored = await world.contactsRepo.getById('uk-1');
        expect(stored?.type).toBe('landlord'); // the concurrent writer's type stands
        expect(stored?.status).toBe('needs_review'); // (landlord, inactive) was never stored
        expect(stored?.status_source).toBeUndefined();
        expect(
          world.auditEvents.filter((a) => a.entityKey === 'contacts#uk-1' && a.event_type === 'tenant_status_changed'),
        ).toEqual([]);
        expect(world.activityEvents.filter((e) => e.contactId === 'uk-1')).toEqual([]);
        expect(notified).toEqual([]);
      });
    });

    // Code review R1 FW1-1 (ADV-1), extending ruling AR4: the client names the
    // type its status list was built from (`expectedType`). A contact re-typed
    // since the page or form showed that list is 409 contact_type_changed,
    // decided BEFORE the allowlist check - so a pick that happens to be legal
    // for the new type is never written onto it - and nothing is written.
    // Absent: the route decides by the stored type alone (API callers).
    describe("the client's expectedType (FW1-1)", () => {
      let notified: unknown[];

      beforeEach(async () => {
        await world.contactsRepo.create({ contactId: 'pt-1', type: 'partner', status: 'active' });
        await world.contactsRepo.create({ contactId: 'uk-1', type: 'unknown', status: 'needs_review' });
        await world.contactsRepo.create({ contactId: 'll-2', type: 'landlord', status: 'interested' });
        notified = [];
        world.events.on('contact.updated', (payload) => notified.push(payload));
      });

      const statusAudits = (contactId: string) =>
        world.auditEvents.filter((a) => a.entityKey === `contacts#${contactId}` && a.event_type === 'tenant_status_changed');
      const statusMilestones = (contactId: string) =>
        world.activityEvents.filter((e) => e.contactId === contactId && e.type === 'contact_status_changed');

      it('a pick from a list built for another type is 409 contact_type_changed and writes nothing, even when the status is legal for the stored type', async () => {
        const res = await authedPatch('/api/contacts/pt-1/tenant-status', {
          toStatus: 'inactive',
          source: 'manual',
          expectedType: 'unknown',
        });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'contact_type_changed' });
        const stored = await world.contactsRepo.getById('pt-1');
        expect(stored).toMatchObject({ type: 'partner', status: 'active' });
        expect(stored?.status_source).toBeUndefined();
        expect(statusAudits('pt-1')).toEqual([]);
        expect(statusMilestones('pt-1')).toEqual([]);
        expect(notified).toEqual([]);
      });

      it('the mismatch is decided before the allowlist check: a pick illegal for the stored type is 409, not 400', async () => {
        const res = await authedPatch('/api/contacts/ll-2/tenant-status', {
          toStatus: 'inactive',
          source: 'manual',
          expectedType: 'unknown',
        });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'contact_type_changed' });
        expect(await world.contactsRepo.getById('ll-2')).toMatchObject({ type: 'landlord', status: 'interested' });
        expect(notified).toEqual([]);
      });

      it('(PIN) a matching expectedType writes as before: 200, the audit, the milestone, contact.updated', async () => {
        const res = await authedPatch('/api/contacts/uk-1/tenant-status', {
          toStatus: 'inactive',
          source: 'manual',
          expectedType: 'unknown',
        });
        expect(res.status).toBe(200);
        expect(res.body.contact).toMatchObject({ type: 'unknown', status: 'inactive', status_source: 'manual' });
        expect(statusAudits('uk-1')).toHaveLength(1);
        expect(statusMilestones('uk-1')).toHaveLength(1);
        expect(notified).toEqual([{ contactId: 'uk-1' }]);
      });

      it('400s an expectedType that is not a contact type and writes nothing', async () => {
        for (const expectedType of ['robot', '', 42, null, ['unknown']]) {
          const res = await authedPatch('/api/contacts/uk-1/tenant-status', {
            toStatus: 'inactive',
            source: 'manual',
            expectedType,
          });
          expect(res.status, JSON.stringify(expectedType)).toBe(400);
          expect(res.body, JSON.stringify(expectedType)).toEqual({ error: 'expectedType must be a contact type' });
        }
        expect(await world.contactsRepo.getById('uk-1')).toMatchObject({ type: 'unknown', status: 'needs_review' });
        expect(statusAudits('uk-1')).toEqual([]);
        expect(notified).toEqual([]);
      });

      it('(PIN) an absent expectedType keeps the route deciding by the stored type alone', async () => {
        const res = await authedPatch('/api/contacts/pt-1/tenant-status', { toStatus: 'inactive', source: 'manual' });
        expect(res.status).toBe(200);
        expect(res.body.contact).toMatchObject({ type: 'partner', status: 'inactive' });
      });

      // The adversarial reviewer's stale-client interleaving, as regressions:
      // the page or form showed an unknown contact's list, a colleague's
      // "Mark as" PATCH re-typed it, then the stale Inactive pick arrives.
      for (const [to, after] of [
        ['tenant', 'onboarding'],
        ['partner', 'active'],
        ['landlord', 'interested'],
      ] as const) {
        it(`an unknown contact re-typed to ${to} under an open page: the stale Inactive pick is 409 and the ${to} stays ${after}`, async () => {
          const retype = await authedPatch('/api/contacts/uk-1', { type: to });
          expect(retype.status).toBe(200);
          expect(retype.body.contact).toMatchObject({ type: to, status: after });
          // The re-type's own milestone and contact.updated are not the pick's.
          const milestonesBefore = statusMilestones('uk-1').length;
          notified = [];

          const res = await authedPatch('/api/contacts/uk-1/tenant-status', {
            toStatus: 'inactive',
            source: 'manual',
            expectedType: 'unknown',
          });

          expect(res.status).toBe(409);
          expect(res.body).toEqual({ error: 'contact_type_changed' });
          expect(await world.contactsRepo.getById('uk-1')).toMatchObject({ type: to, status: after });
          expect(statusAudits('uk-1')).toEqual([]);
          expect(statusMilestones('uk-1')).toHaveLength(milestonesBefore);
          expect(notified).toEqual([]);
        });
      }
    });
  });

  // Tracker #30 (D1/D6): the route validates toStatus against the stored
  // type's list. S1 pins the allowlist only; the write's source, audit,
  // timeline label, 409 and notify are pinned by S2.
  describe('PATCH /api/contacts/:contactId/tenant-status - non-tenant lists (tracker #30, D1/D6)', () => {
    it('REJECTS active for an unknown contact with 400 and writes nothing', async () => {
      await world.contactsRepo.create({ contactId: 'unk-1', type: 'unknown', status: 'needs_review' });
      const res = await authedPatch('/api/contacts/unk-1/tenant-status', { toStatus: 'active', source: 'manual' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('toStatus must be one of: needs_review, inactive');
      expect((await world.contactsRepo.getById('unk-1'))!.status).toBe('needs_review');
    });

    it('accepts inactive for a partner, a team member and an unknown contact', async () => {
      for (const [contactId, type, from] of [
        ['p-1', 'partner', 'active'],
        ['tm-1', 'team_member', 'active'],
        ['unk-2', 'unknown', 'needs_review'],
      ] as const) {
        await world.contactsRepo.create({ contactId, type, status: from });
        const res = await authedPatch(`/api/contacts/${contactId}/tenant-status`, { toStatus: 'inactive', source: 'manual' });
        expect(res.status, type).toBe(200);
        expect(res.body.contact.status, type).toBe('inactive');
        expect((await world.contactsRepo.getById(contactId))!.status, type).toBe('inactive');
      }
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
