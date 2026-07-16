// Placement nudges endpoints tests — GET + PATCH /api/placements/:placementId/nudges
// (placement-detail-hub, Task 2 backend).
//
//   GET   /api/placements/:placementId/nudges
//        -> { nudges: PlacementNudgeView[] }  (sorted dueAt DESCENDING)
//   PATCH /api/placements/:placementId/nudges/:nudgeId  { canceled: boolean }
//        -> { nudge: PlacementNudgeView } | 409 (already sent, or the row raced
//           the poll's claim -> the honest current state is returned)
//
// Mirrors tourRemindersApi.test.ts: the full app via makeWebhookHarness with
// in-memory fakes (no DynamoDB, no network); placements/nudges/units are seeded
// directly on the world fakes. recipient derives from kind per NUDGE_RUNGS
// (approval_check + rta_window_closing -> landlord, else tenant) and a
// cancel/restore emits scheduled.updated keyed on the RECIPIENT's contactId
// (tenant -> placement.tenantId; landlord -> unit.landlordId).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { NudgeKind, NudgeSkipReason, PlacementNudgeItem } from '../src/repos/placementNudgesRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;

function authed(app: ReturnType<typeof makeWebhookHarness>['app']) {
  return {
    get: (path: string) =>
      request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
    patch: (path: string) =>
      request(app).patch(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
  };
}

/** Seed a placement row directly on the world fake. */
async function seedPlacement(
  world: FakeWorld,
  input: { tenantId: string; unitId: string; stage?: string },
): Promise<string> {
  const created = await world.placementsRepo.create({
    tenantId: input.tenantId,
    unitId: input.unitId,
    stage: (input.stage ?? 'awaiting_receipt') as Parameters<
      typeof world.placementsRepo.create
    >[0]['stage'],
  });
  return created.placementId;
}

/** Seed a nudge row directly on the world fake. */
function seedNudge(
  world: FakeWorld,
  input: {
    nudgeId: string;
    placementId: string;
    kind: NudgeKind;
    dueAt: string;
    sentAt?: string;
    canceledAt?: string;
    skippedAt?: string;
    skipReason?: NudgeSkipReason;
  },
): void {
  const item: PlacementNudgeItem = {
    nudgeId: input.nudgeId,
    placementId: input.placementId,
    kind: input.kind,
    dueAt: input.dueAt,
    _nudgePartition: 'nudges',
    createdAt: '2026-07-13T00:00:00.000Z',
    ...(input.sentAt !== undefined && { sentAt: input.sentAt }),
    ...(input.canceledAt !== undefined && { canceledAt: input.canceledAt }),
    ...(input.skippedAt !== undefined && { skippedAt: input.skippedAt }),
    ...(input.skipReason !== undefined && { skipReason: input.skipReason }),
  };
  world.placementNudgesMap.set(item.nudgeId, item);
}

describe('GET /api/placements/:placementId/nudges', () => {
  it('returns each nudge sorted by dueAt DESC with state + recipient, sentAt/canceledAt surfaced', async () => {
    const { app, world } = makeWebhookHarness();
    const placementId = await seedPlacement(world, {
      tenantId: 'contact-nudge-tenant-1',
      unitId: 'unit-nudge-1',
    });

    // Three rungs seeded out of dueAt order to prove the server sorts DESC. Mix
    // of tenant-routed (receipt_check/completion_check) + landlord-routed
    // (approval_check) kinds and mixed states.
    seedNudge(world, {
      nudgeId: 'nudge-receipt',
      placementId,
      kind: 'receipt_check',
      dueAt: '2026-07-14T08:00:00.000Z',
      canceledAt: '2026-07-14T09:00:00.000Z',
    });
    seedNudge(world, {
      nudgeId: 'nudge-completion',
      placementId,
      kind: 'completion_check',
      dueAt: '2026-07-16T10:00:00.000Z',
      sentAt: '2026-07-16T10:00:05.000Z',
    });
    seedNudge(world, {
      nudgeId: 'nudge-approval',
      placementId,
      kind: 'approval_check',
      dueAt: '2026-07-15T10:00:00.000Z',
    });

    const res = await authed(app).get(`/api/placements/${placementId}/nudges`);
    expect(res.status).toBe(200);

    const { nudges } = res.body as {
      nudges: {
        nudgeId: string;
        placementId: string;
        kind: NudgeKind;
        recipient: string;
        dueAt: string;
        state: string;
        sentAt?: string;
        canceledAt?: string;
      }[];
    };

    // Sorted DESCENDING by dueAt: completion (07-16), approval (07-15), receipt (07-14).
    expect(nudges.map((n) => n.nudgeId)).toEqual(['nudge-completion', 'nudge-approval', 'nudge-receipt']);
    expect(nudges.map((n) => n.state)).toEqual(['sent', 'upcoming', 'canceled']);

    // recipient derives from kind (NUDGE_RUNGS): approval_check -> landlord, the
    // receipt/completion checks -> tenant.
    const byId = new Map(nudges.map((n) => [n.nudgeId, n]));
    expect(byId.get('nudge-receipt')?.recipient).toBe('tenant');
    expect(byId.get('nudge-completion')?.recipient).toBe('tenant');
    expect(byId.get('nudge-approval')?.recipient).toBe('landlord');

    // placementId echoed; sentAt / canceledAt surfaced on the respective rungs.
    expect(byId.get('nudge-approval')?.placementId).toBe(placementId);
    expect(byId.get('nudge-completion')?.sentAt).toBe('2026-07-16T10:00:05.000Z');
    expect(byId.get('nudge-receipt')?.canceledAt).toBe('2026-07-14T09:00:00.000Z');
    // upcoming rung carries neither terminal stamp.
    expect(byId.get('nudge-approval')?.sentAt).toBeUndefined();
    expect(byId.get('nudge-approval')?.canceledAt).toBeUndefined();
  });

  it('surfaces a claim-skipped rung as state=skipped with its skipReason (never "sent")', async () => {
    const { app, world } = makeWebhookHarness();
    const placementId = await seedPlacement(world, {
      tenantId: 'contact-nudge-tenant-skip',
      unitId: 'unit-nudge-skip',
    });
    seedNudge(world, {
      nudgeId: 'nudge-skipped',
      placementId,
      kind: 'approval_check',
      dueAt: '2026-07-14T08:00:00.000Z',
      skippedAt: '2026-07-14T08:01:00.000Z',
      skipReason: 'no_landlord',
    });

    const res = await authed(app).get(`/api/placements/${placementId}/nudges`);
    expect(res.status).toBe(200);
    const [nudge] = (res.body as { nudges: { state: string; skippedAt?: string; skipReason?: string; sentAt?: string }[] }).nudges;
    expect(nudge?.state).toBe('skipped');
    expect(nudge?.skippedAt).toBe('2026-07-14T08:01:00.000Z');
    expect(nudge?.skipReason).toBe('no_landlord');
    expect(nudge?.sentAt).toBeUndefined();
  });

  it('returns 404 for an unknown placement id', async () => {
    const { app } = makeWebhookHarness();
    const res = await authed(app).get('/api/placements/no-such-placement/nudges');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'placement_not_found' });
  });
});

