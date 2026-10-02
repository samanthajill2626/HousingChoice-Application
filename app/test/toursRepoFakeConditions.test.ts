// Fake parity for the tour conditional writes (tour auto-close and reopen,
// Sam #18, 2026-10-01).
//
// The in-memory toursRepo in helpers/twilioWebhookHarness.ts must refuse
// exactly what the real repo refuses, with the SAME condition evaluated
// synchronously (no await between the check and the write). A fake looser
// than the store makes every route test built on it lie. So every case here
// is a case of toursRepo.integration.test.ts (which runs it against DynamoDB
// Local), run against the fake - keep the two lists in step.
//
// Pure in-memory: createFakeWorld() does no I/O. Stored rows are read straight
// from the backing map (world.toursMap), the fake's equivalent of rawTour.
import { describe, expect, it } from 'vitest';
import { ConditionalCheckFailedException } from '../src/repos/toursRepo.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

function setup() {
  const world = createFakeWorld();
  const tours = world.toursRepo;
  /** A COPY of the stored row (the fake mutates stored rows in place). */
  const rawTour = (tourId: string) => {
    const t = world.toursMap.get(tourId);
    return t ? { ...t } : undefined;
  };
  return { world, tours, rawTour };
}

describe('harness fake toursRepo - conditional writes match the real repo', () => {
  it('patch with expectedStatus writes while the stored status matches, and refuses once it does not', async () => {
    const { tours, rawTour } = setup();
    const tour = await tours.create({
      tenantId: 'contact-expect-1',
      unitId: 'unit-expect-1',
      scheduledAt: '2026-09-10T15:00:00.000Z',
      tourType: 'self_guided',
    });

    const patched = await tours.patch(tour.tourId, { status: 'toured' }, { expectedStatus: 'scheduled' });
    expect(patched.status).toBe('toured');
    const before = rawTour(tour.tourId);
    expect(before).toMatchObject({ status: 'toured' });

    await expect(
      tours.patch(tour.tourId, { status: 'no_show' }, { expectedStatus: 'scheduled' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    await expect(
      tours.patch(tour.tourId, { scheduledAt: '2026-09-11T15:00:00.000Z' }, { expectedStatus: 'scheduled' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    expect(rawTour(tour.tourId)).toEqual(before);
  });

  it('(PIN) patch without opts keeps the unconditional contract', async () => {
    const { tours, rawTour } = setup();
    const tour = await tours.create({
      tenantId: 'contact-expect-2',
      unitId: 'unit-expect-2',
      scheduledAt: '2026-09-10T15:00:00.000Z',
      tourType: 'self_guided',
    });
    await tours.patch(tour.tourId, { status: 'toured' }, { expectedStatus: 'scheduled' });

    const patched = await tours.patch(tour.tourId, { status: 'no_show' });

    expect(patched.status).toBe('no_show');
    expect(rawTour(tour.tourId)).toMatchObject({ status: 'no_show' });
  });

  it('(PIN) patch with expectedStatus on a missing tour throws ConditionalCheckFailedException and creates nothing', async () => {
    const { tours, rawTour } = setup();
    await expect(
      tours.patch('tour-ghost-expected', { status: 'toured' }, { expectedStatus: 'scheduled' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    expect(rawTour('tour-ghost-expected')).toBeUndefined();
  });
});
