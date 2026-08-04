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
import { resolveMessage } from '../src/messages/index.js';
import type {
  SendMessageInput,
  SendMessageOutcome,
  SendMessageService,
} from '../src/services/sendMessage.js';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import {
  isoHoursFromNow,
  quietWindowAroundNow,
  quietWindowAwayFromNow,
} from './helpers/settingsStub.js';

const SECRET = ORIGIN_SECRET;

function authed(app: ReturnType<typeof makeWebhookHarness>['app']) {
  return {
    get: (path: string) =>
      request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
    patch: (path: string) =>
      request(app).patch(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
    post: (path: string) =>
      request(app).post(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
  };
}

/** Records every send the route drives (the route asserts on view + audit). */
function makeSendSpy(): { service: SendMessageService; sent: SendMessageInput[] } {
  const sent: SendMessageInput[] = [];
  const service: SendMessageService = async (input) => {
    sent.push(input);
    return {
      conversationId: input.conversationId,
      providerSid: 'SM-route-fake',
      tsMsgId: 'ts-route-fake',
      status: 'queued',
    } as SendMessageOutcome;
  };
  return { service, sent };
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

/**
 * Seed a placement whose stage MATCHES its rung (a mismatched stage would report
 * the harder stale_stage reason) plus one upcoming receipt_check rung due at
 * `dueAt`, and return the placementId. One placement per rung keeps each
 * quiet-hours case a clean read of that rung's own dueAt.
 */
async function seedQuietNudge(world: FakeWorld, suffix: string, dueAt: string): Promise<string> {
  const placementId = await seedPlacement(world, {
    tenantId: `contact-nudge-quiet-${suffix}`,
    unitId: `unit-nudge-quiet-${suffix}`,
    stage: 'awaiting_receipt',
  });
  seedNudge(world, { nudgeId: `nudge-quiet-${suffix}`, placementId, kind: 'receipt_check', dueAt });
  return placementId;
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

  // Quiet hours (spec 2026-08-03) brought the FIRST suppression estimate to the
  // nudge view. The chip is a claim about the FUTURE ("Will wait"), so it is a
  // property of the RUNG - its own dueAt against the daily-recurring window -
  // not of the server wall clock. The window stub is still computed from the
  // current time; a fixed 21:00-08:00 fixture would be time-of-day dependent.
  it('carries a quiet_hours suppression estimate on a rung due inside a window occurrence', async () => {
    const { app, world } = makeWebhookHarness();
    Object.assign(world.settings, quietWindowAroundNow());
    const placementId = await seedPlacement(world, {
      tenantId: 'contact-nudge-quiet-1',
      unitId: 'unit-nudge-quiet-1',
      stage: 'awaiting_receipt',
    });
    // Same wall time tomorrow: inside TOMORROW's occurrence of the window.
    seedNudge(world, {
      nudgeId: 'nudge-quiet-1',
      placementId,
      kind: 'receipt_check',
      dueAt: isoHoursFromNow(24),
    });
    // A terminal rung must never carry an estimate (nothing is going to fire).
    seedNudge(world, {
      nudgeId: 'nudge-quiet-sent',
      placementId,
      kind: 'completion_check',
      dueAt: '2026-07-13T08:00:00.000Z',
      sentAt: '2026-07-13T08:00:05.000Z',
    });

    const res = await authed(app).get(`/api/placements/${placementId}/nudges`);
    expect(res.status).toBe(200);
    const byId = new Map(
      (res.body.nudges as { nudgeId: string; state: string; suppression?: { reason: string } }[]).map(
        (n) => [n.nudgeId, n],
      ),
    );
    expect(byId.get('nudge-quiet-1')?.suppression).toEqual({ reason: 'quiet_hours' });
    expect(byId.get('nudge-quiet-sent')?.suppression).toBeUndefined();
  });

  /** The first (only) rung's suppression on a placement, via the real route. */
  async function suppressionOf(
    app: ReturnType<typeof makeWebhookHarness>['app'],
    placementId: string,
  ): Promise<unknown> {
    const res = await authed(app).get(`/api/placements/${placementId}/nudges`);
    expect(res.status).toBe(200);
    const [nudge] = res.body.nudges as { suppression?: { reason: string } }[];
    return nudge?.suppression;
  }

  // The SF1 false positive: inside the window the wall clock says "quiet", but a
  // rung due days from now will not wait for tonight's window - while a rung
  // already due IS being held by the fire-time backstop right now.
  it('inside the window, chips only what quiet hours will hold - not every upcoming rung', async () => {
    const { app, world } = makeWebhookHarness();
    Object.assign(world.settings, quietWindowAroundNow());
    // Three days out at a time of day outside EVERY occurrence of the window.
    const far = await seedQuietNudge(world, 'far', isoHoursFromNow(3 * 24 + 6));
    // Already due, with a dueAt outside every occurrence: the poll is deferring
    // it RIGHT NOW (worker-downtime catch-up that crossed the window start).
    const overdue = await seedQuietNudge(world, 'overdue', isoHoursFromNow(-30));

    expect(await suppressionOf(app, far)).toBeUndefined();
    expect(await suppressionOf(app, overdue)).toEqual({ reason: 'quiet_hours' });
  });

  // The other half of SF1: during business hours a rung genuinely due at 23:00
  // tonight WILL be deferred, so it must chip even though the clock is outside
  // the window - exactly when staff are looking at the card.
  it('outside the window, still chips a rung due inside tonight occurrence', async () => {
    const { app, world } = makeWebhookHarness();
    Object.assign(world.settings, quietWindowAwayFromNow());
    const tonight = await seedQuietNudge(world, 'tonight', isoHoursFromNow(4));
    const before = await seedQuietNudge(world, 'before', isoHoursFromNow(1));

    expect(await suppressionOf(app, tonight)).toEqual({ reason: 'quiet_hours' });
    expect(await suppressionOf(app, before)).toBeUndefined();
  });

  it('carries NO suppression when quiet hours are disabled', async () => {
    const { app, world } = makeWebhookHarness();
    world.settings.quietHoursEnabled = false;
    const placementId = await seedPlacement(world, {
      tenantId: 'contact-nudge-quiet-2',
      unitId: 'unit-nudge-quiet-2',
      stage: 'awaiting_receipt',
    });
    seedNudge(world, {
      nudgeId: 'nudge-quiet-2',
      placementId,
      kind: 'receipt_check',
      dueAt: '2026-07-14T08:00:00.000Z',
    });

    const res = await authed(app).get(`/api/placements/${placementId}/nudges`);
    expect(res.status).toBe(200);
    const [nudge] = res.body.nudges as { suppression?: { reason: string } }[];
    expect(nudge?.suppression).toBeUndefined();
  });

  it('stale_stage outranks quiet_hours on a rung whose placement has moved on', async () => {
    const { app, world } = makeWebhookHarness();
    Object.assign(world.settings, quietWindowAroundNow());
    // The placement already LEFT awaiting_receipt, so the receipt_check rung
    // would be retired unsent - a harder reason than "waiting for quiet-end".
    const placementId = await seedPlacement(world, {
      tenantId: 'contact-nudge-quiet-3',
      unitId: 'unit-nudge-quiet-3',
      stage: 'awaiting_completion',
    });
    // A dueAt inside tomorrow's occurrence, so quiet hours WOULD chip this rung
    // on its own - stale_stage has to outrank it, not merely fill a gap.
    seedNudge(world, {
      nudgeId: 'nudge-quiet-3',
      placementId,
      kind: 'receipt_check',
      dueAt: isoHoursFromNow(24),
    });

    const res = await authed(app).get(`/api/placements/${placementId}/nudges`);
    expect(res.status).toBe(200);
    const [nudge] = res.body.nudges as { suppression?: { reason: string } }[];
    expect(nudge?.suppression).toEqual({ reason: 'stale_stage' });
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

// Send now (quiet-hours spec section 7): any authed staff role - no admin gate.
describe('POST /api/placements/:placementId/nudges/:nudgeId/send-now', () => {
  /** A tenant-routed rung whose placement is still on the rung's stage. */
  async function seedSendNowNudge(
    world: FakeWorld,
    over: {
      suffix?: string;
      stage?: string;
      contactOptOut?: boolean;
      consent?: boolean;
      /** Soft-delete stamp (contactsRepo isDeleted reads a non-empty deleted_at). */
      deletedAt?: string;
    } = {},
  ) {
    const suffix = over.suffix ?? '1';
    const tenantId = `contact-nudge-sendnow-${suffix}`;
    const phone = `+1555071${suffix.padStart(4, '0')}`;
    world.contacts.push({
      contactId: tenantId,
      type: 'tenant',
      phone,
      created_at: '2026-07-13T00:00:00.000Z',
      ...(over.consent !== false && { consent_method: 'inbound_text' }),
      ...(over.contactOptOut === true && { sms_opt_out: true }),
      ...(over.deletedAt !== undefined && { deleted_at: over.deletedAt }),
    } as Parameters<typeof world.contacts.push>[0]);
    world.conversations.set(`conv-nudge-sendnow-${suffix}`, {
      conversationId: `conv-nudge-sendnow-${suffix}`,
      participant_phone: phone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: '2026-07-13T00:00:00.000Z',
      created_at: '2026-07-13T00:00:00.000Z',
    });
    const placementId = await seedPlacement(world, {
      tenantId,
      unitId: `unit-nudge-sendnow-${suffix}`,
      ...(over.stage !== undefined && { stage: over.stage }),
    });
    const nudgeId = `nudge-sendnow-${suffix}`;
    seedNudge(world, {
      nudgeId,
      placementId,
      kind: 'receipt_check',
      dueAt: '2026-07-19T10:00:00.000Z',
    });
    return { placementId, nudgeId, tenantId };
  }

  it('200s with the re-read sent view, sends automated: false, and records an audit event', async () => {
    const spy = makeSendSpy();
    const { app, world } = makeWebhookHarness({ sendMessageService: spy.service });
    // Quiet hours ON around the wall clock: the human path must ignore them.
    Object.assign(world.settings, quietWindowAroundNow());
    const { placementId, nudgeId } = await seedSendNowNudge(world);

    const res = await authed(app).post(
      `/api/placements/${placementId}/nudges/${nudgeId}/send-now`,
    );

    expect(res.status).toBe(200);
    expect(res.body.nudge.nudgeId).toBe(nudgeId);
    expect(res.body.nudge.state).toBe('sent');
    expect(typeof res.body.nudge.sentAt).toBe('string');
    expect(res.body.nudge.recipient).toBe('tenant');

    expect(spy.sent).toHaveLength(1);
    expect(spy.sent[0]!.conversationId).toBe('conv-nudge-sendnow-1');
    expect(spy.sent[0]!.body).toBe(resolveMessage('nudge.receipt_check'));
    expect(spy.sent[0]!.automated).toBe(false);

    const ev = world.auditEvents.find((e) => e.event_type === 'nudge_force_sent');
    expect(ev?.entityKey).toBe(`placements#${placementId}`);
    expect(ev?.actorId).toBe(TEST_SESSION_USER.userId);
    expect(ev?.payload).toEqual({
      nudgeId,
      kind: 'receipt_check',
      actor: TEST_SESSION_USER.userId,
    });
  });

  it('409s nudge_not_pending with the honest current view when the rung already fired', async () => {
    const spy = makeSendSpy();
    const { app, world } = makeWebhookHarness({ sendMessageService: spy.service });
    const { placementId, nudgeId } = await seedSendNowNudge(world, { suffix: '2' });
    await world.placementNudgesRepo.claimSend(nudgeId, '2026-07-19T10:00:05.000Z');

    const res = await authed(app).post(
      `/api/placements/${placementId}/nudges/${nudgeId}/send-now`,
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('nudge_not_pending');
    expect(res.body.nudge.state).toBe('sent');
    expect(spy.sent).toHaveLength(0);
    expect(world.auditEvents.some((e) => e.event_type === 'nudge_force_sent')).toBe(false);
  });

  it('409s stage_moved and leaves the rung PENDING (only the poll retires stale rows)', async () => {
    const spy = makeSendSpy();
    const { app, world } = makeWebhookHarness({ sendMessageService: spy.service });
    // The rung chases awaiting_receipt; the placement already moved on.
    const { placementId, nudgeId } = await seedSendNowNudge(world, {
      suffix: '3',
      stage: 'awaiting_completion',
    });

    const res = await authed(app).post(
      `/api/placements/${placementId}/nudges/${nudgeId}/send-now`,
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('stage_moved');
    expect(res.body.nudge.state).toBe('upcoming');
    expect(res.body.nudge.skippedAt).toBeUndefined();
    expect(spy.sent).toHaveLength(0);
    // Still the poll's to retire on its own tick.
    expect(
      (await world.placementNudgesRepo.listDue('2026-07-19T10:01:00.000Z')).map((n) => n.nudgeId),
    ).toContain(nudgeId);
  });

  it('409s contact_opted_out and leaves the rung upcoming', async () => {
    const spy = makeSendSpy();
    const { app, world } = makeWebhookHarness({ sendMessageService: spy.service });
    const { placementId, nudgeId } = await seedSendNowNudge(world, {
      suffix: '4',
      contactOptOut: true,
    });

    const res = await authed(app).post(
      `/api/placements/${placementId}/nudges/${nudgeId}/send-now`,
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('contact_opted_out');
    expect(res.body.nudge.state).toBe('upcoming');
    expect(spy.sent).toHaveLength(0);
  });

  it('409s contact_deleted for a soft-deleted recipient and leaves the rung upcoming', async () => {
    const spy = makeSendSpy();
    const { app, world } = makeWebhookHarness({ sendMessageService: spy.service });
    const { placementId, nudgeId } = await seedSendNowNudge(world, {
      suffix: '6',
      deletedAt: '2026-07-12T00:00:00.000Z',
    });

    const res = await authed(app).post(
      `/api/placements/${placementId}/nudges/${nudgeId}/send-now`,
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('contact_deleted');
    expect(res.body.nudge.state).toBe('upcoming');
    expect(spy.sent).toHaveLength(0);
  });

  it('404s an unknown placement, an unknown rung, and a rung owned by ANOTHER placement', async () => {
    const spy = makeSendSpy();
    const { app, world } = makeWebhookHarness({ sendMessageService: spy.service });
    const { placementId, nudgeId } = await seedSendNowNudge(world, { suffix: '5' });

    const ghostPlacement = await authed(app).post(
      `/api/placements/no-such-placement/nudges/${nudgeId}/send-now`,
    );
    expect(ghostPlacement.status).toBe(404);
    expect(ghostPlacement.body).toEqual({ error: 'placement_not_found' });

    const ghostRung = await authed(app).post(
      `/api/placements/${placementId}/nudges/nudge-does-not-exist/send-now`,
    );
    expect(ghostRung.status).toBe(404);
    expect(ghostRung.body).toEqual({ error: 'nudge_not_found' });

    const other = await seedPlacement(world, {
      tenantId: 'contact-nudge-sendnow-other',
      unitId: 'unit-nudge-sendnow-other',
    });
    const cross = await authed(app).post(
      `/api/placements/${other}/nudges/${nudgeId}/send-now`,
    );
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual({ error: 'nudge_not_found' });
    expect(spy.sent).toHaveLength(0);
  });
});
