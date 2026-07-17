// Unit tests for the lost-placement relay-close hook
// (services/placementRelayLifecycle.ts), driven on the in-memory world fakes.
// Mirrors the relayGroups close pattern: read the conversation, atomically flip
// status->closed (conditional on 'open'), and audit `relay_group_closed` with
// IDs ONLY (reason + placementId - never a phone). The pool number is KEPT
// (burn-multiplexing) - nothing is released. Idempotent: an already-closed
// thread (ConditionalCheckFailedException) is a no-op.
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createPlacementRelayLifecycle } from '../src/services/placementRelayLifecycle.js';
import type { PlacementItem } from '../src/repos/placementsRepo.js';

const POOL_NUMBER = '+15550001111';

function makeLifecycle(world: FakeWorld) {
  const lifecycle = createPlacementRelayLifecycle({
    conversationsRepo: world.conversationsRepo,
    auditRepo: world.auditRepo,
    logger: createLogger({ destination: createLogCapture().stream }),
  });
  return { lifecycle };
}

const placementWith = (over: Partial<PlacementItem>): PlacementItem =>
  ({ placementId: 'placement-x', tenantId: 'tenant-1', unitId: 'unit-1', stage: 'lost', ...over }) as PlacementItem;

describe('placementRelayLifecycle — closeForLost', () => {
  let world: FakeWorld;

  beforeEach(() => {
    world = createFakeWorld();
  });

  it('closes the relay group (KEEPS the pool number) and audits relay_group_closed (IDs only)', async () => {
    const conv = await world.conversationsRepo.createRelayGroup({
      poolNumber: POOL_NUMBER,
      members: [],
      owner: { type: 'placement', id: 'placement-x' },
    });
    const { lifecycle } = makeLifecycle(world);

    await lifecycle.closeForLost(placementWith({ group_thread: conv.conversationId }));

    const after = await world.conversationsRepo.getById(conv.conversationId);
    expect(after!.status).toBe('closed');
    // The pool number is KEPT (burn-multiplexing) - nothing is released.
    expect(after!.pool_number).toBe(POOL_NUMBER);

    const audit = world.auditEvents.find((a) => a.event_type === 'relay_group_closed');
    expect(audit).toBeDefined();
    expect(audit!.entityKey).toBe(`conversations#${conv.conversationId}`);
    expect(audit!.payload).toMatchObject({ reason: 'placement_lost', placementId: 'placement-x' });
    // PII: the audit payload carries NO phone number.
    expect(JSON.stringify(audit!.payload)).not.toContain(POOL_NUMBER);
  });

  it('is a no-op when the placement has NO group_thread (nothing read or audited)', async () => {
    const { lifecycle } = makeLifecycle(world);
    await lifecycle.closeForLost(placementWith({}));
    expect(world.auditEvents.some((a) => a.event_type === 'relay_group_closed')).toBe(false);
  });

  it('is a no-op when group_thread is an empty string', async () => {
    const { lifecycle } = makeLifecycle(world);
    await lifecycle.closeForLost(placementWith({ group_thread: '' }));
    expect(world.auditEvents.some((a) => a.event_type === 'relay_group_closed')).toBe(false);
  });

  it('is an idempotent no-op on an already-closed thread (ConditionalCheckFailedException) - no double audit', async () => {
    const conv = await world.conversationsRepo.createRelayGroup({
      poolNumber: POOL_NUMBER,
      members: [],
      owner: { type: 'placement', id: 'placement-x' },
    });
    // Pre-close it (mirrors a concurrent/duplicate close): status->closed.
    await world.conversationsRepo.setRelayStatus(conv.conversationId, 'closed', 'open');

    const { lifecycle } = makeLifecycle(world);
    await lifecycle.closeForLost(placementWith({ group_thread: conv.conversationId }));

    // The conditional flip failed -> idempotent no-op: no audit.
    expect(world.auditEvents.some((a) => a.event_type === 'relay_group_closed')).toBe(false);
  });

  it('is a no-op when the referenced conversation does not exist', async () => {
    const { lifecycle } = makeLifecycle(world);
    await lifecycle.closeForLost(placementWith({ group_thread: 'conv-ghost' }));
    expect(world.auditEvents.some((a) => a.event_type === 'relay_group_closed')).toBe(false);
  });
});
