// Unit tests for lib/listingOutcomeEvents.ts - the ONE writer for a
// send-outcome event (last-heard-from spec 5.4 as amended by 14.3), pinned
// against the harness fake world (the tourEvents.test.ts pattern): the
// contact's timeline only (never a landlord copy), the units# audit row with
// a whitelisted payload, and the best-effort guards.
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { recordListingOutcomeEvent } from '../src/lib/listingOutcomeEvents.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

const AT = '2026-10-13T15:00:00.000Z';

function setup() {
  const world = createFakeWorld();
  // A unit WITH a landlord: the writer must still never copy the landlord.
  world.units.set('unit-1', {
    unitId: 'unit-1',
    landlordId: 'contact-ll-1',
    status: 'available',
    created_at: AT,
    updated_at: AT,
  });
  const capture = createLogCapture();
  const deps = {
    activityEvents: world.activityEventsRepo,
    audit: world.auditRepo,
    logger: createLogger({ destination: capture.stream }),
  };
  return { world, deps, capture };
}

describe('recordListingOutcomeEvent (spec 14.3)', () => {
  it('pins the CONTACT timeline only (refType unit) and appends the unit audit with { contactId, actor }', async () => {
    const { world, deps } = setup();
    await recordListingOutcomeEvent(deps, {
      type: 'listing_declined',
      contactId: 'c-1',
      unitId: 'unit-1',
      label: 'Not interested in 12 Oak St, Atlanta, GA',
      actor: 'usr_va',
      at: AT,
    });
    expect(world.activityEvents).toHaveLength(1); // no landlord copy
    expect(world.activityEvents[0]).toMatchObject({
      contactId: 'c-1',
      type: 'listing_declined',
      label: 'Not interested in 12 Oak St, Atlanta, GA',
      refType: 'unit',
      refId: 'unit-1',
      at: AT,
    });
    expect(world.auditEvents).toEqual([
      { entityKey: 'units#unit-1', event_type: 'listing_declined', actorId: 'usr_va', payload: { contactId: 'c-1', actor: 'usr_va' } },
    ]);
  });

  it('listing_interested carries tourId on the unit audit (the Activity row links the tour); no actor -> no actor key', async () => {
    const { world, deps } = setup();
    await recordListingOutcomeEvent(deps, {
      type: 'listing_interested',
      contactId: 'c-1',
      unitId: 'unit-1',
      label: 'Interested in 12 Oak St - tour requested',
      tourId: 'tour-9',
      at: AT,
    });
    expect(world.activityEvents[0]).toMatchObject({ type: 'listing_interested', refType: 'unit', refId: 'unit-1' });
    expect(world.auditEvents).toEqual([
      { entityKey: 'units#unit-1', event_type: 'listing_interested', payload: { contactId: 'c-1', tourId: 'tour-9' } },
    ]);
  });

  it('a failed timeline write is logged and the audit row is still written; never throws', async () => {
    const { world, deps, capture } = setup();
    world.activityEventsRepo.record = async () => {
      throw new Error('activity down');
    };
    await expect(
      recordListingOutcomeEvent(deps, { type: 'listing_decline_cleared', contactId: 'c-1', unitId: 'unit-1', label: 'x', at: AT }),
    ).resolves.toBeUndefined();
    expect(world.auditEvents).toHaveLength(1);
    expect(capture.atLevel(50).some((l) => l['msg'] === 'listing_decline_cleared contact timeline record failed (best-effort)')).toBe(true);
  });

  it('a failed unit audit is logged; never throws', async () => {
    const { world, deps, capture } = setup();
    world.failAuditAppendFor.add('listing_declined');
    await expect(
      recordListingOutcomeEvent(deps, { type: 'listing_declined', contactId: 'c-1', unitId: 'unit-1', label: 'x', at: AT }),
    ).resolves.toBeUndefined();
    expect(world.activityEvents).toHaveLength(1);
    expect(capture.atLevel(50).some((l) => l['msg'] === 'listing_declined unit audit failed (best-effort)')).toBe(true);
  });
});
