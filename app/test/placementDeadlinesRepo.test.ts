// Invariant tests for the first-class placement deadlines (placement-deadline-model).
// The pure `soonestDeadline` helper + the repo's deterministic-id arm/retire
// semantics, driven on the in-memory fake (no DynamoDB). Real GSI round-trips
// live in placementsRepo.integration.test.ts.
import { describe, expect, it } from 'vitest';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';
import {
  deadlineIdFor,
  soonestDeadline,
  type PlacementDeadlineItem,
} from '../src/repos/placementDeadlinesRepo.js';

const item = (
  placementId: string,
  type: PlacementDeadlineItem['type'],
  at: string,
): PlacementDeadlineItem => ({
  deadlineId: deadlineIdFor(placementId, type),
  placementId,
  type,
  at,
  _deadlinePartition: 'deadlines',
  createdAt: at,
  updatedAt: at,
});

describe('soonestDeadline (pure)', () => {
  it('picks the soonest by instant', () => {
    const soonest = soonestDeadline([
      item('p', 'voucher_expiration', '2026-09-01T00:00:00.000Z'),
      item('p', 'rta_window', '2026-06-16T00:00:00.000Z'),
    ]);
    expect(soonest).toEqual({ type: 'rta_window', at: '2026-06-16T00:00:00.000Z' });
  });

  it('breaks ties by type (deterministic) and returns null for none', () => {
    const at = '2026-06-16T00:00:00.000Z';
    // follow_up < rta_window < voucher_expiration lexically.
    const soonest = soonestDeadline([item('p', 'rta_window', at), item('p', 'follow_up', at)]);
    expect(soonest).toEqual({ type: 'follow_up', at });
    expect(soonestDeadline([])).toBeNull();
  });
});

describe('placementDeadlinesRepo — invariants (fake)', () => {
  // INVARIANT #1: soonest-wins — retire the soonest and the next surfaces;
  // retire all → soonest is null.
  it('soonest-wins: retire the soonest → next surfaces; retire all → null', async () => {
    const world = createFakeWorld();
    const repo = world.placementDeadlinesRepo;
    await repo.arm('p1', 'rta_window', '2026-06-16T00:00:00.000Z');
    await repo.arm('p1', 'voucher_expiration', '2026-09-01T00:00:00.000Z');
    expect(soonestDeadline(await repo.listByPlacement('p1'))?.type).toBe('rta_window');

    await repo.retire('p1', 'rta_window');
    expect(soonestDeadline(await repo.listByPlacement('p1'))?.type).toBe('voucher_expiration');

    await repo.retire('p1', 'voucher_expiration');
    expect(soonestDeadline(await repo.listByPlacement('p1'))).toBeNull();
  });

  // INVARIANT #2: independent arm/retire — arming one type never disturbs another;
  // re-arming a type upserts in place (deterministic id → single row).
  it('independent arm/retire + idempotent upsert (deterministic id → one row per type)', async () => {
    const world = createFakeWorld();
    const repo = world.placementDeadlinesRepo;
    await repo.arm('p2', 'rta_window', '2026-06-16T00:00:00.000Z');
    // Arming a DIFFERENT type leaves the pending rta_window intact.
    await repo.arm('p2', 'voucher_expiration', '2026-09-01T00:00:00.000Z');
    let rows = await repo.listByPlacement('p2');
    expect(rows.map((r) => r.type).sort()).toEqual(['rta_window', 'voucher_expiration']);

    // Re-arming the SAME type upserts the single deterministic-id row (no dup).
    await repo.arm('p2', 'rta_window', '2026-06-20T00:00:00.000Z');
    rows = await repo.listByPlacement('p2');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.type === 'rta_window')!.at).toBe('2026-06-20T00:00:00.000Z');

    // Retiring one leaves the other untouched.
    await repo.retire('p2', 'rta_window');
    expect((await repo.listByPlacement('p2')).map((r) => r.type)).toEqual(['voucher_expiration']);
  });

  it('clearForPlacement empties a placement; listDue bounds by now', async () => {
    const world = createFakeWorld();
    const repo = world.placementDeadlinesRepo;
    await repo.arm('p3', 'rta_window', '2026-06-16T00:00:00.000Z'); // past
    await repo.arm('p3', 'voucher_expiration', '2099-01-01T00:00:00.000Z'); // future
    // Only the due (<= now) item is returned; soonest-first.
    const due = await repo.listDue('2026-07-01T00:00:00.000Z');
    expect(due.map((d) => d.placementId)).toContain('p3');
    expect(due.filter((d) => d.placementId === 'p3').map((d) => d.type)).toEqual(['rta_window']);

    await repo.clearForPlacement('p3');
    expect(await repo.listByPlacement('p3')).toHaveLength(0);
  });
});
