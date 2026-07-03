// Unit tests for the lost-placement relay-close hook
// (services/placementRelayLifecycle.ts), driven on the in-memory world fakes.
// Mirrors the relayGroups close pattern: read the conversation to capture the
// pool number, atomically flip status→closed (conditional on 'open'), release the
// captured pool number best-effort, and audit `relay_group_closed` with IDs ONLY
// (reason + placementId — never a phone). Idempotent: an already-closed thread
// (ConditionalCheckFailedException) is a no-op with no double-release.
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createPlacementRelayLifecycle } from '../src/services/placementRelayLifecycle.js';
import type { PlacementItem } from '../src/repos/placementsRepo.js';
import type { PoolNumberItem } from '../src/repos/poolNumbersRepo.js';
import type { PoolNumbersService } from '../src/services/poolNumbers.js';

const POOL_NUMBER = '+15550001111';

function makeLifecycle(world: FakeWorld) {
  const releases: string[] = [];
  const poolNumbersService: PoolNumbersService = {
    async provisionForPlacement() {
      throw new Error('provisionForPlacement not used in lost-close');
    },
    async assignConversation() {
      throw new Error('assignConversation not used in lost-close');
    },
    async release(poolNumber: string) {
      releases.push(poolNumber);
      return { pool_number: poolNumber, lifecycle_state: 'quarantined' } as unknown as PoolNumberItem;
    },
  };
  const lifecycle = createPlacementRelayLifecycle({
    conversationsRepo: world.conversationsRepo,
    poolNumbersService,
    auditRepo: world.auditRepo,
    logger: createLogger({ destination: createLogCapture().stream }),
  });
  return { lifecycle, releases };
}

const placementWith = (over: Partial<PlacementItem>): PlacementItem =>
  ({ placementId: 'placement-x', tenantId: 'tenant-1', unitId: 'unit-1', stage: 'lost', ...over }) as PlacementItem;

describe('placementRelayLifecycle — closeForLost', () => {
  let world: FakeWorld;

  beforeEach(() => {
    world = createFakeWorld();
  });

  it('closes the relay group, releases the pool number, and audits relay_group_closed (IDs only)', async () => {
    const conv = await world.conversationsRepo.createRelayGroup({
      poolNumber: POOL_NUMBER,
      members: [],
      owner: { type: 'placement', id: 'placement-x' },
    });
    const { lifecycle, releases } = makeLifecycle(world);

    await lifecycle.closeForLost(placementWith({ group_thread: conv.conversationId }));

    const after = await world.conversationsRepo.getById(conv.conversationId);
    expect(after!.status).toBe('closed');
    // The pool number is cleared FIRST (atomic status+REMOVE) then released.
    expect(after!.pool_number).toBeUndefined();
    expect(releases).toEqual([POOL_NUMBER]);

    const audit = world.auditEvents.find((a) => a.event_type === 'relay_group_closed');
    expect(audit).toBeDefined();
    expect(audit!.entityKey).toBe(`conversations#${conv.conversationId}`);
    expect(audit!.payload).toMatchObject({ reason: 'placement_lost', placementId: 'placement-x' });
    // PII: the audit payload carries NO phone number.
    expect(JSON.stringify(audit!.payload)).not.toContain(POOL_NUMBER);
  });

  it('is a no-op when the placement has NO group_thread (nothing read, released, or audited)', async () => {
    const { lifecycle, releases } = makeLifecycle(world);
    await lifecycle.closeForLost(placementWith({}));
    expect(releases).toEqual([]);
    expect(world.auditEvents.some((a) => a.event_type === 'relay_group_closed')).toBe(false);
  });

  it('is a no-op when group_thread is an empty string', async () => {
    const { lifecycle, releases } = makeLifecycle(world);
    await lifecycle.closeForLost(placementWith({ group_thread: '' }));
    expect(releases).toEqual([]);
    expect(world.auditEvents.some((a) => a.event_type === 'relay_group_closed')).toBe(false);
  });

  it('is an idempotent no-op on an already-closed thread (ConditionalCheckFailedException) — no double release/audit', async () => {
    const conv = await world.conversationsRepo.createRelayGroup({
      poolNumber: POOL_NUMBER,
      members: [],
      owner: { type: 'placement', id: 'placement-x' },
    });
    // Pre-close it (mirrors a concurrent/duplicate close): status→closed, pool cleared.
    await world.conversationsRepo.setRelayStatus(conv.conversationId, 'closed', null, 'open');

    const { lifecycle, releases } = makeLifecycle(world);
    await lifecycle.closeForLost(placementWith({ group_thread: conv.conversationId }));

    // The conditional flip failed → idempotent no-op: no release, no audit.
    expect(releases).toEqual([]);
    expect(world.auditEvents.some((a) => a.event_type === 'relay_group_closed')).toBe(false);
  });

  it('is a no-op when the referenced conversation does not exist', async () => {
    const { lifecycle, releases } = makeLifecycle(world);
    await lifecycle.closeForLost(placementWith({ group_thread: 'conv-ghost' }));
    expect(releases).toEqual([]);
    expect(world.auditEvents.some((a) => a.event_type === 'relay_group_closed')).toBe(false);
  });
});
