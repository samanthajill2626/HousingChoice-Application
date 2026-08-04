// Unit tests for lib/personEvents.ts - the dual-party milestone recorder that
// tours.ts / placements.ts / services/statusTransition.ts all funnel through.
// The route-level dual-party behavior (landlord resolved / absent / missing unit
// row / resolve throws / record throws / degenerate self-landlord) is pinned
// THROUGH the real routes in toursApi.test.ts and transitionRoutes.test.ts.
// What only a direct unit test can reach is the blank-tenant input: every route
// requires a tenantId, so the guard below is unreachable from a request.
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import { recordPersonMilestone, type PersonMilestoneDeps } from '../src/lib/personEvents.js';
import type {
  ActivityEventItem,
  RecordActivityEventInput,
} from '../src/repos/activityEventsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';

const LANDLORD_UNIT: UnitItem = {
  unitId: 'unit-1',
  landlordId: 'c-ll',
  status: 'available',
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
};

const INPUT = {
  unitId: 'unit-1',
  type: 'tour_scheduled',
  label: 'Tour scheduled',
  refType: 'tour',
  refId: 'tour-1',
} as const;

function makeDeps(unit: UnitItem | undefined = LANDLORD_UNIT) {
  const record = vi.fn(
    async (input: RecordActivityEventInput): Promise<ActivityEventItem> =>
      ({
        contactId: input.contactId,
        tsEventId: `${input.at ?? '2026-07-01T00:00:00.000Z'}#evt-1`,
        eventId: 'evt-1',
        at: input.at ?? '2026-07-01T00:00:00.000Z',
        type: input.type,
        label: input.label,
        created_at: '2026-07-01T00:00:00.000Z',
      }) satisfies ActivityEventItem,
  );
  const getById = vi.fn(async (_unitId: string): Promise<UnitItem | undefined> => unit);
  const deps: PersonMilestoneDeps = {
    activityEvents: { record },
    units: { getById },
    log: createLogger({ destination: createLogCapture().stream }),
  };
  return { record, getById, deps };
}

describe('recordPersonMilestone - the blank-tenant guard', () => {
  // Main's recorders (placements.ts recordPlacementMilestone,
  // statusTransition.ts recordStageMilestone) both opened with
  // `if (tenantId.length === 0) return;`: a blank tenant meant NO milestone at
  // all, not a landlord-only one. This helper absorbed both, so it owns that
  // rule now - a half-written pair (a landlord pin for a tour whose tenant was
  // never pinned) is a worse outcome than skipping the event outright.
  it('records NOTHING and never touches the units repo when tenantId is blank', async () => {
    const { record, getById, deps } = makeDeps();

    await recordPersonMilestone(deps, { ...INPUT, tenantId: '' });

    expect(record).not.toHaveBeenCalled();
    // The early return happens BEFORE the landlord resolve, so an unusable input
    // costs no unit read either.
    expect(getById).not.toHaveBeenCalled();
  });

  it('records NOTHING for a non-string tenantId (defensive, same guard)', async () => {
    const { record, getById, deps } = makeDeps();

    await recordPersonMilestone(deps, {
      ...INPUT,
      tenantId: undefined as unknown as string,
    });

    expect(record).not.toHaveBeenCalled();
    expect(getById).not.toHaveBeenCalled();
  });

  it('a real tenantId still records BOTH parties (the guard is not over-broad)', async () => {
    const { record, getById, deps } = makeDeps();

    await recordPersonMilestone(deps, { ...INPUT, tenantId: 'c-tenant' });

    expect(getById).toHaveBeenCalledWith('unit-1');
    expect(record.mock.calls.map((c) => c[0].contactId)).toEqual(['c-tenant', 'c-ll']);
  });
});
