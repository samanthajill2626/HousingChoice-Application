// Placement-scoped relay provisioning (M1.10c) — POST /api/placements/:placementId/relay: the
// explicit "Set up relay thread" action. Derives the roster from the placement
// (tenant + the unit's landlord), reuses the shared provisioning primitive,
// links placement.group_thread <-> conversation.placementId, and is idempotent. Runs on
// the shared in-memory world + a FAKE poolNumbers service (no Twilio, no real
// number), with the jobs machinery wired so the intro enqueue resolves.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  dispatchJob,
} from '../src/jobs/jobs.js';
import { registerRelayFanOutJobHandler } from '../src/jobs/relayFanOut.js';
import { createLogger } from '../src/lib/logger.js';
import type { PoolNumberItem } from '../src/repos/poolNumbersRepo.js';
import type { PlacementStage } from '../src/lib/statusModel.js';
import { RelayProvisioningDisabledError, type PoolNumbersService } from '../src/services/poolNumbers.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  ORIGIN_SECRET,
  signedTwilioPost,
  statusParams,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';

const TENANT_PHONE = '+15550100001';
const LANDLORD_PHONE = '+15550100002';

function makeFakePoolNumbers(): PoolNumbersService & { provisioned: string[] } {
  let counter = 0;
  const provisioned: string[] = [];
  const rec = (poolNumber: string): PoolNumberItem => ({
    poolNumber,
    lifecycle_state: 'active',
    quarantine_until: '0000-00-00T00:00:00.000Z',
    voice_capable: true,
    sms_capable: true,
    provisioned_at: new Date().toISOString(),
  });
  return {
    provisioned,
    async provisionForGroup() {
      counter += 1;
      const poolNumber = `+1555030${String(counter).padStart(4, '0')}`;
      provisioned.push(poolNumber);
      return { poolNumber, record: rec(poolNumber), provisioned: true };
    },
    async noteGroupClosed() {},
    async retireEligible() {
      return [];
    },
  };
}

function makeDisabledPoolNumbers(): PoolNumbersService & { provisionAttempts: number } {
  let provisionAttempts = 0;
  return {
    get provisionAttempts() {
      return provisionAttempts;
    },
    async provisionForGroup() {
      provisionAttempts += 1;
      throw new RelayProvisioningDisabledError('set RELAY_LIVE_PROVISIONING=true after A2P approval');
    },
    async noteGroupClosed() {},
    async retireEligible() {
      return [];
    },
  };
}

/** Seed a tenant contact + a unit (owned by a landlord contact) + a placement. */
async function seedPlacement(
  world: FakeWorld,
  opts: { tenantHasPhone?: boolean; landlordHasPhone?: boolean } = {},
): Promise<string> {
  const { tenantHasPhone = true, landlordHasPhone = true } = opts;
  await world.contactsRepo.create({
    contactId: 'c-tenant',
    type: 'tenant',
    firstName: 'Keisha',
    lastName: 'Tenant',
    ...(tenantHasPhone && { phone: TENANT_PHONE }),
  });
  await world.contactsRepo.create({
    contactId: 'c-landlord',
    type: 'landlord',
    firstName: 'Larry',
    lastName: 'Landlord',
    ...(landlordHasPhone && { phone: LANDLORD_PHONE }),
  });
  await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'c-landlord', status: 'available' });
  const c = await world.placementsRepo.create({
    tenantId: 'c-tenant',
    unitId: 'unit-1',
    stage: 'awaiting_approval',
    placement_tag: 'Keisha @ 123 Main',
  });
  return c.placementId;
}

const post = (app: Parameters<typeof request>[0], path: string) =>
  request(app).post(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).send();