describe('PATCH /api/placements/:placementId/nudges/:nudgeId', () => {
  async function seedTenantNudge(world: FakeWorld): Promise<string> {
    const placementId = await seedPlacement(world, {
      tenantId: 'contact-cancel-tenant-1',
      unitId: 'unit-cancel-1',
      stage: 'awaiting_receipt',
    });
    seedNudge(world, {
      nudgeId: 'nudge-cancelable',
      placementId,
      kind: 'receipt_check',
      dueAt: '2026-07-19T10:00:00.000Z',
    });
    return placementId;
  }

  it('cancels an upcoming (tenant) nudge (emits scheduled.updated on the tenant), then restores it', async () => {
    const { app, world } = makeWebhookHarness();
    const placementId = await seedTenantNudge(world);
    world.emitted.length = 0;

    const canceled = await authed(app)
      .patch(`/api/placements/${placementId}/nudges/nudge-cancelable`)
      .send({ canceled: true });
    expect(canceled.status).toBe(200);
    expect(canceled.body.nudge.state).toBe('canceled');
    expect(typeof canceled.body.nudge.canceledAt).toBe('string');
    expect(canceled.body.nudge.recipient).toBe('tenant');
    // The card + the tenant timeline's Upcoming bucket refetch on this.
    expect(
      world.emitted.some(
        (e) =>
          e.event === 'scheduled.updated' &&
          (e.payload as { contactId?: string }).contactId === 'contact-cancel-tenant-1',
      ),
    ).toBe(true);
    // A canceled nudge leaves listDue — the poll can never fire it.
    expect(await world.placementNudgesRepo.listDue('2026-07-19T10:01:00.000Z')).toEqual([]);

    const restored = await authed(app)
      .patch(`/api/placements/${placementId}/nudges/nudge-cancelable`)
      .send({ canceled: false });
    expect(restored.status).toBe(200);
    expect(restored.body.nudge.state).toBe('upcoming');
    expect(restored.body.nudge.canceledAt).toBeUndefined();
    // Restored -> back in listDue at its original dueAt.
    expect(
      (await world.placementNudgesRepo.listDue('2026-07-19T10:01:00.000Z')).map((n) => n.nudgeId),
    ).toEqual(['nudge-cancelable']);
  });

  it('keys scheduled.updated on the LANDLORD contact for a landlord-routed nudge', async () => {
    const { app, world } = makeWebhookHarness();
    // A unit whose landlord is a distinct contact; the approval_check nudge routes
    // to that landlord, so the emit must carry the landlordId (not the tenant).
    await world.unitsRepo.create({
      unitId: 'unit-landlord-1',
      landlordId: 'contact-landlord-9',
      status: 'available',
    });
    const placementId = await seedPlacement(world, {
      tenantId: 'contact-tenant-9',
      unitId: 'unit-landlord-1',
      stage: 'awaiting_approval',
    });
    seedNudge(world, {
      nudgeId: 'nudge-approval-9',
      placementId,
      kind: 'approval_check',
      dueAt: '2026-07-20T10:00:00.000Z',
    });
    world.emitted.length = 0;

    const res = await authed(app)
      .patch(`/api/placements/${placementId}/nudges/nudge-approval-9`)
      .send({ canceled: true });
    expect(res.status).toBe(200);
    expect(res.body.nudge.recipient).toBe('landlord');
    expect(
      world.emitted.some(
        (e) =>
          e.event === 'scheduled.updated' &&
          (e.payload as { contactId?: string }).contactId === 'contact-landlord-9',
      ),
    ).toBe(true);
  });

  it('409s a cancel that lost to the send (honest state in the body)', async () => {
    const { app, world } = makeWebhookHarness();
    const placementId = await seedTenantNudge(world);
    // The poll fired the nudge first (pre-stamp sentAt via the claim).
    await world.placementNudgesRepo.claimSend('nudge-cancelable', '2026-07-19T10:00:05.000Z');

    const res = await authed(app)
      .patch(`/api/placements/${placementId}/nudges/nudge-cancelable`)
      .send({ canceled: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('nudge_not_cancelable');
    expect(res.body.nudge.state).toBe('sent');
  });

  it('409s restoring a nudge that is not canceled', async () => {
    const { app, world } = makeWebhookHarness();
    const placementId = await seedTenantNudge(world);

    const res = await authed(app)
      .patch(`/api/placements/${placementId}/nudges/nudge-cancelable`)
      .send({ canceled: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('nudge_not_restorable');
    expect(res.body.nudge.state).toBe('upcoming');
  });

  it('409s BOTH cancel and restore of a skipped rung (retired unsent is terminal)', async () => {
    const { app, world } = makeWebhookHarness();
    const placementId = await seedPlacement(world, {
      tenantId: 'contact-cancel-tenant-skip',
      unitId: 'unit-cancel-skip',
    });
    seedNudge(world, {
      nudgeId: 'nudge-skip-terminal',
      placementId,
      kind: 'receipt_check',
      dueAt: '2026-07-14T08:00:00.000Z',
      skippedAt: '2026-07-14T08:01:00.000Z',
      skipReason: 'contact_no_phone',
    });

    const cancel = await authed(app)
      .patch(`/api/placements/${placementId}/nudges/nudge-skip-terminal`)
      .send({ canceled: true });
    expect(cancel.status).toBe(409);
    expect(cancel.body.error).toBe('nudge_not_cancelable');
    expect(cancel.body.nudge.state).toBe('skipped');

    const restore = await authed(app)
      .patch(`/api/placements/${placementId}/nudges/nudge-skip-terminal`)
      .send({ canceled: false });
    expect(restore.status).toBe(409);
    expect(restore.body.error).toBe('nudge_not_restorable');
    expect(restore.body.nudge.state).toBe('skipped');
  });

  it('validates: 400 non-boolean, 404 unknown placement, 404 nudge of ANOTHER placement', async () => {
    const { app, world } = makeWebhookHarness();
    const placementId = await seedTenantNudge(world);

    const bad = await authed(app)
      .patch(`/api/placements/${placementId}/nudges/nudge-cancelable`)
      .send({ canceled: 'yes' });
    expect(bad.status).toBe(400);

    const ghostPlacement = await authed(app)
      .patch('/api/placements/no-such-placement/nudges/nudge-cancelable')
      .send({ canceled: true });
    expect(ghostPlacement.status).toBe(404);

    // A real nudge, but owned by a DIFFERENT placement — never mutable through this path.
    const other = await seedPlacement(world, {
      tenantId: 'contact-cancel-tenant-2',
      unitId: 'unit-cancel-2',
    });
    const cross = await authed(app)
      .patch(`/api/placements/${other}/nudges/nudge-cancelable`)
      .send({ canceled: true });
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual({ error: 'nudge_not_found' });
  });
});
