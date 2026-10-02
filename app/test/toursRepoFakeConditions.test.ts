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
import { ConditionalCheckFailedException, type ToursRepo } from '../src/repos/toursRepo.js';
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

  // autoCloseIf - the sweep's ONE write (spec 6.3).

  it('autoCloseIf closes a scheduled tour as no_outcome, rotates the pointer and stamps the wall clock', async () => {
    const { tours, rawTour } = setup();
    const tour = await tours.create({
      tenantId: 'contact-close-1',
      unitId: 'unit-close-1',
      scheduledAt: '2026-09-01T15:00:00.000Z',
      tourType: 'self_guided',
      currentLadderId: 'ladder-live',
    });
    const read = (await tours.get(tour.tourId))!;
    const before = Date.now();

    const closed = await tours.autoCloseIf(read, 'rot-1');

    expect(closed).toMatchObject({
      tourId: tour.tourId,
      tenantId: 'contact-close-1',
      scheduledAt: '2026-09-01T15:00:00.000Z',
      createdAt: read.createdAt,
      status: 'closed',
      outcome: 'no_outcome',
      autoClosedFrom: 'scheduled',
      currentLadderId: 'rot-1',
    });
    expect(closed!.autoClosedAt).toBe(closed!.updatedAt);
    expect(Date.parse(closed!.autoClosedAt as string)).toBeGreaterThanOrEqual(before);
    expect(closed).not.toHaveProperty('moveForward');
    expect(closed).not.toHaveProperty('convertible');
    expect(closed).not.toHaveProperty('lastMarkedAt');
    expect(rawTour(tour.tourId)).toEqual(closed);
  });

  it('autoCloseIf closes a candidate carrying convertible: false and leaves moveForward / convertible as they are', async () => {
    const { tours, rawTour } = setup();
    const tour = await tours.create({
      tenantId: 'contact-close-cv',
      unitId: 'unit-close-cv',
      scheduledAt: '2026-09-01T15:00:00.000Z',
      tourType: 'self_guided',
      status: 'toured',
      moveForward: false,
      convertible: false,
      lastMarkedAt: '2026-09-02T09:00:00.000Z',
    });
    const read = (await tours.get(tour.tourId))!;

    const closed = await tours.autoCloseIf(read, 'rot-cv');

    expect(closed).toMatchObject({
      status: 'closed',
      outcome: 'no_outcome',
      autoClosedFrom: 'toured',
      moveForward: false,
      convertible: false,
      lastMarkedAt: '2026-09-02T09:00:00.000Z',
    });
    expect(rawTour(tour.tourId)).toEqual(closed);
  });

  it('autoCloseIf closes an undated toured tour and adds no scheduledAt', async () => {
    const { tours, rawTour } = setup();
    const tour = await tours.create({
      tenantId: 'contact-close-2',
      unitId: 'unit-close-2',
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { status: 'toured' });
    const read = (await tours.get(tour.tourId))!;

    const closed = await tours.autoCloseIf(read, 'rot-2');

    expect(closed).toMatchObject({ status: 'closed', outcome: 'no_outcome', autoClosedFrom: 'toured' });
    const stored = rawTour(tour.tourId);
    expect(stored).toEqual(closed);
    expect(stored).not.toHaveProperty('scheduledAt');
  });

  // The integration file's race table, row for row.
  const autoCloseRaces: {
    name: string;
    undated?: boolean;
    lastMarkedAt?: string;
    change: (repo: ToursRepo, tourId: string) => Promise<unknown>;
  }[] = [
    { name: 'the status changed', change: (r, id) => r.patch(id, { status: 'toured' }) },
    { name: 'an outcome was recorded', change: (r, id) => r.patch(id, { outcome: 'not_a_fit' }) },
    { name: 'a conversion was claimed', change: (r, id) => r.claimConversion(id, 'pending:x') },
    { name: 'it became convertible', change: (r, id) => r.patch(id, { convertible: true }) },
    {
      name: 'it was rescheduled',
      change: (r, id) => r.patch(id, { scheduledAt: '2026-09-05T15:00:00.000Z' }),
    },
    {
      name: 'an undated tour got a date',
      undated: true,
      change: (r, id) => r.patch(id, { scheduledAt: '2026-09-05T15:00:00.000Z' }),
    },
    {
      name: 'a person marked it for the first time',
      change: (r, id) => r.patch(id, { lastMarkedAt: '2026-09-20T00:00:00.000Z' }),
    },
    {
      name: 'a person marked it again',
      lastMarkedAt: '2026-09-10T00:00:00.000Z',
      change: (r, id) => r.patch(id, { lastMarkedAt: '2026-09-20T00:00:00.000Z' }),
    },
  ];

  it.each(autoCloseRaces)(
    'autoCloseIf loses - undefined, nothing written - when $name between its read and its write',
    async ({ undated, lastMarkedAt, change }) => {
      const { tours, rawTour } = setup();
      const tour = await tours.create({
        tenantId: 'contact-close-race',
        unitId: 'unit-close-race',
        tourType: 'self_guided',
        status: undated === true ? 'toured' : 'scheduled',
        ...(undated !== true && { scheduledAt: '2026-09-01T15:00:00.000Z' }),
        ...(lastMarkedAt !== undefined && { lastMarkedAt }),
      });
      const read = (await tours.get(tour.tourId))!;
      await change(tours, tour.tourId);
      const changed = rawTour(tour.tourId);

      await expect(tours.autoCloseIf(read, 'rot-race')).resolves.toBeUndefined();
      expect(rawTour(tour.tourId)).toEqual(changed);
    },
  );

  it('autoCloseIf returns undefined for a missing tour and creates NOTHING', async () => {
    const { tours, rawTour } = setup();
    const tour = await tours.create({
      tenantId: 'contact-close-ghost',
      unitId: 'unit-close-ghost',
      scheduledAt: '2026-09-01T15:00:00.000Z',
      tourType: 'self_guided',
    });
    const read = (await tours.get(tour.tourId))!;

    await expect(tours.autoCloseIf({ ...read, tourId: 'tour-ghost-close' }, 'rot-ghost')).resolves.toBeUndefined();
    expect(rawTour('tour-ghost-close')).toBeUndefined();
  });

  it.each(['canceled', 'requested', 'closed'])(
    'autoCloseIf refuses a %s tour up front and writes nothing (the store alone would let it through)',
    async (status) => {
      const { tours, rawTour } = setup();
      const tour = await tours.create({
        tenantId: 'contact-close-refuse',
        unitId: 'unit-close-refuse',
        tourType: 'self_guided',
        status,
        ...(status !== 'requested' && { scheduledAt: '2026-09-01T15:00:00.000Z' }),
      });
      const read = (await tours.get(tour.tourId))!;
      const before = rawTour(tour.tourId);

      await expect(tours.autoCloseIf(read, 'rot-refuse')).resolves.toBeUndefined();
      expect(rawTour(tour.tourId)).toEqual(before);
    },
  );

  // reopenIf - POST /api/tours/:id/reopen's write (spec 7.3).

  /** The integration file's seedClosed: `auto` is the item autoCloseIf
   *  RETURNED (the post-close row). */
  const seedClosed = async (repo: ToursRepo, kind: 'auto' | 'person' | 'bare') => {
    if (kind === 'auto') {
      const tour = await repo.create({
        tenantId: 'contact-reopen-auto',
        unitId: 'unit-reopen',
        scheduledAt: '2026-09-01T15:00:00.000Z',
        tourType: 'self_guided',
        moveForward: false,
        convertible: false,
        currentLadderId: 'ladder-live',
      });
      return (await repo.autoCloseIf((await repo.get(tour.tourId))!, 'rot-reopen'))!;
    }
    if (kind === 'person') {
      const tour = await repo.create({
        tenantId: 'contact-reopen-person',
        unitId: 'unit-reopen',
        scheduledAt: '2026-09-01T15:00:00.000Z',
        tourType: 'self_guided',
        status: 'toured',
      });
      await repo.patch(tour.tourId, { outcome: 'not_a_fit', moveForward: false, convertible: false, status: 'closed' });
      return (await repo.get(tour.tourId))!;
    }
    const tour = await repo.create({
      tenantId: 'contact-reopen-bare',
      unitId: 'unit-reopen',
      tourType: 'self_guided',
      status: 'closed',
      autoClosedFrom: 'toured',
    });
    return (await repo.get(tour.tourId))!;
  };

  it('reopenIf returns an auto-closed tour to its status, stamps lastMarkedAt and removes the close and the decision', async () => {
    const { tours, rawTour } = setup();
    const closed = await seedClosed(tours, 'auto');
    expect(closed).toMatchObject({
      status: 'closed',
      outcome: 'no_outcome',
      autoClosedFrom: 'scheduled',
      moveForward: false,
      convertible: false,
    });
    const before = Date.now();

    const reopened = await tours.reopenIf(closed, 'scheduled', '2026-10-20T12:00:00.000Z');

    expect(reopened).toMatchObject({
      tourId: closed.tourId,
      status: 'scheduled',
      lastMarkedAt: '2026-10-20T12:00:00.000Z',
      scheduledAt: '2026-09-01T15:00:00.000Z',
      currentLadderId: 'rot-reopen',
    });
    for (const gone of ['outcome', 'moveForward', 'convertible', 'autoClosedAt', 'autoClosedFrom']) {
      expect(reopened).not.toHaveProperty(gone);
    }
    expect(reopened!.updatedAt).not.toBe('2026-10-20T12:00:00.000Z');
    expect(Date.parse(reopened!.updatedAt)).toBeGreaterThanOrEqual(before);
    expect(rawTour(closed.tourId)).toEqual(reopened);
  });

  it('reopenIf returns a person-decided tour to toured and removes outcome / moveForward / convertible', async () => {
    const { tours, rawTour } = setup();
    const closed = await seedClosed(tours, 'person');

    const reopened = await tours.reopenIf(closed, 'toured', '2026-10-20T12:00:00.000Z');

    expect(reopened).toMatchObject({ status: 'toured', lastMarkedAt: '2026-10-20T12:00:00.000Z' });
    for (const gone of ['outcome', 'moveForward', 'convertible', 'autoClosedAt', 'autoClosedFrom']) {
      expect(reopened).not.toHaveProperty(gone);
    }
    expect(rawTour(closed.tourId)).toEqual(reopened);
  });

  // The integration file's race table, row for row.
  const reopenRaces: {
    name: string;
    seed: 'auto' | 'person' | 'bare';
    change: (repo: ToursRepo, tourId: string) => Promise<unknown>;
  }[] = [
    {
      name: 'a first reopen already ran',
      seed: 'auto',
      change: async (r, id) => r.reopenIf((await r.get(id))!, 'scheduled', '2026-10-21T12:00:00.000Z'),
    },
    { name: 'it left closed (outcome kept)', seed: 'auto', change: (r, id) => r.patch(id, { status: 'toured' }) },
    { name: 'a conversion was claimed', seed: 'person', change: (r, id) => r.claimConversion(id, 'pending:x') },
    { name: 'the outcome changed', seed: 'person', change: (r, id) => r.patch(id, { outcome: 'move_forward' }) },
    { name: 'an outcome appeared', seed: 'bare', change: (r, id) => r.patch(id, { outcome: 'not_a_fit' }) },
    { name: 'autoClosedFrom changed', seed: 'auto', change: (r, id) => r.patch(id, { autoClosedFrom: 'toured' }) },
    { name: 'autoClosedFrom appeared', seed: 'person', change: (r, id) => r.patch(id, { autoClosedFrom: 'no_show' }) },
  ];

  it.each(reopenRaces)(
    'reopenIf loses - undefined, nothing written - when $name after its read',
    async ({ seed, change }) => {
      const { tours, rawTour } = setup();
      const read = await seedClosed(tours, seed);
      await change(tours, read.tourId);
      const changed = rawTour(read.tourId);

      await expect(tours.reopenIf(read, 'toured', '2026-10-20T12:00:00.000Z')).resolves.toBeUndefined();
      expect(rawTour(read.tourId)).toEqual(changed);
    },
  );

  it('reopenIf returns undefined for a missing tour and creates NOTHING', async () => {
    const { tours, rawTour } = setup();
    const read = await seedClosed(tours, 'person');

    await expect(
      tours.reopenIf({ ...read, tourId: 'tour-ghost-reopen' }, 'toured', '2026-10-20T12:00:00.000Z'),
    ).resolves.toBeUndefined();
    expect(rawTour('tour-ghost-reopen')).toBeUndefined();
  });
});