describe('placement-scoped relay provisioning (M1.10c)', () => {
  let world: FakeWorld;

  beforeEach(() => {
    _resetForTests();
    const logger = createLogger({ destination: createLogCapture().stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    registerRelayFanOutJobHandler({
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      logger,
    });
    configureOutboundQueue(new InProcessOutboundQueueAdapter({ dispatch: dispatchJob }));
  });

  afterEach(() => {
    _resetForTests();
  });

  it('provisions a relay from the placement, links group_thread <-> placementId, and intros tenant + landlord', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });
    const placementId = await seedPlacement(world);

    const res = await post(app, `/api/placements/${placementId}/relay`);
    expect(res.status).toBe(201);

    const conv = res.body.conversation;
    expect(conv.type).toBe('relay_group');
    expect(conv.placementId).toBe(placementId); // the conversation->placement back-reference
    expect(conv.pool_number).toBe(pool.provisioned[0]);
    expect(conv.participants).toHaveLength(2);
    expect((conv.participants as { phone: string }[]).map((p) => p.phone).sort()).toEqual(
      [TENANT_PHONE, LANDLORD_PHONE].sort(),
    );

    // The placement is linked to its placement thread (both directions).
    expect(res.body.placement.group_thread).toBe(conv.conversationId);
    expect((await world.placementsRepo.getById(placementId))?.group_thread).toBe(conv.conversationId);

    // Intro fanned out to BOTH parties FROM the pool number.
    expect(world.sent.map((s) => s.to).sort()).toEqual([TENANT_PHONE, LANDLORD_PHONE].sort());
    expect(world.sent.every((s) => s.from === pool.provisioned[0])).toBe(true);

    // Live events + audits.
    expect(world.emitted.some((e) => e.event === 'placement.updated')).toBe(true);
    expect(world.emitted.some((e) => e.event === 'conversation.updated')).toBe(true);
    expect(world.auditEvents.some((a) => a.event_type === 'placement_relay_provisioned')).toBe(true);
    expect(world.auditEvents.some((a) => a.event_type === 'relay_group_created')).toBe(true);
  });

  it('is idempotent — a second call while the relay is OPEN → 409, no second pool number', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });
    const placementId = await seedPlacement(world);

    const first = await post(app, `/api/placements/${placementId}/relay`);
    expect(first.status).toBe(201);

    const second = await post(app, `/api/placements/${placementId}/relay`);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('relay_exists');
    expect(pool.provisioned).toHaveLength(1); // never bought a second number
  });

  it('404s an unknown placement', async () => {
    const { app } = makeWebhookHarness({ world, poolNumbersService: makeFakePoolNumbers() });
    const res = await post(app, '/api/placements/placement-ghost/relay');
    expect(res.status).toBe(404);
  });

  it('400s when the tenant has no phone on file (never a half-roster relay)', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });
    const placementId = await seedPlacement(world, { tenantHasPhone: false });

    const res = await post(app, `/api/placements/${placementId}/relay`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('tenant_unreachable');
    expect(pool.provisioned).toHaveLength(0); // refused BEFORE any number purchase
  });

  it('400s when the unit landlord has no phone on file', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });
    const placementId = await seedPlacement(world, { landlordHasPhone: false });

    const res = await post(app, `/api/placements/${placementId}/relay`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('landlord_unreachable');
    expect(pool.provisioned).toHaveLength(0);
  });

  it('503s when the kill-switch is off (no number purchased) and audits the refusal on the placement', async () => {
    const pool = makeDisabledPoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });
    const placementId = await seedPlacement(world);

    const res = await post(app, `/api/placements/${placementId}/relay`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('relay_provisioning_disabled');
    expect(pool.provisionAttempts).toBe(1);
    // No conversation created, no link written.
    expect([...world.conversations.values()]).toHaveLength(0);
    expect((await world.placementsRepo.getById(placementId))?.group_thread).toBeUndefined();
    // The refusal is audited on the CASE (entity placements#<placementId>, reason 'placement').
    const refusal = world.auditEvents.find((a) => a.event_type === 'relay_provisioning_disabled');
    expect(refusal?.entityKey).toBe(`placements#${placementId}`);
  });

  // --- M1.10c failed-send escalation (doc §7.1) ---------------------------
  // Seed a placement + its relay (placementId-linked) + a relay source message with a
  // 'sent' delivery slot for member c-bob + the relaysid pointer, so a status
  // callback for the leg SID drives the relay-recipient failure branch.
  async function seedRelayLeg(stage: PlacementStage): Promise<string> {
    const c = await world.placementsRepo.create({ tenantId: 'c-alice', unitId: 'unit-1', stage });
    const relay = await world.conversationsRepo.createRelayGroup({
      poolNumber: '+15550309999',
      members: [{ phone: LANDLORD_PHONE, contactId: 'c-bob' }],
      placementId: c.placementId,
    });
    const appended = await world.messagesRepo.append({
      conversationId: relay.conversationId,
      providerSid: 'SMrelaysrc',
      providerTs: '2026-06-15T10:00:00.000Z',
      type: 'sms',
      direction: 'inbound',
      author: 'unknown',
      deliveryStatus: 'delivered',
      relaySenderKey: 'c-alice',
      deliveryRecipients: { 'c-bob': { status: 'sent', sid: 'SMleg-bob' } },
    });
    await world.messagesRepo.putRelaySidPointer('SMleg-bob', {
      conversationId: relay.conversationId,
      tsMsgId: appended.tsMsgId,
      memberKey: 'c-bob',
    });
    return c.placementId;
  }

  it('a failed relay leg on an ACTIVE placement raises the attention flag + emits placement.updated', async () => {
    const { app } = makeWebhookHarness({ world });
    const placementId = await seedRelayLeg('awaiting_approval');
    world.emitted.length = 0;

    const res = await signedTwilioPost(app, '/webhooks/twilio/status', statusParams({ MessageSid: 'SMleg-bob', MessageStatus: 'failed', ErrorCode: '30007' }));
    expect(res.status).toBe(200);

    const c = await world.placementsRepo.getById(placementId);
    expect(c?.attention).toBeDefined();
    expect(c?.attention?.reason).toBe('send_failed');
    expect(world.emitted.some((e) => e.event === 'placement.updated')).toBe(true);
  });

  it('the escalation event PRESERVES the placement\'s pending deadline chip (not null)', async () => {
    const { app } = makeWebhookHarness({ world });
    const placementId = await seedRelayLeg('awaiting_approval');
    // A pending hard-clock deadline the board is showing. The escalation only
    // raises `attention` — it must NOT blank the chip. Regression guard: the emit
    // recomputes the soonest deadline instead of emitting `next: null` (which the
    // dashboard's in-place patch would have used to blank a live rta_window chip).
    await world.placementDeadlinesRepo.arm(placementId, 'rta_window', '2026-07-20T00:00:00.000Z');
    world.emitted.length = 0;

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/status',
      statusParams({ MessageSid: 'SMleg-bob', MessageStatus: 'failed', ErrorCode: '30007' }),
    );
    expect(res.status).toBe(200);

    const evt = world.emitted.find((e) => e.event === 'placement.updated');
    expect(evt).toBeDefined();
    const payload = evt!.payload as {
      attention: boolean;
      next_deadline_type: string | null;
      next_deadline_at: string | null;
    };
    expect(payload.attention).toBe(true); // the escalation DID raise attention…
    expect(payload.next_deadline_type).toBe('rta_window'); // …and PRESERVED the chip
    expect(payload.next_deadline_at).toBe('2026-07-20T00:00:00.000Z');
  });

  it('a failed relay leg on a TERMINAL placement does NOT escalate (the deal is closed)', async () => {
    const { app } = makeWebhookHarness({ world });
    const placementId = await seedRelayLeg('lost');

    await signedTwilioPost(app, '/webhooks/twilio/status', statusParams({ MessageSid: 'SMleg-bob', MessageStatus: 'failed', ErrorCode: '30007' }));

    expect((await world.placementsRepo.getById(placementId))?.attention).toBeUndefined();
  });

  it('a DELIVERED relay leg never escalates', async () => {
    const { app } = makeWebhookHarness({ world });
    const placementId = await seedRelayLeg('awaiting_approval');

    await signedTwilioPost(app, '/webhooks/twilio/status', statusParams({ MessageSid: 'SMleg-bob', MessageStatus: 'delivered' }));

    expect((await world.placementsRepo.getById(placementId))?.attention).toBeUndefined();
  });

  it('a REDELIVERED failed relay leg does not re-escalate (exactly once; forward-only guard)', async () => {
    const { app } = makeWebhookHarness({ world });
    const placementId = await seedRelayLeg('awaiting_approval');
    world.emitted.length = 0;

    await signedTwilioPost(app, '/webhooks/twilio/status', statusParams({ MessageSid: 'SMleg-bob', MessageStatus: 'failed', ErrorCode: '30007' }));
    const firstAt = (await world.placementsRepo.getById(placementId))?.attention?.at;
    // Twilio redelivers the SAME terminal callback — failed→failed isn't an
    // allowed transition, so transitioned=false → no re-escalation.
    await signedTwilioPost(app, '/webhooks/twilio/status', statusParams({ MessageSid: 'SMleg-bob', MessageStatus: 'failed', ErrorCode: '30007' }));

    expect(world.emitted.filter((e) => e.event === 'placement.updated')).toHaveLength(1);
    expect((await world.placementsRepo.getById(placementId))?.attention?.at).toBe(firstAt); // unchanged
  });

  it('a failed 1:1 send does NOT flag any placement (1:1 threads are not placement-linked)', async () => {
    const { app } = makeWebhookHarness({ world });
    await seedPlacement(world); // a placement exists, but the tenant's 1:1 thread is separate
    const conv = await world.conversationsRepo.createOrGetByParticipantPhone(TENANT_PHONE, 'tenant_1to1');
    await world.messagesRepo.append({
      conversationId: conv.conversationId,
      providerSid: 'SM1to1',
      providerTs: '2026-06-15T10:00:00.000Z',
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      deliveryStatus: 'sent',
    });
    world.emitted.length = 0;

    await signedTwilioPost(app, '/webhooks/twilio/status', statusParams({ MessageSid: 'SM1to1', MessageStatus: 'failed', ErrorCode: '30007' }));

    // The 1:1 conversation carries no placementId → flagPlacementAttention is a no-op.
    expect(world.emitted.some((e) => e.event === 'placement.updated')).toBe(false);
  });

  it('escalation is best-effort: a placementsRepo.update failure never 5xxs the webhook', async () => {
    const { app } = makeWebhookHarness({ world });
    await seedRelayLeg('awaiting_approval');
    // A DynamoDB blip on the attention write must be swallowed (Twilio must not
    // be told to redeliver a delivery callback over a side-effect failure).
    world.placementsRepo.update = async () => {
      throw new Error('dynamo blip');
    };

    const res = await signedTwilioPost(app, '/webhooks/twilio/status', statusParams({ MessageSid: 'SMleg-bob', MessageStatus: 'failed', ErrorCode: '30007' }));
    expect(res.status).toBe(200);
  });
});
