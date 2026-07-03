// Placements + boards API (M1.10b) — CRUD, the board list filters (by stage /
// tenant / unit / tourDate), stage advance + tour clear via PATCH, the COMPUTED
// next_deadline_* serialization, and the manual follow_up deadline endpoint
// (placement-deadline-model). Runs on the shared in-memory world (the harness
// placementsRepo + placementDeadlinesRepo fakes), authed via the real sealed
// session cookie next to the origin secret.
import { beforeEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { toPlacementUpdatedEvent } from '../src/lib/events.js';
import type { PlacementItem } from '../src/repos/placementsRepo.js';
import { createPlacementsRouter } from '../src/routes/placements.js';
import type { StatusTransitionService } from '../src/services/statusTransition.js';

describe('placements API (M1.10b)', () => {
  let app: Express;
  let world: FakeWorld;

  beforeEach(() => {
    const h = makeWebhookHarness();
    app = h.app;
    world = h.world;
  });

  const authedGet = (path: string) =>
    request(app).get(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
  const authedPost = (path: string, body: object) =>
    request(app)
      .post(path)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send(body);
  const authedPatch = (path: string, body: object) =>
    request(app)
      .patch(path)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send(body);

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/placements').set('x-origin-verify', ORIGIN_SECRET);
    expect([401, 403]).toContain(res.status);
  });

  it('POST /api/placements opens a placement (default stage send_application), emits placement.updated, audits — no PII on the wire', async () => {
    await world.contactsRepo.create({ contactId: 'c-tenant', type: 'tenant', status: 'searching' });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
    const res = await authedPost('/api/placements', {
      tenantId: 'c-tenant',
      unitId: 'unit-1',
      placement_tag: 'Keisha @ 123 Main',
    });
    expect(res.status).toBe(201);
    expect(res.body.placement.placementId).toMatch(/^placement-/);
    expect(res.body.placement.stage).toBe('send_application');
    expect(res.body.placement.tenantId).toBe('c-tenant');
    expect(res.body.placement.placement_tag).toBe('Keisha @ 123 Main');
    // Coverage (#6): create initializes the INITIAL-stage provenance fields so
    // time-in-stage is computable from t0 and a later derived write respects
    // precedence (§8). stage is operator-set ⇒ source 'manual' (stage is NOT
    // precedence-gated, so 'manual' here is correct and intended).
    expect(typeof res.body.placement.stage_entered_at).toBe('string');
    expect(res.body.placement.stage_source).toBe('manual');
    expect(world.placements.size).toBe(1);

    const evt = world.emitted.find((e) => e.event === 'placement.updated');
    expect(evt).toBeDefined();
    // The compact event carries IDs/stage only — NEVER the placement_tag (a name).
    expect(JSON.stringify(evt!.payload)).not.toContain('Keisha');

    expect(world.auditEvents.some((a) => a.event_type === 'placement_created')).toBe(true);
  });

  it('POST /api/placements rejects missing tenantId/unitId and a bad stage', async () => {
    expect((await authedPost('/api/placements', { unitId: 'unit-1' })).status).toBe(400);
    expect((await authedPost('/api/placements', { tenantId: 'c-1' })).status).toBe(400);
    expect((await authedPost('/api/placements', { tenantId: 'c-1', unitId: 'u-1', stage: 'bogus' })).status).toBe(400);
  });

  it('POST /api/placements 404s (tenant_not_found) when the tenant does not exist — nothing persisted', async () => {
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
    const res = await authedPost('/api/placements', { tenantId: 'ghost-tenant', unitId: 'unit-1' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('tenant_not_found');
    expect(world.placements.size).toBe(0);
  });

  it('POST /api/placements 404s (unit_not_found) when the unit does not exist — nothing persisted', async () => {
    await world.contactsRepo.create({ contactId: 'c-real', type: 'tenant', status: 'searching' });
    const res = await authedPost('/api/placements', { tenantId: 'c-real', unitId: 'ghost-unit' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unit_not_found');
    expect(world.placements.size).toBe(0);
  });

  it('GET /api/placements/:placementId returns the placement; 404 for unknown', async () => {
    const c = await world.placementsRepo.create({ tenantId: 'c-1', unitId: 'u-1', stage: 'awaiting_inspection' });
    const res = await authedGet(`/api/placements/${c.placementId}`);
    expect(res.status).toBe(200);
    expect(res.body.placement.stage).toBe('awaiting_inspection');
    expect((await authedGet('/api/placements/placement-ghost')).status).toBe(404);
  });

  it('GET /api/placements filters by stage / tenant / unit / tourDate, lists all with no filter, 400s a bad allowlist value', async () => {
    await world.placementsRepo.create({ tenantId: 't-1', unitId: 'u-1', stage: 'awaiting_approval' });
    await world.placementsRepo.create({ tenantId: 't-1', unitId: 'u-2', stage: 'awaiting_inspection', tour_date: '2026-07-01' });
    await world.placementsRepo.create({ tenantId: 't-2', unitId: 'u-1', stage: 'awaiting_approval' });

    expect((await authedGet('/api/placements')).body.placements).toHaveLength(3);
    expect((await authedGet('/api/placements?stage=awaiting_approval')).body.placements).toHaveLength(2);
    expect((await authedGet('/api/placements?tenantId=t-1')).body.placements).toHaveLength(2);
    expect((await authedGet('/api/placements?unitId=u-1')).body.placements).toHaveLength(2);
    expect((await authedGet('/api/placements?tourDate=2026-07-01')).body.placements).toHaveLength(1);

    expect((await authedGet('/api/placements?stage=bogus')).status).toBe(400);
    // The ?deadlineType= filter is RETIRED (placement-deadline-model): an unknown
    // query param is simply ignored → the unfiltered list (200), never a 400.
    expect((await authedGet('/api/placements?deadlineType=whenever')).status).toBe(200);
    expect((await authedGet('/api/placements?tourDate=2026-13-45')).status).toBe(400); // impossible date
    expect((await authedGet('/api/placements?limit=0')).status).toBe(400);
    expect((await authedGet('/api/placements?cursor=not-base64-json')).status).toBe(400);
  });

  it('GET /api/placements serializes the COMPUTED soonest next_deadline_* (from placementDeadlines)', async () => {
    const p = await world.placementsRepo.create({ tenantId: 't', unitId: 'u-due', stage: 'awaiting_authority_approval' });
    // Two independent deadline items — the serializer picks the soonest.
    await world.placementDeadlinesRepo.arm(p.placementId, 'rta_window', '2026-06-16T08:00:00.000Z');
    await world.placementDeadlinesRepo.arm(p.placementId, 'voucher_expiration', '2026-09-01T00:00:00.000Z');
    // A second placement with no deadlines → null next_deadline.
    const bare = await world.placementsRepo.create({ tenantId: 't', unitId: 'u-bare', stage: 'send_application' });

    const res = await authedGet('/api/placements');
    expect(res.status).toBe(200);
    const rows = res.body.placements as Array<{ placementId: string; next_deadline_type?: string; next_deadline_at?: string }>;
    const dueRow = rows.find((r) => r.placementId === p.placementId)!;
    expect(dueRow.next_deadline_type).toBe('rta_window'); // soonest of the two
    expect(dueRow.next_deadline_at).toBe('2026-06-16T08:00:00.000Z');
    const bareRow = rows.find((r) => r.placementId === bare.placementId)!;
    expect(bareRow.next_deadline_type ?? null).toBeNull();
  });

  it('a TERMINAL placement with a straggler deadline serializes next_deadline_* as null (list + detail)', async () => {
    // A closed deal that still has a lingering deadline row (reachable via a
    // partial clearForPlacement failure or a voucher-sync↔terminal-transition
    // race). The serializer must treat a terminal placement as having NO
    // deadline — parity with today.ts's read-time TERMINAL_STAGES skip.
    const terminal = await world.placementsRepo.create({ tenantId: 't', unitId: 'u-term', stage: 'moved_in' });
    await world.placementDeadlinesRepo.arm(terminal.placementId, 'voucher_expiration', '2026-08-01T00:00:00.000Z');

    // List path (listAllPending → map).
    const list = await authedGet('/api/placements');
    expect(list.status).toBe(200);
    const listRow = (list.body.placements as Array<{ placementId: string; next_deadline_type?: string; next_deadline_at?: string }>)
      .find((r) => r.placementId === terminal.placementId)!;
    expect(listRow.next_deadline_type ?? null).toBeNull();
    expect(listRow.next_deadline_at ?? null).toBeNull();

    // Detail path (listByPlacement).
    const detail = await authedGet(`/api/placements/${terminal.placementId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.placement.next_deadline_type ?? null).toBeNull();
    expect(detail.body.placement.next_deadline_at ?? null).toBeNull();
  });

  it('PATCH /api/placements/:placementId clears tour_date with null and emits (stage is NOT writable here)', async () => {
    const c = await world.placementsRepo.create({
      tenantId: 't',
      unitId: 'u',
      stage: 'awaiting_inspection',
      tour_date: '2026-07-02',
    });
    const res = await authedPatch(`/api/placements/${c.placementId}`, { tour_date: null });
    expect(res.status).toBe(200);
    expect(res.body.placement.tour_date).toBeUndefined();
    expect(world.emitted.some((e) => e.event === 'placement.updated')).toBe(true);
    expect(world.auditEvents.some((a) => a.event_type === 'placement_updated')).toBe(true);
  });

  it('PATCH REFUSES a stage write (§8: stage moves go through the transition route)', async () => {
    const c = await world.placementsRepo.create({ tenantId: 't', unitId: 'u', stage: 'send_application' });
    // Even a VALID stage is rejected via legacy CRUD — the ONLY way to change a
    // placement stage is POST /api/placements/:placementId/transition.
    expect((await authedPatch(`/api/placements/${c.placementId}`, { stage: 'awaiting_approval' })).status).toBe(400);
    expect((await authedPatch(`/api/placements/${c.placementId}`, { stage: 'bogus' })).status).toBe(400);
    // The placement stage is untouched.
    expect((await world.placementsRepo.getById(c.placementId))!.stage).toBe('send_application');
  });

  it('PATCH rejects the next_deadline_* keys, an immutable/unknown field, an attention SET, and 404s unknown', async () => {
    const c = await world.placementsRepo.create({ tenantId: 't', unitId: 'u', stage: 'send_application' });
    expect((await authedPatch(`/api/placements/${c.placementId}`, { next_deadline_at: '2026-07-01T00:00:00.000Z' })).status).toBe(400);
    expect((await authedPatch(`/api/placements/${c.placementId}`, { placementId: 'x' })).status).toBe(400); // immutable key
    expect((await authedPatch(`/api/placements/${c.placementId}`, { attention: { reason: 'x' } })).status).toBe(400); // set not allowed
    expect((await authedPatch(`/api/placements/${c.placementId}`, {})).status).toBe(400); // empty patch
    expect((await authedPatch('/api/placements/placement-ghost', { notes: 'x' })).status).toBe(404);
  });

  it('PATCH can CLEAR the attention flag with null (operator acknowledges an escalation)', async () => {
    const c = await world.placementsRepo.create({
      tenantId: 't',
      unitId: 'u',
      stage: 'awaiting_approval',
      attention: { reason: 'send_failed', at: '2026-06-14T00:00:00.000Z' },
    });
    const res = await authedPatch(`/api/placements/${c.placementId}`, { attention: null });
    expect(res.status).toBe(200);
    expect(res.body.placement.attention).toBeUndefined();
    // The live event reflects the cleared flag → the boards drop the badge.
    const evt = world.emitted.filter((e) => e.event === 'placement.updated').at(-1);
    expect((evt!.payload as { attention: boolean }).attention).toBe(false);
  });

  it('POST /api/placements/:placementId/deadline arms then clears a follow_up item, with validation + 404', async () => {
    const c = await world.placementsRepo.create({ tenantId: 't', unitId: 'u', stage: 'awaiting_authority_approval' });

    const set = await authedPost(`/api/placements/${c.placementId}/deadline`, {
      type: 'follow_up',
      at: '2026-06-16T12:00:00.000Z',
    });
    expect(set.status).toBe(200);
    expect(set.body.placement.next_deadline_type).toBe('follow_up');
    expect(set.body.placement.next_deadline_at).toBe('2026-06-16T12:00:00.000Z');
    // The item is a real placementDeadlines row.
    expect((await world.placementDeadlinesRepo.listByPlacement(c.placementId)).map((d) => d.type)).toEqual(['follow_up']);

    const clear = await authedPost(`/api/placements/${c.placementId}/deadline`, { clear: true });
    expect(clear.status).toBe(200);
    expect(clear.body.placement.next_deadline_type ?? null).toBeNull();
    expect(await world.placementDeadlinesRepo.listByPlacement(c.placementId)).toHaveLength(0);

    // Manual set is follow_up-ONLY: system-managed types are refused (400).
    expect(
      (await authedPost(`/api/placements/${c.placementId}/deadline`, { type: 'rta_window', at: '2026-06-16T12:00:00.000Z' })).status,
    ).toBe(400);
    expect(
      (await authedPost(`/api/placements/${c.placementId}/deadline`, { type: 'voucher_expiration', at: '2026-06-16T12:00:00.000Z' })).status,
    ).toBe(400);
    // Validation: bad type / bad timestamp.
    expect(
      (await authedPost(`/api/placements/${c.placementId}/deadline`, { type: 'whenever', at: '2026-06-16T12:00:00.000Z' })).status,
    ).toBe(400);
    expect((await authedPost(`/api/placements/${c.placementId}/deadline`, { type: 'follow_up', at: 'not-a-date' })).status).toBe(400);
    // 404 unknown placement.
    expect((await authedPost('/api/placements/placement-ghost/deadline', { clear: true })).status).toBe(404);
  });
});

describe('placements API — BE2/C2 activity milestones', () => {
  let app: Express;
  let world: FakeWorld;

  beforeEach(() => {
    const h = makeWebhookHarness();
    app = h.app;
    world = h.world;
  });

  const authedPost = (path: string, body: object) =>
    request(app).post(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).send(body);
  const authedPatch = (path: string, body: object) =>
    request(app).patch(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).send(body);

  const milestonesFor = (tenantId: string) =>
    world.activityEvents.filter((e) => e.contactId === tenantId);

  it('placement create emits placement_opened against the tenant (refType placement)', async () => {
    await world.contactsRepo.create({ contactId: 'c-keisha', type: 'tenant', status: 'searching' });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
    const res = await authedPost('/api/placements', { tenantId: 'c-keisha', unitId: 'unit-1' });
    const placementId = res.body.placement.placementId;
    const ev = milestonesFor('c-keisha');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'placement_opened', refType: 'placement', refId: placementId });
  });

  // NOTE: stage moves no longer go through the legacy CRUD PATCH (§8 — they
  // route through POST /api/placements/:placementId/transition, which records a
  // placement_stage_changed AUDIT row, not an activity milestone). So the
  // stage-driven `stage_changed` / `placement_closed` activity milestones that the
  // placements-router PATCH used to emit are no longer produced for stage moves (the
  // PATCH path can no longer change stage). Their tests are removed here; the
  // placement_closed milestone LABEL's category-only / no-PII discipline (fix #8)
  // still lives in routes/placements.ts for any future caller. Tour milestones below
  // still fire on tour_date / tours PATCHes, which remain CRUD-writable.

  it('newly setting tour_date emits tour_scheduled', async () => {
    const c = await world.placementsRepo.create({ tenantId: 'c-t', unitId: 'u', stage: 'awaiting_inspection' });
    await authedPatch(`/api/placements/${c.placementId}`, { tour_date: '2026-07-02' });
    const ev = world.activityEvents.filter((e) => e.type === 'tour_scheduled');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.label).toContain('2026-07-02');
  });

  // NOTE: the tour_took_place milestone was previously derived from placement.tours[],
  // which is retired (Tours are now first-class entities in the tours table; the field
  // had no real data). The milestone will be re-implemented against the tours API
  // (listening to tour status changes) in a downstream task.
  it('tour_took_place is a no-op after placement.tours[] retirement (downstream re-implementation pending)', async () => {
    const c = await world.placementsRepo.create({ tenantId: 'c-t', unitId: 'u', stage: 'awaiting_inspection' });
    // PATCHing tours (now a no-op flexible-doc attribute) never emits tour_took_place.
    await authedPatch(`/api/placements/${c.placementId}`, { note_for_future: 'tours now come from /api/tours' });
    expect(world.activityEvents.filter((e) => e.type === 'tour_took_place')).toHaveLength(0);
  });
});

describe('placements API — derive-on-create (§7)', () => {
  let app: Express;
  let world: FakeWorld;

  beforeEach(() => {
    const h = makeWebhookHarness();
    app = h.app;
    world = h.world;
  });

  const authedPost = (path: string, body: object) =>
    request(app).post(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).send(body);

  // Seed a tenant contact + a unit through the SAME world repos the router's
  // self-constructed transition service reads/writes — so a derived write is
  // observable via world.contactsRepo.getById / world.unitsRepo.getById.
  const seedTenant = (status: string) =>
    world.contactsRepo.create({ contactId: 't-derive', type: 'tenant', status });
  const seedUnit = (status: string) =>
    world.unitsRepo.create({ unitId: 'u-derive', landlordId: 'll-1', status });

  it('create at a mid-ladder stage derives tenant placing + listing under_application + provenance', async () => {
    await seedTenant('searching');
    await seedUnit('available');

    const res = await authedPost('/api/placements', {
      tenantId: 't-derive',
      unitId: 'u-derive',
      stage: 'awaiting_inspection',
    });
    expect(res.status).toBe(201);

    // The placement's OWN provenance (the stage is operator-set ⇒ 'manual').
    expect(res.body.placement.stage_source).toBe('manual');
    expect(typeof res.body.placement.stage_entered_at).toBe('string');

    // Derived coarse statuses (source 'derived', the lowest-precedence input).
    const tenant = await world.contactsRepo.getById('t-derive');
    expect(tenant?.status).toBe('placing');
    expect(tenant?.status_source).toBe('derived');
    const unit = await world.unitsRepo.getById('u-derive');
    expect(unit?.status).toBe('under_application');
    expect(unit?.status_source).toBe('derived');
  });

  it('create at a Contract-phase stage derives listing finalizing (tenant placing)', async () => {
    await seedTenant('searching');
    await seedUnit('available');

    const res = await authedPost('/api/placements', {
      tenantId: 't-derive',
      unitId: 'u-derive',
      stage: 'awaiting_hap_contract',
    });
    expect(res.status).toBe(201);

    const unit = await world.unitsRepo.getById('u-derive');
    expect(unit?.status).toBe('finalizing');
    const tenant = await world.contactsRepo.getById('t-derive');
    expect(tenant?.status).toBe('placing');
  });

  it('a derived write respects an existing override pin (listing on_hold not clobbered)', async () => {
    await seedTenant('searching');
    await seedUnit('on_hold'); // an explicit override → derivation must NOT overwrite

    const res = await authedPost('/api/placements', {
      tenantId: 't-derive',
      unitId: 'u-derive',
      stage: 'awaiting_inspection',
    });
    expect(res.status).toBe(201);

    const unit = await world.unitsRepo.getById('u-derive');
    expect(unit?.status).toBe('on_hold'); // STILL pinned (gated; no under_application)
    // The tenant side (not override-pinned) still derives.
    const tenant = await world.contactsRepo.getById('t-derive');
    expect(tenant?.status).toBe('placing');
  });

  it('the default stage (no stage) derives too (tenant placing + listing under_application)', async () => {
    await seedTenant('searching');
    await seedUnit('available');

    const res = await authedPost('/api/placements', { tenantId: 't-derive', unitId: 'u-derive' });
    expect(res.status).toBe(201);
    expect(res.body.placement.stage).toBe('send_application');

    const tenant = await world.contactsRepo.getById('t-derive');
    expect(tenant?.status).toBe('placing');
    const unit = await world.unitsRepo.getById('u-derive');
    expect(unit?.status).toBe('under_application');
  });

  it('a failed derived write does NOT fail the 201 (best-effort — the row is persisted)', async () => {
    // Mount the router standalone with an injected transition service whose
    // deriveForStage REJECTS — proving the POST-create try/catch swallows it.
    const isolated = createFakeWorld();
    await isolated.contactsRepo.create({ contactId: 't-x', type: 'tenant', status: 'searching' });
    await isolated.unitsRepo.create({ unitId: 'u-x', landlordId: 'll-1', status: 'available' });
    const rejectingTransitions: StatusTransitionService = {
      transitionPlacement: () => {
        throw new Error('not used in this test');
      },
      setTenantStatus: () => {
        throw new Error('not used in this test');
      },
      setListingStatus: () => {
        throw new Error('not used in this test');
      },
      deriveForStage: () => Promise.reject(new Error('boom: derived write failed')),
    };
    const bare = express();
    bare.use(express.json());
    bare.use(
      '/api/placements',
      createPlacementsRouter({
        placementsRepo: isolated.placementsRepo,
        placementDeadlinesRepo: isolated.placementDeadlinesRepo,
        unitsRepo: isolated.unitsRepo,
        contactsRepo: isolated.contactsRepo,
        auditRepo: isolated.auditRepo,
        activityEventsRepo: isolated.activityEventsRepo,
        events: isolated.events,
        statusTransitionService: rejectingTransitions,
      }),
    );

    const res = await request(bare)
      .post('/api/placements')
      .send({ tenantId: 't-x', unitId: 'u-x', stage: 'awaiting_inspection' });
    expect(res.status).toBe(201); // the rejecting derive did NOT fail the create
    expect(res.body.placement.placementId).toMatch(/^placement-/);
    expect(isolated.placements.size).toBe(1); // the row WAS persisted
  });
});

describe('toPlacementUpdatedEvent (M1.10b live-update payload)', () => {
  it('maps attention to a boolean (both states) and never carries PII', () => {
    const base = { placementId: 'c', tenantId: 't', unitId: 'u', stage: 'awaiting_approval' } as PlacementItem;
    const withAttn = toPlacementUpdatedEvent({
      ...base,
      attention: { reason: 'send_failed', at: '2026-06-14T00:00:00.000Z' },
      placement_tag: 'Keisha @ 123 Main',
    });
    expect(withAttn.attention).toBe(true); // load-bearing: M1.10c flips the board badge live
    // placement_tag (a name) is deliberately omitted from the wire payload (doc §9).
    expect(JSON.stringify(withAttn)).not.toContain('Keisha');
    expect(toPlacementUpdatedEvent(base).attention).toBe(false);
  });
});
